/* ============================================================
   Rebuilding the stake split on battles that predate it.

   Without this, every battle already in flight when the
   refund-to-source change ships falls back to refunding the whole
   stake to deposit — the bucket-converting behaviour the change
   exists to stop.
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

const { backfillStakeSplits } = await import('../server/src/lib/backfill.js');
const { refundStake } = await import('../server/src/lib/settlement.js');
const { getWallet } = await import('../server/src/lib/db.js');

const HOST = 1, GUEST = 2;

function seedBattle({ id = 'b1', status = 'waiting', amount = 500, acceptor = GUEST, ...rest } = {}) {
  fake.col('battles').docs.push({
    id, status, amount, creator_id: HOST, acceptor_id: acceptor,
    creator_stake: null, acceptor_stake: null, ...rest,
  });
  return fake.col('battles').docs.at(-1);
}
const stakeRow = (battleId, userId, bucket, amount) =>
  fake.col('transactions').docs.push({
    ref_id: battleId, user_id: userId, type: 'debit', bucket, amount, note: 'Battle stake',
  });
const battle = id => fake.col('battles').docs.find(b => b.id === id);

test('stake-split backfill', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('rebuilds a split stake from the ledger', async () => {
    seedBattle();
    stakeRow('b1', HOST, 'deposit', 400);
    stakeRow('b1', HOST, 'winnings', 100);
    const r = await backfillStakeSplits();
    assert.equal(r.repaired, 1);
    assert.deepEqual(battle('b1').creator_stake, { deposit: 400, winnings: 100 });
  });

  await t.test('rebuilds both players independently', async () => {
    seedBattle();
    stakeRow('b1', HOST, 'deposit', 500);
    stakeRow('b1', GUEST, 'deposit', 200);
    stakeRow('b1', GUEST, 'winnings', 300);
    await backfillStakeSplits();
    assert.deepEqual(battle('b1').creator_stake, { deposit: 500, winnings: 0 });
    assert.deepEqual(battle('b1').acceptor_stake, { deposit: 200, winnings: 300 });
  });

  await t.test('a repaired battle then refunds to the right buckets', async () => {
    // The whole point: repair, then refund, and the money lands where it began.
    fake.col('wallets').docs.push({ user_id: HOST, deposit: 0, winnings: 0, referral: 0 });
    seedBattle();
    stakeRow('b1', HOST, 'deposit', 400);
    stakeRow('b1', HOST, 'winnings', 100);
    await backfillStakeSplits();

    const res = await refundStake(null, battle('b1'), HOST, 'refund');
    assert.equal(res.recorded, true, 'the repaired split must be trusted');
    const w = await getWallet(HOST);
    assert.deepEqual([w.deposit, w.winnings], [400, 100]);
  });

  await t.test('leaves settled battles alone', async () => {
    for (const status of ['completed', 'cancelled']) {
      fake.reset();
      seedBattle({ status });
      stakeRow('b1', HOST, 'deposit', 500);
      const r = await backfillStakeSplits();
      assert.equal(r.repaired, 0, `${status} battles are done with`);
      assert.equal(battle('b1').creator_stake, null);
    }
  });

  await t.test('skips a battle whose ledger does not add up', async () => {
    seedBattle();
    stakeRow('b1', HOST, 'deposit', 300);      // ₹300 recorded against a ₹500 stake
    const r = await backfillStakeSplits();
    assert.equal(r.repaired, 0);
    assert.equal(battle('b1').creator_stake, null, 'a partial split must not be trusted');
  });

  await t.test('skips a battle with no stake rows at all', async () => {
    seedBattle();
    const r = await backfillStakeSplits();
    assert.equal(r.repaired, 0);
  });

  await t.test('never touches a battle that already has its split', async () => {
    seedBattle({ creator_stake: { deposit: 1, winnings: 499 } });
    stakeRow('b1', HOST, 'deposit', 500);
    const r = await backfillStakeSplits();
    assert.equal(r.scanned, 0, 'already-recorded battles are not even scanned');
    assert.deepEqual(battle('b1').creator_stake, { deposit: 1, winnings: 499 },
      'an existing split must not be overwritten');
  });

  await t.test('is safe to run twice', async () => {
    seedBattle();
    stakeRow('b1', HOST, 'deposit', 400);
    stakeRow('b1', HOST, 'winnings', 100);
    await backfillStakeSplits();
    const second = await backfillStakeSplits();
    assert.equal(second.scanned, 0, 'a restart must be a no-op');
    assert.deepEqual(battle('b1').creator_stake, { deposit: 400, winnings: 100 });
  });

  await t.test('one unrepairable battle does not stop the others', async () => {
    seedBattle({ id: 'bad', amount: 500 });
    stakeRow('bad', HOST, 'deposit', 1);        // does not add up
    seedBattle({ id: 'good', amount: 500 });
    stakeRow('good', HOST, 'deposit', 500);
    const r = await backfillStakeSplits();
    assert.equal(r.repaired, 1);
    assert.deepEqual(battle('good').creator_stake, { deposit: 500, winnings: 0 });
    assert.equal(battle('bad').creator_stake, null);
  });

  await t.test('reports nothing to do on a clean database', async () => {
    assert.deepEqual(await backfillStakeSplits(), { scanned: 0, repaired: 0 });
  });
});
