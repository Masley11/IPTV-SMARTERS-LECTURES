const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('./api/iptv');
const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const allowedFiles = ['/index.html', '/app.js', '/style.css', '/assets/hls.min.js', '/assets/mpegts.min.js'];
http.createServer((req, res) => {
  if (req.url.startsWith('/api/iptv')) return handler(req, res);
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = pathname === '/' ? '/index.html' : pathname;
  const full = path.resolve(root, '.' + filename);
  if (!full.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  if (!allowedFiles.includes(filename)) { res.writeHead(404).end(); return; }
  fs.createReadStream(full).on('error', () => { if (!res.headersSent) res.writeHead(404).end(); }).on('open', () => {
    res.setHeader('Content-Type', types[path.extname(full)] || 'application/octet-stream');
  }).pipe(res);
}).listen(process.env.PORT || 8080, '0.0.0.0', () => console.log(`IPTV prêt sur le port ${process.env.PORT || 8080}`));
