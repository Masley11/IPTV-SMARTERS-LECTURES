const crypto = require('node:crypto');
const { readPolicy, quotaWindow, publicUsage } = require('./policy');
const { getStore, LOCK_KEY } = require('./store');
const { verifySession, sessionCookie } = require('./session');

const errors = {
  BUSY: 'Une autre fenêtre ou TV utilise déjà la lecture. Fermez-la, puis réessayez dans une minute.',
  OUTSIDE_HOURS: 'La lecture est en pause hors de la plage horaire autorisée.',
  DAILY_LIMIT: 'Votre quota de visionnage du jour est épuisé. Revenez demain.',
  MONTHLY_LIMIT: 'Votre quota mensuel est épuisé. La lecture reprendra le mois prochain.'
};

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function sameOrigin(req) {
  if (req.headers['x-onda-request'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients still need the signed HttpOnly cookie.
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function requireSession(req) {
  const token = sessionCookie({ headers: { get: name => name === 'cookie' ? req.headers.cookie : null } });
  if (!await verifySession(token, process.env.SESSION_SECRET)) {
    const error = new Error('Connectez-vous à votre espace privé.'); error.status = 401; error.code = 'AUTH_REQUIRED'; throw error;
  }
  // A stolen cookie must not survive logout. Static shell contains no secrets;
  // every data/API request additionally checks the revocable server-side session.
  if (!await getStore().get(`onda:session:${hash(token)}`)) {
    const error = new Error('Session expirée. Reconnectez-vous.'); error.status = 401; error.code = 'AUTH_REQUIRED'; throw error;
  }
  return token;
}
async function rateLimit(key, maximum, windowMs) {
  const count = await getStore().hit(`onda:rate:${hash(key)}`, windowMs);
  if (count > maximum) { const error = new Error('Trop de tentatives. Réessayez plus tard.'); error.status = 429; error.code = 'RATE_LIMIT'; throw error; }
}
function ownerFor(token, viewerId) {
  if (!/^[a-f0-9-]{36}$/.test(String(viewerId || ''))) throw new Error('Identifiant de fenêtre invalide.');
  return hash(`${process.env.SESSION_SECRET}|${token.split('.')[1]}|${viewerId}`);
}
function clientIP(req) {
  // Ignore arbitrary user-supplied forwarding headers. Vercel supplies x-forwarded-for.
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim().slice(0, 100);
}
async function usage(now = Date.now()) {
  const policy = { unlimited: true, videoRoute: 'direct' };
  return { policy, usage: { serverNow: now } };
}
async function lease(token, viewerId) {
  // Validate viewer identifiers but do not reserve a shared lock or quota.
  ownerFor(token, viewerId);
  const now = Date.now();
  return { ...(await usage(now)), lease: { expiresAt: now + 31536000000, serverNow: now, chargedSeconds: 0 } };
}

module.exports = { hash, sameOrigin, requireSession, rateLimit, ownerFor, clientIP, usage, lease, errors, LOCK_KEY };
