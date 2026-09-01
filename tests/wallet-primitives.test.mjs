/* ============================================================
   The money primitives, against an in-memory Mongo stand-in.

   These are the operations every rupee in the system passes
   through, so they are tested for the hostile cases: concurrent
   spends, missing fields, and bad input.

   Run via `npm test` (needs --experimental-test-module-mocks).
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fake-mongo.mjs';

const fake = createFakeDb();

// db.js pulls its collection accessors from mongo.js — swap that out.
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

const { credit, debit, getWallet, spendable } = await import('../server/src/lib/db.js');

const seedWallet = async (userId, w = {}) => {
  fake.col('wallets').docs.push({
    user_id: userId, deposit: 0, winnings: 0, referral: 0, ...w,
  });
};

test('debit', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('spends deposit before winnings', async () => {
    await seedWallet(1, { deposit: 100, winnings: 100 });
    assert.deepEqual(await debit(1, 60, 'stake'), { deposit: 60, winnings: 0 });
    const w = await getWallet(1);
    assert.deepEqual([w.deposit, w.winnings], [40, 100], 'deposit is drained first');
  });

  await t.test('spills into winnings once deposit is exhausted', async () => {
    await seedWallet(2, { deposit: 30, winnings: 100 });
    assert.deepEqual(await debit(2, 80, 'stake'), { deposit: 30, winnings: 50 });
    const w = await getWallet(2);
    assert.deepEqual([w.deposit, w.winnings], [0, 50]);
  });

  await t.test('spends the exact full balance', async () => {
    await seedWallet(3, { deposit: 40, winnings: 60 });
    assert.deepEqual(await debit(3, 100, 'stake'), { deposit: 40, winnings: 60 });
    const w = await getWallet(3);
    assert.deepEqual([w.deposit, w.winnings], [0, 0]);
  });

  await t.test('refuses to overdraw by a single rupee', async () => {
    await seedWallet(4, { deposit: 40, winnings: 60 });
    assert.equal(await debit(4, 101, 'stake'), null, 'short debits report null');
    const w = await getWallet(4);
    assert.deepEqual([w.deposit, w.winnings], [40, 60], 'balance untouched on refusal');
  });

  await t.test('two concurrent stakes cannot overdraw the same wallet', async () => {
    // ₹100 available, two ₹100 battles started at the same moment.
    await seedWallet(5, { deposit: 100, winnings: 0 });
    const [a, b] = await Promise.all([
      debit(5, 100, 'battle A'),
      debit(5, 100, 'battle B'),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, 'exactly one stake may succeed');
    const w = await getWallet(5);
    assert.equal(w.deposit + w.winnings, 0);
    assert.ok(w.deposit >= 0 && w.winnings >= 0, 'no bucket may go negative');
  });

  await t.test('many concurrent spends never mint money', async () => {
    /* Twelve ₹100 stakes launched against a ₹500 balance, with no transaction
       isolation at all. On a stale read the guard refuses rather than
       overdrawing — the safe direction — so fewer than five may get through
       here; production retries the transaction with a fresh read. What must
       hold unconditionally is that the money removed equals the money spent
       and no bucket ever goes negative. */
    const START = 500;
    await seedWallet(6, { deposit: 250, winnings: 250 });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => debit(6, 100, 'stake ' + i)));
    const wins = results.filter(Boolean).length;

    const w = await getWallet(6);
    assert.ok(wins >= 1, 'at least one stake must get through');
    assert.ok(w.deposit >= 0, `deposit went negative: ${w.deposit}`);
    assert.ok(w.winnings >= 0, `winnings went negative: ${w.winnings}`);
    assert.equal(START - (w.deposit + w.winnings), wins * 100,
      'rupees removed must equal exactly what was reported as spent');

    // The ledger is the other half of the invariant: it must agree with the wallet.
    const debited = fake.dump('transactions')
      .filter(r => r.user_id === 6 && r.type === 'debit')
      .reduce((sum, r) => sum + r.amount, 0);
    assert.equal(debited, wins * 100, 'ledger must match the wallet movement');
  });

  await t.test('rejects nonsense amounts instead of corrupting the balance', async () => {
    await seedWallet(7, { deposit: 100 });
    for (const bad of [0, -50, NaN, Infinity, undefined, null]) {
      assert.equal(await debit(7, bad, 'junk'), null, `${String(bad)} must be refused`);
    }
    assert.equal((await getWallet(7)).deposit, 100);
  });

  await t.test('returns false for a wallet that does not exist', async () => {
    assert.equal(await debit(999, 10, 'stake'), null);
  });

  await t.test('writes one ledger row per bucket touched', async () => {
    await seedWallet(8, { deposit: 30, winnings: 100 });
    await debit(8, 80, 'split stake');
    const rows = fake.dump('transactions').filter(r => r.user_id === 8);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => [r.bucket, r.amount]).sort(), [['deposit', 30], ['winnings', 50]]);
  });
});

test('credit', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('adds to the named bucket and logs it', async () => {
    await seedWallet(10, { deposit: 5 });
    await credit(10, 'winnings', 950, 'Battle won');
    const w = await getWallet(10);
    assert.deepEqual([w.deposit, w.winnings], [5, 950]);
    assert.equal(fake.dump('transactions').at(-1).note, 'Battle won');
  });

  await t.test('creates the wallet when it is missing, seeding every bucket', async () => {
    await credit(11, 'winnings', 100, 'Battle won');
    const doc = fake.dump('wallets').find(d => d.user_id === 11);
    // All three must exist as numbers, or debit()'s $gte guards silently fail.
    for (const b of ['deposit', 'winnings', 'referral']) {
      assert.equal(typeof doc[b], 'number', `${b} must be seeded`);
    }
    assert.equal(doc.winnings, 100);
  });

  await t.test('a wallet born from a credit can still be debited', async () => {
    await credit(12, 'winnings', 500, 'Battle won');
    assert.deepEqual(await debit(12, 500, 'stake'), { deposit: 0, winnings: 500 },
      'missing-field guard regression');
    assert.equal((await getWallet(12)).winnings, 0);
  });

  await t.test('refuses a non-positive amount rather than silently debiting', async () => {
    await seedWallet(13, { deposit: 100 });
    for (const bad of [0, -100, NaN, undefined]) {
      await assert.rejects(() => credit(13, 'deposit', bad, 'junk'), /non-positive/);
    }
    assert.equal((await getWallet(13)).deposit, 100);
  });

  await t.test('refuses an unknown bucket', async () => {
    await assert.rejects(() => credit(14, 'bonus', 100, 'junk'), /unknown bucket/);
  });
});

test('getWallet', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('never returns null — it creates the row', async () => {
    const w = await getWallet(20);
    assert.deepEqual(w, { deposit: 0, winnings: 0, referral: 0 });
    assert.equal(fake.dump('wallets').length, 1);
  });

  await t.test('coerces missing buckets to zero rather than undefined', async () => {
    fake.col('wallets').docs.push({ user_id: 21, deposit: 50 });   // legacy row
    const w = await getWallet(21);
    assert.deepEqual(w, { deposit: 50, winnings: 0, referral: 0 });
    assert.equal(await spendable(21), 50, 'spendable must not be NaN');
  });
});
