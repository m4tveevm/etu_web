import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = '__Host-etu_session';
export const TRANSACTION_COOKIE = '__Host-etu_transaction';
export const COOKIE_MAX_LENGTH = 3800;

export function seal(config, name, data, ttlSeconds, now = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.cookieKey, iv);
  cipher.setAAD(Buffer.from(`${config.origin}|${name}|v1`));
  const body = Buffer.from(JSON.stringify({ ...data, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds }));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  const cookie = `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}`;
  if (cookie.length > COOKIE_MAX_LENGTH) throw new Error('cookie_too_large');
  return cookie;
}

export function clearCookie(name) {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function open(config, name, cookieHeader, now = Date.now()) {
  try {
    const values = (cookieHeader || '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
    if (values.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(values[0]) || values[0].length > COOKIE_MAX_LENGTH) return null;
    const packed = Buffer.from(values[0], 'base64url');
    if (packed.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', config.cookieKey, packed.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${config.origin}|${name}|v1`));
    decipher.setAuthTag(packed.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (!Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)
      || value.iat > seconds + 5 || value.exp <= seconds || value.exp <= value.iat
      || value.exp - value.iat > 1800) return null;
    return value;
  } catch { return null; }
}
