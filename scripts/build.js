/* No framework/build dependencies. Publish an explicit allowlist, never repository sources. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'public');
const files = [
  'index.html', 'style.css', 'app.js', 'access-client.js', 'login.html', 'login.css', 'login.js',
  'manifest.webmanifest', 'streampulse/streampulse.css', 'streampulse/streampulse.js',
  'assets/hls.min.js', 'assets/mpegts.min.js', 'assets/qrcode.min.js', 'assets/shaka-player.compiled.js',
  'assets/pwa-icon-192.png', 'assets/pwa-icon-512.png', 'assets/apple-touch-icon.png', 'assets/favicon.png', 'assets/standby-backdrop.jpg'
];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const hashes = new Map(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 12)]));
function versionReferences(text) {
  for (const [file, hash] of hashes) text = text.split('/' + file).join('/' + file + '?v=' + hash);
  return text;
}
for (const file of files) {
  const target = path.join(out, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  if (/\.(js|css|html|webmanifest)$/.test(file)) fs.writeFileSync(target, versionReferences(fs.readFileSync(path.join(root, file), 'utf8')));
  else fs.copyFileSync(path.join(root, file), target);
}
const shellVersion = crypto.createHash('sha256').update([...hashes].map(([file, hash]) => file + hash).join('|')).digest('hex').slice(0, 12);
let sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
sw = sw.replace('__SHELL_VERSION__', shellVersion).replace('__SHELL_ASSETS__', JSON.stringify(files.filter(f => f !== 'login.html' && f !== 'login.js' && f !== 'login.css' && f !== 'index.html').map(f => '/' + f + '?v=' + hashes.get(f)), null, 2));
fs.writeFileSync(path.join(out, 'sw.js'), sw);
console.log(`Interface privée prête : ${files.length + 1} fichiers, aucun code serveur ni ancienne page publique. Version ${shellVersion}.`);
