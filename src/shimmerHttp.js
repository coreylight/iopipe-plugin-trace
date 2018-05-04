import http from 'http';
import https from 'https';
import url from 'url';
import { debuglog } from 'util';
import shimmer from 'shimmer';
import Perf from 'performance-node';
import uuid from 'uuid/v4';
import pickBy from 'lodash.pickby';
import isArray from 'isarray';
import { flatten } from 'flat';

const debug = debuglog('@iopipe/trace');

/*eslint-disable babel/no-invalid-this*/

function unwrap() {
  if (http.get.__wrapped) {
    shimmer.unwrap(http, 'get');
  }
  if (http.request.__wrapped) {
    shimmer.unwrap(http, 'request');
  }
  if (https.get.__wrapped) {
    shimmer.unwrap(https, 'get');
  }
  if (https.request.__wrapped) {
    shimmer.unwrap(https, 'request');
  }
  delete http.__iopipeShimmer;
  delete https.__iopipeShimmer;
}

function wrapHttpGet(mod) {
  return (options, cb) => {
    const req = mod.request(options, cb);
    req.end();
    return req;
  };
}

// these are keys that are node specific and come from the actual js request object
const unnecessaryReqKeys = [
  'agent',
  'automaticFailover',
  'cache',
  'decompress',
  'followRedirect',
  'retries',
  'slashes',
  'strictTtl',
  'throwHttpErrors',
  'useElectronNet'
];

function excludeUnnecessaryReqKeys(obj) {
  return pickBy(obj, (v, k) => unnecessaryReqKeys.indexOf(k) === -1);
}

function getReqDataObject(rawOptions) {
  // options might be a string ie http.get(), coerce to object
  const data =
    typeof rawOptions === 'string'
      ? { href: rawOptions, headers: {} }
      : Object.assign({}, rawOptions) || {};

  const urlObject =
    typeof data === 'string' ? url.parse(rawOptions) : rawOptions;
  Object.assign(data, urlObject);

  // ensure url key is present with full URI
  data.url = data.href || url.format(data);
  // simple rename
  data.query = data.search;
  // delete duplicate or extraneous keys
  delete data.search;
  delete data.host;
  delete data.href;
  // delete data['user-agent'];

  // sometimes request headers come in as an array
  // make them strings to conform to our schema better
  Object.keys(data.headers || {}).forEach(k => {
    data.headers[k] = isArray(data.headers[k])
      ? data.headers[k].join(' ')
      : data.headers[k];
  });

  return excludeUnnecessaryReqKeys(data);
}

const initialResKeys = ['headers', 'statusCode', 'statusMessage'];

function getResDataObject(res) {
  return pickBy(res, (v, k) => initialResKeys.indexOf(k) > -1);
}

const defaultKeysToRecord = [
  'req.headers.user-agent',
  'req.headers.accept-encoding',
  'req.method',
  'req.path',
  'req.protocol',
  'req.port',
  'req.hostname',
  'req.hash',
  'req.pathname',
  'req.url',
  'req.query',
  'req.user-agent',
  'req.accept-encoding',
  'res.headers.cache-control',
  'res.headers.content-type',
  'res.headers.date',
  'res.headers.etag',
  'res.headers.strict-transport-security',
  'res.headers.content-encoding',
  'res.headers.content-length',
  'res.headers.age',
  'res.headers.connection',
  'res.headers.server',
  'res.headers.vary',
  'res.statusCode',
  'res.statusMessage'
];

function filterData(config = {}, obj = {}) {
  if (typeof config.filter === 'function') {
    return config.filter(obj);
  }
  return pickBy(obj, (v, k) => defaultKeysToRecord.indexOf(k) > -1);
}

function wrapHttpRequest({ timeline, data: moduleData = {}, config = {} }) {
  return function wrapper(original) {
    return function execute(rawOptions, originalCallback) {
      // bail if we have already started tracking this request
      // this can happen by calling https.request(opts)
      // which ends up calling http.request(opts)
      if (originalCallback && originalCallback.__iopipeTraceId) {
        return original.apply(this, [rawOptions, originalCallback]);
      }

      // id of this particular trace
      const id = uuid();
      // start the trace
      timeline.mark(`start:${id}`);

      // setup http trace data that will be sent to IOpipe later
      moduleData[id] = {};
      moduleData[id].req = getReqDataObject(rawOptions);

      // the func to execute at the end of the http call
      function extendedCallback(res) {
        timeline.mark(`end:${id}`);
        // add full response data
        moduleData[id].res = getResDataObject(res);
        // flatten object for easy transformation/filtering later
        moduleData[id] = flatten(moduleData[id]);
        moduleData[id] = filterData(config, moduleData[id]);

        // if filter function returns falsey value, drop all data completely
        if (typeof moduleData[id] !== 'object') {
          timeline.data = timeline.data.filter(
            d => !new RegExp(id).test(d.name)
          );
          delete moduleData[id];
        }

        if (originalCallback) {
          return originalCallback.apply(this, [res]);
        }
        return true;
      }

      // add traceId to callback so we do not create duplicate data from inner http calls
      // this can happen for the https module which calls the http module internally
      extendedCallback.__iopipeTraceId = id;

      // execute the original function with callback
      if (typeof originalCallback === 'function') {
        return original.apply(this, [rawOptions, extendedCallback]);
      } else {
        // the user didn't specify a callback, add it as a "response" handler ourselves
        return original
          .apply(this, [rawOptions])
          .on('response', extendedCallback);
      }
    };
  };
}

function wrap({ timeline, data = {}, config = {} } = {}) {
  if (!(timeline instanceof Perf)) {
    debug(
      'Timeline passed to shimmerHttp.wrap not an instance of performance-node. Skipping.'
    );
    return false;
  }

  if (!http.__iopipeShimmer) {
    shimmer.wrap(http, 'get', () => wrapHttpGet(http));
    shimmer.wrap(http, 'request', wrapHttpRequest({ timeline, data, config }));
    http.__iopipeShimmer = true;
  }

  if (!https.__iopipeShimmer) {
    shimmer.wrap(https, 'get', () => wrapHttpGet(https));
    shimmer.wrap(https, 'request', wrapHttpRequest({ timeline, data, config }));
    https.__iopipeShimmer = true;
  }

  return true;
}

export { unwrap, wrap };
