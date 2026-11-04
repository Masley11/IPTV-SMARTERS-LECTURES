const { requireSession, rateLimit, ownerFor, usage, lease, LOCK_KEY } = require('../lib/access');
const { getStore } = require('../lib/store');
const { readPolicy } = require('../lib/policy');
const { resolveBase, credentials, directUrls } = require('../lib/xtream');
const { issueTvToken } = require('../lib/tv');

function json(res, status, payload) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(payload));
}
async function readBody(req) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > 2048) throw new Error('Requête trop volumineuse.');
    return JSON.parse(req.body.toString('utf8'));
  }
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (req.body.length > 2048) throw new Error('Requête trop volumineuse.');
    return JSON.parse(req.body);
  }
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2048) { req.destroy(); throw new Error('Requête trop volumineuse.'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function sameOrigin(req) {
  if (req.headers['x-onda-request'] !== '1') return false;
  try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const token = await requireSession(req);
    readPolicy(); getStore();
    await rateLimit(`api:${token.split('.')[1]}`, 120, 60000);
    if (req.method === 'GET') return json(res, 200, await usage());
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { error: 'Origine ou méthode interdite.' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'JSON invalide ou trop volumineux.' }); }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'JSON invalide.' });
    const owner = ownerFor(token, body.viewerId);
    if (body.action === 'tv_handoff') {
      await rateLimit(`tv-handoff:${token.split('.')[1]}`, 20, 3600000);
      let provider = null;
      if (String(req.headers['x-iptv-username'] || '')) {
        const { base, isLocked } = resolveBase(req.headers);
        const auth = credentials(req.headers);
        provider = { base: base.origin, username: auth.username, password: auth.password, isLocked };
      }
      return json(res, 200, await issueTvToken(token, body.viewerId, provider));
    }
    if (body.action === 'lease') {
      let urls = null;
      if (body.streamId != null) {
        const { base } = resolveBase(req.headers);
        urls = directUrls(base, credentials(req.headers), body.streamId);
      }
      return json(res, 200, { ...await lease(token, body.viewerId), urls });
    }
    if (body.action === 'release') { await getStore().release(LOCK_KEY, owner); return json(res, 200, { ok: true }); }
    return json(res, 400, { error: 'Action invalide.' });
  } catch (error) {
    return json(res, error.status || (error.message.includes('invalide') ? 400 : 503), {
      error: error.status ? error.message : 'Le contrôle des quotas est indisponible. Lecture bloquée par sécurité.',
      code: error.code || 'QUOTA_UNAVAILABLE', ...(error.snapshot || {})
    });
  }
};
