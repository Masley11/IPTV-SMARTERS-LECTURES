/* Short-lived handoff for the external HTTP TV player.
 * The token is delivered in a URL fragment (never sent to the static host).
 * Provider credentials are encrypted at rest in Redis and never returned to the player.
 */
const crypto = require('node:crypto');
const { getStore } = require('./store');

const TV_TTL_MS = 12 * 60 * 60 * 1000;
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function key(secret) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET doit contenir au moins 32 caractères.');
  return crypto.createHash('sha256').update(`onda-tv:${secret}`).digest();
}
function encryptProvider(provider, secret) {
  if (!provider) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(provider), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), ct: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function decryptProvider(encoded, secret) {
  if (!encoded) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(secret), Buffer.from(encoded.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encoded.tag, 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(encoded.ct, 'base64url')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
async function issueTvToken(sessionToken, viewerId, provider, now = Date.now()) {
  const parts = String(sessionToken || '').split('.');
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{32}$/.test(parts[1])) throw new Error('Session invalide.');
  if (!/^[a-f0-9-]{36}$/.test(String(viewerId || ''))) throw new Error('Identifiant de fenêtre invalide.');
  const expiresAt = Math.min(now + TV_TTL_MS, Number(parts[0]));
  if (expiresAt <= now) throw new Error('Session expirée.');
  const token = crypto.randomBytes(32).toString('base64url');
  const record = {
    nonce: parts[1], sessionHash: hash(sessionToken), viewerId,
    provider: encryptProvider(provider, process.env.SESSION_SECRET), expiresAt
  };
  await getStore().set(`onda:tv:${hash(token)}`, JSON.stringify(record), expiresAt - now);
  return { token, expiresAt };
}
async function requireTvToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    const error = new Error('Jeton TV invalide.'); error.status = 401; error.code = 'TV_AUTH_REQUIRED'; throw error;
  }
  const store = getStore();
  const raw = await store.get(`onda:tv:${hash(token)}`);
  const record = raw ? JSON.parse(raw) : null;
  if (!record || record.expiresAt <= now) {
    const error = new Error('Jeton TV expiré. Revenez à StreamPulse et relancez la chaîne.'); error.status = 401; error.code = 'TV_AUTH_REQUIRED'; throw error;
  }
  if (!await store.get(`onda:session:${record.sessionHash}`)) {
    const error = new Error('Session fermée. Reconnectez-vous dans StreamPulse.'); error.status = 401; error.code = 'TV_AUTH_REQUIRED'; throw error;
  }
  return record;
}
function pseudoSession(record) { return `0.${record.nonce}.0`; }
function providerAuth(record) {
  const provider = decryptProvider(record.provider, process.env.SESSION_SECRET);
  if (!provider) return null;
  return { base: new URL(provider.base), auth: { username: provider.username, password: provider.password }, isLocked: Boolean(provider.isLocked) };
}
module.exports = { TV_TTL_MS, hash, issueTvToken, requireTvToken, pseudoSession, providerAuth };
