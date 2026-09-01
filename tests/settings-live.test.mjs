/* ============================================================
   Admin settings, applied live.

   The promise made for these is "editable from the panel and
   applied live — no code changes required". So each one is
   changed through the API and then observed taking effect, not
   merely observed being stored.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, seedAdmin, seedOtp, walletOf, fake }
  from './helpers/api-harness.mjs';

const api = await startApi({ auth: true, wallet: true, admin: true });
test.after(() => api.stop());

const reset = async (settings = {}) => { fake.reset(); await seedSettings(settings); };
const stored = () => fake.col('settings').findOne({ id: 1 });

/* ---------------------------------------------------------------- */
test('who may change settings', async t => {
  t.beforeEach(() => reset());

  await t.test('an owner can', async () => {
    const owner = await seedAdmin({ role: 'owner' });
    const r = await api.patch('/api/admin/settings', { referral_rate: 0.05 }, owner.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored()).referral_rate, 0.05);
  });

  await t.test('a plain admin cannot', async () => {
    const admin = await seedAdmin({ username: 'a1', role: 'admin' });
    assert.equal((await api.patch('/api/admin/settings', { referral_rate: 0.05 }, admin.token)).status, 403);
    assert.equal((await stored()).referral_rate, 0.01, 'the change went through anyway');
  });

  await t.test('a viewer cannot even read them without a token', async () => {
    assert.equal((await api.get('/api/admin/settings')).status, 401);
    const viewer = await seedAdmin({ username: 'v1', role: 'viewer' });
    assert.equal((await api.get('/api/admin/settings', viewer.token)).status, 200, 'read-only should still read');
    assert.equal((await api.patch('/api/admin/settings', { referral_rate: 0.05 }, viewer.token)).status, 403);
  });

  await t.test('a player’s own token is not an admin token', async () => {
    const u = await seedUser();
    assert.equal((await api.patch('/api/admin/settings', { referral_rate: 0.05 }, u.token)).status, 401);
  });
});

/* ---------------------------------------------------------------- */
test('the values the panel accepts', async t => {
  t.beforeEach(() => reset());
  const save = async (body, token) => api.patch('/api/admin/settings', body, token);

  await t.test('stores every rate, bonus, switch and limit', async () => {
    const owner = await seedAdmin();
    const wanted = {
      withdraw_open: false, deposit_open: true, maintenance: false,
      commission_threshold: 1000, commission_under: 0.04, commission_from: 0.02,
      referral_rate: 0.03, signup_bonus: 25, referral_bonus: 50,
      battle_limit: 4, upi_id: 'khelbro@okaxis', notice: 'Server maintenance at 2am.',
    };
    const r = await save(wanted, owner.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const s = await stored();
    assert.equal(s.withdraw_open, 0, 'booleans are stored as 0/1');
    assert.equal(s.deposit_open, 1);
    for (const k of ['commission_threshold', 'commission_under', 'commission_from',
                     'referral_rate', 'signup_bonus', 'referral_bonus', 'battle_limit',
                     'upi_id', 'notice']) {
      assert.equal(s[k], wanted[k], `${k} was not stored`);
    }
  });

  await t.test('refuses values outside the safe range', async () => {
    const owner = await seedAdmin();
    for (const body of [
      { commission_under: 0.31 },        // over 30% commission
      { commission_from: -0.1 },
      { referral_rate: 0.21 },
      { referral_rate: -0.01 },
      { battle_limit: 0 },
      { battle_limit: 11 },
      { signup_bonus: -1 },
      { signup_bonus: 25.5 },            // whole rupees only
      { referral_bonus: 100001 },
      { notice: 'x'.repeat(501) },
      { commission_threshold: -1 },
    ]) {
      const r = await save(body, owner.token);
      assert.equal(r.status, 400, `accepted ${JSON.stringify(body)}`);
    }
    // Nothing partial was written.
    assert.deepEqual(
      [(await stored()).referral_rate, (await stored()).battle_limit], [0.01, 2]);
  });

  await t.test('refuses an empty change', async () => {
    const owner = await seedAdmin();
    assert.equal((await save({}, owner.token)).status, 400);
  });

  await t.test('ignores a key that is not a setting', async () => {
    const owner = await seedAdmin();
    await save({ referral_rate: 0.03, is_admin: true, __proto__: { x: 1 } }, owner.token);
    const s = await stored();
    assert.equal(s.referral_rate, 0.03);
    assert.equal(s.is_admin, undefined, 'an arbitrary key was written into settings');
  });

  await t.test('leaves the settings it was not asked to change', async () => {
    const owner = await seedAdmin();
    await save({ referral_rate: 0.03 }, owner.token);
    const s = await stored();
    assert.equal(s.battle_limit, 2);
    assert.equal(s.commission_from, 0.025);
  });

  await t.test('writes an audit entry naming what changed', async () => {
    const owner = await seedAdmin();
    await save({ referral_rate: 0.03 }, owner.token);
    const log = fake.dump('audit_log');
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'settings.update');
    assert.equal(JSON.parse(log[0].detail).referral_rate, 0.03);
  });
});

/* ---------------------------------------------------------------- */
test('a change takes effect on the very next request', async t => {
  const asOwner = async () => seedAdmin();

  await t.test('closing withdrawals shuts the route', async () => {
    await reset();
    const owner = await asOwner();
    const u = await seedUser({ kyc_status: 'done', winnings: 5000 });
    const payload = { amount: 500, method: 'upi', upiId: 'player@ybl' };

    assert.equal((await api.post('/api/wallet/withdraw', payload, u.token)).status, 200);
    await api.patch('/api/admin/settings', { withdraw_open: false }, owner.token);
    const shut = await api.post('/api/wallet/withdraw', payload, u.token);
    assert.equal(shut.status, 503);
    assert.equal(shut.body.code, 'WITHDRAW_CLOSED');
  });

  await t.test('reopening them lets the next one through', async () => {
    await reset({ withdraw_open: 0 });
    const owner = await asOwner();
    const u = await seedUser({ kyc_status: 'done', winnings: 5000 });
    const payload = { amount: 500, method: 'upi', upiId: 'player@ybl' };
    assert.equal((await api.post('/api/wallet/withdraw', payload, u.token)).status, 503);
    await api.patch('/api/admin/settings', { withdraw_open: true }, owner.token);
    assert.equal((await api.post('/api/wallet/withdraw', payload, u.token)).status, 200);
  });

  await t.test('closing deposits stops new requests', async () => {
    await reset();
    const owner = await asOwner();
    const u = await seedUser();
    await api.patch('/api/admin/settings', { deposit_open: false }, owner.token);
    const r = await api.post('/api/wallet/deposit-request', { amount: 500, utr: 'AXIS12345678' }, u.token);
    assert.equal(r.status, 503);
  });

  await t.test('a signup bonus set now is paid to the next account', async () => {
    await reset({ signup_bonus: 0 });
    const owner = await asOwner();
    await api.patch('/api/admin/settings', { signup_bonus: 30 }, owner.token);

    const phone = '9812345670';
    const code = await seedOtp(phone);
    await api.post('/api/auth/verify-otp', { phone, code });
    const u = await fake.col('users').findOne({ phone });
    assert.equal((await walletOf(u.id)).deposit, 30);
  });

  await t.test('setting the bonus back to zero stops paying it', async () => {
    await reset({ signup_bonus: 30 });
    const owner = await asOwner();
    await api.patch('/api/admin/settings', { signup_bonus: 0 }, owner.token);
    const phone = '9812345671';
    const code = await seedOtp(phone);
    await api.post('/api/auth/verify-otp', { phone, code });
    const u = await fake.col('users').findOne({ phone });
    assert.equal((await walletOf(u.id)).deposit, 0);
  });
});

/* ---------------------------------------------------------------- */
test('the player notice', async t => {
  t.beforeEach(() => reset());

  await t.test('is saved and read back exactly as typed', async () => {
    const owner = await seedAdmin();
    const text = 'Withdrawals run 10am–8pm.\nKeep your KYC up to date.';
    await api.patch('/api/admin/settings', { notice: text }, owner.token);
    assert.equal((await api.get('/api/admin/settings', owner.token)).body.settings.notice, text);
  });

  await t.test('can be cleared, which is how the banner is hidden', async () => {
    await reset({ notice: 'Something old' });
    const owner = await seedAdmin();
    await api.patch('/api/admin/settings', { notice: '' }, owner.token);
    assert.equal((await stored()).notice, '');
  });

  await t.test('takes 500 characters but not 501', async () => {
    const owner = await seedAdmin();
    assert.equal((await api.patch('/api/admin/settings', { notice: 'x'.repeat(500) }, owner.token)).status, 200);
    assert.equal((await api.patch('/api/admin/settings', { notice: 'x'.repeat(501) }, owner.token)).status, 400);
  });

  await t.test('keeps markup as literal text — the page renders it as text', async () => {
    /* The banner writes it with textContent, so this can never execute; the
       point is that the server does not silently mangle what was typed. */
    const owner = await seedAdmin();
    const text = '<b>Note</b> & "quotes"';
    await api.patch('/api/admin/settings', { notice: text }, owner.token);
    assert.equal((await stored()).notice, text);
  });
});
