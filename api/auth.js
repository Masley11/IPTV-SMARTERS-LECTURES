const crypto = require('node:crypto');
const { createSession, verifySession, sessionCookie, serializeSession } = require('../lib/session');
const { rateLimit, clientIP, hash, sameOrigin, ownerFor, LOCK_KEY } = require('../lib/access');
const { SESSION_TTL_MS } = require('../lib/session');
const { getStore } = require('../lib/store');
const { readPolicy } = require('../lib/policy');

function json(res, status, data) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data));
}
function configured() {
  try {
    if (!process.env.APP_ACCESS_PASSWORD || process.env.APP_ACCESS_PASSWORD.length < 12) return false;
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) return false;
    readPolicy(); getStore(); return true;
  } catch { return false; }
}
function secureRequest(req) {
  return process.env.VERCEL === '1' || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || Boolean(req.socket?.encrypted);
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (req.body.length > 2048) throw new Error('Requête trop volumineuse.');
    try { return JSON.parse(req.body); } catch { const error = new Error('JSON invalide.'); error.status = 400; throw error; }
  }
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2048) { const error = new Error('Requête trop volumineuse.'); error.status = 413; throw error; }
  }
  try { return JSON.parse(text || '{}'); } catch { const error = new Error('JSON invalide.'); error.status = 400; throw error; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method === 'GET') {
      const token = sessionCookie({ headers: { get: () => req.headers.cookie } });
      return json(res, 200, { configured: configured(), authenticated: await verifySession(token, process.env.SESSION_SECRET) });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'Méthode non autorisée.' }); }
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origine interdite.' });
    if (!configured()) return json(res, 503, { error: 'Espace privé non configuré : définissez le mot de passe, le secret de session et le stockage Redis dans les variables Vercel.', code: 'SETUP_REQUIRED' });
    const ip = clientIP(req);
    await rateLimit(`login:ip:${ip}`, 10, 15 * 60000);
    await rateLimit('login:global', 60, 15 * 60000);
    const data = await body(req);
    if (data.action === 'logout') {
      const token = sessionCookie({ headers: { get: () => req.headers.cookie } });
      if (await verifySession(token, process.env.SESSION_SECRET)) {
        if (data.viewerId) await getStore().release(LOCK_KEY, ownerFor(token, data.viewerId));
        await getStore().del(`onda:session:${hash(token)}`);
      }
      res.setHeader('Set-Cookie', serializeSession('', secureRequest(req), 0));
      return json(res, 200, { ok: true });
    }
    const supplied = crypto.createHash('sha256').update(String(data.password || '')).digest();
    const expected = crypto.createHash('sha256').update(process.env.APP_ACCESS_PASSWORD).digest();
    if (!crypto.timingSafeEqual(supplied, expected)) {
      await new Promise(resolve => setTimeout(resolve, 350));
      return json(res, 401, { error: 'Mot de passe incorrect.', code: 'INVALID_PASSWORD' });
    }
    const token = await createSession(process.env.SESSION_SECRET);
    await getStore().set(`onda:session:${hash(token)}`, '1', SESSION_TTL_MS);
    res.setHeader('Set-Cookie', serializeSession(token, secureRequest(req)));
    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, error.status || 503, { error: error.status ? error.message : 'Connexion au stockage privé impossible. Réessayez plus tard.', code: error.code || 'SERVICE_UNAVAILABLE' });
  }
};
module.exports.configured = configured;
