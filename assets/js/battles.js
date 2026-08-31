/* Battle lobby — live. Battles created or taken by other users appear
   and disappear here without a refresh, via Socket.IO. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, money, toast, busy } = K;
  const t = str => (window.KhelbroI18n ? window.KhelbroI18n.t(str) : str);

  const mode = new URLSearchParams(location.search).get('mode') === 'rich' ? 'rich' : 'lite';
  let cfg = { name: 'Ludo Classic', min: 50, max: 25000, step: 10 };
  let open = [], running = [], mine = [];

  const avatar = (name, tint) =>
    `<span class="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full ${tint} text-[11px] font-bold text-white"
           aria-hidden="true">${(name || '?').slice(0, 1).toUpperCase()}</span>`;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function openCard(b) {
    const me = K.state.user;
    const mine = me && b.creator && b.creator.id === me.id;
    const requested = me && b.acceptor && b.acceptor.id === me.id;
    const action = mine
      ? `<button class="inline-flex h-[30px] shrink-0 items-center rounded-[5px] border border-live px-[18px]
                        text-[10.5px] font-bold uppercase text-live transition hover:bg-live hover:text-white"
                 type="button" data-cancel="${b.id}">Cancel</button>`
      : requested
      ? `<a class="btn-play shrink-0 !bg-brand text-white text-center" href="battle.html?id=${b.id}">Requested</a>`
      : `<button class="btn-play shrink-0" type="button" data-play="${b.id}">Play</button>`;
    return `<li class="rounded-[5px] border border-line bg-surface" data-battle="${b.id}">
      <div class="flex h-[30px] items-center border-b border-accent-hair px-2.5">
        <span class="text-[9.75px] font-bold uppercase text-ink">${t('Challenge from')} ${esc(b.creator.name)}</span>
      </div>
      <div class="flex items-center gap-2 px-2.5 py-2.5">
        ${avatar(b.creator.name, 'bg-ludo-red')}
        <span class="min-w-0 flex-1 truncate pl-1 text-[10.5px] font-medium text-ink">${esc(b.creator.name)}</span>
        <span class="shrink-0 text-right leading-tight">
          <span class="block text-[8.25px] font-medium uppercase text-accent-fee">Entry fee</span>
          <span class="block text-[13.5px] font-black text-ink">${money(b.amount)}</span>
        </span>
        ${action}
      </div>
    </li>`;
  }

  const runningCard = b => `<li class="rounded-[5px] border border-line bg-surface" data-battle="${b.id}">
      <div class="flex h-[30px] items-center justify-between border-b border-accent-hair px-2.5">
        <span class="text-[9.75px] font-bold uppercase text-ink">${t('Playing for')}</span>
        <span class="text-[13.5px] font-black text-ink">${money(b.amount)}</span>
      </div>
      <div class="flex items-center gap-2 px-2.5 py-2.5">
        ${avatar(b.creator.name, 'bg-ludo-red')}
        <span class="min-w-0 flex-1 truncate pl-1 text-[10.5px] font-medium text-ink">${esc(b.creator.name)}</span>
        <span class="shrink-0 text-[10.5px] font-bold text-muted">${t('VS')}</span>
        <span class="min-w-0 flex-1 truncate pr-1 text-right text-[10.5px] font-medium text-ink">${esc(b.acceptor ? b.acceptor.name : '—')}</span>
        ${avatar(b.acceptor && b.acceptor.name, 'bg-ludo-blue')}
      </div>
    </li>`;

  /* ---------- the player's own battles ----------
     Only states you can still act on. Settled and cancelled ones live in
     game history, not here. */
  const ACTIVE = ['open', 'requested', 'waiting', 'running', 'disputed'];

  /* Short labels for a narrow table. Wording follows the battle room so a
     player does not meet two names for the same state. */
  const MINE_STATUS = {
    open:      ['Waiting',   'bg-gold/20 text-gold-deep'],
    requested: ['Requested', 'bg-brand/15 text-brand'],
    waiting:   ['Starting',  'bg-brand/15 text-brand'],
    running:   ['Running',   'bg-cta/15 text-cta-deep'],
    // Kept short: the row also carries a cancel action, and the table has to
    // fit a 320px phone without scrolling sideways.
    disputed:  ['Review',    'bg-live/15 text-live'],
  };

  const CANCEL_ICON =
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
       <path d="M6 6l12 12M18 6L6 18"></path>
     </svg>`;

  /* An eye, so the action reads as "look at this" rather than "do something". */
  const DETAILS_ICON =
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
       <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z"></path>
       <circle cx="12" cy="12" r="3"></circle>
     </svg>`;

  /* Cancelling is only possible before the match starts, and the server
     enforces that too: the host may cancel an `open` or `requested` battle,
     and a player who asked to join may withdraw that request. Once a room
     code exists the battle has to be played and reported. */
  function cancelButton(b, isCreator) {
    const canCancel = isCreator && (b.status === 'open' || b.status === 'requested');
    const canWithdraw = !isCreator && b.status === 'requested';
    if (!canCancel && !canWithdraw) return '';
    const attr = canCancel ? `data-mine-cancel="${b.id}"` : `data-mine-withdraw="${b.id}"`;
    const label = canCancel ? `Cancel the ${money(b.amount)} battle` : 'Withdraw your join request';
    return `<button class="inline-grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[5px]
                           border border-live/60 text-live transition hover:bg-live hover:text-white
                           focus-visible:bg-live focus-visible:text-white"
                    type="button" ${attr} aria-label="${label}" title="${label}">${CANCEL_ICON}</button>`;
  }

  function mineRow(b) {
    const me = K.state.user;
    const isCreator = me && b.creator && b.creator.id === me.id;
    // "Opponent" is whoever is not you.
    const other = isCreator ? b.acceptor : b.creator;
    const [label, tint] = MINE_STATUS[b.status] || [b.status, 'bg-surface-page text-muted-dark'];
    const modeTag = b.mode === 'rich' ? 'Rich' : 'Lite';
    return `<tr class="border-t border-accent-hair" data-battle="${b.id}">
      <td class="px-2.5 py-2 align-middle">
        <span class="block font-black text-ink">${money(b.amount)}</span>
        <span class="block text-[9px] font-bold uppercase text-muted">${modeTag}</span>
      </td>
      <td class="px-2.5 py-2 align-middle">
        <span class="inline-block rounded-full px-2 py-0.5 text-[9.75px] font-bold uppercase ${tint}">${t(label)}</span>
      </td>
      <td class="px-2.5 py-2 align-middle">
        <span class="block max-w-[110px] truncate text-ink">${other ? esc(other.name) : '<span class="text-muted">—</span>'}</span>
      </td>
      <td class="px-2 py-2 align-middle">
        <span class="flex items-center justify-end gap-1.5">
          ${cancelButton(b, isCreator)}
          <a class="inline-grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[5px] border border-line text-muted
                    transition hover:border-brand hover:text-brand focus-visible:border-brand focus-visible:text-brand"
             href="battle.html?id=${b.id}" aria-label="Open details for the ${money(b.amount)} battle"
             title="Open battle details">${DETAILS_ICON}</a>
        </span>
      </td>
    </tr>`;
  }

  function renderMine() {
    const section = $('#mine-section');
    if (!section) return;
    const signedIn = !!K.state.user;
    section.hidden = !signedIn;
    if (!signedIn) return;

    $('#mine-rows').innerHTML = mine.map(mineRow).join('');
    $('#mine-wrap').hidden = mine.length === 0;
    $('#mine-empty').hidden = mine.length > 0;
    $('#mine-count').textContent = mine.length ? `${mine.length} active` : '';
  }

  function render() {
    $('#open-list').innerHTML = open.map(openCard).join('');
    $('#open-empty').hidden = open.length > 0;
    $('#running-list').innerHTML = running.map(runningCard).join('');
    $('#running-empty').hidden = running.length > 0;
    renderMine();
  }

  async function load() {
    try {
      /* `mine` is not filtered by mode: a player wants every battle they are
         in, not only the ones matching the tab they happen to be looking at.
         It is only requested when signed in — /battles/mine needs auth. */
      const [o, r, m] = await Promise.all([
        Api.battles.list(mode, 'open'),
        Api.battles.list(mode, 'running'),
        K.state.user ? Api.battles.mine().catch(() => ({ battles: [] })) : Promise.resolve({ battles: [] }),
      ]);
      open = o.battles; running = r.battles;
      mine = (m.battles || [])
        .filter(b => ACTIVE.includes(b.status))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const showError = msg => {
    const el = $('#amount-err');
    el.textContent = msg; el.classList.remove('hidden');
    $('#amount').classList.add('field-error');
  };
  const clearError = () => {
    $('#amount-err').classList.add('hidden');
    $('#amount').classList.remove('field-error');
  };

  K.ready.then(async () => {
    // Business rules come from the server, never hard-coded here.
    try {
      const conf = await Api.config();
      cfg = conf.modes[mode];
    } catch { /* fall back to the defaults above */ }

    /* Commission is a server setting and depends on the stake, so show the
       real tiers rather than one number that would be wrong for half of them. */
    try {
      const conf = await K.config();
      /* `tiers`, not `t` — `t` is the translator in this scope. These always
         resolve, so the table shows both rates even against a server that
         does not publish them; one row labelled "All amounts" would state a
         rate that is wrong for half of every stake. */
      const tiers = K.commissionTiers();
      const pct = r => (r * 100).toFixed(1).replace(/\.0$/, '') + '%';
      const rows = $('#commission-rows');
      if (rows) {
        rows.innerHTML = [
          [`${t('Below')} ${money(tiers.threshold)}`, pct(tiers.under)],
          [`${money(tiers.threshold)} ${t('and above')}`, pct(tiers.from)],
        ].map(([label, rate]) =>
          `<tr><td class="border border-line px-2 py-1.5">${label}</td>` +
          `<td class="border border-line px-2 py-1.5">${rate}</td></tr>`).join('');
      }
      // Example uses a stake on the lower-rate side, matching the label above.
      const eg = $('#commission-example');
      if (eg) eg.textContent = money(K.prizeFor(500));
      if (conf.notice) toast(conf.notice, 'info', 6000);
    } catch {}

    $('#mode-title').textContent = cfg.name;
    $('#mode-range').textContent =
      `${t('Bet amount:')} ${money(cfg.min)} ${t('to')} ${money(cfg.max)}/-`;
    document.title = `${cfg.name} | Khelbro`;

    $('#amount').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
      clearError();
    });

    $('#create-form').addEventListener('submit', async e => {
      e.preventDefault();
      if (!K.state.user) { toast('Sign in to create a battle', 'error'); location.href = 'login.html'; return; }
      const amount = Number($('#amount').value);
      if (!amount) return showError('Enter an amount.');
      await busy($('#create-btn'), '', async () => {
        try {
          await Api.battles.create(mode, amount);
          toast('Battle created — waiting for an opponent', 'success');
          /* Stay on the lobby: the new battle shows up in My Battles below,
             where it can be watched or cancelled. */
          $('#amount').value = '';
          clearError();
          await K.refresh(); K.paint();       // the stake has left the balance
          await load();
          $('#mine-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
          showError(err.message);
          toast(err.message, 'error');
        }
      });
    });

    /* My Battles actions. Delegated, because the rows are re-rendered on every
       live update and per-row listeners would be lost with them. */
    $('#mine-rows').addEventListener('click', async e => {
      const cancel = e.target.closest('[data-mine-cancel]');
      const withdraw = e.target.closest('[data-mine-withdraw]');
      if (!cancel && !withdraw) return;

      const btn = cancel || withdraw;
      const id = btn.dataset.mineCancel || btn.dataset.mineWithdraw;
      if (!confirm(cancel
        ? 'Cancel this battle? Your entry fee is refunded.'
        : 'Withdraw your request to join this battle?')) return;

      await busy(btn, '', async () => {
        try {
          if (cancel) {
            await Api.battles.cancel(id);
            toast('Battle cancelled — amount refunded', 'success');
          } else {
            await Api.battles.cancelRequest(id);
            toast('Join request withdrawn', 'info');
          }
          await K.refresh(); K.paint();      // the refund lands in the balance
          await load();
        } catch (err) { toast(err.message, 'error'); load(); }
      });
    });

    $('#open-list').addEventListener('click', async e => {
      const play = e.target.closest('[data-play]');
      const cancel = e.target.closest('[data-cancel]');
      if (play) {
        if (!K.state.user) { toast('Sign in to play', 'error'); location.href = 'login.html'; return; }
        await busy(play, '', async () => {
          try {
            const { battle } = await Api.battles.accept(play.dataset.play);
            toast('Request sent to host — waiting for acceptance', 'info');
            location.href = 'battle.html?id=' + battle.id;
          } catch (err) { toast(err.message, 'error'); load(); }
        });
      }
      if (cancel) {
        await busy(cancel, '', async () => {
          try {
            await Api.battles.cancel(cancel.dataset.cancel);
            toast('Battle cancelled — amount refunded', 'success');
            await K.refresh(); K.paint(); load();
          } catch (err) { toast(err.message, 'error'); }
        });
      }
    });

    /* ---- live lobby ---- */
    K.on('battle:created', b => {
      // My own battle, possibly in the other mode — refresh My Battles for it.
      const me = K.state.user;
      if (me && b.creator && b.creator.id === me.id) { load(); return; }
      if (b.mode !== mode || b.status !== 'open') return;
      if (open.some(x => x.id === b.id)) return;
      open.unshift(b); render();
    });
    K.on('battle:removed', ({ id }) => {
      const before = open.length;
      open = open.filter(b => b.id !== id);
      if (open.length !== before) render();
      load();                       // pick up anything that moved into Running
    });
    K.on('battle:updated', () => load());

    K.revealAfter('#open-skeleton', '#open-wrap');
    await load();
  });
})();
