/* ==========================================================================
   StreamPulse — Isolated Smart TV & Android Web Player Module (#streampulse-module)
   - Zero root file overwrite, scoped exclusively inside #streampulse-module
   - Adaptive Video Engine: hls.js (ABR enabled) + Shaka DASH + mpegts.js fallback
   - Strict Smart TV memory teardown on every zap (destroy + video buffer flush)
   - Silent exponential-backoff auto-recovery on 404 / timeout / network errors
   - True DOM Virtualization for 28,000+ channels & EPG guide
   - 60 FPS requestAnimationFrame telemetry loop (zero setInterval)
   - Passive touch listeners ({ passive: true }) for instant Android Web scrolling
   ========================================================================== */
(function (rootGlobal) {
  'use strict';

  const CHANNEL_ROW_HEIGHT = 68;
  const CHANNEL_OVERSCAN = 6;
  const EPG_ROW_HEIGHT = 44;
  const EPG_OVERSCAN = 4;
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_MAX_MS = 16000;
  const MAX_AUTO_RETRIES = 6;
  const FAV_STORAGE_KEY = 'sp-favorites-v1';

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
   * Lightweight M3U playlist parser for direct M3U content pasted/fetched by user.
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

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inferQualityTag(name) {
    const s = String(name || '').toUpperCase();
    if (/\b8K\b/.test(s)) return '8K UHD';
    if (/\b(4K|UHD|2160P)\b/.test(s)) return '4K UHD';
    if (/\b(FHD|1080P)\b/.test(s)) return 'FHD 1080p';
    if (/\b(HD|720P)\b/.test(s)) return 'HD 720p';
    if (/\bHEVC\b/.test(s)) return 'HEVC';
    return 'LIVE ABR';
  }

  function channelInitials(name) {
    const clean = String(name || 'TV').replace(/[^\p{L}\p{N} ]/gu, '').trim();
    return (clean.slice(0, 2) || 'TV').toUpperCase();
  }

  function formatClock(dateObj) {
    const h = String(dateObj.getHours()).padStart(2, '0');
    const m = String(dateObj.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  class StreamPulseController {
    constructor(mountEl) {
      this.mountEl = mountEl;
      this.mounted = false;
      this.isOpen = false;
      this.deviceMode = 'tv';
      this.activeSection = 'live'; // 'live' | 'favs'
      this.selectedCat = 'all';
      this.searchQuery = '';

      this.categories = [];
      this.categoryMap = new Map();
      this.streams = [];
      this.customStreams = null;
      this.filtered = [];
      this.favorites = this.readFavorites();

      this.currentChannel = null;
      this.currentIndex = -1;
      this.focusedVirtualIndex = 0;

      // Video engines
      this.hls = null;
      this.shaka = null;
      this.mpegts = null;
      this.sessionToken = 0;
      this.retryAttempt = 0;
      this.mediaRecoveryCount = 0;
      this.retryTimer = null;
      this.zapStartPerf = 0;
      this.lastZapSeconds = '--';
      this.abrSelection = -1; // -1 = Auto ABR

      // UI state
      this.isQuadView = false;
      this.isEpgOpen = false;
      this.isOsdVisible = true;
      this.osdTimer = null;
      this.toastTimer = null;
      this.virtualRafPending = false;
      this.epgRafPending = false;

      // rAF Telemetry state (zero setInterval)
      this.rafId = 0;
      this.lastFrameTs = 0;
      this.fpsSamples = [];
      this.lastTelemetryCommitTs = 0;
      this.measuredMbps = 0;
      this.measuredPingMs = 0;
      this.detectedCodec = 'Auto ABR';
      this.detectedRes = '';
      this.renderedTelemetry = {};

      // Touch swipe state (Android passive touch)
      this.touchStartX = 0;
      this.touchStartY = 0;
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

    toggleFavorite(streamId, ev) {
      if (ev) ev.stopPropagation();
      const key = String(streamId);
      if (this.favorites.has(key)) {
        this.favorites.delete(key);
        this.showToast('Retiré des favoris');
      } else {
        this.favorites.add(key);
        this.showToast('★ Ajouté aux favoris');
      }
      this.saveFavorites();
      this.recomputeFiltered();
    }

    q(sel) {
      return this.mountEl ? this.mountEl.querySelector(sel) : null;
    }

    mount() {
      if (this.mounted || !this.mountEl) return;
      this.mounted = true;
      this.mountEl.innerHTML = this.template();
      this.bindEvents();
      this.syncFromBridge();

      if (typeof window !== 'undefined' && window.innerWidth <= 820) {
        this.setDeviceMode('android', true);
      } else {
        this.setDeviceMode('tv', true);
      }
    }

    template() {
      return `
      <!-- 1. TOPBAR UNIFIÉE -->
      <header class="sp-topbar">
        <div class="sp-brand-wrap">
          <div class="sp-brand-badge">
            <div class="sp-brand-badge-inner">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </div>
          </div>
          <div>
            <div class="sp-brand-title-row">
              <span class="sp-brand-name">Stream<span class="sp-brand-gradient">Pulse</span></span>
              <span class="sp-engine-tag" data-sp="engineTag">HLS ABR Engine</span>
            </div>
            <p class="sp-brand-sub">Module IPTV isolé · Smart TV D-Pad &amp; Android Web · by PremiumZone</p>
          </div>
        </div>

        <!-- Télémétrie 60 FPS (requestAnimationFrame) -->
        <div class="sp-telemetry-bar" aria-label="Télémétrie du flux en direct">
          <div class="sp-telemetry-pill">
            <span class="sp-dot-live"></span>
            <span>Buffer:</span>
            <span class="sp-val-emerald" data-sp="telBuffer">0.0s</span>
          </div>
          <div class="sp-telemetry-pill">
            <span>Débit:</span>
            <span class="sp-val-cyan" data-sp="telBitrate">-- Mbps</span>
          </div>
          <div class="sp-telemetry-pill">
            <span>Ping:</span>
            <span class="sp-val-cyan" data-sp="telPing">-- ms</span>
          </div>
          <div class="sp-telemetry-pill">
            <span>FPS:</span>
            <span class="sp-val-purple" data-sp="telFps">60</span>
          </div>
        </div>

        <div class="sp-top-tools">
          <button type="button" class="sp-btn-cyan-soft sp-tv-focusable sp-touch-ripple" data-action="open-qr" title="Associer cette TV par QR Code chiffré">
            <span>⊞</span> <span class="sp-hide-sm">QR TV</span>
          </button>
          <button type="button" class="sp-btn-cyan-soft sp-tv-focusable sp-touch-ripple" data-action="open-source" title="Importer M3U ou configurer Xtream">
            <span>⚡</span> <span class="sp-hide-sm">Sources M3U</span>
          </button>

          <div class="sp-mode-switch" role="group" aria-label="Mode d'interface">
            <button type="button" class="sp-mode-option sp-active sp-tv-focusable" data-action="mode-tv">Smart TV</button>
            <button type="button" class="sp-mode-option sp-tv-focusable" data-action="mode-android">Android</button>
          </div>

          <button type="button" class="sp-icon-btn sp-tv-focusable" data-action="open-help" title="Raccourcis Télécommande D-Pad">?</button>
          <button type="button" class="sp-icon-btn sp-tv-focusable" data-action="close-module" title="Retourner à l'accueil ONDA">✕</button>
        </div>
      </header>

      <!-- 2. CORPS PRINCIPAL (RAIL + LISTE VIRTUALISÉE + SCÈNE VIDÉO) -->
      <div class="sp-body">
        <aside class="sp-sidebar" aria-label="Navigation StreamPulse">
          <nav class="sp-sidebar-nav">
            <button type="button" class="sp-rail-btn sp-active sp-tv-focusable" data-action="nav-live" title="Toutes les chaînes en Direct">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>
            </button>
            <button type="button" class="sp-rail-btn sp-tv-focusable" data-action="nav-favs" title="Mes Chaînes Favorites">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
            <button type="button" class="sp-rail-btn sp-tv-focusable" data-action="toggle-epg" title="Guide TV (EPG virtualisé)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            </button>
            <button type="button" class="sp-rail-btn sp-tv-focusable" data-action="toggle-quad" title="Mosaïque Multi-Écrans 4x">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            </button>
            <button type="button" class="sp-rail-btn sp-tv-focusable" data-action="open-source" title="Sources IPTV / Xtream">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
          </nav>
          <div class="sp-sidebar-foot">
            <span class="sp-dot-live"></span>
            <span data-sp="netBadge">ABR OK</span>
          </div>
        </aside>

        <!-- Colonne des chaînes (Virtual Scrolling DOM) -->
        <section class="sp-channel-panel" data-sp="channelPanel">
          <div class="sp-panel-header">
            <div class="sp-search-wrap">
              <svg class="sp-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              <input type="search" class="sp-search-input sp-tv-focusable" data-sp="searchInput" placeholder="Rechercher parmi les chaînes..." autocomplete="off" spellcheck="false">
              <button type="button" class="sp-search-clear" data-action="clear-search" title="Effacer la recherche">✕</button>
            </div>
            <div class="sp-cat-bar sp-no-scrollbar" data-sp="categoryBar"></div>
          </div>

          <div class="sp-virtual-viewport sp-custom-scroll" data-sp="channelsViewport">
            <div class="sp-virtual-spacer" data-sp="channelsSpacer"></div>
            <div class="sp-empty-state sp-hidden" data-sp="emptyState"></div>
          </div>

          <div class="sp-panel-footer">
            <div class="sp-panel-source">
              <span style="color:var(--sp-cyan)">●</span>
              <span data-sp="sourceLabel">Aucune source connectée</span>
            </div>
            <span style="color:var(--sp-emerald);font-family:var(--sp-font-mono);font-size:10px" data-sp="countLabel">0 chaîne</span>
          </div>
        </section>

        <!-- Scène Vidéo Principale -->
        <main class="sp-stage" data-sp="stage">
          <div class="sp-video-wrap" data-sp="videoWrap">
            <video class="sp-video" data-sp="video" playsinline preload="none"></video>

            <!-- Mosaïque Rapide Quad-View 4x -->
            <div class="sp-quad-grid sp-hidden" data-sp="quadGrid"></div>

            <!-- OSD Supérieur -->
            <div class="sp-osd-top" data-sp="osdTop">
              <div class="sp-osd-left">
                <div class="sp-osd-icon" data-sp="osdIcon">TV</div>
                <div>
                  <div class="sp-osd-badges">
                    <span class="sp-live-badge"><i></i> DIRECT</span>
                    <h2 class="sp-osd-title" data-sp="osdTitle">Sélectionnez une chaîne</h2>
                    <span class="sp-quality-badge" data-sp="osdQuality">HLS ABR</span>
                  </div>
                  <p class="sp-osd-prog" data-sp="osdProg">Prêt pour la diffusion adaptative sans coupure</p>
                </div>
              </div>

              <div class="sp-osd-right">
                <div class="sp-codec-box">Codec: <strong style="color:#67e8f9" data-sp="osdCodec">Auto ABR</strong></div>
                <div class="sp-zap-box">Zapping: <strong data-sp="osdZap">--</strong></div>
              </div>
            </div>

            <!-- Alerte de flux / reconnexion -->
            <div class="sp-stream-alert sp-hidden" data-sp="streamAlert"></div>

            <!-- Toast éphémère -->
            <div class="sp-toast" data-sp="toast"><span data-sp="toastText">StreamPulse prêt</span></div>
          </div>

          <!-- Barre de contrôle inférieure + Timeshift + EPG virtualisé -->
          <div class="sp-osd-bottom" data-sp="osdBottom">
            <div>
              <div class="sp-timeshift-meta">
                <span data-sp="tsStart">--:--</span>
                <span class="sp-timeshift-label">⏱ Contrôle du Direct (Tampon MSE Temps Réel)</span>
                <span data-sp="tsEnd">DIRECT</span>
              </div>
              <div class="sp-timeshift-track" data-sp="tsTrack" title="Se déplacer dans le tampon du direct">
                <div class="sp-timeshift-fill" data-sp="tsFill" style="width:100%">
                  <div class="sp-timeshift-thumb"></div>
                </div>
              </div>
            </div>

            <div class="sp-controls-row">
              <div class="sp-controls-group">
                <button type="button" class="sp-ctrl-btn sp-tv-focusable sp-touch-ripple" data-action="prev-ch" title="Chaîne précédente">⏮</button>
                <button type="button" class="sp-ctrl-btn sp-tv-focusable sp-touch-ripple" data-action="seek-back" title="Reculer de 10s">-10</button>
                <button type="button" class="sp-ctrl-play sp-tv-focusable sp-touch-ripple" data-action="play-pause" data-sp="playBtn" title="Lecture / Pause (P)">⏸</button>
                <button type="button" class="sp-ctrl-btn sp-tv-focusable sp-touch-ripple" data-action="seek-fwd" title="Avancer de 10s / Retour au direct">+10</button>
                <button type="button" class="sp-ctrl-btn sp-tv-focusable sp-touch-ripple" data-action="next-ch" title="Chaîne suivante">⏭</button>

                <div class="sp-vol-group">
                  <button type="button" class="sp-ctrl-btn sp-tv-focusable" data-action="mute" data-sp="muteBtn" title="Couper / Rétablir le son">🔊</button>
                  <input type="range" min="0" max="100" value="90" class="sp-vol-range" data-sp="volRange" aria-label="Volume">
                </div>
              </div>

              <div class="sp-controls-group">
                <button type="button" class="sp-pill-ctrl sp-tv-focusable sp-touch-ripple" data-action="cycle-abr" data-sp="abrBtn" title="Qualité vidéo / Adaptative Bitrate">ABR: Auto</button>
                <button type="button" class="sp-pill-ctrl sp-tv-focusable sp-touch-ripple" data-action="cycle-audio" data-sp="audioBtn" title="Changer de piste audio">Audio: Auto</button>
                <button type="button" class="sp-pill-ctrl sp-tv-focusable sp-touch-ripple" data-action="toggle-fav-current" data-sp="favCurrentBtn" title="Ajouter / retirer des favoris">☆ Favori</button>
                <button type="button" class="sp-pill-ctrl sp-tv-focusable sp-touch-ripple" data-action="toggle-quad" data-sp="quadBtn" title="Mosaïque 4 chaînes (M)">⊞ 4x</button>
                <button type="button" class="sp-ctrl-btn sp-tv-focusable sp-touch-ripple" data-action="toggle-epg" title="Guide EPG">📅</button>
                <button type="button" class="sp-ctrl-btn sp-tv-focusable sp-touch-ripple" data-action="fullscreen" title="Plein écran (F)">⛶</button>
              </div>
            </div>

            <!-- Tiroir Guide EPG Virtualisé -->
            <div class="sp-epg-drawer sp-hidden" data-sp="epgDrawer">
              <div class="sp-epg-head">
                <span>● GUIDE RAPIDE &amp; PROGRAMME DE LA CATÉGORIE (DOM VIRTUALISÉ)</span>
                <span style="color:var(--sp-emerald)" data-sp="epgSummary">Synchronisé</span>
              </div>
              <div class="sp-epg-viewport sp-custom-scroll" data-sp="epgViewport">
                <div class="sp-virtual-spacer" data-sp="epgSpacer"></div>
              </div>
            </div>
          </div>
        </main>
      </div>

      <!-- 3. BARRE TACTILE INFÉRIEURE ANDROID -->
      <nav class="sp-android-nav sp-hidden" data-sp="androidNav" aria-label="Navigation mobile Android">
        <button type="button" class="sp-android-tab sp-active sp-touch-ripple" data-action="nav-live"><span>📺</span><span>Direct</span></button>
        <button type="button" class="sp-android-tab sp-touch-ripple" data-action="nav-favs"><span>★</span><span>Favoris</span></button>
        <button type="button" class="sp-android-tab sp-touch-ripple" data-action="toggle-epg"><span>📅</span><span>Guide</span></button>
        <button type="button" class="sp-android-tab sp-touch-ripple" data-action="toggle-quad"><span>⊞</span><span>4x</span></button>
        <button type="button" class="sp-android-tab sp-touch-ripple" data-action="open-source"><span>⚙</span><span>Sources</span></button>
      </nav>

      <!-- 4. MODAL INTERNE : SOURCES M3U / XTREAM / QR TV -->
      <div class="sp-modal-backdrop sp-hidden" data-sp="sourceModal" role="dialog" aria-modal="true" aria-label="Sources IPTV">
        <div class="sp-modal-card">
          <div class="sp-modal-head">
            <h3>⚡ Connecter une Source IPTV</h3>
            <button type="button" class="sp-icon-btn" data-action="close-source">✕</button>
          </div>

          <div class="sp-tabs-2">
            <button type="button" class="sp-tab-btn sp-active" data-action="tab-xtream" data-sp="tabXtream">Xtream Codes / Lien M3U</button>
            <button type="button" class="sp-tab-btn" data-action="tab-rawm3u" data-sp="tabRawM3u">Fichier / Texte #EXTM3U</button>
          </div>

          <div data-sp="paneXtream">
            <div class="sp-field">
              <label>Lien complet M3U / Xtream (remplissage automatique)</label>
              <input type="text" data-sp="inpM3uAuto" placeholder="http://serveur:8080/get.php?username=...&password=..." spellcheck="false">
            </div>
            <div class="sp-field">
              <label>Serveur Xtream (Host:Port)</label>
              <input type="url" data-sp="inpServer" placeholder="http://fournisseur.com:8080" spellcheck="false">
            </div>
            <div class="sp-grid-2">
              <div class="sp-field">
                <label>Identifiant</label>
                <input type="text" data-sp="inpUser" placeholder="Utilisateur" spellcheck="false">
              </div>
              <div class="sp-field">
                <label>Mot de passe</label>
                <input type="password" data-sp="inpPass" placeholder="••••••••">
              </div>
            </div>
          </div>

          <div class="sp-hidden" data-sp="paneRawM3u">
            <div class="sp-field">
              <label>Coller le contenu brut d’une liste #EXTM3U</label>
              <input type="text" data-sp="inpRawM3u" placeholder="#EXTM3U ..." spellcheck="false">
            </div>
          </div>

          <div class="sp-modal-foot">
            <button type="button" class="sp-btn-cyan-soft" data-action="open-qr">⊞ Associer par QR Code TV</button>
            <button type="button" class="sp-btn-primary" data-action="save-source">Connecter &amp; Charger</button>
          </div>
        </div>
      </div>

      <!-- 5. MODAL INTERNE : AIDE TÉLÉCOMMANDE D-PAD -->
      <div class="sp-modal-backdrop sp-hidden" data-sp="helpModal" role="dialog" aria-modal="true" aria-label="Raccourcis Télécommande">
        <div class="sp-modal-card">
          <div class="sp-modal-head">
            <h3>🎮 Contrôle Télécommande Smart TV &amp; Clavier</h3>
            <button type="button" class="sp-icon-btn" data-action="close-help">✕</button>
          </div>
          <div class="sp-shortcut-row"><span>Parcourir les chaînes :</span><span>Flèches ↑ / ↓</span></div>
          <div class="sp-shortcut-row"><span>Zapping instantané :</span><span>Flèches ← / → ou Entrée</span></div>
          <div class="sp-shortcut-row"><span>Lecture / Pause :</span><span>Touche P ou Espace</span></div>
          <div class="sp-shortcut-row"><span>Mosaïque Multi-Écrans 4x :</span><span>Touche M</span></div>
          <div class="sp-shortcut-row"><span>Plein écran :</span><span>Touche F</span></div>
          <div class="sp-shortcut-row"><span>Retour à l'accueil ONDA :</span><span>Touche Échap / Retour</span></div>
          <div class="sp-modal-foot">
            <button type="button" class="sp-btn-primary" data-action="close-help">Compris</button>
          </div>
        </div>
      </div>
      `;
    }

    bindEvents() {
      // Delegated click handler inside #streampulse-module
      this.mountEl.addEventListener('click', (ev) => {
        const actionEl = ev.target.closest('[data-action]');
        if (actionEl) {
          this.handleAction(actionEl.getAttribute('data-action'), actionEl, ev);
          return;
        }
        const catBtn = ev.target.closest('[data-sp-cat]');
        if (catBtn) {
          this.selectedCat = catBtn.getAttribute('data-sp-cat');
          this.renderCategoryChips();
          this.recomputeFiltered();
          return;
        }
        const favToggle = ev.target.closest('[data-fav-id]');
        if (favToggle) {
          this.toggleFavorite(favToggle.getAttribute('data-fav-id'), ev);
          return;
        }
        const chBtn = ev.target.closest('[data-sp-idx]');
        if (chBtn) {
          const idx = Number(chBtn.getAttribute('data-sp-idx'));
          if (Number.isFinite(idx) && this.filtered[idx]) {
            this.playChannel(this.filtered[idx], idx);
          }
          return;
        }
        const quadSlot = ev.target.closest('[data-quad-idx]');
        if (quadSlot) {
          const idx = Number(quadSlot.getAttribute('data-quad-idx'));
          if (Number.isFinite(idx) && this.filtered[idx]) {
            this.playChannel(this.filtered[idx], idx);
            this.showToast(`Focus direct : ${this.filtered[idx].name}`);
          }
          return;
        }
        if (ev.target === this.q('[data-sp="videoWrap"]') || ev.target === this.q('[data-sp="video"]')) {
          this.toggleOsd();
        }
      });

      // Search input
      const searchInput = this.q('[data-sp="searchInput"]');
      searchInput.addEventListener('input', () => {
        this.searchQuery = searchInput.value.trim().toLocaleLowerCase();
        this.recomputeFiltered();
      });

      // Volume slider
      const volRange = this.q('[data-sp="volRange"]');
      volRange.addEventListener('input', () => {
        const video = this.q('[data-sp="video"]');
        const v = Number(volRange.value) / 100;
        video.volume = v;
        video.muted = v === 0;
        this.q('[data-sp="muteBtn"]').textContent = video.muted ? '🔇' : '🔊';
      });

      // Timeshift bar click seek
      this.q('[data-sp="tsTrack"]').addEventListener('click', (ev) => {
        const video = this.q('[data-sp="video"]');
        if (!video.buffered || !video.buffered.length) return;
        const start = video.buffered.start(0);
        const end = video.buffered.end(video.buffered.length - 1);
        if (end - start < 2) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        video.currentTime = start + ratio * (end - start);
        this.showToast(`Timeshift : ${Math.round(ratio * 100)}% du tampon`);
      });

      // Auto-parse M3U link inside StreamPulse source modal
      const m3uAuto = this.q('[data-sp="inpM3uAuto"]');
      m3uAuto.addEventListener('input', () => {
        const bridge = rootGlobal.ONDA_BRIDGE;
        if (bridge && typeof bridge.parseXtreamText === 'function') {
          const parsed = bridge.parseXtreamText(m3uAuto.value);
          if (parsed) {
            if (parsed.server) this.q('[data-sp="inpServer"]').value = parsed.server;
            if (parsed.username) this.q('[data-sp="inpUser"]').value = parsed.username;
            if (parsed.password) this.q('[data-sp="inpPass"]').value = parsed.password;
          }
        }
      });

      // Passive scroll & passive touch listeners for Android Web 60 FPS responsiveness
      const chViewport = this.q('[data-sp="channelsViewport"]');
      chViewport.addEventListener('scroll', () => {
        if (this.virtualRafPending) return;
        this.virtualRafPending = true;
        requestAnimationFrame(() => {
          this.virtualRafPending = false;
          this.renderVirtualChannels();
        });
      }, { passive: true });

      chViewport.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) {
          this.touchStartX = e.touches[0].clientX;
          this.touchStartY = e.touches[0].clientY;
        }
      }, { passive: true });
      chViewport.addEventListener('touchmove', () => {}, { passive: true });

      const catBar = this.q('[data-sp="categoryBar"]');
      catBar.addEventListener('touchstart', () => {}, { passive: true });
      catBar.addEventListener('touchmove', () => {}, { passive: true });

      const epgViewport = this.q('[data-sp="epgViewport"]');
      epgViewport.addEventListener('scroll', () => {
        if (this.epgRafPending) return;
        this.epgRafPending = true;
        requestAnimationFrame(() => {
          this.epgRafPending = false;
          this.renderVirtualEpg();
        });
      }, { passive: true });
      epgViewport.addEventListener('touchstart', () => {}, { passive: true });
      epgViewport.addEventListener('touchmove', () => {}, { passive: true });

      // Android stage swipe gestures ({ passive: true })
      const stage = this.q('[data-sp="stage"]');
      stage.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) {
          this.touchStartX = e.touches[0].clientX;
          this.touchStartY = e.touches[0].clientY;
        }
      }, { passive: true });
      stage.addEventListener('touchmove', () => {}, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        const dx = e.changedTouches[0].clientX - this.touchStartX;
        const dy = e.changedTouches[0].clientY - this.touchStartY;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
          if (dx < 0) this.stepChannel(1);
          else this.stepChannel(-1);
        }
      }, { passive: true });

      // Listen to ONDA root catalogue updates without mutating auth or storage
      rootGlobal.addEventListener('onda:catalogue-updated', () => {
        this.customStreams = null;
        this.syncFromBridge();
      });

      // Smart TV D-Pad & Keyboard controls (active ONLY when StreamPulse is open and no root modal sits above it)
      rootGlobal.addEventListener('keydown', (ev) => this.onKeyDown(ev));

      // Pause rAF when tab hidden & clean up MSE buffers on page unload
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.stopTelemetryLoop();
        else if (this.isOpen) this.startTelemetryLoop();
      });
      rootGlobal.addEventListener('pagehide', () => this.destroyPlayer());
    }

    handleAction(action) {
      switch (action) {
        case 'close-module':
          this.close();
          break;
        case 'mode-tv':
          this.setDeviceMode('tv');
          break;
        case 'mode-android':
          this.setDeviceMode('android');
          break;
        case 'nav-live':
          this.activeSection = 'live';
          this.updateNavHighlights();
          this.recomputeFiltered();
          break;
        case 'nav-favs':
          this.activeSection = 'favs';
          this.updateNavHighlights();
          this.recomputeFiltered();
          break;
        case 'clear-search':
          this.q('[data-sp="searchInput"]').value = '';
          this.searchQuery = '';
          this.recomputeFiltered();
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
        case 'seek-back':
          this.seekRelative(-10);
          break;
        case 'seek-fwd':
          this.seekRelative(10);
          break;
        case 'mute': {
          const video = this.q('[data-sp="video"]');
          video.muted = !video.muted;
          this.q('[data-sp="muteBtn"]').textContent = video.muted ? '🔇' : '🔊';
          this.showToast(video.muted ? 'Audio coupé' : 'Audio rétabli');
          break;
        }
        case 'cycle-abr':
          this.cycleAbrQuality();
          break;
        case 'cycle-audio':
          this.cycleAudioTrack();
          break;
        case 'toggle-fav-current':
          if (this.currentChannel) {
            this.toggleFavorite(this.currentChannel.stream_id);
            this.updateCurrentFavButton();
          }
          break;
        case 'toggle-quad':
          this.toggleQuadView();
          break;
        case 'toggle-epg':
          this.toggleEpgDrawer();
          break;
        case 'fullscreen':
          this.toggleFullscreen();
          break;
        case 'open-qr':
          this.q('[data-sp="sourceModal"]').classList.add('sp-hidden');
          if (rootGlobal.ONDA_BRIDGE && typeof rootGlobal.ONDA_BRIDGE.openQrPair === 'function') {
            rootGlobal.ONDA_BRIDGE.openQrPair();
          }
          break;
        case 'open-source':
          this.openSourceModal();
          break;
        case 'close-source':
          this.q('[data-sp="sourceModal"]').classList.add('sp-hidden');
          break;
        case 'tab-xtream':
          this.q('[data-sp="tabXtream"]').classList.add('sp-active');
          this.q('[data-sp="tabRawM3u"]').classList.remove('sp-active');
          this.q('[data-sp="paneXtream"]').classList.remove('sp-hidden');
          this.q('[data-sp="paneRawM3u"]').classList.add('sp-hidden');
          break;
        case 'tab-rawm3u':
          this.q('[data-sp="tabRawM3u"]').classList.add('sp-active');
          this.q('[data-sp="tabXtream"]').classList.remove('sp-active');
          this.q('[data-sp="paneRawM3u"]').classList.remove('sp-hidden');
          this.q('[data-sp="paneXtream"]').classList.add('sp-hidden');
          break;
        case 'save-source':
          this.submitSourceModal();
          break;
        case 'open-help':
          this.q('[data-sp="helpModal"]').classList.remove('sp-hidden');
          break;
        case 'close-help':
          this.q('[data-sp="helpModal"]').classList.add('sp-hidden');
          break;
      }
    }

    setDeviceMode(mode, silent = false) {
      this.deviceMode = mode === 'android' ? 'android' : 'tv';
      const isAndroid = this.deviceMode === 'android';
      this.mountEl.classList.toggle('sp-mode-android', isAndroid);
      this.q('[data-action="mode-tv"]').classList.toggle('sp-active', !isAndroid);
      this.q('[data-action="mode-android"]').classList.toggle('sp-active', isAndroid);
      this.q('[data-sp="androidNav"]').classList.toggle('sp-hidden', !isAndroid);
      if (!silent) {
        this.showToast(isAndroid ? 'Mode Android Web : gestes tactiles passifs actifs' : 'Mode Smart TV : navigation D-Pad active');
      }
      requestAnimationFrame(() => this.renderVirtualChannels());
    }

    updateNavHighlights() {
      const isFavs = this.activeSection === 'favs';
      this.mountEl.querySelectorAll('[data-action="nav-live"]').forEach((b) => b.classList.toggle('sp-active', !isFavs));
      this.mountEl.querySelectorAll('[data-action="nav-favs"]').forEach((b) => b.classList.toggle('sp-active', isFavs));
    }

    syncFromBridge() {
      if (!this.mounted) return;
      const bridge = rootGlobal.ONDA_BRIDGE;
      const snapshot = bridge && typeof bridge.getState === 'function' ? bridge.getState() : null;

      if (snapshot) {
        this.categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
        this.categoryMap = new Map(this.categories.map((c) => [String(c.category_id), c.category_name || 'Direct']));
        this.streams = this.customStreams || (Array.isArray(snapshot.streams) ? snapshot.streams : []);

        const serverHost = snapshot.credentials && snapshot.credentials.server
          ? snapshot.credentials.server.replace(/^https?:\/\//i, '')
          : '';
        this.q('[data-sp="sourceLabel"]').textContent = serverHost || 'Aucune playlist connectée';
      }

      this.renderCategoryChips();
      this.recomputeFiltered();
    }

    renderCategoryChips() {
      const bar = this.q('[data-sp="categoryBar"]');
      if (!bar) return;
      const chips = [{ id: 'all', name: `Tous (${this.streams.length.toLocaleString('fr-FR')})` }];
      const limit = Math.min(this.categories.length, 60);
      for (let i = 0; i < limit; i++) {
        const c = this.categories[i];
        chips.push({ id: String(c.category_id), name: c.category_name || 'Catégorie' });
      }
      bar.innerHTML = chips
        .map((c) => `<button type="button" data-sp-cat="${escapeHtml(c.id)}" class="sp-cat-chip sp-tv-focusable ${this.selectedCat === c.id ? 'sp-active' : ''}">${escapeHtml(c.name)}</button>`)
        .join('');
    }

    recomputeFiltered() {
      const q = this.searchQuery;
      const onlyFavs = this.activeSection === 'favs';
      const cat = this.selectedCat;

      this.filtered = this.streams.filter((item) => {
        if (onlyFavs && !this.favorites.has(String(item.stream_id))) return false;
        if (cat !== 'all' && String(item.category_id) !== cat) return false;
        if (q && !String(item.name || '').toLocaleLowerCase().includes(q) && !String(item.stream_id).includes(q)) return false;
        return true;
      });

      this.q('[data-sp="countLabel"]').textContent = `${this.filtered.length.toLocaleString('fr-FR')} chaîne${this.filtered.length > 1 ? 's' : ''}`;

      if (this.currentChannel) {
        this.currentIndex = this.filtered.findIndex((c) => String(c.stream_id) === String(this.currentChannel.stream_id));
      }

      const emptyBox = this.q('[data-sp="emptyState"]');
      const spacer = this.q('[data-sp="channelsSpacer"]');

      if (!this.filtered.length) {
        spacer.style.height = '0px';
        spacer.innerHTML = '';
        emptyBox.classList.remove('sp-hidden');
        if (!this.streams.length) {
          emptyBox.innerHTML = `
            <strong style="color:#fff;font-size:14px">Aucune playlist connectée</strong>
            <span>Associez votre Smart TV par QR Code depuis votre téléphone ou importez votre lien M3U / Xtream.</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
              <button type="button" class="sp-btn-primary" data-action="open-qr">⊞ QR Code TV</button>
              <button type="button" class="sp-btn-cyan-soft" data-action="open-source">⚡ Importer M3U / Xtream</button>
            </div>
          `;
        } else {
          emptyBox.innerHTML = `<span>Aucune chaîne ne correspond à ce filtre.</span>`;
        }
      } else {
        emptyBox.classList.add('sp-hidden');
        this.renderVirtualChannels();
      }

      if (this.isQuadView) this.renderQuadView();
      if (this.isEpgOpen) this.renderVirtualEpg();
    }

    /**
     * True DOM Virtualization: renders ONLY visible rows (~18-24 elements) even for 28,000+ channels.
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
        viewport.clientHeight || 520,
        CHANNEL_ROW_HEIGHT,
        CHANNEL_OVERSCAN
      );

      spacer.style.height = `${totalHeight}px`;
      const activeId = this.currentChannel ? String(this.currentChannel.stream_id) : '';
      const rowsHtml = [];

      for (let i = start; i < end; i++) {
        const ch = this.filtered[i];
        const idStr = String(ch.stream_id);
        const isCurrent = idStr === activeId;
        const isFocused = i === this.focusedVirtualIndex;
        const isFav = this.favorites.has(idStr);
        const num = String(i + 1).padStart(2, '0');
        const catName = ch.category_name || this.categoryMap.get(String(ch.category_id)) || 'Télévision en direct';
        const qTag = inferQualityTag(ch.name);
        const hasHttpsLogo = ch.stream_icon && /^https:\/\//i.test(ch.stream_icon);
        const logoInner = hasHttpsLogo
          ? `<img src="${escapeHtml(ch.stream_icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
          : escapeHtml(channelInitials(ch.name));

        rowsHtml.push(`
          <button type="button"
            class="sp-channel-row sp-tv-focusable sp-touch-ripple ${isCurrent ? 'sp-active' : ''} ${isFocused ? 'sp-tv-focused' : ''}"
            data-sp-idx="${i}"
            style="transform:translate3d(0,${i * CHANNEL_ROW_HEIGHT}px,0)">
            <div class="sp-ch-left">
              <span class="sp-ch-num">${num}</span>
              <div class="sp-ch-logo">${logoInner}</div>
              <div class="sp-ch-meta">
                <div class="sp-ch-name-row">
                  <span class="sp-ch-name">${escapeHtml(ch.name || 'Chaîne ' + idStr)}</span>
                  <span class="sp-ch-tag">${escapeHtml(qTag)}</span>
                </div>
                <p class="sp-ch-sub">${escapeHtml(catName)}</p>
                <div class="sp-ch-bar"><span style="width:${isCurrent ? 100 : 65}%"></span></div>
              </div>
            </div>
            <div class="sp-ch-right">
              <span class="sp-fav-star ${isFav ? 'sp-is-fav' : ''}" data-fav-id="${escapeHtml(idStr)}" title="Favori">${isFav ? '★' : '☆'}</span>
              <span class="sp-ch-status">${isCurrent ? '● DIRECT' : 'PRÊT'}</span>
            </div>
          </button>
        `);
      }

      spacer.innerHTML = rowsHtml.join('');
    }

    /**
     * Virtualized EPG / Category Quick-Guide Drawer.
     */
    renderVirtualEpg() {
      const viewport = this.q('[data-sp="epgViewport"]');
      const spacer = this.q('[data-sp="epgSpacer"]');
      if (!viewport || !spacer) return;

      const list = this.filtered;
      const { start, end, totalHeight } = computeVirtualRange(
        list.length,
        viewport.scrollTop,
        viewport.clientHeight || 132,
        EPG_ROW_HEIGHT,
        EPG_OVERSCAN
      );
      spacer.style.height = `${totalHeight}px`;
      this.q('[data-sp="epgSummary"]').textContent = `${list.length.toLocaleString('fr-FR')} flux indexés`;

      const now = new Date();
      const slotStart = new Date(now.getTime() - (now.getMinutes() % 30) * 60000);
      const slotEnd = new Date(slotStart.getTime() + 60 * 60000);
      const timeRange = `${formatClock(slotStart)} - ${formatClock(slotEnd)}`;
      const activeId = this.currentChannel ? String(this.currentChannel.stream_id) : '';

      const html = [];
      for (let i = start; i < end; i++) {
        const ch = list[i];
        const isCurrent = String(ch.stream_id) === activeId;
        const catName = ch.category_name || this.categoryMap.get(String(ch.category_id)) || 'Diffusion continue';
        html.push(`
          <div class="sp-epg-row ${isCurrent ? 'sp-active' : ''}" data-sp-idx="${i}" style="transform:translate3d(0,${i * EPG_ROW_HEIGHT}px,0)">
            <div style="min-width:0;display:flex;align-items:center;gap:10px">
              <span style="font-family:var(--sp-font-mono);font-size:10.5px;color:#67e8f9">${timeRange}</span>
              <strong style="color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(ch.name)}</strong>
            </div>
            <span style="font-size:11px;color:var(--sp-muted);flex-shrink:0">${escapeHtml(catName)}</span>
          </div>
        `);
      }
      spacer.innerHTML = html.join('');
    }

    /**
     * Strict Smart TV Memory Cleanup: destroys HLS / Shaka / mpegts instances and flushes <video> buffer.
     */
    destroyPlayer() {
      this.sessionToken++;
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

    playChannel(channel, idx = -1) {
      if (!channel) return;
      // Stop any background root player so single-connection Xtream slots never collide
      if (rootGlobal.ONDA_BRIDGE && typeof rootGlobal.ONDA_BRIDGE.stopRootPlayback === 'function') {
        rootGlobal.ONDA_BRIDGE.stopRootPlayback();
      }

      this.destroyPlayer();
      const token = this.sessionToken;
      this.currentChannel = channel;
      this.currentIndex = idx >= 0 ? idx : this.filtered.findIndex((c) => String(c.stream_id) === String(channel.stream_id));
      if (this.currentIndex >= 0) this.focusedVirtualIndex = this.currentIndex;

      this.retryAttempt = 0;
      this.mediaRecoveryCount = 0;
      this.abrSelection = -1;
      this.zapStartPerf = performance.now();
      this.detectedCodec = 'Auto ABR';
      this.detectedRes = inferQualityTag(channel.name);

      // Update OSD immediately
      this.q('[data-sp="osdTitle"]').textContent = channel.name || 'Chaîne';
      this.q('[data-sp="osdQuality"]').textContent = this.detectedRes;
      this.q('[data-sp="osdProg"]').textContent = channel.category_name || this.categoryMap.get(String(channel.category_id)) || 'Diffusion en direct';
      this.q('[data-sp="abrBtn"]').textContent = 'ABR: Auto';
      this.q('[data-sp="audioBtn"]').textContent = 'Audio: Auto';
      this.updateCurrentFavButton();

      const iconBox = this.q('[data-sp="osdIcon"]');
      if (channel.stream_icon && /^https:\/\//i.test(channel.stream_icon)) {
        iconBox.innerHTML = `<img src="${escapeHtml(channel.stream_icon)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.textContent='${escapeHtml(channelInitials(channel.name))}'">`;
      } else {
        iconBox.textContent = channelInitials(channel.name);
      }

      this.renderVirtualChannels();
      if (this.isQuadView) this.renderQuadView();
      if (this.isEpgOpen) this.renderVirtualEpg();
      this.showOsd();
      this.setStreamAlert('');

      const streamUrl = this.buildStreamUrl(channel, 'play');
      if (!streamUrl) {
        this.setStreamAlert('Connectez d’abord votre source IPTV (QR Code TV ou Sources M3U).');
        return;
      }

      if (/\.mpd(?:\?|$)/i.test(streamUrl)) {
        this.startDashShaka(channel, streamUrl, token);
      } else {
        this.startAdaptiveHls(channel, streamUrl, token, true);
      }
    }

    updateCurrentFavButton() {
      const btn = this.q('[data-sp="favCurrentBtn"]');
      if (!btn || !this.currentChannel) return;
      const isFav = this.favorites.has(String(this.currentChannel.stream_id));
      btn.textContent = isFav ? '★ Favori' : '☆ Favori';
      btn.classList.toggle('sp-active', isFav);
    }

    markStreamConnected() {
      if (this.zapStartPerf > 0) {
        const sec = ((performance.now() - this.zapStartPerf) / 1000).toFixed(2);
        this.lastZapSeconds = `${sec}s`;
        this.q('[data-sp="osdZap"]').textContent = this.lastZapSeconds;
        this.zapStartPerf = 0;
      }
      if (rootGlobal.ONDA_BRIDGE && typeof rootGlobal.ONDA_BRIDGE.markLocalPlay === 'function') {
        rootGlobal.ONDA_BRIDGE.markLocalPlay();
      }
      this.q('[data-sp="playBtn"]').textContent = '⏸';
      this.setStreamAlert('');
    }

    /**
     * Adaptive HLS Engine (hls.js) with ABR enabled & exponential-backoff auto-recovery.
     */
    startAdaptiveHls(channel, streamUrl, token, allowTsFallback) {
      if (token !== this.sessionToken) return;
      const video = this.q('[data-sp="video"]');
      this.q('[data-sp="engineTag"]').textContent = 'HLS ABR Engine';

      video.addEventListener('playing', () => {
        if (token === this.sessionToken) this.markStreamConnected();
      }, { once: true });

      if (rootGlobal.Hls && rootGlobal.Hls.isSupported()) {
        const HlsClass = rootGlobal.Hls;
        const hls = new HlsClass({
          startLevel: -1, // Adaptive Bitrate (ABR) active immediately
          capLevelToPlayerSize: true,
          abrEwmaDefaultEstimate: 2500000,
          abrBandWidthFactor: 0.9,
          abrBandWidthUpFactor: 0.7,
          lowLatencyMode: false,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          backBufferLength: 30,
          maxBufferLength: 50,
          maxMaxBufferLength: 90,
          maxBufferHole: 0.8,
          highBufferWatchdogPeriod: 3,
          nudgeOffset: 0.2,
          nudgeMaxRetry: 5,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: allowTsFallback ? 1 : 2,
          manifestLoadingRetryDelay: 800,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 3,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetry: 4
        });
        this.hls = hls;
        let manifestReady = false;

        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(HlsClass.Events.MANIFEST_PARSED, (_ev, data) => {
          if (token !== this.sessionToken) return;
          manifestReady = true;
          if (data && Array.isArray(data.levels) && data.levels.length) {
            const best = data.levels[data.levels.length - 1];
            if (best && best.videoCodec) this.detectedCodec = best.videoCodec.toUpperCase();
            if (best && best.height) this.detectedRes = `${best.height}p ABR`;
          }
          video.play().catch(() => {
            this.q('[data-sp="playBtn"]').textContent = '▶';
          });
        });

        hls.on(HlsClass.Events.LEVEL_SWITCHED, (_ev, data) => {
          if (token !== this.sessionToken || !hls.levels) return;
          const lvl = hls.levels[data.level];
          if (lvl) {
            if (lvl.height) this.detectedRes = `${lvl.height}p${this.abrSelection === -1 ? ' ABR' : ''}`;
            if (lvl.videoCodec) this.detectedCodec = lvl.videoCodec.toUpperCase();
          }
        });

        hls.on(HlsClass.Events.FRAG_LOADED, (_ev, data) => {
          if (token !== this.sessionToken) return;
          this.retryAttempt = 0;
          const stats = data && data.frag && data.frag.stats;
          if (stats && stats.loading) {
            const rtt = Math.max(1, Math.round((stats.loading.first || stats.loading.end) - stats.loading.start));
            this.measuredPingMs = rtt;
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
          if (token !== this.sessionToken || !data) return;
          const httpCode = data.response && data.response.code;

          // Non-fatal segment 404 or timeout: schedule silent exponential-backoff recovery
          if (!data.fatal) {
            if (
              data.details === HlsClass.ErrorDetails.FRAG_LOAD_ERROR ||
              data.details === HlsClass.ErrorDetails.FRAG_LOAD_TIMEOUT ||
              data.details === HlsClass.ErrorDetails.LEVEL_LOAD_ERROR ||
              data.details === HlsClass.ErrorDetails.LEVEL_LOAD_TIMEOUT
            ) {
              this.scheduleExponentialRecovery(token, () => {
                if (this.hls === hls) hls.startLoad();
              });
            }
            return;
          }

          // Fatal error handling
          if (manifestReady && data.type === HlsClass.ErrorTypes.MEDIA_ERROR) {
            this.mediaRecoveryCount++;
            if (this.mediaRecoveryCount === 2 && typeof hls.swapAudioCodec === 'function') {
              hls.swapAudioCodec();
            }
            hls.recoverMediaError();
            return;
          }

          // Xtream raw MPEG-TS stream detection (415) -> seamless switch to mpegts.js
          if (allowTsFallback && (httpCode === 415 || !manifestReady) && !channel.directUrl && rootGlobal.mpegts && rootGlobal.mpegts.isSupported()) {
            if (httpCode !== 429 && httpCode !== 403) {
              this.destroyPlayer();
              this.sessionToken = token;
              this.startMpegTsFallback(channel, token);
              return;
            }
          }

          // Single-connection Xtream zapping contention (429)
          if (httpCode === 429) {
            const bridge = rootGlobal.ONDA_BRIDGE;
            if (bridge && bridge.isOwnSessionCoolingDown && bridge.isOwnSessionCoolingDown() && this.retryAttempt < 3) {
              this.retryAttempt++;
              this.setStreamAlert('Libération du flux précédent auprès du serveur, reprise automatique...');
              this.retryTimer = setTimeout(() => {
                if (token === this.sessionToken) this.startAdaptiveHls(channel, this.buildStreamUrl(channel, 'play'), token, allowTsFallback);
              }, 4500);
              return;
            }
            this.destroyPlayer();
            this.setStreamAlert('Limite de connexions atteinte sur ce compte IPTV (une lecture est ouverte sur un autre appareil).', true);
            return;
          }

          if (httpCode === 403) {
            this.destroyPlayer();
            this.setStreamAlert('Accès refusé par le fournisseur IPTV (compte expiré ou identifiants invalides).', true);
            return;
          }

          // Exponential backoff silent stream reload for 404 / timeout / network drop
          this.scheduleExponentialRecovery(token, () => {
            this.destroyPlayer();
            this.sessionToken = token;
            this.startAdaptiveHls(channel, this.buildStreamUrl(channel, 'play'), token, allowTsFallback);
          }, true);
        });
        return;
      }

      // Native HLS fallback (Safari / iOS / WebKit Smart TVs)
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.onerror = () => {
          if (token !== this.sessionToken) return;
          this.scheduleExponentialRecovery(token, () => {
            video.src = this.buildStreamUrl(channel, 'play');
            video.play().catch(() => {});
          }, true);
        };
        video.play().catch(() => {});
        return;
      }

      if (allowTsFallback && rootGlobal.mpegts && rootGlobal.mpegts.isSupported()) {
        this.startMpegTsFallback(channel, token);
      } else {
        this.setStreamAlert('Navigateur incompatible avec HLS / MSE.', true);
      }
    }

    /**
     * MPEG-DASH Engine (Shaka Player) with ABR enabled when playing .mpd streams.
     */
    async startDashShaka(channel, streamUrl, token) {
      if (token !== this.sessionToken) return;
      const video = this.q('[data-sp="video"]');
      this.q('[data-sp="engineTag"]').textContent = 'Shaka DASH ABR';

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
          video.play().catch(() => {});
        }
      } catch {
        if (token === this.sessionToken) {
          this.scheduleExponentialRecovery(token, () => this.playChannel(channel, this.currentIndex), true);
        }
      }
    }

    /**
     * Live MPEG-TS (.ts) Engine fallback with deep anti-cut stash buffer & exponential recovery.
     */
    startMpegTsFallback(channel, token) {
      if (token !== this.sessionToken) return;
      const tsUrl = this.buildStreamUrl(channel, 'ts');
      if (!tsUrl || !rootGlobal.mpegts) return;

      const video = this.q('[data-sp="video"]');
      this.q('[data-sp="engineTag"]').textContent = 'MPEG-TS Direct';
      this.detectedCodec = 'MPEG-TS Live';

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

      video.addEventListener('playing', () => {
        if (token === this.sessionToken) {
          this.retryAttempt = 0;
          this.markStreamConnected();
        }
      }, { once: true });

      player.on(rootGlobal.mpegts.Events.STATISTICS_INFO, (info) => {
        if (token === this.sessionToken && info && info.speed) {
          // info.speed is KB/s
          this.measuredMbps = (info.speed * 8) / 1000;
        }
      });

      player.on(rootGlobal.mpegts.Events.ERROR, (_t, _d, info) => {
        if (token !== this.sessionToken) return;
        const code = info && info.code;
        if (code === 429) {
          this.destroyPlayer();
          this.setStreamAlert('Limite de connexions atteinte sur ce compte IPTV.', true);
          return;
        }
        this.scheduleExponentialRecovery(token, () => {
          this.destroyPlayer();
          this.sessionToken = token;
          this.startMpegTsFallback(channel, token);
        }, true);
      });

      player.attachMediaElement(video);
      player.load();
      const p = player.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    /**
     * Silent Exponential-Backoff Auto-Recovery (1s -> 2s -> 4s -> 8s -> 16s).
     */
    scheduleExponentialRecovery(token, actionFn, showBanner = false) {
      if (token !== this.sessionToken) return;
      if (this.retryTimer) clearTimeout(this.retryTimer);

      if (this.retryAttempt >= MAX_AUTO_RETRIES) {
        this.setStreamAlert('Ce flux est temporairement hors antenne ou injoignable chez le fournisseur.', true);
        return;
      }

      const jitter = Math.floor(Math.random() * 250);
      const delay = computeBackoffMs(this.retryAttempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS, jitter);
      this.retryAttempt++;

      if (showBanner) {
        this.setStreamAlert(`Récupération automatique du flux (tentative ${this.retryAttempt}/${MAX_AUTO_RETRIES} dans ${(delay / 1000).toFixed(1)}s)...`);
      }

      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (token === this.sessionToken) actionFn();
      }, delay);
    }

    setStreamAlert(message, withRetryButton = false) {
      const box = this.q('[data-sp="streamAlert"]');
      if (!box) return;
      if (!message) {
        box.classList.add('sp-hidden');
        box.innerHTML = '';
        return;
      }
      box.classList.remove('sp-hidden');
      box.innerHTML = `
        <span>${escapeHtml(message)}</span>
        ${withRetryButton ? '<button type="button" class="sp-btn-primary" data-sp-retry="1">↻ Relancer le flux</button>' : ''}
      `;
      const retryBtn = box.querySelector('[data-sp-retry]');
      if (retryBtn) {
        retryBtn.onclick = () => {
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

        // Throttle DOM text updates to ~4Hz inside rAF to guarantee 60 FPS zero-jank rendering
        if (now - this.lastTelemetryCommitTs >= 250) {
          this.lastTelemetryCommitTs = now;
          this.commitTelemetryDom();
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

      // 1. Buffer ahead
      let bufAhead = 0;
      let bufStart = 0;
      let bufEnd = 0;
      if (video.buffered && video.buffered.length > 0) {
        bufStart = video.buffered.start(0);
        bufEnd = video.buffered.end(video.buffered.length - 1);
        bufAhead = Math.max(0, bufEnd - video.currentTime);
      }
      const pct = Math.min(100, Math.round((bufAhead / 25) * 100));
      const bufText = `${bufAhead.toFixed(1)}s (${pct}%)`;
      this.setDomIfChanged('telBuffer', bufText);

      // 2. Bitrate
      const mbpsText = this.measuredMbps > 0 ? `${this.measuredMbps.toFixed(1)} Mbps` : 'Auto ABR';
      this.setDomIfChanged('telBitrate', mbpsText);

      // 3. Ping RTT
      const pingText = this.measuredPingMs > 0 ? `${this.measuredPingMs} ms` : 'Direct';
      this.setDomIfChanged('telPing', pingText);

      // 4. FPS
      const avgFps = this.fpsSamples.length
        ? Math.min(120, Math.round(this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length))
        : 60;
      this.setDomIfChanged('telFps', String(avgFps));

      // 5. Real video dimensions & codec
      if (video.videoHeight > 0) {
        const resLabel = `${video.videoHeight}p${this.abrSelection === -1 ? ' ABR' : ''}`;
        this.setDomIfChanged('osdQuality', resLabel);
      }
      this.setDomIfChanged('osdCodec', this.detectedCodec);

      // 6. Live Timeshift progress bar
      if (bufEnd - bufStart > 1) {
        const ratio = Math.max(4, Math.min(100, Math.round(((video.currentTime - bufStart) / (bufEnd - bufStart)) * 100)));
        const fill = this.q('[data-sp="tsFill"]');
        if (fill) fill.style.width = `${ratio}%`;
        const lagSec = Math.max(0, Math.round(bufEnd - video.currentTime));
        this.setDomIfChanged('tsStart', `-${Math.round(bufEnd - bufStart)}s`);
        this.setDomIfChanged('tsEnd', lagSec <= 4 ? '● DIRECT' : `-${lagSec}s`);
      }
    }

    setDomIfChanged(key, val) {
      if (this.renderedTelemetry[key] === val) return;
      this.renderedTelemetry[key] = val;
      const el = this.q(`[data-sp="${key}"]`);
      if (el) el.textContent = val;
    }

    stepChannel(delta) {
      if (!this.filtered.length) return;
      const nextIdx = (Math.max(0, this.currentIndex) + delta + this.filtered.length) % this.filtered.length;
      this.scrollChannelIntoView(nextIdx);
      this.playChannel(this.filtered[nextIdx], nextIdx);
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
      if (!video) return;
      if (video.paused) {
        video.play().catch(() => {});
        this.q('[data-sp="playBtn"]').textContent = '⏸';
        this.showToast('Reprise de la lecture');
      } else {
        video.pause();
        this.q('[data-sp="playBtn"]').textContent = '▶';
        this.showToast('Pause Timeshift');
      }
    }

    seekRelative(sec) {
      const video = this.q('[data-sp="video"]');
      if (!video || !video.buffered || !video.buffered.length) return;
      const start = video.buffered.start(0);
      const end = video.buffered.end(video.buffered.length - 1);
      video.currentTime = Math.max(start, Math.min(end - 0.5, video.currentTime + sec));
      this.showToast(`${sec > 0 ? '+' : ''}${sec}s`);
    }

    cycleAbrQuality() {
      if (!this.hls || !Array.isArray(this.hls.levels) || this.hls.levels.length <= 1) {
        this.showToast('ABR Automatique actif (niveau unique sur cette chaîne)');
        return;
      }
      const levels = this.hls.levels;
      this.abrSelection = this.abrSelection >= levels.length - 1 ? -1 : this.abrSelection + 1;
      this.hls.currentLevel = this.abrSelection;
      const label = this.abrSelection === -1
        ? 'ABR: Auto'
        : `Qualité: ${levels[this.abrSelection].height || this.abrSelection + 1}p`;
      this.q('[data-sp="abrBtn"]').textContent = label;
      this.showToast(label);
    }

    cycleAudioTrack() {
      if (this.hls && Array.isArray(this.hls.audioTracks) && this.hls.audioTracks.length > 1) {
        const next = (this.hls.audioTrack + 1) % this.hls.audioTracks.length;
        this.hls.audioTrack = next;
        const track = this.hls.audioTracks[next];
        const label = track.name || track.lang || `Piste ${next + 1}`;
        this.q('[data-sp="audioBtn"]').textContent = `Audio: ${label}`;
        this.showToast(`Piste audio : ${label}`);
        return;
      }
      this.showToast('Piste audio principale active');
    }

    toggleQuadView() {
      this.isQuadView = !this.isQuadView;
      const grid = this.q('[data-sp="quadGrid"]');
      const btn = this.q('[data-sp="quadBtn"]');
      grid.classList.toggle('sp-hidden', !this.isQuadView);
      btn.classList.toggle('sp-active', this.isQuadView);
      if (this.isQuadView) {
        this.renderQuadView();
        this.showToast('Mosaïque Rapide 4x (1 connexion protégée)');
      } else {
        this.showToast('Vue plein lecteur');
      }
    }

    renderQuadView() {
      const grid = this.q('[data-sp="quadGrid"]');
      if (!grid) return;
      const baseIdx = Math.max(0, this.currentIndex);
      const slots = [];
      for (let s = 0; s < 4; s++) {
        const idx = this.filtered.length ? (baseIdx + s) % this.filtered.length : -1;
        const ch = idx >= 0 ? this.filtered[idx] : null;
        const isPrimary = s === 0;
        slots.push(`
          <button type="button" class="sp-quad-slot sp-tv-focusable ${isPrimary ? 'sp-active' : ''}" data-quad-idx="${idx}">
            <div class="sp-quad-top">
              <span class="sp-quad-audio-pill">${isPrimary ? '1 • FLUX ACTIF AUDIO' : `${s + 1} • ZAP RAPIDE`}</span>
              <span class="sp-quality-badge">${ch ? escapeHtml(inferQualityTag(ch.name)) : '--'}</span>
            </div>
            <span class="sp-quad-title">${ch ? escapeHtml(ch.name) : 'Aucun flux'}</span>
          </button>
        `);
      }
      grid.innerHTML = slots.join('');
    }

    toggleEpgDrawer() {
      this.isEpgOpen = !this.isEpgOpen;
      const drawer = this.q('[data-sp="epgDrawer"]');
      drawer.classList.toggle('sp-hidden', !this.isEpgOpen);
      if (this.isEpgOpen) this.renderVirtualEpg();
    }

    toggleFullscreen() {
      if (!document.fullscreenElement) {
        this.mountEl.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    }

    toggleOsd() {
      this.isOsdVisible = !this.isOsdVisible;
      this.q('[data-sp="osdTop"]').classList.toggle('sp-osd-hidden-top', !this.isOsdVisible);
      if (this.isOsdVisible) this.resetOsdTimer();
    }

    showOsd() {
      this.isOsdVisible = true;
      this.q('[data-sp="osdTop"]')?.classList.remove('sp-osd-hidden-top');
      this.resetOsdTimer();
    }

    resetOsdTimer() {
      if (this.osdTimer) clearTimeout(this.osdTimer);
      this.osdTimer = setTimeout(() => {
        const video = this.q('[data-sp="video"]');
        if (video && !video.paused && !this.isQuadView) {
          this.isOsdVisible = false;
          this.q('[data-sp="osdTop"]')?.classList.add('sp-osd-hidden-top');
        }
      }, 5000);
    }

    showToast(text) {
      const toast = this.q('[data-sp="toast"]');
      const label = this.q('[data-sp="toastText"]');
      if (!toast || !label) return;
      label.textContent = text;
      toast.classList.add('sp-visible');
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => toast.classList.remove('sp-visible'), 1600);
    }

    openSourceModal() {
      const bridge = rootGlobal.ONDA_BRIDGE;
      const snap = bridge && typeof bridge.getState === 'function' ? bridge.getState() : null;
      if (snap && snap.credentials) {
        this.q('[data-sp="inpServer"]').value = snap.credentials.server || '';
        this.q('[data-sp="inpUser"]').value = snap.credentials.username || '';
        this.q('[data-sp="inpPass"]').value = snap.credentials.password || '';
      }
      this.q('[data-sp="sourceModal"]').classList.remove('sp-hidden');
      this.q('[data-sp="inpM3uAuto"]').focus();
    }

    submitSourceModal() {
      const rawPaneVisible = !this.q('[data-sp="paneRawM3u"]').classList.contains('sp-hidden');
      if (rawPaneVisible) {
        const rawText = this.q('[data-sp="inpRawM3u"]').value.trim();
        const parsed = parseM3uPlaylist(rawText);
        if (!parsed.length) {
          this.showToast('Aucun flux valide trouvé dans ce texte #EXTM3U');
          return;
        }
        this.customStreams = parsed;
        this.streams = parsed;
        const groups = [...new Set(parsed.map((p) => p.category_name))];
        this.categories = groups.map((g) => ({ category_id: g, category_name: g }));
        this.categoryMap = new Map(groups.map((g) => [g, g]));
        this.selectedCat = 'all';
        this.q('[data-sp="sourceLabel"]').textContent = 'Playlist #EXTM3U locale';
        this.q('[data-sp="sourceModal"]').classList.add('sp-hidden');
        this.renderCategoryChips();
        this.recomputeFiltered();
        this.playChannel(this.filtered[0], 0);
        this.showToast(`${parsed.length} flux chargés`);
        return;
      }

      const server = this.q('[data-sp="inpServer"]').value.trim();
      const username = this.q('[data-sp="inpUser"]').value.trim();
      const password = this.q('[data-sp="inpPass"]').value.trim();
      if (!server || !username || !password) {
        this.showToast('Veuillez renseigner le serveur, l’identifiant et le mot de passe');
        return;
      }
      this.q('[data-sp="sourceModal"]').classList.add('sp-hidden');
      if (rootGlobal.ONDA_BRIDGE && typeof rootGlobal.ONDA_BRIDGE.connectXtream === 'function') {
        this.showToast('Synchronisation du catalogue Xtream en cours...');
        rootGlobal.ONDA_BRIDGE.connectXtream({ server, username, password });
      }
    }

    onKeyDown(ev) {
      if (!this.isOpen) return;
      // Yield if a root ONDA modal (#tv-pair-overlay, #settings-overlay, etc.) is currently open on top
      const bridge = rootGlobal.ONDA_BRIDGE;
      if (bridge && typeof bridge.hasActiveRootModal === 'function' && bridge.hasActiveRootModal()) {
        return;
      }

      const helpOpen = !this.q('[data-sp="helpModal"]').classList.contains('sp-hidden');
      const sourceOpen = !this.q('[data-sp="sourceModal"]').classList.contains('sp-hidden');
      if (ev.key === 'Escape' || (ev.key === 'Backspace' && ev.target.tagName !== 'INPUT')) {
        ev.preventDefault();
        if (helpOpen) {
          this.q('[data-sp="helpModal"]').classList.add('sp-hidden');
        } else if (sourceOpen) {
          this.q('[data-sp="sourceModal"]').classList.add('sp-hidden');
        } else {
          this.close();
        }
        return;
      }

      if (ev.target.tagName === 'INPUT' || helpOpen || sourceOpen) return;

      if (ev.key === 'p' || ev.key === 'P' || ev.key === ' ') {
        ev.preventDefault();
        this.togglePlayPause();
        return;
      }
      if (ev.key === 'm' || ev.key === 'M') {
        ev.preventDefault();
        this.toggleQuadView();
        return;
      }
      if (ev.key === 'f' || ev.key === 'F') {
        ev.preventDefault();
        this.toggleFullscreen();
        return;
      }

      if (ev.key === 'ArrowDown' && this.filtered.length) {
        ev.preventDefault();
        this.focusedVirtualIndex = (this.focusedVirtualIndex + 1) % this.filtered.length;
        this.scrollChannelIntoView(this.focusedVirtualIndex);
        return;
      }
      if (ev.key === 'ArrowUp' && this.filtered.length) {
        ev.preventDefault();
        this.focusedVirtualIndex = (this.focusedVirtualIndex - 1 + this.filtered.length) % this.filtered.length;
        this.scrollChannelIntoView(this.focusedVirtualIndex);
        return;
      }
      if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        this.stepChannel(1);
        return;
      }
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        this.stepChannel(-1);
        return;
      }
      if (ev.key === 'Enter' && this.filtered[this.focusedVirtualIndex]) {
        ev.preventDefault();
        if (document.activeElement && document.activeElement !== document.body && !document.activeElement.hasAttribute('data-sp-idx')) {
          document.activeElement.click();
          return;
        }
        this.playChannel(this.filtered[this.focusedVirtualIndex], this.focusedVirtualIndex);
      }
    }

    open(initialChannel = null) {
      this.mount();
      this.isOpen = true;
      this.mountEl.hidden = false;
      this.mountEl.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';

      this.syncFromBridge();
      this.startTelemetryLoop();

      const target = initialChannel || this.currentChannel || this.filtered[0] || null;
      if (target) {
        const idx = this.filtered.findIndex((c) => String(c.stream_id) === String(target.stream_id));
        if (idx >= 0) this.scrollChannelIntoView(idx);
        this.playChannel(target, idx);
      }
    }

    close() {
      this.isOpen = false;
      this.stopTelemetryLoop();
      this.destroyPlayer();
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
      this.mountEl.hidden = true;
      this.mountEl.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    }
  }

  // Browser bootstrap inside #streampulse-module without mutating root globals
  if (typeof document !== 'undefined') {
    const boot = () => {
      const container = document.getElementById('streampulse-module');
      if (!container) return;
      const instance = new StreamPulseController(container);
      rootGlobal.StreamPulse = {
        open: (ch) => instance.open(ch),
        close: () => instance.close(),
        isOpen: () => instance.isOpen,
        instance
      };

      document.querySelectorAll('[data-open-streampulse]').forEach((btn) => {
        btn.addEventListener('click', () => instance.open());
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  // Export pure helpers & controller for Node.js automated test suite
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      computeVirtualRange,
      computeBackoffMs,
      parseM3uPlaylist,
      StreamPulseController
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
