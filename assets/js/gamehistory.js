/* Game history — from the API, filtered and paged. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money } = K;
  const PER = 8;
  let filter = 'all', page = 1, all = [], rows = [];

  const STYLE = { completed:'bg-cta/15 text-cta-deep', cancelled:'bg-live/15 text-live',
                  running:'bg-gold/25 text-gold-deep', waiting:'bg-brand/15 text-brand',
                  open:'bg-surface-page text-muted-dark', disputed:'bg-live/15 text-live' };

  /* Was this battle ever actually a match?

     A player who sets a battle and calls it straight off has not played
     anything — the stake went out and came back and nothing happened in
     between. Those rows are noise here, and there can be a lot of them. The
     room code is the line: once it is shared the two players are in a Ludo
     room, so a cancellation after that point is a real event with a real
     story and belongs in the history.

     `roomSetAt` survives cancellation (cancel only writes status and the
     reason), so it stays a reliable marker after the fact. */
  const everStarted = b => !!(b.roomSetAt || b.roomCode);
  const isNoise = b => b.status === 'cancelled' && !everStarted(b);

  function apply() {
    rows = all.filter(b => filter === 'all' ? true
      : filter === 'running' ? ['running','waiting','open'].includes(b.status)
      : b.status === filter);
  }

  /* Balances are omitted for a battle whose ledger rows fell outside the
     window the server reconstructs from, so both have to be present before
     the line is worth drawing. */
  function balanceLine(b) {
    const open = b.openingBalance, close = b.closingBalance;
    if (!Number.isFinite(open) || !Number.isFinite(close)) return '';
    const diff = close - open;
    const tone = diff > 0 ? 'text-cta' : diff < 0 ? 'text-live' : 'text-muted';
    return `<div class="mt-2 flex items-center justify-between border-t border-line pt-2 text-[10.5px]">
      <span class="text-muted">Opening <span class="font-bold text-ink">${money(open)}</span></span>
      <span class="font-bold ${tone}">${diff > 0 ? '+' : ''}${money(diff)}</span>
      <span class="text-muted">Closing <span class="font-bold text-ink">${money(close)}</span></span>
    </div>`;
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
      ${balanceLine(b)}
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
    let list = [];
    try {
      list = (await Api.battles.history()).battles;
    } catch {
      /* An older server has no /history. Fall back to the plain list so the
         page still works — it just shows no balances. */
      try { list = (await Api.battles.mine()).battles; } catch { list = []; }
    }
    all = list.filter(b => !isNoise(b));
    apply(); K.revealAfter('#gh-skeleton', '#gh-content'); render();

    $$('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-filter]').forEach(b => b.classList.toggle('is-active', b === btn));
      filter = btn.dataset.filter; page = 1; apply(); render();
    }));
    $('#gh-prev').addEventListener('click', () => { page--; render(); });
    $('#gh-next').addEventListener('click', () => { page++; render(); });
  });
})();
