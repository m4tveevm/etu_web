import { createHash } from 'node:crypto';
import { jsonRequest, readBytes } from './http.mjs';
import { validateQuote } from '../../quotes/contract.mjs';

export const MAX_FILE_BYTES = 2_200_000;
const METADATA_URL = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const TYPES = new Set(['text/html', 'text/css', 'text/javascript', 'application/javascript',
  'application/pdf', 'image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']);

export function safePath(path) {
  return typeof path === 'string' && path.length <= 1024 && path.split('/').every((part) =>
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== '.' && part !== '..');
}

export function requestPath(rawUrl) {
  try {
    const raw = rawUrl.split('?')[0];
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    let path = decodeURIComponent(raw).slice(1);
    if (!path || path.endsWith('/')) path += 'index.html';
    if (!safePath(path)) return null;
    return path;
  } catch { return null; }
}

export function createCloud(config, fetcher = fetch) {
  let iam;
  let tokenUntil = 0;
  let manifest;
  let manifestLoading;
  let manifestQuoteAccess;

  async function iamToken() {
    if (iam && Date.now() < tokenUntil) return iam;
    const result = await jsonRequest(fetcher, METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' } });
    if (typeof result.access_token !== 'string' || !result.access_token
      || !Number.isFinite(result.expires_in) || result.expires_in <= 60) throw new Error('metadata_token');
    iam = result.access_token;
    tokenUntil = Date.now() + (Math.min(result.expires_in, 3600) - 60) * 1000;
    return iam;
  }

  async function privateGet(url, limit) {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${await iamToken()}` } });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) tokenUntil = 0;
      await response.body?.cancel();
      throw new Error('private_upstream_failed');
    }
    return readBytes(response, limit);
  }

  const objectUrl = (path) => `https://storage.yandexcloud.net/${config.bucket}/releases/${config.releaseId}/${config.manifestSha256}/${path.split('/').map(encodeURIComponent).join('/')}`;

  async function loadManifest() {
    if (manifest) return manifest;
    if (manifestLoading) return manifestLoading;
    manifestLoading = (async () => {
      const bytes = await privateGet(objectUrl('manifest.json'), 512_000);
      if (digest(bytes) !== config.manifestSha256) throw new Error('manifest_digest');
      const data = JSON.parse(bytes.toString('utf8'));
      if (data.schemaVersion !== 2 || data.releaseId !== config.releaseId || !Array.isArray(data.files)
        || !['public', 'admin', null].includes(data.quoteAccess)
        || data.files.length < 1 || data.files.length > 5000) throw new Error('manifest_schema');
      const entries = new Map();
      for (const item of data.files) {
        if (!safePath(item.path) || entries.has(item.path) || item.path === 'manifest.json'
          || !['public', 'admin'].includes(item.access)
          || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.size)
          || item.size < 0 || item.size > MAX_FILE_BYTES || typeof item.contentType !== 'string'
          || !TYPES.has(item.contentType.split(';')[0])
          || !/^[a-zA-Z0-9/+.-]+(?:; charset=utf-8)?$/.test(item.contentType)) throw new Error('manifest_entry');
        entries.set(item.path, item);
      }
      if (entries.get('index.html')?.access !== 'public'
        || entries.get('admin/index.html')?.access !== 'admin') {
        throw new Error('manifest_index');
      }
      manifestQuoteAccess = data.quoteAccess;
      manifest = entries;
      return entries;
    })();
    try { return await manifestLoading; } finally { manifestLoading = undefined; }
  }

  async function object(path) {
    const entries = await loadManifest();
    const item = entries.get(path);
    if (!item) return null;
    const bytes = await privateGet(objectUrl(path), MAX_FILE_BYTES);
    if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new Error('object_digest');
    return { bytes, contentType: item.contentType };
  }

  async function access(path) {
    return (await loadManifest()).get(path)?.access ?? null;
  }

  async function quoteAccess() {
    await loadManifest();
    return manifestQuoteAccess;
  }

  async function quote() {
    if (!config.quoteUrl) throw new Error('quote_unconfigured');
    const value = JSON.parse((await privateGet(config.quoteUrl, 16_384)).toString('utf8'));
    if (!validateQuote(value)) throw new Error('quote_schema');
    return value;
  }

  return { object, quote, access, quoteAccess, loadManifest };
}
