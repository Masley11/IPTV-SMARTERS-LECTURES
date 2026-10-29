// Same-origin gateway for HTTP Xtream servers with load-balancer redirect & live MPEG-TS support.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_SERVER = 'http://erdaenbv.dupefik.com';
const MAX_JSON_BYTES = 15 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'IPTVSmartersPro/4.0 (Linux; Android 13) VLC/3.0.20';

function configuredOrigin() {
  return (process.env.XTREAM_SERVER || DEFAULT_SERVER).trim().replace(/\/+$/, '');
}

function getBaseURL() {
  const base = new URL(configuredOrigin());
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Configuration XTREAM_SERVER invalide');
  }
  return base;
}

function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function isPrivateOrReservedIP(ip) {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean.startsWith('::ffff:')) {
    const v4 = clean.slice(7);
    if (net.isIPv4(v4)) return isPrivateOrReservedIP(v4);
  }
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(clean)) return true;
    return false;
  }
  return true;
}

async function assertSafeExternalURL(url, base) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Ressource externe invalide');
  }
  if (url.origin === base.origin) return;
  if (isLoopbackHost(base.hostname) && isLoopbackHost(url.hostname)) return;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Hôte interne interdit');
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIP(host)) throw new Error('Adresse IP privée interdite');
    return;
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length) throw new Error('Hôte introuvable');
  for (const record of records) {
    if (isPrivateOrReservedIP(record.address)) throw new Error('Adresse résolue privée interdite');
  }
}

function upstreamURL(path, options = {}) {
  const base = getBaseURL();
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Ressource hors du serveur configuré');
  }
  if (!options.allowExternal && url.origin !== base.origin) {
    throw new Error('Ressource hors du serveur configuré');
  }
  return url;
}

function hmacSecret() {
  return crypto
    .createHash('sha256')
    .update(`${process.env.XTREAM_PROXY_SECRET || process.env.VERCEL_PROJECT_ID || 'onda-iptv-hmac-v1'}|${configuredOrigin()}`)
    .digest();
}

function signResource(targetHref, username, exp) {
  return crypto
    .createHmac('sha256', hmacSecret())
    .update(`${username}\n${exp}\n${targetHref}`)
    .digest('base64url');
}

function verifyResource(targetHref, username, exp, sig) {
  if (!sig || !/^\d{10,15}$/.test(String(exp || ''))) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = Buffer.from(signResource(targetHref, username, String(exp)));
  const provided = Buffer.from(String(sig));
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Requête annulée'));
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Requête annulée'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function singleFetch(url, timeoutMs, externalSignal, headers) {
  const hopController = new AbortController();
  const timer = setTimeout(() => hopController.abort(new Error('Délai de connexion dépassé')), timeoutMs);
  const onAbort = () => hopController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw new Error('Requête annulée');
    }
    externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        ...(headers || {})
      },
      redirect: 'manual',
      signal: hopController.signal
    });
    return { response, detachAbort: () => externalSignal?.removeEventListener('abort', onAbort) };
  } catch (err) {
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function upstreamFetch(initialPath, options = {}) {
  const base = getBaseURL();
  let url = upstreamURL(initialPath, { allowExternal: Boolean(options.allowExternal) });
  await assertSafeExternalURL(url, base);

  const timeoutMs = options.connectTimeoutMs || 20000;
  const externalSignal = options.signal;
  const retryDelays = Array.isArray(options.retryDelays)
    ? options.retryDelays
    : (options.retryTransientLock ? [1200, 1800, 2200, 2500] : []);

  for (let hop = 0; hop < 6; hop++) {
    let attempt = 0;
    let response;
    let detachAbort;
    while (true) {
      ({ response, detachAbort } = await singleFetch(url, timeoutMs, externalSignal, options.headers));
      if (attempt < retryDelays.length && [401, 403, 429, 458, 503].includes(response.status)) {
        detachAbort();
        try { await response.body?.cancel(); } catch { /* ignore */ }
        const delay = retryDelays[attempt++];
        await sleep(delay, externalSignal);
        continue;
      }
      break;
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalURL: url.href };
    }
    detachAbort();
    try { await response.body?.cancel(); } catch { /* ignore */ }
    const next = response.headers.get('location');
    if (!next) throw new Error('Redirection sans destination');
    const nextURL = new URL(next, url);
    await assertSafeExternalURL(nextURL, base);
    if (options.returnRedirectTarget && nextURL.href !== url.href) {
      return { response: null, redirectURL: nextURL.href, finalURL: nextURL.href };
    }
    url = nextURL;
  }
  throw new Error('Trop de redirections');
}

function credentials(query) {
  const username = String(query.username || '');
  const password = String(query.password || '');
  if (!/^[\w@.\-]{1,100}$/.test(username) || !/^[\w@.\-]{1,100}$/.test(password)) {
    throw new Error('Identifiants invalides');
  }
  return { username, password };
}

async function fetchAccountInfo(base, auth, signal) {
  try {
    const api = new URL('/player_api.php', base);
    api.searchParams.set('username', auth.username);
    api.searchParams.set('password', auth.password);
    const { response } = await upstreamFetch(api.href, { signal, connectTimeoutMs: 6000 });
    if (!response.ok) return null;
    const data = await response.json();
    const info = data && data.user_info;
    if (!info || typeof info !== 'object') return null;
    const active = Number(info.active_cons ?? 0);
    const max = Number(info.max_connections ?? 0);
    return {
      status: String(info.status || ''),
      activeConnections: Number.isFinite(active) ? active : 0,
      maxConnections: Number.isFinite(max) ? max : 0,
      expDate: info.exp_date ? String(info.exp_date) : null
    };
  } catch {
    return null;
  }
}

async function diagnoseAuthRejection(base, auth, upstreamStatus, signal) {
  if ([401, 403, 429, 458].includes(upstreamStatus)) {
    const info = await fetchAccountInfo(base, auth, signal);
    if (info) {
      if (info.status && info.status.toLowerCase() !== 'active') {
        return {
          status: 403,
          message: `Ce compte IPTV est inactif ou expiré (statut : ${info.status}).`,
          extra: { code: 'ACCOUNT_INACTIVE', accountStatus: info.status }
        };
      }
      if (info.maxConnections > 0 && info.activeConnections >= info.maxConnections) {
        return {
          status: 429,
          message: `Limite atteinte (${info.activeConnections}/${info.maxConnections} connexion active) : une chaîne est déjà en cours de lecture sur un autre appareil (ex. IPTV Smarters Pro). Arrêtez la lecture sur l’autre appareil puis réessayez.`,
          extra: {
            code: 'MAX_CONNECTIONS',
            activeConnections: info.activeConnections,
            maxConnections: info.maxConnections
          }
        };
      }
    }
  }
  return {
    status: 502,
    message: `Le serveur IPTV a répondu ${upstreamStatus || 502}`,
    extra: { code: 'UPSTREAM_ERROR', upstreamStatus }
  };
}

function playbackURL(query, targetHref, extra = {}) {
  const resolved = String(targetHref);
  const base = getBaseURL();
  const parsed = new URL(resolved, base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Ressource hors du serveur configuré');
  }
  const exp = String(Math.floor(Date.now() / 3600000) * 3600000 + 6 * 3600000);
  const params = new URLSearchParams({
    action: 'resource',
    username: query.username,
    password: query.password,
    id: parsed.href,
    ...extra
  });
  if (parsed.origin !== base.origin) {
    params.set('exp', exp);
    params.set('sig', signResource(parsed.href, query.username, exp));
  }
  return `/api/iptv?${params}`;
}

function rewriteManifest(text, manifestURL, query) {
  const wrap = (value, isVariant = false) => {
    const absolute = new URL(value.trim(), manifestURL);
    if (!['http:', 'https:'].includes(absolute.protocol)) {
      throw new Error('Protocole de segment invalide');
    }
    const extra = isVariant || /\.m3u8(?:\?|$)/i.test(absolute.pathname + absolute.search) ? { manifest: '1' } : {};
    return playbackURL(query, absolute.href, extra);
  };
  const lines = text.split(/\r?\n/);
  let nextIsVariant = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) nextIsVariant = true;
        return line.replace(/URI="([^"]+)"/gi, (_, value) => `URI="${wrap(value, false)}"`);
      }
      const isVar = nextIsVariant;
      nextIsVariant = false;
      return wrap(trimmed, isVar);
    })
    .join('\n');
}

async function peekBody(webBody, minBytes = 512) {
  if (!webBody) return { head: Buffer.alloc(0), reader: null, done: true };
  const reader = webBody.getReader();
  const chunks = [];
  let total = 0;
  let done = false;
  while (total < minBytes) {
    const step = await reader.read();
    if (step.done) {
      done = true;
      break;
    }
    if (step.value && step.value.byteLength) {
      const buf = Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength);
      chunks.push(buf);
      total += buf.length;
    }
  }
  return { head: Buffer.concat(chunks, total), reader, done };
}

async function readRemainingBytes(head, reader, done, maxBytes) {
  const chunks = [head];
  let total = head.length;
  if (total > maxBytes) {
    try { await reader?.cancel(); } catch { /* ignore */ }
    throw new Error('Manifeste HLS trop volumineux');
  }
  while (!done) {
    const step = await reader.read();
    if (step.done) break;
    if (step.value && step.value.byteLength) {
      total += step.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error('Manifeste HLS trop volumineux');
      }
      chunks.push(Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength));
    }
  }
  return Buffer.concat(chunks, total);
}

async function streamReaderToResponse(head, reader, done, res, abortSignal) {
  if (head.length) {
    const ok = res.write(head);
    if (!ok) await new Promise((resolve) => res.once('drain', resolve));
  }
  if (done || !reader) {
    res.end();
    return;
  }
  try {
    while (!abortSignal?.aborted && !res.destroyed) {
      const step = await reader.read();
      if (step.done) break;
      if (step.value && step.value.byteLength) {
        const chunk = Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength);
        const ok = res.write(chunk);
        if (!ok) await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    if (!res.writableEnded) res.end();
  }
}

function looksLikeHLS(head) {
  if (!head.length) return false;
  const sample = head.subarray(0, Math.min(head.length, 256)).toString('utf8');
  return /^\uFEFF?\s*#EXTM3U/i.test(sample);
}

function looksLikeMpegTS(head, contentType) {
  if (head.length > 0 && head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) return true;
  return /video\/mp2t|video\/mpeg/i.test(contentType || '');
}

function fail(res, status, message, extra = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message, ...extra }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') return fail(res, 405, 'Méthode non autorisée');

  const requestAbort = new AbortController();
  const abortNow = () => requestAbort.abort();
  req.on('aborted', abortNow);
  res.on('close', () => {
    if (!res.writableFinished) abortNow();
  });

  try {
    const origin = configuredOrigin();
    const base = getBaseURL();
    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action');

    if (action === 'config') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ server: origin }));
    }

    const auth = credentials({ username: query.get('username'), password: query.get('password') });
    const id = query.get('id');
    const isZapping = query.get('zapping') === '1';
    const lockRetries = isZapping ? [1200, 1800, 2200, 2500] : [1100];

    if (action === 'account') {
      const info = await fetchAccountInfo(base, auth, requestAbort.signal);
      if (!info) return fail(res, 502, 'Impossible de lire l’état du compte IPTV');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(info));
    }

    if (action === 'categories' || action === 'streams') {
      const api = new URL('/player_api.php', base);
      api.searchParams.set('username', auth.username);
      api.searchParams.set('password', auth.password);
      api.searchParams.set('action', action === 'categories' ? 'get_live_categories' : 'get_live_streams');
      const { response } = await upstreamFetch(api.href, { signal: requestAbort.signal });
      if (!response.ok) return fail(res, 502, `Le serveur IPTV a répondu ${response.status}`);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_JSON_BYTES) return fail(res, 502, 'Liste trop volumineuse');
      const text = await response.text();
      if (text.length > MAX_JSON_BYTES) return fail(res, 502, 'Liste trop volumineuse');
      let data;
      try { data = JSON.parse(text); } catch { return fail(res, 502, 'Réponse API invalide (vérifiez vos identifiants)'); }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(data));
    }

    if (action === 'ts') {
      if (!/^\d{1,12}$/.test(id || '')) return fail(res, 400, 'Chaîne invalide');
      const candidates = [
        `/live/${encodeURIComponent(auth.username)}/${encodeURIComponent(auth.password)}/${id}.ts`,
        `/${encodeURIComponent(auth.username)}/${encodeURIComponent(auth.password)}/${id}`
      ];
      let upstream = null;
      let lastStatus = 0;
      for (const candidate of candidates) {
        const result = await upstreamFetch(candidate, {
          signal: requestAbort.signal,
          connectTimeoutMs: 15000,
          retryDelays: lockRetries
        });
        lastStatus = result.response.status;
        if (result.response.ok) {
          upstream = result;
          break;
        }
        try { await result.response.body?.cancel(); } catch { /* ignore */ }
        if (![400, 404].includes(lastStatus)) break;
      }
      if (!upstream) {
        const diag = await diagnoseAuthRejection(base, auth, lastStatus, requestAbort.signal);
        return fail(res, diag.status, diag.message, diag.extra);
      }

      let firstByteTimer;
      const { head, reader, done } = await Promise.race([
        peekBody(upstream.response.body, 188),
        new Promise((_, reject) => {
          firstByteTimer = setTimeout(() => reject(new Error('Chaîne hors antenne ou délai dépassé')), 12000);
        })
      ]).finally(() => clearTimeout(firstByteTimer));
      if (!head.length) {
        try { await reader?.cancel(); } catch { /* ignore */ }
        return fail(res, 502, 'Chaîne actuellement hors antenne (aucun flux vidéo reçu)', { code: 'OFFLINE' });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      await streamReaderToResponse(head, reader, done, res, requestAbort.signal);
      return;
    }

    let targetPath;
    let allowExternal = false;
    const expectsManifest = action === 'play' || query.get('manifest') === '1';

    if (action === 'play') {
      if (!/^\d{1,12}$/.test(id || '')) return fail(res, 400, 'Chaîne invalide');
      targetPath = `/live/${encodeURIComponent(auth.username)}/${encodeURIComponent(auth.password)}/${id}.m3u8`;
    } else if (action === 'resource') {
      if (!id || id.length > 4096) return fail(res, 400, 'Ressource invalide');
      const parsed = new URL(id, base);
      if (parsed.origin !== base.origin) {
        const exp = query.get('exp');
        const sig = query.get('sig');
        if (!verifyResource(parsed.href, auth.username, exp, sig)) {
          throw new Error('Ressource hors du serveur configuré');
        }
        allowExternal = true;
      }
      targetPath = parsed.href;
    } else {
      return fail(res, 400, 'Action invalide');
    }

    const fetched = await upstreamFetch(targetPath, {
      allowExternal,
      signal: requestAbort.signal,
      connectTimeoutMs: 15000,
      retryDelays: action === 'play' ? lockRetries : [],
      returnRedirectTarget: action === 'play'
    });

    if (fetched.redirectURL) {
      res.statusCode = 302;
      res.setHeader('Location', playbackURL(auth, fetched.redirectURL, { manifest: '1' }));
      return res.end();
    }

    const { response, finalURL } = fetched;
    if (!response.ok) {
      const diag = action === 'play'
        ? await diagnoseAuthRejection(base, auth, response.status, requestAbort.signal)
        : { status: 502, message: `Le serveur IPTV a répondu ${response.status}`, extra: {} };
      return fail(res, diag.status, diag.message, diag.extra);
    }

    const contentType = response.headers.get('content-type') || '';
    const { head, reader, done } = await peekBody(response.body, 512);

    if (looksLikeHLS(head)) {
      const fullBuf = await readRemainingBytes(head, reader, done, MAX_MANIFEST_BYTES);
      const rewritten = rewriteManifest(fullBuf.toString('utf8'), finalURL, auth);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.end(rewritten);
    }

    if (expectsManifest) {
      try { await reader?.cancel(); } catch { /* ignore */ }
      if (looksLikeMpegTS(head, contentType)) {
        return fail(res, 415, 'Ce flux est diffusé en MPEG-TS direct (.ts)', { code: 'MPEGTS_DIRECT' });
      }
      if (!head.length) {
        return fail(res, 502, 'Chaîne actuellement hors antenne (flux vide)', { code: 'OFFLINE' });
      }
      return fail(res, 502, 'Flux HLS indisponible sur cette chaîne', { code: 'NO_HLS' });
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    if (response.headers.get('content-length')) {
      res.setHeader('Content-Length', response.headers.get('content-length'));
    }
    await streamReaderToResponse(head, reader, done, res, requestAbort.signal);
  } catch (error) {
    if (!res.headersSent) fail(res, 502, error.message || 'Serveur IPTV inaccessible');
    else res.destroy(error);
  }
};

module.exports.rewriteManifest = rewriteManifest;
module.exports.upstreamURL = upstreamURL;
module.exports.signResource = signResource;
module.exports.verifyResource = verifyResource;
