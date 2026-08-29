/* ============================================================
   Khelbro — PWA installation and update handling.

   Registers the service worker, surfaces the browser's install
   prompt as our own button (Chrome fires it once and it cannot
   be re-requested), and offers a reload when a new build lands.
   ============================================================ */
(function () {
  'use strict';
  if (location.protocol === 'file:') return;

  let deferredPrompt = null;

  /* ---------- registration + update flow ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            // A new version is ready and an old one is still controlling the page.
            if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg);
          });
        });
      } catch { /* offline support is optional; never block the app */ }
    });
  }

  function showUpdateBar(reg) {
    if (document.getElementById('sw-update')) return;
    const bar = document.createElement('div');
    bar.id = 'sw-update';
    bar.className =
      'fixed inset-x-0 bottom-0 z-[95] mx-auto flex w-full max-w-app items-center gap-3 ' +
      'border-t border-line bg-surface px-4 py-3 shadow-sheet';
    bar.innerHTML =
      '<span class="flex-1 text-body-sm text-ink">A new version is available.</span>' +
      '<button class="btn btn-primary !min-h-[38px] !px-4 !text-meta" type="button">Update</button>';
    bar.querySelector('button').addEventListener('click', () => {
      reg.waiting && reg.waiting.postMessage('skipWaiting');
      location.reload();
    });
    document.body.appendChild(bar);
  }

  /* ---------- install prompt ---------- */
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();               // we choose when to ask
    deferredPrompt = e;
    revealInstall();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstall();
    if (window.Khelbro) Khelbro.toast('Khelbro installed', 'success');
  });

  function revealInstall() {
    // Already running as an installed app? Nothing to offer.
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (localStorage.getItem('khelbro.installDismissed')) return;
    document.querySelectorAll('[data-install]').forEach(el => (el.hidden = false));
  }
  function hideInstall() {
    document.querySelectorAll('[data-install]').forEach(el => (el.hidden = true));
  }

  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome !== 'accepted') localStorage.setItem('khelbro.installDismissed', '1');
    hideInstall();
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-install-go]')) { e.preventDefault(); promptInstall(); }
    if (e.target.closest('[data-install-close]')) {
      e.preventDefault();
      localStorage.setItem('khelbro.installDismissed', '1');
      hideInstall();
    }
  });

  window.KhelbroPWA = { promptInstall, canInstall: () => !!deferredPrompt };
})();
