/**
 * StreamPulse — Cloudflare Worker Media Relay (Optionnel, 0 € de bande passante sortante)
 *
 * Pourquoi ce fichier ?
 * Sur Vercel Hobby, le quota "Fast Origin Transfer" est limité à 10 Go/mois partagés.
 * Or 1 heure de flux TV HD représente ~1,5 à 3 Go de segments vidéo (.ts).
 * En déployant ce script sur un Cloudflare Worker gratuit (https://dash.cloudflare.com -> Workers),
 * puis en ajoutant la variable d'environnement Vercel :
 *   STREAM_RELAY_URL = https://votre-worker.votre-compte.workers.dev
 * 100 % des segments vidéo (.m3u8 / .ts) passent par Cloudflare (bande passante sortante gratuite)
 * et la consommation Fast Origin Transfer de Vercel tombe à ~0 Go !
 */

const USER_AGENT = 'IPTVSmartersPro/4.0 (Linux; Android 13) VLC/3.0.20';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Cache-Control': 'no-store'
  };
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(reqOrigin) });
    }
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: corsHeaders(reqOrigin) });
    }

    const reqUrl = new URL(request.url);
    const q = reqUrl.searchParams;
    const action = q.get('action');
    const server = (q.get('server') || env.XTREAM_SERVER || '').trim().replace(/\/+$/, '');
    const username = q.get('username') || '';
    const password = q.get('password') || '';
    const id = q.get('id') || '';
    const secret = env.RELAY_SECRET || 'streampulse-cf-relay-v1';

    if (!server) {
      return Response.json({ error: 'Serveur manquant' }, { status: 400, headers: corsHeaders(reqOrigin) });
    }

    let base;
    try {
      base = new URL(server);
      if (isBlockedHost(base.hostname)) throw new Error('blocked');
    } catch {
      return Response.json({ error: 'Serveur invalide' }, { status: 400, headers: corsHeaders(reqOrigin) });
    }

    const wrapUrl = async (targetHref, extra = {}) => {
      const target = new URL(targetHref, base);
      const exp = String(Math.floor(Date.now() / 3600000) * 3600000 + 6 * 3600000);
      const params = new URLSearchParams({
        action: 'resource',
        server: base.origin,
        username,
        password,
        id: target.href,
        ...extra
      });
      if (target.origin !== base.origin) {
        params.set('exp', exp);
        params.set('sig', await hmacSign(secret, `${username}\n${base.origin}\n${exp}\n${target.href}`));
      }
      return `${reqUrl.origin}/api/iptv?${params}`;
    };

    try {
      if (action === 'ts') {
        const tsTarget = new URL(`/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.ts`, base);
        const upstream = await fetch(tsTarget.href, {
          headers: { 'User-Agent': USER_AGENT },
          redirect: 'follow'
        });
        if (!upstream.ok) {
          return Response.json({ error: `Upstream ${upstream.status}` }, { status: upstream.status === 401 || upstream.status === 403 ? 429 : 502, headers: corsHeaders(reqOrigin) });
        }
        return new Response(upstream.body, {
          status: 200,
          headers: { ...corsHeaders(reqOrigin), 'Content-Type': 'video/mp2t' }
        });
      }

      let targetHref;
      if (action === 'play') {
        targetHref = new URL(`/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.m3u8`, base).href;
      } else if (action === 'resource') {
        const parsed = new URL(id, base);
        if (isBlockedHost(parsed.hostname)) throw new Error('Hôte interdit');
        if (parsed.origin !== base.origin) {
          const exp = q.get('exp') || '';
          const sig = q.get('sig') || '';
          const expected = await hmacSign(secret, `${username}\n${base.origin}\n${exp}\n${parsed.href}`);
          if (Number(exp) < Date.now() || sig !== expected) {
            return Response.json({ error: 'Signature expirée' }, { status: 403, headers: corsHeaders(reqOrigin) });
          }
        }
        targetHref = parsed.href;
      } else {
        return Response.json({ error: 'Action invalide' }, { status: 400, headers: corsHeaders(reqOrigin) });
      }

      const upstream = await fetch(targetHref, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: action === 'play' ? 'manual' : 'follow'
      });

      if (action === 'play' && [301, 302, 303, 307, 308].includes(upstream.status)) {
        const loc = upstream.headers.get('Location');
        if (loc) {
          const next = await wrapUrl(new URL(loc, targetHref).href, { manifest: '1' });
          return new Response(null, { status: 302, headers: { ...corsHeaders(reqOrigin), Location: next } });
        }
      }

      if (!upstream.ok) {
        return Response.json({ error: `Upstream ${upstream.status}` }, { status: [401, 403, 458].includes(upstream.status) ? 429 : 502, headers: corsHeaders(reqOrigin) });
      }

      const ct = upstream.headers.get('content-type') || '';
      if (action === 'play' || q.get('manifest') === '1' || /mpegurl/i.test(ct)) {
        const text = await upstream.text();
        if (!/^\uFEFF?\s*#EXTM3U/i.test(text)) {
          return Response.json({ error: 'MPEGTS_DIRECT', code: 'MPEGTS_DIRECT' }, { status: 415, headers: corsHeaders(reqOrigin) });
        }
        const lines = text.split(/\r?\n/);
        let nextIsVar = false;
        const out = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { out.push(line); continue; }
          if (trimmed.startsWith('#')) {
            if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) nextIsVar = true;
            if (/URI="([^"]+)"/i.test(trimmed)) {
              const m = trimmed.match(/URI="([^"]+)"/i);
              const wrapped = await wrapUrl(new URL(m[1], targetHref).href);
              out.push(trimmed.replace(/URI="([^"]+)"/i, `URI="${wrapped}"`));
            } else {
              out.push(line);
            }
            continue;
          }
          const isVar = nextIsVar;
          nextIsVar = false;
          const extra = isVar || /\.m3u8(?:\?|$)/i.test(trimmed) ? { manifest: '1' } : {};
          out.push(await wrapUrl(new URL(trimmed, targetHref).href, extra));
        }
        return new Response(out.join('\n'), {
          status: 200,
          headers: { ...corsHeaders(reqOrigin), 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' }
        });
      }

      return new Response(upstream.body, {
        status: 200,
        headers: { ...corsHeaders(reqOrigin), 'Content-Type': ct || 'video/mp2t' }
      });
    } catch (err) {
      return Response.json({ error: err.message || 'Relay error' }, { status: 502, headers: corsHeaders(reqOrigin) });
    }
  }
};
