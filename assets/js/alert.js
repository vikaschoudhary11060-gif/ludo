/* ============================================================
   Match alerts — the two moments a player must not miss.

     1. A host learns an opponent has turned up.
     2. An opponent learns the host has started the match.

   Both happen while the player is very likely looking at
   something else, so an alert is a banner, a sound and a buzz
   rather than a line of text that scrolls past.

   The tone is synthesised rather than loaded: an audio file is
   another request that can 404, be blocked by the service worker
   or arrive after the moment has passed. Two sine notes through
   WebAudio always play, offline included.
   ============================================================ */
(function () {
  'use strict';

  let ctx = null;
  let unlocked = false;

  /* Browsers only let audio start from a user gesture, and the gesture that
     matters here happened minutes ago — the tap that created or joined the
     battle. So the context is built and resumed on the first interaction of
     the page and kept warm for when the alert actually fires. */
  function unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = ctx || new AC();
      if (ctx.state === 'suspended') ctx.resume();
      unlocked = true;
    } catch { /* no audio on this device; the banner still shows */ }
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, unlock, { once: true, passive: true }));

  /** Two short notes. `rising` is the "good news" shape used for both events. */
  function chime(rising = true) {
    if (!ctx) unlock();
    if (!ctx || ctx.state !== 'running') return false;
    const notes = rising ? [660, 990] : [990, 660];
    const start = ctx.currentTime;
    notes.forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      /* Normal listening volume, and ramped rather than switched — a square
         start on a phone speaker clicks loudly enough to be unpleasant. */
      const at = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.2);
    });
    return true;
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
  }

  let host = null;
  function banner(title, body) {
    if (!host) {
      host = document.createElement('div');
      host.className =
        'pointer-events-none fixed inset-x-0 top-[68px] z-[95] mx-auto flex w-full max-w-app flex-col items-center gap-2 px-4';
      host.setAttribute('role', 'alert');
      host.setAttribute('aria-live', 'assertive');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    /* brand-dark is a fixed colour rather than a theme token: `ink` flips to a
       near-white in dark mode, which would put white text on a white banner. */
    el.className =
      'pointer-events-auto flex w-full items-start gap-3 rounded-card border-l-4 border-gold ' +
      'bg-brand-dark px-4 py-3 text-white shadow-card';
    el.style.transition = 'opacity .25s, transform .25s';
    el.innerHTML =
      '<span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gold/30 text-[15px]">🔔</span>' +
      '<span class="min-w-0 flex-1"><strong class="block text-body font-bold"></strong>' +
      '<span class="mt-0.5 block text-body-sm text-white/85"></span></span>' +
      '<button class="shrink-0 px-1 text-white/70 hover:text-white" type="button" aria-label="Dismiss">✕</button>';
    // textContent, never innerHTML: `body` carries an opponent's chosen name.
    el.querySelector('strong').textContent = title;
    el.querySelector('strong + span').textContent = body || '';

    const close = () => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 260);
    };
    el.querySelector('button').addEventListener('click', close);
    host.appendChild(el);
    /* Eight seconds: long enough to catch someone glancing back at the phone,
       short enough not to sit over the board. */
    setTimeout(close, 8000);
    return el;
  }

  /** The whole alert: banner, sound, buzz. Safe to call from any page. */
  function fire(title, body, opts = {}) {
    banner(title, body);
    chime(opts.falling !== true);
    buzz(opts.pattern || [120, 60, 120]);
  }

  window.KhelbroAlert = { fire, chime, unlock, get ready() { return unlocked; } };
})();
