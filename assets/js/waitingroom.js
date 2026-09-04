/* Waiting room — live. Redirects into the battle the moment the
   server says an opponent joined. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, money } = K;
  const id = new URLSearchParams(location.search).get('id');
  /* `Api.warm` may be absent for one navigation after a deploy: the service
     worker keeps api.js in its cached shell and serves it stale-while-
     revalidate, so a fresh copy of THIS file can be paired with the previous
     api.js. Falling back to calling the function directly is exactly what this
     page did before warming existed, so the worst case is the old timing —
     never a broken page. */
  const warm = (window.Api && Api.warm) || (fn => fn);
  // Issued now, consumed below — it does not depend on /api/config.
  const getBattle = id ? warm(() => Api.battles.get(id)) : () => Api.battles.get(id);
  let started = Date.now();

  K.ready.then(async () => {
    if (!id) { location.replace('battles.html'); return; }
    await K.config();

    let battle;
    try { battle = (await getBattle()).battle; }
    catch { location.replace('battles.html'); return; }

    // Real numbers in hand — swap the placeholder bars for the card.
    K.revealAfter('#wr-skeleton', '#wr-card');
    $('#wr-amount').textContent = money(battle.amount);
    $('#wr-prize').textContent = money(K.prizeFor(battle.amount));
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
