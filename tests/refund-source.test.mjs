/* ============================================================
   Refunds must return money to the buckets it was taken from.

   A ₹500 stake paid as ₹400 deposit + ₹100 winnings has to come
   back the same way. Crediting the lot to deposit silently turned
   withdrawable winnings into play-only balance every time a
   battle was called off.
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

const { debit, getWallet } = await import('../server/src/lib/db.js');
const { refundStake } = await import('../server/src/lib/settlement.js');

const HOST = 1, GUEST = 2;

const seedWallet = (id, w) => fake.col('wallets').docs.push({
  user_id: id, deposit: 0, winnings: 0, referral: 0, ...w,
});

const battleWith = extra => ({
  id: 'b1', amount: 500, creator_id: HOST, acceptor_id: GUEST,
  creator_stake: null, acceptor_stake: null, ...extra,
});

test('debit reports which buckets it drew from', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('deposit only, when it covers the stake', async () => {
    seedWallet(HOST, { deposit: 900, winnings: 5000 });
    assert.deepEqual(await debit(HOST, 500, 'stake'), { deposit: 500, winnings: 0 });
  });

  await t.test('the exact split when deposit falls short', async () => {
    // The reported case: ₹400 cash, ₹5,000 winnings, ₹500 stake.
    seedWallet(HOST, { deposit: 400, winnings: 5000 });
    assert.deepEqual(await debit(HOST, 500, 'stake'), { deposit: 400, winnings: 100 });
    const w = await getWallet(HOST);
    assert.deepEqual([w.deposit, w.winnings], [0, 4900]);
  });

  await t.test('winnings only, when there is no deposit', async () => {
    seedWallet(HOST, { deposit: 0, winnings: 5000 });
    assert.deepEqual(await debit(HOST, 500, 'stake'), { deposit: 0, winnings: 500 });
  });

  await t.test('null when short, and nothing moves', async () => {
    seedWallet(HOST, { deposit: 100, winnings: 100 });
    assert.equal(await debit(HOST, 500, 'stake'), null);
    const w = await getWallet(HOST);
    assert.deepEqual([w.deposit, w.winnings], [100, 100], 'balance untouched');
  });
});

test('refund returns money to its source', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('the reported case: ₹400 cash + ₹100 winnings comes back split', async () => {
    seedWallet(HOST, { deposit: 400, winnings: 5000 });
    const stake = await debit(HOST, 500, 'stake');
    const b = battleWith({ creator_stake: stake });

    await refundStake(null, b, HOST, 'Battle cancelled — refund');

    const w = await getWallet(HOST);
    assert.equal(w.deposit, 400, 'the ₹400 goes back to cash, not ₹500');
    assert.equal(w.winnings, 5000, 'the ₹100 goes back to winnings');
  });

  await t.test('a whole-deposit stake comes back whole to deposit', async () => {
    seedWallet(HOST, { deposit: 900, winnings: 0 });
    const stake = await debit(HOST, 500, 'stake');
    await refundStake(null, battleWith({ creator_stake: stake }), HOST, 'refund');
    const w = await getWallet(HOST);
    assert.deepEqual([w.deposit, w.winnings], [900, 0]);
  });

  await t.test('a whole-winnings stake comes back whole to winnings', async () => {
    seedWallet(HOST, { deposit: 0, winnings: 900 });
    const stake = await debit(HOST, 500, 'stake');
    await refundStake(null, battleWith({ creator_stake: stake }), HOST, 'refund');
    const w = await getWallet(HOST);
    assert.deepEqual([w.deposit, w.winnings], [0, 900], 'withdrawable money stays withdrawable');
  });

  await t.test('stake then refund leaves the wallet exactly as it started', async () => {
    for (const start of [
      { deposit: 400, winnings: 5000 },
      { deposit: 0, winnings: 500 },
      { deposit: 500, winnings: 0 },
      { deposit: 499, winnings: 1 },
      { deposit: 1, winnings: 499 },
    ]) {
      fake.reset();
      seedWallet(HOST, start);
      const stake = await debit(HOST, 500, 'stake');
      await refundStake(null, battleWith({ creator_stake: stake }), HOST, 'refund');
      const w = await getWallet(HOST);
      assert.deepEqual([w.deposit, w.winnings], [start.deposit, start.winnings],
        `round trip changed the buckets for ${JSON.stringify(start)}`);
    }
  });

  await t.test('refunds the acceptor from their own recorded split', async () => {
    seedWallet(GUEST, { deposit: 200, winnings: 800 });
    const stake = await debit(GUEST, 500, 'stake');       // 200 + 300
    await refundStake(null, battleWith({ acceptor_stake: stake }), GUEST, 'refund');
    const w = await getWallet(GUEST);
    assert.deepEqual([w.deposit, w.winnings], [200, 800]);
  });

  await t.test('a battle with no recorded split falls back to deposit', async () => {
    // Battles created before the split was recorded must still refund.
    seedWallet(HOST, { deposit: 0, winnings: 0 });
    const r = await refundStake(null, battleWith({}), HOST, 'refund');
    assert.equal(r.recorded, false);
    const w = await getWallet(HOST);
    assert.deepEqual([w.deposit, w.winnings], [500, 0]);
  });

  await t.test('a split that does not add up is not trusted', async () => {
    seedWallet(HOST, { deposit: 0, winnings: 0 });
    // Corrupt or partial data must not under- or over-refund.
    const r = await refundStake(null, battleWith({ creator_stake: { deposit: 10, winnings: 10 } }), HOST, 'refund');
    assert.equal(r.recorded, false, 'a split that misses the amount is ignored');
    const w = await getWallet(HOST);
    assert.equal(w.deposit + w.winnings, 500, 'the player still gets the full stake back');
  });

  await t.test('refunding a player who is not in the battle still returns their stake', async () => {
    seedWallet(99, { deposit: 0, winnings: 0 });
    const r = await refundStake(null, battleWith({}), 99, 'refund');
    assert.equal(r.recorded, false);
    assert.equal((await getWallet(99)).deposit, 500);
  });

  await t.test('refuses a battle side that nobody filled', async () => {
    /* A disputed battle can reach an admin with one seat empty. `null` used to
       match acceptor_id === null, find no split and credit the full stake to a
       wallet keyed on null — money out of thin air. */
    for (const bad of [null, undefined, '3', 1.5, NaN]) {
      await assert.rejects(
        () => refundStake(null, battleWith({ acceptor_id: null }), bad, 'refund'),
        /non-player id/,
        `refundStake accepted ${String(bad)} as a player`);
    }
    assert.equal(fake.dump('wallets').length, 0, 'a phantom wallet was created');
    assert.equal(fake.dump('transactions').length, 0, 'a phantom ledger row was written');
  });

  await t.test('the ledger records each bucket separately', async () => {
    seedWallet(HOST, { deposit: 400, winnings: 5000 });
    const stake = await debit(HOST, 500, 'stake');
    await refundStake(null, battleWith({ creator_stake: stake }), HOST, 'Battle cancelled — refund');
    const credits = fake.dump('transactions')
      .filter(r => r.user_id === HOST && r.type === 'credit')
      .map(r => [r.bucket, r.amount]).sort();
    assert.deepEqual(credits, [['deposit', 400], ['winnings', 100]]);
  });
});
