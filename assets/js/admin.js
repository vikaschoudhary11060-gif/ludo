/* ============================================================
   Khelbro admin console

   Standalone: does not use app.js or api.js. Talks to the admin
   API with a key held in sessionStorage for the tab's lifetime.
   ============================================================ */
(function () {
  'use strict';

  const API = (window.KHELBRO_API || '') + '/api';
  const IMG = window.KHELBRO_API || '';
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const when = ms => {
    if (!ms) return '—';
    const d = new Date(ms), diff = (Date.now() - ms) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  let TOKEN = sessionStorage.getItem('khelbro.adminToken') || '';
  let ME = null;
  const RANK = { viewer: 0, admin: 1, owner: 2 };
  const can = min => ME && RANK[ME.role] >= RANK[min];
  let range = '1d';
  let tab = 'overview';
  let gameStatus = '', depStatus = '', wdStatus = '', gameQuery = '';
  let autoTimer = null;

  /* ---------------- transport ---------------- */
  /* The API host answers 502/503/504 while it wakes from idle, which made the
     console look broken — a failed preflight blocks the real request, so login
     and dispute actions just died. Reads are safely repeatable and are ridden
     out; writes are never repeated, since a 502 cannot tell us whether the
     server already processed one. */
  const WAKING = new Set([502, 503, 504]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function call(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    const idempotent = !opts.method || opts.method.toUpperCase() === 'GET';
    const deadline = Date.now() + 45000;
    let res, attempt = 0;

    for (;;) {
      try {
        res = await fetch(API + path, { ...opts, headers });
      } catch (e) {
        if (!idempotent || Date.now() >= deadline) throw new Error('Cannot reach the server.');
        await sleep(Math.min(1000 * 2 ** attempt++, 5000));
        continue;
      }
      if (WAKING.has(res.status) && idempotent && Date.now() < deadline) {
        await sleep(Math.min(1000 * 2 ** attempt++, 5000));
        continue;
      }
      break;
    }

    if (WAKING.has(res.status)) throw new Error('The server is starting up. Try again in a moment.');
    const data = await res.json().catch(() => null);
    if (res.status === 401) { signOut(); throw new Error((data && data.error) || 'Session expired.'); }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }
  const q = extra => `?range=${range}${extra || ''}`;

  /* ---------------- toasts ---------------- */
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    const bg = { success: 'bg-cta-deep', error: 'bg-live', info: 'bg-ink' }[type] || 'bg-ink';
    el.className = `pointer-events-auto w-full rounded-lg ${bg} px-4 py-2.5 text-body-sm font-medium text-white shadow-card`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s'; el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, 2800);
  }

  const skeleton = rows => `<div class="space-y-2">${Array.from({ length: rows },
    () => '<div class="skeleton h-16 w-full rounded-tile"></div>').join('')}</div>`;
  const empty = msg => `<p class="rounded-card border border-line bg-surface p-10 text-center text-muted">${msg}</p>`;

  const STATUS_TONE = {
    open:'bg-surface-page text-muted-dark', waiting:'bg-brand/15 text-brand',
    running:'bg-gold/25 text-gold-deep', completed:'bg-cta/15 text-cta-deep',
    cancelled:'bg-live/10 text-live', disputed:'bg-live/20 text-live',
    pending:'bg-gold/25 text-gold-deep', approved:'bg-cta/15 text-cta-deep',
    paid:'bg-cta/15 text-cta-deep', rejected:'bg-live/15 text-live',
  };
  const pill = s => `<span class="rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase ${STATUS_TONE[s] || 'bg-surface-page text-muted-dark'}">${esc(s)}</span>`;
  const shot = p => p
    ? `<a href="${IMG + p}" target="_blank" rel="noopener" title="Open full size">
         <img src="${IMG + p}" alt="evidence" class="h-20 w-20 rounded-tile border border-line object-cover transition hover:scale-105"></a>`
    : '<span class="text-meta text-muted">no image</span>';

  /* ---------------- overview ---------------- */
  async function loadOverview() {
    $('#tab-overview').innerHTML = skeleton(2);
    const s = await call('/admin/stats' + q());
    const card = (label, value, sub, tone = 'text-ink') => `
      <div class="rounded-card border border-line bg-surface p-4">
        <p class="pill-label">${label}</p>
        <p class="mt-1 text-h2 font-bold ${tone}">${value}</p>
        ${sub ? `<p class="mt-0.5 text-meta text-muted">${sub}</p>` : ''}
      </div>`;

    $('#tab-overview').innerHTML = `
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        ${card('New players', s.users)}
        ${card('Games', s.battles.total, `${s.battles.completed} completed · ${s.battles.running} running`)}
        ${card('Commission earned', money(s.commission), 'from settled games', 'text-cta')}
        ${card('Needs attention', s.battles.disputed + s.deposits.pending + s.withdrawals.pending + s.kycPending,
               `${s.battles.disputed} disputes · ${s.kycPending} KYC`, 'text-live')}
      </div>

      <h2 class="mb-3 mt-6 text-title text-ink">Games by status</h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        ${['open','waiting','running','completed','disputed','cancelled']
          .map(k => `<button class="rounded-card border border-line bg-surface p-3 text-left transition hover:border-brand"
                             data-jump="${k}">
              <p class="pill-label">${k}</p>
              <p class="mt-1 text-h3 font-bold text-ink">${s.battles[k]}</p></button>`).join('')}
      </div>

      <h2 class="mb-3 mt-6 text-title text-ink">Money</h2>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        ${card('Deposit credits (ledger)', money(s.deposits.instant), 'every deposit credited to a wallet')}
        ${card('Deposits (verified UPI)', money(s.deposits.approved), `${s.deposits.pending} awaiting check`)}
        ${card('Withdrawals paid', money(s.withdrawals.paid))}
        ${card('Withdrawals pending', money(s.withdrawals.pendingValue), `${s.withdrawals.pending} request(s)`, 'text-gold-deep')}
      </div>`;

    /* Only the games badge comes from /stats. The queue badges are the
       inbox's, because /stats is scoped to the selected time range — a
       deposit still pending from last week vanished from the badge the
       moment somebody chose "1 day". */
    setCount('games', s.battles.total);
    pollInbox().catch(() => {});

    renderChart();       // M1
  }

  /* M1 — a responsive donut chart of the money split. Pure SVG, no deps. */
  async function renderChart() {
    let rev, pm;
    try { rev = await call('/admin/revenue' + q()); } catch { return; }
    try { pm = await call('/admin/pending-money'); } catch { pm = null; }

    // Donut segments: what the platform is holding / earned, over the range.
    const segs = [
      { label: 'Paid to winners', value: rev.totalPaidOut, color: '#0db25b' },
      { label: 'Commission', value: rev.grossCommission, color: '#2d68c4' },
      { label: 'Referral paid', value: rev.referralPaid, color: '#f4bc41' },
    ].filter(s => s.value > 0);
    const total = segs.reduce((a, s) => a + s.value, 0) || 1;

    // build stroke-dasharray arcs on a single circle
    const R = 80, C = 2 * Math.PI * R;
    let offset = 0;
    const arcs = segs.map(s => {
      const frac = s.value / total;
      const dash = `${(frac * C).toFixed(1)} ${(C - frac * C).toFixed(1)}`;
      const el = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${s.color}" stroke-width="30"
        stroke-dasharray="${dash}" stroke-dashoffset="${(-offset * C).toFixed(1)}"
        transform="rotate(-90 100 100)"><title>${s.label}: ${money(s.value)}</title></circle>`;
      offset += frac;
      return el;
    }).join('');

    const legend = segs.map(s => `<div class="flex items-center justify-between gap-3 py-1">
        <span class="flex items-center gap-2 text-body-sm text-ink"><span class="h-3 w-3 rounded-full" style="background:${s.color}"></span>${s.label}</span>
        <span class="text-body-sm font-bold text-ink">${money(s.value)}</span></div>`).join('');

    const host = document.createElement('section');
    host.className = 'mt-6';
    host.innerHTML = `
      <h2 class="mb-2 text-title text-ink">Money split (${rev.range})</h2>
      <div class="grid items-center gap-4 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
        <div class="mx-auto w-full max-w-[220px]">
          <svg viewBox="0 0 200 200" class="w-full" role="img" aria-label="Money split donut chart">
            ${arcs || '<circle cx="100" cy="100" r="80" fill="none" stroke="#e0e0e0" stroke-width="30"/>'}
            <text x="100" y="94" text-anchor="middle" class="fill-current" style="font:700 15px sans-serif;fill:rgb(var(--c-ink))">${money(rev.totalStaked)}</text>
            <text x="100" y="112" text-anchor="middle" style="font:500 10px sans-serif;fill:rgb(var(--c-muted))">total pot</text>
          </svg>
        </div>
        <div>
          ${legend || '<p class="text-meta text-muted">No settled games in this range.</p>'}
          <div class="mt-2 border-t border-line pt-2">
            <div class="flex items-center justify-between py-1"><span class="text-body-sm font-bold text-ink">Net revenue</span>
              <span class="text-body font-black text-cta">${money(rev.netRevenue)}</span></div>
          </div>
        </div>
      </div>
      ${pm ? `<div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        ${[['Open stakes',pm.openStakes],['Pending withdrawals',pm.pendingWithdrawals],['Pending deposits',pm.pendingDeposits],['In disputes',pm.disputed]]
          .map(([l,o])=>`<div class="rounded-card border border-line bg-surface p-3"><p class="pill-label">${l}</p><p class="mt-1 text-h3 font-bold text-ink">${money(o.v)}</p><p class="text-meta text-muted">${o.n} item(s)</p></div>`).join('')}
      </div>` : ''}`;
    $('#tab-overview').appendChild(host);
  }

  function setCount(name, n) {
    const el = document.querySelector(`[data-count="${name}"]`);
    if (!el) return;
    el.textContent = n > 0 ? n : '';
    el.style.display = n > 0 ? '' : 'none';
  }

  /* ---------------- games ---------------- */
  async function loadGames() {
    $('#games').innerHTML = skeleton(4);
    const { battles } = await call('/admin/battles' +
      q(`${gameStatus ? '&status=' + gameStatus : ''}${gameQuery ? '&q=' + encodeURIComponent(gameQuery) : ''}`));

    if (!battles.length) { $('#games').innerHTML = empty('No games in this range.'); return; }

    $('#games').innerHTML = `
      <div class="sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-accent-head text-left text-brand-dark">
            <th class="px-3 py-2.5 font-bold">Game</th>
            <th class="px-3 py-2.5 font-bold">Players</th>
            <th class="px-3 py-2.5 font-bold">Amount</th>
            <th class="px-3 py-2.5 font-bold">Status</th>
            <th class="px-3 py-2.5 font-bold">Room</th>
            <th class="px-3 py-2.5 font-bold">When</th>
            <th class="px-3 py-2.5"></th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${battles.map(b => `
              <tr class="hover:bg-surface-page">
                <td data-label="Game" class="px-3 py-2.5 font-mono text-[11px] text-muted">#${b.id.slice(-6)}</td>
                <td data-label="Players" class="px-3 py-2.5">
                  <span class="font-bold text-ink">${esc(b.creator_name)}</span>
                  <span class="text-muted"> vs </span>
                  <span class="font-bold text-ink">${esc(b.acceptor_name || '—')}</span>
                  ${b.winner_id ? `<span class="ml-1 text-[11px] font-bold text-cta">
                     ${esc(b.winner_id === b.creator_id ? b.creator_name : b.acceptor_name)} won</span>` : ''}
                </td>
                <td data-label="Amount" class="px-3 py-2.5 font-black text-ink">${money(b.amount)}</td>
                <td data-label="Status" class="px-3 py-2.5">${pill(b.status)}</td>
                <td data-label="Room" class="px-3 py-2.5 font-mono text-[11px]">${esc(b.room_code || '—')}</td>
                <td data-label="When" class="px-3 py-2.5 text-muted">${when(b.created_at)}</td>
                <td data-label="" class="rtable-actions px-3 py-2.5 text-right">
                  ${b.claims.length ? `<button class="text-[11px] font-bold text-brand hover:underline" data-expand="${b.id}">Claims (${b.claims.length})</button>` : ''}
                </td>
              </tr>
              <tr hidden data-detail="${b.id}"><td colspan="7" class="bg-surface-page px-3 py-3">
                <div class="flex flex-wrap gap-4">
                  ${b.claims.map(c => `<div class="rounded-tile border border-line bg-surface p-3">
                    <p class="pill-label">${esc(c.user_id === b.creator_id ? b.creator_name : b.acceptor_name)}</p>
                    <p class="text-body font-bold text-ink">claim: ${esc(c.claim)}</p>
                    ${c.reason ? `<p class="text-meta text-muted">${esc(c.reason)}</p>` : ''}
                    <div class="mt-2">${shot(c.proof)}</div></div>`).join('')}
                </div></td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="mt-2 text-meta text-muted">${battles.length} game(s) shown.</p>`;
  }

  /* ---------------- disputes ---------------- */
  async function loadDisputes() {
    $('#disputes').innerHTML = skeleton(2);
    const { disputes } = await call('/admin/disputes' + q());
    if (!disputes.length) { $('#disputes').innerHTML = empty('No disputes in this range.'); return; }

    $('#disputes').innerHTML = disputes.map(d => `
      <article class="mb-3 rounded-card border border-line bg-surface p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-h3 font-bold text-ink">${money(d.amount)}</span>
          <span class="text-meta text-muted">#${d.id.slice(-6)} · room ${esc(d.room_code) || '—'} · ${when(d.created_at)}</span>
        </div>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          ${[['Creator', d.creator_id, d.creator_name], ['Acceptor', d.acceptor_id, d.acceptor_name]].map(([role, uid, name]) => {
            const c = d.claims.find(x => x.user_id === uid);
            return `<div class="rounded-tile border border-line p-3">
              <p class="pill-label">${role}</p>
              <p class="text-body font-bold text-ink">${esc(name)}</p>
              <p class="mt-1 text-body-sm">claim: <strong class="uppercase">${esc(c ? c.claim : 'none')}</strong></p>
              ${c && c.reason ? `<p class="text-meta text-muted">${esc(c.reason)}</p>` : ''}
              <div class="mt-2">${shot(c && c.proof)}</div></div>`;
          }).join('')}
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="btn btn-primary !min-h-[36px] !px-4 !text-meta" data-resolve="${d.id}" data-outcome="creator">Award ${esc(d.creator_name)}</button>
          <button class="btn btn-primary !min-h-[36px] !px-4 !text-meta" data-resolve="${d.id}" data-outcome="acceptor">Award ${esc(d.acceptor_name || 'acceptor')}</button>
          <button class="btn btn-outline !min-h-[36px] !px-4 !text-meta" data-resolve="${d.id}" data-outcome="refund">Refund both</button>
        </div>
      </article>`).join('');
  }

  /* ---------------- deposits ---------------- */
  async function loadDeposits() {
    $('#deposits').innerHTML = skeleton(3);
    const { requests, instant } = await call('/admin/deposits/all' + q(depStatus ? '&status=' + depStatus : ''));

    const reqTable = requests.length ? `
      <div class="sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-accent-head text-left text-brand-dark">
            <th class="px-3 py-2.5 font-bold">Player</th><th class="px-3 py-2.5 font-bold">Amount</th>
            <th class="px-3 py-2.5 font-bold">Method</th><th class="px-3 py-2.5 font-bold">UTR / Ref</th>
            <th class="px-3 py-2.5 font-bold">Proof</th><th class="px-3 py-2.5 font-bold">Status</th>
            <th class="px-3 py-2.5 font-bold">When</th><th class="px-3 py-2.5"></th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${requests.map(d => `<tr class="hover:bg-surface-page">
              <td data-label="Player" class="px-3 py-2.5"><span class="font-bold text-ink">${esc(d.name)}</span>
                  <span class="block text-meta text-muted">${esc(d.phone)}</span></td>
              <td data-label="Amount" class="px-3 py-2.5 font-black text-ink">${money(d.amount)}</td>
              <td data-label="Method" class="px-3 py-2.5"><span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${d.method === 'bank' ? 'bg-brand/15 text-brand' : 'bg-cta/15 text-cta-deep'}">${d.method === 'bank' ? 'Bank Transfer' : 'UPI'}</span></td>
              <td data-label="UTR / Ref" class="px-3 py-2.5 font-mono text-[11px]">${esc(d.utr)}</td>
              <td data-label="Proof" class="px-3 py-2.5">${shot(d.proof)}</td>
              <td data-label="Status" class="px-3 py-2.5">${pill(d.status)}</td>
              <td data-label="When" class="px-3 py-2.5 text-muted">${when(d.created_at)}</td>
              <td data-label="" class="rtable-actions px-3 py-2.5 text-right">${d.status === 'pending' ? `
                <button class="btn btn-primary !min-h-[32px] !px-3 !text-[11px]" data-dep="${d.id}" data-approve="1">Approve</button>
                <button class="btn btn-outline !min-h-[32px] !px-3 !text-[11px]" data-dep="${d.id}" data-approve="0">Reject</button>` : ''}</td>
            </tr>`).join('')}
          </tbody></table></div>` : empty('No deposit requests in this range.');

    const instantList = instant.length ? `
      <div class="mt-4 sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-surface-page text-left text-muted-dark">
            <th class="px-3 py-2.5 font-bold">Player</th><th class="px-3 py-2.5 font-bold">Amount</th>
            <th class="px-3 py-2.5 font-bold">Type</th><th class="px-3 py-2.5 font-bold">When</th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${instant.map(t => `<tr class="hover:bg-surface-page">
              <td data-label="Player" class="px-3 py-2.5"><span class="font-bold text-ink">${esc(t.name)}</span>
                  <span class="block text-meta text-muted">${esc(t.phone)}</span></td>
              <td data-label="Amount" class="px-3 py-2.5 font-black text-cta">${money(t.amount)}</td>
              <td data-label="Type" class="px-3 py-2.5 text-muted">${esc(t.note)}</td>
              <td data-label="When" class="px-3 py-2.5 text-muted">${when(t.created_at)}</td></tr>`).join('')}
          </tbody></table></div>` : '';

    $('#deposits').innerHTML =
      `<h2 class="mb-2 text-title text-ink">UPI requests (need verification)</h2>${reqTable}
       <h2 class="mb-2 mt-6 text-title text-ink">Deposit credits on the ledger</h2>${instantList || empty('None in this range.')}`;
  }

  /* ---------------- withdrawals ---------------- */
  async function loadWithdrawals() {
    $('#withdrawals').innerHTML = skeleton(3);
    const { withdrawals } = await call('/admin/withdrawals' + q(wdStatus ? '&status=' + wdStatus : ''));
    if (!withdrawals.length) { $('#withdrawals').innerHTML = empty('No withdrawals in this range.'); return; }

    $('#withdrawals').innerHTML = `
      <div class="sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-accent-head text-left text-brand-dark">
            <th class="px-3 py-2.5 font-bold">Player</th><th class="px-3 py-2.5 font-bold">Amount</th>
            <th class="px-3 py-2.5 font-bold">Pay to</th><th class="px-3 py-2.5 font-bold">KYC</th>
            <th class="px-3 py-2.5 font-bold">Status</th><th class="px-3 py-2.5 font-bold">When</th>
            <th class="px-3 py-2.5"></th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${withdrawals.map(w => `<tr class="hover:bg-surface-page">
              <td data-label="Player" class="px-3 py-2.5"><span class="font-bold text-ink">${esc(w.name)}</span>
                  <span class="block text-meta text-muted">${esc(w.phone)}</span></td>
              <td data-label="Amount" class="px-3 py-2.5 font-black text-ink">${money(w.amount)}</td>
              <td data-label="Pay to" class="px-3 py-2.5 text-[11px]">${w.method === 'upi'
                  ? `<span class="font-mono">${esc(w.upi_id)}</span>`
                  : `${esc(w.account_name)}<br><span class="font-mono">${esc(w.account_number)} · ${esc(w.ifsc)}</span>`}</td>
              <td data-label="KYC" class="px-3 py-2.5">${w.kyc_status === 'done'
                  ? '<span class="text-cta">✓</span>' : `<span class="text-live">${esc(w.kyc_status)}</span>`}</td>
              <td data-label="Status" class="px-3 py-2.5">${pill(w.status)}</td>
              <td data-label="When" class="px-3 py-2.5 text-muted">${when(w.created_at)}</td>
              <td data-label="" class="rtable-actions px-3 py-2.5 text-right">${w.status === 'pending' ? `
                <button class="btn btn-primary !min-h-[32px] !px-3 !text-[11px]" data-wd="${w.id}" data-approve="1">Mark paid</button>
                <button class="btn btn-outline !min-h-[32px] !px-3 !text-[11px]" data-wd="${w.id}" data-approve="0">Reject</button>` : ''}</td>
            </tr>`).join('')}
          </tbody></table></div>
      <p class="mt-2 text-meta text-muted">Rejecting returns the amount to the player's winnings.</p>`;
  }

  /* ---------------- kyc ---------------- */
  async function loadKyc() {
    $('#kyc').innerHTML = skeleton(2);
    const { pending } = await call('/admin/kyc');
    if (!pending.length) { $('#kyc').innerHTML = empty('Nothing pending.'); return; }
    $('#kyc').innerHTML = pending.map(u => `
      <article class="mb-3 rounded-card border border-line bg-surface p-4">
        <p class="text-body font-bold text-ink">${esc(u.legal_name || u.name)}</p>
        <p class="text-meta text-muted">${esc(u.name)} · ${esc(u.phone)}</p>
        <div class="mt-3 flex flex-wrap gap-2">${u.documents.length
          ? u.documents.map(d => `<figure class="text-center">${shot(d.path)}
              <figcaption class="mt-1 text-[10px] uppercase text-muted">${esc(d.slot)}</figcaption></figure>`).join('')
          : '<span class="text-meta text-muted">no documents uploaded</span>'}</div>
        <div class="mt-3 flex gap-2">
          <button class="btn btn-primary !min-h-[36px] !px-4 !text-meta" data-kyc="${u.id}" data-approve="1">Approve</button>
          <button class="btn btn-outline !min-h-[36px] !px-4 !text-meta" data-kyc="${u.id}" data-approve="0">Reject</button>
        </div>
      </article>`).join('');
  }


  /* ---------------- players ---------------- */
  async function loadPlayers() {
    $('#player-detail').hidden = true;
    $('#players').hidden = false;
    const q = ($('#player-q') && $('#player-q').value.trim()) || '';
    $('#players').innerHTML = skeleton(4);
    const { players } = await call('/admin/players' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!players.length) { $('#players').innerHTML = empty('No players found.'); return; }
    $('#players').innerHTML = `
      <div class="sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-accent-head text-left text-brand-dark">
            <th class="px-3 py-2.5 font-bold">Player</th><th class="px-3 py-2.5 font-bold">Balance</th>
            <th class="px-3 py-2.5 font-bold">KYC</th><th class="px-3 py-2.5 font-bold">Joined</th><th class="px-3 py-2.5"></th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${players.map(u => `<tr class="cursor-pointer hover:bg-surface-page" data-player="${u.id}">
              <td data-label="Player" class="px-3 py-2.5"><span class="font-bold text-ink">${esc(u.name)}</span>
                  <span class="block text-meta text-muted">${esc(u.phone)} · #${u.id}${u.banned?' · <span class="text-live">banned</span>':''}</span></td>
              <td data-label="Balance" class="px-3 py-2.5 font-black text-ink">${money(u.deposit+u.winnings)}</td>
              <td data-label="KYC" class="px-3 py-2.5">${pill(u.kyc_status)}</td>
              <td data-label="Joined" class="px-3 py-2.5 text-muted">${when(u.created_at)}</td>
              <td data-label="" class="rtable-actions px-3 py-2.5 text-right">
                <button class="text-[11px] font-bold text-brand hover:underline" data-player="${u.id}">View</button></td>
            </tr>`).join('')}
          </tbody></table></div>`;
  }

  async function openPlayer(id) {
    const d = await call('/admin/players/' + id);
    const p = d.player, w = d.wallet, st = d.stats;
    $('#players').hidden = true;
    const det = $('#player-detail');
    det.hidden = false;
    det.innerHTML = `
      <button class="link-muted mb-3 inline-flex items-center gap-1" type="button" id="player-back">‹ Back to players</button>
      <div class="rounded-card border border-line bg-surface p-4">
        <div class="flex flex-wrap items-center gap-3">
          <span class="grid h-12 w-12 place-items-center rounded-full bg-brand text-h3 font-bold text-white">${esc(p.name.slice(0,1))}</span>
          <div class="flex-1">
            <p class="text-title text-ink">${esc(p.name)} ${p.banned?'<span class="rounded-full bg-live/15 px-2 py-0.5 text-[10px] font-bold uppercase text-live">banned</span>':''}
              ${d.watch?'<span class="rounded-full bg-gold/25 px-2 py-0.5 text-[10px] font-bold uppercase text-gold-deep">watched</span>':''}</p>
            <p class="text-meta text-muted">${esc(p.phone)} · #${p.id} · ${esc(p.email||'no email')} · joined ${when(p.createdAt)}</p>
          </div>
        </div>
        <div class="mt-4 grid grid-cols-3 gap-2 text-center">
          <div class="rounded-tile bg-surface-page p-2"><p class="pill-label">Deposit</p><p class="font-bold text-ink">${money(w.deposit)}</p></div>
          <div class="rounded-tile bg-surface-page p-2"><p class="pill-label text-cta">Winnings</p><p class="font-bold text-cta">${money(w.winnings)}</p></div>
          <div class="rounded-tile bg-surface-page p-2"><p class="pill-label">Referral</p><p class="font-bold text-ink">${money(w.referral)}</p></div>
        </div>
        <div class="mt-3 grid grid-cols-4 gap-2 text-center text-meta text-muted">
          <div><span class="block font-bold text-ink">${st.played}</span>played</div>
          <div><span class="block font-bold text-ink">${st.won}</span>won</div>
          <div><span class="block font-bold text-ink">${st.winRate}%</span>win rate</div>
          <div><span class="block font-bold text-ink">${money(st.deposited)}</span>deposited</div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2" data-min-role="admin">
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta" data-padjust="${p.id}">Adjust wallet</button>
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta" data-pset="${p.id}">Set balance</button>
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta" data-plogout="${p.id}">Force logout</button>
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta" data-pwatch="${p.id}" data-on="${d.watch?0:1}">${d.watch?'Unwatch':'Watch'}</button>
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta !text-live" data-pban="${p.id}" data-on="${p.banned?0:1}">${p.banned?'Unban':'Ban'}</button>
        </div>
      </div>

      <div class="mt-3 rounded-card border border-line bg-surface p-4">
        <div class="mb-3 flex items-center justify-between">
          <p class="text-body font-bold text-ink">Match &amp; Battle History (${d.recentGames.length})</p>
          <span class="text-meta text-muted">${st.won} won / ${st.played} played (${st.winRate}% win rate)</span>
        </div>
        ${d.recentGames && d.recentGames.length ? `
          <div class="overflow-x-auto">
            <table class="rtable w-full border-collapse text-body-sm">
              <thead><tr class="bg-accent-head text-left text-brand-dark">
                <th class="px-2.5 py-2 font-bold">Match</th>
                <th class="px-2.5 py-2 font-bold">Opponent</th>
                <th class="px-2.5 py-2 font-bold">Stake</th>
                <th class="px-2.5 py-2 font-bold">Result</th>
                <th class="px-2.5 py-2 font-bold">Room Code</th>
                <th class="px-2.5 py-2 font-bold">When</th>
                <th class="px-2.5 py-2"></th>
              </tr></thead>
              <tbody class="divide-y divide-line">
                ${d.recentGames.map(g => `
                  <tr class="hover:bg-surface-page">
                    <td data-label="Match" class="px-2.5 py-2 font-mono text-[11px] text-muted">#${g.id.slice(-6)}</td>
                    <td data-label="Opponent" class="px-2.5 py-2">
                      <span class="inline-block text-[11px] text-muted">${g.isCreator ? 'Created vs' : 'Joined vs'}</span>
                      <strong class="text-ink">${esc(g.isCreator ? g.acceptorName : g.creatorName)}</strong>
                      ${(g.isCreator ? g.acceptorPhone : g.creatorPhone) ? `<span class="block font-mono text-[10px] text-muted">${esc(g.isCreator ? g.acceptorPhone : g.creatorPhone)}</span>` : ''}
                    </td>
                    <td data-label="Stake" class="px-2.5 py-2 font-black text-ink">${money(g.amount)}</td>
                    <td data-label="Result" class="px-2.5 py-2">
                      ${g.isWinner ? '<span class="inline-block rounded-full bg-cta/15 px-2 py-0.5 text-[10px] font-bold text-cta">Won (+' + money(g.payout || 0) + ')</span>' :
                        g.isLoser ? '<span class="inline-block rounded-full bg-live/15 px-2 py-0.5 text-[10px] font-bold text-live">Lost</span>' :
                        pill(g.status)}
                    </td>
                    <td data-label="Room" class="px-2.5 py-2 font-mono text-[11px] font-bold text-brand">${esc(g.roomCode || '—')}</td>
                    <td data-label="When" class="px-2.5 py-2 text-[11px] text-muted">${when(g.createdAt)}</td>
                    <td data-label="" class="rtable-actions px-2.5 py-2 text-right">
                      ${g.claims && g.claims.length ? `<button class="text-[11px] font-bold text-brand hover:underline" data-expand="${g.id}">Claims (${g.claims.length})</button>` : ''}
                    </td>
                  </tr>
                  ${g.claims && g.claims.length ? `
                    <tr hidden data-detail="${g.id}"><td colspan="7" class="bg-surface-page px-3 py-3">
                      <div class="flex flex-wrap gap-4">
                        ${g.claims.map(c => `<div class="rounded-tile border border-line bg-surface p-3">
                          <p class="pill-label">${c.user_id === p.id ? 'This Player (' + esc(p.name) + ')' : 'Opponent'}</p>
                          <p class="text-body font-bold text-ink">Claim: ${esc(c.claim)}</p>
                          ${c.reason ? `<p class="text-meta text-muted">${esc(c.reason)}</p>` : ''}
                          <div class="mt-2">${shot(c.proof)}</div>
                        </div>`).join('')}
                      </div>
                    </td></tr>
                  ` : ''}
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="text-meta text-muted">No matches played yet.</p>'}
      </div>

      <div class="mt-3 grid gap-3 lg:grid-cols-2">
        <div class="rounded-card border border-line bg-surface p-4">
          <p class="mb-2 text-body font-bold text-ink">Recent transactions</p>
          ${d.recentTx.length ? d.recentTx.map(t => `<div class="flex justify-between border-b border-line py-1.5 text-meta last:border-0">
            <span class="text-muted">${esc(t.note||t.bucket)}</span>
            <span class="font-bold ${t.type==='credit'?'text-cta':'text-live'}">${t.type==='credit'?'+':'−'}${money(t.amount)}</span></div>`).join('') : '<p class="text-meta text-muted">none</p>'}
        </div>
        <div class="rounded-card border border-line bg-surface p-4">
          <p class="mb-2 text-body font-bold text-ink">Devices / logins</p>
          ${d.devices.length ? d.devices.slice(0,6).map(dv => `<div class="border-b border-line py-1.5 text-meta last:border-0">
            <span class="font-mono text-ink">${esc(dv.ip||'—')}</span>
            <span class="block truncate text-muted">${esc((dv.user_agent||'').slice(0,50))} · ${when(dv.created_at)}</span></div>`).join('') : '<p class="text-meta text-muted">no logins recorded</p>'}
        </div>
      </div>`;
    det.dataset.pid = id;
  }

  /* ---------------- live chat ---------------- */
  let openThread = null;
  let chatStatus = '';

  async function loadChat() {
    const { threads, waiting } = await call('/admin/chats' + (chatStatus ? '?status=' + chatStatus : ''));
    setCount('chat', waiting);
    $('#chat-threads').innerHTML = threads.length ? threads.map(t => `
      <button class="mb-1.5 flex w-full items-start gap-2 rounded-tile border p-3 text-left transition
                     ${openThread === t.id ? 'border-brand bg-brand/5' : 'border-line bg-surface hover:border-brand'}"
              type="button" data-thread="${t.id}">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-body font-bold text-white">
          ${esc(t.name.slice(0,1))}</span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2">
            <span class="truncate text-body font-bold text-ink">${esc(t.name)}</span>
            ${t.unread_admin ? `<span class="rounded-full bg-live px-1.5 text-[10px] font-black text-white">${t.unread_admin}</span>` : ''}
          </span>
          <span class="block truncate text-meta text-muted">${esc(t.last_message || 'No messages yet')}</span>
          <span class="block text-[10px] text-muted">${t.last_at ? when(t.last_at) : ''} · ${esc(t.status)}</span>
        </span>
      </button>`).join('') : empty('No conversations.');
  }

  function renderMsg(m) {
    const admin = !!m.from_admin || !!m.fromAdmin;
    const at = m.created_at || m.at;
    const body = m.body;
    const att = m.attachment;
    const el = document.createElement('div');
    el.className = admin
      ? 'ml-auto max-w-[80%] rounded-tile rounded-br-none bg-brand px-3 py-2 text-body-sm text-white'
      : 'max-w-[80%] rounded-tile rounded-tl-none bg-surface px-3 py-2 text-body-sm text-ink shadow-tile';
    el.innerHTML =
      (m.kind === 'image' && att
        ? `<a href="${IMG + att}" target="_blank" rel="noopener"><img src="${IMG + att}" alt="" class="max-h-40 rounded"></a>`
        : `<span>${esc(body)}</span>`) +
      `<span class="mt-1 block text-right text-[10px] ${admin ? 'text-white/70' : 'text-muted'}">
         ${esc(m.author || '')} · ${new Date(at).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'})}</span>`;
    $('#ct-messages').appendChild(el);
    $('#ct-messages').scrollTop = $('#ct-messages').scrollHeight;
  }

  async function openConversation(id) {
    openThread = id;
    const { thread, messages } = await call('/admin/chats/' + id);
    $('#chat-empty').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    $('#chat-view').classList.add('flex');
    $('#ct-name').textContent = thread.name;
    $('#ct-phone').textContent = thread.phone + ' · ' + thread.status;
    $('#ct-messages').innerHTML = '';
    messages.forEach(renderMsg);
    if (socket) socket.emit('chat:join', { threadId: id });
    loadChat();
  }

  /* Socket.IO so agents see messages arrive without refreshing. */
  let socket = null;
  let awaitingIo = false;
  function connectSocket() {
    if (socket) return;
    // socket.io.js loads async from the API host, so it may not be here yet.
    if (typeof window.io !== 'function') {
      const tag = document.querySelector('script[data-socket-io]');
      if (tag && !awaitingIo) {
        awaitingIo = true;
        tag.addEventListener('load', () => { awaitingIo = false; connectSocket(); }, { once: true });
      }
      return;
    }
    socket = window.io(window.KHELBRO_API || '', { auth: { adminToken: TOKEN }, transports: ['websocket', 'polling'] });
    socket.on('connect', () => socket.emit('chat:admin-join'));
    socket.on('chat:message', ({ threadId, message }) => {
      if (threadId === openThread) renderMsg(message);
      loadChat();
    });
    socket.on('chat:activity', () => { loadChat(); toast('New message from a player', 'info'); });
    socket.on('chat:typing', ({ threadId, typing, fromAdmin }) => {
      if (threadId === openThread && !fromAdmin) $('#ct-typing').classList.toggle('hidden', !typing);
    });
  }

  /* ---------------- audit log ---------------- */
  async function loadAudit() {
    $('#audit').innerHTML = skeleton(4);
    const { entries } = await call('/admin/audit' + q());
    $('#audit').innerHTML = entries.length ? `
      <div class="sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-accent-head text-left text-brand-dark">
            <th class="px-3 py-2.5 font-bold">Who</th><th class="px-3 py-2.5 font-bold">Action</th>
            <th class="px-3 py-2.5 font-bold">Target</th><th class="px-3 py-2.5 font-bold">Detail</th>
            <th class="px-3 py-2.5 font-bold">IP</th><th class="px-3 py-2.5 font-bold">When</th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${entries.map(e => `<tr class="hover:bg-surface-page">
              <td data-label="Who" class="px-3 py-2.5 font-bold text-ink">${esc(e.admin_name)}</td>
              <td data-label="Action" class="px-3 py-2.5">
                <span class="rounded-full px-2 py-0.5 text-[11px] font-bold
                  ${e.action.includes('failed') ? 'bg-live/15 text-live' : 'bg-surface-page text-muted-dark'}">${esc(e.action)}</span></td>
              <td data-label="Target" class="px-3 py-2.5 text-muted">${esc(e.target_type || '—')}${e.target_id ? ' #' + esc(String(e.target_id).slice(-6)) : ''}</td>
              <td data-label="Detail" class="px-3 py-2.5 font-mono text-[11px] text-muted">${e.detail ? esc(JSON.stringify(e.detail)).slice(0,80) : ''}</td>
              <td data-label="IP" class="px-3 py-2.5 font-mono text-[11px] text-muted">${esc(e.ip || '')}</td>
              <td data-label="When" class="px-3 py-2.5 text-muted">${when(e.created_at)}</td>
            </tr>`).join('')}
          </tbody></table></div>
      <p class="mt-2 text-meta text-muted">${entries.length} entries. The log is append-only.</p>`
      : empty('Nothing recorded in this range.');
  }

  /* ---------------- admins ---------------- */
  async function loadAdmins() {
    const { admins } = await call('/admin/admins');
    $('#admins').innerHTML = `
      <div class="sm:overflow-x-auto sm:rounded-card sm:border sm:border-line sm:bg-surface">
        <table class="rtable w-full border-collapse text-body-sm">
          <thead><tr class="bg-accent-head text-left text-brand-dark">
            <th class="px-3 py-2.5 font-bold">User</th><th class="px-3 py-2.5 font-bold">Role</th>
            <th class="px-3 py-2.5 font-bold">Last login</th><th class="px-3 py-2.5 font-bold">Status</th>
            <th class="px-3 py-2.5"></th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${admins.map(a => `<tr class="hover:bg-surface-page">
              <td data-label="User" class="px-3 py-2.5"><span class="font-bold text-ink">${esc(a.name)}</span>
                  <span class="block text-meta text-muted">@${esc(a.username)}</span></td>
              <td data-label="Role" class="px-3 py-2.5">${pill(a.role)}</td>
              <td data-label="Last login" class="px-3 py-2.5 text-muted">${a.last_login_at ? when(a.last_login_at) : 'never'}</td>
              <td data-label="Status" class="px-3 py-2.5">${a.active ? '<span class="text-cta">active</span>' : '<span class="text-live">disabled</span>'}</td>
              <td data-label="" class="rtable-actions px-3 py-2.5 text-right">
                ${a.id === ME.id ? '<span class="text-meta text-muted">you</span>' :
                  `<button class="sub-btn" data-admin-toggle="${a.id}" data-active="${a.active ? 0 : 1}">
                     ${a.active ? 'Disable' : 'Enable'}</button>`}</td>
            </tr>`).join('')}
          </tbody></table></div>`;
  }


  /* ---------------- risk & fraud ---------------- */
  let riskView = 'withdrawals';
  async function loadRisk() {
    $('#risk').innerHTML = skeleton(3);
    if (riskView === 'withdrawals') {
      const { withdrawals } = await call('/admin/withdrawals/risk');
      $('#risk').innerHTML = withdrawals.length ? withdrawals.map(w => {
        const tone = w.riskLevel==='high'?'border-live bg-live/5':w.riskLevel==='medium'?'border-gold bg-gold/5':'border-line';
        return `<div class="mb-2 rounded-card border-l-4 ${tone} border p-3">
          <div class="flex items-center justify-between">
            <span class="font-bold text-ink">${esc(w.name)} · ${money(w.amount)}</span>
            <span class="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${w.riskLevel==='high'?'bg-live/15 text-live':w.riskLevel==='medium'?'bg-gold/25 text-gold-deep':'bg-cta/15 text-cta'}">${w.riskLevel} · ${w.riskScore}</span>
          </div>
          <p class="mt-1 text-meta text-muted">${esc(w.phone)} · ${w.method==='upi'?esc(w.upi_id):esc(w.account_number||'')}</p>
          ${w.reasons.length?`<p class="mt-1 text-meta text-live">⚠ ${w.reasons.map(esc).join(' · ')}</p>`:''}
          <div class="mt-2 flex gap-2">
            <button class="btn btn-primary !min-h-[32px] !px-3 !text-[11px]" data-wd="${w.id}" data-approve="1">Mark paid</button>
            <button class="btn btn-outline !min-h-[32px] !px-3 !text-[11px]" data-wd="${w.id}" data-approve="0">Reject</button>
          </div></div>`;
      }).join('') : empty('No pending withdrawals.');
    } else if (riskView === 'multi') {
      const { groups } = await call('/admin/fraud/multi-account');
      $('#risk').innerHTML = groups.length ? groups.map(g => `
        <div class="mb-2 rounded-card border border-line bg-surface p-3">
          <p class="font-bold text-ink">${g.count} accounts share IP <span class="font-mono text-brand">${esc(g.ip)}</span></p>
          <p class="mt-1 text-meta text-muted">${g.users.map(u=>esc(u.name)+' (#'+u.id+')').join(' · ')}</p>
        </div>`).join('') : empty('No shared-device accounts found.');
    } else if (riskView === 'collusion') {
      const { pairs } = await call('/admin/fraud/collusion');
      $('#risk').innerHTML = pairs.length ? pairs.map(pr => `
        <div class="mb-2 rounded-card border border-line bg-surface p-3">
          <div class="flex items-center justify-between">
            <span class="font-bold text-ink">${esc(pr.aName)} vs ${esc(pr.bName)}</span>
            <span class="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${pr.risk==='high'?'bg-live/15 text-live':'bg-gold/25 text-gold-deep'}">${pr.risk}</span>
          </div>
          <p class="mt-1 text-meta text-muted">${pr.games} games · ${pr.aWins}–${pr.bWins}</p>
        </div>`).join('') : empty('No suspicious pairs.');
    } else {
      const { watchlist } = await call('/admin/watchlist');
      $('#risk').innerHTML = watchlist.length ? watchlist.map(w => `
        <div class="mb-2 flex items-center justify-between rounded-card border border-line bg-surface p-3">
          <span><span class="font-bold text-ink">${esc(w.name)}</span>
            <span class="block text-meta text-muted">${esc(w.phone)} · ${esc(w.reason||'no reason')} · by ${esc(w.added_by||'')}</span></span>
          <button class="sub-btn" data-unwatch="${w.user_id}">Remove</button>
        </div>`).join('') : empty('Watchlist is empty.');
    }
  }


  /* ---------------- payment methods ---------------- */
  async function loadPayments() {
    $('#payments').innerHTML = skeleton(3);
    const { methods, max } = await call('/admin/payment-methods');
    const total = methods.reduce((a, m) => a + m.collected, 0);
    $('#payments').innerHTML =
      `<p class="mb-2 text-meta text-muted">${methods.length}/${max} methods · ${money(total)} collected in total</p>` +
      (methods.length ? methods.map(m => `
        <div class="mb-2 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
          ${m.qrImage
            ? `<img src="${IMG + m.qrImage}" alt="QR" class="h-16 w-16 rounded-tile border border-line bg-white object-contain p-1">`
            : `<span class="grid h-16 w-16 place-items-center rounded-tile border border-dashed border-line text-[10px] text-muted">no QR</span>`}
          <div class="min-w-0 flex-1">
            <p class="font-bold text-ink">${esc(m.label || 'UPI')} ${m.active ? '' : '<span class="text-[10px] uppercase text-live">off</span>'}</p>
            <p class="font-mono text-meta text-muted">${esc(m.upiId)}</p>
            <p class="text-meta text-cta">${money(m.collected)} collected · ${m.approved} approved · ${m.pending} pending</p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-1.5">
            <label class="sub-btn cursor-pointer">QR<input class="sr-only" type="file" accept="image/*" data-pm-qr="${m.id}"></label>
            <button class="sub-btn" data-pm-toggle="${m.id}" data-active="${m.active ? 0 : 1}">${m.active ? 'Disable' : 'Enable'}</button>
            <button class="sub-btn !text-live" data-pm-del="${m.id}">Delete</button>
          </div>
        </div>`).join('') : empty('No payment methods yet. Add one above.'));
  }

  /* ---------------- settings ----------------
     Every business rule the operator can change without a deploy. Rates are
     stored as fractions (0.035) but typed as percentages (3.5) — an admin
     typing "5" meaning 5% into a fraction field would have set a 500%
     commission, so the conversion lives here rather than in their head. */
  const pctOf = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? +(n * 100).toFixed(3) : fallback;
  };

  let adminNotices = [];
  function renderNoticeList() {
    const cont = $('#notice-list-container');
    if (!cont) return;
    if (!adminNotices.length) {
      cont.innerHTML = '<p class="text-meta text-muted italic">No active notices. Add one above.</p>';
      return;
    }
    cont.innerHTML = adminNotices.map((n, idx) => `
      <div class="flex items-center gap-2 rounded-tile border border-line bg-surface-page p-2.5">
        <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">${idx + 1}</span>
        <input class="field !h-8 flex-1 !bg-surface text-body-sm font-medium text-ink notice-item-val" data-idx="${idx}" value="${esc(n)}" maxlength="500">
        <button class="sub-btn !text-live hover:!border-live shrink-0" type="button" data-del-notice="${idx}">Delete</button>
      </div>`).join('');
  }

  async function loadSettings() {
    const { settings } = await call('/admin/settings');
    adminNotices = Array.isArray(settings.notices) && settings.notices.length
      ? [...settings.notices]
      : (settings.notice ? [settings.notice] : []);

    const group = (title, hint, body) => `
      <section class="rounded-card border border-line bg-surface p-4">
        <h3 class="text-body font-bold text-ink">${title}</h3>
        ${hint ? `<p class="mt-0.5 text-meta text-muted">${hint}</p>` : ''}
        <div class="mt-3 space-y-3">${body}</div>
      </section>`;

    const toggle = (k, label, hint) => `
      <label class="flex cursor-pointer items-start gap-3 rounded-tile border border-line p-3 transition hover:border-brand">
        <input type="checkbox" class="mt-0.5 h-5 w-5 shrink-0 accent-brand" data-set="${k}" ${settings[k] ? 'checked' : ''}>
        <span class="min-w-0">
          <span class="block text-body text-ink">${label}</span>
          ${hint ? `<span class="block text-meta text-muted">${hint}</span>` : ''}
        </span></label>`;

    /* `scale` marks a field the save handler must divide by 100 on the way
       out; without it a percentage would be written straight in as a rate. */
    const field = (k, label, attrs, value, hint) => `
      <label class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input ${attrs} value="${esc(value)}" data-set="${k}" class="field !h-9 w-32">
        <span class="text-body text-ink">${label}</span>
        ${hint ? `<span class="w-full text-meta text-muted">${hint}</span>` : ''}
      </label>`;

    const rupees = (k, label, hint, fallback = 0) =>
      field(k, label, 'type="number" min="0" step="1" data-unit="rupees"', Number(settings[k]) || fallback, hint);
    const percent = (k, label, hint, fallback = 0) =>
      field(k, label, 'type="number" min="0" step="0.1" data-scale="100"', pctOf(settings[k], fallback), hint);
    const count = (k, label, hint, fallback = 1) =>
      field(k, label, 'type="number" min="1" step="1"', Number(settings[k]) || fallback, hint);

    $('#settings').innerHTML = `
      <div class="grid gap-4 lg:grid-cols-2">
        ${group('Switches', 'Take a route offline without a deploy.',
          toggle('withdraw_open', 'Withdrawals enabled',
                 'Off: the withdraw page shows a closed notice and the API refuses requests.') +
          toggle('deposit_open', 'Deposits enabled',
                 'Off: players cannot submit new deposit requests.') +
          toggle('maintenance', 'Maintenance mode'))}

        ${group('Game commission', 'Taken from the pot before the winner is paid. Small battles carry the higher rate.',
          percent('commission_under', 'Commission below the threshold (%)',
                  'e.g. 3.5 means a ₹100 battle pays the winner ₹193.', 3.5) +
          percent('commission_from', 'Commission at or above the threshold (%)',
                  'e.g. 2.5 means a ₹500 battle pays the winner ₹975.', 2.5) +
          rupees('commission_threshold', 'Threshold (₹)',
                 'Battles below this amount take the higher rate.', 500))}

        ${group('Referral &amp; bonuses', 'Applied live — the next signup and the next settled battle already use these.',
          percent('referral_rate', 'Referral commission (%)',
                  'Paid to the referrer from every battle their player settles.', 1) +
          rupees('signup_bonus', 'Signup bonus (₹)',
                 'Credited to every new account’s cash balance. 0 switches it off.', 0) +
          rupees('referral_bonus', 'Referral signup bonus (₹)',
                 'Extra cash credited when the new account used a referral code.', 0))}

        ${group('Play &amp; payments', '',
          count('battle_limit', 'Max open battles per player', '', 2) +
          `<label class="block">
             <span class="mb-1.5 block text-body text-ink">Deposit UPI ID</span>
             <input class="field !h-9 w-full font-mono" value="${esc(settings.upi_id || 'khelbro@upi')}" data-set="upi_id" placeholder="name@bank">
           </label>`)}

        ${group('Deposit Bank Account Details', 'Official company bank account details shown to players on the Add Cash page for Bank Transfer.',
          `<div class="space-y-3">
             <label class="block">
               <span class="mb-1 block text-meta font-bold text-ink">Bank Name</span>
               <input class="field !h-9 w-full" value="${esc(settings.bank_name || 'HDFC Bank')}" data-set="bank_name" placeholder="e.g. HDFC Bank">
             </label>
             <label class="block">
               <span class="mb-1 block text-meta font-bold text-ink">Account Holder Name</span>
               <input class="field !h-9 w-full" value="${esc(settings.bank_account_name || 'Khelbro Gaming Pvt Ltd')}" data-set="bank_account_name" placeholder="e.g. Khelbro Gaming Pvt Ltd">
             </label>
             <label class="block">
               <span class="mb-1 block text-meta font-bold text-ink">Account Number</span>
               <input class="field !h-9 w-full font-mono" value="${esc(settings.bank_account_number || '50200012345678')}" data-set="bank_account_number" placeholder="e.g. 50200012345678">
             </label>
             <label class="block">
               <span class="mb-1 block text-meta font-bold text-ink">IFSC Code</span>
               <input class="field !h-9 w-full font-mono uppercase" value="${esc(settings.bank_ifsc || 'HDFC0001234')}" data-set="bank_ifsc" placeholder="e.g. HDFC0001234">
             </label>
           </div>`)}
      </div>

      <div class="mt-4">
        ${group('Player Announcements &amp; Notices (Multiple)', 'Shown at the top of the battles page. When multiple notices are added, players see them rotating dynamically.',
          `<div class="space-y-3">
             <div class="flex gap-2">
               <input class="field !h-10 flex-1" id="new-notice-input" placeholder="Enter an announcement / notice text..." maxlength="500">
               <button class="btn btn-primary !min-h-[40px] !px-4 !text-meta shrink-0" type="button" id="add-notice-btn">+ Add Notice</button>
             </div>
             <div id="notice-list-container" class="space-y-2"></div>
           </div>`)}
      </div>

      <div class="mt-4">
        <button class="btn btn-primary !min-h-[38px] !px-6 !text-meta" type="button" id="save-settings">Save changes</button>
      </div>`;

    renderNoticeList();
  }

  /* ---------------- alerts inbox ----------------
     One list of everything waiting on a human. The console has a tab per
     queue, so noticing new work used to mean clicking through five of them —
     and nothing at all told an operator that something had arrived while they
     were looking elsewhere. This feed is that signal, and it rings. */

  const KIND = {
    deposit:    ['Deposit',    'bg-gold/25 text-gold-deep',  '₹'],
    withdrawal: ['Withdrawal', 'bg-live/15 text-live',       '↑'],
    dispute:    ['Dispute',    'bg-live/20 text-live',       '⚖'],
    kyc:        ['KYC',        'bg-brand/15 text-brand',     '🪪'],
    chat:       ['Chat',       'bg-cta/15 text-cta-deep',    '💬'],
  };

  /* Counts from the previous poll, so a rise can be told from a steady state.
     Null until the first poll lands: an operator opening the console to a
     backlog of forty should not be greeted by an alarm for work that was
     already there. */
  let lastCounts = null;

  function inboxRow(it) {
    const [label, tone, glyph] = KIND[it.kind] || ['Item', 'bg-surface-page text-muted-dark', '•'];
    return `
      <button class="flex w-full items-center gap-3 border-b border-line px-3 py-3 text-left transition hover:bg-surface-page"
              type="button" data-inbox-tab="${esc(it.tab)}" data-inbox-filter="${esc(it.filter || '')}">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone} text-[15px]">${glyph}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-body font-bold text-ink">${esc(it.title)}</span>
          <span class="block truncate text-meta text-muted">${esc(it.detail)}</span>
        </span>
        <span class="shrink-0 text-right">
          <span class="block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${tone}">${label}</span>
          <span class="mt-0.5 block text-[11px] text-muted">${when(it.at)}</span>
        </span>
      </button>`;
  }

  function paintInbox(data) {
    const c = data.counts || {};
    const tile = (n, label, tab) => `
      <button class="rounded-card border border-line bg-surface p-3 text-left transition hover:border-brand"
              type="button" data-inbox-tab="${tab}" data-inbox-filter="${tab === 'deposits' || tab === 'withdrawals' ? 'pending' : ''}">
        <p class="pill-label">${label}</p>
        <p class="mt-1 text-h3 font-bold ${n > 0 ? 'text-live' : 'text-ink'}">${n || 0}</p>
      </button>`;

    $('#alerts').innerHTML = `
      <div class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        ${tile(c.deposits, 'Deposits', 'deposits')}
        ${tile(c.withdrawals, 'Withdrawals', 'withdrawals')}
        ${tile(c.disputes, 'Disputes', 'disputes')}
        ${tile(c.kyc, 'KYC', 'kyc')}
        ${tile(c.chat, 'Chat', 'chat')}
      </div>
      ${data.items && data.items.length
        ? `<div class="overflow-hidden rounded-card border border-line bg-surface">${data.items.map(inboxRow).join('')}</div>`
        : empty('Nothing is waiting. Every queue is clear.')}`;
  }

  async function loadInbox() {
    $('#alerts').innerHTML = skeleton(3);
    paintInbox(await pollInbox({ paint: false }));
  }

  /** Fetch the inbox, update the badges, and ring when something new arrives.
      Returns the payload so the tab renderer can draw it. */
  async function pollInbox({ paint = true } = {}) {
    const data = await call('/admin/inbox');
    const c = data.counts || {};

    setCount('alerts', c.total || 0);
    setCount('deposits', c.deposits || 0);
    setCount('withdrawals', c.withdrawals || 0);
    setCount('disputes', c.disputes || 0);
    setCount('kyc', c.kyc || 0);
    setCount('chat', c.chat || 0);

    /* Ring on a rise in any single queue, not on the total: one deposit
       approved and one arriving in the same window leaves the total
       unchanged, and that new deposit still needs somebody. */
    if (lastCounts) {
      const risen = ['deposits', 'withdrawals', 'disputes', 'kyc', 'chat']
        .filter(k => (c[k] || 0) > (lastCounts[k] || 0));
      if (risen.length && $('#alert-sound') && $('#alert-sound').checked) {
        const words = risen.map(k => `${(c[k] || 0) - (lastCounts[k] || 0)} ${k}`).join(', ');
        window.KhelbroAlert?.fire('New items need attention', words);
      }
    }
    lastCounts = c;

    if (paint && tab === 'alerts') paintInbox(data);
    return data;
  }

  const TABS = { overview: loadOverview, alerts: loadInbox, players: loadPlayers, games: loadGames, disputes: loadDisputes,
                 deposits: loadDeposits, withdrawals: loadWithdrawals, kyc: loadKyc, risk: loadRisk,
                 chat: loadChat, audit: loadAudit, admins: loadAdmins, payments: loadPayments, settings: loadSettings };

  async function render() {
    try { await TABS[tab](); }
    catch (err) {
      toast(err.message, 'error');
      if (String(err.message).includes('Unauthorized')) signOut();
    }
  }

  /* Counts stay fresh on every tab, so badges are meaningful. The queue
     badges come from the inbox rather than from /stats: /stats is scoped to
     the selected time range, so a pending deposit from last week vanished
     from the badge while still very much needing an answer. */
  async function refreshCounts() {
    try {
      const s = await call('/admin/stats' + q());
      setCount('games', s.battles.total);
    } catch {}
    try { await pollInbox(); } catch {}
  }

  /* An independent heartbeat, not tied to the Auto checkbox: the whole point
     of the inbox is to notice work that arrives while nobody is looking. */
  let inboxTimer = null;
  function watchInbox(everyMs = 30000) {
    clearInterval(inboxTimer);
    inboxTimer = setInterval(() => {
      if (document.hidden || !TOKEN) return;
      pollInbox().catch(() => {});
    }, everyMs);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && TOKEN) pollInbox().catch(() => {});
    });
  }

  /* One setter per filter, so the chip row and the dropdown can never drift apart. */
  function setRange(v) {
    range = v;
    $$('[data-range]').forEach(b => b.classList.toggle('is-active', b.dataset.range === v));
    const m = $('#m-range'); if (m && m.value !== v) m.value = v;
    render(); if (tab !== 'overview') refreshCounts();
  }
  function syncGameStatus(v) {
    gameStatus = v;
    $$('[data-gstatus]').forEach(b => b.classList.toggle('is-active', b.dataset.gstatus === v));
    const m = $('#m-gstatus'); if (m && m.value !== v) m.value = v;
  }
  const setGameStatus = v => { syncGameStatus(v); loadGames(); };
  /* The sync half is separate from the load half, so an inbox row can narrow
     the filter and let the tab switch do the single fetch. */
  function syncDepStatus(v) {
    depStatus = v;
    $$('[data-dstatus]').forEach(b => b.classList.toggle('is-active', b.dataset.dstatus === v));
    const m = $('#m-dstatus'); if (m && m.value !== v) m.value = v;
  }
  const setDepStatus = v => { syncDepStatus(v); loadDeposits(); };

  function syncWdStatus(v) {
    wdStatus = v;
    $$('[data-wstatus]').forEach(b => b.classList.toggle('is-active', b.dataset.wstatus === v));
    const m = $('#m-wstatus'); if (m && m.value !== v) m.value = v;
  }
  const setWdStatus = v => { syncWdStatus(v); loadWithdrawals(); };

  function switchTab(name) {
    tab = name;
    $$('[data-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
    const m = $('#m-tab'); if (m && m.value !== name) m.value = name;
    Object.keys(TABS).forEach(t => { $('#tab-' + t).hidden = t !== name; });
    render();
  }

  function signOut() {
    sessionStorage.removeItem('khelbro.adminToken');
    TOKEN = ''; ME = null;
    clearInterval(autoTimer);
    clearInterval(inboxTimer);
    window.KhelbroAlert?.stop();
    /* Forget the baseline: signing back in must not ring for the backlog
       that was already there when the last session ended. */
    lastCounts = null;
    if (socket) { socket.disconnect(); socket = null; }
    $('#app').hidden = true;
    $('#gate').hidden = false;
  }

  /* Hide anything the signed-in role may not use. */
  function applyRole() {
    $('#who-name').textContent = ME.name;
    $('#who-role').textContent = ME.role;
    $$('[data-min-role]').forEach(el => { el.hidden = !can(el.dataset.minRole); });
    // Read-only roles should not see action buttons at all.
    document.body.classList.toggle('is-viewer', !can('admin'));
  }

  /* ---------------- events ---------------- */
  /* Wallet editing. 'adjust' moves a bucket by ±amount; 'set' writes an exact
     balance and the server records the difference, so the ledger still
     reconciles. Current values are read back first so the admin is never
     typing blind. */
  async function editWallet(playerId, mode) {
    let current = null;
    try {
      const d = await call('/admin/players/' + playerId);
      current = d.wallet || null;
    } catch (err) { toast(err.message, 'error'); return; }

    const shown = current
      ? `deposit ₹${current.deposit || 0} · winnings ₹${current.winnings || 0} · referral ₹${current.referral || 0}`
      : 'balances unavailable';
    const bucket = prompt(`Bucket: deposit / winnings / referral\n\nCurrent: ${shown}`, 'deposit');
    if (!bucket) return;
    if (!['deposit', 'winnings', 'referral'].includes(bucket.trim())) {
      toast('Bucket must be deposit, winnings or referral', 'error'); return;
    }
    const key = bucket.trim();
    const at = current ? (current[key] || 0) : 0;

    const label = mode === 'set'
      ? `New ${key} balance (currently ₹${at}):`
      : `Amount to add to ${key} (negative to deduct, currently ₹${at}):`;
    const raw = prompt(label, mode === 'set' ? String(at) : '');
    if (raw === null) return;
    const amount = Number(String(raw).trim());
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) { toast('Enter a whole number', 'error'); return; }
    if (mode === 'set' && amount < 0) { toast('A balance cannot be negative', 'error'); return; }
    if (mode === 'adjust' && amount === 0) { toast('Enter a non-zero amount', 'error'); return; }

    const reason = prompt('Reason (required, min 3 chars):');
    if (!reason || reason.trim().length < 3) { toast('A reason is required', 'error'); return; }

    const preview = mode === 'set' ? `₹${at} → ₹${amount}` : `${amount > 0 ? '+' : ''}₹${amount} (→ ₹${at + amount})`;
    if (!confirm(`Update ${key} for player #${playerId}?\n\n${preview}\n\nReason: ${reason.trim()}`)) return;

    try {
      const r = await call(`/admin/players/${playerId}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount, bucket: key, mode, reason: reason.trim() }),
      });
      toast(r.unchanged ? 'Already at that balance' : `Wallet updated — ${key} is now ₹${r.to}`, 'success');
      openPlayer(playerId);
    } catch (err) { toast(err.message, 'error'); }
  }

  document.addEventListener('click', async e => {
    const t = e.target;

    /* An inbox row is also a [data-tab] chip's job, but it carries a filter —
       check it first, or the plain tab handler below would swallow it and
       drop the "pending" narrowing. */
    const inbox = t.closest('[data-inbox-tab]');
    if (inbox) {
      const to = inbox.dataset.inboxTab;
      const filter = inbox.dataset.inboxFilter || '';
      if (to === 'deposits') syncDepStatus(filter);
      if (to === 'withdrawals') syncWdStatus(filter);
      return switchTab(to);
    }

    if (t.id === 'alerts-refresh') { loadInbox().catch(err => toast(err.message, 'error')); return; }

    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) return switchTab(tabBtn.dataset.tab);

    const jump = t.closest('[data-jump]');
    if (jump) { syncGameStatus(jump.dataset.jump); return switchTab('games'); }

    const r = t.closest('[data-range]');
    if (r) return setRange(r.dataset.range);

    const gs = t.closest('[data-gstatus]');
    if (gs) return setGameStatus(gs.dataset.gstatus);

    const ds = t.closest('[data-dstatus]');
    if (ds) return setDepStatus(ds.dataset.dstatus);

    const ws = t.closest('[data-wstatus]');
    if (ws) return setWdStatus(ws.dataset.wstatus);

    const ex = t.closest('[data-expand]');
    if (ex) { const row = document.querySelector(`[data-detail="${ex.dataset.expand}"]`);
      row.hidden = !row.hidden; ex.textContent = row.hidden ? ex.textContent.replace('Hide', 'Claims') : 'Hide'; return; }

    const res = t.closest('[data-resolve]');
    if (res) {
      const label = res.textContent.trim();
      if (!confirm(`${label} for battle #${res.dataset.resolve.slice(-6)}?`)) return;
      try {
        await call(`/admin/disputes/${res.dataset.resolve}/resolve`,
          { method: 'POST', body: JSON.stringify({ outcome: res.dataset.outcome }) });
        toast('Dispute resolved', 'success'); await loadDisputes(); refreshCounts();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const k = t.closest('[data-kyc]');
    if (k) {
      try { await call('/admin/kyc/' + k.dataset.kyc,
        { method: 'POST', body: JSON.stringify({ approve: k.dataset.approve === '1' }) });
        toast(k.dataset.approve === '1' ? 'KYC approved' : 'KYC rejected', 'success');
        await loadKyc(); refreshCounts();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const d = t.closest('[data-dep]');
    if (d) {
      try { await call('/admin/deposits/' + d.dataset.dep,
        { method: 'POST', body: JSON.stringify({ approve: d.dataset.approve === '1' }) });
        toast(d.dataset.approve === '1' ? 'Deposit credited' : 'Deposit rejected', 'success');
        await loadDeposits(); refreshCounts();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const w = t.closest('[data-wd]');
    if (w) {
      const approve = w.dataset.approve === '1';
      if (!confirm(approve ? 'Mark this withdrawal as paid?' : 'Reject and refund to winnings?')) return;
      try { await call('/admin/withdrawals/' + w.dataset.wd,
        { method: 'POST', body: JSON.stringify({ approve }) });
        toast(approve ? 'Marked paid' : 'Rejected and refunded', 'success');
        await loadWithdrawals(); refreshCounts();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    if (t.id === 'add-notice-btn') {
      const inp = $('#new-notice-input');
      const val = (inp?.value || '').trim();
      if (!val) { toast('Enter notice text first', 'error'); return; }
      adminNotices.push(val);
      if (inp) inp.value = '';
      renderNoticeList();
      return;
    }

    const delNotice = t.closest('[data-del-notice]');
    if (delNotice) {
      const idx = Number(delNotice.dataset.delNotice);
      if (Number.isInteger(idx) && idx >= 0 && idx < adminNotices.length) {
        adminNotices.splice(idx, 1);
        renderNoticeList();
      }
      return;
    }

    if (t.id === 'save-settings') {
      const body = {};
      let bad = null;
      $$('[data-set]').forEach(el => {
        if (el.type === 'checkbox') { body[el.dataset.set] = el.checked; return; }
        if (el.type !== 'number') { body[el.dataset.set] = el.value; return; }
        const raw = Number(el.value);
        if (!Number.isFinite(raw) || raw < 0) { bad = bad || el.dataset.set; return; }
        // Percentage fields are typed as 3.5 and stored as 0.035.
        const scale = Number(el.dataset.scale) || 1;
        /* Rupee amounts and counts are whole numbers on the server. Catching
           "25.5" here names the field; letting it through returns a flat
           "Invalid settings." that says nothing about which one. */
        if (scale === 1 && !Number.isInteger(raw)) { bad = bad || el.dataset.set; return; }
        // Rounded, because 3.5/100 is 0.034999999999999996 in binary floating
        // point and the server rejects nothing but stores the noise forever.
        body[el.dataset.set] = scale === 1 ? raw : Number((raw / scale).toFixed(6));
      });

      // Gather live notices from the list
      const liveNotices = [];
      $$('.notice-item-val').forEach(inp => {
        const val = inp.value.trim();
        if (val) liveNotices.push(val);
      });
      adminNotices = liveNotices;
      body.notices = adminNotices;
      body.notice = adminNotices[0] || '';

      if (bad) { toast(`Enter a valid number for ${bad.replace(/_/g, ' ')}`, 'error'); return; }
      try { await call('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }); toast('Settings saved', 'success'); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }

    const th = t.closest('[data-thread]');
    if (th) return openConversation(Number(th.dataset.thread));

    const cs = t.closest('[data-cstatus]');
    if (cs) { chatStatus = cs.dataset.cstatus;
      $$('[data-cstatus]').forEach(b => b.classList.toggle('is-active', b === cs)); return loadChat(); }

    if (t.id === 'ct-resolve' || t.id === 'ct-block') {
      if (!openThread) return;
      const status = t.id === 'ct-resolve' ? 'resolved' : 'blocked';
      try { await call(`/admin/chats/${openThread}/status`, { method: 'POST', body: JSON.stringify({ status }) });
        toast('Conversation ' + status, 'success'); loadChat(); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }

    const at = t.closest('[data-admin-toggle]');
    if (at) {
      try { await call('/admin/admins/' + at.dataset.adminToggle,
        { method: 'PATCH', body: JSON.stringify({ active: at.dataset.active === '1' }) });
        toast('Updated', 'success'); loadAdmins(); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }


    // players
    const prow = t.closest('[data-player]');
    if (prow) return openPlayer(prow.dataset.player);
    if (t.id === 'player-search') return loadPlayers();
    if (t.id === 'player-back') { $('#player-detail').hidden = true; $('#players').hidden = false; return; }

    const padj = t.closest('[data-padjust]');
    if (padj) return editWallet(padj.dataset.padjust, 'adjust');
    const pset = t.closest('[data-pset]');
    if (pset) return editWallet(pset.dataset.pset, 'set');
    const plog = t.closest('[data-plogout]');
    if (plog) {
      if (!confirm('Force-logout this player?')) return;
      try { await call(`/admin/players/${plog.dataset.plogout}/logout`, { method: 'POST' }); toast('Player logged out', 'success'); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    const pw = t.closest('[data-pwatch]');
    if (pw) {
      const on = pw.dataset.on === '1';
      const reason = on ? prompt('Reason for watching:') : null;
      if (on && reason === null) return;
      try { await call(`/admin/players/${pw.dataset.pwatch}/watch`,
        { method: 'POST', body: JSON.stringify({ watch: on, reason }) });
        toast(on?'Added to watchlist':'Removed', 'success'); openPlayer(pw.dataset.pwatch); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    const pb = t.closest('[data-pban]');
    if (pb) {
      const on = pb.dataset.on === '1';
      if (!confirm(on?'Ban this player?':'Unban this player?')) return;
      try { await call(`/admin/users/${pb.dataset.pban}/ban`, { method: 'POST', body: JSON.stringify({ banned: on }) });
        toast(on?'Player banned':'Player unbanned', 'success'); openPlayer(pb.dataset.pban); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    const rv = t.closest('[data-risk]');
    if (rv) { riskView = rv.dataset.risk;
      $$('[data-risk]').forEach(b => b.classList.toggle('is-active', b === rv)); return loadRisk(); }
    const uw = t.closest('[data-unwatch]');
    if (uw) { try { await call(`/admin/players/${uw.dataset.unwatch}/watch`, { method: 'POST', body: JSON.stringify({ watch: false }) });
      toast('Removed from watchlist', 'success'); loadRisk(); } catch (err) { toast(err.message, 'error'); } return; }

    if (t.id === 'pm-add') {
      const upiId = $('#pm-upi').value.trim(), label = $('#pm-label').value.trim();
      try { await call('/admin/payment-methods', { method: 'POST', body: JSON.stringify({ upiId, label }) });
        $('#pm-upi').value = ''; $('#pm-label').value = ''; $('#pm-err').classList.add('hidden');
        toast('Payment method added', 'success'); loadPayments(); }
      catch (err) { $('#pm-err').textContent = err.message; $('#pm-err').classList.remove('hidden'); }
      return;
    }
    const pmt = t.closest('[data-pm-toggle]');
    if (pmt) { try { await call('/admin/payment-methods/' + pmt.dataset.pmToggle,
      { method: 'PATCH', body: JSON.stringify({ active: pmt.dataset.active === '1' }) });
      toast('Updated', 'success'); loadPayments(); } catch (err) { toast(err.message, 'error'); } return; }
    const pmd = t.closest('[data-pm-del]');
    if (pmd) { if (!confirm('Delete this payment method?')) return;
      try { await call('/admin/payment-methods/' + pmd.dataset.pmDel, { method: 'DELETE' });
      toast('Deleted', 'success'); loadPayments(); } catch (err) { toast(err.message, 'error'); } return; }

    if (t.id === 'theme') {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      localStorage.setItem('khelbro.theme', next);
      document.documentElement.setAttribute('data-theme', next);
      return;
    }
    if (t.id === 'refresh') { refreshCounts(); return render(); }
    if (t.id === 'signout') return signOut();
  });

  /* Agent reply box */
  document.addEventListener('submit', async e => {
    if (e.target.id === 'ct-form') {
      e.preventDefault();
      const input = $('#ct-input');
      const body = input.value.trim();
      if (!body || !openThread) return;
      input.value = '';
      try { await call(`/admin/chats/${openThread}/reply`, { method: 'POST', body: JSON.stringify({ body }) }); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (e.target.id === 'new-admin') {
      e.preventDefault();
      const body = {
        username: $('#na-username').value.trim(),
        name: $('#na-name').value.trim(),
        password: $('#na-password').value,
        role: $('#na-role').value,
      };
      try {
        await call('/admin/admins', { method: 'POST', body: JSON.stringify(body) });
        $('#na-username').value = $('#na-name').value = $('#na-password').value = '';
        $('#na-err').classList.add('hidden');
        toast('Admin created', 'success');
        loadAdmins();
      } catch (err) { $('#na-err').textContent = err.message; $('#na-err').classList.remove('hidden'); }
    }
  });

  /* Typing indicator from the agent side */
  let ctTyping;
  document.addEventListener('input', e => {
    if (e.target.id !== 'ct-input' || !socket || !openThread) return;
    socket.emit('chat:typing', { threadId: openThread, typing: true });
    clearTimeout(ctTyping);
    ctTyping = setTimeout(() => socket.emit('chat:typing', { threadId: openThread, typing: false }), 1200);
  });

  document.addEventListener('change', e => {
    switch (e.target.id) {
      case 'm-range':   return setRange(e.target.value);
      case 'm-tab':     return switchTab(e.target.value);
      case 'm-gstatus': return setGameStatus(e.target.value);
      case 'm-dstatus': return setDepStatus(e.target.value);
      case 'm-wstatus': return setWdStatus(e.target.value);
    }
    const pmQr = e.target.closest('[data-pm-qr]');
    if (pmQr) {
      const file = e.target.files[0]; if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      fetch(API + '/admin/payment-methods/' + pmQr.dataset.pmQr + '/qr',
        { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd })
        .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); toast('QR uploaded', 'success'); loadPayments(); })
        .catch(err => toast(err.message, 'error'));
      e.target.value = ''; return;
    }
    if (e.target.id === 'ct-file' && openThread) {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      fetch(API + '/uploads/proof', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd })
        .then(r => r.json())
        .then(u => call(`/admin/chats/${openThread}/reply`,
          { method: 'POST', body: JSON.stringify({ kind: 'image', attachment: u.url }) }))
        .catch(err => toast(err.message, 'error'));
      e.target.value = '';
    }
  });

  // Debounced game search
  let searchTimer;
  document.addEventListener('input', e => {
    if (e.target.id === 'player-q') { clearTimeout(searchTimer); searchTimer = setTimeout(loadPlayers, 350); }
    if (e.target.id === 'game-q') {
      clearTimeout(searchTimer);
      gameQuery = e.target.value.trim();
      searchTimer = setTimeout(loadGames, 300);
    }
    if (e.target.id === 'auto') {
      clearInterval(autoTimer);
      if (e.target.checked) {
        autoTimer = setInterval(() => { refreshCounts(); render(); }, 60000);
        toast('Auto-refreshing every 60s', 'info');
      }
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'key') $('#connect').click();
  });

  async function enterConsole() {
    ME = (await call('/admin/me')).admin;
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#gate-err').classList.add('hidden');
    applyRole();
    connectSocket();
    // Reset controls to the code's defaults — a reloaded page can otherwise
    // restore a stale <select> value that the state never saw.
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('#m-range', range); set('#m-gstatus', gameStatus);
    set('#m-dstatus', depStatus); set('#m-wstatus', wdStatus);
    refreshCounts();
    watchInbox();
    switchTab('overview');
  }

  async function login(e) {
    if (e) e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) {
      $('#gate-err').textContent = 'Enter your username and password.';
      $('#gate-err').classList.remove('hidden');
      return;
    }
    const btn = $('#connect');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await fetch(API + '/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error((data && data.error) || 'Sign in failed.');
      TOKEN = data.token;
      sessionStorage.setItem('khelbro.adminToken', TOKEN);
      $('#password').value = '';
      await enterConsole();
    } catch (err) {
      $('#gate-err').textContent = err.message;
      $('#gate-err').classList.remove('hidden');
    } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('#login-form').addEventListener('submit', login);
    try {
      const b = await fetch(API + '/admin/bootstrap').then(r => r.json());
      if (b.needsSetup) $('#setup-hint').classList.remove('hidden');
    } catch {}
    if (TOKEN) { try { await enterConsole(); } catch { signOut(); } }
  });
})();
