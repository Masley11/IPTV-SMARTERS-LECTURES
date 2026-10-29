/* ONDA — Lecteur IPTV Web & Smart TV par PremiumZone.
 * Zéro identifiant pré-rempli : chaque utilisateur connecte sa propre playlist
 * (localement ou par scan QR Code chiffré de bout en bout depuis son téléphone). */

const EMPTY_CREDS = { server: '', username: '', password: '' };
const STORAGE_KEY = 'onda-xtream-settings';
const MODE_KEY = 'onda-stream-mode';
const LAST_PLAY_KEY = 'onda-last-play-ts';
const LOCAL_COOLDOWN_MS = 45000;
const MAX_ZAP_WAIT_MS = 25000;
const $ = (id) => document.getElementById(id);

function readLastLocalPlayAt() {
  try {
    const v = Number(sessionStorage.getItem(LAST_PLAY_KEY) || 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

function markLocalPlay() {
  const now = Date.now();
  state.lastLocalPlayAt = now;
  try { sessionStorage.setItem(LAST_PLAY_KEY, String(now)); } catch { /* ignore */ }
}

function isOwnSessionCoolingDown() {
  return state.lastLocalPlayAt > 0 && (Date.now() - state.lastLocalPlayAt) < LOCAL_COOLDOWN_MS;
}

const state = {
  categories: [],
  streams: [],
  account: null,
  selected: 'all',
  query: '',
  visible: 40,
  credentials: readCredentials(),
  lockedServer: null,
  mode: readMode(),
  hls: null,
  mpegts: null,
  reconnectTimer: null,
  accountRefreshTimer: null,
  playToken: 0,
  zapStartedAt: 0,
  lastLocalPlayAt: readLastLocalPlayAt(),
  localStreaming: false,
  current: null,
  loading: false,
  tvPairAbort: null,
  phonePairSecret: ''
};

const icons = ['◈', '▣', '◉', '✦', '◇', '▤', '◎'];

const MAX_CONN_MESSAGE = 'Limite atteinte (1/1 connexion active) : une chaîne est déjà en cours de lecture sur un autre appareil (ex. IPTV Smarters Pro). Arrêtez simplement la lecture vidéo sur l’autre appareil (inutile de déconnecter le compte) puis cliquez sur Réessayer.';

function normalizeServer(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function hasCredentials(creds = state.credentials) {
  return Boolean(creds && normalizeServer(creds.server) && String(creds.username || '').trim() && String(creds.password || '').trim());
}

function readCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      server: normalizeServer(saved.server || ''),
      username: String(saved.username || '').trim(),
      password: String(saved.password || '').trim()
    };
  } catch {
    return { ...EMPTY_CREDS };
  }
}

function saveCredentials(next) {
  const clean = {
    server: normalizeServer(next.server),
    username: String(next.username || '').trim(),
    password: String(next.password || '').trim()
  };
  state.credentials = clean;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* navigation privée */ }
}

function clearCredentials() {
  state.credentials = { ...EMPTY_CREDS };
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

function readMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return ['auto', 'hls', 'ts'].includes(saved) ? saved : 'auto';
  } catch { return 'auto'; }
}

function params(action, extra = {}) {
  const q = {
    action,
    username: state.credentials.username,
    password: state.credentials.password,
    ...extra
  };
  if (!state.lockedServer && state.credentials.server) {
    q.server = normalizeServer(state.credentials.server);
  }
  return '/api/iptv?' + new URLSearchParams(q);
}

function mpegtsSupported() {
  try { return Boolean(window.mpegts && window.mpegts.isSupported()); }
  catch { return false; }
}

// Extraction intelligente d'un lien M3U / Xtream complet ou d'un message copié-collé
function parseXtreamText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (urlMatch) {
    try {
      const u = new URL(urlMatch[0]);
      const result = { server: u.origin, username: '', password: '' };
      const qUser = u.searchParams.get('username') || u.searchParams.get('user');
      const qPass = u.searchParams.get('password') || u.searchParams.get('pass');
      if (qUser) result.username = qUser.trim();
      if (qPass) result.password = qPass.trim();

      if (!result.username || !result.password) {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'live' || parts[0] === 'movie' || parts[0] === 'series') {
          if (parts.length >= 3) {
            result.username = decodeURIComponent(parts[1]);
            result.password = decodeURIComponent(parts[2]);
          }
        } else if (parts.length >= 3 && /\d+/.test(parts[2])) {
          result.username = decodeURIComponent(parts[0]);
          result.password = decodeURIComponent(parts[1]);
        }
      }

      const userLine = text.match(/(?:user(?:name)?|identifiant|login)\s*[:=]\s*([^\s,;]+)/i);
      const passLine = text.match(/(?:pass(?:word)?|mot\s*de\s*passe|mdp)\s*[:=]\s*([^\s,;]+)/i);
      if (!result.username && userLine) result.username = userLine[1].trim();
      if (!result.password && passLine) result.password = passLine[1].trim();
      return result;
    } catch {
      return null;
    }
  }
  return null;
}

function bindM3uAutoFill(m3uInputId, serverId, userId, passId) {
  const input = $(m3uInputId);
  const apply = (val) => {
    const parsed = parseXtreamText(val);
    if (!parsed) return false;
    if (parsed.server) $(serverId).value = parsed.server;
    if (parsed.username) $(userId).value = parsed.username;
    if (parsed.password) $(passId).value = parsed.password;
    return Boolean(parsed.server && parsed.username && parsed.password);
  };
  input.addEventListener('input', () => apply(input.value));
  input.addEventListener('paste', (e) => {
    const clip = e.clipboardData && e.clipboardData.getData('text');
    if (clip && apply(clip)) {
      setTimeout(() => { input.value = ''; }, 60);
    }
  });
  // Si l'utilisateur colle directement le lien M3U complet dans le champ Serveur
  $(serverId).addEventListener('change', () => {
    const val = $(serverId).value.trim();
    if (val.includes('?') || val.split('/').length > 3) {
      apply(val);
    }
  });
}

// --- Chiffrement de bout en bout WebCrypto (AES-256-GCM) pour l'association QR TV ---
function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBase64Url(byteLen = 16) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

async function derivePairKey(code, secret) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Le chiffrement sécurisé nécessite HTTPS ou localhost.');
  }
  const cleanCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(`onda-e2ee-v1:${cleanCode}:${secret || 'manual'}`),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(`onda-tv-pair-salt:${cleanCode}`),
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPairCredentials(creds, code, secret) {
  const key = await derivePairKey(code, secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({
    server: normalizeServer(creds.server),
    username: creds.username.trim(),
    password: creds.password.trim()
  }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    mode: secret ? 'qr' : 'manual'
  };
}

async function decryptPairCredentials(envelope, code, secret) {
  const effectiveSecret = envelope.mode === 'manual' ? '' : secret;
  const key = await derivePairKey(code, effectiveSecret);
  const iv = base64UrlToBytes(envelope.iv);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('Réponse inattendue du serveur.'); }
  if (!response.ok) throw new Error(data.error || 'Connexion impossible.');
  return data;
}

function updateSubtitle(itemsCount) {
  if (!hasCredentials()) {
    $('list-subtitle').textContent = 'Aucune playlist connectée · Scannez un QR Code ou ouvrez Paramètres';
    return;
  }
  const count = typeof itemsCount === 'number' ? itemsCount : filtered().length;
  let text = count.toLocaleString('fr-FR') + ' chaîne' + (count > 1 ? 's' : '') + ' disponible' + (count > 1 ? 's' : '');
  if (state.account && state.account.maxConnections > 0) {
    const { activeConnections, maxConnections } = state.account;
    const ownSession = state.localStreaming || isOwnSessionCoolingDown();
    if (ownSession) {
      text += ` · Connexion prête sur cet écran`;
    } else if (activeConnections >= maxConnections) {
      text += ` · ⚠ ${activeConnections}/${maxConnections} connexion utilisée sur un autre appareil`;
    } else {
      text += ` · Connexion libre (${activeConnections}/${maxConnections} active)`;
    }
  }
  $('list-subtitle').textContent = text;
}

async function refreshAccount() {
  if (!hasCredentials()) return null;
  try {
    state.account = await requestJSON(params('account'));
    if (!state.loading && state.streams.length) updateSubtitle();
    return state.account;
  } catch {
    return null;
  }
}

function showWelcomeOnboarding() {
  state.categories = [];
  state.streams = [];
  state.account = null;
  renderCategories();
  $('result-count').textContent = '0';
  $('channel-grid').hidden = true;
  $('pagination').hidden = true;
  updateSubtitle(0);

  const box = $('status');
  box.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = 'Connectez votre playlist IPTV en 10 secondes';
  const text = document.createElement('span');
  text.textContent = 'Sur Smart TV : affichez le QR Code et scannez-le depuis votre téléphone pour copier-coller vos identifiants sans télécommande. Vous pouvez aussi saisir vos accès Xtream / M3U directement ici.';
  const actions = document.createElement('div');
  actions.className = 'status-actions';

  const qrBtn = document.createElement('button');
  qrBtn.type = 'button';
  qrBtn.className = 'primary-status-btn';
  qrBtn.textContent = '⊞ Scanner un QR Code avec mon téléphone';
  qrBtn.addEventListener('click', openTvPair);

  const manualBtn = document.createElement('button');
  manualBtn.type = 'button';
  manualBtn.textContent = '⌨ Saisir mes identifiants manuellement';
  manualBtn.addEventListener('click', openSettings);

  actions.append(qrBtn, manualBtn);
  box.append(strong, text, actions);
  box.hidden = false;
}

function setStatus(message, title = '', retry = false) {
  const box = $('status');
  box.replaceChildren();
  if (title) { const strong = document.createElement('strong'); strong.textContent = title; box.append(strong); }
  else { const spinner = document.createElement('span'); spinner.className = 'loading-spinner'; box.append(spinner); }
  const text = document.createElement('span'); text.textContent = message; box.append(text);
  if (retry) {
    const actions = document.createElement('div');
    actions.className = 'status-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary-status-btn';
    button.textContent = '↻ Réessayer';
    button.addEventListener('click', load);
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.textContent = '⚙ Modifier mes identifiants';
    settingsBtn.addEventListener('click', openSettings);
    actions.append(button, settingsBtn);
    box.append(actions);
  }
  box.hidden = false;
}

async function load() {
  if (state.loading) return;
  try {
    const config = await requestJSON('/api/iptv?action=config');
    state.lockedServer = config.locked && config.server ? normalizeServer(config.server) : null;
    if (state.lockedServer && !state.credentials.server) {
      state.credentials.server = state.lockedServer;
    }
  } catch { /* ignore config preflight error */ }

  if (!hasCredentials()) {
    showWelcomeOnboarding();
    return;
  }

  state.loading = true;
  $('channel-grid').hidden = true;
  $('pagination').hidden = true;
  setStatus('Connexion à votre catalogue en cours...');
  try {
    if (state.lockedServer && normalizeServer(state.credentials.server) !== state.lockedServer) {
      throw new Error('Ce déploiement est configuré uniquement pour ' + state.lockedServer + '.');
    }
    const [categories, streams, account] = await Promise.all([
      requestJSON(params('categories')),
      requestJSON(params('streams')),
      requestJSON(params('account')).catch(() => null)
    ]);
    if (!Array.isArray(categories) || !Array.isArray(streams)) throw new Error('Catalogue invalide : vérifiez vos identifiants Xtream Codes.');
    state.categories = categories.filter(item => item && item.category_id != null);
    state.streams = streams.filter(item => item && /^\d+$/.test(String(item.stream_id)));
    state.account = account;
    renderCategories();
    renderChannels();
  } catch (error) {
    state.categories = []; state.streams = []; state.account = null;
    renderCategories();
    $('result-count').textContent = '0'; $('list-subtitle').textContent = 'Connexion indisponible';
    setStatus(error.message, 'Impossible de charger les chaînes', true);
  } finally { state.loading = false; }
}

function filtered() {
  const query = state.query.toLocaleLowerCase();
  return state.streams.filter(item => (state.selected === 'all' || String(item.category_id) === state.selected) && String(item.name || '').toLocaleLowerCase().includes(query));
}

function chooseCategory(id) {
  state.selected = id; state.visible = 40;
  renderCategories(); renderChannels();
}

function renderCategories() {
  const counts = new Map();
  for (const item of state.streams) counts.set(String(item.category_id), (counts.get(String(item.category_id)) || 0) + 1);
  const items = [{ category_id: 'all', category_name: 'Toutes les chaînes', count: state.streams.length }, ...state.categories.map(item => ({ ...item, count: counts.get(String(item.category_id)) || 0 }))];
  $('category-count').textContent = String(state.categories.length).padStart(2, '0');
  const nav = $('categories'); const mobile = $('mobile-categories');
  nav.replaceChildren(); mobile.replaceChildren();
  items.forEach((item, index) => {
    const id = String(item.category_id);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'category-item' + (state.selected === id ? ' selected' : '');
    button.setAttribute('aria-pressed', String(state.selected === id));
    const icon = document.createElement('span'); icon.className = 'category-icon'; icon.textContent = icons[index % icons.length];
    const name = document.createElement('span'); name.className = 'category-name'; name.textContent = item.category_name || 'Sans nom';
    const number = document.createElement('span'); number.className = 'category-number'; number.textContent = item.count;
    button.append(icon, name, number); button.addEventListener('click', () => chooseCategory(id)); nav.append(button);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = state.selected === id ? 'selected' : '';
    chip.setAttribute('aria-pressed', String(state.selected === id)); chip.textContent = item.category_name || 'Sans nom';
    chip.addEventListener('click', () => chooseCategory(id)); mobile.append(chip);
  });
}

function renderChannels() {
  const items = filtered(); const grid = $('channel-grid'); grid.replaceChildren();
  $('result-count').textContent = items.length.toLocaleString('fr-FR');
  updateSubtitle(items.length);
  if (!items.length) {
    grid.hidden = true; $('pagination').hidden = true;
    setStatus(state.streams.length ? 'Essayez une autre recherche ou une autre catégorie.' : 'Aucune chaîne disponible pour ces identifiants.', state.streams.length ? 'Aucun résultat' : 'Catalogue vide');
    return;
  }
  $('status').hidden = true; grid.hidden = false;
  const categoryNames = new Map(state.categories.map(c => [String(c.category_id), c.category_name]));
  for (const item of items.slice(0, state.visible)) {
    const card = document.createElement('button'); card.className = 'channel-card'; card.type = 'button';
    card.setAttribute('aria-label', 'Regarder ' + (item.name || 'Chaîne'));
    const logo = document.createElement('span'); logo.className = 'channel-logo';
    const initials = String(item.name || 'TV').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 2).toUpperCase() || 'TV';
    logo.textContent = initials;
    if (item.stream_icon && /^https:\/\//i.test(item.stream_icon)) {
      const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.onerror = () => image.remove(); image.src = item.stream_icon; logo.append(image);
    }
    const info = document.createElement('span'); info.className = 'channel-info';
    const name = document.createElement('span'); name.className = 'channel-name'; name.textContent = item.name || 'Chaîne ' + item.stream_id;
    const meta = document.createElement('span'); meta.className = 'channel-meta'; meta.textContent = categoryNames.get(String(item.category_id)) || 'En direct';
    info.append(name, meta);
    const arrow = document.createElement('span'); arrow.className = 'channel-arrow'; arrow.textContent = '↗';
    card.append(logo, info, arrow); card.addEventListener('click', () => play(item)); grid.append(card);
  }
  $('pagination').hidden = items.length <= state.visible;
}

// --- Moteur de lecture vidéo (HLS fluide + MPEG-TS direct) ---
function updateModeButtons() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function setMode(nextMode) {
  if (!['auto', 'hls', 'ts'].includes(nextMode)) return;
  state.mode = nextMode;
  try { localStorage.setItem(MODE_KEY, nextMode); } catch { /* ignore */ }
  updateModeButtons();
  if (state.current && !$('player-overlay').hidden) {
    play(state.current, true);
  }
}

function destroyEngines() {
  if (state.localStreaming) {
    markLocalPlay();
    state.localStreaming = false;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.hls) {
    try {
      state.hls.stopLoad();
      state.hls.detachMedia();
      state.hls.destroy();
    } catch { /* ignore */ }
    state.hls = null;
  }
  if (state.mpegts) {
    try {
      state.mpegts.pause();
      state.mpegts.unload();
      state.mpegts.detachMediaElement();
      state.mpegts.destroy();
    } catch { /* ignore */ }
    state.mpegts = null;
  }
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function destroyPlayback() {
  state.playToken++;
  destroyEngines();
}

function showPlayerMessage(text, retryable = false) {
  const box = $('player-message');
  box.replaceChildren();
  if (!text) return;
  const span = document.createElement('span');
  span.textContent = text;
  box.append(span);
  if (retryable && state.current) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '↻ Réessayer le flux';
    btn.addEventListener('click', () => {
      if (state.current) play(state.current, true);
    });
    box.append(btn);
  }
}

function zappingParam() {
  return isOwnSessionCoolingDown() ? { zapping: '1' } : {};
}

function canAutoWaitZapping() {
  return isOwnSessionCoolingDown() && state.zapStartedAt > 0 && (Date.now() - state.zapStartedAt) < MAX_ZAP_WAIT_MS;
}

function formatMaxConnMessage(account) {
  if (account && account.maxConnections > 0 && account.activeConnections >= account.maxConnections) {
    return `Limite atteinte (${account.activeConnections}/${account.maxConnections} connexion active) : une chaîne est déjà en cours de lecture sur un autre appareil (ex. IPTV Smarters Pro). Arrêtez simplement la lecture vidéo sur l’autre appareil (inutile de déconnecter le compte) puis cliquez sur Réessayer.`;
  }
  return MAX_CONN_MESSAGE;
}

function startMpegTs(item, token, fromFallback = false, allowHlsFallback = false) {
  if (token !== state.playToken) return;
  destroyEngines();
  if (!mpegtsSupported()) {
    if (allowHlsFallback) {
      startHls(item, token, false);
      return;
    }
    showPlayerMessage('Ce fournisseur diffuse en MPEG-TS (.ts) et ce navigateur ne prend pas en charge MSE. Essayez Chrome, Edge, Firefox ou Android.', true);
    return;
  }
  const label = item.name || 'Chaîne';
  $('player-subtitle').textContent = 'Direct MPEG-TS · ' + label;
  showPlayerMessage(fromFallback ? 'Passage automatique en flux direct MPEG-TS...' : 'Connexion au direct...');

  const video = $('video');
  const url = params('ts', { id: item.stream_id, ...zappingParam(), _t: Date.now() });
  const startedAt = Date.now();
  const player = window.mpegts.createPlayer(
    { type: 'mpegts', isLive: true, cors: true, url },
    {
      isLive: true,
      enableWorker: true,
      enableStashBuffer: true,
      stashInitialSize: 512 * 1024,
      lazyLoad: false,
      liveBufferLatencyChasing: false,
      liveSync: false,
      fixAudioTimestampGap: true,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30
    }
  );
  state.mpegts = player;
  let hasPlayed = false;

  const markPlaying = () => {
    if (token !== state.playToken) return;
    hasPlayed = true;
    state.localStreaming = true;
    markLocalPlay();
    showPlayerMessage('');
  };
  video.addEventListener('playing', markPlaying, { once: true });

  player.on(window.mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
    if (token !== state.playToken) return;
    if (hasPlayed) {
      showPlayerMessage('Reconnexion automatique au direct...');
      state.reconnectTimer = setTimeout(() => startMpegTs(item, token, false, false), 900);
      return;
    }
    const statusCode = errorInfo && errorInfo.code;
    if (statusCode === 429) {
      destroyEngines();
      if (canAutoWaitZapping()) {
        showPlayerMessage('Changement de chaîne : fermeture du flux précédent auprès du serveur, démarrage automatique...');
        state.reconnectTimer = setTimeout(() => startMpegTs(item, token, fromFallback, allowHlsFallback), 1800);
        return;
      }
      refreshAccount().then((acc) => {
        if (token === state.playToken) showPlayerMessage(formatMaxConnMessage(acc), true);
      });
      showPlayerMessage(formatMaxConnMessage(state.account), true);
      return;
    }
    if (statusCode === 403) {
      showPlayerMessage('Ce compte IPTV est inactif, expiré ou ses identifiants sont incorrects.', true);
      return;
    }
    if (allowHlsFallback) {
      destroyEngines();
      state.reconnectTimer = setTimeout(() => startHls(item, token, false), 150);
      return;
    }
    const msg = statusCode === 502
      ? 'Cette chaîne est actuellement hors antenne ou indisponible chez le fournisseur (ex. chaîne événementielle hors match).'
      : 'Lecture impossible sur cette chaîne (' + (errorDetail || errorType || 'flux indisponible') + ').';
    showPlayerMessage(msg, true);
  });

  player.on(window.mpegts.Events.LOADING_COMPLETE, () => {
    if (token !== state.playToken) return;
    if (hasPlayed && !$('player-overlay').hidden) {
      if (state.mode === 'auto' && Date.now() - startedAt < 25000) {
        destroyEngines();
        state.reconnectTimer = setTimeout(() => startHls(item, token, false), 150);
        return;
      }
      state.reconnectTimer = setTimeout(() => startMpegTs(item, token, false, false), 400);
    } else if (!hasPlayed) {
      if (allowHlsFallback) {
        destroyEngines();
        state.reconnectTimer = setTimeout(() => startHls(item, token, false), 150);
        return;
      }
      showPlayerMessage('Cette chaîne est actuellement hors antenne (aucun flux vidéo actif).', true);
    }
  });

  player.attachMediaElement(video);
  player.load();
  const playPromise = player.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      if (token === state.playToken && hasPlayed) {
        showPlayerMessage('Appuyez sur ▶ pour lancer la lecture.');
      }
    });
  }
}

function startHls(item, token, allowFallback, retryingZap = false) {
  if (token !== state.playToken) return;
  destroyEngines();
  const label = item.name || 'Chaîne';
  $('player-subtitle').textContent = 'Direct HLS · ' + label;
  showPlayerMessage(retryingZap
    ? 'Changement de chaîne : fermeture du flux précédent auprès du serveur, démarrage automatique...'
    : 'Connexion au direct...');

  const url = params('play', { id: item.stream_id, ...zappingParam(), _t: Date.now() });
  const video = $('video');

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8,
      backBufferLength: 20,
      maxBufferLength: 24,
      maxMaxBufferLength: 45,
      maxBufferHole: 0.8,
      highBufferWatchdogPeriod: 3,
      nudgeOffset: 0.2,
      nudgeMaxRetry: 5,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: allowFallback ? 1 : 2,
      manifestLoadingRetryDelay: 700,
      levelLoadingTimeOut: 20000,
      levelLoadingMaxRetry: 4,
      levelLoadingRetryDelay: 700,
      fragLoadingTimeOut: 30000,
      fragLoadingMaxRetry: 5,
      fragLoadingRetryDelay: 700
    });
    state.hls = hls;
    let manifestReady = false;
    let networkRecoveries = 0;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.LEVEL_LOADED, () => {
      if (token === state.playToken) markLocalPlay();
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (token !== state.playToken) return;
      manifestReady = true;
      state.localStreaming = true;
      markLocalPlay();
      showPlayerMessage('');
      video.play().catch(() => showPlayerMessage('Appuyez sur ▶ pour lancer la lecture.'));
    });

    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (token === state.playToken) {
        networkRecoveries = 0;
        markLocalPlay();
      }
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (token !== state.playToken || !data.fatal) return;
      if (manifestReady) {
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 6) {
          networkRecoveries++;
          state.reconnectTimer = setTimeout(() => {
            if (token === state.playToken && state.hls === hls) hls.startLoad();
          }, 700);
          return;
        }
      }
      const httpCode = data.response && data.response.code;
      if (httpCode === 429) {
        destroyEngines();
        if (canAutoWaitZapping()) {
          showPlayerMessage('Changement de chaîne : fermeture du flux précédent auprès du serveur, démarrage automatique...');
          state.reconnectTimer = setTimeout(() => startHls(item, token, allowFallback, true), 1800);
          return;
        }
        refreshAccount().then((acc) => {
          if (token === state.playToken) showPlayerMessage(formatMaxConnMessage(acc), true);
        });
        showPlayerMessage(formatMaxConnMessage(state.account), true);
        return;
      }
      if (httpCode === 403) {
        destroyEngines();
        showPlayerMessage('Ce compte IPTV est inactif, expiré ou ses identifiants sont incorrects.', true);
        return;
      }
      if (allowFallback && mpegtsSupported()) {
        destroyEngines();
        state.reconnectTimer = setTimeout(() => startMpegTs(item, token, true, false), 150);
        return;
      }
      showPlayerMessage('Flux HLS indisponible sur cette chaîne. Essayez le mode MPEG-TS ou une autre chaîne.', true);
    });
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    const onNativeError = async () => {
      if (token !== state.playToken) return;
      if (canAutoWaitZapping()) {
        showPlayerMessage('Changement de chaîne : fermeture du flux précédent auprès du serveur, démarrage automatique...');
        state.reconnectTimer = setTimeout(() => startHls(item, token, allowFallback, true), 1800);
        return;
      }
      const acc = await refreshAccount();
      if (token !== state.playToken) return;
      if (acc && acc.maxConnections > 0 && acc.activeConnections >= acc.maxConnections) {
        showPlayerMessage(formatMaxConnMessage(acc), true);
        return;
      }
      if (allowFallback && mpegtsSupported()) {
        startMpegTs(item, token, true, false);
      } else {
        showPlayerMessage('Ce flux n’est pas disponible en HLS natif sur cet appareil.', true);
      }
    };
    video.addEventListener('error', onNativeError, { once: true });
    video.addEventListener('playing', () => {
      if (token === state.playToken) {
        state.localStreaming = true;
        markLocalPlay();
      }
    }, { once: true });
    video.src = url;
    video.play().catch(() => showPlayerMessage('Appuyez sur ▶ pour lancer la lecture.'));
    return;
  }

  if (allowFallback && mpegtsSupported()) {
    startMpegTs(item, token, true, false);
    return;
  }
  showPlayerMessage('Ce navigateur ne prend pas en charge la lecture HLS ou MPEG-TS.', true);
}

function play(item, keepFullscreen = false) {
  if (state.accountRefreshTimer) {
    clearTimeout(state.accountRefreshTimer);
    state.accountRefreshTimer = null;
  }
  destroyPlayback();
  const token = state.playToken;
  state.zapStartedAt = Date.now();
  state.current = item;
  const label = item.name || 'Chaîne';
  $('player-title').textContent = label;
  $('player-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  updateModeButtons();
  if (!keepFullscreen) $('close-player').focus();

  if (state.mode === 'ts') {
    startMpegTs(item, token, false, false);
  } else {
    startHls(item, token, state.mode === 'auto');
  }
}

function closePlayer() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  destroyPlayback();
  state.current = null;
  $('player-overlay').hidden = true;
  document.body.style.overflow = '';
  if (!state.loading && state.streams.length) updateSubtitle();
  $('search').focus();
  if (state.accountRefreshTimer) clearTimeout(state.accountRefreshTimer);
  // Attend que le serveur Xtream purge sa session HLS (~20-25s) avant de rafraîchir le compteur
  state.accountRefreshTimer = setTimeout(() => {
    state.accountRefreshTimer = null;
    if ($('player-overlay').hidden) refreshAccount();
  }, 26000);
}

window.addEventListener('pagehide', destroyPlayback);
window.addEventListener('beforeunload', destroyPlayback);

// --- Modales : Paramètres, Association TV QR Code, Télécommande Mobile & À propos ---
function closeAllModals() {
  stopTvPairPolling();
  $('settings-overlay').hidden = true;
  $('tv-pair-overlay').hidden = true;
  $('phone-pair-overlay').hidden = true;
  $('about-overlay').hidden = true;
}

function openSettings() {
  closeAllModals();
  $('m3u-input').value = '';
  $('server-input').value = state.lockedServer || state.credentials.server || '';
  $('server-input').readOnly = Boolean(state.lockedServer);
  $('username-input').value = state.credentials.username || '';
  $('password-input').value = state.credentials.password || '';
  $('logout-device').hidden = !hasCredentials();
  $('settings-error').hidden = true;
  $('settings-overlay').hidden = false;
  ($('m3u-input') || $('server-input')).focus();
}

function closeSettings() {
  $('settings-overlay').hidden = true;
  $('open-settings').focus();
}

function stopTvPairPolling() {
  if (state.tvPairAbort) {
    state.tvPairAbort.abort();
    state.tvPairAbort = null;
  }
}

function renderQrSvg(targetUrl) {
  const box = $('qr-box');
  box.replaceChildren();
  if (typeof window.qrcode !== 'function') {
    box.textContent = targetUrl;
    return;
  }
  const qr = window.qrcode(0, 'M');
  qr.addData(targetUrl);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
}

async function openTvPair() {
  closeAllModals();
  $('tv-pair-overlay').hidden = false;
  $('close-tv-pair').focus();
  await startTvPairSession();
}

function closeTvPair() {
  stopTvPairPolling();
  $('tv-pair-overlay').hidden = true;
}

async function startTvPairSession() {
  stopTvPairPolling();
  const abortController = new AbortController();
  state.tvPairAbort = abortController;

  $('qr-box').innerHTML = '<span class="loading-spinner"></span>';
  $('pair-code-display').textContent = '--- · ---';
  $('pair-status-text').textContent = 'Génération du code sécurisé...';

  try {
    const secret = randomBase64Url(16);
    const created = await requestJSON('/api/iptv?action=pair_create', {
      method: 'POST',
      signal: abortController.signal
    });
    if (abortController.signal.aborted) return;

    const code = created.code;
    const readToken = created.readToken;
    const pairUrl = `${location.origin}/?pair=${encodeURIComponent(code)}#k=${encodeURIComponent(secret)}`;
    renderQrSvg(pairUrl);
    $('pair-code-display').textContent = `${code.slice(0, 3)} · ${code.slice(3)}`;
    $('pair-status-text').textContent = 'En attente du scan depuis votre téléphone...';

    while (!abortController.signal.aborted && !$('tv-pair-overlay').hidden) {
      const pollUrl = `/api/iptv?` + new URLSearchParams({
        action: 'pair_wait',
        code,
        token: readToken,
        _t: Date.now()
      });
      const res = await fetch(pollUrl, { cache: 'no-store', signal: abortController.signal });
      const data = await res.json().catch(() => ({}));
      if (abortController.signal.aborted) return;

      if (res.status === 404) {
        $('pair-status-text').textContent = 'Code expiré. Cliquez sur « Nouveau QR Code » pour continuer.';
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Erreur de synchronisation TV.');
      }
      if (data.status === 'paired' && data.envelope) {
        $('pair-status-text').textContent = 'Identifiants reçus ! Déchiffrement et ouverture des chaînes...';
        const creds = await decryptPairCredentials(data.envelope, code, secret);
        saveCredentials(creds);
        state.selected = 'all';
        state.visible = 40;
        closeTvPair();
        await load();
        return;
      }
      if (typeof data.expiresIn === 'number') {
        const mins = Math.ceil(data.expiresIn / 60);
        $('pair-status-text').textContent = `En attente du téléphone... (valide encore ${mins} min)`;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) return;
    $('pair-status-text').textContent = err.message || 'Impossible de générer le QR Code.';
  }
}

function openPhonePair(prefillCode = '', secret = '') {
  closeAllModals();
  state.phonePairSecret = secret || '';
  const codeInput = $('phone-code-input');
  codeInput.value = prefillCode ? prefillCode.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  codeInput.readOnly = Boolean(prefillCode && secret);

  $('phone-m3u-input').value = '';
  $('phone-server-input').value = state.lockedServer || state.credentials.server || '';
  $('phone-username-input').value = state.credentials.username || '';
  $('phone-password-input').value = state.credentials.password || '';
  $('phone-pair-error').hidden = true;
  $('phone-pair-success').hidden = true;
  $('phone-send-btn').disabled = false;
  $('phone-pair-overlay').hidden = false;

  if (!codeInput.value) codeInput.focus();
  else if (!$('phone-server-input').value) $('phone-m3u-input').focus();
  else $('phone-send-btn').focus();
}

function closePhonePair() {
  $('phone-pair-overlay').hidden = true;
}

function openAbout() {
  closeAllModals();
  $('about-overlay').hidden = false;
  $('close-about').focus();
}

function closeAbout() {
  $('about-overlay').hidden = true;
}

// --- Événements formulaires & boutons ---
bindM3uAutoFill('m3u-input', 'server-input', 'username-input', 'password-input');
bindM3uAutoFill('phone-m3u-input', 'phone-server-input', 'phone-username-input', 'phone-password-input');

$('paste-clipboard-btn').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    $('phone-m3u-input').value = text;
    $('phone-m3u-input').dispatchEvent(new Event('input'));
  } catch {
    $('phone-m3u-input').focus();
  }
});

$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const next = {
    server: normalizeServer($('server-input').value),
    username: $('username-input').value.trim(),
    password: $('password-input').value.trim()
  };
  const error = $('settings-error');
  if (!/^https?:\/\//i.test(next.server)) {
    error.textContent = 'Veuillez entrer une URL de serveur valide (ex. http://exemple.com:8080).';
    error.hidden = false;
    return;
  }
  if (state.lockedServer && next.server !== state.lockedServer) {
    error.textContent = 'Ce déploiement utilise uniquement ' + state.lockedServer + '.';
    error.hidden = false;
    return;
  }
  saveCredentials(next);
  state.selected = 'all';
  state.visible = 40;
  closeSettings();
  load();
});

$('logout-device').addEventListener('click', () => {
  clearCredentials();
  closeSettings();
  showWelcomeOnboarding();
});

$('phone-pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errBox = $('phone-pair-error');
  const okBox = $('phone-pair-success');
  const sendBtn = $('phone-send-btn');
  errBox.hidden = true;
  okBox.hidden = true;

  const code = $('phone-code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const creds = {
    server: normalizeServer($('phone-server-input').value),
    username: $('phone-username-input').value.trim(),
    password: $('phone-password-input').value.trim()
  };

  if (code.length !== 6) {
    errBox.textContent = 'Le code TV doit contenir exactement 6 caractères.';
    errBox.hidden = false;
    return;
  }
  if (!/^https?:\/\//i.test(creds.server)) {
    errBox.textContent = 'URL du serveur Xtream invalide (ex. http://fournisseur.com:8080).';
    errBox.hidden = false;
    return;
  }

  sendBtn.disabled = true;
  const prevText = sendBtn.innerHTML;
  sendBtn.textContent = 'Vérification et envoi chiffré...';

  try {
    // Vérifie d'abord que le serveur et les identifiants répondent bien
    const checkParams = new URLSearchParams({
      action: 'account',
      username: creds.username,
      password: creds.password
    });
    if (!state.lockedServer) checkParams.set('server', creds.server);
    await requestJSON('/api/iptv?' + checkParams);

    const encrypted = await encryptPairCredentials(creds, code, state.phonePairSecret);
    await requestJSON('/api/iptv?action=pair_send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, ...encrypted })
    });

    if ($('phone-save-local').checked) {
      saveCredentials(creds);
    }

    okBox.textContent = '✓ C’est envoyé ! Vos chaînes s’ouvrent automatiquement sur votre téléviseur.';
    okBox.hidden = false;
    if ($('phone-save-local').checked) {
      load();
    }
  } catch (err) {
    errBox.textContent = err.message || 'Impossible d’envoyer les identifiants vers la TV.';
    errBox.hidden = false;
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = prevText;
  }
});

$('search').addEventListener('input', (event) => { state.query = event.target.value.trim(); state.visible = 40; if (!state.loading && hasCredentials()) renderChannels(); });
$('show-more').addEventListener('click', () => { state.visible += 40; renderChannels(); });
$('refresh').addEventListener('click', load);
$('open-settings').addEventListener('click', openSettings);
$('mobile-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('open-tv-pair').addEventListener('click', openTvPair);
$('top-qr-btn').addEventListener('click', openTvPair);
$('hero-qr-btn').addEventListener('click', openTvPair);
$('close-tv-pair').addEventListener('click', closeTvPair);
$('refresh-tv-qr').addEventListener('click', startTvPairSession);
$('tv-to-manual').addEventListener('click', openSettings);
$('settings-to-tv-qr').addEventListener('click', openTvPair);
$('settings-to-phone-send').addEventListener('click', () => openPhonePair('', ''));
$('close-phone-pair').addEventListener('click', closePhonePair);
$('open-about').addEventListener('click', openAbout);
$('footer-contact').addEventListener('click', openAbout);
$('close-about').addEventListener('click', closeAbout);

['settings-overlay', 'tv-pair-overlay', 'phone-pair-overlay', 'about-overlay'].forEach((id) => {
  $(id).addEventListener('click', (event) => {
    if (event.target === $(id)) closeAllModals();
  });
});

$('close-player').addEventListener('click', closePlayer);
$('fullscreen').addEventListener('click', () => {
  const video = $('video');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
});
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});
$('video').addEventListener('playing', () => showPlayerMessage(''));
$('video').addEventListener('error', () => {
  if (state.current && !state.hls && !state.mpegts) {
    showPlayerMessage('Le flux vidéo est indisponible ou son format n’est pas compatible avec cet appareil.', true);
  }
});

function activeModalElement() {
  for (const id of ['settings-overlay', 'tv-pair-overlay', 'phone-pair-overlay', 'about-overlay', 'player-overlay']) {
    if (!$(id).hidden) return $(id);
  }
  return null;
}

document.addEventListener('keydown', (event) => {
  const modal = activeModalElement();
  if (event.key === 'Escape' || (event.key === 'Backspace' && event.target.tagName !== 'INPUT')) {
    if (modal) {
      if (modal.id === 'player-overlay') closePlayer();
      else closeAllModals();
      event.preventDefault();
    }
  }
  if (event.key === '/' && event.target.tagName !== 'INPUT' && !modal) {
    event.preventDefault();
    $('search').focus();
  }
  // Navigation directionnelle pour télécommandes Smart TV
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !['INPUT', 'VIDEO'].includes(event.target.tagName)) {
    const scope = modal || document;
    const buttons = [...scope.querySelectorAll('button:not([hidden]),a[href],input:not([hidden])')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const current = document.activeElement;
    if (!buttons.includes(current)) {
      if (buttons.length) { event.preventDefault(); buttons[0].focus(); }
      return;
    }
    const box = current.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const choices = buttons.filter(el => el !== current).map(el => { const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - x, dy = b.top + b.height / 2 - y; return { el, dx, dy }; })
      .filter(({ dx, dy }) => event.key === 'ArrowRight' ? dx > 5 : event.key === 'ArrowLeft' ? dx < -5 : event.key === 'ArrowDown' ? dy > 5 : dy < -5)
      .sort((a, b) => { const score = p => event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? Math.abs(p.dx) + Math.abs(p.dy) * 2 : Math.abs(p.dy) + Math.abs(p.dx) * 2; return score(a) - score(b); });
    if (choices.length) { event.preventDefault(); choices[0].el.focus(); choices[0].el.scrollIntoView({ block: 'nearest' }); }
  }
});

function checkIncomingQrScan() {
  const url = new URL(location.href);
  const pairCode = url.searchParams.get('pair');
  if (!pairCode) return false;
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const secret = hashParams.get('k') || '';
  try {
    history.replaceState(null, '', location.pathname);
  } catch { /* ignore */ }
  openPhonePair(pairCode, secret);
  return true;
}

updateModeButtons();
const openedFromQr = checkIncomingQrScan();
if (!openedFromQr || hasCredentials()) {
  load();
} else {
  showWelcomeOnboarding();
}
