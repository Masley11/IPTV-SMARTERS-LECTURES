/* Metadata + quota bridge for the external HTTP TV player.
 * VIDEO NEVER PASSES THROUGH VERCEL. The player fetches media directly from the provider.
 */
const zlib = require('node:zlib');
const { rateLimit, ownerFor, usage, lease, LOCK_KEY } = require('../lib/access');
const { getStore } = require('../lib/store');
const { readPolicy } = require('../lib/policy');
const { directUrls } = require('../lib/xtream');
const { metadata, boundedJSON, apiURL, slimCatalogue } = require('../lib/provider');
const { hash, requireTvToken, pseudoSession, providerAuth } = require('../lib/tv');

const ALLOWED_ORIGINS = new Set([
  'http://raw.githack.com', 'https://raw.githack.com',
  'http://rawcdn.githack.com', 'https://rawcdn.githack.com'
]);
function json(res, status, payload) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(payload));
}
function cors(req, res) {
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2048) { req.destroy(); throw new Error('Requête trop volumineuse.'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

module.exports = async function handler(req, res) {
  cors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const origin = String(req.headers.origin || '');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(res, 403, { error: 'Origine interdite.', code: 'ORIGIN_DENIED' });
  try {
    readPolicy(); getStore();
    const token = bearer(req);
    const record = await requireTvToken(token);
    await rateLimit(`tv:${hash(token)}`, 120, 60000);
    const query = new URL(req.url, 'http://localhost').searchParams;
    const body = req.method === 'POST' ? await readBody(req) : {};
    const action = req.method === 'GET' ? query.get('action') : body.action;
    if (req.method === 'GET' && action === 'usage') return json(res, 200, await usage());
    if (req.method === 'GET' && action === 'catalogue') {
      const provider = providerAuth(record);
      if (!provider) return json(res, 200, { categories: [], streams: [] });
      const abort = new AbortController();
      req.on('aborted', () => abort.abort());
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      const [categoriesResponse, streamsResponse] = await Promise.all([
        metadata(apiURL(provider.base, provider.auth, 'get_live_categories'), provider.base, provider.isLocked, abort.signal),
        metadata(apiURL(provider.base, provider.auth, 'get_live_streams'), provider.base, provider.isLocked, abort.signal)
      ]);
      if (!categoriesResponse.ok || !streamsResponse.ok) {
        await categoriesResponse.body?.cancel(); await streamsResponse.body?.cancel();
        return json(res, 502, { error: 'Catalogue fournisseur indisponible.', code: 'CATALOGUE_UNAVAILABLE' });
      }
      const [categories, streams] = await Promise.all([boundedJSON(categoriesResponse), boundedJSON(streamsResponse)]);
      const payload = Buffer.from(JSON.stringify(slimCatalogue(categories, streams)));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', 'Accept-Encoding, Origin');
      if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
        res.setHeader('Content-Encoding', 'gzip');
        return res.end(zlib.gzipSync(payload, { level: 6 }));
      }
      return res.end(payload);
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée.' });
    const session = pseudoSession(record);
    if (body.action === 'lease') {
      const result = await lease(session, record.viewerId);
      let urls = null;
      if (body.streamId != null) {
        const provider = providerAuth(record);
        if (provider) urls = directUrls(provider.base, provider.auth, body.streamId);
      }
      return json(res, 200, { ...result, urls });
    }
    if (body.action === 'release') {
      await getStore().release(LOCK_KEY, ownerFor(session, record.viewerId));
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'Action invalide.' });
  } catch (error) {
    return json(res, error.status || (String(error.message).includes('invalide') ? 400 : 503), {
      error: error.status ? error.message : 'Le contrôle TV est indisponible. Lecture bloquée par sécurité.',
      code: error.code || 'TV_UNAVAILABLE', ...(error.snapshot || {})
    });
  }
};
