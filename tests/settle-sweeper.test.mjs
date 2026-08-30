/* ============================================================
   The settlement sweeper, against the in-memory Mongo stand-in.

   These cover the money-moving path: who gets paid when only one
   player reported, and the compare-and-swap that stops the sweeper
   acting on a battle that moved underneath it.

   Run via `npm test` (needs --experimental-test-module-mocks).
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fake-mongo.mjs';

const fake = createFakeDb();

const { mock } = await import('node:test');
mock.module(new URL('../server/src/lib/mongo.js', import.meta.url).href, {
  namedExports: {
    col: fake.col,
    nextId: fake.nextId,
    withTransaction: fake.withTransaction,
    connect: fake.connect,
    db: () => ({}),
    startSession: () => ({}),
    close: async () => {},
  },
});

const { runSettlementSweep } = await import('../server/src/lib/settle-sweeper.js');

const HOST = 1, GUEST = 2, STAKE = 500;

/** A battle parked in dispute with its grace period already elapsed. */
function seed({ claim = 'won', claimant = HOST, acceptor = GUEST, autoSettleAt = Date.now() - 1000 } = {}) {
  fake.reset();
  fake.col('settings').docs.push({ id: 1, commission: 0.05, referral_rate: 0.01, battle_limit: 2 });
  fake.col('wallets').docs.push({ user_id: HOST, deposit: 0, winnings: 0, referral: 0 });
  fake.col('wallets').docs.push({ user_id: GUEST, deposit: 0, winnings: 0, referral: 0 });
  fake.col('users').docs.push({ id: HOST, name: 'Host', referred_by: null });
  fake.col('users').docs.push({ id: GUEST, name: 'Guest', referred_by: null });
  fake.col('battles').docs.push({
    id: 'abcdef123456', mode: 'lite', amount: STAKE, status: 'disputed',
    creator_id: HOST, acceptor_id: acceptor, room_code: '12345678',
    room_set_at: Date.now() - 700000, created_at: Date.now() - 800000,
    winner_id: null, payout: null, settled_at: null, auto_settle_at: autoSettleAt,
  });
  if (claim) {
    fake.col('battle_claims').docs.push({ battle_id: 'abcdef123456', user_id: claimant, claim, created_at: Date.now() });
  }
  return fake.col('battles').docs[0];
}

const battle = () => fake.col('battles').docs[0];
const wallet = uid => fake.col('wallets').docs.find(w => w.user_id === uid);

/* Run a sweep with a concurrent commit landing between the transaction's read
   and its write, so the compare-and-swap has something to catch. The patch is
   restored in a finally — a leaked stub would silently corrupt later tests. */
async function withConcurrentChange(mutate, app = null) {
  const battles = fake.col('battles');
  const realFindOne = battles.findOne.bind(battles);
  let fired = false;
  battles.findOne = async (...args) => {
    const doc = await realFindOne(...args);
    if (!fired) { fired = true; mutate(battles.docs[0]); }
    return doc;                                   // caller still sees the old state
  };
  try { return await runSettlementSweep(app); }
  finally { battles.findOne = realFindOne; }
}

test('sweeper settles an unanswered claim', async t => {
  await t.test('a lone "won" pays the claimant the pot less commission', async () => {
    seed({ claim: 'won', claimant: HOST });
    const [r] = await runSettlementSweep(null);
    assert.equal(r.state, 'completed');
    assert.equal(battle().status, 'completed');
    assert.equal(battle().winner_id, HOST);
    // 500 * 2 * 0.95
    assert.equal(wallet(HOST).winnings, 950);
    assert.equal(wallet(GUEST).winnings, 0);
    assert.equal(battle().auto_settle_at, undefined, 'clock must be cleared');
  });

  await t.test('a lone "lost" pays the silent opponent', async () => {
    seed({ claim: 'lost', claimant: HOST });
    const [r] = await runSettlementSweep(null);
    assert.equal(r.state, 'completed');
    assert.equal(battle().winner_id, GUEST);
    assert.equal(wallet(GUEST).winnings, 950);
    assert.equal(wallet(HOST).winnings, 0);
  });

  await t.test('a lone "cancel" refunds both stakes and pays nobody', async () => {
    seed({ claim: 'cancel', claimant: HOST });
    const [r] = await runSettlementSweep(null);
    assert.equal(r.state, 'cancelled');
    assert.equal(battle().status, 'cancelled');
    assert.equal(wallet(HOST).deposit, STAKE);
    assert.equal(wallet(GUEST).deposit, STAKE);
    assert.equal(wallet(HOST).winnings + wallet(GUEST).winnings, 0);
  });

  await t.test('two claims are a real conflict and are left for an admin', async () => {
    seed({ claim: 'won', claimant: HOST });
    fake.col('battle_claims').docs.push({ battle_id: 'abcdef123456', user_id: GUEST, claim: 'won' });
    const [r] = await runSettlementSweep(null);
    assert.equal(r.state, 'left-for-admin');
    assert.equal(battle().status, 'disputed', 'stays disputed for a human');
    assert.equal(battle().auto_settle_at, undefined, 'but stops being re-swept');
    assert.equal(wallet(HOST).winnings + wallet(GUEST).winnings, 0, 'no money moves');
  });

  await t.test('a battle with no opponent is never auto-awarded', async () => {
    seed({ claim: 'won', claimant: HOST, acceptor: null });
    const [r] = await runSettlementSweep(null);
    assert.equal(r.state, 'left-for-admin');
    assert.equal(wallet(HOST).winnings, 0, 'must not pay a pot that was never staked twice');
  });

  await t.test('a battle whose grace has not elapsed is not picked up', async () => {
    seed({ claim: 'won', claimant: HOST, autoSettleAt: Date.now() + 60000 });
    const results = await runSettlementSweep(null);
    assert.deepEqual(results, []);
    assert.equal(battle().status, 'disputed');
  });
});

test('sweeper compare-and-swap', async t => {
  await t.test('a second sweep cannot settle the same battle twice', async () => {
    seed({ claim: 'won', claimant: HOST });
    await runSettlementSweep(null);
    const afterFirst = wallet(HOST).winnings;
    // The battle is no longer disputed, so a re-sweep must find nothing.
    const second = await runSettlementSweep(null);
    assert.deepEqual(second, []);
    assert.equal(wallet(HOST).winnings, afterFirst, 'no second payout');
  });

  await t.test('a battle settled mid-flight is skipped, not overwritten', async () => {
    seed({ claim: 'won', claimant: HOST });
    /* Interleave a concurrent settlement: the transaction reads the battle,
       then someone else's /result commits before our write lands. The guard
       carries the status and clock we read, so the write must miss. */
    const results = await withConcurrentChange(live => {
      live.status = 'completed'; live.winner_id = GUEST; live.payout = 950;
      delete live.auto_settle_at;
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].state, 'skipped', 'must not act on state it no longer holds');
    assert.equal(battle().winner_id, GUEST, 'the earlier settlement must stand');
    assert.equal(wallet(HOST).winnings, 0, 'the sweeper must not pay on top of it');
  });

  await t.test('a clock re-armed mid-flight blocks the write', async () => {
    seed({ claim: 'won', claimant: HOST });
    const results = await withConcurrentChange(live => {
      live.auto_settle_at = Date.now() + 600000;   // pushed out under us
    });
    assert.equal(results[0].state, 'skipped');
    assert.equal(battle().status, 'disputed');
    assert.equal(wallet(HOST).winnings, 0, 'no payout on a stale clock');
  });

  await t.test('a battle already settled is never selected in the first place', async () => {
    seed({ claim: 'won', claimant: HOST });
    battle().status = 'completed';
    assert.deepEqual(await runSettlementSweep(null), []);
    assert.equal(wallet(HOST).winnings, 0);
  });
});

test('sweeper pays referral cuts on an auto-settlement', async () => {
  seed({ claim: 'won', claimant: HOST });
  fake.col('users').docs.push({ id: 3, name: 'Referrer', referred_by: null });
  fake.col('wallets').docs.push({ user_id: 3, deposit: 0, winnings: 0, referral: 0 });
  fake.col('users').docs.find(u => u.id === HOST).referred_by = 3;

  await runSettlementSweep(null);
  // 1% of the ₹500 stake
  assert.equal(wallet(3).referral, 5);
  const note = fake.dump('transactions').find(r => r.user_id === 3);
  assert.match(note.note, /^Referral bonus — battle #/, 'sweeper labels its own settlements');
});

/* A stand-in for the Express app the sweeper pulls `io` off, recording every
   broadcast so the payload clients actually receive can be asserted on. */
function recordingApp() {
  const sent = [];
  return {
    sent,
    get: key => (key === 'io' ? { to: room => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) } : undefined),
  };
}

test('sweeper broadcast', async t => {
  await t.test('emits the same shape the routes emit, to the battle room', async () => {
    seed({ claim: 'won', claimant: HOST });
    const app = recordingApp();
    await runSettlementSweep(app);

    assert.equal(app.sent.length, 1);
    const { room, event, payload } = app.sent[0];
    assert.equal(room, 'battle:abcdef123456');
    assert.equal(event, 'battle:updated');
    // The client dereferences creator.name unguarded, so both must be present.
    assert.equal(payload.creator.name, 'Host');
    assert.equal(payload.acceptor.name, 'Guest');
    assert.equal(payload.status, 'completed');
    assert.equal(payload.winnerId, HOST);
    assert.equal(payload.payout, 950);
    // The room admits only the two players, so the code they already have stays.
    assert.equal(payload.roomCode, '12345678');
    assert.equal(payload.awaitingOpponent, false);
    assert.equal(payload.autoSettleAt, null);
    assert.equal(payload.cancelDeadline !== undefined, true, 'client reads this every tick');
  });

  await t.test('broadcasts a cancellation too', async () => {
    seed({ claim: 'cancel', claimant: HOST });
    const app = recordingApp();
    await runSettlementSweep(app);
    assert.equal(app.sent.length, 1);
    assert.equal(app.sent[0].payload.status, 'cancelled');
  });

  await t.test('says nothing when no battle settles', async () => {
    seed({ claim: 'won', claimant: HOST });
    fake.col('battle_claims').docs.push({ battle_id: 'abcdef123456', user_id: GUEST, claim: 'won' });
    const app = recordingApp();
    await runSettlementSweep(app);       // conflict -> left for an admin
    assert.deepEqual(app.sent, []);
  });

  await t.test('a failed broadcast does not undo the settlement', async () => {
    seed({ claim: 'won', claimant: HOST });
    const app = { get: () => ({ to: () => ({ emit: () => { throw new Error('socket gone'); } }) }) };
    await runSettlementSweep(app);
    assert.equal(battle().status, 'completed', 'money already moved and must stand');
    assert.equal(wallet(HOST).winnings, 950);
  });
});

test('sweeper stops retrying a battle that always fails', async t => {
  /* Make settleOne throw every time by breaking a collection it must read. */
  const breakClaims = () => {
    const claims = fake.col('battle_claims');
    claims.find = () => { throw new Error('claims unavailable'); };
  };

  await t.test('counts attempts and parks the battle after the limit', async () => {
    seed({ claim: 'won', claimant: HOST });
    breakClaims();

    let last;
    for (let i = 0; i < 3; i++) last = (await runSettlementSweep(null))[0];
    assert.equal(last.state, 'error');
    assert.equal(last.attempts, 3, 'each sweep counts one attempt');
    assert.equal(battle().auto_settle_at, undefined, 'stops being swept');
    assert.equal(battle().status, 'disputed', 'still visible to an admin');

    // Now that the clock is cleared it must not be picked up again.
    assert.deepEqual(await runSettlementSweep(null), []);
  });

  await t.test('a battle still under the limit keeps its clock', async () => {
    seed({ claim: 'won', claimant: HOST });
    breakClaims();
    const [r] = await runSettlementSweep(null);
    assert.equal(r.state, 'error');
    assert.equal(r.attempts, 1);
    assert.ok(battle().auto_settle_at, 'one failure must not park it');
  });
});

test('sweeper drains the queue oldest-first', async () => {
  fake.reset();
  fake.col('settings').docs.push({ id: 1, commission: 0.05, referral_rate: 0.01 });
  // Insert newest-first so insertion order is the opposite of the wanted order.
  const overdue = [3000, 1000, 5000, 2000];
  overdue.forEach((ago, i) => {
    const id = 'battle' + i;
    fake.col('battles').docs.push({
      id, mode: 'lite', amount: 100, status: 'disputed',
      creator_id: 10 + i, acceptor_id: 20 + i, created_at: Date.now() - 90000,
      winner_id: null, payout: null, settled_at: null,
      auto_settle_at: Date.now() - ago,
    });
    fake.col('battle_claims').docs.push({ battle_id: id, user_id: 10 + i, claim: 'won' });
    for (const uid of [10 + i, 20 + i]) {
      fake.col('users').docs.push({ id: uid, name: 'P' + uid, referred_by: null });
      fake.col('wallets').docs.push({ user_id: uid, deposit: 0, winnings: 0, referral: 0 });
    }
  });

  const results = await runSettlementSweep(null);
  assert.equal(results.length, 4);
  // Longest-overdue first: 5000, 3000, 2000, 1000 ms ago.
  assert.deepEqual(results.map(r => r.id), ['battle2', 'battle0', 'battle3', 'battle1']);
});
