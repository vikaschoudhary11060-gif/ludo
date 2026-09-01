/* ============================================================
   Deposits: manual UPI only.

   The instant top-up is gone, so the only way a rupee reaches a
   wallet is a player submitting a UTR and an admin approving it.
   The thing worth proving over and over is that nothing lands in
   a wallet before that approval.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, seedAdmin, walletOf, ledgerOf, fake }
  from './helpers/api-harness.mjs';

const api = await startApi({ auth: true, wallet: true, admin: true, payments: true });
test.after(() => api.stop());

const reset = async (settings = {}) => { fake.reset(); await seedSettings(settings); };
const pending = () => fake.dump('deposit_requests');

const UTR = 'AXIS12345678';

/* ---------------------------------------------------------------- */
test('the instant top-up is gone', async t => {
  t.beforeEach(() => reset());

  await t.test('POST /api/wallet/deposit no longer exists', async () => {
    const u = await seedUser();
    const r = await api.post('/api/wallet/deposit', { amount: 500 }, u.token);
    assert.equal(r.status, 404, 'a signed-in player could still mint balance');
    assert.deepEqual(await walletOf(u.id), { user_id: u.id, deposit: 0, winnings: 0, referral: 0 });
  });

  await t.test('and cannot be reached without a session either', async () => {
    const r = await api.post('/api/wallet/deposit', { amount: 500 });
    assert.ok(r.status === 404 || r.status === 401, `unexpected ${r.status}`);
  });
});

/* ---------------------------------------------------------------- */
test('submitting a deposit request', async t => {
  t.beforeEach(() => reset());

  await t.test('creates a pending row and credits nothing', async () => {
    const u = await seedUser();
    const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, u.token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'pending');

    assert.equal(pending().length, 1);
    assert.deepEqual(
      [pending()[0].user_id, pending()[0].amount, pending()[0].utr, pending()[0].status],
      [u.id, 500, UTR, 'pending']);
    assert.equal((await walletOf(u.id)).deposit, 0, 'money moved before an admin looked at it');
    assert.deepEqual(ledgerOf(u.id), [], 'an unapproved request must not touch the ledger');
  });

  await t.test('keeps the screenshot when one is attached', async () => {
    const u = await seedUser();
    await api.post('/api/wallet/deposit-request',
      { amount: 500, utr: UTR, proof: '/uploads/shot.png' }, u.token);
    assert.equal(pending()[0].proof, '/uploads/shot.png');
  });

  await t.test('works without a screenshot — it is optional', async () => {
    const u = await seedUser();
    const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, u.token);
    assert.equal(r.status, 201);
    assert.equal(pending()[0].proof, null);
  });

  await t.test('refuses amounts outside the published limits', async () => {
    const u = await seedUser();
    for (const [amount, why] of [[99, 'under the minimum'], [10001, 'over the maximum'],
                                 [0, 'zero'], [-500, 'negative'], [500.5, 'not whole rupees']]) {
      const r = await api.post('/api/wallet/deposit-request', { amount, utr: UTR }, u.token);
      assert.equal(r.status, 400, `accepted ${amount} (${why})`);
    }
    assert.equal(pending().length, 0);
  });

  await t.test('refuses a UTR that is not 10 to 20 characters', async () => {
    const u = await seedUser();
    for (const utr of ['', 'SHORT', 'A'.repeat(9), 'A'.repeat(21)]) {
      const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr }, u.token);
      assert.equal(r.status, 400, `accepted UTR ${JSON.stringify(utr)}`);
    }
  });

  await t.test('refuses a UTR already claimed by someone', async () => {
    const a = await seedUser({ phone: '9800000001' });
    const b = await seedUser({ phone: '9800000002' });
    assert.equal((await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, a.token)).status, 201);

    // Same player again, and a different player claiming the same reference.
    for (const who of [a, b]) {
      const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, who.token);
      assert.equal(r.status, 409, 'a UTR was accepted twice');
    }
    assert.equal(pending().length, 1);
  });

  await t.test('lets a rejected UTR be submitted again', async () => {
    // A typo the admin rejected must not lock the real reference out forever.
    const u = await seedUser();
    await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, u.token);
    await fake.col('deposit_requests').updateOne({ utr: UTR }, { $set: { status: 'rejected' } });
    const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, u.token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  await t.test('is refused outright when deposits are switched off', async () => {
    await reset({ deposit_open: 0 });
    const u = await seedUser();
    const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, u.token);
    assert.equal(r.status, 503);
    assert.equal(pending().length, 0);
  });

  await t.test('needs a session', async () => {
    const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR });
    assert.equal(r.status, 401);
  });

  await t.test('records which UPI account the player was told to pay', async () => {
    const u = await seedUser();
    await fake.col('payment_methods').insertOne({ id: 1, upi_id: 'a@ybl', qr_image: null, label: 'A', active: 1 });
    await fake.col('payment_methods').insertOne({ id: 2, upi_id: 'b@ybl', qr_image: null, label: 'B', active: 1 });
    await api.post('/api/wallet/deposit-request', { amount: 500, utr: UTR }, u.token);
    // Whichever method the player was assigned, the request must name it — an
    // admin reconciling a bank statement has nothing else to match against.
    const assigned = (await api.get('/api/payments/deposit-method', u.token)).body.method;
    assert.equal(pending()[0].method_id, assigned.id);
  });
});

/* ---------------------------------------------------------------- */
test('a player reading their own requests', async t => {
  t.beforeEach(() => reset());

  await t.test('sees theirs and nobody else’s', async () => {
    const a = await seedUser({ phone: '9800000001' });
    const b = await seedUser({ phone: '9800000002' });
    await api.post('/api/wallet/deposit-request', { amount: 500, utr: 'AAAA11112222' }, a.token);
    await api.post('/api/wallet/deposit-request', { amount: 700, utr: 'BBBB11112222' }, b.token);

    const mine = await api.get('/api/wallet/deposit-requests', a.token);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.requests.map(r => r.utr), ['AAAA11112222']);
  });
});

/* ---------------------------------------------------------------- */
test('the admin decision', async t => {
  t.beforeEach(() => reset());

  const submit = async (u, amount = 500, utr = UTR) => {
    await api.post('/api/wallet/deposit-request', { amount, utr }, u.token);
    return pending()[0].id;
  };

  await t.test('approving credits the wallet and writes the ledger', async () => {
    const u = await seedUser();
    const admin = await seedAdmin();
    const id = await submit(u);

    const r = await api.post(`/api/admin/deposits/${id}`, { approve: true }, admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await walletOf(u.id)).deposit, 500);
    assert.deepEqual(ledgerOf(u.id), [['credit', 'deposit', 500, `Deposit verified (UTR ${UTR})`]]);
    assert.equal(pending()[0].status, 'approved');
  });

  await t.test('credits nothing to winnings — a deposit is never withdrawable', async () => {
    const u = await seedUser();
    const admin = await seedAdmin();
    await api.post(`/api/admin/deposits/${await submit(u)}`, { approve: true }, admin.token);
    assert.equal((await walletOf(u.id)).winnings, 0);
  });

  await t.test('pays the cashback bonus on a qualifying amount', async () => {
    const u = await seedUser();
    const admin = await seedAdmin();
    const id = await submit(u, 5000);
    await api.post(`/api/admin/deposits/${id}`, { approve: true }, admin.token);
    assert.equal((await walletOf(u.id)).deposit, 5050, '₹50 per ₹5,000 was not applied');
  });

  await t.test('rejecting credits nothing', async () => {
    const u = await seedUser();
    const admin = await seedAdmin();
    const id = await submit(u);
    const r = await api.post(`/api/admin/deposits/${id}`, { approve: false }, admin.token);
    assert.equal(r.status, 200);
    assert.equal((await walletOf(u.id)).deposit, 0);
    assert.deepEqual(ledgerOf(u.id), []);
    assert.equal(pending()[0].status, 'rejected');
  });

  await t.test('cannot be made twice — a double tap does not pay twice', async () => {
    const u = await seedUser();
    const admin = await seedAdmin();
    const id = await submit(u);
    assert.equal((await api.post(`/api/admin/deposits/${id}`, { approve: true }, admin.token)).status, 200);
    const again = await api.post(`/api/admin/deposits/${id}`, { approve: true }, admin.token);
    assert.equal(again.status, 404, 'an approved deposit was approved again');
    assert.equal((await walletOf(u.id)).deposit, 500, 'the wallet was credited twice');
  });

  await t.test('an approved request cannot then be rejected', async () => {
    const u = await seedUser();
    const admin = await seedAdmin();
    const id = await submit(u);
    await api.post(`/api/admin/deposits/${id}`, { approve: true }, admin.token);
    assert.equal((await api.post(`/api/admin/deposits/${id}`, { approve: false }, admin.token)).status, 404);
    assert.equal((await walletOf(u.id)).deposit, 500, 'the credit was reversed by a stale reject');
  });

  await t.test('needs at least the admin role', async () => {
    const u = await seedUser();
    const viewer = await seedAdmin({ username: 'v1', role: 'viewer' });
    const id = await submit(u);
    const r = await api.post(`/api/admin/deposits/${id}`, { approve: true }, viewer.token);
    assert.equal(r.status, 403);
    assert.equal((await walletOf(u.id)).deposit, 0);
  });

  await t.test('is refused without an admin token', async () => {
    const u = await seedUser();
    const id = await submit(u);
    assert.equal((await api.post(`/api/admin/deposits/${id}`, { approve: true })).status, 401);
    // A player's own token is not an admin token.
    assert.equal((await api.post(`/api/admin/deposits/${id}`, { approve: true }, u.token)).status, 401);
    assert.equal((await walletOf(u.id)).deposit, 0);
  });

  await t.test('shows up in the admin pending list', async () => {
    const u = await seedUser({ name: 'Anita' });
    const admin = await seedAdmin();
    await submit(u);
    const list = await api.get('/api/admin/deposits', admin.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.pending.length, 1);
    assert.equal(list.body.pending[0].utr, UTR);
    assert.equal(list.body.pending[0].name, 'Anita', 'the admin needs to see who paid');
  });
});
