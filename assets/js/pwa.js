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

  /* ---------- version + update flow ----------
     build.py hashes the shipped assets into sw.js, so any real deploy produces
     a new service worker. When one lands we activate it and reload, so nobody
     keeps running last week's JavaScript against this week's API.

     The one thing we never interrupt is an action in flight — reloading over a
     submit could lose a result the player believes they sent. */

  const RELOAD_FLAG = 'khelbro.swReloaded';
  const UPDATE_EVERY_MS = 15 * 60 * 1000;

  /** True while something the user started is still running. */
  const busy = () =>
    !!document.querySelector('[aria-busy="true"], [data-update-hold]') ||
    !!(document.activeElement && document.activeElement.matches('input, textarea, select'));

  function applyUpdate(reg) {
    if (reg.waiting) reg.waiting.postMessage('skipWaiting');
  }

  function onNewVersion(reg) {
    // Defer while the user is mid-action; the bar lets them take it manually.
    if (busy()) { showUpdateBar(reg); return; }
    applyUpdate(reg);
    showUpdateBar(reg);      // visible for the moment before the reload lands
  }

  /* The authoritative staleness check: compare the build baked into this page
     against the one the server is serving now. Independent of service workers,
     so it also covers browsers where they are unavailable or blocked. */
  async function serverBuild() {
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()).build || null;
    } catch { return null; }
  }

  async function checkForNewBuild() {
    const mine = window.KHELBRO_BUILD;
    if (!mine) return false;                       // page predates versioning
    const latest = await serverBuild();
    if (!latest || latest === mine) return false;

    if (busy()) { showUpdateBar(null); return true; }   // never interrupt an action
    await refreshToLatest();
    return true;
  }

  /** Drop the stale caches and reload onto the current build. */
  async function refreshToLatest() {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;    // never loop
    sessionStorage.setItem(RELOAD_FLAG, '1');
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) { applyUpdate(reg); await reg.update().catch(() => {}); }
      // Purge caches so the reload cannot be answered from the old build.
      if (window.caches) await Promise.all((await caches.keys()).map(k => caches.delete(k)));
    } catch { /* fall through to the reload regardless */ }
    location.reload();
  }

  if ('serviceWorker' in navigator) {
    // The new worker taking control is the signal that fresh code is ready.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem(RELOAD_FLAG)) return;   // never loop
      sessionStorage.setItem(RELOAD_FLAG, '1');
      location.reload();
    });

    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        sessionStorage.removeItem(RELOAD_FLAG);          // this load is the fresh one

        // A worker already waiting from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) onNewVersion(reg);

        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            // A new version is ready and an old one is still controlling the page.
            if (sw.state === 'installed' && navigator.serviceWorker.controller) onNewVersion(reg);
          });
        });

        /* A tab left open for days would otherwise never re-check. Ask on a
           timer and whenever the user comes back to it. */
        const check = () => {
          if (!navigator.onLine) return;
          reg.update().catch(() => {});
          checkForNewBuild();
        };
        setInterval(check, UPDATE_EVERY_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
        window.addEventListener('online', check);
        check();                                   // and once on this load
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
      if (reg) applyUpdate(reg);
      refreshToLatest();
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

  if (!('serviceWorker' in navigator)) {
    window.addEventListener('load', () => {
      checkForNewBuild();
      setInterval(checkForNewBuild, UPDATE_EVERY_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewBuild(); });
    });
  }

  window.KhelbroPWA = {
    promptInstall,
    canInstall: () => !!deferredPrompt,
    /** Ask now whether this page is stale, and refresh if it is. */
    checkForNewBuild,
    /** The build this page was served as — stamped in by build.py. */
    build: () => window.KHELBRO_BUILD || null,
  };
})();
