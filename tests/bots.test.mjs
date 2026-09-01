/* ============================================================
   Lobby bots.

   The whole feature rests on three promises, and each one is a
   bug with real money behind it if it breaks:

     - a bot battle never writes a ledger row or touches a wallet
     - a bot account can never be signed into
     - nothing a bot does reaches the admin console
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

const { ensureBots, runBotTick, BOT_COUNT, NOT_BOT } = await import('../server/src/lib/bots.js');
const { MODES } = await import('../server/src/lib/config.js');

/* No `io` on the app: emitCreated returns early, which keeps the tests off
   the aggregation pipeline the fake database does not implement. */
const APP = { get: () => null };

const battles = () => fake.dump('battles');
const bots = () => fake.dump('users').filter(u => u.is_bot);

/** Drive the engine until it has put `n` battles on the board. */
async function fill(n) {
  for (let i = 0; i < n * 4 && battles().length < n; i++) await runBotTick(APP);
}

test('the bot pool', async t => {
  t.beforeEach(() => fake.reset());

  await t.test(`creates exactly ${BOT_COUNT} accounts`, async () => {
    const made = await ensureBots();
    assert.equal(made.length, BOT_COUNT);
    assert.equal(bots().length, BOT_COUNT);
  });

  await t.test('is idempotent — a restart adds nobody', async () => {
    await ensureBots();
    const again = await ensureBots();
    assert.deepEqual(again, [], 'the second run created accounts');
    assert.equal(bots().length, BOT_COUNT);
  });

  await t.test('every bot phone is one no real person could register', async () => {
    await ensureBots();
    // routes/auth.js accepts only this shape, for signup and for OTP requests.
    const SIGNUP_RE = /^[6-9]\d{9}$/;
    for (const b of bots()) {
      assert.equal(b.phone.length, 10, `${b.phone} is not 10 digits`);
      assert.equal(SIGNUP_RE.test(b.phone), false,
        `${b.phone} would pass the signup check — a real user could own it`);
    }
    assert.equal(new Set(bots().map(b => b.phone)).size, BOT_COUNT, 'phones must be unique');
  });

  await t.test('no bot carries a referral code', async () => {
    await ensureBots();
    // The index on referral_code is unique+sparse: sparse skips a *missing*
    // field but still indexes an explicit null, so nulls would collide.
    for (const b of bots()) {
      assert.ok(!('referral_code' in b), `${b.name} has a referral_code field`);
    }
  });

  await t.test('gives every bot a zeroed wallet', async () => {
    await ensureBots();
    const wallets = fake.dump('wallets');
    assert.equal(wallets.length, BOT_COUNT);
    for (const w of wallets) assert.deepEqual(
      [w.deposit, w.winnings, w.referral], [0, 0, 0]);
  });

  await t.test('flags an account seeded before the flag existed', async () => {
    await ensureBots();
    const one = bots()[0];
    delete fake.dump('users').find(u => u.id === one.id).is_bot;
    await ensureBots();
    assert.equal(bots().length, BOT_COUNT, 'the unflagged account was not re-flagged');
  });
});

test('bot battles', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('appear on the board, open, awaiting an auto-accept', async () => {
    await runBotTick(APP);
    assert.equal(battles().length, 1);
    const [b] = battles();
    assert.equal(b.status, 'open');
    assert.equal(b.is_bot, true);
    assert.ok(b.bot_accept_at > Date.now(), 'no acceptance was scheduled');
  });

  await t.test('carry a retirement stamp from the moment they are created', async () => {
    // A battle whose acceptance never lands must still be cleaned up, not sit
    // open on the lobby offering a Play button that can only refuse.
    await runBotTick(APP);
    const [b] = battles();
    assert.ok(b.bot_retire_at > Date.now(), 'an unaccepted bot battle would live forever');
  });

  await t.test('are accepted two to three seconds after creation', async () => {
    await runBotTick(APP);
    const [b] = battles();
    const delay = b.bot_accept_at - b.created_at;
    assert.ok(delay >= 2000 && delay <= 3000, `scheduled ${delay}ms out, expected 2000-3000`);
  });

  await t.test('the sweep promotes one whose timer was lost to a restart', async () => {
    await runBotTick(APP);
    // Exactly what a restart leaves behind: a due battle and no live timer.
    battles()[0].bot_accept_at = Date.now() - 1;
    await runBotTick(APP);

    const b = battles().find(x => x.status === 'running');
    assert.ok(b, 'the stale open battle was never accepted');
    assert.ok(b.acceptor_id != null && b.acceptor_id !== b.creator_id,
      'a bot was matched against itself');
    assert.match(String(b.room_code), /^\d{8}$/, 'running battles need an 8-digit room code');
    assert.ok(b.bot_retire_at > Date.now(), 'no retirement was scheduled');
    assert.ok(!('bot_accept_at' in b), 'the accept stamp should be cleared');
  });

  await t.test('never move money — no ledger row, no wallet change', async () => {
    await fill(6);
    for (const b of battles()) { b.bot_accept_at = Date.now() - 1; }
    await runBotTick(APP);

    assert.equal(fake.dump('transactions').length, 0, 'a bot battle wrote to the ledger');
    for (const w of fake.dump('wallets')) {
      assert.deepEqual([w.deposit, w.winnings, w.referral], [0, 0, 0],
        'a bot wallet moved');
    }
  });

  await t.test('stay within the mode limits the lobby publishes', async () => {
    await fill(12);
    for (const b of battles()) {
      const cfg = MODES[b.mode];
      assert.ok(cfg, `unknown mode ${b.mode}`);
      assert.ok(b.amount >= cfg.min && b.amount <= cfg.max,
        `${b.amount} is outside ${b.mode} (${cfg.min}-${cfg.max})`);
      assert.equal(b.amount % cfg.step, 0, `${b.amount} is not a multiple of ${cfg.step}`);
    }
  });

  await t.test('stop being created once the board is full', async () => {
    for (let i = 0; i < 40; i++) await runBotTick(APP);
    // The default target is 6; the cap is what matters, not the exact number.
    assert.ok(battles().length <= 6, `${battles().length} battles is over the target`);
    assert.ok(battles().length >= 5, 'the board should have filled up');
  });

  await t.test('are removed once their time is up', async () => {
    await runBotTick(APP);
    battles()[0].bot_accept_at = Date.now() - 1;
    await runBotTick(APP);
    const running = battles().find(b => b.status === 'running');
    const id = running.id;

    running.bot_retire_at = Date.now() - 1;
    await runBotTick(APP);
    assert.equal(battles().some(b => b.id === id), false, 'the expired battle is still there');
  });

  await t.test('never settle, so there is no bot commission to earn', async () => {
    await fill(6);
    for (const b of battles()) b.bot_accept_at = Date.now() - 1;
    for (let i = 0; i < 5; i++) await runBotTick(APP);
    for (const b of battles()) {
      assert.equal(b.winner_id, null);
      assert.equal(b.payout, null);
      assert.equal(b.settled_at, null);
      assert.notEqual(b.status, 'completed');
    }
  });
});

test('the admin filter excludes exactly the bot rows', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('matches real rows and rejects bot rows', async () => {
    await ensureBots();
    await runBotTick(APP);
    await fake.col('battles').insertOne({ id: 'real1', status: 'open', amount: 500 });

    const visible = await fake.col('battles').find(NOT_BOT).toArray();
    assert.deepEqual(visible.map(b => b.id), ['real1']);

    const players = await fake.col('users').find(NOT_BOT).toArray();
    assert.deepEqual(players, [], 'only bots exist in this fixture');
  });
});
