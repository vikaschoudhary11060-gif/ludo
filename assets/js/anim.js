/* ============================================================
   Khelbro — micro-interactions and animations

   All effects are progressive: with prefers-reduced-motion the
   page still works, elements just appear instantly. Loaded on
   every page, after app.js.
   ============================================================ */
(function () {
  'use strict';

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- staggered entrance for lists & cards ----------
     Any container marked data-stagger animates its direct children
     in, one after another. A MutationObserver re-applies it to
     content rendered later (battle lists, history rows, etc.). */
  function stagger(container) {
    if (reduce) return;
    const kids = Array.from(container.children);
    kids.forEach((el, i) => {
      if (el.dataset.revealed) return;
      el.dataset.revealed = '1';
      el.style.animation = 'none';
      el.style.opacity = '0';
      // one paint later so the transition actually runs
      requestAnimationFrame(() => {
        el.style.animation = `reveal .4s cubic-bezier(.22,.61,.36,1) both`;
        el.style.animationDelay = Math.min(i * 45, 400) + 'ms';
      });
    });
  }

  function applyStagger(root = document) {
    root.querySelectorAll('[data-stagger]').forEach(stagger);
  }

  /* ---------- reveal-on-scroll for sections ---------- */
  function revealOnScroll() {
    if (reduce || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('animate-reveal');
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));
  }

  /* ---------- material-style ripple on buttons ---------- */
  function ripple(e) {
    if (reduce) return;
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = document.createElement('span');
    span.className = 'kb-ripple';
    span.style.width = span.style.height = size + 'px';
    span.style.left = (e.clientX - rect.left - size / 2) + 'px';
    span.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
  }
  function wireRipples(root = document) {
    root.querySelectorAll('.btn, .btn-play, .chip').forEach(b => {
      if (b.dataset.ripple) return;
      b.dataset.ripple = '1';
      if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
      b.style.overflow = 'hidden';
      b.addEventListener('pointerdown', ripple);
    });
  }

  /* ---------- count-up for money / stat numbers ----------
     Elements bound by app.js (data-bind="cash" etc.) get their
     text set directly; we animate the transition when the value
     actually changes. */
  const rupee = n => '₹' + Math.round(n).toLocaleString('en-IN');

  /* One run token per element. Retargeting an element mid-flight bumps the
     token so the older frame loop stops instead of fighting the new one. */
  const runToken = new WeakMap();

  function countUp(el, to, opts = {}) {
    const onWrite = opts.onWrite || (() => {});
    const onDone = opts.onDone || (() => {});
    const put = v => {
      const text = opts.money ? rupee(v) : String(Math.round(v));
      el.textContent = text;
      onWrite(text);
    };
    const token = (runToken.get(el) || 0) + 1;
    runToken.set(el, token);

    if (reduce) { el.dataset.value = to; put(to); onDone(); return; }
    const from = Number(el.dataset.value || 0);
    if (from === to) { onDone(); return; }
    el.dataset.value = to;
    const dur = 600, start = performance.now();
    const tick = now => {
      if (runToken.get(el) !== token) { onDone(); return; }   // superseded by a newer value
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) { put(from + (to - from) * eased); requestAnimationFrame(tick); }
      else { put(to); onDone(); }
    };
    requestAnimationFrame(tick);
    // pop the element on increase — no forced reflow
    if (to > from) {
      el.classList.remove('animate-coin');
      requestAnimationFrame(() => el.classList.add('animate-coin'));
    }
  }

  /* Watch the header money boxes; when app.js updates them, animate.

     countUp rewrites the text on every frame, and each of those writes is
     itself a mutation. Without `mine` the observer read a half-finished
     frame as a brand-new balance and started animating towards it, so the
     loops chased each other and the box settled on a number the user never
     had. Comparing against the exact string we last wrote tells our own
     frames apart from a real update by app.js. */
  function watchMoney() {
    document.querySelectorAll('[data-bind="cash"],[data-bind="winnings"],[data-bind="earning"],[data-bind="referral"],[data-bind="balance"],[data-bind="won"]')
      .forEach(el => {
        const money = el.getAttribute('data-bind') !== 'won';
        const parse = () => Number((el.textContent || '').replace(/[^\d.]/g, '')) || 0;
        el.dataset.value = parse();
        let animating = false;
        const mo = new MutationObserver(() => {
          if (animating) return;                              // skip our own frames
          const next = parse();
          if (next === Number(el.dataset.value)) return;
          animating = true;
          countUp(el, next, { money, onWrite: () => {}, onDone: () => { animating = false; } });
        });
        mo.observe(el, { childList: true, characterData: true, subtree: true });
      });
  }

  /* ---------- shake on inline form errors ---------- */
  function watchErrors() {
    if (reduce) return;
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        const el = m.target;
        if (el.nodeType === 1 && el.matches('.field-error') && !el.dataset.shook) {
          el.dataset.shook = '1';
          el.classList.add('animate-shake');
          setTimeout(() => { el.classList.remove('animate-shake'); delete el.dataset.shook; }, 450);
        }
      }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  /* ---------- particle bursts ----------

     One canvas, one loop, one set of options. Every moment worth marking is a
     preset rather than its own effect, so adding one costs a line of config
     and no new code path — and there is only ever one animation loop to get
     wrong. The canvas is created on demand and removed when the last particle
     dies, so nothing is retained between bursts. */

  /* The four Ludo colours are the app's own, so a goti on the canvas matches
     the board in the scene above it. */
  const LUDO = ['#e33d3d', '#28a745', '#f0b429', '#2d68c4'];
  const PALETTE = {
    party: [...LUDO, '#f4bc41', '#ffffff'],
    gold:  ['#f4bc41', '#e0a020', '#ffd54f'],
    money: ['#0db25b', '#28a745', '#7bc47f'],
    ludo:  LUDO,
    tears: ['#7fb2ff', '#4d8fe8', '#bcd8ff'],
  };

  /* ---------- scenes ----------
     A scene is one click-through element on a fixed stage, animated entirely
     in CSS (see .kb-* in input.css) so the browser can composite it without
     the main thread, then removed. The JS only builds the markup and sets a
     timer — there is no second animation loop. */
  function showScene(html, hold = 1500) {
    if (reduce || document.hidden) return;
    const stage = document.createElement('div');
    stage.className = 'kb-stage';
    stage.setAttribute('aria-hidden', 'true');
    stage.innerHTML = `<div class="kb-scene">${html}</div>`;
    document.body.appendChild(stage);
    setTimeout(() => {
      stage.firstElementChild?.classList.add('kb-scene--out');
      setTimeout(() => stage.remove(), 400);
    }, hold);
  }

  /* A Ludo board: four homes, the cross, the centre, and four goti hopping
     one after another. Drawn as SVG so it stays sharp at any size and costs
     no request. */
  const board = () => {
    const homes = [[6, 6], [56, 6], [6, 56], [56, 56]];
    const goti = [[16, 16], [66, 16], [16, 66], [66, 66]];
    return `<svg class="kb-board" width="164" height="164" viewBox="0 0 90 90" aria-hidden="true">
      <rect width="90" height="90" rx="9" fill="#fff"/>
      ${homes.map(([x, y], i) =>
        `<rect x="${x}" y="${y}" width="28" height="28" rx="5" fill="${LUDO[i]}"/>`).join('')}
      <rect x="36" y="2" width="18" height="86" fill="#fff"/>
      <rect x="2" y="36" width="86" height="18" fill="#fff"/>
      <path d="M45 36 54 45 45 54 36 45z" fill="#f0b429"/>
      ${goti.map(([x, y], i) =>
        `<circle class="kb-goti" style="animation-delay:${i * 150}ms" cx="${x}" cy="${y}" r="6"
                 fill="#fff" stroke="${LUDO[i]}" stroke-width="3"/>`).join('')}
    </svg>`;
  };

  /* The room code, a colour per digit — easier to read back a digit at a time
     while typing it into Ludo King, which is the only thing it is for. */
  const digits = (opts = {}) => {
    const code = String(opts.text || '').trim();
    if (!code) return '';
    return `<div class="rounded-card bg-white/95 px-5 py-4 text-center shadow-card">
      <p class="text-[11px] font-bold uppercase tracking-wide text-muted">Room code</p>
      <p class="mt-1 font-display text-[38px] font-black leading-none tracking-[0.12em]">${
        [...code].map((ch, i) =>
          `<span class="kb-digit" style="color:${LUDO[i % LUDO.length]};animation-delay:${i * 80}ms">${ch}</span>`
        ).join('')}</p>
    </div>`;
  };

  const sadFace = () => '<span class="kb-sad" style="font-size:86px;line-height:1">😢</span>';

  /* count, life and gravity are the only knobs that affect cost. Everything
     here is deliberately small: the win burst is the one indulgence, the rest
     are brief accents. */
  const PRESETS = {
    // 200 and 150 frames: unchanged from the confetti this replaced, so the
    // win moment looks exactly as it did before.
    win:      { n: 200, colors: PALETTE.party, shape: 'rect', rise: 14, gravity: 0.40, life: 150 },
    deposit:  { n: 40,  colors: PALETTE.gold,  shape: 'coin', rise: 11, gravity: 0.28, life: 105, from: 'bottom' },
    /* Short on purpose: the withdraw page navigates to transactions 600ms
       after the request lands, so a longer burst would only ever be seen
       half-played. ~34 frames is about 560ms. */
    withdraw: { n: 26,  colors: PALETTE.money, shape: 'note', rise: 4,  gravity: 0.5,  life: 34, from: 'top' },
    // The board is the scene; the goti scatter out of it.
    start:    { scene: board, hold: 1500,
                n: 22,  colors: PALETTE.ludo,  shape: 'goti', rise: 10, gravity: 0.34, life: 95 },
    // Just the digits — particles would only compete with the number the
    // player is trying to read and type into Ludo King.
    code:     { scene: digits, hold: 2200 },
    // Tears fall from the face itself, not from the top of the screen.
    loss:     { scene: sadFace, hold: 1600,
                n: 16,  colors: PALETTE.tears, shape: 'tear', rise: 1, gravity: 0.30, life: 95, atY: 0.44 },
  };

  /* Every shape is canvas primitives — no images to load, no sprite sheet to
     ship. Each runs inside a save/restore, so a shape may change fillStyle
     without leaking into the next particle. */
  function paint(ctx, p, shape) {
    const r = p.r;
    if (shape === 'coin') {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, 6.28); ctx.fill();
      return;
    }
    if (shape === 'note') {                      // a banknote, seen edge-on as it tumbles
      const w = r * 2.8, h = r * 1.6;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w - 4, 1.2);
      ctx.beginPath(); ctx.arc(0, 0, h * 0.24, 0, 6.28); ctx.fill();
      return;
    }
    if (shape === 'goti') {                      // a Ludo pawn: round head, flared body
      const g = r * 0.6;
      ctx.beginPath();
      ctx.moveTo(-g, g * 1.7); ctx.lineTo(g, g * 1.7);
      ctx.lineTo(g * 0.45, -g * 0.2); ctx.lineTo(-g * 0.45, -g * 0.2);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -g, g * 0.8, 0, 6.28); ctx.fill();
      return;
    }
    if (shape === 'tear') {                      // point up, bulge below
      const d = r * 0.65;
      ctx.beginPath();
      ctx.moveTo(0, -d * 1.9);
      ctx.quadraticCurveTo(d, -d * 0.1, 0, d);
      ctx.quadraticCurveTo(-d, -d * 0.1, 0, -d * 1.9);
      ctx.fill();
      return;
    }
    ctx.fillRect(-r / 2, -r / 2, r, r * 1.6);
  }

  function burst(opts = {}) {
    /* Nothing to watch, or the viewer asked for stillness. Skipping while
       hidden also stops a backgrounded tab queueing frames it cannot draw. */
    if (reduce || document.hidden) return;

    const o = { n: 60, colors: PALETTE.party, shape: 'rect', rise: 12, gravity: 0.4, life: 130, from: 'center', ...opts };
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:120';
    canvas.width = innerWidth; canvas.height = innerHeight;
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const originY = o.atY != null ? innerHeight * o.atY
      : o.from === 'top' ? -20 : o.from === 'bottom' ? innerHeight + 20 : innerHeight / 3;
    const spread = o.from === 'center' ? 120 : innerWidth;
    const parts = Array.from({ length: o.n }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * spread,
      y: originY,
      vx: (Math.random() - 0.5) * (o.from === 'center' ? 12 : 5),
      vy: o.from === 'bottom' ? -Math.random() * o.rise - 6
        : o.from === 'top' ? Math.random() * o.rise
        : Math.random() * -o.rise - 4,
      r: Math.random() * 6 + 3,
      c: o.colors[(Math.random() * o.colors.length) | 0],
      rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.4,
    }));

    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Fade the last fifth, so particles leave rather than vanish.
      ctx.globalAlpha = Math.min(1, (o.life - frame) / (o.life * 0.2));
      for (const p of parts) {
        p.vy += o.gravity; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        paint(ctx, p, o.shape);
        ctx.restore();
      }
      if (++frame < o.life) requestAnimationFrame(draw);
      else canvas.remove();
    };
    draw();
  }

  /** Mark a moment by name. Unknown names do nothing — a typo at a call site
      must not throw in the middle of a payout or a deposit.
      `opts` carries anything the scene needs, e.g. the room code text. */
  function celebrate(kind, opts = {}) {
    const p = PRESETS[kind];
    if (!p) return;
    if (p.scene) showScene(p.scene(opts), p.hold);
    if (p.n) burst(p);
  }

  // Kept for the existing win call site.
  const confetti = (opts = {}) => burst({ ...PRESETS.win, ...opts, n: opts.count || PRESETS.win.n });

  document.addEventListener('DOMContentLoaded', () => {
    applyStagger();
    wireRipples();
    revealOnScroll();
    watchMoney();
    watchErrors();

    // Re-apply to dynamically inserted content.
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('[data-stagger]')) stagger(node);
          if (node.parentElement && node.parentElement.hasAttribute('data-stagger')) stagger(node.parentElement);
          wireRipples(node);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });

  window.KhelbroAnim = { confetti, celebrate, burst, countUp, stagger: applyStagger, ripple: wireRipples };
})();
