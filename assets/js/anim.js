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

  function countUp(el, to, opts = {}) {
    if (reduce) { el.textContent = opts.money ? rupee(to) : Math.round(to); return; }
    const from = Number(el.dataset.value || 0);
    if (from === to) return;
    el.dataset.value = to;
    const dur = 600, start = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      el.textContent = opts.money ? rupee(val) : Math.round(val);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = opts.money ? rupee(to) : Math.round(to);
    };
    requestAnimationFrame(tick);
    // pop the element on increase
    if (to > from) { el.classList.remove('animate-coin'); void el.offsetWidth; el.classList.add('animate-coin'); }
  }

  /* Watch the header money boxes; when app.js updates them, animate. */
  function watchMoney() {
    document.querySelectorAll('[data-bind="cash"],[data-bind="winnings"],[data-bind="earning"],[data-bind="balance"],[data-bind="won"]')
      .forEach(el => {
        const parse = () => Number((el.textContent || '').replace(/[^\d.]/g, '')) || 0;
        el.dataset.value = parse();
        const mo = new MutationObserver(() => {
          const next = parse();
          if (next !== Number(el.dataset.value)) {
            const target = next;
            // reset text so countUp animates from the stored value
            countUp(el, target, { money: /₹/.test(el.textContent) || true });
          }
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

  /* ---------- confetti (self-contained, ~40 lines) ---------- */
  function confetti(opts = {}) {
    if (reduce) return;
    const colors = ['#e33d3d', '#28a745', '#f0b429', '#2d68c4', '#f4bc41', '#ffffff'];
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:120';
    canvas.width = innerWidth; canvas.height = innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const N = opts.count || 160;
    const parts = Array.from({ length: N }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: innerHeight / 3,
      vx: (Math.random() - 0.5) * 12,
      vy: Math.random() * -14 - 4,
      r: Math.random() * 6 + 3,
      c: colors[(Math.random() * colors.length) | 0],
      rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.4,
    }));
    let frame = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts.forEach(p => {
        p.vy += 0.4; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6);
        ctx.restore();
      });
      if (++frame < 160) requestAnimationFrame(draw);
      else canvas.remove();
    };
    draw();
  }

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

  window.KhelbroAnim = { confetti, countUp, stagger: applyStagger, ripple: wireRipples };
})();
