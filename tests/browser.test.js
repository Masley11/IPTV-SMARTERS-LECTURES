const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '..');

async function boot(t, respond) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]+src=[^>]+><\/script>/g, '');
  const vc = new VirtualConsole();
  const errors = []; vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://private.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = async (url, options = {}) => respond(String(url), options, w);
  w.AbortSignal.timeout = () => new AbortController().signal;
  w.HTMLMediaElement.prototype.play = async () => {};
  w.HTMLMediaElement.prototype.pause = () => {};
  w.HTMLMediaElement.prototype.load = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.ONDA_ACCESS_REQUESTS = [];
  for (const file of ['access-client.js', 'app.js', 'streampulse/streampulse.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  t.after(() => { w.ONDA_ACCESS.stop('', false); w.StreamPulse.instance.destroyPlayer(); w.close(); });
  assert.deepEqual(errors, []);
  return { w, d: w.document };
}
const json = data => ({ ok: true, status: 200, json: async () => data });
const snapshot = {
  policy: { dailyMinutes: 120, monthlyMinutes: 2700, startHour: 6, endHour: 24, videoRoute: 'direct' },
  usage: { dayRemainingSeconds: 7200, monthRemainingSeconds: 162000, dayUsedSeconds: 0, monthUsedSeconds: 0, inWindow: true }
};

test('private player boots, renders budget, and gates BOTH Xtream and raw M3U before media loading', async t => {
  const leases = [];
  const { w, d } = await boot(t, async (url, options) => {
    if (url === '/api/access' && options.method === 'POST') {
      const body = JSON.parse(options.body); leases.push(body);
      return json({ ...snapshot, lease: { expiresAt: Date.now() + 60000, serverNow: Date.now(), chargedSeconds: 60 }, urls: body.streamId ? { hls: 'https://provider.test/live.m3u8', ts: 'https://provider.test/live.ts' } : null });
    }
    if (url === '/api/access') return json(snapshot);
    if (url.includes('action=config')) return json({ locked: false, server: null, videoRoute: 'direct' });
    return json([]);
  });
  assert.equal(d.querySelectorAll('#streampulse-module .sp-ch-row').length, 0);
  d.querySelector('[data-action="open-budget"]').click();
  assert.match(d.querySelector('[data-sp="budgetDay"]').textContent, /2 h restantes/);
  assert.equal(d.querySelector('[data-sp="budgetModal"]').classList.contains('sp-hidden'), false);
  d.querySelector('[data-action="close-budget"]').click();
  const controller = w.StreamPulse.instance;
  const loaded = [];
  controller.startAdaptiveHls = (channel, token) => loaded.push(controller.buildStreamUrl(channel));
  controller.loadChannelEpg = () => {};
  w.ONDA_BRIDGE.authorizeChannel = async id => {
    const result = await w.ONDA_ACCESS.acquire({ streamId: id, headers: { 'X-Iptv-Username': 'test' } });
    return result;
  };
  await controller.playChannel({ stream_id: 42, name: 'Chaîne privée' });
  assert.equal(leases.length, 1); assert.equal(leases[0].streamId, 42);
  assert.deepEqual(loaded, ['https://provider.test/live.m3u8']);
  await controller.playChannel({ stream_id: 'm3u-1', name: 'M3U privé', directUrl: 'https://direct.test/video.m3u8' });
  assert.equal(leases.length, 2); assert.equal(leases[1].streamId, undefined);
  assert.equal(loaded[1], 'https://direct.test/video.m3u8');
  w.ONDA_ACCESS.stop('Quota test');
  assert.equal(controller.hls, null); assert.equal(controller.mpegts, null);
  assert.equal(w.ONDA_ACCESS.valid(), false);
  assert.match(d.querySelector('[data-sp="streamAlert"]').textContent, /Quota test/);
});

test('quota refusal never reaches a media engine', async t => {
  const { w } = await boot(t, async (url, options) => {
    if (url === '/api/access' && options.method === 'POST') return { ok: false, status: 403, json: async () => ({ ...snapshot, error: 'Quotidien épuisé', code: 'DAILY_LIMIT' }) };
    if (url === '/api/access') return json(snapshot);
    if (url.includes('action=config')) return json({ locked: false, server: null });
    return json([]);
  });
  const c = w.StreamPulse.instance;
  let mediaStarted = false; c.startAdaptiveHls = () => { mediaStarted = true; };
  w.ONDA_BRIDGE.authorizeChannel = id => w.ONDA_ACCESS.acquire({ streamId: id });
  await c.playChannel({ stream_id: 42, name: 'Test' });
  assert.equal(mediaStarted, false); assert.equal(w.ONDA_ACCESS.valid(), false);
  assert.match(c.q('[data-sp="streamAlert"]').textContent, /Quotidien épuisé/);
});

test('login rejects open redirects and never puts the password in a URL', async t => {
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'login.html'), 'utf8'), { url: 'https://private.test/login.html?next=%2F%3Fpair%3DABC234#k=secret', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window; const calls = []; const navigation = [];
  w.fetch = async (url, options = {}) => { calls.push({ url, options }); return json(url === '/api/auth' && !options.method ? { configured: true, authenticated: false } : { ok: true }); };
  const context = require('node:vm').createContext({
    document: w.document, fetch: w.fetch, URL, URLSearchParams, AbortSignal: w.AbortSignal,
    location: { origin: 'https://private.test', search: '?next=%2F%3Fpair%3DABC234', hash: '#k=secret', pathname: '/login.html', replace: url => navigation.push(url) }
  });
  require('node:vm').runInContext(fs.readFileSync(path.join(root, 'login.js'), 'utf8'), context);
  await new Promise(resolve => setTimeout(resolve, 5));
  w.document.getElementById('password').value = 'private-password';
  w.document.getElementById('login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls[1].url, '/api/auth'); assert.equal(calls[1].options.method, 'POST');
  assert.match(calls[1].options.body, /private-password/); assert.doesNotMatch(calls[1].url, /private-password/);
  assert.equal(navigation[0], '/?pair=ABC234#k=secret');
  assert.equal(w.document.getElementById('password').value, '');
  for (const hostile of ['//evil.test', '/\\evil.test', '/%2F%2Fevil.test', 'https://evil.test', '/login.html']) {
    context.location.search = '?next=' + encodeURIComponent(hostile);
    w.document.getElementById('login-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(navigation.at(-1), '/', hostile);
  }
  w.close();
});
