/* ============================================================
   Khelbro — app shell (API-backed)

   Talks to the Node server in /server through api.js. There is no
   local mock any more: the signed-in user, wallet and battles all
   come from the API, and Socket.IO pushes changes between users.

   Pages wait on `Khelbro.ready` before rendering.
   ============================================================ */
(function () {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');

  /* Shared state, refreshed from the server. */
  const state = { user: null, wallet: null, stats: null, config: null, online: false };

  /* ---------------- toasts ---------------- */
  let toastHost;
  function toast(message, type = 'info', ms = 3200) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      // Sits below the 60px header so it never covers the balance boxes.
      toastHost.className =
        'pointer-events-none fixed inset-x-0 top-[68px] z-[80] mx-auto flex w-full max-w-app flex-col items-center gap-2 px-4';
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastHost);
    }
    // Literal class names, so Tailwind's scanner can see them. Building the
    // name as 'toast-' + type made these get purged and the toast rendered
    // with no background at all.
    const TONE = {
      success: 'toast toast-success',
      error:   'toast toast-error',
      info:    'toast toast-info',
    };
    const el = document.createElement('div');
    el.className = TONE[type] || TONE.info;
    const icon = { success: '✓', error: '!', info: 'i' }[type] || 'i';
    el.innerHTML =
      '<span class="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/25 text-[11px] font-black">' +
      icon + '</span><span class="flex-1"></span>';
    el.lastChild.textContent = String(message);
    toastHost.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  /* Run an async action with the button locked and a spinner label, so a slow
     network on a phone never looks like a dead tap. */
  async function busy(btn, label, fn) {
    if (!btn) return fn();
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML =
      `<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"></span>` +
      (label ? `<span class="ml-2">${label}</span>` : '');
    try { return await fn(); }
    finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.innerHTML = original;
    }
  }

  /* Copy helper with consistent feedback — used all over the app. */
  async function copy(text, label = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(label, 'success'); return true; }
    catch { toast('Copy failed — select it manually', 'error'); return false; }
  }

  /* ---------------- session ---------------- */
  async function refresh() {
    if (!window.Api || !Api.isLoggedIn()) { state.user = null; state.wallet = null; return null; }
    try {
      const data = await Api.auth.me();
      state.user = data.user;
      state.wallet = { ...data.wallet, total: data.wallet.deposit + data.wallet.winnings };
      state.stats = data.stats;
      return state.user;
    } catch (e) {
      if (e.status === 401) { state.user = null; state.wallet = null; }
      return null;
    }
  }

  function paint() {
    const inSession = !!state.user;
    // Revealing only after the first paint stops a signed-in user seeing the
    // signed-out screen flash on every page load.
    document.documentElement.setAttribute('data-session', inSession ? 'in' : 'out');
    $$('[data-when="in"]').forEach(el  => el.hidden = !inSession);
    $$('[data-when="out"]').forEach(el => el.hidden = inSession);
    if (!inSession) return;

    const w = state.wallet || { deposit: 0, winnings: 0, referral: 0, total: 0 };
    const set = (sel, v) => $$(`[data-bind="${sel}"]`).forEach(el => (el.textContent = v));
    set('cash', money(w.deposit));          // deposit — play money
    set('winnings', money(w.winnings));     // withdrawable
    set('referral', money(w.referral));     // referral commission
    /* `earning` predates the split and means the referral bucket on the
       profile, redeem and wallet screens. Kept so those keep working. */
    set('earning', money(w.referral));
    set('balance', money(w.total));
    set('name', state.user.name);
    set('phone', '+91 ' + state.user.phone);
    set('won', state.stats ? state.stats.won : 0);
    set('played', state.stats ? state.stats.played : 0);
    set('referralCode', state.user.referralCode || '—');
  }

  function logout() {
    Api.auth.logout();
    if (socket) socket.disconnect();
    toast('Logged out', 'success');
    setTimeout(() => (location.href = 'index.html'), 400);
  }

  /* Connection state is worth surfacing on a phone, where it changes often. */
  function watchConnection() {
    let wasOffline = !navigator.onLine;
    window.addEventListener('offline', () => { wasOffline = true; toast('You are offline', 'error', 5000); });
    window.addEventListener('online', () => {
      if (!wasOffline) return;
      wasOffline = false;
      toast('Back online', 'success');
      refresh().then(paint);
    });
  }

  /* ---------------- realtime ---------------- */
  let socket = null;
  let awaitingIo = false;
  const listeners = new Map();      // event -> Set(handler)
  /* Battles this page wants live updates for. Socket.IO rooms live on the
     server, so they are lost whenever the socket is replaced — and with
     socket.io.js loading async the socket often does not exist yet at the
     moment a page asks to watch. Re-sending this set on every connect covers
     both the late first load and every later reconnect. */
  const watched = new Set();

  const apiOrigin = () => window.KHELBRO_API || location.origin;

  function connect() {
    if (socket) return socket;
    /* socket.io.js is loaded async from the API host so a sleeping backend can
       never hold up the first paint. It may therefore land after boot — wire up
       the moment it arrives rather than dropping realtime for the whole page. */
    if (typeof window.io !== 'function') {
      const tag = document.querySelector('script[data-socket-io]');
      if (tag && !awaitingIo) {
        awaitingIo = true;
        tag.addEventListener('load', () => { awaitingIo = false; connect(); }, { once: true });
      }
      return null;
    }
    socket = window.io(apiOrigin(), {
      auth: { token: window.Api ? Api.token : null },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
    });
    socket.on('connect',    () => {
      state.online = true; setOnline(true);
      watched.forEach(id => socket.emit('battle:watch', { id }));
    });
    socket.on('disconnect', () => { state.online = false; setOnline(false); });
    socket.on('connect_error', () => { state.online = false; setOnline(false); });
    // fan every server event out to page subscribers
    ['battle:created', 'battle:removed', 'battle:updated', 'presence',
     'chat:message', 'chat:typing', 'chat:admin-online', 'chat:status'].forEach(ev =>
      socket.on(ev, payload => (listeners.get(ev) || []).forEach(fn => fn(payload))));
    return socket;
  }

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
  }

  function watchBattle(id) {
    watched.add(id);
    connect();
    // If the socket is not up yet the 'connect' handler replays the set.
    if (socket && socket.connected) socket.emit('battle:watch', { id });
  }
  function leaveBattle(id) {
    watched.delete(id);
    if (socket && socket.connected) socket.emit('battle:leave', { id });
  }

  /* A small dot in the header so the user can see the live link. */
  function setOnline(up) {
    let dot = $('#live-dot');
    if (!dot) {
      const header = $('.site-header');
      if (!header) return;
      dot = document.createElement('span');
      dot.id = 'live-dot';
      dot.className = 'absolute left-1/2 top-1 h-1.5 w-1.5 -translate-x-1/2 rounded-full transition-colors';
      dot.title = 'Live connection';
      header.appendChild(dot);
    }
    dot.classList.toggle('bg-cta', up);
    dot.classList.toggle('bg-live', !up);
    dot.setAttribute('aria-label', up ? 'Live updates connected' : 'Live updates offline');
  }

  /* ---------------- drawer ---------------- */
  function initDrawer() {
    const drawer = $('#drawer'), scrim = $('#scrim'), openBtn = $('#drawer-open');
    if (!drawer || !scrim || !openBtn) return;
    let lastFocused = null;
    const focusables = () =>
      $$('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])', drawer)
        .filter(el => el.offsetParent !== null);

    function open() {
      lastFocused = document.activeElement;
      drawer.classList.add('is-open'); scrim.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      openBtn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      (focusables()[0] || drawer).focus();
    }
    function close() {
      drawer.classList.remove('is-open'); scrim.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      openBtn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      if (lastFocused) lastFocused.focus();
    }
    openBtn.addEventListener('click', open);
    scrim.addEventListener('click', close);
    $$('[data-drawer-close]', drawer).forEach(el => el.addEventListener('click', close));
    document.addEventListener('keydown', e => {
      if (!drawer.classList.contains('is-open')) return;
      if (e.key === 'Escape') return close();
      if (e.key !== 'Tab') return;
      const list = focusables(); if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function initModals() {
    $$('[data-modal-open]').forEach(btn =>
      btn.addEventListener('click', () => {
        const m = document.getElementById(btn.dataset.modalOpen);
        if (m) { m.hidden = false; ($('button, a', m) || m).focus(); }
      }));
    $$('[data-modal-close]').forEach(btn =>
      btn.addEventListener('click', () => { btn.closest('[data-modal]').hidden = true; }));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $$('[data-modal]').forEach(m => { if (!m.hidden) m.hidden = true; });
    });
  }

  function markActiveNav() {
    const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    $$('a[href]').forEach(a => {
      const href = (a.getAttribute('href') || '').split('/').pop().split('#')[0].toLowerCase();
      if (href && href === here) a.setAttribute('aria-current', 'page');
    });
  }

  function revealAfter(skeletonSel, contentSel) {
    const sk = $(skeletonSel), content = $(contentSel);
    if (sk) sk.remove();
    if (content) { content.hidden = false; content.classList.add('animate-slide-up'); }
  }

  /* Pages that must not be seen signed-out. */
  function requireSession() {
    if (!state.user) { location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop())); return false; }
    return true;
  }

  /* Capture referral code from URL if present */
  function captureReferral() {
    try {
      const params = new URLSearchParams(location.search);
      const ref = (params.get('ref') || params.get('r') || params.get('referral') || '').trim();
      if (ref && /^[A-Za-z0-9_-]{3,25}$/.test(ref)) {
        localStorage.setItem('khelbro.referral', ref.toUpperCase());
      }
    } catch {}
  }

  /* ---------------- boot ---------------- */
  const ready = new Promise(resolve => {
    document.addEventListener('DOMContentLoaded', async () => {
      captureReferral();
      // The API host sleeps when idle; nudge it awake before anything needs it.
      if (window.Api && Api.wake) Api.wake();
      initDrawer(); initModals(); markActiveNav();
      $$('[data-year]').forEach(el => (el.textContent = new Date().getFullYear()));
      $$('[data-action="logout"]').forEach(b =>
        b.addEventListener('click', e => { e.preventDefault(); logout(); }));

      await refresh();
      paint();
      const pageSkeleton = $('#page-skeleton');
      if (pageSkeleton) pageSkeleton.remove();
      connect();
      watchConnection();
      resolve(state);
    });
  });

  window.Khelbro = {
    $, $$, money, toast, state, ready, refresh, paint, logout,
    revealAfter, requireSession, busy, copy,
    on, watchBattle, leaveBattle, connect,
    get socket() { return socket; },
  };
})();
