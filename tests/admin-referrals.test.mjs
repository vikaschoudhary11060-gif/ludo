/* ============================================================
   The admin console's two new reads.

   GET /admin/referrals — every referral payout the programme
   has made, both ends of each transfer named, and totals that
   describe the whole filtered set rather than the page shown.

   GET /admin/players/:id — the 360 view: payout destinations,
   deposits, withdrawals and referral position in one response,
   so support does not have to open four tabs to answer one
   question.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, seedAdmin, fake } from './helpers/api-harness.mjs';

const api = await startApi({ admin: true });
test.after(() => api.stop());

const at = Date.now();
const reset = async () => { fake.reset(); await seedSettings(); };

/** One row of the referral transfer ledger, as settlement writes it. */
async function transfer({ referrer, referee, battleId = 'b1', amount = 5, stake = 500,
                          rate = 0.01, split = false, when = at, source = 'battle' }) {
  await fake.col('referral_earnings').insertOne({
    id: await fake.nextId('referral_earnings'),
    referrer_id: referrer, referee_id: referee, battle_id: battleId,
    mode: 'lite', stake, amount, rate, base_rate: 0.01, split, source, created_at: when,
  });
}

test('the referral payouts list', async t => {
  t.beforeEach(reset);

  await t.test('is empty, not broken, before anything has been paid', async () => {
    const admin = await seedAdmin();
    const r = await api.get('/api/admin/referrals', admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.transfers, []);
    assert.equal(r.body.totals.amount, 0);
    assert.equal(r.body.totals.transfers, 0);
  });

  await t.test('needs an admin token', async () => {
    const r = await api.get('/api/admin/referrals');
    assert.equal(r.status, 401);
  });

  await t.test('names both ends of every transfer', async () => {
    const admin = await seedAdmin();
    const boss = await seedUser({ phone: '9000000001', name: 'Referrer' });
    const kid = await seedUser({ phone: '9000000002', name: 'Referred Player' });
    await transfer({ referrer: boss.id, referee: kid.id });

    const { body } = await api.get('/api/admin/referrals', admin.token);
    assert.equal(body.transfers.length, 1);
    const row = body.transfers[0];
    assert.equal(row.referrer.name, 'Referrer');
    assert.equal(row.referrer.phone, '9000000001');
    assert.equal(row.referee.name, 'Referred Player');
    assert.equal(row.amount, 5);
    assert.equal(row.stake, 500);
    assert.equal(row.ratePercent, 1);
    assert.equal(row.split, false);
  });

  await t.test('totals count the whole set, and unique people once', async () => {
    const admin = await seedAdmin();
    const a = await seedUser({ phone: '9000000011', name: 'A' });
    const b = await seedUser({ phone: '9000000012', name: 'B' });
    const c = await seedUser({ phone: '9000000013', name: 'C' });
    await transfer({ referrer: a.id, referee: b.id, amount: 5, battleId: 'b1' });
    await transfer({ referrer: a.id, referee: c.id, amount: 7, battleId: 'b2' });

    const { body } = await api.get('/api/admin/referrals', admin.token);
    assert.equal(body.totals.transfers, 2);
    assert.equal(body.totals.amount, 12);
    assert.equal(body.totals.referrers, 1, 'one referrer, paid twice');
    assert.equal(body.totals.referees, 2);
  });

  await t.test('reports the half-rate payouts separately', async () => {
    const admin = await seedAdmin();
    const a = await seedUser({ phone: '9000000021' });
    const b = await seedUser({ phone: '9000000022' });
    const c = await seedUser({ phone: '9000000023' });
    await transfer({ referrer: a.id, referee: b.id, amount: 5, split: false, battleId: 'b1' });
    await transfer({ referrer: a.id, referee: c.id, amount: 3, split: true, rate: 0.005, battleId: 'b2' });

    const { body } = await api.get('/api/admin/referrals', admin.token);
    assert.equal(body.totals.amount, 8);
    assert.equal(body.totals.splitTransfers, 1);
    assert.equal(body.totals.splitAmount, 3);
  });

  await t.test('quotes both rates from live settings, not a fixed 0.5%', async () => {
    await seedSettings({ referral_rate: 0.04 });
    const admin = await seedAdmin();
    const { body } = await api.get('/api/admin/referrals', admin.token);
    assert.equal(body.ratePercent, 4);
    assert.equal(body.splitRatePercent, 2, 'half of whatever the owner configured');
  });

  await t.test('type=split narrows to games where both players were referred', async () => {
    const admin = await seedAdmin();
    const a = await seedUser({ phone: '9000000031' });
    const b = await seedUser({ phone: '9000000032' });
    await transfer({ referrer: a.id, referee: b.id, split: false, battleId: 'b1' });
    await transfer({ referrer: a.id, referee: b.id, split: true, battleId: 'b2' });

    const split = await api.get('/api/admin/referrals?type=split', admin.token);
    assert.equal(split.body.transfers.length, 1);
    assert.equal(split.body.transfers[0].battleId, 'b2');
    assert.equal(split.body.totals.amount, 5, 'totals follow the filter');

    const full = await api.get('/api/admin/referrals?type=full', admin.token);
    assert.equal(full.body.transfers.length, 1);
    assert.equal(full.body.transfers[0].battleId, 'b1');
  });

  await t.test('a range excludes what falls outside it', async () => {
    const admin = await seedAdmin();
    const a = await seedUser({ phone: '9000000041' });
    const b = await seedUser({ phone: '9000000042' });
    await transfer({ referrer: a.id, referee: b.id, battleId: 'old', when: at - 10 * 864e5 });
    await transfer({ referrer: a.id, referee: b.id, battleId: 'new', when: at });

    const { body } = await api.get('/api/admin/referrals?range=7d', admin.token);
    assert.equal(body.transfers.length, 1);
    assert.equal(body.transfers[0].battleId, 'new');
    assert.equal(body.totals.transfers, 1);
  });

  await t.test('search matches either end of the transfer', async () => {
    const admin = await seedAdmin();
    const boss = await seedUser({ phone: '9000000051', name: 'Sunita' });
    const kid = await seedUser({ phone: '9000000052', name: 'Rakesh' });
    const other = await seedUser({ phone: '9000000053', name: 'Nobody' });
    await transfer({ referrer: boss.id, referee: kid.id, battleId: 'b1' });
    await transfer({ referrer: other.id, referee: other.id, battleId: 'b2' });

    const byReferrer = await api.get('/api/admin/referrals?q=Sunita', admin.token);
    assert.deepEqual(byReferrer.body.transfers.map(r => r.battleId), ['b1']);

    const byReferee = await api.get('/api/admin/referrals?q=Rakesh', admin.token);
    assert.deepEqual(byReferee.body.transfers.map(r => r.battleId), ['b1']);

    const byPhone = await api.get('/api/admin/referrals?q=9000000052', admin.token);
    assert.deepEqual(byPhone.body.transfers.map(r => r.battleId), ['b1']);
  });

  await t.test('ranks the top earners over the same window', async () => {
    const admin = await seedAdmin();
    const big = await seedUser({ phone: '9000000061', name: 'Big' });
    const small = await seedUser({ phone: '9000000062', name: 'Small' });
    const kid = await seedUser({ phone: '9000000063', name: 'Kid' });
    await transfer({ referrer: small.id, referee: kid.id, amount: 5, battleId: 'b1' });
    await transfer({ referrer: big.id, referee: kid.id, amount: 50, battleId: 'b2' });
    await transfer({ referrer: big.id, referee: kid.id, amount: 20, battleId: 'b3' });

    const { body } = await api.get('/api/admin/referrals', admin.token);
    assert.equal(body.topReferrers[0].name, 'Big');
    assert.equal(body.topReferrers[0].amount, 70);
    assert.equal(body.topReferrers[0].transfers, 2);
    assert.equal(body.topReferrers[1].name, 'Small');
  });

  await t.test('a deleted player still shows as a placeholder rather than blank', async () => {
    const admin = await seedAdmin();
    await transfer({ referrer: 90210, referee: 90211 });
    const { body } = await api.get('/api/admin/referrals', admin.token);
    assert.equal(body.transfers[0].referrer.name, 'Player0210');
    assert.equal(body.transfers[0].referee.phone, '');
  });
});

test('the player 360 view', async t => {
  t.beforeEach(reset);

  const withdrawal = async (user, over = {}) => fake.col('withdrawal_requests').insertOne({
    id: await fake.nextId('withdrawal_requests'), user_id: user.id, amount: 1000,
    method: 'upi', upi_id: 'player@ybl', account_name: null, account_number: null, ifsc: null,
    status: 'pending', note: null, created_at: at, settled_at: null, ...over,
  });
  const deposit = async (user, over = {}) => fake.col('deposit_requests').insertOne({
    id: await fake.nextId('deposit_requests'), user_id: user.id, amount: 500, utr: 'AXIS12345678',
    proof: null, method: 'upi', method_id: 1, status: 'pending', note: null,
    created_at: at, settled_at: null, ...over,
  });

  await t.test('lists every payout destination the player has used', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100001' });
    await withdrawal(u, { upi_id: 'old@ybl', status: 'paid', amount: 700 });
    await withdrawal(u, { upi_id: 'new@okaxis', status: 'pending' });

    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.payoutMethods.length, 2);
    const paid = body.payoutMethods.find(m => m.upiId === 'old@ybl');
    assert.equal(paid.verified, true, 'this one has actually been paid out to');
    assert.equal(paid.paidOut, 700);
    assert.equal(body.payoutMethods.find(m => m.upiId === 'new@okaxis').verified, false);
  });

  await t.test('collapses repeat use of one UPI ID into a single destination', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100002' });
    await withdrawal(u, { upi_id: 'same@ybl', status: 'paid', amount: 300 });
    await withdrawal(u, { upi_id: 'same@ybl', status: 'paid', amount: 200 });

    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.payoutMethods.length, 1);
    assert.equal(body.payoutMethods[0].used, 2);
    assert.equal(body.payoutMethods[0].paidOut, 500);
  });

  await t.test('keeps a bank account separate from a UPI ID', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100003' });
    await withdrawal(u, { method: 'bank', upi_id: null, account_number: '123456789',
      ifsc: 'HDFC0001234', account_name: 'A Player · HDFC', status: 'paid' });

    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.payoutMethods.length, 1);
    assert.equal(body.payoutMethods[0].method, 'bank');
    assert.equal(body.payoutMethods[0].accountNumber, '123456789');
    assert.equal(body.payoutMethods[0].ifsc, 'HDFC0001234');
  });

  await t.test('separates money that cleared from money still queued', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100004' });
    await deposit(u, { amount: 1000, status: 'approved', utr: 'A1' });
    await deposit(u, { amount: 250, status: 'pending', utr: 'A2' });
    await deposit(u, { amount: 90, status: 'rejected', utr: 'A3' });
    await withdrawal(u, { amount: 400, status: 'paid' });
    await withdrawal(u, { amount: 150, status: 'pending' });

    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.stats.depositApproved, 1000);
    assert.equal(body.stats.depositPending, 250);
    assert.equal(body.stats.depositRejected, 90);
    assert.equal(body.stats.withdrawPaid, 400);
    assert.equal(body.stats.withdrawPending, 150);
    assert.equal(body.deposits.length, 3);
    assert.equal(body.withdrawals.length, 2);
  });

  await t.test('counts joining bonuses without counting the player’s own deposit', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100005' });
    await fake.col('transactions').insertOne({ id: 1, user_id: u.id, type: 'credit', bucket: 'deposit',
      amount: 25, note: 'Welcome bonus', ref_id: null, status: 'success', created_at: at });
    await fake.col('transactions').insertOne({ id: 2, user_id: u.id, type: 'credit', bucket: 'deposit',
      amount: 5000, note: 'Deposit verified (UTR AXIS1)', ref_id: null, status: 'success', created_at: at });

    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.stats.bonuses, 25, 'a verified deposit is the player’s own money');
  });

  await t.test('reports the player’s net position across settled games', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100006' });
    // Two ₹500 games: one won for ₹960, one lost.
    await fake.col('battles').insertOne({ id: 'g1', amount: 500, status: 'completed',
      creator_id: u.id, acceptor_id: 99, winner_id: u.id, payout: 960, created_at: at, settled_at: at });
    await fake.col('battles').insertOne({ id: 'g2', amount: 500, status: 'completed',
      creator_id: 99, acceptor_id: u.id, winner_id: 99, payout: 960, created_at: at, settled_at: at });

    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.stats.staked, 1000);
    assert.equal(body.stats.wonPayout, 960);
    assert.equal(body.stats.lostStake, 500);
    assert.equal(body.stats.netProfit, -40, 'down by the commission on the game they won');
  });

  await t.test('shows the referral position in both directions', async () => {
    const admin = await seedAdmin();
    const boss = await seedUser({ phone: '9111100011', name: 'Boss' });
    const player = await seedUser({ phone: '9111100012', name: 'Player', referred_by: boss.id });
    const kid = await seedUser({ phone: '9111100013', name: 'Kid', referred_by: player.id });
    await fake.col('referrals').insertOne({ referrer_id: player.id, referee_id: kid.id, earned: 12, created_at: at });
    await transfer({ referrer: player.id, referee: kid.id, amount: 12, battleId: 'b1' });
    await transfer({ referrer: boss.id, referee: player.id, amount: 5, battleId: 'b2' });

    const { body } = await api.get('/api/admin/players/' + player.id, admin.token);
    assert.equal(body.referral.referredBy.name, 'Boss');
    assert.deepEqual(body.referral.referredUsers.map(r => r.name), ['Kid']);
    assert.equal(body.referral.referredUsers[0].earned, 12);
    assert.equal(body.referral.earnedTransfers.length, 1);
    assert.equal(body.referral.earnedTransfers[0].counterparty, 'Kid');
    assert.equal(body.referral.generatedTransfers.length, 1);
    assert.equal(body.referral.generatedTransfers[0].counterparty, 'Boss',
      'what this player earned for the person who referred them');
  });

  await t.test('says plainly that a player joined without a referral', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100021' });
    const { body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(body.referral.referredBy, null);
    assert.deepEqual(body.referral.referredUsers, []);
  });

  await t.test('a player with no history still returns every section', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ phone: '9111100031' });
    const { status, body } = await api.get('/api/admin/players/' + u.id, admin.token);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.payoutMethods, []);
    assert.deepEqual(body.deposits, []);
    assert.deepEqual(body.withdrawals, []);
    assert.deepEqual(body.kycDocuments, []);
    assert.equal(body.stats.netProfit, 0);
    assert.equal(body.wallet.grand, 0);
  });
});
