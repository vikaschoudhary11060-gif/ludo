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

const { ensureBots, runBotTick, botTakeOver, purgeBotBattles,
        BOT_COUNT, TARGET_LIVE, ACCEPT_CEILING_MS, NOT_BOT } = await import('../server/src/lib/bots.js');
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

/** One tick, with every open battle's moment brought forward so the same pass
    also takes them over. Tests that care about the steady state want the board
    as it looks a few seconds later, not mid-window. */
async function settle() {
  for (const b of battles()) if (b.status === 'open') b.bot_accept_at = Date.now() - 1;
  await runBotTick(APP);
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

  await t.test('every bot carries a real full name, and they are all distinct', async () => {
    await ensureBots();
    const names = bots().map(b => b.name);
    assert.equal(names.length, BOT_COUNT);
    assert.equal(new Set(names).size, BOT_COUNT, 'two bots share a name');
    for (const n of names) {
      /* These sit on the open board next to real players. A handle like
         "AmanRolls" beside "Priya Nair" reads as a different kind of account,
         which is exactly what a lobby bot must not do. */
      assert.match(n, /^[A-Z][a-z]+ [A-Z][a-z]+$/, `"${n}" is not a first and last name`);
    }
  });

  await t.test('renames a pool that was seeded under the old handles', async () => {
    await ensureBots();
    const one = fake.dump('users').find(u => u.phone === '1000000001');
    const proper = one.name;
    one.name = 'RohitPlays';

    await ensureBots();
    assert.equal(fake.dump('users').find(u => u.phone === '1000000001').name, proper,
      'an existing pool must pick up the real names, not stay half-renamed');
    assert.equal(bots().length, BOT_COUNT, 'the repair created a duplicate account');
  });

  await t.test('keeps each name pinned to its own phone number', async () => {
    await ensureBots();
    const first = Object.fromEntries(bots().map(b => [b.phone, b.name]));
    await ensureBots();
    for (const b of bots()) {
      assert.equal(b.name, first[b.phone], 'a restart shuffled who is who');
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

test('a bot battle appears open and is taken within five seconds', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('is created open, unaccepted, with no room code', async () => {
    await runBotTick(APP);
    const b = battles()[0];
    assert.equal(b.status, 'open', 'the open window is what makes the board look alive');
    assert.equal(b.acceptor_id, null);
    assert.equal(b.room_code, null, 'an open battle has no room to join yet');
    assert.equal(b.is_bot, true);
  });

  await t.test('names the bot that will take it, and it is never the host', async () => {
    await runBotTick(APP);
    for (const b of battles()) {
      assert.ok(b.bot_acceptor_id != null, 'nobody is lined up to accept this');
      assert.notEqual(b.bot_acceptor_id, b.creator_id, 'a bot was paired against itself');
    }
  });

  await t.test('is due to be taken inside the five-second promise', async () => {
    const at = Date.now();
    await runBotTick(APP);
    for (const b of battles()) {
      assert.ok(b.bot_accept_at > at, 'it should not already be due');
      assert.ok(b.bot_accept_at - at <= ACCEPT_CEILING_MS,
        `${b.bot_accept_at - at}ms is past the five-second promise`);
    }
  });

  await t.test('the sweep takes over everything that is due', async () => {
    await runBotTick(APP);
    const open = battles().filter(b => b.status === 'open');
    assert.ok(open.length, 'nothing was created to take over');
    for (const b of open) b.bot_accept_at = Date.now() - 1;

    await runBotTick(APP);
    for (const id of open.map(b => b.id)) {
      const after = battles().find(b => b.id === id);
      assert.equal(after.status, 'running', 'an overdue battle was left open');
      assert.ok(after.acceptor_id != null && after.acceptor_id !== after.creator_id);
      assert.match(String(after.room_code), /^\d{8}$/, 'a running battle needs an 8-digit room code');
    }
  });

  await t.test('the sweep leaves it alone until its moment', async () => {
    await runBotTick(APP);
    const before = battles().map(b => b.id);
    await runBotTick(APP);                       // a tick inside the open window
    for (const id of before) {
      assert.equal(battles().find(b => b.id === id).status, 'open',
        'the sweep took a battle over before its five seconds were up');
    }
  });

  await t.test('but a real player’s tap can take it over early', async () => {
    /* botTakeOver() is deliberately not gated on the clock. The sweep checks
       `bot_accept_at`; this does not, because the accept route calls it the
       instant a player taps, and the row has to be gone by their refresh. */
    await runBotTick(APP);
    const id = battles()[0].id;
    assert.equal(await botTakeOver(APP, id), true);
    assert.equal(battles().find(b => b.id === id).status, 'running');
  });

  await t.test('the retirement clock starts when it starts running, not before', async () => {
    await runBotTick(APP);
    const b = battles()[0];
    assert.equal(b.bot_retire_at, null, 'an open battle is not yet on the clock');
    await botTakeOver(APP, b.id);
    assert.ok(battles().find(x => x.id === b.id).bot_retire_at > Date.now());
  });

  await t.test('is never retired while it is still open', async () => {
    /* Open battles carry `bot_retire_at: null`. A comparison operator does not
       match null in MongoDB, so the retirement sweep steps over them — but a
       change to 0, or to leaving the field off, would silently delete every
       challenge before anyone could see it. */
    await runBotTick(APP);
    const ids = battles().filter(b => b.status === 'open').map(b => b.id);
    assert.ok(ids.length, 'nothing open to test');
    for (let i = 0; i < 3; i++) await runBotTick(APP);
    for (const id of ids) {
      assert.ok(battles().some(b => b.id === id), 'an open battle was retired before it ran');
    }
  });

  await t.test('taking one over twice changes nothing the second time', async () => {
    await runBotTick(APP);
    const id = battles()[0].id;
    assert.equal(await botTakeOver(APP, id), true);
    const after = { ...battles().find(b => b.id === id) };
    assert.equal(await botTakeOver(APP, id), false);
    assert.equal(battles().find(b => b.id === id).acceptor_id, after.acceptor_id);
    assert.equal(battles().find(b => b.id === id).room_code, after.room_code);
  });

  await t.test('drops the scheduling fields once it is running', async () => {
    await runBotTick(APP);
    const id = battles()[0].id;
    await botTakeOver(APP, id);
    const after = battles().find(b => b.id === id);
    assert.equal('bot_accept_at' in after, false);
    assert.equal('bot_acceptor_id' in after, false);
  });
});

test('bot battles', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('never move money — no ledger row, no wallet change', async () => {
    await fill(TARGET_LIVE);
    await settle();

    assert.equal(fake.dump('transactions').length, 0, 'a bot battle wrote to the ledger');
    for (const w of fake.dump('wallets')) {
      assert.deepEqual([w.deposit, w.winnings, w.referral], [0, 0, 0],
        'a bot wallet moved');
    }
  });

  await t.test('stay within the mode limits the lobby publishes', async () => {
    await fill(TARGET_LIVE);
    for (const b of battles()) {
      const cfg = MODES[b.mode];
      assert.ok(cfg, `unknown mode ${b.mode}`);
      assert.ok(b.amount >= cfg.min && b.amount <= cfg.max,
        `${b.amount} is outside ${b.mode} (${cfg.min}-${cfg.max})`);
      assert.equal(b.amount % cfg.step, 0, `${b.amount} is not a multiple of ${cfg.step}`);
    }
  });

  await t.test(`holds ${TARGET_LIVE} on the board and does not overshoot`, async () => {
    for (let i = 0; i < 40; i++) await settle();
    assert.equal(battles().length, TARGET_LIVE,
      `${battles().length} battles on a board meant to hold ${TARGET_LIVE}`);
  });

  await t.test('counts the open ones towards the target', async () => {
    // Without that, every tick inside a five-second open window would decide
    // the board was short and start another one.
    for (let i = 0; i < 10; i++) await runBotTick(APP);
    assert.equal(battles().length, TARGET_LIVE,
      'open battles were not counted, so the board overshot');
  });

  await t.test('are removed once their time is up', async () => {
    await fill(TARGET_LIVE);
    await settle();
    const running = battles().find(b => b.status === 'running');
    assert.ok(running, 'nothing reached Running to retire');
    const id = running.id;

    running.bot_retire_at = Date.now() - 1;
    await runBotTick(APP);
    assert.equal(battles().some(b => b.id === id), false, 'the expired battle is still there');
  });

  await t.test('never settle, so there is no bot commission to earn', async () => {
    await fill(TARGET_LIVE);
    for (let i = 0; i < 5; i++) await settle();
    for (const b of battles()) {
      assert.equal(b.winner_id, null);
      assert.equal(b.payout, null);
      assert.equal(b.settled_at, null);
      assert.notEqual(b.status, 'completed');
    }
  });
});

test('clearing the board', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('removes every bot battle, whatever state it is in', async () => {
    await fill(TARGET_LIVE);
    await runBotTick(APP);                       // leaves a mix of open and running
    assert.ok(battles().length > 0);

    const cleared = await purgeBotBattles(APP);
    assert.equal(cleared, TARGET_LIVE);
    assert.deepEqual(battles(), []);
  });

  await t.test('leaves real battles alone', async () => {
    await fake.col('battles').insertOne({ id: 'real1', status: 'open', amount: 500 });
    await fill(TARGET_LIVE);
    await purgeBotBattles(APP);
    assert.deepEqual(battles().map(b => b.id), ['real1']);
  });

  await t.test('on an empty board it is a no-op', async () => {
    assert.equal(await purgeBotBattles(APP), 0);
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
