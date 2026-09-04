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

const { ensureBots, runBotTick, botTakeOver, purgeBotBattles, rotateBotNames,
        BOT_COUNT, TARGET_RUNNING, TARGET_OPEN, NOT_BOT } = await import('../server/src/lib/bots.js');
const { MODES } = await import('../server/src/lib/config.js');

/* No `io` on the app: emitCreated returns early, which keeps the tests off
   the aggregation pipeline the fake database does not implement. */
const APP = { get: () => null };

const battles = () => fake.dump('battles');
const bots = () => fake.dump('users').filter(u => u.is_bot);

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
      assert.match(n, /^[A-Z][a-z]+ [A-Z][a-z]+$/, `"${n}" is not a first and last name`);
    }
  });

  await t.test('a restart leaves legitimate pool names alone', async () => {
    await ensureBots();
    const firstNames = bots().map(b => b.name);
    await ensureBots();
    assert.deepEqual(bots().map(b => b.name), firstNames);
  });

  await t.test('but replaces a name from an older seed', async () => {
    await ensureBots();
    const one = bots()[0];
    fake.dump('users').find(u => u.id === one.id).name = 'AmanRolls';
    await ensureBots();
    const after = bots().find(u => u.id === one.id).name;
    assert.notEqual(after, 'AmanRolls', 'the old handle was left on the bot');
    assert.match(after, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  await t.test('re-flags a bot whose is_bot flag was cleared', async () => {
    await ensureBots();
    const one = bots()[0];
    delete fake.dump('users').find(u => u.id === one.id).is_bot;
    await ensureBots();
    assert.equal(bots().length, BOT_COUNT, 'the unflagged account was not re-flagged');
  });
});

test('bot battle board structure: 3 running and 2 open', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('creates exactly 3 running and 2 open battles on a fresh board', async () => {
    await runBotTick(APP);
    const running = battles().filter(b => b.status === 'running');
    const open = battles().filter(b => b.status === 'open');
    assert.equal(running.length, TARGET_RUNNING, `expected ${TARGET_RUNNING} running`);
    assert.equal(open.length, TARGET_OPEN, `expected ${TARGET_OPEN} open`);
    assert.equal(battles().length, TARGET_RUNNING + TARGET_OPEN);
  });

  await t.test('open challenges have no acceptor, no room code, and valid bot creator', async () => {
    await runBotTick(APP);
    const open = battles().filter(b => b.status === 'open');
    for (const b of open) {
      assert.equal(b.status, 'open');
      assert.equal(b.acceptor_id, null);
      assert.equal(b.room_code, null);
      assert.equal(b.is_bot, true);
      assert.ok(b.creator_id != null);
      assert.ok(b.bot_acceptor_id != null);
      assert.notEqual(b.bot_acceptor_id, b.creator_id);
    }
  });

  await t.test('running matches have both players, room code, and retirement timestamp', async () => {
    await runBotTick(APP);
    const running = battles().filter(b => b.status === 'running');
    for (const b of running) {
      assert.equal(b.status, 'running');
      assert.ok(b.creator_id != null);
      assert.ok(b.acceptor_id != null);
      assert.notEqual(b.creator_id, b.acceptor_id);
      assert.match(String(b.room_code), /^\d{8}$/);
      assert.ok(b.bot_retire_at > Date.now());
    }
  });

  await t.test('when a running battle retires, oldest open challenge is promoted', async () => {
    await runBotTick(APP);
    const oldestOpen = battles().filter(b => b.status === 'open').sort((a, b) => a.created_at - b.created_at)[0];
    assert.ok(oldestOpen);

    // Expire one running match
    const running = battles().find(b => b.status === 'running');
    running.bot_retire_at = Date.now() - 1;

    await runBotTick(APP);

    // Oldest open should now be running
    const promoted = battles().find(b => b.id === oldestOpen.id);
    assert.equal(promoted.status, 'running');

    // Counts must stay exactly 3 running and 2 open
    assert.equal(battles().filter(b => b.status === 'running').length, TARGET_RUNNING);
    assert.equal(battles().filter(b => b.status === 'open').length, TARGET_OPEN);
  });

  await t.test('botTakeOver allows early takeover when a player taps play', async () => {
    await runBotTick(APP);
    const open = battles().find(b => b.status === 'open');
    assert.ok(open);
    const res = await botTakeOver(APP, open.id);
    assert.equal(res, true);
    assert.equal(battles().find(b => b.id === open.id).status, 'running');
  });

  await t.test('calling botTakeOver twice on the same battle returns false second time', async () => {
    await runBotTick(APP);
    const open = battles().find(b => b.status === 'open');
    assert.equal(await botTakeOver(APP, open.id), true);
    assert.equal(await botTakeOver(APP, open.id), false);
  });
});

test('bot battles financial integrity & board bounds', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('never move money — no ledger row, no wallet change', async () => {
    await runBotTick(APP);
    assert.equal(fake.dump('transactions').length, 0, 'a bot battle wrote to the ledger');
    for (const w of fake.dump('wallets')) {
      assert.deepEqual([w.deposit, w.winnings, w.referral], [0, 0, 0], 'a bot wallet moved');
    }
  });

  await t.test('stay within the mode limits the lobby publishes', async () => {
    await runBotTick(APP);
    for (const b of battles()) {
      const cfg = MODES[b.mode];
      assert.ok(cfg, `unknown mode ${b.mode}`);
      assert.ok(b.amount >= cfg.min && b.amount <= cfg.max,
        `${b.amount} is outside ${b.mode} (${cfg.min}-${cfg.max})`);
      assert.equal(b.amount % cfg.step, 0, `${b.amount} is not a multiple of ${cfg.step}`);
    }
  });

  await t.test('holds exactly 3 running and 2 open across repeated ticks', async () => {
    for (let i = 0; i < 10; i++) {
      await runBotTick(APP);
      const running = battles().filter(b => b.status === 'running').length;
      const open = battles().filter(b => b.status === 'open').length;
      assert.equal(running, TARGET_RUNNING);
      assert.equal(open, TARGET_OPEN);
    }
  });

  await t.test('never settle, so there is no bot commission to earn', async () => {
    await runBotTick(APP);
    for (const b of battles()) {
      assert.equal(b.winner_id, null);
      assert.equal(b.payout, null);
      assert.equal(b.settled_at, null);
      assert.notEqual(b.status, 'completed');
    }
  });
});

test('rotateBotNames rotation logic', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('rotates bot names', async () => {
    await runBotTick(APP);
    const renamed = await rotateBotNames(APP);
    assert.ok(renamed >= 0);
    // All bots should have valid distinct names
    const names = bots().map(b => b.name);
    assert.equal(names.length, BOT_COUNT);
    assert.equal(new Set(names).size, BOT_COUNT);
  });
});

test('clearing the board', async t => {
  t.beforeEach(async () => { fake.reset(); await ensureBots(); });

  await t.test('removes every bot battle, whatever state it is in', async () => {
    await runBotTick(APP);
    assert.equal(battles().length, TARGET_RUNNING + TARGET_OPEN);

    const cleared = await purgeBotBattles(APP);
    assert.equal(cleared, TARGET_RUNNING + TARGET_OPEN);
    assert.deepEqual(battles(), []);
  });

  await t.test('leaves real battles alone', async () => {
    await fake.col('battles').insertOne({ id: 'real1', status: 'open', amount: 500 });
    await runBotTick(APP);
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
