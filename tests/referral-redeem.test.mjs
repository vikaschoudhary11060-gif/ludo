/* ============================================================
   Redeeming referral earnings.

   Referral money lands in Winnings, which is the withdrawable
   bucket — so this path leads directly to a cash-out and has to
   be exact. It replays the route's own two steps: claim the
   balance atomically, then credit it.
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

const { credit, getWallet, col, withTransaction } = await import('../server/src/lib/db.js');

const USER = 5;
const seedWallet = w => fake.col('wallets').docs.push({
  user_id: USER, deposit: 0, winnings: 0, referral: 0, ...w,
});

/** The redeem route's body, verbatim in behaviour. */
async function redeem(userId = USER) {
  let amount = 0;
  await withTransaction(async session => {
    const before = await col('wallets').findOneAndUpdate(
      { user_id: userId, referral: { $gt: 0 } },
      { $set: { referral: 0 } },
      { session, returnDocument: 'before' });
    if (!before) throw new Error('NO_REFERRAL');
    amount = before.referral;
    await credit(userId, 'winnings', amount, 'Referral earnings redeemed', null, 'success', session);
  }).catch(e => {
    if (e.message === 'NO_REFERRAL') return null;
    throw e;
  });
  return amount;
}

test('redeeming referral earnings', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('moves the balance into winnings, not deposit', async () => {
    seedWallet({ deposit: 100, winnings: 200, referral: 75 });
    assert.equal(await redeem(), 75);
    const w = await getWallet(USER);
    assert.equal(w.winnings, 275, 'referral money must be withdrawable');
    assert.equal(w.deposit, 100, 'deposit is untouched');
    assert.equal(w.referral, 0, 'the bucket is emptied');
  });

  await t.test('conserves the money exactly', async () => {
    seedWallet({ deposit: 40, winnings: 60, referral: 33 });
    const before = 40 + 60 + 33;
    await redeem();
    const w = await getWallet(USER);
    assert.equal(w.deposit + w.winnings + w.referral, before, 'no rupee created or lost');
  });

  await t.test('refuses when there is nothing to redeem', async () => {
    seedWallet({ deposit: 10, winnings: 10, referral: 0 });
    assert.equal(await redeem(), 0);
    const w = await getWallet(USER);
    assert.deepEqual([w.deposit, w.winnings, w.referral], [10, 10, 0], 'nothing moves');
  });

  await t.test('refuses for a wallet that does not exist', async () => {
    assert.equal(await redeem(999), 0);
  });

  await t.test('two concurrent redeems credit the balance once', async () => {
    // The whole reason the claim is a single findOneAndUpdate.
    seedWallet({ deposit: 0, winnings: 0, referral: 500 });
    const [a, b] = await Promise.all([redeem(), redeem()]);
    const w = await getWallet(USER);
    assert.equal(a + b, 500, 'exactly one redeem may take the balance');
    assert.equal(w.winnings, 500, 'never credited twice');
    assert.equal(w.referral, 0);
  });

  await t.test('a second redeem after the first finds nothing', async () => {
    seedWallet({ referral: 120 });
    assert.equal(await redeem(), 120);
    assert.equal(await redeem(), 0);
    assert.equal((await getWallet(USER)).winnings, 120);
  });

  await t.test('writes one ledger row naming the source', async () => {
    seedWallet({ referral: 250 });
    await redeem();
    const rows = fake.dump('transactions').filter(r => r.user_id === USER);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bucket, 'winnings');
    assert.equal(rows[0].amount, 250);
    assert.match(rows[0].note, /Referral earnings redeemed/);
  });

  await t.test('redeemed money is then withdrawable', async () => {
    /* The point of the change: withdraw() only lets winnings out, so redeemed
       referral money has to clear that check. */
    seedWallet({ deposit: 0, winnings: 0, referral: 300 });
    await redeem();
    const w = await getWallet(USER);
    const withdrawable = w.winnings;
    assert.equal(withdrawable, 300, 'the full referral balance can be cashed out');
  });
});
