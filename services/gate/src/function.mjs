import { readConfig } from './config.mjs';
import { createOidc } from './oidc.mjs';
import { createCloud, MAX_FILE_BYTES } from './cloud.mjs';
import { createApp } from './app.mjs';

// API Gateway calls a private function with payload_format_version: "1.0".
// event headers are request data, never an identity or an IAM credential.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const dictionary = (value) => {
  if (value == null) return {};
  if (!object(value) || Object.keys(value).length > 100) throw new Error('event_dictionary');
  return value;
};
const headerValue = (value) => typeof value === 'string' && !/[^\x20-\x7e\t]/.test(value);

export function adaptRequest(event) {
  if (!object(event) || event.version !== '1.0' || typeof event.httpMethod !== 'string'
    || !/^[A-Z]{3,10}$/.test(event.httpMethod) || typeof event.path !== 'string'
    || !event.path.startsWith('/') || event.path.startsWith('//')
    || /[?#\\\x00-\x20\x7f]/.test(event.path) || event.path.length > 4096) {
    throw new Error('event_request');
  }
  const headers = Object.create(null);
  let headerBytes = 0;
  for (const [source, multiple] of [[event.headers, false], [event.multiValueHeaders, true]]) {
    const seen = new Set();
    for (const [name, raw] of Object.entries(dictionary(source))) {
      const key = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || seen.has(key)) throw new Error('event_header');
      seen.add(key);
      const values = multiple ? raw : [raw];
      if (!Array.isArray(values) || !values.length || values.length > 100 || !values.every(headerValue)
        || (key === 'origin' && values.length !== 1)) throw new Error('event_header');
      headerBytes += Buffer.byteLength(name) + values.reduce((size, value) => size + Buffer.byteLength(value), 0);
      if (headerBytes > 32_768) throw new Error('event_headers_size');
      // Multi-value entries override their single-value copies without losing duplicates.
      headers[key] = values.join(key === 'cookie' ? '; ' : ', ');
    }
  }
  if ((headers.cookie?.length || 0) > 8192 || (headers.origin?.length || 0) > 2048) throw new Error('event_header_size');
  const query = new Map();
  for (const [source, multiple] of [[event.queryStringParameters, false], [event.multiValueQueryStringParameters, true]]) {
    for (const [name, raw] of Object.entries(dictionary(source))) {
      const values = multiple ? raw : [raw];
      if (name.length > 4096 || !Array.isArray(values) || !values.length || values.length > 100
        || values.some((value) => typeof value !== 'string' || value.length > 4096)) throw new Error('event_query');
      query.set(name, values);
    }
  }
  const search = new URLSearchParams();
  for (const [name, values] of query) for (const value of values) search.append(name, value);
  const url = event.path + (search.size ? `?${search}` : '');
  if (url.length > 4096) throw new Error('event_url_size');
  return { method: event.httpMethod, url, headers };
}

function failure(statusCode) {
  return { statusCode, headers: { 'cache-control': 'private, no-store, max-age=0',
    'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  body: statusCode === 400 ? 'Некорректный запрос.' : 'Сервис временно недоступен.', isBase64Encoded: false };
}

export function createFunctionHandler(app) {
  return async (event) => {
    let req;
    try { req = adaptRequest(event); } catch { return failure(400); }
    try {
      let statusCode, responseHeaders, bytes;
      await app(req, {
        writeHead(status, headers) { statusCode = status; responseHeaders = headers; },
        end(body) { bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
      });
      if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599
        || !responseHeaders || !bytes || bytes.length > MAX_FILE_BYTES) throw new Error('response_invalid');
      const headers = {}, multiValueHeaders = {};
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (Array.isArray(value)) multiValueHeaders[key] = value.map(String);
        else headers[key] = String(value);
      }
      // Preserve all bytes, including PDF/WebP, and keep Set-Cookie as separate fields.
      const response = { statusCode, headers, multiValueHeaders,
        body: bytes.toString('base64'), isBase64Encoded: bytes.length > 0 };
      // Cloud Functions limits the entire JSON envelope to 3.5 MB.
      if (Buffer.byteLength(JSON.stringify(response)) > 3_400_000) throw new Error('response_too_large');
      return response;
    } catch { return failure(503); }
  };
}

const config = readConfig(process.env);
const audit = (event) => process.stdout.write(`${JSON.stringify({ event })}\n`);
export const handler = createFunctionHandler(createApp({ config,
  oidc: config && createOidc(config), cloud: config && createCloud(config), audit }));
