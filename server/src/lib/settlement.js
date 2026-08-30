/* ============================================================
   Settlement rules shared by every path that pays out a battle:
   the live result route, an admin resolving a dispute, and the
   sweeper settling an unanswered claim.

   Keeping one copy matters — the referral rate has already
   changed once, and three divergent copies would pay different
   amounts depending on which path happened to settle the battle.
   ============================================================ */
import { col, credit } from './db.js';

/** Pay both players' referrers their cut of a settled battle.
    `source` labels the ledger entry ('battle' or 'dispute').
    Appends [userId, title, body] notification tuples to `notes`. */
export async function payReferralCuts(session, battle, settings, notes = [], source = 'battle') {
  const rate = settings?.referral_rate;
  const cut = Math.round(battle.amount * (Number.isFinite(rate) ? rate : 0.01));
  if (cut <= 0) return notes;

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

  for (const u of players) {
    if (!u?.referred_by) continue;
    await credit(u.referred_by, 'referral', cut,
      `Referral bonus — ${label}`, battle.id, 'success', session);
    await col('referrals').updateOne(
      { referrer_id: u.referred_by, referee_id: u.id }, { $inc: { earned: cut } }, { session });
    notes.push([u.referred_by, 'Referral bonus earned! 💰',
      `You earned ₹${cut} from ${u.name || 'your referral'}'s match.`]);
  }
  return notes;
}
