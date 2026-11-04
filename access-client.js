/* Private-access client. The server reserves time atomically; the player must stop
 * when its lease expires. Direct provider traffic never goes through Vercel.
 * This is a personal-use guard, not DRM against a determined modified client.
 */
(function (root) {
  'use strict';
  function viewerId() {
    try {
      let id = sessionStorage.getItem('onda-viewer-id');
      if (!id) {
        id = root.crypto.randomUUID ? root.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16);
        });
        sessionStorage.setItem('onda-viewer-id', id);
      }
      return id;
    } catch { return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }
  }
  function minutes(seconds) {
    const total = Math.max(0, Math.ceil(seconds / 60));
    const h = Math.floor(total / 60), m = total % 60;
    return h ? `${h} h${m ? ' ' + String(m).padStart(2, '0') : ''}` : `${m} min`;
  }
  class AccessClient {
    constructor() {
      this.viewerId = viewerId(); this.snapshot = null; this.active = false;
      this.lease = null; this.offset = 0; this.timer = null; this.deadlineTimer = null;
      this.generation = 0; this.pending = null; this.lastRefresh = 0; this.metadata = null; this.handoffPending = false;
      root.addEventListener('onda:access-updated', () => this.render());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { if (!this.handoffPending) this.stop('Lecture arrêtée : application en arrière-plan.'); }
        else if (Date.now() - this.lastRefresh > 60000) this.refresh();
      });
      root.addEventListener('pagehide', () => { if (!this.handoffPending) this.stop('', false); });
      if (document.readyState === 'loading' || document.readyState === 'interactive') document.addEventListener('DOMContentLoaded', () => { this.refresh(); this.render(); }, { once: true });
      else { this.refresh(); this.render(); }
    }
    async request(path, options = {}) {
      const response = await fetch(path, {
        ...options, cache: 'no-store', credentials: 'same-origin',
        headers: { 'X-Onda-Request': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        signal: options.signal || AbortSignal.timeout(8000)
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('Le contrôle d’accès est indisponible.'); }
      if (response.status === 401 && path !== '/api/auth') {
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
      }
      if (!response.ok) {
        if (data.policy && data.usage) this.accept(data);
        const error = new Error(data.error || 'Contrôle d’accès indisponible.'); error.code = data.code; throw error;
      }
      return data;
    }
    accept(data) {
      if (data.policy && data.usage) {
        this.snapshot = { policy: data.policy, usage: data.usage };
        this.lastRefresh = Date.now();
        root.dispatchEvent(new CustomEvent('onda:access-updated', { detail: this.snapshot }));
      }
    }
    async refresh() {
      try { this.accept(await this.request('/api/access')); }
      catch (error) { root.dispatchEvent(new CustomEvent('onda:access-error', { detail: error.message })); }
    }
    async tvHandoff() {
      const metadata = this.metadata || {};
      const data = await this.request('/api/access', {
        method: 'POST', headers: metadata.headers || {},
        body: JSON.stringify({ action: 'tv_handoff', viewerId: this.viewerId })
      });
      this.handoffPending = true; this.active = false; this.generation++;
      clearTimeout(this.timer); clearTimeout(this.deadlineTimer);
      return data;
    }
    async acquire(metadata = {}) {
      this.metadata = metadata;
      this.handoffPending = false;
      this.active = true;
      const generation = ++this.generation;
      if (this.pending) {
        try { await this.pending; } catch { /* the newest request reports its own error */ }
        if (!this.active || generation !== this.generation) throw new Error('Lecture annulée.');
      }
      if (this.lease && this.lease.expiresAt - this.offset - Date.now() > 15000 && this.lease.streamId == metadata.streamId) return this.lease.urls;
      const promise = this.request('/api/access', {
        method: 'POST', headers: metadata.headers || {},
        body: JSON.stringify({ action: 'lease', viewerId: this.viewerId, ...(metadata.streamId != null ? { streamId: metadata.streamId } : {}) })
      });
      this.pending = promise;
      try {
        const data = await promise;
        if (!this.active || generation !== this.generation) throw new Error('Lecture annulée.');
        this.accept(data);
        this.offset = data.lease.serverNow - Date.now();
        this.lease = { ...data.lease, streamId: metadata.streamId, urls: data.urls || (metadata.streamId == null ? { direct: true } : null) };
        if (!this.lease.urls) throw new Error('Adresse de lecture manquante.');
        this.schedule();
        return this.lease.urls;
      } catch (error) {
        if (generation === this.generation) this.stop(error.message);
        throw error;
      } finally { if (this.pending === promise) this.pending = null; }
    }
    schedule() {
      clearTimeout(this.timer); clearTimeout(this.deadlineTimer);
      const remaining = this.lease.expiresAt - this.offset - Date.now();
      if (remaining <= 0) { this.stop('Quota atteint : la lecture est arrêtée.'); return; }
      this.timer = setTimeout(() => this.renew(), Math.max(250, remaining - 10000));
      this.deadlineTimer = setTimeout(() => this.stop('Quota atteint : la lecture est arrêtée.'), remaining + 100);
    }
    async renew() {
      if (!this.active) return;
      const generation = this.generation;
      const metadata = this.metadata || {};
      try {
        const data = await this.request('/api/access', {
          method: 'POST', headers: metadata.headers || {},
          body: JSON.stringify({ action: 'lease', viewerId: this.viewerId, ...(metadata.streamId != null ? { streamId: metadata.streamId } : {}) })
        });
        if (!this.active || generation !== this.generation) return;
        this.accept(data); this.offset = data.lease.serverNow - Date.now();
        this.lease = { ...data.lease, streamId: metadata.streamId, urls: data.urls || this.lease.urls };
        this.schedule();
      } catch (error) { if (this.active && generation === this.generation) this.stop(error.message || 'Lecture arrêtée : contrôle d’accès indisponible.'); }
    }
    valid() { return this.active && this.lease && Date.now() + this.offset < this.lease.expiresAt; }
    stop(message = '', notify = true) {
      const wasActive = this.active;
      this.active = false; this.generation++; this.lease = null; this.metadata = null;
      clearTimeout(this.timer); clearTimeout(this.deadlineTimer);
      if (wasActive) {
        this.request('/api/access', { method: 'POST', keepalive: true, body: JSON.stringify({ action: 'release', viewerId: this.viewerId }) }).catch(() => {});
      }
      if (notify) root.dispatchEvent(new CustomEvent('onda:access-stop', { detail: message }));
    }
    async logout() {
      this.stop('', false);
      try { await this.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'logout', viewerId: this.viewerId }) }); }
      finally { location.replace('/login.html'); }
    }
    render() {
      const mount = document.getElementById('streampulse-module');
      if (!mount) return;
      const s = this.snapshot;
      const badge = mount.querySelector('[data-sp="budgetBadge"]');
      if (badge) badge.textContent = s ? `${minutes(s.usage.dayRemainingSeconds)} restantes` : 'Mode privé';
      const day = mount.querySelector('[data-sp="budgetDay"]');
      const month = mount.querySelector('[data-sp="budgetMonth"]');
      const hours = mount.querySelector('[data-sp="budgetHours"]');
      const dayFill = mount.querySelector('[data-sp="budgetDayFill"]');
      const monthFill = mount.querySelector('[data-sp="budgetMonthFill"]');
      if (!s) { if (hours) hours.textContent = 'Chargement du quota sécurisé…'; return; }
      if (day) day.textContent = `${minutes(s.usage.dayRemainingSeconds)} restantes / ${minutes(s.policy.dailyMinutes * 60)}`;
      if (month) month.textContent = `${minutes(s.usage.monthRemainingSeconds)} restantes / ${minutes(s.policy.monthlyMinutes * 60)}`;
      if (hours) hours.textContent = `Lecture de ${s.policy.startHour} h à ${s.policy.endHour === 24 ? 'minuit' : s.policy.endHour + ' h'} (UTC, heure du Burkina Faso). Vidéo directe : aucun octet vidéo ne transite par Vercel.`;
      if (dayFill) dayFill.style.width = `${Math.min(100, s.usage.dayUsedSeconds / (s.policy.dailyMinutes * 60) * 100)}%`;
      if (monthFill) monthFill.style.width = `${Math.min(100, s.usage.monthUsedSeconds / (s.policy.monthlyMinutes * 60) * 100)}%`;
    }
  }
  root.ONDA_ACCESS = new AccessClient();
  root.addEventListener('onda:access-updated', () => root.ONDA_ACCESS.render());
})(window);
