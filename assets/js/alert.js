/* ============================================================
   Match alerts — the two moments a player must not miss.

     1. A host learns an opponent has turned up.
     2. An opponent learns the host has started the match.

   Both happen while the player is very likely looking at
   something else — usually the Ludo app — so an alert rings for
   five seconds rather than making one sound they can miss while
   the phone is face down.

   The tone is synthesised rather than loaded: an audio file is
   another request that can 404, be blocked by the service worker
   or arrive after the moment has passed. Sine notes through
   WebAudio always play, offline included.
   ============================================================ */
(function () {
  'use strict';

  /* How long the alert keeps ringing. */
  const ALERT_MS = 5000;
  /* One two-note chirp every 620ms — a rhythm that reads as "answer me"
     rather than a single ping that is over before a phone is picked up. */
  const PERIOD = 0.62;

  let ctx = null;
  let unlocked = false;
  let ringing = [];          // oscillators currently scheduled
  let stopTimer = null;

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
      unlocked = ctx.state === 'running';
    } catch { /* no audio on this device; the banner still shows */ }
  }

  /* Not `once: true`: the first gesture can land while the tab is still
     loading and leave the context suspended, and on iOS a context can be
     suspended again whenever the page is backgrounded. Re-running on every
     gesture is cheap and keeps it live. */
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, unlock, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx && ctx.state === 'suspended') unlock();
  });

  /** Silence an alert that is still ringing. */
  function stop() {
    clearTimeout(stopTimer);
    stopTimer = null;
    for (const osc of ringing) {
      try { osc.stop(); } catch { /* already finished */ }
      try { osc.disconnect(); } catch {}
    }
    ringing = [];
    try { if (navigator.vibrate) navigator.vibrate(0); } catch {}
  }

  /** Ring for `ms`. Returns false when audio is unavailable. */
  function ring(ms = ALERT_MS) {
    if (!ctx || ctx.state !== 'running') unlock();
    if (!ctx || ctx.state !== 'running') return false;

    // A second alert replaces the first rather than layering on top of it.
    stop();

    const start = ctx.currentTime;
    const seconds = ms / 1000;
    /* Scheduled on the audio clock in one go, not driven by setInterval: a
       timer drifts, and a backgrounded tab throttles it to once a second or
       stops it altogether — exactly when the alert matters most. */
    for (let at = 0; at < seconds; at += PERIOD) {
      [660, 990].forEach((hz, i) => {
        const t = at + i * 0.16;
        if (t >= seconds) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        /* Normal listening volume, and ramped rather than switched — a square
           start on a phone speaker clicks loudly enough to be unpleasant. */
        const from = start + t;
        gain.gain.setValueAtTime(0.0001, from);
        gain.gain.exponentialRampToValueAtTime(0.4, from + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, from + 0.15);
        osc.connect(gain).connect(ctx.destination);
        osc.start(from);
        osc.stop(from + 0.18);
        ringing.push(osc);
      });
    }
    // Clear the bookkeeping once the last note has played.
    stopTimer = setTimeout(() => { ringing = []; stopTimer = null; }, ms + 200);
    return true;
  }

  /** Buzz in the same rhythm, for the same duration. */
  function buzz(ms = ALERT_MS) {
    try {
      if (!navigator.vibrate) return;
      const pattern = [];
      for (let at = 0; at < ms; at += 620) pattern.push(300, 320);
      navigator.vibrate(pattern);
    } catch {}
  }

  let host = null;
  function banner(title, body, onDismiss) {
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
      if (onDismiss) onDismiss();
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 260);
    };
    el.querySelector('button').addEventListener('click', close);
    host.appendChild(el);
    /* Ten seconds: the ring lasts five, and the message has to still be on
       screen when someone picks the phone up because of it. */
    setTimeout(close, 10000);
    return el;
  }

  /** The whole alert: banner, five seconds of sound, five seconds of buzz. */
  function fire(title, body, opts = {}) {
    const ms = Number(opts.ms) > 0 ? Number(opts.ms) : ALERT_MS;
    // Dismissing the banner stops the noise — it is the same interruption.
    banner(title, body, stop);
    ring(ms);
    buzz(ms);
  }

  window.KhelbroAlert = {
    fire, ring, stop, unlock, ALERT_MS,
    get ready() { return unlocked; },
  };
})();
