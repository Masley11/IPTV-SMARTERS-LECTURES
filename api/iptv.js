// Same-origin gateway for HTTP Xtream servers. Only the configured upstream is reachable.
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const origin = (process.env.XTREAM_SERVER || 'http://erdaenbv.dupefik.com').replace(/\/+$/, '');
const MAX_JSON_BYTES = 12 * 1024 * 1024;

function upstreamURL(path) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Configuration XTREAM_SERVER invalide');
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Ressource hors du serveur configuré');
  return url;
}

async function upstreamFetch(path, options = {}) {
  let url = upstreamURL(path);
  for (let i = 0; i < 4; i++) {
    const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = response.headers.get('location');
    if (!next) throw new Error('Redirection sans destination');
    url = upstreamURL(new URL(next, url).href);
  }
  throw new Error('Trop de redirections');
}

function credentials(query) {
  const username = String(query.username || '');
  const password = String(query.password || '');
  if (!/^[\w@.\-]{1,100}$/.test(username) || !/^[\w@.\-]{1,100}$/.test(password)) throw new Error('Identifiants invalides');
  return { username, password };
}

function playbackURL(query, id) {
  const params = new URLSearchParams({ action: 'resource', username: query.username, password: query.password, id: String(id) });
  return `/api/iptv?${params}`;
}

function rewriteManifest(text, manifestURL, query) {
  const wrap = (value) => {
    const absolute = new URL(value, manifestURL);
    upstreamURL(absolute.href); // Reject external hosts, javascript:, etc.
    return playbackURL(query, absolute.href);
  };
  return text.split(/\r?\n/).map(line => {
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${wrap(value)}"`);
    return line.trim() ? wrap(line.trim()) : line;
  }).join('\n');
}

function fail(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') return fail(res, 405, 'Méthode non autorisée');
  try {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action');
    if (action === 'config') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ server: origin }));
    }
    const auth = credentials({ username: query.get('username'), password: query.get('password') });
    const id = query.get('id');
    let path;
    if (action === 'categories' || action === 'streams') {
      const api = new URL('/player_api.php', origin);
      api.searchParams.set('username', auth.username);
      api.searchParams.set('password', auth.password);
      api.searchParams.set('action', action === 'categories' ? 'get_live_categories' : 'get_live_streams');
      path = api.href;
    } else if (action === 'play') {
      if (!/^\d{1,12}$/.test(id || '')) return fail(res, 400, 'Chaîne invalide');
      path = `/live/${encodeURIComponent(auth.username)}/${encodeURIComponent(auth.password)}/${id}.m3u8`;
    } else if (action === 'resource') {
      path = id;
      if (!path || path.length > 4096) return fail(res, 400, 'Ressource invalide');
    } else return fail(res, 400, 'Action invalide');

    const response = await upstreamFetch(path, { headers: { 'Accept': '*/*' } });
    if (!response.ok) return fail(res, 502, `Le serveur IPTV a répondu ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    const isManifest = action === 'play' || /mpegurl|\.m3u8(?:\?|$)/i.test(contentType + ' ' + response.url);

    if (action === 'categories' || action === 'streams') {
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_JSON_BYTES) return fail(res, 502, 'Liste trop volumineuse');
      const text = await response.text();
      if (text.length > MAX_JSON_BYTES) return fail(res, 502, 'Liste trop volumineuse');
      let data;
      try { data = JSON.parse(text); } catch { return fail(res, 502, 'Réponse API invalide (vérifiez vos identifiants)'); }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(data));
    }
    if (isManifest) {
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024 || !text.trimStart().startsWith('#EXTM3U')) return fail(res, 502, 'Flux HLS indisponible sur ce serveur');
      const rewritten = rewriteManifest(text, response.url, { ...auth });
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.end(rewritten);
    }
    if (action === 'play') return fail(res, 502, 'Ce flux ne fournit pas de playlist HLS');
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!res.headersSent) fail(res, 502, error.message || 'Serveur IPTV inaccessible');
    else res.destroy(error);
  }
};
module.exports.rewriteManifest = rewriteManifest;
module.exports.upstreamURL = upstreamURL;
