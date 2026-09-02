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
  payoutFor, prizeFor, commissionFor, SETTINGS_DEFAULTS,
  COMMISSION_THRESHOLD, COMMISSION_UNDER, COMMISSION_FROM,
  cancelPlan, CANCEL_REASONS, CANCEL_REASON_IDS, cancelReasonLabel,
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

/* ---------------- cancel window: 10 minutes after the room code ---------------- */

test('cancel window', async t => {
  const roomSetAt = 1_000_000;
  const created = roomSetAt - 60 * 60 * 1000;      // an hour earlier
  const TEN_MIN = 10 * 60 * 1000;

  await t.test('is ten minutes long', () => {
    assert.equal(CANCEL_WINDOW_MS, TEN_MIN);
  });

  await t.test('open the instant the room code goes up', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt), true);
  });

  await t.test('still open just before the ten minutes are up', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + TEN_MIN - 1), true);
  });

  await t.test('open exactly on the boundary', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + TEN_MIN), true);
  });

  await t.test('closed one millisecond past the window', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + TEN_MIN + 1), false);
  });

  await t.test('closed well after', () => {
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 2 * TEN_MIN), false);
  });

  await t.test('measures from the room code, not from battle creation', () => {
    // The battle is an hour old but the code just went up — still cancellable.
    assert.equal(cancelWindowOpen(roomSetAt, created, roomSetAt + 30_000), true);
  });

  await t.test('falls back to creation time when no room code was set', () => {
    assert.equal(cancelWindowOpen(null, created, created + 30_000), true);
    assert.equal(cancelWindowOpen(null, created, created + TEN_MIN + 1_000), false);
  });
});

/* ---------------- lone claim after the 15-minute grace ---------------- */

test('lone-claim settlement', async t => {
  const HOST = 11, GUEST = 22;

  await t.test('grace period is fifteen minutes, as the rules promise', () => {
    // The rules screen renders this value; a mismatch would publish a window
    // the sweeper does not actually honour.
    assert.equal(CLAIM_GRACE_MS, 15 * 60 * 1000);
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
  await t.test('takes the commission off one stake, then pays the rest of the pot', () => {
    // pot − (rate × one stake), which is what the player is quoted.
    assert.equal(payoutFor(500, 0.05), 975);    // 1000 − 25
    assert.equal(payoutFor(1000, 0.05), 1950);  // 2000 − 50
    assert.equal(payoutFor(50, 0.05), 98);      // 100 − 2.5, rounded
  });

  await t.test('honours a changed commission', () => {
    assert.equal(payoutFor(500, 0), 1000);
    // 10% of ONE ₹500 stake is ₹50, so the winner takes ₹950 of the ₹1,000 pot.
    assert.equal(payoutFor(500, 0.10), 950);
  });

  await t.test('rounds to whole rupees', () => {
    assert.equal(Number.isInteger(payoutFor(55, 0.07)), true);
    assert.equal(Number.isInteger(payoutFor(333, 0.05)), true);
  });

  await t.test('never returns NaN when no rate is given', () => {
    // Bare payoutFor falls back to the standard tier rate, not the legacy flat one.
    assert.equal(payoutFor(500), payoutFor(500, COMMISSION_FROM));
    assert.equal(Number.isFinite(payoutFor(500)), true);
    assert.ok(payoutFor(500) > 0 && payoutFor(500) <= 1000);
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

/* ---------------- tiered commission ---------------- */

test('commission tiers', async t => {
  /* The published rule: "50 से 500 तक — 5%", "500 से ज्यादा — 3%". The
     threshold sits on the HIGHER side, so ₹500 pays 5% and it takes ₹501 to
     reach 3%. That boundary is the whole point of these tests. */

  await t.test('a stake up to the threshold takes the higher rate', () => {
    for (const amount of [50, 100, 250, 499]) {
      assert.equal(commissionFor(amount, {}), 0.08, `₹${amount} should be 8%`);
    }
  });

  await t.test('the threshold itself takes the HIGHER rate', () => {
    // "50 to 500" includes 500. Flipping this comparison is a silent 2%
    // giveaway on the single most common stake on the board.
    assert.equal(commissionFor(500, {}), 0.08);
  });

  await t.test('one rupee past the threshold takes the lower rate', () => {
    for (const amount of [501, 1000, 25000, 100000]) {
      assert.equal(commissionFor(amount, {}), 0.05, `₹${amount} should be 5%`);
    }
  });

  await t.test('the constants match the tiers', () => {
    assert.equal(COMMISSION_THRESHOLD, 500);
    assert.equal(COMMISSION_UNDER, 0.08);
    assert.equal(COMMISSION_FROM, 0.05);
  });

  await t.test('the defaults match the constants', () => {
    assert.equal(SETTINGS_DEFAULTS.commission_threshold, COMMISSION_THRESHOLD);
    assert.equal(SETTINGS_DEFAULTS.commission_under, COMMISSION_UNDER);
    assert.equal(SETTINGS_DEFAULTS.commission_from, COMMISSION_FROM);
  });

  await t.test('settings override the built-in tiers, boundary included', () => {
    const s = { commission_threshold: 1000, commission_under: 0.09, commission_from: 0.01 };
    assert.equal(commissionFor(999, s), 0.09);
    assert.equal(commissionFor(1000, s), 0.09, 'the threshold belongs to the higher tier');
    assert.equal(commissionFor(1001, s), 0.01);
  });

  await t.test('nonsense settings fall back rather than producing NaN', () => {
    for (const bad of [{ commission_under: 'x' }, { commission_under: NaN },
                       { commission_under: -1 }, { commission_under: 2 }, {}]) {
      assert.equal(commissionFor(100, bad), 0.08, JSON.stringify(bad));
    }
    assert.equal(commissionFor(100, { commission_threshold: 'x' }), 0.08);
  });
});

test('prize at each tier', async t => {
  await t.test('charges the rate on one stake, not on the pot', () => {
    /* The rule as a player is quoted it: "you bet ₹500, we take 8%". So the
       house takes ₹40 from the ₹1,000 pot, not ₹80. */
    assert.equal(prizeFor(100, {}), 192);      // pot 200, 8% of 100 = 8
    assert.equal(prizeFor(499, {}), 958);      // pot 998, 8% of 499 = 40
    assert.equal(prizeFor(500, {}), 960);      // pot 1000, 8% of 500 = 40
    assert.equal(prizeFor(501, {}), 977);      // pot 1002, 5% of 501 = 25
    assert.equal(prizeFor(1000, {}), 1950);    // pot 2000, 5% of 1000 = 50
  });

  await t.test('the two ways of stating the same commission agree', () => {
    /* The rules quote a percentage of the player's own bet — 8% up to ₹500,
       5% above. The same money described against the whole pot is 4% and
       2.5%, because a pot is exactly two equal stakes. Both readings are
       written down here: if either drifts, the house is taking a different
       amount from the one somebody was promised. */
    const cases = [
      // stake, of-one-stake, of-the-whole-pot
      [50,   0.08, 0.04],
      [100,  0.08, 0.04],
      [500,  0.08, 0.04],
      [501,  0.05, 0.025],
      [1000, 0.05, 0.025],
      [5000, 0.05, 0.025],
    ];
    for (const [stake, ofStake, ofPot] of cases) {
      const pot = stake * 2;
      const taken = pot - prizeFor(stake, {});
      assert.equal(taken, Math.round(stake * ofStake),
        `₹${stake}: took ₹${taken}, not ${ofStake * 100}% of the one stake`);
      assert.equal(taken, Math.round(pot * ofPot),
        `₹${stake}: took ₹${taken}, not ${ofPot * 100}% of the ₹${pot} pot`);
    }
  });

  await t.test('the quoted rate is always double the pot rate', () => {
    // The identity that makes both statements true at once. It holds for any
    // rate the admin sets, not just the two defaults.
    for (const rate of [0.02, 0.05, 0.08, 0.1, 0.25]) {
      const stake = 1000, pot = stake * 2;
      const taken = pot - payoutFor(stake, rate);
      assert.equal(taken / pot, rate / 2,
        `${rate * 100}% of a stake should be ${rate * 50}% of the pot`);
    }
  });

  await t.test('the house take is exactly the quoted rate on one stake', () => {
    for (const amount of [50, 100, 499, 500, 501, 1000, 25000]) {
      const taken = amount * 2 - prizeFor(amount, {});
      assert.equal(taken, Math.round(amount * commissionFor(amount, {})),
        `₹${amount}: the house took ${taken}, not the quoted rate on one stake`);
    }
  });

  await t.test('crossing the threshold never pays less for a bigger stake', () => {
    let previous = 0;
    for (let amount = 50; amount <= 2000; amount += 1) {
      const prize = prizeFor(amount, {});
      assert.ok(prize >= previous, `₹${amount} pays ${prize}, less than ₹${amount - 1} paid ${previous}`);
      previous = prize;
    }
  });

  await t.test('the house never pays out more than the pot', () => {
    for (const amount of [50, 499, 500, 1000, 100000]) {
      assert.ok(prizeFor(amount, {}) <= amount * 2, `₹${amount} pays more than both stakes`);
    }
  });

  await t.test('whole rupees only', () => {
    for (const amount of [55, 333, 777, 1234]) {
      assert.equal(Number.isInteger(prizeFor(amount, {})), true);
    }
  });

  await t.test('payoutFor still takes an explicit rate', () => {
    assert.equal(payoutFor(500, 0.08), 960);
    assert.equal(payoutFor(500, 0), 1000);
  });
});

/* ---------------- cancelling ---------------- */

test('who may cancel, and who gets refunded', async t => {
  const HOST = 1, GUEST = 2;
  const asHost  = { isCreator: true,  isAcceptor: false, creatorId: HOST, acceptorId: GUEST };
  const asGuest = { isCreator: false, isAcceptor: true,  creatorId: HOST, acceptorId: GUEST };

  await t.test('before anyone joins, only the host cancels and only the host is refunded', () => {
    const p = cancelPlan('open', { ...asHost, acceptorId: null });
    assert.equal(p.allowed, true);
    assert.deepEqual(p.refund, [HOST], 'the opponent has not staked yet');
  });

  await t.test('a pending request is still the host\'s to cancel', () => {
    const p = cancelPlan('requested', asHost);
    assert.equal(p.allowed, true);
    assert.deepEqual(p.refund, [HOST], 'the requester is only debited once accepted');
  });

  await t.test('a would-be opponent cannot cancel the host\'s battle', () => {
    const p = cancelPlan('open', asGuest);
    assert.equal(p.allowed, false);
    assert.equal(p.error, 'HOSTONLY');
  });

  await t.test('with no room code, EITHER player can call it off', () => {
    for (const who of [asHost, asGuest]) {
      const p = cancelPlan('waiting', who);
      assert.equal(p.allowed, true, 'a stuck battle must not trap a stake');
      assert.deepEqual(p.refund, [HOST, GUEST], 'both staked, so both are refunded');
    }
  });

  await t.test('once the room code is up, neither can cancel from the list', () => {
    for (const status of ['running', 'completed', 'cancelled', 'disputed']) {
      for (const who of [asHost, asGuest]) {
        const p = cancelPlan(status, who);
        assert.equal(p.allowed, false, `${status} must not be cancellable`);
        assert.equal(p.error, 'CLOSED');
      }
    }
  });

  await t.test('a stranger is refused outright', () => {
    const p = cancelPlan('waiting', { isCreator: false, isAcceptor: false, creatorId: HOST, acceptorId: GUEST });
    assert.equal(p.allowed, false);
    assert.equal(p.error, 'FORBIDDEN');
  });

  await t.test('a refund list never contains a missing player', () => {
    const p = cancelPlan('waiting', { isCreator: true, isAcceptor: false, creatorId: HOST, acceptorId: null });
    assert.deepEqual(p.refund, [HOST]);
  });
});

test('cancel reasons', async t => {
  await t.test('every reason has an id and a label', () => {
    assert.ok(CANCEL_REASONS.length >= 3);
    for (const r of CANCEL_REASONS) {
      assert.equal(typeof r.id, 'string');
      assert.ok(r.id.length > 0 && r.label.length > 0);
    }
  });

  await t.test('ids are unique', () => {
    assert.equal(new Set(CANCEL_REASON_IDS).size, CANCEL_REASON_IDS.length);
  });

  await t.test('covers the stuck-battle case the rules depend on', () => {
    assert.ok(CANCEL_REASON_IDS.includes('no_room'), 'players need a way to say the code never came');
  });

  await t.test('an unknown id reads back as a sentence, not undefined', () => {
    assert.equal(cancelReasonLabel('no_room'), 'Host never shared the room code');
    assert.equal(cancelReasonLabel('nonsense'), 'No reason given');
    assert.equal(cancelReasonLabel(undefined), 'No reason given');
  });
});
