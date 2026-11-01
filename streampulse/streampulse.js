/* ==========================================================================
   StreamPulse — Unified Adaptive IPTV Player (#streampulse-module)
   - Single streamlined interface with automatic TV / Desktop / Mobile adaptation
   - 100% crisp inline SVG iconography (zero emojis / stickers)
   - Adaptive Video Engine: hls.js (ABR) + Shaka DASH (ABR) + mpegts.js live TS
   - Strict Smart TV memory cleanup on every zap (destroy + video buffer flush)
   - Exponential-backoff recovery + 1-connection Xtream zapping protection
   - True DOM Virtualization (~20 DOM rows for 28,000+ channels)
   - 60 FPS requestAnimationFrame telemetry loop (zero setInterval)
   - Passive touch/scroll listeners ({ passive: true }) + PWA install support
   ========================================================================== */
(function (rootGlobal) {
  'use strict';

  const CHANNEL_ROW_HEIGHT = 64;
  const CHANNEL_OVERSCAN = 6;
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_MAX_MS = 16000;
  const MAX_AUTO_RETRIES = 5;
  const MAX_ZAP_WAIT_MS = 25000;
  const FAV_STORAGE_KEY = 'sp-favorites-v1';
  const PROTO_STORAGE_KEY = 'sp-protocol-v1';
  const LAST_CH_STORAGE_KEY = 'sp-last-channel-v1';
  const ECO_STORAGE_KEY = 'sp-eco-mode-v1';

  /* Pure vector SVG icon set — zero emojis or Unicode dingbats */
  const ICONS = {
    tv: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
    qr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h7"/></svg>',
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    star: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    starSolid: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    refresh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
    play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    prev: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>',
    next: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
    volume: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    mute: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    maximize: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    sidebar: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
    activity: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    layers: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    chevronDown: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    help: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };

  /**
   * Pure virtual-scroll window calculator (unit-testable in Node).
   */
  function computeVirtualRange(totalCount, scrollTop, viewportHeight, rowHeight, overscan) {
    const safeTotal = Math.max(0, Number(totalCount) || 0);
    const safeHeight = Math.max(rowHeight, Number(viewportHeight) || 480);
    const safeScroll = Math.max(0, Number(scrollTop) || 0);
    if (safeTotal === 0) {
      return { start: 0, end: 0, totalHeight: 0 };
    }
    const firstVisible = Math.floor(safeScroll / rowHeight);
    const visibleCount = Math.ceil(safeHeight / rowHeight);
    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(safeTotal, firstVisible + visibleCount + overscan);
    return {
      start,
      end,
      totalHeight: safeTotal * rowHeight
    };
  }

  /**
   * Pure exponential backoff calculator with optional jitter (unit-testable in Node).
   */
  function computeBackoffMs(attempt, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS, jitterMs = 0) {
    const n = Math.max(0, Number(attempt) || 0);
    const exp = Math.min(maxMs, baseMs * Math.pow(2, n));
    return Math.round(exp + Math.max(0, jitterMs));
  }

  /**
   * Lightweight M3U playlist parser for direct #EXTM3U content.
   */
  function parseM3uPlaylist(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let pending = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const nameMatch = line.split(',');
        const name = (nameMatch.slice(1).join(',') || 'Chaîne').trim();
        const groupMatch = line.match(/group-title="([^"]*)"/i);
        const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
        pending = {
          name,
          category_name: groupMatch ? groupMatch[1].trim() : 'Direct M3U',
          stream_icon: logoMatch ? logoMatch[1].trim() : ''
        };
      } else if (!line.startsWith('#') && /^https?:\/\//i.test(line)) {
        const id = 'm3u_' + (out.length + 1);
        out.push({
          stream_id: id,
          directUrl: line,
          name: pending ? pending.name : 'Flux ' + (out.length + 1),
          category_id: pending ? pending.category_name : 'Direct M3U',
          category_name: pending ? pending.category_name : 'Direct M3U',
          stream_icon: pending ? pending.stream_icon : ''
        });
        pending = null;
      }
    }
    return out;
  }

  /**
   * Detects Xtream section divider pseudo-channels such as "##### FRANCE #####" or "--- CANAL+ ---".
   */
  function isSeparatorStream(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    return /^(?:[#=*~_-]{3,}|\|[-=]{2,}).*(?:[#=*~_-]{3,}|[-=]{2,}\|)$/.test(s);
  }

  function cleanSeparatorLabel(name) {
    return String(name || '')
      .replace(/^[#=*~_\-\s|]+|[#=*~_\-\s|]+$/g, '')
      .trim() || 'Section';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inferQualityTag(name) {
    const s = String(name || '').toUpperCase();
    if (/\b8K\b/.test(s)) return '8K';
    if (/\b(4K|UHD|2160P)\b/.test(s)) return '4K';
    if (/\b(FHD|1080P)\b/.test(s)) return 'FHD';
    if (/\b(HD|720P)\b/.test(s)) return 'HD';
    if (/\bHEVC\b/.test(s)) return 'HEVC';
    return '';
  }

  function channelInitials(name) {
    const clean = String(name || 'TV')
      .replace(/^[A-Z]{2,3}\s*[:|-]\s*/i, '')
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .trim();
    return (clean.slice(0, 2) || 'TV').toUpperCase();
  }

  class StreamPulseController {
    constructor(mountEl) {
      this.mountEl = mountEl;
      this.mounted = false;
      this.isOpen = true;
      this.activeTab = 'live'; // 'live' | 'favs'
      this.selectedCat = 'all';
      this.searchQuery = '';
      this.bouquetQuery = '';
      this.isBouquetDrawerOpen = false;
      this.isTheater = false;
      this.isStatsOpen = false;

      this.categories = [];
      this.categoryMap = new Map();
      this.categoryCounts = new Map();
      this.streams = [];
      this.customStreams = null;
      this.filtered = [];
      this.favorites = this.readFavorites();
      this.protocol = this.readProtocol(); // 'auto' | 'hls' | 'ts'
      this.ecoMode = this.readEcoMode(); // Caps bandwidth/resolution to save Fast Origin Transfer
      this.lastSavedChannelId = this.readLastChannelId();

      this.isLoadingCatalogue = false;
      this.catalogueError = '';
      this.hasCreds = false;

      this.currentChannel = null;
      this.currentIndex = -1;
      this.focusedVirtualIndex = 0;
      this.userMuted = false;

      // Active media engines
      this.hls = null;
      this.shaka = null;
      this.mpegts = null;
      this.wasStreaming = false;
      this.sessionToken = 0;
      this.retryAttempt = 0;
      this.zapRetries = 0;
      this.zapStartedAt = 0;
      this.mediaRecoveryCount = 0;
      this.retryTimer = null;
      this.zapStartPerf = 0;
      this.lastZapSeconds = '--';
      this.abrSelection = -1;

      // OSD & Toast timers
      this.osdTimer = null;
      this.toastTimer = null;
      this.virtualRafPending = false;

      // 60 FPS requestAnimationFrame telemetry state (zero setInterval)
      this.rafId = 0;
      this.lastFrameTs = 0;
      this.fpsSamples = [];
      this.lastTelemetryCommitTs = 0;
      this.measuredMbps = 0;
      this.measuredPingMs = 0;
      this.detectedCodec = 'Auto ABR';
      this.renderedTelemetry = {};

      // Touch & PWA prompt
      this.touchStartX = 0;
      this.touchStartY = 0;
      this.deferredInstallPrompt = null;
    }

    readFavorites() {
      try {
        const arr = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]');
        return new Set(Array.isArray(arr) ? arr.map(String) : []);
      } catch {
        return new Set();
      }
    }

    saveFavorites() {
      try {
        localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...this.favorites]));
      } catch { /* ignore */ }
    }

    readProtocol() {
      try {
        const p = localStorage.getItem(PROTO_STORAGE_KEY);
        return ['auto', 'hls', 'ts'].includes(p) ? p : 'auto';
      } catch {
        return 'auto';
      }
    }

    saveProtocol(proto) {
      if (!['auto', 'hls', 'ts'].includes(proto)) return;
      this.protocol = proto;
      try { localStorage.setItem(PROTO_STORAGE_KEY, proto); } catch { /* ignore */ }
      this.updateProtocolButtons();
      if (this.currentChannel) {
        this.playChannel(this.currentChannel, this.currentIndex);
      }
    }

    readLastChannelId() {
      try { return localStorage.getItem(LAST_CH_STORAGE_KEY) || ''; }
      catch { return ''; }
    }

    readEcoMode() {
      try { return localStorage.getItem(ECO_STORAGE_KEY) === '1'; }
      catch { return false; }
    }

    saveLastChannelId(id) {
      const s = String(id || '');
      this.lastSavedChannelId = s;
      try { localStorage.setItem(LAST_CH_STORAGE_KEY, s); } catch { /* ignore */ }
    }

    q(sel) {
      return this.mountEl ? this.mountEl.querySelector(sel) : null;
    }

    mount() {
      if (this.mounted || !this.mountEl) return;
      this.mounted = true;
      this.mountEl.hidden = false;
      this.mountEl.setAttribute('aria-hidden', 'false');
      this.mountEl.setAttribute('data-input', 'pointer');
      this.mountEl.innerHTML = this.template();
      this.bindEvents();
      this.updateProtocolButtons();
      this.syncFromBridge();
      this.startTelemetryLoop();
    }

    template() {
      return `
      <!-- EN-TÊTE UNIFIÉ ÉPURÉ -->
      <header class="sp-topbar">
        <div class="sp-brand">
          <div class="sp-brand-icon">
            <img src="/assets/pwa-icon-192.png" alt="StreamPulse" width="34" height="34">
          </div>
          <div class="sp-brand-text">
            <span class="sp-brand-title">Stream<span class="sp-brand-accent">Pulse</span></span>
            <span class="sp-status-pill">
              <span class="sp-status-dot" data-sp="statusDot"></span>
              <span data-sp="statusLabel">Prêt</span>
            </span>
          </div>
        </div>

        <div class="sp-top-actions">
          <button type="button" class="sp-btn sp-btn-soft sp-focusable sp-hidden" data-action="install-pwa" data-sp="installBtn" title="Installer l'application StreamPulse">
            ${ICONS.download}
            <span class="sp-hide-mobile">Installer l’app</span>
          </button>

          <button type="button" class="sp-btn sp-btn-soft sp-focusable" data-action="open-qr" title="Associer un téléviseur par QR Code chiffré">
            ${ICONS.qr}
            <span>QR TV</span>
          </button>

          <button type="button" class="sp-btn sp-btn-primary sp-focusable" data-action="open-settings" title="Connecter ou modifier ma playlist Xtream / M3U">
            ${ICONS.settings}
            <span class="sp-hide-mobile">Ma Playlist</span>
          </button>

          <button type="button" class="sp-btn sp-btn-icon sp-focusable sp-hide-mobile" data-action="open-help" title="Raccourcis clavier &amp; télécommande">
            ${ICONS.help}
          </button>
        </div>
      </header>

      <!-- ESPACE DE TRAVAIL ADAPTATIF -->
      <div class="sp-workspace">
        <!-- Panneau Chaînes & Bouquets (Virtual Scrolling DOM) -->
        <aside class="sp-browser" aria-label="Catalogue des chaînes">
          <div class="sp-browser-top">
            <div class="sp-view-tabs" role="tablist">
              <button type="button" class="sp-view-tab sp-active sp-focusable" data-action="tab-live" data-sp="tabLive">
                ${ICONS.tv}
                <span>Toutes les chaînes</span>
              </button>
              <button type="button" class="sp-view-tab sp-focusable" data-action="tab-favs" data-sp="tabFavs">
                ${ICONS.star}
                <span data-sp="favTabCount">Favoris</span>
              </button>
            </div>

            <div class="sp-filter-row">
              <div class="sp-search-box">
                ${ICONS.search}
                <input type="search" class="sp-search-input sp-focusable" data-sp="searchInput" placeholder="Rechercher une chaîne..." autocomplete="off" spellcheck="false">
                <button type="button" class="sp-search-clear sp-hidden" data-action="clear-search" data-sp="clearSearchBtn" aria-label="Effacer">${ICONS.x}</button>
              </div>
              <button type="button" class="sp-btn sp-btn-icon sp-focusable" data-action="refresh-cat" title="Actualiser le catalogue">
                ${ICONS.refresh}
              </button>
            </div>

            <button type="button" class="sp-bouquet-trigger sp-focusable" data-action="toggle-bouquets" data-sp="bouquetTrigger">
              <span class="sp-bouquet-trigger-left">
                ${ICONS.layers}
                <span class="sp-bouquet-trigger-label" data-sp="bouquetLabel">Tous les bouquets</span>
              </span>
              ${ICONS.chevronDown}
            </button>

            <div class="sp-chips-row sp-no-scrollbar" data-sp="chipsRow"></div>
          </div>

          <!-- Tiroir filtrable des bouquets (pratique pour 200+ catégories) -->
          <div class="sp-bouquet-drawer sp-hidden" data-sp="bouquetDrawer">
            <div class="sp-bouquet-drawer-head">
              <div class="sp-search-box">
                ${ICONS.search}
                <input type="search" class="sp-search-input sp-focusable" data-sp="bouquetSearch" placeholder="Filtrer les bouquets (France, Sport...)" autocomplete="off" spellcheck="false">
              </div>
              <button type="button" class="sp-btn sp-btn-icon" data-action="toggle-bouquets" title="Fermer">${ICONS.x}</button>
            </div>
            <div class="sp-bouquet-list sp-scroll" data-sp="bouquetList"></div>
          </div>

          <!-- Liste Virtualisée des Chaînes -->
          <div class="sp-virtual-viewport sp-scroll" data-sp="channelsViewport">
            <div class="sp-virtual-spacer" data-sp="channelsSpacer"></div>
            <div class="sp-list-state sp-hidden" data-sp="listState"></div>
          </div>

          <div class="sp-browser-foot">
            <span data-sp="footSource">StreamPulse · PremiumZone</span>
            <div style="display:flex;gap:8px;align-items:center">
              <button type="button" class="sp-link-btn" data-action="open-rawm3u">Fichier #EXTM3U</button>
              <span>·</span>
              <button type="button" class="sp-link-btn" data-action="open-about">À propos</button>
            </div>
          </div>
        </aside>

        <!-- Scène Vidéo Cinéma -->
        <main class="sp-stage" data-sp="stage">
          <video class="sp-video" data-sp="video" playsinline autoplay preload="none"></video>

          <!-- Écran d'accueil / Veille haute couture -->
          <div class="sp-standby" data-sp="standby">
            <div class="sp-standby-card" data-sp="standbyCard"></div>
          </div>

          <!-- Indicateur de chargement du flux -->
          <div class="sp-buffering sp-hidden" data-sp="buffering">
            <div class="sp-spinner"></div>
            <span class="sp-buffering-label" data-sp="bufferingLabel">Ouverture du direct...</span>
          </div>

          <!-- Bouton flottant si le navigateur démarre en sourdine -->
          <button type="button" class="sp-unmute-pill sp-hidden" data-action="force-unmute" data-sp="unmutePill">
            ${ICONS.mute}
            <span>Activer le son</span>
          </button>

          <!-- Bandeau d'état / reconnexion -->
          <div class="sp-alert-box sp-hidden" data-sp="streamAlert"></div>

          <!-- Panneau Infos Flux (requestAnimationFrame 60 FPS) -->
          <div class="sp-stats-card sp-hidden" data-sp="statsCard">
            <div class="sp-stats-row"><span>Moteur</span><strong data-sp="statEngine">HLS ABR</strong></div>
            <div class="sp-stats-row"><span>Qualité</span><strong data-sp="statRes">Auto</strong></div>
            <div class="sp-stats-row"><span>Tampon vidéo</span><strong data-sp="statBuffer">0.0 s</strong></div>
            <div class="sp-stats-row"><span>Débit estimé</span><strong data-sp="statBitrate">-- Mbps</strong></div>
            <div class="sp-stats-row"><span>Latence segment</span><strong data-sp="statPing">-- ms</strong></div>
            <div class="sp-stats-row"><span>Fluidité UI</span><strong data-sp="statFps">60 fps</strong></div>
            <div class="sp-stats-row"><span>Zapping</span><strong data-sp="statZap">--</strong></div>
          </div>

          <!-- Toast discret -->
          <div class="sp-toast" data-sp="toast"></div>

          <!-- Contrôles Supérieurs (auto-masqués en lecture) -->
          <div class="sp-osd-top sp-hidden" data-sp="osdTop">
            <div class="sp-now-playing">
              <button type="button" class="sp-ctrl-btn sp-focusable sp-hide-mobile" data-action="toggle-theater" title="Afficher / masquer la liste des chaînes">
                ${ICONS.sidebar}
              </button>
              <span class="sp-live-tag"><i></i> DIRECT</span>
              <div class="sp-now-titles">
                <h2 class="sp-now-name" data-sp="osdTitle">Chaîne en direct</h2>
                <p class="sp-now-cat" data-sp="osdCat">Diffusion adaptative</p>
              </div>
            </div>

            <div class="sp-ctrl-cluster">
              <button type="button" class="sp-ctrl-btn sp-focusable" data-action="toggle-fav-current" data-sp="favCurrentBtn" title="Ajouter aux favoris">
                ${ICONS.star}
              </button>
              <button type="button" class="sp-ctrl-btn sp-focusable" data-action="toggle-stats" data-sp="statsBtn" title="Informations techniques du flux">
                ${ICONS.activity}
              </button>
            </div>
          </div>

          <!-- Contrôles Inférieurs (auto-masqués en lecture) -->
          <div class="sp-osd-bottom sp-hidden" data-sp="osdBottom">
            <div class="sp-ctrl-cluster">
              <button type="button" class="sp-ctrl-btn sp-focusable" data-action="prev-ch" title="Chaîne précédente">
                ${ICONS.prev}
              </button>
              <button type="button" class="sp-ctrl-play sp-focusable" data-action="play-pause" data-sp="playBtn" title="Lecture / Pause">
                ${ICONS.pause}
              </button>
              <button type="button" class="sp-ctrl-btn sp-focusable" data-action="next-ch" title="Chaîne suivante">
                ${ICONS.next}
              </button>

              <div class="sp-vol-wrap">
                <button type="button" class="sp-ctrl-btn sp-focusable" data-action="mute" data-sp="muteBtn" title="Activer / couper le son">
                  ${ICONS.volume}
                </button>
                <input type="range" min="0" max="100" value="95" class="sp-vol-slider" data-sp="volRange" aria-label="Volume">
              </div>
            </div>

            <div class="sp-ctrl-cluster">
              <div class="sp-proto-group" role="group" aria-label="Format de réception">
                <button type="button" class="sp-proto-btn sp-focusable" data-proto="auto">Auto</button>
                <button type="button" class="sp-proto-btn sp-focusable" data-proto="hls">HLS</button>
                <button type="button" class="sp-proto-btn sp-focusable" data-proto="ts">MPEG-TS</button>
              </div>

              <button type="button" class="sp-ctrl-pill sp-focusable" data-action="cycle-abr" data-sp="abrBtn" title="Sélectionner la qualité vidéo">
                ABR Auto
              </button>

              <button type="button" class="sp-ctrl-btn sp-focusable" data-action="fullscreen" title="Plein écran">
                ${ICONS.maximize}
              </button>
            </div>
          </div>
        </main>
      </div>

      <!-- BARRE DE NAVIGATION INFÉRIEURE AUTOMATIQUE SUR MOBILE (< 960px) -->
      <nav class="sp-mobile-bar" aria-label="Navigation mobile">
        <button type="button" class="sp-mobile-tab sp-active" data-action="tab-live" data-sp="mobLive">
          ${ICONS.tv}
          <span>Direct</span>
        </button>
        <button type="button" class="sp-mobile-tab" data-action="tab-favs" data-sp="mobFavs">
          ${ICONS.star}
          <span>Favoris</span>
        </button>
        <button type="button" class="sp-mobile-tab" data-action="open-qr">
          ${ICONS.qr}
          <span>QR TV</span>
        </button>
        <button type="button" class="sp-mobile-tab" data-action="open-settings">
          ${ICONS.settings}
          <span>Playlist</span>
        </button>
      </nav>

      <!-- MODALE INTERNE : IMPORT TEXTE #EXTM3U DIRECT -->
      <div class="sp-modal-backdrop sp-hidden" data-sp="rawM3uModal" role="dialog" aria-modal="true" aria-label="Importer une liste #EXTM3U">
        <div class="sp-modal-card">
          <div class="sp-modal-head">
            <h3>Importer une liste #EXTM3U</h3>
            <button type="button" class="sp-btn sp-btn-icon" data-action="close-rawm3u">${ICONS.x}</button>
          </div>
          <p style="margin:0;font-size:12.5px;color:var(--sp-muted);line-height:1.5">Collez directement le contenu brut d’un fichier <code>#EXTM3U</code> pour charger ses flux localement.</p>
          <textarea data-sp="inpRawM3u" rows="5" style="width:100%;border-radius:10px;border:1px solid var(--sp-border);background:rgba(255,255,255,0.04);color:#fff;padding:10px;font-family:var(--sp-font-mono);font-size:12px;resize:vertical;outline:none" placeholder="#EXTM3U&#10;#EXTINF:-1 group-title=&quot;Sport&quot;,Chaîne HD&#10;https://..."></textarea>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="sp-btn" data-action="close-rawm3u">Annuler</button>
            <button type="button" class="sp-btn sp-btn-primary" data-action="save-rawm3u">Charger les flux</button>
          </div>
        </div>
      </div>

      <!-- MODALE INTERNE : RACCOURCIS CLAVIER & TÉLÉCOMMANDE -->
      <div class="sp-modal-backdrop sp-hidden" data-sp="helpModal" role="dialog" aria-modal="true" aria-label="Raccourcis">
        <div class="sp-modal-card">
          <div class="sp-modal-head">
            <h3>Commandes Smart TV &amp; Clavier</h3>
            <button type="button" class="sp-btn sp-btn-icon" data-action="close-help">${ICONS.x}</button>
          </div>
          <div class="sp-kbd-row"><span>Parcourir la liste des chaînes</span><kbd>Flèches Haut / Bas</kbd></div>
          <div class="sp-kbd-row"><span>Lancer la chaîne sélectionnée</span><kbd>Entrée / OK</kbd></div>
          <div class="sp-kbd-row"><span>Zapping chaîne précédente / suivante</span><kbd>Flèches Gauche / Droite</kbd></div>
          <div class="sp-kbd-row"><span>Lecture / Pause</span><kbd>Espace</kbd></div>
          <div class="sp-kbd-row"><span>Mode cinéma (masquer la liste)</span><kbd>T</kbd></div>
          <div class="sp-kbd-row"><span>Plein écran</span><kbd>F</kbd></div>
          <div style="display:flex;justify-content:flex-end">
            <button type="button" class="sp-btn sp-btn-primary" data-action="close-help">Fermer</button>
          </div>
        </div>
      </div>
      `;
    }

    bindEvents() {
      // Automatic input modality switch (Pointer vs Smart TV D-Pad)
      this.mountEl.addEventListener('pointermove', () => {
        if (this.mountEl.getAttribute('data-input') !== 'pointer') {
          this.mountEl.setAttribute('data-input', 'pointer');
        }
        if (this.currentChannel) this.wakeOsd();
      }, { passive: true });

      // Delegated clicks inside #streampulse-module
      this.mountEl.addEventListener('click', (ev) => {
        const protoBtn = ev.target.closest('[data-proto]');
        if (protoBtn) {
          this.saveProtocol(protoBtn.getAttribute('data-proto'));
          return;
        }
        const actionEl = ev.target.closest('[data-action]');
        if (actionEl) {
          this.handleAction(actionEl.getAttribute('data-action'), actionEl, ev);
          return;
        }
        const catChip = ev.target.closest('[data-sp-cat]');
        if (catChip) {
          this.selectCategory(catChip.getAttribute('data-sp-cat'));
          return;
        }
        const favToggle = ev.target.closest('[data-fav-id]');
        if (favToggle) {
          ev.stopPropagation();
          this.toggleFavorite(favToggle.getAttribute('data-fav-id'));
          return;
        }
        const chRow = ev.target.closest('[data-sp-idx]');
        if (chRow) {
          const idx = Number(chRow.getAttribute('data-sp-idx'));
          if (Number.isFinite(idx) && this.filtered[idx] && !isSeparatorStream(this.filtered[idx].name)) {
            this.playChannel(this.filtered[idx], idx);
          }
          return;
        }
        if (ev.target === this.q('[data-sp="video"]') || ev.target === this.q('[data-sp="stage"]')) {
          if (this.currentChannel) this.toggleOsd();
        }
      });

      // Double-click on video toggles fullscreen on desktop
      this.q('[data-sp="video"]').addEventListener('dblclick', () => this.toggleFullscreen());

      // Search channels
      const searchInput = this.q('[data-sp="searchInput"]');
      searchInput.addEventListener('input', () => {
        this.searchQuery = searchInput.value.trim().toLocaleLowerCase();
        this.q('[data-sp="clearSearchBtn"]').classList.toggle('sp-hidden', !this.searchQuery);
        this.q('[data-sp="channelsViewport"]').scrollTop = 0;
        this.recomputeFiltered();
      });

      // Search bouquets inside bouquet drawer
      const bouquetSearch = this.q('[data-sp="bouquetSearch"]');
      bouquetSearch.addEventListener('input', () => {
        this.bouquetQuery = bouquetSearch.value.trim().toLocaleLowerCase();
        this.renderBouquetDrawerList();
      });

      // Volume slider
      const volRange = this.q('[data-sp="volRange"]');
      volRange.addEventListener('input', () => {
        const video = this.q('[data-sp="video"]');
        const v = Number(volRange.value) / 100;
        video.volume = v;
        this.userMuted = v === 0;
        video.muted = this.userMuted;
        this.syncMuteIcon();
      });

      // Passive scroll & touch listeners ({ passive: true }) for silky 60 FPS mobile scrolling
      const chViewport = this.q('[data-sp="channelsViewport"]');
      chViewport.addEventListener('scroll', () => {
        if (this.virtualRafPending) return;
        this.virtualRafPending = true;
        requestAnimationFrame(() => {
          this.virtualRafPending = false;
          this.renderVirtualChannels();
        });
      }, { passive: true });
      chViewport.addEventListener('touchstart', () => {}, { passive: true });
      chViewport.addEventListener('touchmove', () => {}, { passive: true });

      const chipsRow = this.q('[data-sp="chipsRow"]');
      chipsRow.addEventListener('touchstart', () => {}, { passive: true });
      chipsRow.addEventListener('touchmove', () => {}, { passive: true });

      const bqList = this.q('[data-sp="bouquetList"]');
      bqList.addEventListener('touchstart', () => {}, { passive: true });
      bqList.addEventListener('touchmove', () => {}, { passive: true });

      // Passive touch swipe & wake OSD on video stage
      const stage = this.q('[data-sp="stage"]');
      stage.addEventListener('touchstart', (e) => {
        if (this.currentChannel) this.wakeOsd();
        if (e.touches && e.touches[0]) {
          this.touchStartX = e.touches[0].clientX;
          this.touchStartY = e.touches[0].clientY;
        }
      }, { passive: true });
      stage.addEventListener('touchmove', () => {}, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (!this.currentChannel || !e.changedTouches || !e.changedTouches[0]) return;
        const dx = e.changedTouches[0].clientX - this.touchStartX;
        const dy = e.changedTouches[0].clientY - this.touchStartY;
        if (Math.abs(dx) > 75 && Math.abs(dx) > Math.abs(dy) * 1.8) {
          this.stepChannel(dx < 0 ? 1 : -1);
        }
      }, { passive: true });

      // Video media state events
      const video = this.q('[data-sp="video"]');
      video.addEventListener('playing', () => {
        this.setBuffering(false);
        this.q('[data-sp="playBtn"]').innerHTML = ICONS.pause;
      });
      video.addEventListener('pause', () => {
        if (this.currentChannel) this.q('[data-sp="playBtn"]').innerHTML = ICONS.play;
      });
      video.addEventListener('waiting', () => {
        if (this.currentChannel) this.setBuffering(true, 'Mise en mémoire tampon...');
      });
      video.addEventListener('timeupdate', () => {
        if (this.currentChannel && !video.paused && video.readyState >= 2) {
          this.setBuffering(false);
        }
      });

      // Reactive sync with ONDA auth & QR pairing state
      rootGlobal.addEventListener('onda:catalogue-updated', () => {
        this.customStreams = null;
        this.syncFromBridge();
      });

      // PWA Install Prompt capture
      rootGlobal.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredInstallPrompt = e;
        this.q('[data-sp="installBtn"]')?.classList.remove('sp-hidden');
        this.renderStandbyCard();
      });

      rootGlobal.addEventListener('appinstalled', () => {
        this.deferredInstallPrompt = null;
        this.q('[data-sp="installBtn"]')?.classList.add('sp-hidden');
        this.showToast('Application StreamPulse installée');
      });

      // Smart TV D-Pad & Keyboard controls
      rootGlobal.addEventListener('keydown', (ev) => this.onKeyDown(ev));

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.stopTelemetryLoop();
        else if (this.isOpen) this.startTelemetryLoop();
      });
      rootGlobal.addEventListener('pagehide', () => this.destroyPlayer());
    }

    handleAction(action) {
      const bridge = rootGlobal.ONDA_BRIDGE;
      switch (action) {
        case 'open-qr':
          bridge?.openQrPair?.();
          break;
        case 'open-settings':
          bridge?.openSettings?.();
          break;
        case 'open-about':
          bridge?.openAbout?.();
          break;
        case 'refresh-cat':
          this.showToast('Actualisation du catalogue...');
          bridge?.refreshCatalogue?.();
          break;
        case 'install-pwa':
          this.triggerPwaInstall();
          break;
        case 'tab-live':
          this.setTab('live');
          break;
        case 'tab-favs':
          this.setTab('favs');
          break;
        case 'clear-search':
          this.q('[data-sp="searchInput"]').value = '';
          this.searchQuery = '';
          this.q('[data-sp="clearSearchBtn"]').classList.add('sp-hidden');
          this.recomputeFiltered();
          break;
        case 'toggle-bouquets':
          this.toggleBouquetDrawer();
          break;
        case 'toggle-theater':
          this.isTheater = !this.isTheater;
          this.mountEl.classList.toggle('sp-theater', this.isTheater);
          break;
        case 'toggle-stats':
          this.isStatsOpen = !this.isStatsOpen;
          this.q('[data-sp="statsCard"]').classList.toggle('sp-hidden', !this.isStatsOpen);
          this.q('[data-sp="statsBtn"]').classList.toggle('sp-active', this.isStatsOpen);
          break;
        case 'prev-ch':
          this.stepChannel(-1);
          break;
        case 'next-ch':
          this.stepChannel(1);
          break;
        case 'play-pause':
          this.togglePlayPause();
          break;
        case 'mute':
          this.toggleMute();
          break;
        case 'force-unmute': {
          const video = this.q('[data-sp="video"]');
          this.userMuted = false;
          video.muted = false;
          if (video.volume === 0) video.volume = 0.95;
          this.q('[data-sp="unmutePill"]').classList.add('sp-hidden');
          this.syncMuteIcon();
          break;
        }
        case 'cycle-abr':
          this.cycleAbrQuality();
          break;
        case 'toggle-fav-current':
          if (this.currentChannel) {
            this.toggleFavorite(this.currentChannel.stream_id);
          }
          break;
        case 'fullscreen':
          this.toggleFullscreen();
          break;
        case 'resume-last':
          this.playResumeOrFirst();
          break;
        case 'open-rawm3u':
          this.q('[data-sp="rawM3uModal"]').classList.remove('sp-hidden');
          this.q('[data-sp="inpRawM3u"]').focus();
          break;
        case 'close-rawm3u':
          this.q('[data-sp="rawM3uModal"]').classList.add('sp-hidden');
          break;
        case 'save-rawm3u':
          this.importRawM3u();
          break;
        case 'open-help':
          this.q('[data-sp="helpModal"]').classList.remove('sp-hidden');
          break;
        case 'close-help':
          this.q('[data-sp="helpModal"]').classList.add('sp-hidden');
          break;
      }
    }

    async triggerPwaInstall() {
      if (!this.deferredInstallPrompt) return;
      try {
        this.deferredInstallPrompt.prompt();
        await this.deferredInstallPrompt.userChoice;
      } catch { /* ignore */ }
      this.deferredInstallPrompt = null;
      this.q('[data-sp="installBtn"]')?.classList.add('sp-hidden');
      this.renderStandbyCard();
    }

    setTab(tab) {
      this.activeTab = tab === 'favs' ? 'favs' : 'live';
      const isFavs = this.activeTab === 'favs';
      this.q('[data-sp="tabLive"]').classList.toggle('sp-active', !isFavs);
      this.q('[data-sp="tabFavs"]').classList.toggle('sp-active', isFavs);
      this.q('[data-sp="mobLive"]').classList.toggle('sp-active', !isFavs);
      this.q('[data-sp="mobFavs"]').classList.toggle('sp-active', isFavs);
      this.isBouquetDrawerOpen = false;
      this.q('[data-sp="bouquetDrawer"]').classList.add('sp-hidden');
      this.q('[data-sp="channelsViewport"]').classList.remove('sp-hidden');
      this.q('[data-sp="channelsViewport"]').scrollTop = 0;
      this.recomputeFiltered();
    }

    selectCategory(catId) {
      this.selectedCat = String(catId || 'all');
      this.isBouquetDrawerOpen = false;
      this.q('[data-sp="bouquetDrawer"]').classList.add('sp-hidden');
      this.q('[data-sp="channelsViewport"]').classList.remove('sp-hidden');
      this.q('[data-sp="channelsViewport"]').scrollTop = 0;
      this.updateBouquetTriggerLabel();
      this.renderCategoryChips();
      this.recomputeFiltered();
    }

    toggleBouquetDrawer() {
      if (!this.categories.length) return;
      this.isBouquetDrawerOpen = !this.isBouquetDrawerOpen;
      this.q('[data-sp="bouquetDrawer"]').classList.toggle('sp-hidden', !this.isBouquetDrawerOpen);
      this.q('[data-sp="channelsViewport"]').classList.toggle('sp-hidden', this.isBouquetDrawerOpen);
      if (this.isBouquetDrawerOpen) {
        this.bouquetQuery = '';
        const inp = this.q('[data-sp="bouquetSearch"]');
        inp.value = '';
        this.renderBouquetDrawerList();
        inp.focus();
      }
    }

    updateBouquetTriggerLabel() {
      const labelEl = this.q('[data-sp="bouquetLabel"]');
      if (!labelEl) return;
      if (this.selectedCat === 'all') {
        const bCount = this.categories.length;
        labelEl.textContent = bCount ? `Tous les bouquets (${bCount})` : 'Tous les bouquets';
      } else {
        labelEl.textContent = this.categoryMap.get(this.selectedCat) || 'Bouquet sélectionné';
      }
    }

    renderBouquetDrawerList() {
      const listEl = this.q('[data-sp="bouquetList"]');
      if (!listEl) return;
      const q = this.bouquetQuery;
      const items = [
        { id: 'all', name: 'Toutes les chaînes', count: this.streams.length },
        ...this.categories.map((c) => ({
          id: String(c.category_id),
          name: c.category_name || 'Sans nom',
          count: this.categoryCounts.get(String(c.category_id)) || 0
        }))
      ].filter((item) => !q || item.name.toLocaleLowerCase().includes(q));

      listEl.innerHTML = items
        .map((it) => `
          <button type="button" class="sp-bouquet-item sp-focusable ${this.selectedCat === it.id ? 'sp-active' : ''}" data-sp-cat="${escapeHtml(it.id)}">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.name)}</span>
            <span class="sp-bouquet-count">${it.count.toLocaleString('fr-FR')}</span>
          </button>
        `)
        .join('');
    }

    renderCategoryChips() {
      const bar = this.q('[data-sp="chipsRow"]');
      if (!bar) return;
      if (!this.categories.length) {
        bar.innerHTML = '';
        return;
      }
      const chips = [{ id: 'all', name: 'Tous' }];
      const limit = Math.min(this.categories.length, 30);
      for (let i = 0; i < limit; i++) {
        const c = this.categories[i];
        chips.push({ id: String(c.category_id), name: c.category_name || 'Bouquet' });
      }
      bar.innerHTML = chips
        .map((c) => `<button type="button" data-sp-cat="${escapeHtml(c.id)}" class="sp-chip sp-focusable ${this.selectedCat === c.id ? 'sp-active' : ''}">${escapeHtml(c.name)}</button>`)
        .join('');
    }

    toggleFavorite(streamId) {
      const key = String(streamId);
      if (this.favorites.has(key)) {
        this.favorites.delete(key);
        this.showToast('Retiré des favoris');
      } else {
        this.favorites.add(key);
        this.showToast('Ajouté aux favoris');
      }
      this.saveFavorites();
      this.updateFavCounts();
      this.updateCurrentFavButton();
      if (this.activeTab === 'favs') this.recomputeFiltered();
      else this.renderVirtualChannels();
    }

    updateFavCounts() {
      const n = this.favorites.size;
      const el = this.q('[data-sp="favTabCount"]');
      if (el) el.textContent = n > 0 ? `Favoris (${n})` : 'Favoris';
    }

    syncFromBridge() {
      if (!this.mounted) return;
      const bridge = rootGlobal.ONDA_BRIDGE;
      const snap = bridge && typeof bridge.getState === 'function' ? bridge.getState() : null;

      if (snap) {
        this.isLoadingCatalogue = Boolean(snap.loading);
        this.catalogueError = snap.lastError || '';
        this.hasCreds = Boolean(snap.credentials && snap.credentials.server && snap.credentials.username && snap.credentials.password);

        if (!this.customStreams) {
          this.categories = Array.isArray(snap.categories) ? snap.categories : [];
          this.streams = Array.isArray(snap.streams) ? snap.streams : [];
        }
        this.categoryMap = new Map(this.categories.map((c) => [String(c.category_id), c.category_name || 'En direct']));
        this.categoryCounts = new Map();
        for (const s of this.streams) {
          const cid = String(s.category_id);
          this.categoryCounts.set(cid, (this.categoryCounts.get(cid) || 0) + 1);
        }

        const dot = this.q('[data-sp="statusDot"]');
        const label = this.q('[data-sp="statusLabel"]');
        const foot = this.q('[data-sp="footSource"]');

        if (this.isLoadingCatalogue) {
          dot.classList.remove('sp-online');
          label.textContent = 'Synchronisation...';
        } else if (this.streams.length > 0) {
          dot.classList.add('sp-online');
          label.textContent = `${this.streams.length.toLocaleString('fr-FR')} chaînes`;
        } else if (this.catalogueError) {
          dot.classList.remove('sp-online');
          label.textContent = 'Erreur de connexion';
        } else {
          dot.classList.remove('sp-online');
          label.textContent = 'Aucune playlist';
        }

        if (foot) {
          const host = snap.credentials?.server ? snap.credentials.server.replace(/^https?:\/\//i, '') : 'StreamPulse · PremiumZone';
          foot.textContent = host;
        }
      }

      this.updateFavCounts();
      this.updateBouquetTriggerLabel();
      this.renderCategoryChips();
      this.recomputeFiltered();
      this.renderStandbyCard();
    }

    renderStandbyCard() {
      const card = this.q('[data-sp="standbyCard"]');
      if (!card) return;

      const installBtnHtml = this.deferredInstallPrompt
        ? `<button type="button" class="sp-btn sp-btn-soft sp-focusable" data-action="install-pwa">${ICONS.download}<span>Installer l’application</span></button>`
        : '';

      if (this.isLoadingCatalogue) {
        card.innerHTML = `
          <div class="sp-spinner"></div>
          <h2>Chargement de vos chaînes</h2>
          <p>Récupération des bouquets et du catalogue en direct auprès de votre fournisseur...</p>
        `;
        return;
      }

      if (this.catalogueError) {
        card.innerHTML = `
          <div class="sp-standby-emblem"><img src="/assets/pwa-icon-192.png" alt=""></div>
          <h2>Connexion impossible</h2>
          <p>${escapeHtml(this.catalogueError)}</p>
          <div class="sp-standby-actions">
            <button type="button" class="sp-btn sp-btn-primary sp-focusable" data-action="refresh-cat">${ICONS.refresh}<span>Réessayer</span></button>
            <button type="button" class="sp-btn sp-focusable" data-action="open-settings">${ICONS.settings}<span>Vérifier mes accès</span></button>
          </div>
        `;
        return;
      }

      if (!this.streams.length) {
        card.innerHTML = `
          <div class="sp-standby-emblem"><img src="/assets/pwa-icon-192.png" alt=""></div>
          <h2>Bienvenue sur StreamPulse</h2>
          <p>Connectez votre playlist IPTV en quelques secondes : scannez le QR Code depuis votre téléphone ou saisissez vos accès Xtream / M3U.</p>
          <div class="sp-standby-actions">
            <button type="button" class="sp-btn sp-btn-primary sp-focusable" data-action="open-qr">${ICONS.qr}<span>Associer par QR Code TV</span></button>
            <button type="button" class="sp-btn sp-focusable" data-action="open-settings">${ICONS.settings}<span>Saisir mes accès M3U / Xtream</span></button>
            ${installBtnHtml}
          </div>
        `;
        return;
      }

      const lastCh = this.lastSavedChannelId
        ? this.streams.find((c) => String(c.stream_id) === String(this.lastSavedChannelId) && !isSeparatorStream(c.name))
        : null;
      const ctaText = lastCh ? `Reprendre ${lastCh.name}` : 'Lancer le direct';

      card.innerHTML = `
        <div class="sp-standby-emblem"><img src="/assets/pwa-icon-192.png" alt=""></div>
        <h2>Prêt pour le direct</h2>
        <p>${this.streams.length.toLocaleString('fr-FR')} chaînes synchronisées dans ${this.categories.length.toLocaleString('fr-FR')} bouquets. Sélectionnez une chaîne dans la liste ou lancez la lecture immédiate.</p>
        <div class="sp-standby-actions">
          <button type="button" class="sp-btn sp-btn-primary sp-focusable" data-action="resume-last">${ICONS.play}<span style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(ctaText)}</span></button>
          ${installBtnHtml}
        </div>
      `;
    }

    playResumeOrFirst() {
      const lastCh = this.lastSavedChannelId
        ? this.streams.find((c) => String(c.stream_id) === String(this.lastSavedChannelId) && !isSeparatorStream(c.name))
        : null;
      if (lastCh) {
        const idx = this.filtered.findIndex((c) => String(c.stream_id) === String(lastCh.stream_id));
        if (idx >= 0) this.scrollChannelIntoView(idx);
        this.playChannel(lastCh, idx);
        return;
      }
      const firstIdx = this.filtered.findIndex((c) => !isSeparatorStream(c.name));
      if (firstIdx >= 0) {
        this.scrollChannelIntoView(firstIdx);
        this.playChannel(this.filtered[firstIdx], firstIdx);
      }
    }

    recomputeFiltered() {
      const q = this.searchQuery;
      const onlyFavs = this.activeTab === 'favs';
      const cat = this.selectedCat;

      this.filtered = this.streams.filter((item) => {
        if (onlyFavs && !this.favorites.has(String(item.stream_id))) return false;
        if (cat !== 'all' && String(item.category_id) !== cat) return false;
        if (q) {
          if (isSeparatorStream(item.name)) return false;
          if (!String(item.name || '').toLocaleLowerCase().includes(q)) return false;
        }
        return true;
      });

      if (this.currentChannel) {
        this.currentIndex = this.filtered.findIndex((c) => String(c.stream_id) === String(this.currentChannel.stream_id));
      }

      const listState = this.q('[data-sp="listState"]');
      const spacer = this.q('[data-sp="channelsSpacer"]');

      if (this.isLoadingCatalogue && !this.streams.length) {
        spacer.style.height = '0px';
        spacer.innerHTML = '';
        listState.classList.remove('sp-hidden');
        listState.innerHTML = `<div class="sp-spinner" style="width:28px;height:28px;border-width:2.5px"></div><span>Chargement du catalogue en cours...</span>`;
        return;
      }

      if (!this.filtered.length) {
        spacer.style.height = '0px';
        spacer.innerHTML = '';
        listState.classList.remove('sp-hidden');
        if (!this.streams.length) {
          listState.innerHTML = `
            <strong style="color:#fff">Aucune playlist connectée</strong>
            <span>Scannez un QR Code TV ou ajoutez votre lien Xtream / M3U pour afficher vos chaînes ici.</span>
          `;
        } else if (onlyFavs) {
          listState.innerHTML = `
            <strong style="color:#fff">Aucun favori enregistré</strong>
            <span>Cliquez sur l’étoile à droite d’une chaîne pour l’épingler ici.</span>
          `;
        } else {
          listState.innerHTML = `<span>Aucune chaîne ne correspond à votre recherche.</span>`;
        }
        return;
      }

      listState.classList.add('sp-hidden');
      this.renderVirtualChannels();
    }

    /**
     * True DOM Virtualization: mounts only ~18-22 visible rows even for 28,000+ channels.
     */
    renderVirtualChannels() {
      const viewport = this.q('[data-sp="channelsViewport"]');
      const spacer = this.q('[data-sp="channelsSpacer"]');
      if (!viewport || !spacer) return;

      const total = this.filtered.length;
      if (!total) {
        spacer.style.height = '0px';
        spacer.innerHTML = '';
        return;
      }

      const { start, end, totalHeight } = computeVirtualRange(
        total,
        viewport.scrollTop,
        viewport.clientHeight || 540,
        CHANNEL_ROW_HEIGHT,
        CHANNEL_OVERSCAN
      );

      spacer.style.height = `${totalHeight}px`;
      const activeId = this.currentChannel ? String(this.currentChannel.stream_id) : '';
      const rows = [];

      for (let i = start; i < end; i++) {
        const ch = this.filtered[i];
        const y = i * CHANNEL_ROW_HEIGHT;

        if (isSeparatorStream(ch.name)) {
          rows.push(`
            <div class="sp-ch-divider" style="transform:translate3d(0,${y}px,0)">
              <span>${escapeHtml(cleanSeparatorLabel(ch.name))}</span>
            </div>
          `);
          continue;
        }

        const idStr = String(ch.stream_id);
        const isCurrent = idStr === activeId;
        const isFocused = i === this.focusedVirtualIndex;
        const isFav = this.favorites.has(idStr);
        const catName = ch.category_name || this.categoryMap.get(String(ch.category_id)) || 'En direct';
        const qTag = inferQualityTag(ch.name);
        const hasHttpsLogo = ch.stream_icon && /^https:\/\//i.test(ch.stream_icon);
        const logoHtml = hasHttpsLogo
          ? `<img src="${escapeHtml(ch.stream_icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
          : escapeHtml(channelInitials(ch.name));

        rows.push(`
          <button type="button"
            class="sp-ch-row sp-focusable ${isCurrent ? 'sp-active' : ''} ${isFocused ? 'sp-dpad-focused' : ''}"
            data-sp-idx="${i}"
            style="transform:translate3d(0,${y}px,0)">
            <div class="sp-ch-main">
              <span class="sp-ch-num">${i + 1}</span>
              <div class="sp-ch-logo">${logoHtml}</div>
              <div class="sp-ch-info">
                <div class="sp-ch-title">${escapeHtml(ch.name || 'Chaîne ' + idStr)}</div>
                <div class="sp-ch-meta">
                  ${qTag ? `<span class="sp-ch-badge">${escapeHtml(qTag)}</span>` : ''}
                  <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(catName)}</span>
                </div>
              </div>
            </div>
            <div class="sp-ch-actions">
              ${isCurrent ? '<span class="sp-playing-bars" aria-label="En lecture"><i></i><i></i><i></i></span>' : ''}
              <span class="sp-fav-btn ${isFav ? 'sp-is-fav' : ''}" data-fav-id="${escapeHtml(idStr)}" title="Favori">
                ${isFav ? ICONS.starSolid : ICONS.star}
              </span>
            </div>
          </button>
        `);
      }

      spacer.innerHTML = rows.join('');
    }

    /**
     * Strict Smart TV Memory Cleanup: destroys HLS / Shaka / mpegts instances and flushes <video> buffer.
     */
    destroyPlayer() {
      this.sessionToken++;
      if (this.wasStreaming) {
        rootGlobal.ONDA_BRIDGE?.markLocalPlay?.();
        this.wasStreaming = false;
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (this.hls) {
        try {
          this.hls.stopLoad();
          this.hls.detachMedia();
          this.hls.destroy();
        } catch { /* ignore */ }
        this.hls = null;
      }
      if (this.shaka) {
        try {
          this.shaka.unload();
          this.shaka.destroy();
        } catch { /* ignore */ }
        this.shaka = null;
      }
      if (this.mpegts) {
        try {
          this.mpegts.pause();
          this.mpegts.unload();
          this.mpegts.detachMediaElement();
          this.mpegts.destroy();
        } catch { /* ignore */ }
        this.mpegts = null;
      }

      const video = this.q('[data-sp="video"]');
      if (video) {
        try {
          video.pause();
          video.removeAttribute('src');
          video.srcObject = null;
          while (video.firstChild) video.removeChild(video.firstChild);
          video.load();
        } catch { /* ignore */ }
      }
    }

    buildStreamUrl(channel, action = 'play') {
      if (channel.directUrl) return channel.directUrl;
      const bridge = rootGlobal.ONDA_BRIDGE;
      if (bridge && typeof bridge.buildStreamUrl === 'function') {
        return bridge.buildStreamUrl(action, channel.stream_id);
      }
      return '';
    }

    canAutoWaitZapping() {
      const bridge = rootGlobal.ONDA_BRIDGE;
      const cooling = bridge && typeof bridge.isOwnSessionCoolingDown === 'function' && bridge.isOwnSessionCoolingDown();
      return cooling && this.zapRetries < 4 && this.zapStartedAt > 0 && (Date.now() - this.zapStartedAt) < MAX_ZAP_WAIT_MS;
    }

    /**
     * Safe video.play() starter: if browser blocks unmuted play after async manifest redirect,
     * immediately plays muted so video ALWAYS renders and offers 1-tap unmute pill.
     */
    safeStartVideoPlayback(video, token) {
      if (!video || token !== this.sessionToken) return;
      video.muted = this.userMuted;
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (token !== this.sessionToken) return;
          video.muted = true;
          const pMuted = video.play();
          if (pMuted && typeof pMuted.then === 'function') {
            pMuted.then(() => {
              if (token === this.sessionToken && !this.userMuted) {
                this.q('[data-sp="unmutePill"]')?.classList.remove('sp-hidden');
              }
            }).catch(() => {
              if (token === this.sessionToken) {
                this.setBuffering(false);
                this.q('[data-sp="playBtn"]').innerHTML = ICONS.play;
                this.setStreamAlert('Appuyez sur le bouton Lecture pour démarrer le direct.');
              }
            });
          }
        });
      }
    }

    playChannel(channel, idx = -1) {
      if (!channel || isSeparatorStream(channel.name)) return;
      rootGlobal.ONDA_BRIDGE?.stopRootPlayback?.();

      this.destroyPlayer();
      const token = this.sessionToken;
      this.currentChannel = channel;
      this.currentIndex = idx >= 0 ? idx : this.filtered.findIndex((c) => String(c.stream_id) === String(channel.stream_id));
      if (this.currentIndex >= 0) this.focusedVirtualIndex = this.currentIndex;

      this.saveLastChannelId(channel.stream_id);
      this.retryAttempt = 0;
      this.zapRetries = 0;
      this.zapStartedAt = Date.now();
      this.mediaRecoveryCount = 0;
      this.abrSelection = -1;
      this.zapStartPerf = performance.now();
      this.detectedCodec = 'Auto ABR';

      // Transition UI from standby to active video stage
      this.mountEl.classList.add('sp-has-stream');
      this.q('[data-sp="standby"]').classList.add('sp-hidden');
      this.q('[data-sp="osdTop"]').classList.remove('sp-hidden');
      this.q('[data-sp="osdBottom"]').classList.remove('sp-hidden');
      this.q('[data-sp="unmutePill"]').classList.add('sp-hidden');

      const catName = channel.category_name || this.categoryMap.get(String(channel.category_id)) || 'Télévision en direct';
      this.q('[data-sp="osdTitle"]').textContent = channel.name || 'Chaîne';
      this.q('[data-sp="osdCat"]').textContent = catName;
      this.q('[data-sp="abrBtn"]').textContent = this.ecoMode ? 'Éco Données' : 'ABR Auto';
      this.updateCurrentFavButton();
      this.renderVirtualChannels();
      this.wakeOsd();
      this.setStreamAlert('');
      this.setBuffering(true, 'Connexion au direct...');

      // Prime <video> synchronously inside user gesture
      const video = this.q('[data-sp="video"]');
      if (video) {
        video.muted = this.userMuted;
      }

      const playUrl = this.buildStreamUrl(channel, 'play');
      if (!playUrl) {
        this.setBuffering(false);
        this.setStreamAlert('Connectez d’abord votre source IPTV (QR TV ou Ma Playlist).');
        return;
      }

      if (/\.mpd(?:\?|$)/i.test(playUrl)) {
        this.startDashShaka(channel, playUrl, token);
      } else if (this.protocol === 'ts' && !channel.directUrl) {
        this.startMpegTs(channel, token, false);
      } else {
        this.startAdaptiveHls(channel, token, this.protocol === 'auto');
      }
    }

    markStreamConnected() {
      if (this.zapStartPerf > 0) {
        const sec = ((performance.now() - this.zapStartPerf) / 1000).toFixed(2);
        this.lastZapSeconds = `${sec} s`;
        this.zapStartPerf = 0;
      }
      this.wasStreaming = true;
      rootGlobal.ONDA_BRIDGE?.markLocalPlay?.();
      this.setBuffering(false);
      this.setStreamAlert('');
      this.q('[data-sp="playBtn"]').innerHTML = ICONS.pause;
    }

    /**
     * Adaptive HLS Engine (hls.js) with ABR enabled & clean native + fatal exponential backoff.
     */
    startAdaptiveHls(channel, token, allowTsFallback) {
      if (token !== this.sessionToken) return;
      const video = this.q('[data-sp="video"]');
      const streamUrl = this.buildStreamUrl(channel, 'play');
      this.setDomIfChanged('statEngine', 'HLS ABR');

      video.addEventListener('playing', () => {
        if (token === this.sessionToken) this.markStreamConnected();
      }, { once: true });

      if (rootGlobal.Hls && rootGlobal.Hls.isSupported()) {
        const HlsClass = rootGlobal.Hls;
        const hasValidSize = video && video.clientWidth >= 320;
        const hls = new HlsClass({
          startLevel: -1, // Adaptive Bitrate (ABR) strictly active
          capLevelToPlayerSize: Boolean(hasValidSize),
          lowLatencyMode: false,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 8,
          backBufferLength: 10,
          maxBufferLength: this.ecoMode ? 12 : 16,
          maxMaxBufferLength: this.ecoMode ? 20 : 28,
          maxBufferHole: 0.8,
          highBufferWatchdogPeriod: 3,
          nudgeOffset: 0.2,
          nudgeMaxRetry: 5,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: allowTsFallback ? 1 : 3,
          manifestLoadingRetryDelay: 900,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 4,
          levelLoadingRetryDelay: 900,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetry: 6,
          fragLoadingRetryDelay: 1000,
          fragLoadingMaxRetryTimeout: 16000
        });
        this.hls = hls;
        let manifestReady = false;

        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(HlsClass.Events.LEVEL_LOADED, () => {
          if (token === this.sessionToken) {
            this.wasStreaming = true;
            rootGlobal.ONDA_BRIDGE?.markLocalPlay?.();
          }
        });

        hls.on(HlsClass.Events.MANIFEST_PARSED, (_ev, data) => {
          if (token !== this.sessionToken) return;
          manifestReady = true;
          this.wasStreaming = true;
          rootGlobal.ONDA_BRIDGE?.markLocalPlay?.();
          if (data && Array.isArray(data.levels) && data.levels.length) {
            const best = data.levels[data.levels.length - 1];
            if (best && best.videoCodec) this.detectedCodec = best.videoCodec.toUpperCase();
            if (this.ecoMode && data.levels.length > 1) {
              const idx720 = data.levels.findIndex((l) => l.height && l.height <= 720);
              if (idx720 >= 0) hls.autoLevelCapping = idx720;
            }
          }
          this.safeStartVideoPlayback(video, token);
        });

        hls.on(HlsClass.Events.FRAG_BUFFERED, () => {
          if (token === this.sessionToken) {
            this.retryAttempt = 0;
            this.wasStreaming = true;
            rootGlobal.ONDA_BRIDGE?.markLocalPlay?.();
          }
        });

        hls.on(HlsClass.Events.FRAG_LOADED, (_ev, data) => {
          if (token !== this.sessionToken) return;
          const stats = data && data.frag && data.frag.stats;
          if (stats && stats.loading) {
            this.measuredPingMs = Math.max(1, Math.round((stats.loading.first || stats.loading.end) - stats.loading.start));
            const loadDurSec = Math.max(0.05, (stats.loading.end - stats.loading.start) / 1000);
            const mbps = ((stats.total || 0) * 8) / (loadDurSec * 1e6);
            if (Number.isFinite(mbps) && mbps > 0) {
              this.measuredMbps = this.measuredMbps ? this.measuredMbps * 0.65 + mbps * 0.35 : mbps;
            }
          }
          if (hls.bandwidthEstimate && Number.isFinite(hls.bandwidthEstimate)) {
            this.measuredMbps = hls.bandwidthEstimate / 1e6;
          }
        });

        hls.on(HlsClass.Events.ERROR, (_ev, data) => {
          // Non-fatal segment 404s/timeouts are retried silently by hls.js's internal backoff without aborting active transfers
          if (token !== this.sessionToken || !data || !data.fatal) return;

          const httpCode = data.response && data.response.code;

          // Recover fatal media decode errors seamlessly
          if (manifestReady && data.type === HlsClass.ErrorTypes.MEDIA_ERROR) {
            this.mediaRecoveryCount++;
            if (this.mediaRecoveryCount === 2 && typeof hls.swapAudioCodec === 'function') {
              hls.swapAudioCodec();
            }
            hls.recoverMediaError();
            return;
          }

          // Recover transient mid-stream network drops with exponential backoff
          if (manifestReady && data.type === HlsClass.ErrorTypes.NETWORK_ERROR && this.retryAttempt < MAX_AUTO_RETRIES) {
            this.scheduleExponentialRecovery(token, () => {
              if (this.hls === hls) hls.startLoad();
            }, false);
            return;
          }

          // Switch to live MPEG-TS ONLY when api/iptv.js explicitly signals 415 MPEGTS_DIRECT
          if (allowTsFallback && httpCode === 415 && !channel.directUrl && rootGlobal.mpegts && rootGlobal.mpegts.isSupported()) {
            this.destroyPlayer();
            this.sessionToken = token;
            this.startMpegTs(channel, token, true);
            return;
          }

          // Single-connection Xtream zapping contention (429 MAX_CONNECTIONS)
          if (httpCode === 429) {
            this.destroyPlayer();
            this.sessionToken = token;
            if (this.canAutoWaitZapping()) {
              this.zapRetries++;
              this.setBuffering(true, 'Libération du flux précédent en cours...');
              this.retryTimer = setTimeout(() => {
                if (token === this.sessionToken) this.startAdaptiveHls(channel, token, allowTsFallback);
              }, 4500);
              return;
            }
            this.setBuffering(false);
            this.setStreamAlert('Limite de connexions atteinte (1/1) : arrêtez la lecture ouverte sur votre autre appareil puis réessayez.', true);
            return;
          }

          if (httpCode === 403) {
            this.destroyPlayer();
            this.setBuffering(false);
            this.setStreamAlert('Accès refusé par le fournisseur IPTV (abonnement expiré ou identifiants invalides).', true);
            return;
          }

          // Exponential backoff silent reload for initial 502 / 404 / timeout
          this.scheduleExponentialRecovery(token, () => {
            this.destroyPlayer();
            this.sessionToken = token;
            this.startAdaptiveHls(channel, token, allowTsFallback);
          }, true);
        });
        return;
      }

      // Native HLS fallback (iOS Safari / Apple WebKit)
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.addEventListener('error', () => {
          if (token !== this.sessionToken) return;
          if (this.canAutoWaitZapping()) {
            this.zapRetries++;
            this.setBuffering(true, 'Libération du flux précédent...');
            this.retryTimer = setTimeout(() => {
              if (token === this.sessionToken) this.startAdaptiveHls(channel, token, allowTsFallback);
            }, 4500);
            return;
          }
          this.scheduleExponentialRecovery(token, () => {
            video.src = this.buildStreamUrl(channel, 'play');
            this.safeStartVideoPlayback(video, token);
          }, true);
        }, { once: true });

        video.src = streamUrl;
        this.safeStartVideoPlayback(video, token);
        return;
      }

      if (allowTsFallback && rootGlobal.mpegts && rootGlobal.mpegts.isSupported()) {
        this.startMpegTs(channel, token, true);
      } else {
        this.setBuffering(false);
        this.setStreamAlert('Ce navigateur ne prend pas en charge la lecture vidéo HLS.', true);
      }
    }

    /**
     * MPEG-DASH Engine (Shaka Player) with ABR strictly enabled for .mpd streams.
     */
    async startDashShaka(channel, streamUrl, token) {
      if (token !== this.sessionToken) return;
      const video = this.q('[data-sp="video"]');
      this.setDomIfChanged('statEngine', 'Shaka DASH ABR');

      if (!rootGlobal.shaka || !rootGlobal.shaka.Player) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '/assets/shaka-player.compiled.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
          });
        } catch {
          this.setBuffering(false);
          this.setStreamAlert('Impossible de charger le moteur MPEG-DASH Shaka Player.', true);
          return;
        }
      }
      if (token !== this.sessionToken) return;

      try {
        rootGlobal.shaka.polyfill.installAll();
        const player = new rootGlobal.shaka.Player(video);
        this.shaka = player;
        player.configure({
          abr: { enabled: true },
          streaming: { bufferingGoal: 40, rebufferingGoal: 4, retryParameters: { maxAttempts: 5, baseDelay: 1000, backoffFactor: 2 } }
        });
        player.addEventListener('error', () => {
          if (token !== this.sessionToken) return;
          this.scheduleExponentialRecovery(token, () => this.playChannel(channel, this.currentIndex), true);
        });
        await player.load(streamUrl);
        if (token === this.sessionToken) {
          this.markStreamConnected();
          this.safeStartVideoPlayback(video, token);
        }
      } catch {
        if (token === this.sessionToken) {
          this.scheduleExponentialRecovery(token, () => this.playChannel(channel, this.currentIndex), true);
        }
      }
    }

    /**
     * Live MPEG-TS (.ts) Engine with deep anti-cut buffer & single-connection zapping support.
     */
    startMpegTs(channel, token, fromAutoFallback) {
      if (token !== this.sessionToken) return;
      if (!rootGlobal.mpegts || !rootGlobal.mpegts.isSupported()) {
        this.setBuffering(false);
        this.setStreamAlert('Flux MPEG-TS non pris en charge sur ce navigateur (essayez le format HLS).', true);
        return;
      }

      const tsUrl = this.buildStreamUrl(channel, 'ts');
      const video = this.q('[data-sp="video"]');
      this.setDomIfChanged('statEngine', 'MPEG-TS Direct');
      this.setBuffering(true, fromAutoFallback ? 'Passage en flux direct MPEG-TS...' : 'Connexion MPEG-TS...');

      const player = rootGlobal.mpegts.createPlayer(
        { type: 'mpegts', isLive: true, cors: true, url: tsUrl },
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
      this.mpegts = player;
      let hasPlayed = false;

      video.addEventListener('playing', () => {
        if (token === this.sessionToken) {
          hasPlayed = true;
          this.retryAttempt = 0;
          this.markStreamConnected();
        }
      }, { once: true });

      player.on(rootGlobal.mpegts.Events.STATISTICS_INFO, (info) => {
        if (token === this.sessionToken && info && info.speed) {
          this.measuredMbps = (info.speed * 8) / 1000;
          rootGlobal.ONDA_BRIDGE?.markLocalPlay?.();
        }
      });

      player.on(rootGlobal.mpegts.Events.ERROR, (_t, _d, info) => {
        if (token !== this.sessionToken) return;
        const code = info && info.code;
        if (code === 429) {
          this.destroyPlayer();
          this.sessionToken = token;
          if (this.canAutoWaitZapping()) {
            this.zapRetries++;
            this.setBuffering(true, 'Libération du flux précédent en cours...');
            this.retryTimer = setTimeout(() => {
              if (token === this.sessionToken) this.startMpegTs(channel, token, fromAutoFallback);
            }, 4500);
            return;
          }
          this.setBuffering(false);
          this.setStreamAlert('Limite de connexions atteinte (1/1) sur ce compte IPTV.', true);
          return;
        }
        if (code === 403) {
          this.destroyPlayer();
          this.setBuffering(false);
          this.setStreamAlert('Identifiants refusés ou abonnement expiré.', true);
          return;
        }
        if (hasPlayed || this.retryAttempt < 3) {
          this.scheduleExponentialRecovery(token, () => {
            this.destroyPlayer();
            this.sessionToken = token;
            this.startMpegTs(channel, token, fromAutoFallback);
          }, true);
        } else {
          this.setBuffering(false);
          this.setStreamAlert('Cette chaîne est actuellement hors antenne chez le fournisseur.', true);
        }
      });

      player.attachMediaElement(video);
      player.load();
      this.safeStartVideoPlayback(video, token);
    }

    /**
     * Exponential-Backoff Auto-Recovery (1s -> 2s -> 4s -> 8s -> 16s).
     */
    scheduleExponentialRecovery(token, actionFn, showStatus = false) {
      if (token !== this.sessionToken) return;
      if (this.retryTimer) clearTimeout(this.retryTimer);

      if (this.retryAttempt >= MAX_AUTO_RETRIES) {
        this.setBuffering(false);
        this.setStreamAlert('Cette chaîne semble hors antenne ou indisponible chez votre fournisseur (essayez une autre chaîne ou le mode MPEG-TS).', true);
        return;
      }

      const jitter = Math.floor(Math.random() * 250);
      const delay = computeBackoffMs(this.retryAttempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS, jitter);
      this.retryAttempt++;

      if (showStatus) {
        this.setBuffering(true, `Reconnexion automatique (${this.retryAttempt}/${MAX_AUTO_RETRIES})...`);
      }

      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (token === this.sessionToken) actionFn();
      }, delay);
    }

    setBuffering(visible, text = 'Ouverture du direct...') {
      const box = this.q('[data-sp="buffering"]');
      const lbl = this.q('[data-sp="bufferingLabel"]');
      if (!box) return;
      box.classList.toggle('sp-hidden', !visible);
      if (lbl && text) lbl.textContent = text;
    }

    setStreamAlert(message, withRetry = false) {
      const box = this.q('[data-sp="streamAlert"]');
      if (!box) return;
      if (!message) {
        box.classList.add('sp-hidden');
        box.innerHTML = '';
        return;
      }
      box.classList.remove('sp-hidden');
      box.innerHTML = `
        <span style="flex:1">${escapeHtml(message)}</span>
        ${withRetry ? `<button type="button" class="sp-btn sp-btn-primary" data-sp-retry="1">${ICONS.refresh}<span>Réessayer</span></button>` : ''}
      `;
      const btn = box.querySelector('[data-sp-retry]');
      if (btn) {
        btn.onclick = () => {
          if (this.currentChannel) this.playChannel(this.currentChannel, this.currentIndex);
        };
      }
    }

    /**
     * 60 FPS requestAnimationFrame Telemetry Loop (Zero setInterval).
     */
    startTelemetryLoop() {
      if (this.rafId) return;
      this.lastFrameTs = performance.now();

      const tick = (now) => {
        if (!this.isOpen || document.hidden) {
          this.rafId = 0;
          return;
        }
        const dt = now - this.lastFrameTs;
        this.lastFrameTs = now;
        if (dt > 0 && dt < 250) {
          this.fpsSamples.push(1000 / dt);
          if (this.fpsSamples.length > 30) this.fpsSamples.shift();
        }

        if (now - this.lastTelemetryCommitTs >= 300) {
          this.lastTelemetryCommitTs = now;
          if (this.isStatsOpen) this.commitTelemetryDom();
        }

        this.rafId = requestAnimationFrame(tick);
      };

      this.rafId = requestAnimationFrame(tick);
    }

    stopTelemetryLoop() {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
    }

    commitTelemetryDom() {
      const video = this.q('[data-sp="video"]');
      if (!video) return;

      let bufAhead = 0;
      if (video.buffered && video.buffered.length > 0) {
        bufAhead = Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime);
      }
      this.setDomIfChanged('statBuffer', `${bufAhead.toFixed(1)} s`);
      this.setDomIfChanged('statBitrate', this.measuredMbps > 0 ? `${this.measuredMbps.toFixed(1)} Mbps` : 'Auto');
      this.setDomIfChanged('statPing', this.measuredPingMs > 0 ? `${this.measuredPingMs} ms` : 'Direct');

      const avgFps = this.fpsSamples.length
        ? Math.min(120, Math.round(this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length))
        : 60;
      this.setDomIfChanged('statFps', `${avgFps} fps`);

      if (video.videoHeight > 0) {
        this.setDomIfChanged('statRes', `${video.videoWidth}×${video.videoHeight}`);
      } else {
        this.setDomIfChanged('statRes', this.detectedCodec);
      }
      this.setDomIfChanged('statZap', this.lastZapSeconds);
    }

    setDomIfChanged(key, val) {
      if (this.renderedTelemetry[key] === val) return;
      this.renderedTelemetry[key] = val;
      const el = this.q(`[data-sp="${key}"]`);
      if (el) el.textContent = val;
    }

    updateProtocolButtons() {
      this.mountEl.querySelectorAll('[data-proto]').forEach((btn) => {
        btn.classList.toggle('sp-active', btn.getAttribute('data-proto') === this.protocol);
      });
    }

    updateCurrentFavButton() {
      const btn = this.q('[data-sp="favCurrentBtn"]');
      if (!btn || !this.currentChannel) return;
      const isFav = this.favorites.has(String(this.currentChannel.stream_id));
      btn.innerHTML = isFav ? ICONS.starSolid : ICONS.star;
      btn.classList.toggle('sp-active', isFav);
    }

    stepChannel(delta) {
      if (!this.filtered.length) return;
      const len = this.filtered.length;
      let idx = this.currentIndex >= 0 ? this.currentIndex : 0;
      for (let step = 0; step < len; step++) {
        idx = (idx + delta + len) % len;
        if (!isSeparatorStream(this.filtered[idx].name)) {
          this.scrollChannelIntoView(idx);
          this.playChannel(this.filtered[idx], idx);
          return;
        }
      }
    }

    scrollChannelIntoView(idx) {
      const viewport = this.q('[data-sp="channelsViewport"]');
      if (!viewport) return;
      const top = idx * CHANNEL_ROW_HEIGHT;
      const viewH = viewport.clientHeight || 480;
      if (top < viewport.scrollTop) {
        viewport.scrollTop = top;
      } else if (top + CHANNEL_ROW_HEIGHT > viewport.scrollTop + viewH) {
        viewport.scrollTop = top - viewH + CHANNEL_ROW_HEIGHT;
      }
      this.renderVirtualChannels();
    }

    togglePlayPause() {
      const video = this.q('[data-sp="video"]');
      if (!video || !this.currentChannel) return;
      if (video.paused) {
        this.safeStartVideoPlayback(video, this.sessionToken);
        this.q('[data-sp="playBtn"]').innerHTML = ICONS.pause;
      } else {
        video.pause();
        this.q('[data-sp="playBtn"]').innerHTML = ICONS.play;
      }
      this.wakeOsd();
    }

    toggleMute() {
      const video = this.q('[data-sp="video"]');
      if (!video) return;
      this.userMuted = !video.muted;
      video.muted = this.userMuted;
      if (!this.userMuted) {
        this.q('[data-sp="unmutePill"]')?.classList.add('sp-hidden');
      }
      this.syncMuteIcon();
    }

    syncMuteIcon() {
      const video = this.q('[data-sp="video"]');
      const btn = this.q('[data-sp="muteBtn"]');
      if (!video || !btn) return;
      btn.innerHTML = video.muted ? ICONS.mute : ICONS.volume;
    }

    cycleAbrQuality() {
      if (!this.hls || !Array.isArray(this.hls.levels) || this.hls.levels.length <= 1) {
        this.ecoMode = !this.ecoMode;
        try { localStorage.setItem(ECO_STORAGE_KEY, this.ecoMode ? '1' : '0'); } catch { /* ignore */ }
        const ecoLabel = this.ecoMode ? 'Éco Données' : 'ABR Auto';
        this.q('[data-sp="abrBtn"]').textContent = ecoLabel;
        this.showToast(this.ecoMode ? 'Mode Éco Données actif (tampon réduit)' : 'Mode ABR Auto standard');
        return;
      }
      const levels = this.hls.levels;
      this.abrSelection = this.abrSelection >= levels.length - 1 ? -1 : this.abrSelection + 1;
      this.hls.currentLevel = this.abrSelection;
      const label = this.abrSelection === -1
        ? (this.ecoMode ? 'Éco Données' : 'ABR Auto')
        : `${levels[this.abrSelection].height || this.abrSelection + 1}p`;
      this.q('[data-sp="abrBtn"]').textContent = label;
      this.showToast(`Qualité vidéo : ${label}`);
    }

    toggleFullscreen() {
      const stage = this.q('[data-sp="stage"]');
      const video = this.q('[data-sp="video"]');
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      } else if (stage && stage.requestFullscreen) {
        stage.requestFullscreen().catch(() => {});
      } else if (video && video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    }

    toggleOsd() {
      if (this.mountEl.classList.contains('sp-osd-idle')) {
        this.wakeOsd();
      } else {
        this.mountEl.classList.add('sp-osd-idle');
      }
    }

    wakeOsd() {
      this.mountEl.classList.remove('sp-osd-idle');
      if (this.osdTimer) clearTimeout(this.osdTimer);
      this.osdTimer = setTimeout(() => {
        const video = this.q('[data-sp="video"]');
        if (this.currentChannel && video && !video.paused && !this.isStatsOpen) {
          this.mountEl.classList.add('sp-osd-idle');
        }
      }, 3400);
    }

    showToast(text) {
      const toast = this.q('[data-sp="toast"]');
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add('sp-show');
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => toast.classList.remove('sp-show'), 1800);
    }

    importRawM3u() {
      const rawText = this.q('[data-sp="inpRawM3u"]').value.trim();
      const parsed = parseM3uPlaylist(rawText);
      if (!parsed.length) {
        this.showToast('Aucun flux valide détecté dans ce texte #EXTM3U');
        return;
      }
      this.customStreams = parsed;
      this.streams = parsed;
      const groups = [...new Set(parsed.map((p) => p.category_name))];
      this.categories = groups.map((g) => ({ category_id: g, category_name: g }));
      this.categoryMap = new Map(groups.map((g) => [g, g]));
      this.categoryCounts = new Map();
      for (const p of parsed) {
        this.categoryCounts.set(p.category_name, (this.categoryCounts.get(p.category_name) || 0) + 1);
      }
      this.selectedCat = 'all';
      this.q('[data-sp="rawM3uModal"]').classList.add('sp-hidden');
      this.q('[data-sp="statusDot"]').classList.add('sp-online');
      this.q('[data-sp="statusLabel"]').textContent = `${parsed.length} flux M3U`;
      this.updateBouquetTriggerLabel();
      this.renderCategoryChips();
      this.recomputeFiltered();
      this.renderStandbyCard();
      this.playChannel(this.filtered[0], 0);
      this.showToast(`${parsed.length} flux chargés`);
    }

    onKeyDown(ev) {
      if (!this.isOpen) return;
      if (rootGlobal.ONDA_BRIDGE?.hasActiveRootModal?.()) return;

      const helpOpen = !this.q('[data-sp="helpModal"]').classList.contains('sp-hidden');
      const m3uOpen = !this.q('[data-sp="rawM3uModal"]').classList.contains('sp-hidden');

      if (ev.key === 'Escape') {
        if (helpOpen) {
          ev.preventDefault();
          this.q('[data-sp="helpModal"]').classList.add('sp-hidden');
        } else if (m3uOpen) {
          ev.preventDefault();
          this.q('[data-sp="rawM3uModal"]').classList.add('sp-hidden');
        } else if (this.isBouquetDrawerOpen) {
          ev.preventDefault();
          this.toggleBouquetDrawer();
        }
        return;
      }

      const tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || helpOpen || m3uOpen) return;

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) {
        this.mountEl.setAttribute('data-input', 'dpad');
        this.wakeOsd();
      }

      if (ev.key === ' ') {
        ev.preventDefault();
        this.togglePlayPause();
        return;
      }
      if (ev.key === 'f' || ev.key === 'F') {
        ev.preventDefault();
        this.toggleFullscreen();
        return;
      }
      if (ev.key === 't' || ev.key === 'T') {
        ev.preventDefault();
        this.handleAction('toggle-theater');
        return;
      }
      if (ev.key === '/' && this.q('[data-sp="searchInput"]')) {
        ev.preventDefault();
        this.q('[data-sp="searchInput"]').focus();
        return;
      }

      if (ev.key === 'ArrowDown' && this.filtered.length) {
        ev.preventDefault();
        for (let step = 0; step < this.filtered.length; step++) {
          this.focusedVirtualIndex = (this.focusedVirtualIndex + 1) % this.filtered.length;
          if (!isSeparatorStream(this.filtered[this.focusedVirtualIndex].name)) break;
        }
        this.scrollChannelIntoView(this.focusedVirtualIndex);
        return;
      }
      if (ev.key === 'ArrowUp' && this.filtered.length) {
        ev.preventDefault();
        for (let step = 0; step < this.filtered.length; step++) {
          this.focusedVirtualIndex = (this.focusedVirtualIndex - 1 + this.filtered.length) % this.filtered.length;
          if (!isSeparatorStream(this.filtered[this.focusedVirtualIndex].name)) break;
        }
        this.scrollChannelIntoView(this.focusedVirtualIndex);
        return;
      }
      if (ev.key === 'ArrowRight' && this.currentChannel) {
        ev.preventDefault();
        this.stepChannel(1);
        return;
      }
      if (ev.key === 'ArrowLeft' && this.currentChannel) {
        ev.preventDefault();
        this.stepChannel(-1);
        return;
      }
      if (ev.key === 'Enter' && this.filtered[this.focusedVirtualIndex]) {
        const active = document.activeElement;
        if (active && active !== document.body && !active.hasAttribute('data-sp-idx')) {
          return;
        }
        ev.preventDefault();
        this.playChannel(this.filtered[this.focusedVirtualIndex], this.focusedVirtualIndex);
      }
    }

    open(initialChannel = null) {
      this.mount();
      this.isOpen = true;
      this.mountEl.hidden = false;
      this.mountEl.setAttribute('aria-hidden', 'false');
      this.syncFromBridge();
      this.startTelemetryLoop();
      if (initialChannel) {
        const idx = this.filtered.findIndex((c) => String(c.stream_id) === String(initialChannel.stream_id));
        if (idx >= 0) this.scrollChannelIntoView(idx);
        this.playChannel(initialChannel, idx);
      }
    }

    close() {
      // Unified single-interface mode: keep UI mounted, simply stop active video if requested
      this.destroyPlayer();
    }
  }

  // Auto-boot unified StreamPulse interface & register safe PWA Service Worker
  if (typeof document !== 'undefined') {
    const boot = () => {
      const container = document.getElementById('streampulse-module');
      if (!container) return;
      const instance = new StreamPulseController(container);
      instance.mount();
      rootGlobal.StreamPulse = {
        open: (ch) => instance.open(ch),
        close: () => instance.close(),
        isOpen: () => instance.isOpen,
        instance
      };

      if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      computeVirtualRange,
      computeBackoffMs,
      parseM3uPlaylist,
      isSeparatorStream,
      StreamPulseController
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
