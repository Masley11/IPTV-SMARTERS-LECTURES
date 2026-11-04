/* Shared Xtream metadata helpers. Metadata only: never fetch or relay video segments. */
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_JSON_BYTES = 12 * 1024 * 1024;
const USER_AGENT = 'IPTVSmartersPro/4.0 (Linux; Android 13) VLC/3.0.20';
const safeHostCache = globalThis.__ondaSafeHostCache || (globalThis.__ondaSafeHostCache = new Map());

function privateIP(ip) {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean.startsWith('::ffff:')) return privateIP(clean.slice(7));
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b >= 16 && b <= 31) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 168) || a >= 224;
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

function slimCatalogue(categories, streams) {
  return {
    categories: (Array.isArray(categories) ? categories : [])
      .filter(it => it && it.category_id != null)
      .map(it => ({ category_id: it.category_id, category_name: it.category_name })),
    streams: (Array.isArray(streams) ? streams : [])
      .filter(it => it && it.stream_id != null)
      .map(it => {
        const slim = { stream_id: it.stream_id, name: it.name };
        if (it.category_id != null) slim.category_id = it.category_id;
        return slim;
      })
  };
}

module.exports = { MAX_JSON_BYTES, USER_AGENT, privateIP, safeURL, metadata, boundedJSON, apiURL, slimCatalogue };
