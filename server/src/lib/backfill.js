/* ============================================================
   One-off data repairs, run once at startup.

   Each is written to be safe to run repeatedly: it only touches
   documents that still need it, so a restart is a no-op.
   ============================================================ */
import { col } from './db.js';

/** Statuses where a stake is still held and could yet be refunded. */
const UNSETTLED = ['open', 'requested', 'waiting', 'running', 'disputed'];

/** Reconstruct the stake split for battles created before it was recorded.

    Refunds return money to the buckets it came from, which needs the split
    stored on the battle. Battles already in flight when that shipped have no
    split, so they would fall back to refunding everything to deposit — the
    exact bucket-converting behaviour the change exists to stop.

    The ledger already holds the answer: staking writes one debit row per
    bucket tagged with the battle id, so the split can be rebuilt from it. */
export async function backfillStakeSplits() {
  const battles = await col('battles').find(
    { status: { $in: UNSETTLED }, creator_stake: { $in: [null, undefined] } },
    { projection: { _id: 0, id: 1, amount: 1, creator_id: 1, acceptor_id: 1 } },
  ).toArray();
  if (!battles.length) return { scanned: 0, repaired: 0 };

  let repaired = 0;
  for (const b of battles) {
    try {
      const rows = await col('transactions').find({
        ref_id: b.id, type: 'debit', bucket: { $in: ['deposit', 'winnings'] },
      }, { projection: { _id: 0, user_id: 1, bucket: 1, amount: 1 } }).toArray();
      if (!rows.length) continue;                 // nothing to rebuild from

      const splitFor = uid => {
        const mine = rows.filter(r => r.user_id === uid);
        if (!mine.length) return null;
        const split = { deposit: 0, winnings: 0 };
        for (const r of mine) split[r.bucket] += r.amount;
        // Only trust a split that accounts for the whole stake.
        return split.deposit + split.winnings === b.amount ? split : null;
      };

      const $set = {};
      const creator = splitFor(b.creator_id);
      if (creator) $set.creator_stake = creator;
      const acceptor = b.acceptor_id != null ? splitFor(b.acceptor_id) : null;
      if (acceptor) $set.acceptor_stake = acceptor;
      if (!Object.keys($set).length) continue;

      await col('battles').updateOne({ id: b.id }, { $set });
      repaired++;
    } catch (e) {
      // One unrepairable battle must not stop the rest, or block startup.
      console.error(`[backfill] battle ${b.id} could not be repaired:`, e?.message);
    }
  }
  return { scanned: battles.length, repaired };
}

/** Run every repair. Never throws — a failed backfill must not block boot. */
export async function runBackfills() {
  try {
    const stakes = await backfillStakeSplits();
    if (stakes.repaired) {
      console.log(`[backfill] rebuilt the stake split on ${stakes.repaired}/${stakes.scanned} unsettled battle(s)`);
    }
  } catch (e) {
    console.error('[backfill] stake splits failed:', e?.stack || e);
  }
}
