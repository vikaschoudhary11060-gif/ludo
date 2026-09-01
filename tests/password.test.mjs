/* ============================================================
   Player passwords.

   Once a password exists it is the only thing between a stranger
   and someone's withdrawable balance, so the rules that decide
   what counts as one — and the lockout that limits guessing —
   are worth pinning down.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  passwordProblem, hashPassword, checkPassword,
  shouldLock, lockUpdate, lockoutRemaining, lockoutMessage,
  PASSWORD_MIN, PASSWORD_MAX, MAX_PASSWORD_ATTEMPTS, LOCKOUT_MS,
} = await import('../server/src/lib/password.js');

const PHONE = '9876543210';

test('what counts as an acceptable password', async t => {
  await t.test(`rejects anything under ${PASSWORD_MIN} characters`, () => {
    for (const pw of ['', 'a', 'abc', 'abcde']) {
      assert.match(String(passwordProblem(pw, PHONE)), /at least/, `accepted ${JSON.stringify(pw)}`);
    }
    assert.equal(passwordProblem('abcdef', PHONE), null, 'six characters should pass');
  });

  await t.test('rejects past the bcrypt ceiling rather than truncating', () => {
    assert.equal(passwordProblem('a1'.repeat(PASSWORD_MAX / 2), PHONE), null, 'exactly the limit is fine');
    assert.match(String(passwordProblem('a'.repeat(PASSWORD_MAX + 1), PHONE)), /at most/);
  });

  await t.test('rejects the guesses that get tried first', () => {
    for (const pw of ['123456', 'password', 'qwerty123', 'PASSWORD', 'Qwerty123']) {
      assert.ok(passwordProblem(pw, PHONE), `accepted ${pw}`);
    }
  });

  await t.test('rejects one character repeated', () => {
    assert.match(String(passwordProblem('aaaaaa', PHONE)), /repeated/);
    assert.match(String(passwordProblem('999999', PHONE)), /repeated/);
  });

  await t.test('rejects the phone number, whole or in part', () => {
    // Every opponent they have ever played can see this number.
    for (const pw of [PHONE, PHONE.slice(-6), PHONE.slice(0, 6)]) {
      assert.match(String(passwordProblem(pw, PHONE)), /phone number/, `accepted ${pw}`);
    }
  });

  await t.test('accepts an ordinary password', () => {
    for (const pw of ['ludo$Bro7', 'my dog rex', 'Khelbro2026!', 'गुप्तशब्द']) {
      assert.equal(passwordProblem(pw, PHONE), null, `rejected ${pw}`);
    }
  });

  await t.test('survives being handed nothing at all', () => {
    for (const pw of [undefined, null, 0, {}]) assert.ok(passwordProblem(pw, PHONE));
    assert.equal(passwordProblem('ludo$Bro7'), null, 'a missing phone must not throw');
  });
});

test('checking a password', async t => {
  const hash = await hashPassword('ludo$Bro7');

  await t.test('matches the right one and nothing else', async () => {
    assert.equal(await checkPassword('ludo$Bro7', hash), true);
    assert.equal(await checkPassword('ludo$Bro8', hash), false);
    assert.equal(await checkPassword('', hash), false);
  });

  await t.test('an account with no password matches nothing', async () => {
    // Not even an empty string, and not the dummy hash's own plaintext.
    for (const stored of [null, undefined, '']) {
      assert.equal(await checkPassword('anything', stored), false);
      assert.equal(await checkPassword('', stored), false);
    }
  });

  await t.test('two hashes of the same password differ', async () => {
    assert.notEqual(await hashPassword('ludo$Bro7'), await hashPassword('ludo$Bro7'), 'unsalted hashing');
  });

  await t.test('never blocks the event loop while it works', async () => {
    /* The sync pair costs ~110ms of solid computation per call. On the sign-in
       path that is 110ms in which nothing else on the process runs — no
       battle, no wallet read, no socket frame. */
    let ticks = 0;
    const spin = setInterval(() => ticks++, 1);
    await checkPassword('ludo$Bro7', hash);
    clearInterval(spin);
    assert.ok(ticks > 0, 'the password check held the event loop for its whole duration');
  });
});

test('account lockout', async t => {
  await t.test('does not lock before the limit', () => {
    for (let after = 0; after < MAX_PASSWORD_ATTEMPTS; after++) {
      assert.equal(shouldLock(after), false, `locked at attempt ${after}`);
    }
  });

  await t.test(`locks at attempt ${MAX_PASSWORD_ATTEMPTS} and beyond`, () => {
    // "Beyond" matters: parallel guesses can push the counter past the limit
    // between the increment and the check.
    for (const after of [MAX_PASSWORD_ATTEMPTS, MAX_PASSWORD_ATTEMPTS + 1, 99]) {
      assert.equal(shouldLock(after), true, `did not lock at ${after}`);
    }
  });

  await t.test('treats a missing counter as zero', () => {
    for (const after of [undefined, null, NaN, 'x']) {
      assert.equal(shouldLock(after), false);
    }
  });

  await t.test('the lock write restarts the counter', () => {
    const u = lockUpdate(1000);
    assert.equal(u.$set.pw_locked_until, 1000 + LOCKOUT_MS);
    assert.equal(u.$set.pw_attempts, 0, 'the counter must restart after the lock');
  });

  await t.test('reports the time left, and zero once it has passed', () => {
    assert.equal(lockoutRemaining({ pw_locked_until: 5000 }, 4000), 1000);
    assert.equal(lockoutRemaining({ pw_locked_until: 5000 }, 5000), 0);
    assert.equal(lockoutRemaining({ pw_locked_until: 5000 }, 9000), 0);
    assert.equal(lockoutRemaining({}, 9000), 0);
    assert.equal(lockoutRemaining(null, 9000), 0);
  });

  await t.test('rounds the wait up, so it never promises early', () => {
    assert.match(lockoutMessage(1), /1 minute,/);
    assert.match(lockoutMessage(60_000), /1 minute,/);
    assert.match(lockoutMessage(61_000), /2 minutes,/);
    // The OTP door stays open, or a locked-out owner could never get back in.
    assert.match(lockoutMessage(60_000), /OTP/);
  });
});
