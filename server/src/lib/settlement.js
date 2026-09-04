/* ============================================================
   Settlement rules shared by every path that pays out a battle:
   the live result route, an admin resolving a dispute, and the
   sweeper settling an unanswered claim.

   Keeping one copy matters — the referral rate has already
   changed once, and three divergent copies would pay different
   amounts depending on which path happened to settle the battle.
   ============================================================ */
import { col, credit, nextId, now } from './db.js';

/** Which field on the battle holds a player's recorded stake split. */
const stakeField = (battle, userId) =>
  battle.creator_id === userId ? 'creator_stake'
  : battle.acceptor_id === userId ? 'acceptor_stake'
  : null;

/** Is this a split we can actually pay out against? */
const usable = (split, amount) => {
  const d = Number(split?.deposit), w = Number(split?.winnings);
  return Number.isFinite(d) && Number.isFinite(w) && d >= 0 && w >= 0 && d + w === amount;
};

/** Rebuild a player's split from the ledger.

    Staking writes one debit row per bucket tagged with the battle id, so the
    answer is already recorded even when the battle document does not carry it
    — every battle created before the split was stored, and anything the
    startup backfill did not reach. Reconstructing here rather than trusting
    the document is what makes the deposit-only fallback genuinely last
    resort, instead of the path every legacy battle takes. */
async function splitFromLedger(session, battleId, userId, amount) {
  const rows = await col('transactions').find(
    { ref_id: battleId, user_id: userId, type: 'debit', bucket: { $in: ['deposit', 'winnings'] } },
    { projection: { _id: 0, bucket: 1, amount: 1 }, ...(session ? { session } : {}) },
  ).toArray();
  if (!rows.length) return null;
  const split = { deposit: 0, winnings: 0 };
  for (const r of rows) split[r.bucket] += Number(r.amount) || 0;
  // Only trust a reconstruction that accounts for the whole stake.
  return usable(split, amount) ? split : null;
}

/** Give a player's stake back to the buckets it was taken from.

    A ₹500 stake paid as ₹400 deposit + ₹100 winnings must come back the same
    way. Refunding the lot to deposit turned withdrawable winnings into
    play-only balance every time a battle was called off.

    Battles created before the split was recorded have no `*_stake` field; for
    those the old behaviour is the only option, so the whole amount goes to
    deposit and the note says so. */
export async function refundStake(session, battle, userId, note) {
  /* A missing player is not a player to refund. Without this, `userId` of
     null matches `battle.acceptor_id === null` in stakeField(), finds no
     recorded split, and falls through to crediting the full stake to a wallet
     keyed on null — money conjured out of a battle nobody joined. Throwing
     aborts the surrounding transaction, which is the safe direction. */
  if (!Number.isInteger(userId))
    throw new Error(`refundStake() refused a non-player id (${userId}) on battle ${battle?.id}`);

  const amount = battle.amount;
  const field = stakeField(battle, userId);
  const recorded = field ? battle[field] : null;

  /* Two sources, in order of directness: what the battle recorded when the
     stake was taken, then what the ledger says was actually debited. The
     second matters because every battle created before the split was stored
     has nothing on the document — which is most of them, right after this
     ships. Falling straight through to "all of it to deposit" for those is
     precisely the bug this function exists to stop. */
  let split = usable(recorded, amount) ? recorded : null;
  let source = 'battle';
  if (!split) {
    split = await splitFromLedger(session, battle.id, userId, amount);
    source = 'ledger';
  }

  if (!split) {
    /* Say so. Falling back is the safe direction — the player is never left
       short — but doing it quietly would hide a systematic mismatch, with
       every affected refund reverting to the old bucket-converting behaviour
       and nothing in the logs to show it. */
    console.warn(`[refund] battle ${battle.id}: no usable stake split for user ${userId}` +
      `${recorded ? ` (recorded ${JSON.stringify(recorded)} against ₹${amount})` : ''}` +
      ' and none reconstructable from the ledger — refunding the full amount to deposit');
    await credit(userId, 'deposit', amount, note, battle.id, 'success', session);
    return { deposit: amount, winnings: 0, recorded: false, source: 'fallback' };
  }

  if (split.deposit > 0) await credit(userId, 'deposit', split.deposit, note, battle.id, 'success', session);
  if (split.winnings > 0) await credit(userId, 'winnings', split.winnings, note, battle.id, 'success', session);
  return { deposit: split.deposit, winnings: split.winnings, recorded: true, source };
}

/** The referral rate that actually applies to one settled battle.

    A referrer normally earns `referral_rate` of the stake. When BOTH players
    arrived through a referral the per-battle referral budget is split rather
    than doubled — each referrer earns half the rate, so the house pays the
    same 1% of the stake whether one player was referred or both.

    Exported and pure so the rule is stated once and can be tested directly:
    the admin console quotes it, and the settlement path pays it. */
export function referralRateFor(baseRate, referredPlayers) {
  const rate = Number.isFinite(baseRate) ? baseRate : 0.01;
  if (rate <= 0) return 0;
  return referredPlayers > 1 ? rate / 2 : rate;
}

/** Pay both players' referrers their cut of a settled battle.
    `source` labels the ledger entry — 'battle' for a live settlement or an
    auto-settlement by the sweeper, 'dispute' for one an admin resolved.
    Appends [userId, title, body] notification tuples to `notes`. */
export async function payReferralCuts(session, battle, settings, notes = [], source = 'battle') {
  const baseRate = Number.isFinite(settings?.referral_rate) ? settings.referral_rate : 0.01;
  /* Cheap exit before any query: a switched-off referral programme has
     nothing to look up. */
  if (baseRate <= 0) return notes;

  /* `source` keeps each caller's own ledger wording — an admin-resolved
     dispute stayed distinguishable from an automatic settlement, and anyone
     reconciling by note relies on that. */
  const label = `${source} #${String(battle.id).slice(-5)}`;
  const ids = [battle.creator_id, battle.acceptor_id].filter(id => id != null);
  if (!ids.length) return notes;

  // Both players in one query rather than a round trip each, since this runs
  // inside the settlement transaction and holds its locks for the duration.
  const players = await col('users')
    .find({ id: { $in: ids } }, { session, projection: { _id: 0, id: 1, name: 1, referred_by: 1 } })
    .toArray();

  /* Who this battle actually pays for. Counted before anything is credited,
     because the count is what decides the rate — working it out per player
     inside the loop would pay the first referrer the full rate and the second
     a half. */
  const earning = players.filter(u => u?.referred_by != null);
  if (!earning.length) return notes;

  const split = earning.length > 1;
  const rate = referralRateFor(baseRate, earning.length);
  const cut = Math.round(battle.amount * rate);
  if (cut <= 0) return notes;

  for (const u of earning) {
    await credit(u.referred_by, 'referral', cut,
      `Referral bonus — ${label}`, battle.id, 'success', session);
    await col('referrals').updateOne(
      { referrer_id: u.referred_by, referee_id: u.id }, { $inc: { earned: cut } }, { session });

    /* A dedicated row per transfer, so the admin console can show which game
       paid which referrer for which player. The wallet credit alone cannot
       answer that: its ledger row names the referrer and the battle but never
       the referee, and deriving the referee from `users.referred_by` breaks
       the moment that field is edited. */
    await col('referral_earnings').insertOne({
      id: await nextId('referral_earnings'),
      referrer_id: u.referred_by,
      referee_id: u.id,
      battle_id: battle.id,
      mode: battle.mode || null,
      stake: battle.amount,
      amount: cut,
      rate,
      base_rate: baseRate,
      split,                      // true when both players were referred
      source,                     // battle | dispute | sweeper
      created_at: now(),
    }, session ? { session } : undefined);

    notes.push([u.referred_by, 'Referral bonus earned! 💰',
      `You earned ₹${cut} from ${u.name || 'your referral'}'s match.`]);
  }
  return notes;
}
