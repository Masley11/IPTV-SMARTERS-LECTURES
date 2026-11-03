/* Private Xtream metadata gateway. VIDEO NEVER PASSES THROUGH VERCEL.
 * Credentials use request headers, not CDN/function query logs.
 * Playlists, EPG and encrypted pairing are small, bounded JSON responses.
 */
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');
const { requireSession, rateLimit, hash } = require('../lib/access');
const { getStore } = require('../lib/store');
const { resolveBase, credentials, lockedOrigin } = require('../lib/xtream');
const { readPolicy } = require('../lib/policy');

const MAX_JSON_BYTES = 12 * 1024 * 1024;
const USER_AGENT = 'IPTVSmartersPro/4.0 (Linux; Android 13) VLC/3.0.20';
const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const safeHostCache = globalThis.__ondaSafeHostCache || (globalThis.__ondaSafeHostCache = new Map());

function decodeEpg(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 4 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    try {
      const buf = Buffer.from(s, 'base64');
      if (buf.length && buf.toString('base64').replace(/=+$/, '') === s.replace(/=+$/, '')) {
        const utf8 = buf.toString('utf8').trim();
        if (utf8 && !utf8.includes('\uFFFD') && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(utf8) && (/=|\/|\+/.test(s) || /^[\p{L}\p{N}\p{P}\p{Zs}\r\n\t]+$/u.test(utf8))) return utf8;
      }
    } catch { /* keep raw */ }
  }
  return s;
}
function timestamp(number, date) {
  const n = Number(number);
  if (Number.isFinite(n) && n > 100000000) return Math.floor(n > 1e12 ? n / 1000 : n);
  const ms = Date.parse(String(date || '').trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/, '$1T$2Z'));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
function normalizeEpg(raw) {
  if (!Array.isArray(raw)) return [];
  const now = Date.now() / 1000;
  return raw.filter(Boolean).map(item => ({
    title: decodeEpg(item.title).slice(0, 240), desc: decodeEpg(item.description).slice(0, 180),
    startTs: timestamp(item.start_timestamp, item.start), stopTs: timestamp(item.stop_timestamp, item.end || item.stop)
  })).filter(item => item.title && item.startTs && item.stopTs > item.startTs && item.stopTs > now - 60)
    .sort((a, b) => a.startTs - b.startTs).slice(0, 2);
}
function privateIP(ip) {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean.startsWith('::ffff:')) return privateIP(clean.slice(7));
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(clean)) return clean === '::' || clean === '::1' || /^f[cd]/.test(clean) || /^fe[89ab]/.test(clean);
  return true;
}
async function safeURL(url, trustedLockedBase) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Ressource externe invalide');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (trustedLockedBase && url.origin === trustedLockedBase.origin) return;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Hôte interne interdit');
  if (net.isIP(host)) { if (privateIP(host)) throw new Error('Adresse IP privée interdite'); return; }
  const cached = safeHostCache.get(host);
  if (cached > Date.now()) return;
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some(record => privateIP(record.address))) throw new Error('Adresse résolue privée interdite');
  if (safeHostCache.size > 200) safeHostCache.clear();
  safeHostCache.set(host, Date.now() + 600000);
}
async function metadata(url, base, isLocked, signal, timeout = 12000, hops = 0) {
  if (hops >= 3) throw new Error('Trop de redirections API');
  await safeURL(url, isLocked ? base : null);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  });
  // Some providers use one redirect to a metadata API. Never forward credentials to another origin.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const target = new URL(response.headers.get('location') || '', url);
    if (target.origin !== base.origin) throw new Error('Redirection API externe non autorisée');
    return metadata(target, base, isLocked, signal, timeout, hops + 1);
  }
  return response;
}
async function boundedJSON(response, limit = MAX_JSON_BYTES) {
  try {
    if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('Réponse trop volumineuse');
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Réponse trop volumineuse'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}
function apiURL(base, auth, action, id) {
  const url = new URL('/player_api.php', base);
  url.searchParams.set('username', auth.username); url.searchParams.set('password', auth.password);
  if (action) url.searchParams.set('action', action);
  if (id) { url.searchParams.set('stream_id', id); url.searchParams.set('limit', '6'); }
  return url;
}
function json(res, status, payload) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function fail(res, status, message, extra = {}) { json(res, status, { error: message, ...extra }); }
async function readBody(req) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > 8192) throw new Error('Requête trop volumineuse');
    return JSON.parse(req.body.toString('utf8'));
  }
  if (typeof req.body === 'string') {
    if (req.body.length > 8192) throw new Error('Requête trop volumineuse');
    return JSON.parse(req.body);
  }
  if (req.body && typeof req.body === 'object') return req.body;
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) { req.destroy(); throw new Error('Requête trop volumineuse'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('JSON invalide'); }
}
function sameOrigin(req) {
  if (req.headers['x-onda-request'] !== '1') return false;
  try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const abort = new AbortController();
  req.on('aborted', () => abort.abort());
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const token = await requireSession(req);
    readPolicy(); getStore();
    await rateLimit(`api:${token.split('.')[1]}`, 120, 60000);
    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action');
    if (['play', 'ts', 'resource'].includes(action)) {
      return fail(res, 410, 'Le relais vidéo est désactivé : utilisez /api/access pour une lecture directe sans consommation vidéo Vercel.', { code: 'VIDEO_RELAY_DISABLED' });
    }
    if (action === 'config' && req.method === 'GET') {
      return json(res, 200, { server: lockedOrigin() || null, locked: Boolean(lockedOrigin()), relayUrl: null, videoRoute: 'direct', policy: readPolicy() });
    }

    // Distributed, short-lived, burn-after-reading E2EE pairing. No long polls or sticky RAM.
    if (action?.startsWith('pair_')) {
      const store = getStore();
      if (action === 'pair_create') {
        if (req.method !== 'POST' || !sameOrigin(req)) return fail(res, 403, 'Origine ou méthode interdite');
        await rateLimit(`pair:${token.split('.')[1]}`, 6, PAIR_TTL_MS);
        const bytes = crypto.randomBytes(6);
        const code = Array.from(bytes, b => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
        const readToken = crypto.randomBytes(24).toString('base64url');
        await store.set(`onda:pair:${code}`, JSON.stringify({ readHash: hash(readToken), expires: Date.now() + PAIR_TTL_MS }), PAIR_TTL_MS);
        return json(res, 200, { code, readToken, expiresIn: PAIR_TTL_MS / 1000 });
      }
      if (action === 'pair_send') {
        if (req.method !== 'POST' || !sameOrigin(req)) return fail(res, 403, 'Origine ou méthode interdite');
        const body = await readBody(req);
        const code = String(body.code || '').toUpperCase();
        const iv = String(body.iv || ''); const ciphertext = String(body.ciphertext || '');
        if (!/^[A-Z2-9]{6}$/.test(code) || !/^[A-Za-z0-9_\-+/=]{12,64}$/.test(iv) || !/^[A-Za-z0-9_\-+/=]{16,4096}$/.test(ciphertext)) return fail(res, 400, 'Format chiffré invalide');
        const key = `onda:pair:${code}`;
        const session = JSON.parse(await store.get(key) || 'null');
        if (!session || session.expires <= Date.now()) return fail(res, 404, 'Code TV expiré. Générez un nouveau QR Code.');
        await store.set(`${key}:envelope`, JSON.stringify({ iv, ciphertext, mode: body.mode === 'manual' ? 'manual' : 'qr' }), session.expires - Date.now());
        return json(res, 200, { ok: true });
      }
      if (action === 'pair_wait') {
        if (req.method !== 'GET') return fail(res, 405, 'Méthode non autorisée');
        const code = String(query.get('code') || '').toUpperCase();
        if (!/^[A-Z2-9]{6}$/.test(code)) return fail(res, 400, 'Code invalide');
        const key = `onda:pair:${code}`;
        const session = JSON.parse(await store.get(key) || 'null');
        const supplied = Buffer.from(hash(String(req.headers['x-pair-token'] || '')));
        const expected = Buffer.from(session?.readHash || '');
        if (!session || session.expires <= Date.now()) return fail(res, 404, 'Code TV expiré', { code: 'PAIR_EXPIRED' });
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return fail(res, 403, 'Jeton TV invalide');
        const envelope = await store.getdel(`${key}:envelope`);
        if (envelope) { await store.del(key); return json(res, 200, { status: 'paired', envelope: JSON.parse(envelope) }); }
        return json(res, 200, { status: 'waiting', expiresIn: Math.ceil((session.expires - Date.now()) / 1000) });
      }
      return fail(res, 400, 'Action invalide');
    }

    if (req.method !== 'GET') return fail(res, 405, 'Méthode non autorisée');
    const { base, isLocked } = resolveBase(req.headers);
    const auth = credentials(req.headers);
    const id = query.get('id');
    if (action === 'account') {
      const response = await metadata(apiURL(base, auth), base, isLocked, abort.signal, 6000);
      if (!response.ok) { await response.body?.cancel(); return fail(res, 502, `Le serveur IPTV a répondu ${response.status}`); }
      const data = await boundedJSON(response, 65536);
      const info = data?.user_info;
      if (!info || typeof info !== 'object') return fail(res, 502, 'Réponse de compte IPTV invalide');
      if (Number(info.auth) === 0 || info.status === 'Invalid') return fail(res, 403, 'Identifiants Xtream incorrects', { code: 'INVALID_CREDENTIALS' });
      return json(res, 200, { status: String(info.status || ''), activeConnections: Number(info.active_cons || 0), maxConnections: Number(info.max_connections || 0), expDate: info.exp_date ? String(info.exp_date) : null });
    }
    if (action === 'epg') {
      if (!/^\d{1,12}$/.test(id || '')) return json(res, 200, { listings: [] });
      const store = getStore();
      const key = `onda:epg:${hash(`${base.origin}|${auth.username}|${auth.password}|${id}`)}`;
      const cached = await store.get(key);
      if (cached) return json(res, 200, { listings: JSON.parse(cached) });
      const response = await metadata(apiURL(base, auth, 'get_short_epg', id), base, isLocked, abort.signal, 7000);
      if (!response.ok) { await response.body?.cancel(); return json(res, 200, { listings: [] }); }
      const data = await boundedJSON(response, 524288);
      const listings = normalizeEpg(Array.isArray(data?.epg_listings) ? data.epg_listings : data);
      await store.set(key, JSON.stringify(listings), 10 * 60000);
      return json(res, 200, { listings });
    }
    if (action === 'categories' || action === 'streams') {
      const response = await metadata(apiURL(base, auth, action === 'categories' ? 'get_live_categories' : 'get_live_streams'), base, isLocked, abort.signal);
      if (!response.ok) { await response.body?.cancel(); return fail(res, 502, `Le serveur IPTV a répondu ${response.status}`); }
      let data = await boundedJSON(response);
      if (!Array.isArray(data)) return fail(res, 502, 'Catalogue invalide : vérifiez vos identifiants');
      data = action === 'categories'
        ? data.filter(it => it && it.category_id != null).map(it => ({ category_id: it.category_id, category_name: it.category_name }))
        : data.filter(it => it && it.stream_id != null).map(it => {
          const slim = { stream_id: it.stream_id, name: it.name };
          if (it.category_id != null) slim.category_id = it.category_id;
          if (it.stream_icon && /^https:\/\//i.test(it.stream_icon)) slim.stream_icon = it.stream_icon;
          return slim;
        });
      const raw = Buffer.from(JSON.stringify(data));
      res.setHeader('Vary', 'Accept-Encoding');
      const result = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || '')) ? zlib.gzipSync(raw, { level: 6 }) : raw;
      if (result !== raw) res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', result.length);
      return res.end(result);
    }
    return fail(res, 400, 'Action invalide');
  } catch (error) {
    if (res.headersSent) return res.end();
    const invalid = /invalide|verrouillé|manquante|interdit/i.test(error.message);
    return fail(res, error.status || (invalid ? 400 : 502), error.status === 401 ? error.message : (error.message || 'Serveur IPTV inaccessible'), { code: error.code || (invalid ? 'INVALID_REQUEST' : 'UPSTREAM_ERROR') });
  }
};
module.exports.normalizeEpg = normalizeEpg;
module.exports.privateIP = privateIP;
