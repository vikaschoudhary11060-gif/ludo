/* Battle room — live for both players.

   When the creator sets the room code, the server emits
   `battle:updated` into the battle's Socket.IO room, and the
   opponent's screen re-renders immediately. Same for accepting
   and for result settlement. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, money, toast, busy, copy } = K;

  const id = new URLSearchParams(location.search).get('id');
  let battle = null, claims = [], chosen = null;
  /* Server-owned windows, filled from /api/config. The literals are only a
     stand-in until that call returns — the server is always the authority. */
  let cancelWindowMs = 10 * 60 * 1000, claimGraceMs = 10 * 60 * 1000;
  let tickTimer = null;

  /* Status lines are cosmetic. Writing one must never be able to fail the
     action it is describing — a missing #proof-status threw on the first line
     of the submit handler, and threw again inside its own catch, so no result
     could be submitted at all. */
  const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };

  const mmss = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
  };
  /* A whole-unit description of the cancel window, e.g. "10 minutes". Seconds
     rather than a rounded minute count when it is not a whole number, so the
     copy never overstates how long a player actually has. */
  const windowLabel = () => {
    const secs = Math.round(cancelWindowMs / 1000);
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    if (secs < 60) return plural(secs, 'second');
    if (secs % 60 === 0) return plural(secs / 60, 'minute');
    return `${plural(Math.floor(secs / 60), 'minute')} ${plural(secs % 60, 'second')}`;
  };
  /* Mirrors the server's cancelWindowOpen(): the window runs from the room
     code going up, falling back to battle creation when there is no room code
     yet. Treating a missing deadline as "open" offered a Cancel the server
     then refused on battles that predate room_set_at. */
  const cancelDeadline = () => {
    if (!battle) return null;
    if (battle.cancelDeadline) return battle.cancelDeadline;
    const from = battle.roomSetAt || battle.createdAt;
    return from ? from + cancelWindowMs : null;
  };
  const cancelOpen = () => {
    const at = cancelDeadline();
    return at == null ? false : Date.now() <= at;
  };

  const STATUS = {
    open:      ['Waiting for an opponent to join',             'bg-gold/20 text-gold-deep'],
    requested: ['Opponent requested to join',                  'bg-brand/15 text-brand'],
    waiting:   ['Host accepted — waiting for room code',       'bg-brand/15 text-brand'],
    running:   ['Match in progress',                           'bg-cta/15 text-cta-deep'],
    completed: ['Battle settled',                              'bg-surface-page text-muted-dark'],
    cancelled: ['Battle cancelled',                            'bg-live/15 text-live'],
    disputed:  ['Result under review by support',              'bg-live/15 text-live'],
  };

  const payoutFor = amt => K.prizeFor(amt);   // tiered, matching the server
  const me = () => K.state.user;
  const isCreator  = () => battle && me() && battle.creator  && battle.creator.id  === me().id;
  const isAcceptor = () => battle && me() && battle.acceptor && battle.acceptor.id === me().id;
  const myClaim = () => claims.find(c => me() && c.user_id === me().id);

  function render() {
    if (!battle) { $('#battle-missing').hidden = false; return; }
    $('#battle-view').hidden = false;

    $('#p1-name').textContent = battle.creator.name;
    $('#p2-name').textContent = battle.acceptor ? battle.acceptor.name : 'Waiting…';
    $('#b-amount').textContent = money(battle.amount);
    $('#b-prize').textContent = money(payoutFor(battle.amount));
    /* The rate is a server setting and depends on the stake, so read it
       rather than printing a fixed percentage that goes stale the moment an
       admin changes the tiers. */
    if ($('#b-commission')) {
      const pct = (K.commissionFor(battle.amount) * 100).toFixed(1).replace(/\.0$/, '');
      $('#b-commission').textContent = `${pct}% commission`;
    }
    $('#back-link').href = 'battles.html?mode=' + battle.mode;

    const [text, cls] = STATUS[battle.status] || STATUS.open;
    const status = $('#b-status');
    status.textContent = isAcceptor() && battle.status === 'requested'
      ? 'Requested to join — waiting for host'
      : isCreator() && battle.status === 'requested'
      ? 'Opponent wants to join — accept request'
      : text;
    status.className = 'rounded-tile px-3 py-2.5 text-center text-body-sm font-bold ' + cls;

    const settled = ['completed', 'cancelled'].includes(battle.status);
    const canSet = isCreator() && battle.status === 'waiting';

    $('#room-section').hidden = settled || battle.status === 'requested' || battle.status === 'open';
    // The install links exist to get you into the room; once it is settled
    // they are just noise on the result screen.
    if ($('#ludoking-section')) $('#ludoking-section').hidden = settled;
    $('#room-form').hidden = !canSet;
    $('#room-display').hidden = !battle.roomCode;
    if (battle.roomCode) $('#room-code').textContent = battle.roomCode;
    $('#room-hint').textContent =
      settled ? '' :
      canSet ? 'Create a room in your Ludo app, then paste its 8-digit code here.' :
      battle.roomCode ? 'Open your Ludo app and join this room code.' :
      battle.status === 'open' ? 'The code appears once an opponent joins.' :
      battle.status === 'requested' ? 'Accept opponent request to proceed with room code.' :
      'Waiting for the creator to set the room code.';

    // Requested state panels
    const isReq = battle.status === 'requested';
    if ($('#request-section')) {
      $('#request-section').hidden = !(isCreator() && isReq);
      if (isCreator() && isReq && $('#req-title')) {
        $('#req-title').textContent = `${battle.acceptor ? battle.acceptor.name : 'Opponent'} wants to join!`;
        $('#req-desc').textContent = `Accept to lock the ₹${battle.amount} stake from both accounts and start the match.`;
      }
    }
    if ($('#opponent-pending-section')) {
      $('#opponent-pending-section').hidden = !(isAcceptor() && isReq);
    }

    // Result panel: only while running, only for the two players, only once
    const mine = myClaim();
    const inBattle = isCreator() || isAcceptor();
    // `awaitingOpponent` is a battle parked in dispute purely because the other
    // player has not reported yet — they must still be able to.
    const canReport = (battle.status === 'running' || battle.awaitingOpponent) && inBattle;
    $('#result-section').hidden = !canReport;
    if (canReport) { paintTimers(); if (!tickTimer) startTicking(); }
    if (!$('#result-section').hidden && mine) {
      $('#result-options').innerHTML =
        `<p class="col-span-3 rounded-tile bg-surface-page px-3 py-3 text-center text-body-sm text-muted">
           You reported <strong class="text-ink">${mine.claim}</strong>. Waiting for your opponent to confirm.
         </p>`;
      $('#proof-wrap').hidden = true;
      $('#cancel-wrap').hidden = true;
      $('#submit-result').hidden = true;
    }

    $('#cancel-section').hidden = !(isCreator() && battle.status === 'open');
    $('#reject-section').hidden = !(isCreator() && battle.status === 'waiting');

    $('#settled-section').hidden = !settled && !(battle.status === 'disputed' && !battle.awaitingOpponent);
    if (settled || battle.status === 'disputed') {
      const iWon = battle.winnerId && me() && battle.winnerId === me().id;
      if (iWon && !window.__confettiFired) {
        window.__confettiFired = true;
        setTimeout(() => window.KhelbroAnim && KhelbroAnim.confetti({ count: 200 }), 300);
      }
      $('#settled-icon').textContent =
        battle.status === 'disputed' ? '⚖️' : battle.status === 'cancelled' ? '↩️' : iWon ? '🏆' : '😔';
      $('#settled-title').textContent =
        battle.status === 'disputed' ? 'Under review' :
        battle.status === 'cancelled' ? 'Battle cancelled' : iWon ? 'You won!' : 'Battle lost';
      $('#settled-text').textContent =
        battle.status === 'disputed'
          ? 'You and your opponent reported different results. Support will check the proof and settle it.'
          : battle.status === 'cancelled'
            ? `${money(battle.amount)} was refunded to your wallet.`
            : iWon ? `${money(battle.payout || payoutFor(battle.amount))} credited to your winnings.`
                   : 'Better luck in the next one.';
    }
  }

  /* Two clocks live on this panel:
       - the 1-minute window to back out after the room code goes up
       - the 10-minute grace before a lone result is taken at face value
     Both run off absolute server instants, so a skewed device clock only
     shifts the display, never the server's decision. */
  function paintTimers() {
    const el = $('#result-timer');
    if (!el || !battle) return;

    const cancelBtn = $('[data-result="cancel"]');
    const open = cancelOpen();
    if (cancelBtn) {
      cancelBtn.disabled = !open;
      cancelBtn.classList.toggle('opacity-40', !open);
      cancelBtn.classList.toggle('pointer-events-none', !open);
      cancelBtn.title = open ? '' : 'The cancel window has closed';
      // Clear a stale selection so Submit cannot post a now-invalid cancel.
      if (!open && chosen === 'cancel') {
        chosen = null;
        cancelBtn.classList.remove('!border-brand', '!text-brand', 'bg-brand/5');
        $('#cancel-wrap').hidden = true;
        $('#submit-result').disabled = true;
      }
    }

    const parts = [];
    const deadline = cancelDeadline();
    if (deadline != null) {
      if (open) {
        const remaining = Math.max(0, deadline - Date.now());
        parts.push(`⏱️ Cancellation available for ${mmss(remaining)} (10-minute timer).`);
      } else {
        parts.push('The 10-minute cancel window has closed — play the match and report the result.');
      }
    }
    if (battle.awaitingOpponent && battle.autoSettleAt) {
      const left = battle.autoSettleAt - Date.now();
      parts.push(myClaim()
        ? (left > 0
            ? `Waiting for your opponent — your result stands in ${mmss(left)} if they do not report.`
            : 'Settling now on your report…')
        : (left > 0
            ? `Your opponent has reported. Submit your result within ${mmss(left)} or theirs stands.`
            : 'Settling now on your opponent’s report…'));
    }
    el.textContent = parts.join(' ');
    el.hidden = parts.length === 0;
  }

  function startTicking() {
    clearInterval(tickTimer);
    let settleCheckAt = 0;            // next allowed refetch, epoch ms
    tickTimer = setInterval(() => {
      if (!battle) return;

      // Nothing left to count down once the battle is over.
      if (!(battle.status === 'running' || battle.awaitingOpponent)) {
        clearInterval(tickTimer);
        tickTimer = null;
        return;
      }

      const wasOpen = cancelOpen();
      paintTimers();
      if (wasOpen && !cancelOpen()) toast('Cancel window closed', 'info');

      /* The sweeper settles on its own schedule, so poll for the result at
         its cadence rather than every tick — a 1s refetch produced dozens of
         redundant round trips per settlement and never stopped if the sweeper
         was stalled. */
      const now = Date.now();
      if (battle.awaitingOpponent && battle.autoSettleAt
          && now > battle.autoSettleAt + 2000 && now >= settleCheckAt) {
        settleCheckAt = now + 15000;
        load();
      }
    }, 1000);
  }

  async function load() {
    try {
      const data = await Api.battles.get(id);
      battle = data.battle; claims = data.claims || [];
      render();
    } catch {
      $('#battle-missing').hidden = false;
    }
  }

  K.ready.then(async () => {
    if (!id) { $('#battle-missing').hidden = false; return; }
    try {
      const conf = await K.config();
      /* Take a value only when the server actually sent a usable number. A
         bare assignment would replace a working default with undefined and
         put NaN on screen; `> 0` would discard a deliberate zero window. */
      const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
      cancelWindowMs = num(conf.cancelWindowMs, cancelWindowMs);
      claimGraceMs = num(conf.claimGraceMs, claimGraceMs);
    } catch {}

    await load();
    if (!battle) return;

    startTicking();
    K.watchBattle(id);

    if (window.KhelbroPush && (isCreator() || isAcceptor())) {
      setTimeout(() => KhelbroPush.offer('We\'ll tell you when your opponent joins or the room code is set.'), 2500);
    }
    // The other player's action lands here.
    K.on('battle:updated', b => {
      if (!b || b.id !== id) return;
      const wasStatus = battle && battle.status;
      const hadCode = battle && battle.roomCode;
      battle = b;
      load();                                   // refetch claims too

      /* The two moments worth interrupting someone for. Both arrive while the
         player is almost certainly looking at the Ludo app rather than at
         this screen, so they get a sound and a buzz, not a toast that fades
         while nobody is watching. */
      const alerts = window.KhelbroAlert;
      const gotOpponent = isCreator() && wasStatus === 'open' && b.status === 'requested';
      const matchStarted = isAcceptor() && !hadCode && !!b.roomCode;

      if (gotOpponent && alerts) {
        alerts.fire('Opponent found!',
          `${(b.acceptor && b.acceptor.name) || 'A player'} wants to join your ${money(b.amount)} battle. Accept to start.`);
      } else if (matchStarted && alerts) {
        alerts.fire('The host has started the match',
          `Open Ludo King and join room ${b.roomCode}.`);
      } else if (!hadCode && b.roomCode) {
        toast('Room code received: ' + b.roomCode, 'success');
      } else if (wasStatus !== b.status) {
        toast('Battle updated: ' + b.status, 'info');
      }

      K.refresh().then(K.paint);                // balances may have moved
    });
    window.addEventListener('beforeunload', () => { clearInterval(tickTimer); K.leaveBattle(id); });

    // Accept / Reject request buttons for host
    if ($('#accept-request-btn')) {
      $('#accept-request-btn').addEventListener('click', e => busy(e.currentTarget, 'Accepting', async () => {
        try {
          await Api.battles.acceptRequest(id);
          toast('Challenge request accepted! Enter room code.', 'success');
          await load(); await K.refresh(); K.paint();
        } catch (err) { toast(err.message, 'error'); }
      }));
    }
    if ($('#reject-request-btn')) {
      $('#reject-request-btn').addEventListener('click', e => busy(e.currentTarget, 'Declining', async () => {
        try {
          await Api.battles.rejectRequest(id);
          toast('Request declined. Battle returned to lobby.', 'info');
          await load();
        } catch (err) { toast(err.message, 'error'); }
      }));
    }
    if ($('#cancel-my-request-btn')) {
      $('#cancel-my-request-btn').addEventListener('click', e => busy(e.currentTarget, 'Cancelling', async () => {
        try {
          await Api.battles.cancelRequest(id);
          toast('Join request withdrawn', 'info');
          location.href = 'battles.html?mode=' + (battle ? battle.mode : 'lite');
        } catch (err) { toast(err.message, 'error'); }
      }));
    }

    $('#room-input').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8);
      $('#room-err').classList.add('hidden');
    });

    $('#room-form').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await Api.battles.setRoom(id, $('#room-input').value);
        $('#room-err').classList.add('hidden');
        $('#room-input').value = '';
        toast('Room code set', 'success');
        await load();
      } catch (err) {
        $('#room-err').textContent = err.message;
        $('#room-err').classList.remove('hidden');
      }
    });

    $('#copy-room').addEventListener('click', () => copy($('#room-code').textContent, 'Room code copied'));

    $('#result-options').addEventListener('click', e => {
      const btn = e.target.closest('[data-result]'); if (!btn || btn.disabled) return;
      chosen = btn.dataset.result;
      $$('[data-result]').forEach(b => {
        const on = b === btn;
        b.classList.toggle('!border-brand', on);
        b.classList.toggle('!text-brand', on);
        b.classList.toggle('bg-brand/5', on);
      });
      $('#proof-wrap').hidden = chosen !== 'won';
      $('#cancel-wrap').hidden = chosen !== 'cancel';
      $('#submit-result').disabled = false;
    });

    $('#submit-result').addEventListener('click', async () => {
      if (!chosen) return;
      if (chosen === 'cancel' && !cancelOpen()) {
        toast('The cancel window closed. Report won or lost instead.', 'error');
        paintTimers();
        return;
      }
      const proofFile = $('#proof').files[0];
      if (chosen === 'won' && !proofFile) { toast('Upload screenshot.', 'error'); return; }
      const btn = $('#submit-result');
      btn.disabled = true; btn.textContent = 'Submitting…';
      try {
        let proofUrl;
        if (proofFile) {
          setText('#proof-status', 'Uploading screenshot…');
          const up = await Api.uploads.proof(proofFile);
          proofUrl = up.url;
          setText('#proof-status', 'Screenshot uploaded.');
        }
        const res = await Api.battles.result(id, chosen, {
          proof: proofUrl,
          reason: chosen === 'cancel' ? $('#cancel-reason').value : undefined,
        });
        toast(res.state === 'pending' || res.state === 'awaiting-opponent'
              ? `Reported — your opponent has ${mmss(claimGraceMs)} to confirm`
            : res.state === 'disputed' ? 'Results conflict — sent for review'
            : 'Result submitted', res.state === 'disputed' ? 'error' : 'success');
        chosen = null;
        await load();
        await K.refresh(); K.paint();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        toast(err.message, 'error');
        setText('#proof-status', err.message || 'Upload failed. Try again.');
      } finally {
        btn.disabled = false; btn.textContent = 'Submit result';
      }
    });

    $('#reject-battle').addEventListener('click', e => busy(e.currentTarget, 'Rejecting', async () => {
      try {
        await Api.battles.reject(id);
        toast('Player rejected — their amount was refunded', 'success');
        await load();
      } catch (err) { toast(err.message, 'error'); }
    }));

    $('#cancel-battle').addEventListener('click', e => busy(e.currentTarget, 'Cancelling', async () => {
      try {
        await Api.battles.cancel(id);
        toast('Battle cancelled — amount refunded', 'success');
        await load(); await K.refresh(); K.paint();
      } catch (err) { toast(err.message, 'error'); }
    }));
  });
})();
