/* Waiting room — live. Redirects into the battle the moment the
   server says an opponent joined. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, money } = K;
  const id = new URLSearchParams(location.search).get('id');
  let started = Date.now(), commission = 0.05;

  K.ready.then(async () => {
    if (!id) { location.replace('battles.html'); return; }
    try { commission = (await Api.config()).commission; } catch {}

    let battle;
    try { battle = (await Api.battles.get(id)).battle; }
    catch { location.replace('battles.html'); return; }

    $('#wr-amount').textContent = money(battle.amount);
    $('#wr-prize').textContent = money(Math.round(battle.amount * 2 * (1 - commission)));
    $('#wr-back').href = 'battles.html?mode=' + battle.mode;
    started = battle.createdAt || Date.now();

    setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $('#wr-elapsed').textContent = s < 60 ? `Waiting ${s}s` : `Waiting ${Math.floor(s / 60)}m ${s % 60}s`;
    }, 1000);

    // As soon as the opponent joins, the server pushes the update here.
    K.watchBattle(id);
    K.on('battle:updated', b => {
      if (!b || b.id !== id) return;
      if (b.status !== 'open') {
        $('#wr-title').textContent = 'Opponent found!';
        $('#wr-sub').textContent = b.acceptor ? b.acceptor.name + ' joined your battle' : '';
        setTimeout(() => (location.href = 'battle.html?id=' + id), 900);
      }
    });

    // Fallback poll for the case where websockets are blocked.
    setInterval(async () => {
      try {
        const b = (await Api.battles.get(id)).battle;
        if (b.status !== 'open') location.href = 'battle.html?id=' + id;
      } catch {}
    }, 5000);
  });
})();
