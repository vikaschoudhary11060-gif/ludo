/* Leaderboard — live ranking from the API. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money } = K;
  const PER = 8;
  let rows = [], page = 1, meRow = null;
  const MEDAL = { 1:'bg-gold text-ink', 2:'bg-silver text-ink', 3:'bg-[#cd7f32] text-white' };

  function renderPodium() {
    const top = rows.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    $('#lb-podium').innerHTML = order.map(p => {
      const h = p.rank === 1 ? 'h-28' : p.rank === 2 ? 'h-24' : 'h-20';
      return `<li class="flex w-1/3 max-w-[110px] flex-col items-center gap-1.5">
        <span class="grid h-11 w-11 place-items-center rounded-full ${MEDAL[p.rank]} text-body font-bold">${p.rank}</span>
        <span class="w-full truncate text-center text-meta font-bold text-ink">${p.name}</span>
        <span class="flex ${h} w-full flex-col items-center justify-center rounded-t-tile bg-brand/10 px-1">
          <span class="text-h3 font-bold text-brand">${p.wins}</span>
          <span class="text-[11px] uppercase text-muted">wins</span>
        </span></li>`;
    }).join('');
  }

  function render() {
    renderPodium();
    const pages = Math.max(1, Math.ceil(rows.length / PER));
    page = Math.min(page, pages);
    $('#lb-rows').innerHTML = rows.slice((page-1)*PER, page*PER).map(p =>
      `<tr class="transition-colors hover:bg-surface-page">
        <td class="px-3 py-3"><span class="grid h-7 w-7 place-items-center rounded-full ${MEDAL[p.rank] || 'bg-surface-page text-muted-dark'} text-meta font-bold">${p.rank}</span></td>
        <td class="px-3 py-3 text-body font-medium text-ink">${p.name}</td>
        <td class="px-3 py-3 text-right text-body font-bold text-cta">${p.wins}</td>
      </tr>`).join('');
    $('#lb-page').textContent = page; $('#lb-pages').textContent = pages;
    $('#lb-prev').disabled = page === 1; $('#lb-next').disabled = page === pages;
    $('#me-rank').textContent = meRow ? meRow.rank : 'NR';
  }

  async function load(range) {
    try {
      const data = await Api.leaderboard(range);
      rows = data.leaders; meRow = data.me;
    } catch { rows = []; meRow = null; }
    page = 1; render();
  }

  K.ready.then(async () => {
    await load('today');
    K.revealAfter('#lb-skeleton', '#lb-content');
    $('#lb-status').textContent = 'Leaderboard loaded';
    $$('[data-range]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-range]').forEach(b => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-selected', String(b === btn)); });
      load(btn.dataset.range);
    }));
    $('#lb-prev').addEventListener('click', () => { page--; render(); });
    $('#lb-next').addEventListener('click', () => { page++; render(); });
  });
})();
