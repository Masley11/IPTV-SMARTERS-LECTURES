const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { return new Promise(resolve => server.close(resolve)); }

test('catalogue, compte 1/1, redirection load-balancer HLS signée, flux MPEG-TS, QR pairing chiffré et garde-fou SSRF', async () => {
  let edgePort = 0;
  let activeCons = '0';
  let lastUpstreamConnectionHeader = '';

  const edge = http.createServer((req, res) => {
    lastUpstreamConnectionHeader = String(req.headers.connection || '');
    if (req.url === '/live/play/tok123/77.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/keys/77.key"\n#EXTINF:6,\n/hlsr/tok123/77_1.ts\n');
    }
    if (req.url === '/hlsr/tok123/77_1.ts') {
      res.setHeader('Content-Type', 'video/mp2t');
      return res.end('edge-segment-data');
    }
    if (req.url === '/keys/77.key') {
      return res.end('0123456789abcdef');
    }
    if (req.url === '/live/play/tok123/88.ts') {
      res.setHeader('Content-Type', 'video/mp2t');
      const packet = Buffer.alloc(190, 0x11);
      packet[0] = 0x47;
      packet[188] = 0x47;
      return res.end(packet);
    }
    res.writeHead(404).end();
  });
  edgePort = await listen(edge);

  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/player_api.php')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      res.setHeader('Content-Type', 'application/json');
      if (!query.get('action')) {
        return res.end(JSON.stringify({
          user_info: {
            username: 'test',
            status: 'Active',
            active_cons: activeCons,
            max_connections: '1',
            exp_date: '1795267007'
          }
        }));
      }
      return res.end(JSON.stringify(query.get('action') === 'get_live_categories' ? [{ category_id: '1', category_name: 'Infos' }] : [{ stream_id: 42, name: 'Info TV' }]));
    }
    if (req.url.endsWith('/99.m3u8')) {
      res.writeHead(401).end();
      return;
    }
    if (req.url.endsWith('/42.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nchunk.ts\n');
    }
    if (req.url.endsWith('/77.m3u8')) {
      res.writeHead(302, { Location: `http://127.0.0.1:${edgePort}/live/play/tok123/77.m3u8` });
      return res.end();
    }
    if (req.url.endsWith('/88.m3u8')) {
      res.setHeader('Content-Type', 'video/mp2t');
      const packet = Buffer.alloc(190, 0x22);
      packet[0] = 0x47;
      packet[188] = 0x47;
      return res.end(packet);
    }
    if (req.url.endsWith('/88.ts')) {
      res.writeHead(302, { Location: `http://127.0.0.1:${edgePort}/live/play/tok123/88.ts` });
      return res.end();
    }
    if (req.url.endsWith('/chunk.ts')) { res.setHeader('Content-Type', 'video/mp2t'); return res.end('segment'); }
    if (req.url.endsWith('/key.bin')) return res.end('key');
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  process.env.XTREAM_SERVER = `http://127.0.0.1:${upstreamPort}`;
  const handler = require('../api/iptv');
  const gateway = http.createServer(handler);
  const gatewayPort = await listen(gateway);
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const base = `${origin}/api/iptv?username=test&password=secret`;
  try {
    // 1. Catalogue + Account info
    const categories = await fetch(base + '&action=categories');
    assert.equal(categories.status, 200);
    assert.deepEqual(await categories.json(), [{ category_id: '1', category_name: 'Infos' }]);
    const streams = await fetch(base + '&action=streams');
    assert.equal((await streams.json())[0].stream_id, 42);
    const account = await fetch(base + '&action=account');
    assert.equal(account.status, 200);
    assert.deepEqual(await account.json(), {
      status: 'Active',
      activeConnections: 0,
      maxConnections: 1,
      expDate: '1795267007'
    });

    // 2. Same-origin HLS
    const playlist = await fetch(base + '&action=play&id=42');
    assert.equal(playlist.status, 200);
    const text = await playlist.text();
    assert.match(text, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/iptv\?/);
    const segment = text.split('\n').find(line => line.startsWith('/api/iptv?'));
    const segmentResponse = await fetch(new URL(segment, origin));
    assert.equal(await segmentResponse.text(), 'segment');

    // 3. Cross-origin load-balancer 302 redirect HLS + HMAC-signed segment
    const redirected = await fetch(base + '&action=play&id=77');
    assert.equal(redirected.status, 200);
    const redirectedText = await redirected.text();
    assert.match(redirectedText, /sig=/);
    const edgeSegLine = redirectedText.split('\n').find(line => line.startsWith('/api/iptv?'));
    const edgeSegResp = await fetch(new URL(edgeSegLine, origin));
    assert.equal(edgeSegResp.status, 200);
    assert.equal(await edgeSegResp.text(), 'edge-segment-data');
    assert.equal(lastUpstreamConnectionHeader.toLowerCase(), 'close');

    // 4. Detection of raw MPEG-TS on play + live streaming via action=ts
    const rawTsPlay = await fetch(base + '&action=play&id=88');
    assert.equal(rawTsPlay.status, 415);
    assert.equal((await rawTsPlay.json()).code, 'MPEGTS_DIRECT');

    const tsStream = await fetch(base + '&action=ts&id=88');
    assert.equal(tsStream.status, 200);
    assert.match(tsStream.headers.get('content-type') || '', /video\/mp2t/);
    const tsBuf = Buffer.from(await tsStream.arrayBuffer());
    assert.equal(tsBuf[0], 0x47);
    assert.equal(tsBuf.length, 190);

    // 5. Detection of max_connections: 1 already occupied on another device (429 MAX_CONNECTIONS)
    activeCons = '1';
    const busy = await fetch(base + '&action=play&id=99');
    assert.equal(busy.status, 429);
    const busyJson = await busy.json();
    assert.equal(busyJson.code, 'MAX_CONNECTIONS');
    assert.equal(busyJson.activeConnections, 1);
    assert.equal(busyJson.maxConnections, 1);

    // 6. Real-time E2EE TV <-> Phone QR Pairing (long-poll wakeup + burn-after-reading)
    const pairCreated = await fetch(`${origin}/api/iptv?action=pair_create`, { method: 'POST' });
    assert.equal(pairCreated.status, 200);
    const { code, readToken } = await pairCreated.json();
    assert.equal(code.length, 6);

    const waitPromise = fetch(`${origin}/api/iptv?action=pair_wait&code=${code}&token=${encodeURIComponent(readToken)}`);
    await new Promise(r => setTimeout(r, 80));
    const sendResp = await fetch(`${origin}/api/iptv?action=pair_send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB', mode: 'qr' })
    });
    assert.equal(sendResp.status, 200);

    const waited = await waitPromise;
    assert.equal(waited.status, 200);
    const waitedJson = await waited.json();
    assert.equal(waitedJson.status, 'paired');
    assert.equal(waitedJson.envelope.ciphertext, 'BBBBBBBBBBBBBBBBBBBBBBBB');

    // Burn-after-reading: second poll must return 404
    const secondRead = await fetch(`${origin}/api/iptv?action=pair_wait&code=${code}&token=${encodeURIComponent(readToken)}&nowait=1`);
    assert.equal(secondRead.status, 404);

    // 7. SSRF / unsigned external host rejection + Multi-provider loopback SSRF block
    const external = await fetch(base + '&action=resource&id=' + encodeURIComponent('http://example.com/anything'));
    assert.equal(external.status, 502);
    assert.match((await external.json()).error, /hors du serveur/);

    const forgedEdge = await fetch(base + '&action=resource&exp=9999999999999&sig=forged&id=' + encodeURIComponent(`http://127.0.0.1:${edgePort}/hlsr/tok123/77_1.ts`));
    assert.equal(forgedEdge.status, 502);
    assert.match((await forgedEdge.json()).error, /hors du serveur/);

    delete process.env.XTREAM_SERVER;
    const ssrfAttempt = await fetch(`${origin}/api/iptv?action=categories&server=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}`)}&username=test&password=secret`);
    assert.equal(ssrfAttempt.status, 502);
    assert.match((await ssrfAttempt.json()).error, /privée interdite|interdit/);

    const invalid = await fetch(`${origin}/api/iptv?action=play&server=${encodeURIComponent('http://93.184.216.34')}&username=test&password=secret&id=../../etc`);
    assert.equal(invalid.status, 400);
  } finally {
    await close(gateway);
    await close(upstream);
    await close(edge);
  }
});
