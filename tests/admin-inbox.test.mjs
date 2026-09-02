/* ============================================================
   The admin alerts inbox.

   One list of everything waiting on a human. What matters is
   that nothing outstanding is missing from it, that the counts
   are the true totals rather than the page size, and that a bot
   battle never appears as work for anyone.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, seedAdmin, fake } from './helpers/api-harness.mjs';

const api = await startApi({ admin: true });
test.after(() => api.stop());

const reset = async () => { fake.reset(); await seedSettings(); };
const at = Date.now();

async function pendingDeposit(user, amount = 500, utr = 'AXIS12345678') {
  await fake.col('deposit_requests').insertOne({
    id: await fake.nextId('deposit_requests'), user_id: user.id, amount, utr,
    proof: null, method_id: 1, status: 'pending', note: null, created_at: at, settled_at: null,
  });
}
async function pendingWithdrawal(user, amount = 1000) {
  await fake.col('withdrawal_requests').insertOne({
    id: await fake.nextId('withdrawal_requests'), user_id: user.id, amount, method: 'upi',
    upi_id: 'player@ybl', account_name: null, account_number: null, ifsc: null,
    status: 'pending', note: null, created_at: at, settled_at: null,
  });
}
const inbox = admin => api.get('/api/admin/inbox', admin.token);

test('what lands in the inbox', async t => {
  t.beforeEach(reset);

  await t.test('is empty when every queue is clear', async () => {
    const admin = await seedAdmin();
    const r = await inbox(admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.counts.total, 0);
  });

  await t.test('gathers all five queues into one feed', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ name: 'Anita', kyc_status: 'pending' });
    await pendingDeposit(u);
    await pendingWithdrawal(u);
    await fake.col('battles').insertOne({
      id: 'd1', amount: 500, status: 'disputed', creator_id: u.id, acceptor_id: 2, created_at: at,
    });
    await fake.col('chat_threads').insertOne({
      id: 1, user_id: u.id, status: 'open', unread_admin: 2, last_message: 'help me', last_at: at,
    });

    const { body } = await inbox(admin);
    assert.deepEqual(body.counts,
      { deposits: 1, withdrawals: 1, disputes: 1, kyc: 1, chat: 1, total: 5 });
    assert.deepEqual([...new Set(body.items.map(i => i.kind))].sort(),
      ['chat', 'deposit', 'dispute', 'kyc', 'withdrawal']);
  });

  await t.test('every row says where to go to action it', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ kyc_status: 'pending' });
    await pendingDeposit(u);
    await pendingWithdrawal(u);

    const { body } = await inbox(admin);
    const byKind = Object.fromEntries(body.items.map(i => [i.kind, i]));
    assert.equal(byKind.deposit.tab, 'deposits');
    assert.equal(byKind.deposit.filter, 'pending', 'the deposits tab must open on the pending queue');
    assert.equal(byKind.withdrawal.tab, 'withdrawals');
    assert.equal(byKind.withdrawal.filter, 'pending');
    assert.equal(byKind.kyc.tab, 'kyc');
  });

  await t.test('names the player, so a row is actionable on sight', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ name: 'Anita' });
    await pendingDeposit(u);
    const { body } = await inbox(admin);
    assert.match(body.items[0].detail, /Anita/);
    assert.match(body.items[0].detail, /AXIS12345678/);
  });

  await t.test('ignores anything already settled', async () => {
    const admin = await seedAdmin();
    const u = await seedUser({ kyc_status: 'done' });
    await fake.col('deposit_requests').insertOne({
      id: 9, user_id: u.id, amount: 500, utr: 'X', status: 'approved', created_at: at });
    await fake.col('withdrawal_requests').insertOne({
      id: 9, user_id: u.id, amount: 500, method: 'upi', status: 'paid', created_at: at });
    await fake.col('battles').insertOne({
      id: 'c1', amount: 500, status: 'completed', creator_id: u.id, acceptor_id: 2, created_at: at });
    await fake.col('chat_threads').insertOne({
      id: 1, user_id: u.id, status: 'resolved', unread_admin: 0, last_at: at });

    const { body } = await inbox(admin);
    assert.equal(body.counts.total, 0, JSON.stringify(body.items));
  });

  await t.test('never lists a bot battle as work for a human', async () => {
    const admin = await seedAdmin();
    const bot = await seedUser({ phone: '1000000001', name: 'RohitPlays', is_bot: true });
    await fake.col('battles').insertOne({
      id: 'b1', amount: 500, status: 'disputed', creator_id: bot.id, acceptor_id: 2,
      created_at: at, is_bot: true });
    const { body } = await inbox(admin);
    assert.equal(body.counts.disputes, 0, 'a bot battle was queued for an admin');
    assert.deepEqual(body.items, []);
  });

  await t.test('counts the true total, not the page size', async () => {
    /* The badge has to say 40 even though only 25 rows come back — an
       operator sizing up a backlog from a truncated list would misjudge it. */
    const admin = await seedAdmin();
    const u = await seedUser();
    for (let i = 0; i < 40; i++) await pendingDeposit(u, 100 + i, 'UTR' + String(i).padStart(9, '0'));

    const { body } = await inbox(admin);
    assert.equal(body.counts.deposits, 40, 'the count was capped with the list');
    assert.equal(body.items.length, 25, 'the list should be capped');
  });

  await t.test('is newest first', async () => {
    const admin = await seedAdmin();
    const u = await seedUser();
    await fake.col('deposit_requests').insertOne({
      id: 1, user_id: u.id, amount: 100, utr: 'OLD0000001', status: 'pending', created_at: 1000 });
    await fake.col('withdrawal_requests').insertOne({
      id: 1, user_id: u.id, amount: 200, method: 'upi', upi_id: 'a@b', status: 'pending', created_at: 9000 });
    const { body } = await inbox(admin);
    assert.deepEqual(body.items.map(i => i.kind), ['withdrawal', 'deposit']);
  });

  await t.test('is readable by a viewer but needs an admin token', async () => {
    const viewer = await seedAdmin({ username: 'v1', role: 'viewer' });
    assert.equal((await inbox(viewer)).status, 200, 'read-only staff should see the queue');
    assert.equal((await api.get('/api/admin/inbox')).status, 401);
    const player = await seedUser();
    assert.equal((await api.get('/api/admin/inbox', player.token)).status, 401);
  });
});
