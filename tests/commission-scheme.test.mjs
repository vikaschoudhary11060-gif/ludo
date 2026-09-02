/* ============================================================
   The stored commission numbers changed meaning.

   They used to be a share of the whole pot; they are now a share
   of one player's bet — the number the rules quote and the number
   that is charged. A value written under the old meaning takes
   half what its operator intends, and nothing on screen says so,
   so it is realigned exactly once.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fake-mongo.mjs';

const fake = createFakeDb();
const { mock } = await import('node:test');
mock.module(new URL('../server/src/lib/mongo.js', import.meta.url).href, {
  namedExports: {
    col: fake.col, nextId: fake.nextId, withTransaction: fake.withTransaction,
    connect: fake.connect, db: () => ({}), startSession: () => ({}), close: async () => {},
  },
});

const { ensureSeed, getSettings } = await import('../server/src/lib/db.js');
const { SETTINGS_DEFAULTS, COMMISSION_SCHEME, commissionFor, prizeFor } =
  await import('../server/src/lib/config.js');

const settings = () => fake.col('settings').findOne({ id: 1 });

test('the published rates', async t => {
  await t.test('are 8% up to ₹500 and 5% above it, on one bet', () => {
    assert.equal(SETTINGS_DEFAULTS.commission_under, 0.08);
    assert.equal(SETTINGS_DEFAULTS.commission_from, 0.05);
    assert.equal(SETTINGS_DEFAULTS.commission_threshold, 500);
  });

  await t.test('produce the payouts the rules promise', () => {
    // The table this was signed off against.
    const rows = [[100, 8, 192], [500, 40, 960], [501, 25, 977], [1000, 50, 1950]];
    for (const [bet, cut, winner] of rows) {
      assert.equal(prizeFor(bet, {}), winner, `₹${bet} should pay ₹${winner}`);
      assert.equal(bet * 2 - prizeFor(bet, {}), cut, `₹${bet} should take ₹${cut}`);
    }
  });

  await t.test('are shown as the same number that is charged', () => {
    // 8% shown, 8% of one bet taken — no factor in between.
    assert.equal(commissionFor(500, {}) * 100, 8);
    assert.equal(commissionFor(1000, {}) * 100, 5);
  });
});

test('realigning a settings document written under the old meaning', async t => {
  t.beforeEach(() => fake.reset());

  await t.test('a fresh install starts on the current scheme', async () => {
    await ensureSeed();
    const s = await settings();
    assert.equal(s.commission_scheme, COMMISSION_SCHEME);
    assert.equal(s.commission_under, 0.08);
    assert.equal(s.commission_from, 0.05);
  });

  await t.test('an old document is corrected once', async () => {
    // Exactly what production held: rates meant as a share of the pot, and
    // no scheme marker because the field did not exist yet.
    await fake.col('settings').insertOne({
      id: 1, ...SETTINGS_DEFAULTS, commission_under: 0.05, commission_from: 0.025,
    });
    delete fake.dump('settings')[0].commission_scheme;

    await ensureSeed();
    const s = await settings();
    assert.equal(s.commission_under, 0.08, 'the stale rate was left in place');
    assert.equal(s.commission_from, 0.05);
    assert.equal(s.commission_scheme, COMMISSION_SCHEME);
  });

  await t.test('and never again — a later choice by an admin sticks', async () => {
    await ensureSeed();                       // marks the scheme
    // The operator deliberately picks their own rates afterwards.
    await fake.col('settings').updateOne({ id: 1 },
      { $set: { commission_under: 0.06, commission_from: 0.04 } });

    await ensureSeed();
    await ensureSeed();
    const s = await settings();
    assert.equal(s.commission_under, 0.06, 'the realignment overwrote a deliberate setting');
    assert.equal(s.commission_from, 0.04);
  });

  await t.test('leaves everything else alone', async () => {
    await fake.col('settings').insertOne({
      id: 1, ...SETTINGS_DEFAULTS,
      commission_under: 0.05, commission_from: 0.025,
      withdraw_open: 0, notice: 'hello', battle_limit: 7, upi_id: 'mine@ybl',
    });
    fake.dump('settings')[0].commission_scheme = undefined;

    await ensureSeed();
    const s = await getSettings();
    assert.equal(s.withdraw_open, 0, 'an unrelated switch was reset');
    assert.equal(s.notice, 'hello');
    assert.equal(s.battle_limit, 7);
    assert.equal(s.upi_id, 'mine@ybl');
  });
});
