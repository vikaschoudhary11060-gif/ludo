/* Transaction ledger — from the API. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money } = K;
  /* `Api.warm` may be absent for one navigation after a deploy: the service
     worker keeps api.js in its cached shell and serves it stale-while-
     revalidate, so a fresh copy of THIS file can be paired with the previous
     api.js. Falling back to calling the function directly is exactly what this
     page did before warming existed, so the worst case is the old timing —
     never a broken page. */
  const warm = (window.Api && Api.warm) || (fn => fn);
  /* Issued now instead of after /api/auth/me and /api/config, neither of
     which this request depends on. Gated on the token, the same condition
     requireSession() resolves to, so a signed-out visitor still issues
     nothing. Only the first call is served from the warm one. */
  const getTransactions = Api.isLoggedIn()
    ? warm(() => Api.wallet.transactions())
    : () => Api.wallet.transactions();

  let filter = 'all', all = [];

  function row(t) {
    const credit = t.type === 'credit';
    const bonus = /bonus|cashback/i.test(t.note || '');
    const tone = t.status === 'pending' ? 'text-gold-deep' : credit ? 'text-cta' : 'text-live';
    return `<li class="flex items-center gap-3 rounded-tile border border-line bg-surface p-3">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full ${credit ? 'bg-cta/15 text-cta' : 'bg-live/15 text-live'}"
            aria-hidden="true">${bonus ? '🎁' : credit ? '↓' : '↑'}</span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-body font-bold text-ink">${t.note || (credit ? 'Credit' : 'Debit')}</span>
        <span class="block text-meta text-muted">
          ${new Date(t.created_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
          · ${t.bucket}${t.status === 'pending' ? ' · pending' : ''}
        </span>
      </span>
      <span class="text-body font-black ${tone}">${credit ? '+' : '−'}${money(t.amount)}</span>
    </li>`;
  }

  function render() {
    const rows = all.filter(t => filter === 'all' ? true
      : filter === 'bonus' ? /bonus|cashback/i.test(t.note || '') : t.type === filter);
    $('#tx-list').innerHTML = rows.map(row).join('');
    $('#tx-empty').hidden = rows.length > 0;
  }

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    try { all = (await getTransactions()).transactions; } catch { all = []; }
    K.revealAfter('#tx-skeleton', '#tx-content'); render();
    $$('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-filter]').forEach(b => b.classList.toggle('is-active', b === btn));
      filter = btn.dataset.filter; render();
    }));
  });
})();
