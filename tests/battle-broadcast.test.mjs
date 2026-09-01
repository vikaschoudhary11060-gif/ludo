/* ============================================================
   Who hears about a battle change.

   A player only sees a live update if the server names them as a
   recipient. Getting that list wrong is invisible in the UI until
   someone is left staring at a stale row — which is exactly what
   happened when a rejected opponent was dropped from the battle
   before the broadcast went out.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

/* The recipient rule from routes/battles.js. Kept in step by the guard test
   at the bottom, which fails if the route's own copy drifts from this one. */
function recipientsOf(battle, also = []) {
  return [...new Set([battle.creator_id, battle.acceptor_id, ...also].filter(u => u != null))];
}

const HOST = 7, GUEST = 8;

test('battle broadcast recipients', async t => {
  await t.test('both players hear about a battle they are both on', () => {
    assert.deepEqual(recipientsOf({ creator_id: HOST, acceptor_id: GUEST }), [HOST, GUEST]);
  });

  await t.test('an unmatched battle reaches only its host', () => {
    assert.deepEqual(recipientsOf({ creator_id: HOST, acceptor_id: null }), [HOST]);
  });

  await t.test('a rejected opponent is still told', () => {
    /* reject-request clears acceptor_id before the broadcast, so the person
       being rejected is not on the document any more. Without naming them the
       host updates and the rejected player keeps a stale Requested row. */
    const afterReject = { creator_id: HOST, acceptor_id: null };
    assert.deepEqual(recipientsOf(afterReject), [HOST], 'the document alone loses them');
    assert.deepEqual(recipientsOf(afterReject, [GUEST]), [HOST, GUEST], 'naming them fixes it');
  });

  await t.test('a withdrawing opponent is still told', () => {
    const afterWithdraw = { creator_id: HOST, acceptor_id: null };
    assert.deepEqual(recipientsOf(afterWithdraw, [GUEST]), [HOST, GUEST]);
  });

  await t.test('nobody is told twice', () => {
    // The actor is often already on the document.
    assert.deepEqual(recipientsOf({ creator_id: HOST, acceptor_id: GUEST }, [HOST, GUEST]), [HOST, GUEST]);
  });

  await t.test('a null extra recipient is ignored', () => {
    assert.deepEqual(recipientsOf({ creator_id: HOST, acceptor_id: GUEST }, [null, undefined]), [HOST, GUEST]);
  });
});

test('each recipient is shaped for themselves', async () => {
  const { shape } = await import('../server/src/lib/battle-view.js');
  const battle = {
    id: 'abcdef123456', mode: 'lite', amount: 500, status: 'running',
    creator_id: HOST, acceptor_id: GUEST, creator_name: 'Host', acceptor_name: 'Guest',
    room_code: '12345678', room_set_at: Date.now(), created_at: Date.now(),
    winner_id: null, payout: null, settled_at: null,
  };

  // Both players may see the room code — it is how they reach the match.
  for (const uid of recipientsOf(battle)) {
    assert.equal(shape(battle, uid).roomCode, '12345678', `player ${uid} needs the room code`);
  }
  // Anyone else must not, which is the reason shape() takes a viewer at all.
  assert.equal(shape(battle, 999).roomCode, null);
  assert.equal(shape(battle, null).roomCode, null);
});

test('the route uses this recipient rule', async () => {
  /* A structural guard: the broadcast helper must derive its recipients from
     both players plus the extras, and must shape per recipient rather than
     sharing one payload. If someone reverts to a single shared shape() call
     this fails and says why. */
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = fs.readFileSync(
    fileURLToPath(new URL('../server/src/routes/battles.js', import.meta.url)), 'utf8');
  const fn = src.slice(src.indexOf('function emitBattle'), src.indexOf('/* GET /api/battles?'));

  assert.match(fn, /\[b\.creator_id, b\.acceptor_id, \.\.\.also\]/,
    'recipients must include the extras, or a rejected opponent is missed');
  assert.match(fn, /shape\(b, uid\)/,
    'each recipient must be shaped for themselves, not handed another player\'s view');
  assert.doesNotMatch(fn, /shape\(b, b\.creator_id\)/,
    'one payload shaped for the creator must not be broadcast to everyone');
});
