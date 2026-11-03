/* WebCrypto sessions: the same verification runs in Vercel Middleware and Node. */
const COOKIE_NAME = 'onda_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function key(secret) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET doit contenir au moins 32 caractères.');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function createSession(secret, now = Date.now()) {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `${now + SESSION_TTL_MS}.${nonce}`;
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifySession(token, secret, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 256) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{32}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
    const expires = Number(parts[0]);
    if (expires <= now || expires > now + SESSION_TTL_MS + 60000) return false;
    return await crypto.subtle.verify('HMAC', await key(secret), fromBase64Url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}

function sessionCookie(req) {
  const header = String(req.headers.get('cookie') || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === COOKIE_NAME) return part.slice(index + 1).trim();
  }
  return '';
}

function serializeSession(value, secure, maxAge = SESSION_TTL_MS / 1000) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { COOKIE_NAME, SESSION_TTL_MS, createSession, verifySession, sessionCookie, serializeSession };
