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
  let battle = null, claims = [], chosen = null, commission = 0.05;

  const STATUS = {
    open:      ['Waiting for an opponent to join',             'bg-gold/20 text-gold-deep'],
    requested: ['Opponent requested to join',                  'bg-brand/15 text-brand'],
    waiting:   ['Host accepted — waiting for room code',       'bg-brand/15 text-brand'],
    running:   ['Match in progress',                           'bg-cta/15 text-cta-deep'],
    completed: ['Battle settled',                              'bg-surface-page text-muted-dark'],
    cancelled: ['Battle cancelled',                            'bg-live/15 text-live'],
    disputed:  ['Result under review by support',              'bg-live/15 text-live'],
  };

  const payoutFor = amt => Math.round(amt * 2 * (1 - commission));
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
    $('#result-section').hidden = !(battle.status === 'running' && (isCreator() || isAcceptor()));
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

    $('#settled-section').hidden = !settled && battle.status !== 'disputed';
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
    try { commission = (await Api.config()).commission; } catch {}

    await load();
    if (!battle) return;

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
      if (!hadCode && b.roomCode) toast('Room code received: ' + b.roomCode, 'success');
      else if (wasStatus !== b.status) toast('Battle updated: ' + b.status, 'info');
      K.refresh().then(K.paint);                // balances may have moved
    });
    window.addEventListener('beforeunload', () => K.leaveBattle(id));

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
          await Api.request(`/battles/${id}/cancel-request`, { method: 'POST' });
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
      const btn = e.target.closest('[data-result]'); if (!btn) return;
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
      const proofFile = $('#proof').files[0];
      if (chosen === 'won' && !proofFile) { toast('Upload screenshot.', 'error'); return; }
      const btn = $('#submit-result');
      btn.disabled = true; btn.textContent = 'Submitting…';
      try {
        let proofUrl;
        if (proofFile) {
          $('#proof-status').textContent = 'Uploading screenshot…';
          const up = await Api.uploads.proof(proofFile);
          proofUrl = up.url;
          $('#proof-status').textContent = 'Screenshot uploaded.';
        }
        const res = await Api.battles.result(id, chosen, {
          proof: proofUrl,
          reason: chosen === 'cancel' ? $('#cancel-reason').value : undefined,
        });
        toast(res.state === 'pending' ? 'Reported — waiting for your opponent'
            : res.state === 'disputed' ? 'Results conflict — sent for review'
            : 'Result submitted', res.state === 'disputed' ? 'error' : 'success');
        chosen = null;
        await load();
        await K.refresh(); K.paint();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        toast(err.message, 'error');
        $('#proof-status').textContent = 'Upload failed. Try again.';
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
