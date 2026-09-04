/* ============================================================
   The referral cut, and the per-transfer ledger behind it.

   Two rules are under test here.

   The rate: a referrer earns `referral_rate` of the stake, but
   when BOTH players in a battle were referred the rate is
   halved, so the house's referral cost for one battle is the
   same whether one player was referred or both.

   The record: every payout writes a `referral_earnings` row
   naming the referrer AND the player whose match paid for it.
   The wallet credit cannot answer the second half — it carries
   the referrer and the battle and nothing else — so the admin
   console reads these rows instead.
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

const { payReferralCuts, referralRateFor } = await import('../server/src/lib/settlement.js');
const { backfillReferralEarnings } = await import('../server/src/lib/backfill.js');

const HOST = 1, GUEST = 2, REF_A = 10, REF_B = 20, STAKE = 500;
const BATTLE = 'ffee00112233';

/** A settled battle plus the two players, with referrers wired as asked. */
function seed({ hostRef = null, guestRef = null, amount = STAKE, acceptor = GUEST } = {}) {
  fake.reset();
  for (const id of [HOST, GUEST, REF_A, REF_B]) {
    fake.col('wallets').docs.push({ user_id: id, deposit: 0, winnings: 0, referral: 0 });
  }
  fake.col('users').docs.push({ id: HOST, name: 'Host', referred_by: hostRef });
  fake.col('users').docs.push({ id: GUEST, name: 'Guest', referred_by: guestRef });
  fake.col('users').docs.push({ id: REF_A, name: 'Referrer A', referred_by: null });
  fake.col('users').docs.push({ id: REF_B, name: 'Referrer B', referred_by: null });
  return {
    id: BATTLE, mode: 'lite', amount, status: 'completed',
    creator_id: HOST, acceptor_id: acceptor, winner_id: HOST,
  };
}

const referralOf = uid => fake.col('wallets').docs.find(w => w.user_id === uid).referral;
const ledger = () => fake.dump('referral_earnings');

test('the referral cut when one player was referred', async t => {
  await t.test('pays the full configured rate', async () => {
    const battle = seed({ hostRef: REF_A });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(referralOf(REF_A), 5, '1% of a ₹500 stake');
    assert.equal(referralOf(REF_B), 0);
  });

  await t.test('records the transfer with both ends and the rate applied', async () => {
    const battle = seed({ hostRef: REF_A });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    const rows = ledger();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referrer_id, REF_A);
    assert.equal(rows[0].referee_id, HOST, 'the row names whose match paid');
    assert.equal(rows[0].battle_id, BATTLE);
    assert.equal(rows[0].stake, STAKE);
    assert.equal(rows[0].amount, 5);
    assert.equal(rows[0].rate, 0.01);
    assert.equal(rows[0].split, false);
    assert.equal(rows[0].source, 'battle');
  });

  await t.test('the source label follows the caller', async () => {
    const battle = seed({ hostRef: REF_A });
    await payReferralCuts(null, battle, { referral_rate: 0.01 }, [], 'dispute');
    assert.equal(ledger()[0].source, 'dispute');
    assert.match(fake.dump('transactions')[0].note, /^Referral bonus — dispute #/);
  });
});

test('the referral cut when both players were referred', async t => {
  await t.test('halves the rate for each referrer', async () => {
    const battle = seed({ hostRef: REF_A, guestRef: REF_B });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(referralOf(REF_A), 3, '0.5% of ₹500 is ₹2.50, rounded to ₹3');
    assert.equal(referralOf(REF_B), 3);
  });

  await t.test('total referral cost stays near one full rate, not two', async () => {
    const battle = seed({ hostRef: REF_A, guestRef: REF_B, amount: 1000 });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(referralOf(REF_A) + referralOf(REF_B), 10,
      'two referrers at 0.5% each cost the same as one at 1%');
  });

  await t.test('marks both rows as split, at the halved rate', async () => {
    const battle = seed({ hostRef: REF_A, guestRef: REF_B });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    const rows = ledger();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.split === true));
    assert.ok(rows.every(r => r.rate === 0.005));
    assert.ok(rows.every(r => r.base_rate === 0.01), 'the configured rate is kept alongside');
    assert.deepEqual(rows.map(r => r.referrer_id).sort((a, b) => a - b), [REF_A, REF_B]);
    assert.deepEqual(rows.map(r => r.referee_id).sort((a, b) => a - b), [HOST, GUEST]);
  });

  await t.test('one referrer who brought both players is paid twice at half rate', async () => {
    const battle = seed({ hostRef: REF_A, guestRef: REF_A });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(referralOf(REF_A), 6, 'two halved cuts of ₹3');
    const rows = ledger();
    assert.equal(rows.length, 2, 'one row per player, not one per referrer');
    assert.deepEqual(rows.map(r => r.referee_id).sort((a, b) => a - b), [HOST, GUEST]);
  });

  await t.test('credits the referrals rollup for each player separately', async () => {
    const battle = seed({ hostRef: REF_A, guestRef: REF_B });
    fake.col('referrals').docs.push({ referrer_id: REF_A, referee_id: HOST, earned: 0 });
    fake.col('referrals').docs.push({ referrer_id: REF_B, referee_id: GUEST, earned: 0 });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(fake.dump('referrals').find(r => r.referrer_id === REF_A).earned, 3);
    assert.equal(fake.dump('referrals').find(r => r.referrer_id === REF_B).earned, 3);
  });
});

test('the referral cut when it should not pay at all', async t => {
  await t.test('neither player referred — no credit, no row', async () => {
    const battle = seed();
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(ledger().length, 0);
    assert.equal(fake.dump('transactions').length, 0);
  });

  await t.test('a zero rate switches the programme off without querying', async () => {
    const battle = seed({ hostRef: REF_A, guestRef: REF_B });
    await payReferralCuts(null, battle, { referral_rate: 0 });
    assert.equal(referralOf(REF_A), 0);
    assert.equal(ledger().length, 0);
  });

  await t.test('a stake too small to round up to a rupee pays nothing', async () => {
    // ₹20 at a halved 1% is ₹0.10 — Math.round takes it to zero.
    const battle = seed({ hostRef: REF_A, guestRef: REF_B, amount: 20 });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(referralOf(REF_A), 0, 'credit() throws on a non-positive amount');
    assert.equal(ledger().length, 0);
  });

  await t.test("a battle nobody joined still pays the host's referrer", async () => {
    const battle = seed({ hostRef: REF_A, acceptor: null });
    await payReferralCuts(null, battle, { referral_rate: 0.01 });
    assert.equal(referralOf(REF_A), 5, 'one referred player is not a split');
    assert.equal(ledger()[0].split, false);
  });
});

test('referralRateFor states the rule on its own', async t => {
  await t.test('one referred player takes the whole rate', () => {
    assert.equal(referralRateFor(0.02, 1), 0.02);
  });
  await t.test('two referred players halve it', () => {
    assert.equal(referralRateFor(0.02, 2), 0.01);
  });
  await t.test('the split follows the configured rate rather than a fixed 0.5%', () => {
    assert.equal(referralRateFor(0.04, 2), 0.02, 'not hard-coded to 0.005');
  });
  await t.test('a missing rate falls back to the 1% default', () => {
    assert.equal(referralRateFor(undefined, 1), 0.01);
  });
  await t.test('a switched-off programme stays off', () => {
    assert.equal(referralRateFor(0, 2), 0);
  });
});

test('backfilling the transfer ledger from historical credits', async t => {
  /** A referral credit as it was written before the ledger existed. */
  const oldCredit = (referrer, battleId, amount, at) =>
    fake.col('transactions').docs.push({
      id: fake.col('transactions').docs.length + 1, user_id: referrer, type: 'credit',
      bucket: 'referral', amount, note: `Referral bonus — battle #${battleId.slice(-5)}`,
      ref_id: battleId, status: 'success', created_at: at,
    });

  await t.test('recovers the referee from the battle and the referrer link', async () => {
    seed({ hostRef: REF_A });
    fake.col('battles').docs.push({ id: BATTLE, amount: STAKE, mode: 'lite', creator_id: HOST, acceptor_id: GUEST });
    oldCredit(REF_A, BATTLE, 5, 1000);

    const out = await backfillReferralEarnings();
    assert.equal(out.written, 1);
    const [row] = ledger();
    assert.equal(row.referrer_id, REF_A);
    assert.equal(row.referee_id, HOST);
    assert.equal(row.amount, 5);
    assert.equal(row.rate, 0.01, 'the rate is derived from what was actually paid');
    assert.equal(row.source, 'backfill');
    assert.equal(row.created_at, 1000, 'the transfer keeps its original date');
  });

  await t.test('running it twice writes nothing the second time', async () => {
    seed({ hostRef: REF_A });
    fake.col('battles').docs.push({ id: BATTLE, amount: STAKE, mode: 'lite', creator_id: HOST, acceptor_id: GUEST });
    oldCredit(REF_A, BATTLE, 5, 1000);

    await backfillReferralEarnings();
    const second = await backfillReferralEarnings();
    assert.equal(second.written, 0);
    assert.equal(ledger().length, 1);
  });

  await t.test('two credits on one battle become two rows, marked split', async () => {
    seed({ hostRef: REF_A, guestRef: REF_B });
    fake.col('battles').docs.push({ id: BATTLE, amount: STAKE, mode: 'lite', creator_id: HOST, acceptor_id: GUEST });
    oldCredit(REF_A, BATTLE, 3, 1000);
    oldCredit(REF_B, BATTLE, 3, 1001);

    await backfillReferralEarnings();
    const rows = ledger();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.split === true));
    assert.deepEqual(rows.map(r => r.referee_id).sort((a, b) => a - b), [HOST, GUEST]);
  });

  await t.test('one referrer credited twice on a battle is given both players', async () => {
    seed({ hostRef: REF_A, guestRef: REF_A });
    fake.col('battles').docs.push({ id: BATTLE, amount: STAKE, mode: 'lite', creator_id: HOST, acceptor_id: GUEST });
    oldCredit(REF_A, BATTLE, 3, 1000);
    oldCredit(REF_A, BATTLE, 3, 1001);

    await backfillReferralEarnings();
    const rows = ledger();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.referee_id).sort((a, b) => a - b), [HOST, GUEST],
      'the second credit must not land on the same player as the first');
  });

  await t.test('leaves a credit alone when the referral link has since changed', async () => {
    seed();                                    // nobody is referred any more
    fake.col('battles').docs.push({ id: BATTLE, amount: STAKE, mode: 'lite', creator_id: HOST, acceptor_id: GUEST });
    oldCredit(REF_A, BATTLE, 5, 1000);

    const out = await backfillReferralEarnings();
    assert.equal(out.written, 0, 'guessing a referee would rewrite history');
  });

  await t.test('ignores wallet adjustments that are not battle payouts', async () => {
    seed({ hostRef: REF_A });
    fake.col('transactions').docs.push({
      id: 1, user_id: REF_A, type: 'credit', bucket: 'referral', amount: 100,
      note: 'Admin adjust: goodwill', ref_id: null, status: 'success', created_at: 1000,
    });
    const out = await backfillReferralEarnings();
    assert.equal(out.written, 0);
    assert.equal(ledger().length, 0);
  });
});
