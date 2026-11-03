function parseServerOrigin(raw) {
  const cleaned = String(raw || '').trim().replace(/\/+$/, '');
  if (!cleaned) throw new Error('URL du serveur Xtream manquante');
  let base;
  try { base = new URL(cleaned); } catch { throw new Error('URL du serveur Xtream invalide'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('URL du serveur Xtream invalide (utilisez ex. https://exemple.com:8080)');
  }
  return base;
}
function lockedOrigin() { return (process.env.XTREAM_SERVER || '').trim().replace(/\/+$/, ''); }
function resolveBase(headers = {}) {
  const locked = lockedOrigin();
  const provided = String(headers['x-iptv-server'] || '').trim();
  if (locked) {
    const base = parseServerOrigin(locked);
    if (provided && provided.replace(/\/+$/, '') !== base.origin) throw new Error(`Ce déploiement est verrouillé sur ${base.origin}`);
    return { base, isLocked: true };
  }
  return { base: parseServerOrigin(provided), isLocked: false };
}
function credentials(headers = {}) {
  const username = String(headers['x-iptv-username'] || '');
  const password = String(headers['x-iptv-password'] || '');
  if (!/^[\x21-\x7E]{1,100}$/.test(username) || !/^[\x21-\x7E]{1,100}$/.test(password)) throw new Error('Identifiants invalides');
  return { username, password };
}
function directUrls(base, auth, id) {
  if (!/^\d{1,12}$/.test(String(id || ''))) throw new Error('Chaîne invalide');
  const prefix = `/live/${encodeURIComponent(auth.username)}/${encodeURIComponent(auth.password)}/${id}`;
  return { hls: new URL(prefix + '.m3u8', base).href, ts: new URL(prefix + '.ts', base).href };
}
module.exports = { parseServerOrigin, lockedOrigin, resolveBase, credentials, directUrls };
