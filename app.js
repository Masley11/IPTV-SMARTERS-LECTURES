/* ONDA — vanilla JS, no database. Credentials are saved locally on this device. */
const DEFAULTS = {
  server: 'http://erdaenbv.dupefik.com',
  username: '18PRDWM4',
  password: '7YZTBJVL'
};
const STORAGE_KEY = 'onda-xtream-settings';
const MODE_KEY = 'onda-stream-mode';
const $ = (id) => document.getElementById(id);
const state = {
  categories: [],
  streams: [],
  selected: 'all',
  query: '',
  visible: 40,
  credentials: readCredentials(),
  configuredServer: DEFAULTS.server,
  mode: readMode(),
  hls: null,
  mpegts: null,
  reconnectTimer: null,
  playToken: 0,
  current: null,
  loading: false
};
const icons = ['◈', '▣', '◉', '✦', '◇', '▤', '◎'];

function readCredentials() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function readMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return ['auto', 'hls', 'ts'].includes(saved) ? saved : 'auto';
  } catch { return 'auto'; }
}
function normalizeServer(value) { return value.trim().replace(/\/+$/, ''); }
function params(action, extra = {}) {
  return '/api/iptv?' + new URLSearchParams({ action, username: state.credentials.username, password: state.credentials.password, ...extra });
}
function mpegtsSupported() {
  try { return Boolean(window.mpegts && window.mpegts.isSupported()); }
  catch { return false; }
}
async function requestJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error('Réponse inattendue du serveur.'); }
  if (!response.ok) throw new Error(data.error || 'Connexion impossible.');
  return data;
}
function setStatus(message, title = '', retry = false) {
  const box = $('status');
  box.replaceChildren();
  if (title) { const strong = document.createElement('strong'); strong.textContent = title; box.append(strong); }
  else { const spinner = document.createElement('span'); spinner.className = 'loading-spinner'; box.append(spinner); }
  const text = document.createElement('span'); text.textContent = message; box.append(text);
  if (retry) { const button = document.createElement('button'); button.textContent = 'Réessayer'; button.addEventListener('click', load); box.append(button); }
  box.hidden = false;
}
async function load() {
  if (state.loading) return;
  state.loading = true;
  $('channel-grid').hidden = true;
  $('pagination').hidden = true;
  setStatus('Connexion au catalogue en cours...');
  try {
    const config = await requestJSON('/api/iptv?action=config');
    state.configuredServer = normalizeServer(config.server);
    if (normalizeServer(state.credentials.server) !== state.configuredServer) throw new Error('Ce déploiement utilise ' + state.configuredServer + '. Modifiez XTREAM_SERVER sur Vercel ou rétablissez cette adresse dans les paramètres.');
    const [categories, streams] = await Promise.all([requestJSON(params('categories')), requestJSON(params('streams'))]);
    if (!Array.isArray(categories) || !Array.isArray(streams)) throw new Error('Catalogue invalide : vérifiez vos identifiants Xtream Codes.');
    state.categories = categories.filter(item => item && item.category_id != null);
    state.streams = streams.filter(item => item && /^\d+$/.test(String(item.stream_id)));
    renderCategories();
    renderChannels();
  } catch (error) {
    state.categories = []; state.streams = [];
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
    const number = document.createElement('span'); name.className = 'category-number'; number.textContent = item.count;
    button.append(icon, name, number); button.addEventListener('click', () => chooseCategory(id)); nav.append(button);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = state.selected === id ? 'selected' : '';
    chip.setAttribute('aria-pressed', String(state.selected === id)); chip.textContent = item.category_name || 'Sans nom';
    chip.addEventListener('click', () => chooseCategory(id)); mobile.append(chip);
  });
}
function renderChannels() {
  const items = filtered(); const grid = $('channel-grid'); grid.replaceChildren();
  $('result-count').textContent = items.length.toLocaleString('fr-FR');
  $('list-subtitle').textContent = items.length + ' chaîne' + (items.length > 1 ? 's' : '') + ' disponible' + (items.length > 1 ? 's' : '');
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
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.hls) {
    try { state.hls.destroy(); } catch { /* ignore */ }
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

function startMpegTs(item, token, fromFallback = false) {
  if (token !== state.playToken) return;
  destroyEngines();
  if (!mpegtsSupported()) {
    showPlayerMessage('Ce fournisseur diffuse en MPEG-TS (.ts) et ce navigateur ne prend pas en charge MSE. Essayez Chrome, Edge, Firefox ou Android.', true);
    return;
  }
  const label = item.name || 'Chaîne';
  $('player-subtitle').textContent = 'Direct MPEG-TS · ' + label;
  showPlayerMessage(fromFallback ? 'Passage automatique en flux direct MPEG-TS...' : 'Connexion au flux direct MPEG-TS...');

  const video = $('video');
  const url = params('ts', { id: item.stream_id, _t: Date.now() });
  const player = window.mpegts.createPlayer(
    { type: 'mpegts', isLive: true, cors: true, url },
    {
      enableWorker: false,
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 5,
      liveBufferLatencyMinRemain: 1,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15
    }
  );
  state.mpegts = player;
  let hasPlayed = false;

  const markPlaying = () => {
    if (token !== state.playToken) return;
    hasPlayed = true;
    showPlayerMessage('');
  };
  video.addEventListener('playing', markPlaying, { once: true });

  player.on(window.mpegts.Events.ERROR, (errorType, errorDetail, errorInfo) => {
    if (token !== state.playToken) return;
    if (hasPlayed) {
      showPlayerMessage('Reconnexion automatique au direct...');
      state.reconnectTimer = setTimeout(() => startMpegTs(item, token, false), 900);
      return;
    }
    const statusCode = errorInfo && errorInfo.code;
    const msg = statusCode === 502
      ? 'Cette chaîne est actuellement hors antenne ou indisponible chez le fournisseur (ex. chaîne événementielle hors match).'
      : 'Lecture impossible sur cette chaîne (' + (errorDetail || errorType || 'flux indisponible') + ').';
    showPlayerMessage(msg, true);
  });

  player.on(window.mpegts.Events.LOADING_COMPLETE, () => {
    if (token !== state.playToken) return;
    if (hasPlayed && !$('player-overlay').hidden) {
      state.reconnectTimer = setTimeout(() => startMpegTs(item, token, false), 400);
    } else if (!hasPlayed) {
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

function startHls(item, token, allowFallback) {
  if (token !== state.playToken) return;
  destroyEngines();
  const label = item.name || 'Chaîne';
  $('player-subtitle').textContent = 'Direct HLS · ' + label;
  showPlayerMessage('Connexion au direct...');

  const url = params('play', { id: item.stream_id });
  const video = $('video');

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      backBufferLength: 30,
      maxBufferLength: 20,
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: allowFallback ? 0 : 1,
      levelLoadingTimeOut: 12000,
      fragLoadingTimeOut: 15000
    });
    state.hls = hls;
    let manifestReady = false;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (token !== state.playToken) return;
      manifestReady = true;
      showPlayerMessage('');
      video.play().catch(() => showPlayerMessage('Appuyez sur ▶ pour lancer la lecture.'));
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (token !== state.playToken || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && manifestReady) {
        hls.recoverMediaError();
        return;
      }
      if (allowFallback && mpegtsSupported()) {
        destroyEngines();
        state.reconnectTimer = setTimeout(() => startMpegTs(item, token, true), 150);
        return;
      }
      showPlayerMessage('Flux HLS indisponible sur cette chaîne. Essayez le mode MPEG-TS ou une autre chaîne.', true);
    });
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    const onNativeError = () => {
      if (token !== state.playToken) return;
      if (allowFallback && mpegtsSupported()) {
        startMpegTs(item, token, true);
      } else {
        showPlayerMessage('Ce flux n’est pas disponible en HLS natif sur cet appareil.', true);
      }
    };
    video.addEventListener('error', onNativeError, { once: true });
    video.src = url;
    video.play().catch(() => showPlayerMessage('Appuyez sur ▶ pour lancer la lecture.'));
    return;
  }

  if (allowFallback && mpegtsSupported()) {
    startMpegTs(item, token, true);
    return;
  }
  showPlayerMessage('Ce navigateur ne prend pas en charge la lecture HLS ou MPEG-TS.', true);
}

function play(item, keepFullscreen = false) {
  destroyPlayback();
  const token = state.playToken;
  state.current = item;
  const label = item.name || 'Chaîne';
  $('player-title').textContent = label;
  $('player-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  updateModeButtons();
  if (!keepFullscreen) $('close-player').focus();

  if (state.mode === 'ts') {
    startMpegTs(item, token, false);
  } else {
    startHls(item, token, state.mode === 'auto');
  }
}

function closePlayer() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  destroyPlayback(); state.current = null; $('player-overlay').hidden = true; document.body.style.overflow = ''; $('search').focus();
}
function openSettings() {
  $('server-input').value = state.credentials.server; $('username-input').value = state.credentials.username; $('password-input').value = state.credentials.password;
  $('settings-error').hidden = true; $('settings-overlay').hidden = false; $('server-input').focus();
}
function closeSettings() { $('settings-overlay').hidden = true; $('open-settings').focus(); }
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const next = { server: normalizeServer($('server-input').value), username: $('username-input').value.trim(), password: $('password-input').value.trim() };
  const error = $('settings-error');
  if (!/^https?:\/\//.test(next.server) || next.server !== state.configuredServer) {
    error.textContent = 'Le serveur doit correspondre à celui du proxy (' + state.configuredServer + '). Configurez XTREAM_SERVER sur Vercel pour le changer.'; error.hidden = false; return;
  }
  state.credentials = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private browsing: temporary settings only */ }
  state.selected = 'all'; state.visible = 40; closeSettings(); load();
});
$('search').addEventListener('input', (event) => { state.query = event.target.value.trim(); state.visible = 40; if (!state.loading) renderChannels(); });
$('show-more').addEventListener('click', () => { state.visible += 40; renderChannels(); });
$('refresh').addEventListener('click', load);
$('open-settings').addEventListener('click', openSettings);
$('mobile-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', (event) => { if (event.target === $('settings-overlay')) closeSettings(); });
$('close-player').addEventListener('click', closePlayer);
$('fullscreen').addEventListener('click', () => { const video = $('video'); if (document.fullscreenElement) document.exitFullscreen(); else if (video.requestFullscreen) video.requestFullscreen().catch(() => {}); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); });
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});
$('video').addEventListener('playing', () => showPlayerMessage(''));
$('video').addEventListener('error', () => {
  if (state.current && !state.hls && !state.mpegts) {
    showPlayerMessage('Le flux vidéo est indisponible ou son format n’est pas compatible avec cet appareil.', true);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Backspace' && event.target.tagName !== 'INPUT') {
    if (!$('settings-overlay').hidden) { closeSettings(); event.preventDefault(); }
    else if (!$('player-overlay').hidden) { closePlayer(); event.preventDefault(); }
  }
  if (event.key === '/' && event.target.tagName !== 'INPUT' && $('player-overlay').hidden && $('settings-overlay').hidden) { event.preventDefault(); $('search').focus(); }
  // Spatial navigation for remote controls in browsers without native directional focus.
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !['INPUT', 'VIDEO'].includes(event.target.tagName)) {
    const scope = !$('settings-overlay').hidden ? $('settings-overlay') : !$('player-overlay').hidden ? $('player-overlay') : document;
    const buttons = [...scope.querySelectorAll('button:not([hidden]),a[href],input')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const current = document.activeElement; if (!buttons.includes(current)) return;
    const box = current.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const choices = buttons.filter(el => el !== current).map(el => { const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - x, dy = b.top + b.height / 2 - y; return { el, dx, dy }; })
      .filter(({ dx, dy }) => event.key === 'ArrowRight' ? dx > 5 : event.key === 'ArrowLeft' ? dx < -5 : event.key === 'ArrowDown' ? dy > 5 : dy < -5)
      .sort((a, b) => { const score = p => event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? Math.abs(p.dx) + Math.abs(p.dy) * 2 : Math.abs(p.dy) + Math.abs(p.dx) * 2; return score(a) - score(b); });
    if (choices.length) { event.preventDefault(); choices[0].el.focus(); choices[0].el.scrollIntoView({ block: 'nearest' }); }
  }
});
updateModeButtons();
load();
