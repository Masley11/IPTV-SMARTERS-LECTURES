/* Development ONLY. Never use this server as a production deployment. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.env.VERCEL) throw new Error('Le serveur de développement ne doit pas tourner sur Vercel.');
process.env.ONDA_LOCAL_DEV = '1';
process.env.APP_ACCESS_PASSWORD ||= 'local-development-only';
process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString('hex');
const { createSession, verifySession, sessionCookie, serializeSession } = require('./lib/session');
const { getStore } = require('./lib/store');
const { hash } = require('./lib/access');
const handlers = { iptv: require('./api/iptv'), access: require('./api/access'), auth: require('./api/auth') };
const middlewareReady = import('./middleware.js').then(module => module.default);
const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const allowedFiles = ['/index.html', '/app.js', '/access-client.js', '/login.html', '/login.css', '/login.js', '/style.css', '/manifest.webmanifest', '/sw.js', '/assets/hls.min.js', '/assets/mpegts.min.js', '/assets/qrcode.min.js', '/assets/shaka-player.compiled.js', '/assets/pwa-icon-512.png', '/assets/pwa-icon-192.png', '/assets/apple-touch-icon.png', '/assets/favicon.png', '/assets/standby-backdrop.jpg', '/streampulse/streampulse.css', '/streampulse/streampulse.js'];
http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (handlers[pathname.split('/')[2]] && pathname.startsWith('/api/')) return await handlers[pathname.split('/')[2]](req, res);
    // The preview is explicitly local and has no provider credentials. Never deployed.
    if (process.env.ONDA_PREVIEW_LOGIN === '1' && (pathname === '/' || pathname === '/index.html') && !await verifySession(sessionCookie({ headers: { get: () => req.headers.cookie } }), process.env.SESSION_SECRET)) {
      const token = await createSession(process.env.SESSION_SECRET);
      await getStore().set(`onda:session:${hash(token)}`, '1', 86400000);
      res.setHeader('Set-Cookie', serializeSession(token, false));
    }
    if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/api/')) {
      const response = await (await middlewareReady)(new Request('http://' + req.headers.host + req.url, { headers: { cookie: req.headers.cookie || '' } }));
      if (response && response.headers.get('x-middleware-next') !== '1') {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        return res.end(Buffer.from(await response.arrayBuffer()));
      }
    }
    const filename = pathname === '/' ? '/index.html' : pathname;
    const full = path.resolve(root, '.' + filename);
    if (!full.startsWith(root + path.sep) || !allowedFiles.includes(filename)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(full)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let content = fs.readFileSync(full);
    if (filename === '/sw.js') content = Buffer.from(content.toString().replace('__SHELL_VERSION__', 'development').replace('__SHELL_ASSETS__', '[]'));
    res.end(content);
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Erreur du serveur local.' }));
  }
}).listen(process.env.PORT || 8080, '0.0.0.0', () => console.log(`Aperçu local uniquement sur le port ${process.env.PORT || 8080}. Mot de passe dev : local-development-only (sauf APP_ACCESS_PASSWORD).`));
