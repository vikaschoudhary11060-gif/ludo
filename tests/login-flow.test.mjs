/* ============================================================
   Sign-in: OTP first, password after.

   Driven through the real routes, so the zod schemas, the auth
   middleware and the lockout are all in the path.

   The whole flow, end to end:
     a new number  -> OTP -> forced password setup -> in
     a known number-> password -> in
     forgotten     -> OTP -> new password -> in
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, seedOtp, fake } from './helpers/api-harness.mjs';

const api = await startApi({ auth: true });
const NEW_PHONE = '9812345670';
const GOOD = 'ludo$Bro7';

test.after(() => api.stop());

const reset = async (settings = {}) => { fake.reset(); await seedSettings(settings); };
const lockedNow = u => Number(u?.pw_locked_until || 0) > Date.now();

/* ---------------------------------------------------------------- */
test('a brand-new number', async t => {
  t.beforeEach(reset);

  await t.test('is offered the OTP door, not the password one', async () => {
    const r = await api.post('/api/auth/check', { phone: NEW_PHONE });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { exists: false, hasPassword: false });
  });

  await t.test('signs in with the code and is told to set a password', async () => {
    const code = await seedOtp(NEW_PHONE);
    const r = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.isNew, true);
    assert.equal(r.body.needsPassword, true, 'the setup step would never be shown');
    assert.ok(r.body.token);
  });

  await t.test('the OTP is spent — the same code cannot be replayed', async () => {
    const code = await seedOtp(NEW_PHONE);
    await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    const again = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    assert.equal(again.status, 400);
  });

  await t.test('a wrong code is refused and counted', async () => {
    await seedOtp(NEW_PHONE, '111111');
    const r = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code: '222222' });
    assert.equal(r.status, 400);
    assert.equal((await fake.col('otps').findOne({ phone: NEW_PHONE })).attempts, 1);
  });

  await t.test('an expired code is refused', async () => {
    await fake.col('otps').insertOne({ phone: NEW_PHONE, code: '123456', expires_at: Date.now() - 1, attempts: 0 });
    const r = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code: '123456' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /expired/i);
  });

  await t.test('a malformed number never reaches the database', async () => {
    for (const phone of ['123', '1234567890', '5876543210', '98765432101', '', null]) {
      const r = await api.post('/api/auth/check', { phone });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(phone)}`);
    }
  });
});

/* ---------------------------------------------------------------- */
test('creating the password', async t => {
  t.beforeEach(reset);

  const signUp = async () => {
    const code = await seedOtp(NEW_PHONE);
    const r = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    return r.body.token;
  };

  await t.test('stores it and returns a working token', async () => {
    const token = await signUp();
    const r = await api.post('/api/auth/set-password', { password: GOOD }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token, 'a fresh token must come back');
    const me = await api.get('/api/auth/me', r.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.hasPassword, true);
  });

  await t.test('signs every other device out', async () => {
    const token = await signUp();
    const r = await api.post('/api/auth/set-password', { password: GOOD }, token);
    // The epoch moved, so the token that made the change is now stale.
    const stale = await api.get('/api/auth/me', token);
    assert.equal(stale.status, 401, 'the old session survived a password change');
    assert.equal((await api.get('/api/auth/me', r.body.token)).status, 200);
  });

  await t.test('refuses a password the rules reject', async () => {
    for (const pw of ['short', '123456', 'aaaaaa', NEW_PHONE]) {
      const token = await signUp();
      const r = await api.post('/api/auth/set-password', { password: pw }, token);
      assert.equal(r.status, 400, `accepted ${pw}`);
      assert.equal((await api.get('/api/auth/me', token)).body.user.hasPassword, false);
    }
  });

  await t.test('needs a session — an anonymous caller cannot set one', async () => {
    const r = await api.post('/api/auth/set-password', { password: GOOD });
    assert.equal(r.status, 401);
  });

  await t.test('afterwards the number is offered the password door', async () => {
    const token = await signUp();
    await api.post('/api/auth/set-password', { password: GOOD }, token);
    const c = await api.post('/api/auth/check', { phone: NEW_PHONE });
    assert.deepEqual(c.body, { exists: true, hasPassword: true });
  });
});

/* ---------------------------------------------------------------- */
test('signing in with the password', async t => {
  t.beforeEach(reset);
  const signedUp = () => seedUser({ phone: NEW_PHONE, password: GOOD });

  await t.test('the right password gets a session', async () => {
    await signedUp();
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.isNew, false);
    assert.equal((await api.get('/api/auth/me', r.body.token)).status, 200);
  });

  await t.test('records the sign-in and how it was proved', async () => {
    await signedUp();
    await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    const events = fake.dump('login_events');
    assert.equal(events.length, 1);
    assert.equal(events[0].via, 'password');
  });

  await t.test('the wrong password is refused', async () => {
    await signedUp();
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: 'ludo$Bro8' });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'BAD_CREDENTIALS');
  });

  await t.test('says the same thing for unknown, password-less and wrong', async () => {
    /* Three different messages would turn this endpoint into a way to map
       which numbers are registered and which have a password set. */
    await signedUp();
    await seedUser({ phone: '9812345671' });                       // no password
    const said = [];
    for (const [phone, password] of [
      ['9899999999', GOOD],       // no such account
      ['9812345671', GOOD],       // exists, no password
      [NEW_PHONE, 'wrong-one'],   // exists, wrong password
    ]) {
      const r = await api.post('/api/auth/login-password', { phone, password });
      assert.equal(r.status, 401);
      said.push(r.body.error);
    }
    assert.equal(new Set(said).size, 1, `distinguishable replies: ${JSON.stringify(said)}`);
  });

  await t.test('a banned account is turned away and never offered the door', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD, banned: 1 });
    const c = await api.post('/api/auth/check', { phone: NEW_PHONE });
    assert.equal(c.body.hasPassword, false, 'a banned account should not get the password screen');
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    assert.equal(r.status, 403);
  });

  await t.test('and is turned away at the OTP door as well', async () => {
    // Otherwise the OTP mints a token every later request then refuses.
    await seedUser({ phone: NEW_PHONE, password: GOOD, banned: 1 });
    const code = await seedOtp(NEW_PHONE);
    const r = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    assert.equal(r.status, 403);
    assert.equal(r.body.token, undefined, 'a banned account was handed a session');
  });

  await t.test('an empty password is rejected before any hashing', async () => {
    await signedUp();
    for (const password of ['', undefined, null, 12345]) {
      const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(password)}`);
    }
  });
});

/* ---------------------------------------------------------------- */
test('guessing the password', async t => {
  t.beforeEach(reset);

  const wrongTry = () => api.post('/api/auth/login-password', { phone: NEW_PHONE, password: 'not-it-at-all' });

  await t.test('locks the account after five wrong tries', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    for (let i = 0; i < 4; i++) assert.equal((await wrongTry()).status, 401, `try ${i + 1}`);
    const fifth = await wrongTry();
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.code, 'LOCKED');
    assert.match(fifth.body.error, /minute/);
  });

  await t.test('and then refuses even the correct password', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    for (let i = 0; i < 5; i++) await wrongTry();
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    assert.equal(r.status, 429, 'the lock did not hold against the right password');
  });

  await t.test('but the OTP door stays open, so nobody is locked out for good', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    for (let i = 0; i < 5; i++) await wrongTry();
    const code = await seedOtp(NEW_PHONE);
    const r = await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    assert.equal(r.status, 200, 'a locked account could never recover');
  });

  await t.test('a successful sign-in clears the count', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    await wrongTry(); await wrongTry();
    await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    const u = await fake.col('users').findOne({ phone: NEW_PHONE });
    assert.equal(u.pw_attempts, 0);
    // Four more wrong tries must not lock, since the counter restarted.
    for (let i = 0; i < 4; i++) assert.equal((await wrongTry()).status, 401, `try ${i + 1} after reset`);
  });

  await t.test('guesses fired in parallel are each counted', async () => {
    /* Counting from the value read before the write let several in-flight
       attempts share one increment, so an attacker running requests in
       parallel got more than five tries — or never tripped the lock at all. */
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    await Promise.all(Array.from({ length: 5 }, wrongTry));
    const u = await fake.col('users').findOne({ phone: NEW_PHONE });
    assert.ok(lockedNow(u), 'five parallel wrong guesses did not lock the account');
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    assert.equal(r.status, 429);
  });

  await t.test('the lock expires on its own', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    for (let i = 0; i < 5; i++) await wrongTry();
    // Wind the clock past the lock rather than waiting fifteen minutes.
    await fake.col('users').updateOne({ phone: NEW_PHONE }, { $set: { pw_locked_until: Date.now() - 1 } });
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD });
    assert.equal(r.status, 200);
  });
});

/* ---------------------------------------------------------------- */
test('forgotten password', async t => {
  t.beforeEach(reset);

  await t.test('an OTP session may replace the password without the old one', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    const code = await seedOtp(NEW_PHONE);
    const otpSession = (await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code })).body;
    assert.equal(otpSession.needsPassword, false, 'the account already has one');

    const set = await api.post('/api/auth/set-password', { password: 'newPass$99' }, otpSession.token);
    assert.equal(set.status, 200, JSON.stringify(set.body));

    assert.equal((await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: 'newPass$99' })).status, 200);
    assert.equal((await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD })).status, 401,
      'the old password still works');
  });

  await t.test('a password session must prove the current one', async () => {
    /* A stolen token is not enough to lock the real owner out — changing the
       password from a password-proved session needs the password. */
    const u = await seedUser({ phone: NEW_PHONE, password: GOOD });
    const session = (await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: GOOD })).body.token;

    const bare = await api.post('/api/auth/set-password', { password: 'newPass$99' }, session);
    assert.equal(bare.status, 400);
    assert.equal(bare.body.code, 'CURRENT_REQUIRED');

    const wrong = await api.post('/api/auth/set-password',
      { password: 'newPass$99', currentPassword: 'nope-nope' }, session);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'BAD_CURRENT');

    const ok = await api.post('/api/auth/set-password',
      { password: 'newPass$99', currentPassword: GOOD }, session);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(u.id);
  });

  await t.test('the new password cannot be the old one', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD });
    const code = await seedOtp(NEW_PHONE);
    const token = (await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code })).body.token;
    const r = await api.post('/api/auth/set-password', { password: GOOD }, token);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /already your password/i);
  });

  await t.test('the reset clears a lockout', async () => {
    await seedUser({ phone: NEW_PHONE, password: GOOD, pw_locked_until: Date.now() + 600000, pw_attempts: 3 });
    const code = await seedOtp(NEW_PHONE);
    const token = (await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code })).body.token;
    await api.post('/api/auth/set-password', { password: 'newPass$99' }, token);
    const r = await api.post('/api/auth/login-password', { phone: NEW_PHONE, password: 'newPass$99' });
    assert.equal(r.status, 200, 'the lock outlived the password it was protecting');
  });
});

/* ---------------------------------------------------------------- */
test('the signup bonus the admin controls', async t => {
  const signUp = async phone => {
    const code = await seedOtp(phone);
    return api.post('/api/auth/verify-otp', { phone, code, referralCode: 'KHEL-1001' });
  };
  const cash = async phone => {
    const u = await fake.col('users').findOne({ phone });
    return (await fake.col('wallets').findOne({ user_id: u.id })).deposit;
  };

  await t.test('is not paid when both amounts are zero', async () => {
    await reset({ signup_bonus: 0, referral_bonus: 0 });
    await signUp(NEW_PHONE);
    assert.equal(await cash(NEW_PHONE), 0);
  });

  await t.test('pays the welcome credit to every new account', async () => {
    await reset({ signup_bonus: 25, referral_bonus: 0 });
    await signUp(NEW_PHONE);
    assert.equal(await cash(NEW_PHONE), 25);
  });

  await t.test('adds the referral tier only when a code was used', async () => {
    await reset({ signup_bonus: 25, referral_bonus: 50 });
    await seedUser({ phone: '9800000001' });         // id 1 -> referral_code KHEL-1001
    await signUp(NEW_PHONE);
    assert.equal(await cash(NEW_PHONE), 75, 'referred signup should get both');

    const code = await seedOtp('9800000002');
    await api.post('/api/auth/verify-otp', { phone: '9800000002', code });
    assert.equal(await cash('9800000002'), 25, 'an unreferred signup gets only the welcome credit');
  });

  await t.test('lands in cash, never in withdrawable winnings', async () => {
    await reset({ signup_bonus: 100, referral_bonus: 0 });
    await signUp(NEW_PHONE);
    const u = await fake.col('users').findOne({ phone: NEW_PHONE });
    const w = await fake.col('wallets').findOne({ user_id: u.id });
    assert.deepEqual([w.deposit, w.winnings], [100, 0],
      'a withdrawable welcome bonus is free money out the door');
  });

  await t.test('is paid once, not again on the next sign-in', async () => {
    await reset({ signup_bonus: 25, referral_bonus: 0 });
    await signUp(NEW_PHONE);
    const code = await seedOtp(NEW_PHONE);
    await api.post('/api/auth/verify-otp', { phone: NEW_PHONE, code });
    assert.equal(await cash(NEW_PHONE), 25, 'the bonus was paid twice');
  });

  await t.test('writes a ledger row, so the books still balance', async () => {
    await reset({ signup_bonus: 25, referral_bonus: 0 });
    await signUp(NEW_PHONE);
    const u = await fake.col('users').findOne({ phone: NEW_PHONE });
    const rows = fake.dump('transactions').filter(t => t.user_id === u.id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].type, rows[0].bucket, rows[0].amount], ['credit', 'deposit', 25]);
  });
});
