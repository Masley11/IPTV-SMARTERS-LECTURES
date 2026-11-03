const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeVirtualRange,
  computeBackoffMs,
  parseM3uPlaylist,
  isSeparatorStream,
  computeChannelCanonicalKey,
  extractVariantBadge,
  rankVariantForFailover,
  StreamPulseController
} = require('../streampulse/streampulse.js');

const ROOT = path.resolve(__dirname, '..');

test('Virtual scrolling mounts ~20 DOM rows even for 28,365 IPTV channels', () => {
  const totalChannels = 28365;
  const rowHeight = 64;
  const viewportHeight = 512; // 8 visible rows
  const overscan = 6;

  const top = computeVirtualRange(totalChannels, 0, viewportHeight, rowHeight, overscan);
  assert.equal(top.start, 0);
  assert.equal(top.end, 14);
  assert.equal(top.totalHeight, totalChannels * rowHeight);
  assert.ok(top.end - top.start <= 22);

  const mid = computeVirtualRange(totalChannels, 10000 * rowHeight, viewportHeight, rowHeight, overscan);
  assert.equal(mid.start, 9994);
  assert.equal(mid.end, 10014);
  assert.equal(mid.end - mid.start, 20);

  const bottom = computeVirtualRange(totalChannels, 28360 * rowHeight, viewportHeight, rowHeight, overscan);
  assert.equal(bottom.end, totalChannels);
  assert.ok(bottom.end - bottom.start <= 20);
});

test('Exponential backoff scales 1s -> 2s -> 4s -> 8s -> 16s cap for silent stream recovery', () => {
  assert.equal(computeBackoffMs(0, 1000, 16000, 0), 1000);
  assert.equal(computeBackoffMs(1, 1000, 16000, 0), 2000);
  assert.equal(computeBackoffMs(2, 1000, 16000, 0), 4000);
  assert.equal(computeBackoffMs(3, 1000, 16000, 0), 8000);
  assert.equal(computeBackoffMs(4, 1000, 16000, 0), 16000);
  assert.equal(computeBackoffMs(9, 1000, 16000, 0), 16000);
});

test('Xtream separator banners are detected and excluded from playback', () => {
  assert.equal(isSeparatorStream('##### FRANCE #####'), true);
  assert.equal(isSeparatorStream('--- CANAL+ HD ---'), true);
  assert.equal(isSeparatorStream('=== SPORT UHD ==='), true);
  assert.equal(isSeparatorStream('Canal+ Foot FHD'), false);
  assert.equal(isSeparatorStream('TF1 4K'), false);
});

test('Strict Smart TV memory cleanup destroys HLS/Shaka/mpegts and flushes <video> buffer', () => {
  const calls = [];
  const fakeVideo = {
    firstChild: null,
    pause: () => calls.push('video.pause'),
    removeAttribute: (attr) => calls.push(`video.removeAttribute(${attr})`),
    load: () => calls.push('video.load')
  };
  const fakeMount = {
    querySelector: (sel) => (sel === '[data-sp="video"]' ? fakeVideo : null)
  };

  const ctrl = new StreamPulseController(fakeMount);
  ctrl.hls = {
    stopLoad: () => calls.push('hls.stopLoad'),
    detachMedia: () => calls.push('hls.detachMedia'),
    destroy: () => calls.push('hls.destroy')
  };
  ctrl.shaka = {
    unload: () => calls.push('shaka.unload'),
    destroy: () => calls.push('shaka.destroy')
  };
  ctrl.mpegts = {
    pause: () => calls.push('mpegts.pause'),
    unload: () => calls.push('mpegts.unload'),
    detachMediaElement: () => calls.push('mpegts.detachMediaElement'),
    destroy: () => calls.push('mpegts.destroy')
  };

  ctrl.destroyPlayer();

  assert.equal(ctrl.hls, null);
  assert.equal(ctrl.shaka, null);
  assert.equal(ctrl.mpegts, null);
  assert.deepEqual(calls, [
    'hls.stopLoad',
    'hls.detachMedia',
    'hls.destroy',
    'shaka.unload',
    'shaka.destroy',
    'mpegts.pause',
    'mpegts.unload',
    'mpegts.detachMediaElement',
    'mpegts.destroy',
    'video.pause',
    'video.removeAttribute(src)',
    'video.load'
  ]);
});

test('M3U parser extracts #EXTM3U entries cleanly', () => {
  const sample = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-logo="https://img.example/1.png" group-title="Sport UHD",Canal Sport 4K',
    'https://cdn.example.com/live/sport4k.m3u8',
    '#EXTINF:-1 group-title="Cinéma",Ciné Premier FHD',
    'https://cdn.example.com/live/cine.mpd'
  ].join('\n');

  const items = parseM3uPlaylist(sample);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Canal Sport 4K');
  assert.equal(items[0].category_name, 'Sport UHD');
  assert.equal(items[0].directUrl, 'https://cdn.example.com/live/sport4k.m3u8');
  assert.equal(items[1].directUrl, 'https://cdn.example.com/live/cine.mpd');
});

test('Unified single interface, 100% SVG (zero stickers/emojis), auto-responsive, PWA & performance constraints', () => {
  const jsSource = fs.readFileSync(path.join(ROOT, 'streampulse/streampulse.js'), 'utf8');
  const cssSource = fs.readFileSync(path.join(ROOT, 'streampulse/streampulse.css'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

  // 1. Single interface: legacy .app-shell is hidden and #streampulse-module is active
  assert.match(htmlSource, /<div class="app-shell" hidden aria-hidden="true">/);
  assert.match(htmlSource, /<div id="streampulse-module"><\/div>/);

  // 2. Zero stickers / emojis in StreamPulse UI & zero manual Smart TV / Android mode toggle
  assert.equal(/[⚡⊞◉📺★☆📅⚙🔊🔇⏮⏭▶⏸⛶✕↻🔒📱⌨💼🎮⏱]/.test(jsSource), false, 'StreamPulse must use pure SVG icons, zero stickers/emojis');
  assert.equal(/mode-tv|mode-android/.test(jsSource), false, 'Device adaptation must be automatic, not manual');
  assert.match(jsSource, /<svg\b/);

  // 3. Zero setInterval; uses requestAnimationFrame
  assert.equal(/setInterval\s*\(/.test(jsSource), false);
  assert.equal(/requestAnimationFrame\s*\(/.test(jsSource), true);

  // 4. Adaptive Bitrate (ABR) strictly enabled + passive touch listeners
  assert.match(jsSource, /startLevel:\s*-1/);
  assert.match(jsSource, /abr:\s*\{\s*enabled:\s*true\s*\}/);
  const passiveMatches = jsSource.match(/\{\s*passive:\s*true\s*\}/g) || [];
  assert.ok(passiveMatches.length >= 10, `Expected >= 10 passive listeners, found ${passiveMatches.length}`);

  // 5. Scoped CSS (--sp-*) & automatic media query adaptation
  assert.match(cssSource, /#streampulse-module\s*\{/);
  assert.match(cssSource, /--sp-bg:/);
  assert.match(cssSource, /@media\s*\(max-width:\s*959px\)/);

  // 6. PWA Manifest, visual assets & safe Service Worker
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.match(swSource, /SHELL_ASSETS\.includes\(url\.pathname \+ url\.search\)/);
  assert.match(swSource, /No HTML, no API, no credentials, no video/);
  for (const rel of [
    'assets/pwa-icon-512.png',
    'assets/pwa-icon-192.png',
    'assets/apple-touch-icon.png',
    'assets/favicon.png',
    'assets/standby-backdrop.jpg',
    'worker/cloudflare-stream-relay.js'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), true, `Missing asset: ${rel}`);
  }

  // 7. Vercel Fast Origin Transfer optimizations: gzip + field pruning, IndexedDB cache, lean HLS zapping buffer
  const apiSource = fs.readFileSync(path.join(ROOT, 'api/iptv.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(apiSource, /zlib\.gzipSync/);
  assert.match(appSource, /onda-catalogue-cache-v1/);
  assert.match(jsSource, /maxBufferLength:\s*this\.ecoMode\s*\?\s*12\s*:\s*16/);

  // 8. Live EPG, Recents, Recall A<->B, Numeric TV Keypad & explicit private quota
  assert.match(jsSource, /sp-recents-v1/);
  assert.match(jsSource, /data-sp="epgStrip"/);
  assert.match(jsSource, /data-sp="variantBar"/);
  assert.match(jsSource, /data-sp="numPadOsd"/);
  assert.match(jsSource, /data-action="recall-ch"/);
  assert.match(jsSource, /onda:access-stop/);
  assert.match(jsSource, /ONDA_ACCESS\.valid\(\)/);
  assert.doesNotMatch(jsSource, /wakeLock|Toujours devant/);
});

test('Multi-source canonical channel grouping matches quality/backup variants without homonym collisions', () => {
  const c4k = computeChannelCanonicalKey('FR| CANAL+ 4K UHD');
  const cfhd = computeChannelCanonicalKey('FR| CANAL+ FHD');
  const chd = computeChannelCanonicalKey('FR : CANAL+ HD');
  const csd = computeChannelCanonicalKey('|FR FHD| CANAL+ SD [BACKUP]');
  const chevc = computeChannelCanonicalKey('FR| CANAL+ HEVC');

  assert.equal(c4k, 'FR::CANAL PLUS');
  assert.equal(cfhd, c4k);
  assert.equal(chd, c4k);
  assert.equal(csd, c4k);
  assert.equal(chevc, c4k);

  // Zero false merges on distinct channels, time-shifted (+1), numbered channels, or countries
  assert.notEqual(computeChannelCanonicalKey('FR| CANAL+ SPORT FHD'), c4k);
  assert.notEqual(computeChannelCanonicalKey('PL| CANAL+ FHD'), c4k);
  assert.notEqual(computeChannelCanonicalKey('FR| BEIN SPORTS 1 FHD'), computeChannelCanonicalKey('FR| BEIN SPORTS 2 FHD'));
  assert.notEqual(computeChannelCanonicalKey('FR| TF1 FHD'), computeChannelCanonicalKey('FR| TF1 +1 FHD'));
  assert.notEqual(computeChannelCanonicalKey('FR| TF1 FHD'), computeChannelCanonicalKey('CH| TF1 FHD'));

  // Badge extraction & safe failover ordering (HD preferred over HEVC/4K on decode failure)
  assert.equal(extractVariantBadge('FR| CANAL+ 4K HEVC', 0), '4K HEVC');
  assert.equal(extractVariantBadge('FR| CANAL+ HD [BACKUP]', 1), 'HD Secours');
  assert.ok(
    rankVariantForFailover({ name: 'FR| CANAL+ HD' }, true) <
    rankVariantForFailover({ name: 'FR| CANAL+ 4K HEVC' }, true)
  );
});

