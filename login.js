(function () {
  'use strict';
  const form = document.getElementById('login-form');
  const password = document.getElementById('password');
  const error = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');
  function showError(message) { error.textContent = message; error.hidden = false; }
  function destination() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
    try {
      const target = new URL(next, location.origin);
      if (target.origin !== location.origin || target.pathname !== '/') return '/';
      return '/' + target.search + location.hash; // Preserve the QR fragment key; it is never sent to the server.
    } catch { return '/'; }
  }
  document.getElementById('toggle-password').addEventListener('click', event => {
    password.type = password.type === 'password' ? 'text' : 'password';
    event.currentTarget.textContent = password.type === 'password' ? 'Afficher' : 'Masquer';
    event.currentTarget.setAttribute('aria-label', password.type === 'password' ? 'Afficher le mot de passe' : 'Masquer le mot de passe');
  });
  fetch('/api/auth', { cache: 'no-store' }).then(r => r.json()).then(data => {
    if (data.authenticated) location.replace(destination());
    else if (!data.configured) showError('Configuration à terminer : le propriétaire doit définir les variables privées et le stockage Redis dans Vercel, puis redéployer.');
  }).catch(() => showError('Connexion impossible. Vérifiez votre réseau et réessayez.'));
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.hidden = true; submit.disabled = true; submit.textContent = 'Ouverture de votre espace…';
    try {
      const response = await fetch('/api/auth', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Onda-Request': '1' },
        body: JSON.stringify({ password: password.value }), signal: AbortSignal.timeout(10000)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Connexion impossible.');
      password.value = ''; location.replace(destination());
    } catch (err) { showError(err.name === 'TimeoutError' ? 'Le serveur met trop de temps à répondre. Réessayez.' : err.message); }
    finally { submit.disabled = false; submit.textContent = 'Ouvrir mon espace →'; }
  });
})();
