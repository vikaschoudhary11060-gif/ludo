/* ============================================================
   An in-process API, for scenario tests.

   The routers are the real ones — real zod schemas, real auth
   middleware, real money code. Only the database underneath is
   swapped for the in-memory stand-in, so a test exercises the
   path a request actually takes rather than a re-description of
   it.

   Usage:

     const api = await startApi({ auth: true, wallet: true });
     const r = await api.post('/api/auth/check', { phone: '9876543210' });
     await api.stop();
   ============================================================ */
import http from 'node:http';
import { createFakeDb } from './fake-mongo.mjs';

/* express lives in server/node_modules; this file does not, so resolving it
   by bare name would look in the repo root and fail. */
const serverModule = async spec =>
  (await import(new URL(`../../server/node_modules/${spec}`, import.meta.url).href)).default;

export const fake = createFakeDb();

/* Mocked before any route module is imported, so every one of them — and
   everything they import — reaches this instead of a real connection. */
const { mock } = await import('node:test');
mock.module(new URL('../../server/src/lib/mongo.js', import.meta.url).href, {
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

/* The routes read these at import time. Set here so a test never depends on
   the developer's shell.

   NODE_ENV is deliberately not "development": IS_DEV gates the test-only
   affordances, and these scenarios are meant to run against the production
   semantics — no OTP in the response, no simulated top-up.

   The per-IP rate limits are lifted because every request in a file comes
   from 127.0.0.1; they are exercised on their own, not as a side effect of
   the twentieth assertion in an unrelated test. */
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-to-be-accepted-32';
process.env.NODE_ENV ||= 'test';
process.env.PASSWORD_RATE_LIMIT ||= '10000';
process.env.CHECK_RATE_LIMIT ||= '10000';

const ROUTES = {
  auth: ['../../server/src/routes/auth.js', '/api/auth'],
  wallet: ['../../server/src/routes/wallet.js', '/api/wallet'],
  battles: ['../../server/src/routes/battles.js', '/api/battles'],
  admin: ['../../server/src/routes/admin.js', '/api/admin'],
  payments: ['../../server/src/routes/payments.js', '/api/payments'],
};

/** Start an HTTP server carrying the named routers. */
export async function startApi(which = {}) {
  const express = await serverModule('express/index.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  for (const [name, [file, mount]] of Object.entries(ROUTES)) {
    if (!which[name]) continue;
    const mod = await import(new URL(file, import.meta.url).href);
    // payments.js default-exports the ADMIN router; the player one is named.
    app.use(mount, name === 'payments' ? mod.userRouter : mod.default);
  }

  // Mirrors the production error handler closely enough to tell a 4xx the
  // route chose from a 500 the route did not mean.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: String(err?.message || err), stack: err?.stack });
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: data ?? {} };
  };

  return {
    app, base, fake,
    get: (p, token) => call('GET', p, undefined, token),
    post: (p, body, token) => call('POST', p, body, token),
    patch: (p, body, token) => call('PATCH', p, body, token),
    stop: () => new Promise(r => server.close(r)),
  };
}

/* ---------- fixtures ---------- */

/** Settings, as ensureSeed() would leave them, plus any overrides. */
export async function seedSettings(overrides = {}) {
  const { SETTINGS_DEFAULTS } = await import(
    new URL('../../server/src/lib/config.js', import.meta.url).href);
  await fake.col('settings').deleteMany({});
  await fake.col('settings').insertOne({ id: 1, ...SETTINGS_DEFAULTS, ...overrides });
}

/** A signed-in player. Returns { id, phone, token, ... }. */
export async function seedUser({
  phone = '9876543210', name = 'Test Player', kyc_status = 'none',
  deposit = 0, winnings = 0, referral = 0, password = null, ...rest
} = {}) {
  const { sign } = await import(new URL('../../server/src/lib/auth.js', import.meta.url).href);
  const { hashPassword } = await import(new URL('../../server/src/lib/password.js', import.meta.url).href);
  const id = await fake.nextId('users');
  const user = {
    id, phone, name, avatar: 0, email: null, avatar_url: null, email_verified: 0,
    kyc_status, kyc_method: null, kyc_masked: null, legal_name: null,
    referral_code: 'KHEL-' + String(1000 + id), referred_by: null,
    banned: 0, session_epoch: 0, created_at: Date.now(),
    ...(password ? { password_hash: await hashPassword(password) } : {}),
    ...rest,
  };
  await fake.col('users').insertOne(user);
  await fake.col('wallets').insertOne({ user_id: id, deposit, winnings, referral });
  return { ...user, token: sign(id, user.session_epoch, password ? 'password' : 'otp') };
}

/** The wallet as it stands now. */
export const walletOf = async id =>
  (await fake.col('wallets').findOne({ user_id: id })) || { deposit: 0, winnings: 0, referral: 0 };

/** Every ledger row for a user, as [type, bucket, amount, note] tuples. */
export const ledgerOf = id => fake.dump('transactions')
  .filter(t => t.user_id === id)
  .map(t => [t.type, t.bucket, t.amount, t.note]);

/** A signed-in admin. Returns { id, username, role, token }. */
export async function seedAdmin({ username = 'owner1', role = 'owner', name = 'Owner' } = {}) {
  const { signAdmin } = await import(new URL('../../server/src/lib/admin-auth.js', import.meta.url).href);
  const id = await fake.nextId('admin_users');
  const admin = { id, username, name, password_hash: 'x', role, active: 1,
                  last_login_at: null, created_at: Date.now() };
  await fake.col('admin_users').insertOne(admin);
  return { ...admin, token: signAdmin(admin) };
}

/** Put a valid OTP in place, as request-otp would. */
export async function seedOtp(phone, code = '123456') {
  await fake.col('otps').deleteMany({ phone });
  await fake.col('otps').insertOne({ phone, code, expires_at: Date.now() + 300000, attempts: 0 });
  return code;
}
