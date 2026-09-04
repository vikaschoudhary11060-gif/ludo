/* ============================================================
   One-off data repairs, run once at startup.

   Each is written to be safe to run repeatedly: it only touches
   documents that still need it, so a restart is a no-op.
   ============================================================ */
import { col, nextId, now } from './db.js';

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

/* How many historical referral credits one boot will convert. The work is
   resumable — each run skips what is already recorded — so a long history
   catches up over a few restarts instead of holding the process at startup. */
const REFERRAL_BACKFILL_LIMIT = 5000;

/** Build the per-transfer referral ledger from the wallet ledger.

    Referral payouts have always written a wallet credit tagged with the
    battle id, but that row names only the referrer — never the player whose
    match paid for it. The admin console needs both ends, so settlement now
    writes a `referral_earnings` row per transfer. Everything paid before that
    shipped exists only as a credit, and without this the console's referral
    list would start empty on an account with months of history.

    The referee is recovered by asking which of the battle's two players was
    referred by the credited user. When one person referred both players there
    are two credits on the same battle from the same referrer, so referees are
    handed out one per credit rather than matched independently. */
export async function backfillReferralEarnings() {
  const credits = await col('transactions').find({
    type: 'credit', bucket: 'referral', ref_id: { $nin: [null, undefined] },
  }, { projection: { _id: 0, id: 1, user_id: 1, amount: 1, ref_id: 1, note: 1, created_at: 1 } })
    .sort({ created_at: 1 }).limit(REFERRAL_BACKFILL_LIMIT + 1).toArray();
  if (!credits.length) return { scanned: 0, written: 0, remaining: 0 };

  const remaining = Math.max(0, credits.length - REFERRAL_BACKFILL_LIMIT);
  const batch = credits.slice(0, REFERRAL_BACKFILL_LIMIT);

  /* Already-recorded transfers, keyed the same way they are written. Reading
     them up front keeps this to one query however many credits are scanned,
     and is what makes a second run a no-op. */
  const battleIds = [...new Set(batch.map(c => c.ref_id))];
  const existing = await col('referral_earnings').find(
    { battle_id: { $in: battleIds } },
    { projection: { _id: 0, battle_id: 1, referrer_id: 1 } }).toArray();
  const seen = new Map();                       // "battle|referrer" -> count already stored
  for (const e of existing) {
    const k = `${e.battle_id}|${e.referrer_id}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }

  const byBattle = new Map();
  for (const c of batch) {
    if (!byBattle.has(c.ref_id)) byBattle.set(c.ref_id, []);
    byBattle.get(c.ref_id).push(c);
  }

  const battles = await col('battles').find(
    { id: { $in: battleIds } },
    { projection: { _id: 0, id: 1, amount: 1, mode: 1, creator_id: 1, acceptor_id: 1 } }).toArray();
  const battleById = new Map(battles.map(b => [b.id, b]));

  const playerIds = [...new Set(battles.flatMap(b => [b.creator_id, b.acceptor_id]).filter(id => id != null))];
  const players = await col('users').find(
    { id: { $in: playerIds } },
    { projection: { _id: 0, id: 1, referred_by: 1 } }).toArray();
  const referrerOf = new Map(players.map(u => [u.id, u.referred_by ?? null]));

  const rows = [];
  for (const [battleId, group] of byBattle) {
    const b = battleById.get(battleId);
    if (!b) continue;                           // battle purged — nothing to attribute it to

    /* Which players on this battle each referrer could have been paid for.
       Consumed as they are used, so two credits from one referrer land on two
       different referees instead of both on the first. */
    const pool = [b.creator_id, b.acceptor_id]
      .filter(id => id != null && referrerOf.get(id) != null)
      .map(id => ({ id, referrer: referrerOf.get(id) }));

    // A battle that paid two referrers is a split-rate battle, then and now.
    const wasSplit = group.length > 1;

    for (const c of group) {
      const key = `${battleId}|${c.user_id}`;
      const already = seen.get(key) || 0;
      if (already > 0) { seen.set(key, already - 1); continue; }   // this credit is recorded

      const i = pool.findIndex(x => x.referrer === c.user_id);
      if (i < 0) continue;                      // referred_by has since changed — cannot attribute
      const [match] = pool.splice(i, 1);

      const stake = b.amount || 0;
      rows.push({
        referrer_id: c.user_id,
        referee_id: match.id,
        battle_id: battleId,
        mode: b.mode || null,
        stake,
        amount: c.amount || 0,
        // Reconstructed, not assumed: what this transfer actually paid out.
        rate: stake > 0 ? (c.amount || 0) / stake : 0,
        base_rate: null,
        split: wasSplit,
        source: 'backfill',
        created_at: c.created_at || now(),
      });
    }
  }

  let written = 0;
  for (const row of rows) {
    try {
      await col('referral_earnings').insertOne({ id: await nextId('referral_earnings'), ...row });
      written++;
    } catch (e) {
      console.error(`[backfill] referral transfer on battle ${row.battle_id} could not be written:`, e?.message);
    }
  }
  return { scanned: batch.length, written, remaining };
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

  try {
    const refs = await backfillReferralEarnings();
    if (refs.written) {
      console.log(`[backfill] recorded ${refs.written} historical referral transfer(s)` +
        (refs.remaining ? ` — ${refs.remaining}+ still to scan, continuing next restart` : ''));
    }
  } catch (e) {
    console.error('[backfill] referral transfers failed:', e?.stack || e);
  }
}
