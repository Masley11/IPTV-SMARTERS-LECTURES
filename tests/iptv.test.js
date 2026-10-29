const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { return new Promise(resolve => server.close(resolve)); }

test('catalogue, réécriture HLS et garde-fou des ressources', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/player_api.php')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(query.get('action') === 'get_live_categories' ? [{ category_id: '1', category_name: 'Infos' }] : [{ stream_id: 42, name: 'Info TV' }]));
    }
    if (req.url.endsWith('/42.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nchunk.ts\n');
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
  const base = `http://127.0.0.1:${gatewayPort}/api/iptv?username=test&password=secret`;
  try {
    const categories = await fetch(base + '&action=categories');
    assert.equal(categories.status, 200);
    assert.deepEqual(await categories.json(), [{ category_id: '1', category_name: 'Infos' }]);
    const streams = await fetch(base + '&action=streams');
    assert.equal((await streams.json())[0].stream_id, 42);
    const playlist = await fetch(base + '&action=play&id=42');
    assert.equal(playlist.status, 200);
    const text = await playlist.text();
    assert.match(text, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/iptv\?/);
    assert.match(text, /action=resource&username=test&password=secret&id=/);
    const segment = text.split('\n').find(line => line.startsWith('/api/iptv?'));
    const segmentResponse = await fetch(new URL(segment, `http://127.0.0.1:${gatewayPort}`));
    assert.equal(await segmentResponse.text(), 'segment');
    const external = await fetch(base + '&action=resource&id=' + encodeURIComponent('http://example.com/anything'));
    assert.equal(external.status, 502);
    assert.match((await external.json()).error, /hors du serveur/);
    const invalid = await fetch(base + '&action=play&id=../../etc');
    assert.equal(invalid.status, 400);
  } finally { await close(gateway); await close(upstream); }
});
