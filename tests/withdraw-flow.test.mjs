/* ============================================================
   Withdrawals: UPI or bank transfer.

   The player chooses a payout method and fills in only that
   method's fields. What matters underneath is that the money
   leaves the winnings bucket exactly once, that a request carries
   enough detail to actually pay someone, and that the admin
   switch really closes the door.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, seedAdmin, walletOf, ledgerOf, fake }
  from './helpers/api-harness.mjs';

const api = await startApi({ auth: true, wallet: true, admin: true });
test.after(() => api.stop());

const reset = async (settings = {}) => { fake.reset(); await seedSettings(settings); };
const requests = () => fake.dump('withdrawal_requests');

const verified = extra => seedUser({ kyc_status: 'done', winnings: 5000, ...extra });
const UPI = { method: 'upi', upiId: 'player@ybl' };
const BANK = {
  method: 'bank', bankName: 'HDFC Bank', accountName: 'Anita Sharma',
  accountNumber: '123456789012', ifsc: 'HDFC0001234',
};

/* ---------------------------------------------------------------- */
test('the gates in front of the form', async t => {
  t.beforeEach(() => reset());

  await t.test('withdrawals switched off closes the route, not just the page', async () => {
    await reset({ withdraw_open: 0 });
    const u = await verified();
    const r = await api.post('/api/wallet/withdraw', { amount: 500, ...UPI }, u.token);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'WITHDRAW_CLOSED');
    assert.equal((await walletOf(u.id)).winnings, 5000, 'money moved while the door was shut');
    assert.equal(requests().length, 0);
  });

  await t.test('unverified KYC is refused whatever the balance', async () => {
    for (const kyc of ['none', 'pending', 'rejected']) {
      await reset();
      const u = await seedUser({ kyc_status: kyc, winnings: 5000 });
      const r = await api.post('/api/wallet/withdraw', { amount: 500, ...UPI }, u.token);
      assert.equal(r.status, 403, `KYC "${kyc}" was allowed through`);
      assert.equal(r.body.code, 'KYC_REQUIRED');
    }
  });

  await t.test('needs a session', async () => {
    assert.equal((await api.post('/api/wallet/withdraw', { amount: 500, ...UPI })).status, 401);
  });
});

/* ---------------------------------------------------------------- */
test('paying out by UPI', async t => {
  t.beforeEach(() => reset());

  await t.test('records the request, the debit and the pending ledger row', async () => {
    const u = await verified();
    const r = await api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'pending');

    assert.equal((await walletOf(u.id)).winnings, 4000);
    assert.equal(requests().length, 1);
    const w = requests()[0];
    assert.equal(w.method, 'upi');
    assert.equal(w.upi_id, 'player@ybl');
    assert.equal(w.status, 'pending');
    assert.equal(w.account_number, null, 'bank fields must stay empty on a UPI payout');

    const rows = fake.dump('transactions').filter(t => t.user_id === u.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].type, rows[0].bucket, rows[0].amount, rows[0].status],
      ['debit', 'winnings', 1000, 'pending']);
  });

  await t.test('refuses an ID that is not a UPI address', async () => {
    for (const upiId of ['', 'player', 'player@', '@ybl', 'p@y', undefined]) {
      await reset();
      const u = await verified();
      const r = await api.post('/api/wallet/withdraw', { amount: 500, method: 'upi', upiId }, u.token);
      assert.equal(r.status, 400, `accepted UPI id ${JSON.stringify(upiId)}`);
      assert.equal((await walletOf(u.id)).winnings, 5000);
    }
  });
});

/* ---------------------------------------------------------------- */
test('paying out to a bank account', async t => {
  t.beforeEach(() => reset());

  await t.test('records every field the payout actually needs', async () => {
    const u = await verified();
    const r = await api.post('/api/wallet/withdraw', { amount: 1000, ...BANK }, u.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const w = requests()[0];
    assert.equal(w.method, 'bank');
    assert.equal(w.account_number, '123456789012');
    assert.equal(w.ifsc, 'HDFC0001234');
    assert.match(w.account_name, /Anita Sharma/);
    assert.match(w.account_name, /HDFC Bank/, 'the bank name is lost, so nobody knows where to send it');
    assert.equal(w.upi_id, null, 'the UPI field must stay empty on a bank payout');
  });

  await t.test('refuses a request missing any of the three required fields', async () => {
    for (const drop of ['accountName', 'accountNumber', 'ifsc']) {
      await reset();
      const u = await verified();
      const body = { amount: 500, ...BANK };
      delete body[drop];
      const r = await api.post('/api/wallet/withdraw', body, u.token);
      assert.equal(r.status, 400, `accepted a bank payout with no ${drop}`);
      assert.equal(requests().length, 0);
    }
  });

  await t.test('refuses an account number that is not 9 to 18 digits', async () => {
    for (const accountNumber of ['12345678', '1'.repeat(19), '12345678a', '1234 5678 9012']) {
      await reset();
      const u = await verified();
      const r = await api.post('/api/wallet/withdraw', { amount: 500, ...BANK, accountNumber }, u.token);
      assert.equal(r.status, 400, `accepted account number ${accountNumber}`);
    }
  });

  await t.test('refuses a malformed IFSC', async () => {
    // Real shape: four letters, a zero, then six alphanumerics.
    for (const ifsc of ['HDFC1001234', 'HDF0001234', 'hdfc0001234', 'HDFC000123', 'HDFC00012345']) {
      await reset();
      const u = await verified();
      const r = await api.post('/api/wallet/withdraw', { amount: 500, ...BANK, ifsc }, u.token);
      assert.equal(r.status, 400, `accepted IFSC ${ifsc}`);
    }
  });

  await t.test('works without the optional bank name', async () => {
    const u = await verified();
    const body = { amount: 500, ...BANK };
    delete body.bankName;
    assert.equal((await api.post('/api/wallet/withdraw', body, u.token)).status, 200);
  });

  await t.test('refuses a method that is neither upi nor bank', async () => {
    const u = await verified();
    for (const method of ['neft', 'cash', '', null]) {
      const r = await api.post('/api/wallet/withdraw', { amount: 500, method, upiId: 'a@ybl' }, u.token);
      assert.equal(r.status, 400, `accepted method ${JSON.stringify(method)}`);
    }
  });
});

/* ---------------------------------------------------------------- */
test('what can actually be withdrawn', async t => {
  t.beforeEach(() => reset());

  await t.test('deposit balance is not withdrawable, however large', async () => {
    const u = await seedUser({ kyc_status: 'done', deposit: 100000, winnings: 0 });
    const r = await api.post('/api/wallet/withdraw', { amount: 500, ...UPI }, u.token);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'NO_WINNINGS');
    assert.equal((await walletOf(u.id)).deposit, 100000, 'deposit money was cashed out');
  });

  await t.test('more than the winnings is refused', async () => {
    const u = await seedUser({ kyc_status: 'done', deposit: 5000, winnings: 1000 });
    const r = await api.post('/api/wallet/withdraw', { amount: 1001, ...UPI }, u.token);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'EXCEEDS_WINNINGS');
    assert.deepEqual(await walletOf(u.id),
      { user_id: u.id, deposit: 5000, winnings: 1000, referral: 0 });
  });

  await t.test('exactly the winnings is allowed, to the rupee', async () => {
    const u = await seedUser({ kyc_status: 'done', winnings: 1000 });
    assert.equal((await api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token)).status, 200);
    assert.equal((await walletOf(u.id)).winnings, 0);
  });

  await t.test('below the minimum is refused', async () => {
    const u = await verified();
    const r = await api.post('/api/wallet/withdraw', { amount: 99, ...UPI }, u.token);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Minimum/);
  });

  await t.test('zero, negative and fractional amounts are refused', async () => {
    const u = await verified();
    for (const amount of [0, -500, 500.5, '500', null]) {
      const r = await api.post('/api/wallet/withdraw', { amount, ...UPI }, u.token);
      assert.equal(r.status, 400, `accepted amount ${JSON.stringify(amount)}`);
    }
    assert.equal((await walletOf(u.id)).winnings, 5000);
  });

  await t.test('two requests at once cannot cash out the same winnings twice', async () => {
    const u = await seedUser({ kyc_status: 'done', winnings: 1000 });
    const [a, b] = await Promise.all([
      api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token),
      api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 400], `both requests returned ${JSON.stringify(codes)}`);
    assert.equal((await walletOf(u.id)).winnings, 0, 'the balance went negative or paid twice');
    assert.equal(requests().length, 1);
  });
});

/* ---------------------------------------------------------------- */
test('the admin settling a payout', async t => {
  t.beforeEach(() => reset());

  const raise = async u => {
    await api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token);
    return requests()[0].id;
  };

  await t.test('marking it paid settles the ledger row and keeps the money out', async () => {
    const u = await verified();
    const admin = await seedAdmin();
    const id = await raise(u);

    const r = await api.post(`/api/admin/withdrawals/${id}`, { approve: true }, admin.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(requests()[0].status, 'paid');
    assert.equal((await walletOf(u.id)).winnings, 4000);
    const row = fake.dump('transactions').find(t => t.user_id === u.id);
    assert.equal(row.status, 'success');
  });

  await t.test('rejecting returns the money to winnings, not to cash', async () => {
    const u = await verified();
    const admin = await seedAdmin();
    const id = await raise(u);

    assert.equal((await api.post(`/api/admin/withdrawals/${id}`, { approve: false }, admin.token)).status, 200);
    const w = await walletOf(u.id);
    assert.equal(w.winnings, 5000, 'the refund did not go back to winnings');
    assert.equal(w.deposit, 0, 'a rejected withdrawal turned winnings into play-only cash');
    assert.equal(fake.dump('transactions').find(t => t.user_id === u.id).status, 'failed');
  });

  await t.test('cannot be settled twice', async () => {
    const u = await verified();
    const admin = await seedAdmin();
    const id = await raise(u);
    await api.post(`/api/admin/withdrawals/${id}`, { approve: true }, admin.token);
    assert.equal((await api.post(`/api/admin/withdrawals/${id}`, { approve: false }, admin.token)).status, 404);
    assert.equal((await walletOf(u.id)).winnings, 4000, 'a stale reject refunded a paid withdrawal');
  });

  await t.test('a viewer cannot settle one', async () => {
    const u = await verified();
    const viewer = await seedAdmin({ username: 'v2', role: 'viewer' });
    const id = await raise(u);
    assert.equal((await api.post(`/api/admin/withdrawals/${id}`, { approve: true }, viewer.token)).status, 403);
    assert.equal(requests()[0].status, 'pending');
  });

  await t.test('settles the row raised closest to the request', async () => {
    /* Two identical pending debits: settling the wrong one leaves a
       permanently pending row and a paid one that reads as unpaid. */
    const u = await seedUser({ kyc_status: 'done', winnings: 5000 });
    const admin = await seedAdmin();
    await api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token);
    await api.post('/api/wallet/withdraw', { amount: 1000, ...UPI }, u.token);
    assert.equal(requests().length, 2);

    await api.post(`/api/admin/withdrawals/${requests()[0].id}`, { approve: true }, admin.token);
    const rows = fake.dump('transactions').filter(t => t.user_id === u.id).sort((a, b) => a.id - b.id);
    assert.deepEqual(rows.map(r => r.status), ['success', 'pending']);
  });
});
