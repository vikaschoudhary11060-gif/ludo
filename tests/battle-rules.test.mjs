/* ============================================================
   Server business rules — deposit bonus, cancel window, payout,
   and lone-claim auto-settlement.

   Pure logic only: no database, no network, safe to run anywhere.
     node --test tests/
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bonusFor, BONUS_PER, BONUS_AMOUNT, BONUS_LABEL,
  cancelWindowOpen, CANCEL_WINDOW_MS, CLAIM_GRACE_MS,
  payoutFor, SETTINGS_DEFAULTS,
} from '../server/src/lib/config.js';
import { decideLoneClaim } from '../server/src/lib/settle-sweeper.js';

/* ---------------- deposit cashback: ₹50 per ₹5,000 ---------------- */

test('deposit bonus', async t => {
  await t.test('pays nothing below the ₹5,000 threshold', () => {
    for (const amount of [0, 1, 100, 999, 1000, 2500, 4999]) {
      assert.equal(bonusFor(amount), 0, `₹${amount} should earn no bonus`);
    }
  });

  await t.test('the old ₹50-per-₹1,000 rule is gone', () => {
    assert.equal(bonusFor(1000), 0);
    assert.equal(bonusFor(2000), 0);
    assert.equal(bonusFor(3000), 0);
  });

  await t.test('pays ₹50 at exactly ₹5,000', () => {
    assert.equal(bonusFor(5000), 50);
  });

  await t.test('pays per completed ₹5,000 block, never partial', () => {
    assert.equal(bonusFor(5001), 50);
    assert.equal(bonusFor(9999), 50);
    assert.equal(bonusFor(10000), 100);
    assert.equal(bonusFor(14999), 100);
    assert.equal(bonusFor(15000), 150);
  });

  await t.test('handles junk input without producing NaN', () => {
    for (const bad of [undefined, null, NaN, -5000, 'abc', {}]) {
      assert.equal(bonusFor(bad), 0, `${String(bad)} should be treated as no bonus`);
    }
  });

  await t.test('the ledger label names the live rule', () => {
    assert.equal(BONUS_PER, 5000);
    assert.equal(BONUS_AMOUNT, 50);
    assert.match(BONUS_LABEL, /₹50 per ₹5,000/);
  });
});

/* ---------------- cancel window: 1 minute after the room code ---------------- */

test('cancel window', async t => {
  const roomSetAt = 1_000_000;
  const created = roomSetAt - 60 * 60 * 1000;      // an hour earlier

  await t.test('is one minute long', () => {
    assert.equal(CANCEL_WINDOW_MS, 60 * 1000);
  });

  await t.test('open the instant the room code goes up', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt), true);
  });

  await t.test('still open just before the minute is up', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 59_999), true);
  });

  await t.test('open exactly on the boundary', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 60_000), true);
  });

  await t.test('closed one millisecond past the minute', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 60_001), false);
  });

  await t.test('closed well after', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 10 * 60_000), false);
  });

  await t.test('measures from the room code, not from battle creation', () => {
    // The battle is an hour old but the code just went up — still cancellable.
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 30_000), true);
  });

  await t.test('falls back to creation time when no room code was set', () => {
    assert.equal(cancelWindowOpen(null, created, created + 30_000), true);
    assert.equal(cancelWindowOpen(null, created, created + 61_000), false);
  });
});

/* ---------------- lone claim after the 10-minute grace ---------------- */

test('lone-claim settlement', async t => {
  const HOST = 11, GUEST = 22;

  await t.test('grace period is ten minutes', () => {
    assert.equal(CLAIM_GRACE_MS, 10 * 60 * 1000);
  });

  await t.test('a lone "won" from the host awards the host', () => {
    const d = decideLoneClaim('won', HOST, HOST, GUEST);
    assert.equal(d.action, 'award');
    assert.equal(d.winner, HOST);
    assert.equal(d.loser, GUEST);
  });

  await t.test('a lone "won" from the guest awards the guest', () => {
    const d = decideLoneClaim('won', GUEST, HOST, GUEST);
    assert.equal(d.action, 'award');
    assert.equal(d.winner, GUEST);
    assert.equal(d.loser, HOST);
  });

  await t.test('a lone "lost" awards the silent opponent', () => {
    assert.equal(decideLoneClaim('lost', HOST, HOST, GUEST).winner, GUEST);
    assert.equal(decideLoneClaim('lost', GUEST, HOST, GUEST).winner, HOST);
  });

  await t.test('a lone "cancel" refunds rather than awarding', () => {
    const d = decideLoneClaim('cancel', HOST, HOST, GUEST);
    assert.equal(d.action, 'refund');
    assert.equal(d.winner, null);
  });

  await t.test('an unknown claim is left for an admin, never auto-awarded', () => {
    for (const junk of ['draw', '', null, undefined]) {
      const d = decideLoneClaim(junk, HOST, HOST, GUEST);
      assert.equal(d.action, 'admin', `claim ${String(junk)} must not auto-settle`);
      assert.equal(d.winner, null);
    }
  });

  await t.test('a battle with no opponent cannot be auto-awarded', () => {
    const d = decideLoneClaim('lost', HOST, HOST, null);
    assert.equal(d.action, 'admin');
    assert.equal(d.winner, null);
  });
});

/* ---------------- payout ---------------- */

test('payout', async t => {
  await t.test('takes the commission off the doubled stake', () => {
    assert.equal(payoutFor(500, 0.05), 950);
    assert.equal(payoutFor(1000, 0.05), 1900);
    assert.equal(payoutFor(50, 0.05), 95);
  });

  await t.test('honours a changed commission', () => {
    assert.equal(payoutFor(500, 0), 1000);
    assert.equal(payoutFor(500, 0.10), 900);
  });

  await t.test('rounds to whole rupees', () => {
    assert.equal(Number.isInteger(payoutFor(55, 0.07)), true);
    assert.equal(Number.isInteger(payoutFor(333, 0.05)), true);
  });

  await t.test('never returns NaN when commission is missing', () => {
    // getSettings() now backfills, but the default must hold on its own.
    assert.equal(payoutFor(500), 950);
    assert.equal(Number.isFinite(payoutFor(500)), true);
  });
});

/* ---------------- settings fallbacks ---------------- */

test('settings defaults are complete and numeric', () => {
  for (const key of ['commission', 'referral_rate', 'battle_limit']) {
    assert.equal(typeof SETTINGS_DEFAULTS[key], 'number', `${key} must default to a number`);
    assert.equal(Number.isFinite(SETTINGS_DEFAULTS[key]), true);
  }
  assert.equal(SETTINGS_DEFAULTS.referral_rate, 0.01);
  assert.equal(SETTINGS_DEFAULTS.commission, 0.05);
  assert.ok(SETTINGS_DEFAULTS.battle_limit >= 1);
});
