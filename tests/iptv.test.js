const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.ONDA_LOCAL_DEV = '1';
process.env.APP_ACCESS_PASSWORD = 'test-password-private';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
process.env.XTREAM_SERVER = '';
process.env.DAILY_WATCH_MINUTES = '120';
process.env.MONTHLY_WATCH_MINUTES = '2700';
process.env.WATCH_START_HOUR_UTC = '0';
process.env.WATCH_END_HOUR_UTC = '24';
const { getStore, LocalStore } = require('../lib/store');
const { createSession, verifySession } = require('../lib/session');
const { readPolicy, quotaWindow, publicUsage } = require('../lib/policy');
const handlers = { auth: require('../api/auth'), access: require('../api/access'), iptv: require('../api/iptv') };
let middleware;
test.before(async () => { middleware = (await import('../middleware.js')).default; });

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
function reset() { const store = getStore(); store.values.clear(); store.hashes.clear(); }
const viewerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const viewerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('signed sessions expire, reject tampering and require a strong secret', async () => {
  const secret = process.env.SESSION_SECRET;
  const token = await createSession(secret, 1700000000000);
  assert.equal(await verifySession(token, secret, 1700000000001), true);
  assert.equal(await verifySession(token, secret, 1700000000000 + 86400001), false);
  assert.equal(await verifySession(token.slice(0, -1) + 'x', secret, 1700000000001), false);
  assert.equal(await verifySession(token, '', 1700000000001), false);
});

test('conservative quotas reset on UTC day/calendar month and never become negative', () => {
  const policy = readPolicy({});
  assert.equal(policy.dailyMinutes, 120); assert.equal(policy.monthlyMinutes, 2700); assert.equal(policy.videoRoute, 'direct');
  const now = Date.parse('2026-11-03T20:00:00Z');
  const window = quotaWindow(now, policy);
  assert.equal(window.windowStart, Date.parse('2026-11-03T06:00:00Z'));
  assert.equal(window.windowEnd, Date.parse('2026-11-04T00:00:00Z'));
  assert.equal(window.nextMonth, Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(publicUsage(7200000, 162000000, policy, now).dayRemainingSeconds, 0);
  assert.throws(() => readPolicy({ DAILY_WATCH_MINUTES: '9999' }));
  assert.throws(() => readPolicy({ WATCH_START_HOUR_UTC: '22', WATCH_END_HOUR_UTC: '6' }));
});

test('atomic reservation: one viewer, zap reuse, no refund, daily/monthly/hour caps', async () => {
  const store = new LocalStore();
  const now = Date.now();
  const keys = ['day', 'month', 'lock'];
  const args = [now, 'owner-a', 60000, 120000, 180000, now - 3600000, now + 7200000, 86400000, 2678400000];
  let result = await store.reserve(keys, args);
  assert.equal(result[0], 'OK'); assert.equal(result[4], 60000);
  result = await store.reserve(keys, [now + 1000, 'owner-a', ...args.slice(2)]);
  assert.equal(result[4], 0, 'zapping reuses the current paid minute');
  result = await store.reserve(keys, [now + 2000, 'owner-b', ...args.slice(2)]);
  assert.equal(result[0], 'BUSY');
  result = await store.reserve(keys, [now + 55000, 'owner-a', ...args.slice(2)]);
  assert.equal(result[1], now + 120000); assert.equal(result[2], 120000);
  await store.release('lock', 'owner-b'); assert.ok(store.hash('lock', now));
  await store.release('lock', 'owner-a'); assert.equal(store.hash('lock', now), null);
  result = await store.reserve(keys, [now + 60000, 'owner-b', ...args.slice(2)]);
  assert.equal(result[0], 'DAILY_LIMIT'); assert.equal(result[2], 120000);
  store.values.set('month', { value: '180000', expires: now + 86400000 });
  result = await store.reserve(['day2', 'month', 'lock'], [now, 'owner-a', ...args.slice(2)]);
  assert.equal(result[0], 'MONTHLY_LIMIT'); assert.equal(result[3], 180000);
  result = await store.reserve(['day3', 'month3', 'lock'], [now, 'owner-a', ...args.slice(2, 5), now - 3600000, now - 1, ...args.slice(7)]);
  assert.equal(result[0], 'OUTSIDE_HOURS');
});

test('private HTTP gateway: auth, distributed pairing, quotas, metadata headers and NO video relay', async () => {
  reset();
  let metadataCalls = 0; let videoCalls = 0;
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/live/')) { videoCalls++; res.writeHead(500).end(); return; }
    metadataCalls++;
    assert.equal(url.searchParams.get('username'), 'test');
    assert.equal(url.searchParams.get('password'), 'secret');
    res.setHeader('Content-Type', 'application/json');
    const action = url.searchParams.get('action');
    if (!action) return res.end(JSON.stringify({ user_info: { auth: 1, status: 'Active', active_cons: 0, max_connections: 1, exp_date: '1795267007' } }));
    if (action === 'get_live_categories') return res.end(JSON.stringify([{ category_id: '1', category_name: 'Infos', private_field: 'remove' }]));
    if (action === 'get_live_streams') return res.end(JSON.stringify([{ stream_id: 42, name: 'Info TV', stream_icon: 'http://unsafe.example/image.png' }]));
    if (action === 'get_short_epg') return res.end(JSON.stringify({ epg_listings: [{ title: Buffer.from('Journal').toString('base64'), description: '', start_timestamp: Math.floor(Date.now() / 1000) - 60, stop_timestamp: Math.floor(Date.now() / 1000) + 1800 }] }));
    res.end('[]');
  });
  const upstreamPort = await listen(upstream);
  process.env.XTREAM_SERVER = `http://127.0.0.1:${upstreamPort}`;
  const gateway = http.createServer((req, res) => handlers[new URL(req.url, 'http://localhost').pathname.split('/')[2]](req, res));
  const port = await listen(gateway); const origin = `http://127.0.0.1:${port}`;
  const post = (path, body, cookie = '') => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Onda-Request': '1', 'X-Iptv-Username': 'test', 'X-Iptv-Password': 'secret', Cookie: cookie }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(origin + '/api/access')).status, 401);
    assert.equal((await fetch(origin + '/api/iptv?action=streams')).status, 401);
    const denied = await middleware(new Request(origin + '/'));
    assert.equal(denied.status, 302); assert.match(denied.headers.get('location'), /login\.html/);
    assert.equal((await post('/api/auth', { password: 'wrong' })).status, 401);
    const login = await post('/api/auth', { password: process.env.APP_ACCESS_PASSWORD });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    const allowed = await middleware(new Request(origin + '/', { headers: { cookie } }));
    assert.equal(allowed.headers.get('x-middleware-next'), '1');
    const headers = { Cookie: cookie, 'X-Iptv-Username': 'test', 'X-Iptv-Password': 'secret' };
    const categories = await fetch(origin + '/api/iptv?action=categories', { headers });
    assert.deepEqual(await categories.json(), [{ category_id: '1', category_name: 'Infos' }]);
    const streams = await fetch(origin + '/api/iptv?action=streams', { headers });
    assert.deepEqual(await streams.json(), [{ stream_id: 42, name: 'Info TV' }]);
    const account = await fetch(origin + '/api/iptv?action=account', { headers });
    assert.equal((await account.json()).maxConnections, 1);
    const epg = await fetch(origin + '/api/iptv?action=epg&id=42', { headers });
    assert.equal((await epg.json()).listings[0].title, 'Journal');
    const before = metadataCalls;
    await fetch(origin + '/api/iptv?action=epg&id=42', { headers });
    assert.equal(metadataCalls, before, 'shared EPG cache avoids another provider request');

    const leased = await post('/api/access', { action: 'lease', viewerId: viewerA, streamId: 42 }, cookie);
    assert.equal(leased.status, 200);
    const data = await leased.json();
    assert.equal(data.urls.hls, `${process.env.XTREAM_SERVER}/live/test/secret/42.m3u8`);
    assert.equal(data.usage.dayUsedSeconds, 60); assert.equal(data.policy.videoRoute, 'direct');
    assert.equal((await post('/api/access', { action: 'lease', viewerId: viewerB }, cookie)).status, 409);
    assert.equal(videoCalls, 0, 'authorization never fetches video');
    for (const action of ['play', 'ts', 'resource']) assert.equal((await fetch(origin + '/api/iptv?action=' + action, { headers })).status, 410);
    assert.equal(videoCalls, 0);

    const pair = await post('/api/iptv?action=pair_create', {}, cookie);
    const { code, readToken } = await pair.json(); assert.equal(code.length, 6);
    const envelope = { code, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB', mode: 'qr' };
    assert.equal((await post('/api/iptv?action=pair_send', envelope, cookie)).status, 200);
    const waitURL = `/api/iptv?action=pair_wait&code=${code}&nowait=1`;
    const received = await fetch(origin + waitURL, { headers: { ...headers, 'X-Pair-Token': readToken } });
    assert.equal((await received.json()).envelope.ciphertext, envelope.ciphertext);
    assert.equal((await fetch(origin + waitURL, { headers: { ...headers, 'X-Pair-Token': readToken } })).status, 404);

    assert.equal((await post('/api/access', { action: 'release', viewerId: viewerA }, cookie)).status, 200);
    assert.equal((await post('/api/access', { action: 'lease', viewerId: viewerB }, cookie)).status, 200);
    await post('/api/access', { action: 'release', viewerId: viewerB }, cookie);
    assert.equal((await post('/api/auth', { action: 'logout' }, cookie)).status, 200);
    assert.equal((await fetch(origin + '/api/access', { headers: { Cookie: cookie } })).status, 401, 'logout revokes server-side session');
  } finally {
    await close(gateway); await close(upstream); process.env.XTREAM_SERVER = '';
  }
});

test('production fails closed without shared Redis and rejects cross-origin mutations', async () => {
  const previous = process.env.ONDA_LOCAL_DEV;
  process.env.ONDA_LOCAL_DEV = '0';
  try {
    assert.throws(() => getStore(), /Configurez/);
    const response = await handlers.auth({ method: 'GET', headers: {} }, { setHeader() {}, end() {} });
    assert.equal(response, undefined);
    const token = await createSession(process.env.SESSION_SECRET);
    const cookie = `onda_session=${token}`;
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value; } };
    await handlers.access({ method: 'GET', headers: { cookie } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).code, 'QUOTA_UNAVAILABLE');
  } finally { process.env.ONDA_LOCAL_DEV = previous; }
});
