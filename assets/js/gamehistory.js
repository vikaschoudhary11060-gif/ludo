/* Game history — from the API, filtered and paged. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money } = K;
  const PER = 8;
  let filter = 'all', page = 1, all = [], rows = [];

  const STYLE = { completed:'bg-cta/15 text-cta-deep', cancelled:'bg-live/15 text-live',
                  running:'bg-gold/25 text-gold-deep', waiting:'bg-brand/15 text-brand',
                  open:'bg-surface-page text-muted-dark', disputed:'bg-live/15 text-live' };

  function apply() {
    rows = all.filter(b => filter === 'all' ? true
      : filter === 'running' ? ['running','waiting','open'].includes(b.status)
      : b.status === filter);
  }

  function card(b) {
    const me = K.state.user;
    const opp = (b.creator && me && b.creator.id === me.id) ? (b.acceptor && b.acceptor.name) : b.creator.name;
    const iWon = b.winnerId && me && b.winnerId === me.id;
    const delta = b.status !== 'completed' ? ''
      : iWon ? `+${money(b.payout)}` : `-${money(b.amount)}`;
    return `<li><a class="block rounded-[5px] border border-line bg-surface p-3 transition hover:border-brand"
                   href="battle.html?id=${b.id}">
      <div class="flex items-center justify-between">
        <span class="rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase ${STYLE[b.status] || ''}">${b.status}</span>
        <span class="text-meta text-muted">${new Date(b.createdAt).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <span class="flex-1 truncate text-body font-bold text-ink">vs ${opp || 'waiting…'}</span>
        <span class="text-body font-black text-ink">${money(b.amount)}</span>
      </div>
      ${delta ? `<p class="mt-1 text-meta font-bold ${iWon ? 'text-cta' : 'text-live'}">${delta}</p>` : ''}
    </a></li>`;
  }

  function render() {
    const pages = Math.max(1, Math.ceil(rows.length / PER));
    page = Math.min(page, pages);
    $('#gh-list').innerHTML = rows.slice((page-1)*PER, page*PER).map(card).join('');
    $('#gh-empty').hidden = rows.length > 0;
    $('#gh-page').textContent = page; $('#gh-pages').textContent = pages;
    $('#gh-prev').disabled = page === 1; $('#gh-next').disabled = page === pages;
  }

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    try { all = (await Api.battles.mine()).battles; } catch { all = []; }
    apply(); K.revealAfter('#gh-skeleton', '#gh-content'); render();

    $$('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-filter]').forEach(b => b.classList.toggle('is-active', b === btn));
      filter = btn.dataset.filter; page = 1; apply(); render();
    }));
    $('#gh-prev').addEventListener('click', () => { page--; render(); });
    $('#gh-next').addEventListener('click', () => { page++; render(); });
  });
})();
