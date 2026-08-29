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
  async function call(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    const res = await fetch(API + path, { ...opts, headers });
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
        ${card('Deposits (instant)', money(s.deposits.instant))}
        ${card('Deposits (verified UPI)', money(s.deposits.approved), `${s.deposits.pending} awaiting check`)}
        ${card('Withdrawals paid', money(s.withdrawals.paid))}
        ${card('Withdrawals pending', money(s.withdrawals.pendingValue), `${s.withdrawals.pending} request(s)`, 'text-gold-deep')}
      </div>`;

    setCount('games', s.battles.total);
    setCount('disputes', s.battles.disputed);
    setCount('deposits', s.deposits.pending);
    setCount('withdrawals', s.withdrawals.pending);
    setCount('kyc', s.kycPending);

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
    setCount('disputes', disputes.length);
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
            <th class="px-3 py-2.5 font-bold">UTR</th><th class="px-3 py-2.5 font-bold">Status</th>
            <th class="px-3 py-2.5 font-bold">When</th><th class="px-3 py-2.5"></th>
          </tr></thead>
          <tbody class="divide-y divide-line">
            ${requests.map(d => `<tr class="hover:bg-surface-page">
              <td data-label="Player" class="px-3 py-2.5"><span class="font-bold text-ink">${esc(d.name)}</span>
                  <span class="block text-meta text-muted">${esc(d.phone)}</span></td>
              <td data-label="Amount" class="px-3 py-2.5 font-black text-ink">${money(d.amount)}</td>
              <td data-label="UTR" class="px-3 py-2.5 font-mono text-[11px]">${esc(d.utr)}</td>
              <td data-label="Status" class="px-3 py-2.5">${pill(d.status)}</td>
              <td data-label="When" class="px-3 py-2.5 text-muted">${when(d.created_at)}</td>
              <td data-label="" class="rtable-actions px-3 py-2.5 text-right">${d.status === 'pending' ? `
                <button class="btn btn-primary !min-h-[32px] !px-3 !text-[11px]" data-dep="${d.id}" data-approve="1">Approve</button>
                <button class="btn btn-outline !min-h-[32px] !px-3 !text-[11px]" data-dep="${d.id}" data-approve="0">Reject</button>` : ''}</td>
            </tr>`).join('')}
          </tbody></table></div>` : empty('No UPI deposit requests in this range.');

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
       <h2 class="mb-2 mt-6 text-title text-ink">Instant top-ups (auto-credited)</h2>${instantList || empty('None in this range.')}`;
    setCount('deposits', requests.filter(r => r.status === 'pending').length);
  }

  /* ---------------- withdrawals ---------------- */
  async function loadWithdrawals() {
    $('#withdrawals').innerHTML = skeleton(3);
    const { withdrawals } = await call('/admin/withdrawals' + q(wdStatus ? '&status=' + wdStatus : ''));
    setCount('withdrawals', withdrawals.filter(w => w.status === 'pending').length);
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
    setCount('kyc', pending.length);
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
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta" data-plogout="${p.id}">Force logout</button>
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta" data-pwatch="${p.id}" data-on="${d.watch?0:1}">${d.watch?'Unwatch':'Watch'}</button>
          <button class="btn btn-outline !min-h-[34px] !px-3 !text-meta !text-live" data-pban="${p.id}" data-on="${p.banned?0:1}">${p.banned?'Unban':'Ban'}</button>
        </div>
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
  function connectSocket() {
    if (socket || typeof window.io !== 'function') return;
    socket = window.io(window.KHELBRO_API || '', { transports: ['websocket', 'polling'] });
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

  /* ---------------- settings ---------------- */
  async function loadSettings() {
    const { settings } = await call('/admin/settings');
    const toggle = (k, label) => `<label class="flex cursor-pointer items-center gap-3 rounded-tile border border-line p-3 transition hover:border-brand">
        <input type="checkbox" class="h-5 w-5 accent-brand" data-set="${k}" ${settings[k] ? 'checked' : ''}>
        <span class="text-body text-ink">${label}</span></label>`;
    const num = (k, label, step) => `<label class="flex items-center gap-3">
        <input type="number" step="${step}" value="${settings[k]}" data-set="${k}" class="field !h-9 w-28">
        <span class="text-body text-ink">${label}</span></label>`;
    $('#settings').innerHTML =
      toggle('withdraw_open', 'Withdrawals open') +
      toggle('deposit_open', 'Deposits open') +
      toggle('maintenance', 'Maintenance mode') +
      num('commission', 'Commission (0.05 = 5%)', '0.01') +
      num('referral_rate', 'Referral rate', '0.01') +
      num('battle_limit', 'Max open battles per user', '1') +
      `<label class="flex items-center gap-3"><input class="field !h-9 w-56" value="${esc(settings.upi_id || '')}" data-set="upi_id"><span class="text-body text-ink">Deposit UPI ID</span></label>` +
      `<label class="flex items-center gap-3"><input class="field !h-9 flex-1" value="${esc(settings.notice || '')}" data-set="notice" placeholder="Shown to every player"><span class="shrink-0 text-body text-ink">Notice</span></label>` +
      `<button class="btn btn-primary !min-h-[38px] !px-6 !text-meta" type="button" id="save-settings">Save changes</button>`;
  }

  const TABS = { overview: loadOverview, players: loadPlayers, games: loadGames, disputes: loadDisputes,
                 deposits: loadDeposits, withdrawals: loadWithdrawals, kyc: loadKyc, risk: loadRisk,
                 chat: loadChat, audit: loadAudit, admins: loadAdmins, payments: loadPayments, settings: loadSettings };

  async function render() {
    try { await TABS[tab](); }
    catch (err) {
      toast(err.message, 'error');
      if (String(err.message).includes('Unauthorized')) signOut();
    }
  }

  /* Counts stay fresh on every tab, so badges are meaningful. */
  async function refreshCounts() {
    try {
      const s = await call('/admin/stats' + q());
      setCount('games', s.battles.total);
      setCount('disputes', s.battles.disputed);
      setCount('deposits', s.deposits.pending);
      setCount('withdrawals', s.withdrawals.pending);
      setCount('kyc', s.kycPending);
    } catch {}
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
  function setDepStatus(v) {
    depStatus = v;
    $$('[data-dstatus]').forEach(b => b.classList.toggle('is-active', b.dataset.dstatus === v));
    const m = $('#m-dstatus'); if (m && m.value !== v) m.value = v;
    loadDeposits();
  }
  function setWdStatus(v) {
    wdStatus = v;
    $$('[data-wstatus]').forEach(b => b.classList.toggle('is-active', b.dataset.wstatus === v));
    const m = $('#m-wstatus'); if (m && m.value !== v) m.value = v;
    loadWithdrawals();
  }

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
  document.addEventListener('click', async e => {
    const t = e.target;

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

    if (t.id === 'save-settings') {
      const body = {};
      $$('[data-set]').forEach(el => {
        body[el.dataset.set] = el.type === 'checkbox' ? el.checked
                             : el.type === 'number' ? Number(el.value) : el.value;
      });
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
    if (padj) {
      const amt = prompt('Amount (negative to deduct):'); if (amt === null) return;
      const bucket = prompt('Bucket: deposit / winnings / referral', 'deposit'); if (!bucket) return;
      const reason = prompt('Reason (required):'); if (!reason) return;
      try { await call(`/admin/players/${padj.dataset.padjust}/adjust`,
        { method: 'POST', body: JSON.stringify({ amount: Number(amt), bucket, reason }) });
        toast('Wallet adjusted', 'success'); openPlayer(padj.dataset.padjust); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
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
    if (e.target.id === 'qr-file') {
      const file = e.target.files[0]; if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      fetch(API + '/admin/deposit-qr', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd })
        .then(r => r.json()).then(d => {
          if (d.error) throw new Error(d.error);
          $('#qr-preview').src = IMG + d.url; $('#qr-preview').classList.remove('hidden');
          toast('QR uploaded', 'success');
        }).catch(err => toast(err.message, 'error'));
      e.target.value = '';
      return;
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
