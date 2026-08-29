/* Battle lobby — live. Battles created or taken by other users appear
   and disappear here without a refresh, via Socket.IO. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, money, toast, busy } = K;
  const t = str => (window.KhelbroI18n ? window.KhelbroI18n.t(str) : str);

  const mode = new URLSearchParams(location.search).get('mode') === 'rich' ? 'rich' : 'lite';
  let cfg = { name: 'Ludo Classic', min: 50, max: 25000, step: 10 };
  let open = [], running = [];

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

  function render() {
    $('#open-list').innerHTML = open.map(openCard).join('');
    $('#open-empty').hidden = open.length > 0;
    $('#running-list').innerHTML = running.map(runningCard).join('');
    $('#running-empty').hidden = running.length > 0;
  }

  async function load() {
    try {
      const [o, r] = await Promise.all([
        Api.battles.list(mode, 'open'),
        Api.battles.list(mode, 'running'),
      ]);
      open = o.battles; running = r.battles;
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

    // Commission is a server setting, so show whatever it actually is.
    try {
      const conf = await Api.config();
      const pct = Math.round(conf.commission * 100);
      $('#commission-value').textContent = pct + '%';
      $('#commission-example').textContent = money(Math.round(500 * 2 * (1 - conf.commission)));
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
          const { battle } = await Api.battles.create(mode, amount);
          toast('Battle created', 'success');
          location.href = 'battle.html?id=' + battle.id;
        } catch (err) {
          showError(err.message);
          toast(err.message, 'error');
        }
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
