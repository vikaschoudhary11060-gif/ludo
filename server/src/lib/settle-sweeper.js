/* ============================================================
   Settlement sweeper.

   When one player reports a result and the other stays silent, the
   battle is parked in `disputed` with an `auto_settle_at` stamp ten
   minutes out. This job settles those on the lone claim once the
   grace period lapses, so a stake is never locked up by an opponent
   who simply walked away.

   Battles where BOTH players reported and disagreed carry no
   `auto_settle_at` — those are real conflicts and stay for an admin.
   ============================================================ */
import { col, now, credit, notify, getSettings, withTransaction } from './db.js';
import { prizeFor, GRACE_LABEL } from './config.js';
import { payReferralCuts } from './settlement.js';
import { shape } from './battle-view.js';

const TICK_MS = 30 * 1000;
const BATCH = 25;
/* A battle that fails this many sweeps is parked for an admin instead of being
   retried forever. */
const MAX_ATTEMPTS = 3;

/** The battle as it now stands after a settling write. `auto_settle_at` is
    removed rather than nulled, so this matches what the write actually did. */
function settledDoc(b, patch) {
  const doc = { ...b, ...patch };
  delete doc.auto_settle_at;
  return doc;
}

/** What a single unanswered claim resolves to.
    'won'  -> the claimant takes it
    'lost' -> the opponent takes it
    'cancel' -> both stakes refunded
    Anything without a decidable winner goes to an admin instead. */
export function decideLoneClaim(claim, claimantId, creatorId, acceptorId) {
  if (claim === 'cancel') return { action: 'refund', winner: null };
  // A battle with only one side never had two stakes, so there is no pot to
  // award — whatever the claim says, that is for a human to look at.
  if (!creatorId || !acceptorId) return { action: 'admin', winner: null };
  const opponent = claimantId === creatorId ? acceptorId : creatorId;
  const winner = claim === 'won' ? claimantId : claim === 'lost' ? opponent : null;
  if (!winner) return { action: 'admin', winner: null };
  return { action: 'award', winner, loser: winner === creatorId ? acceptorId : creatorId };
}

/** Settle one battle on its single unanswered claim.
    Returns { state, battle? } — the battle doc reflects the write we made, so
    callers can broadcast it without re-reading. */
async function settleOne(battleId, settings) {
  const notes = [];

  const outcome = await withTransaction(async session => {
    // Cleared per attempt: withTransaction re-runs this on a write conflict.
    notes.length = 0;
    const b = await col('battles').findOne({ id: battleId }, { session });
    // Re-check under the transaction: a late opponent claim may have settled
    // this between the query and now.
    if (!b || b.status !== 'disputed' || !b.auto_settle_at) return { state: 'skipped' };
    if (b.auto_settle_at > now()) return { state: 'not-due' };

    /* Compare-and-swap on the exact state this decision was made from. Every
       write below carries it, so the sweeper can never act on a battle that
       moved underneath it — the same guarded-transition rule the battle routes
       follow, rather than relying on write-conflict detection alone. */
    const guard = { id: battleId, status: 'disputed', auto_settle_at: b.auto_settle_at };
    const claim = async $set => {
      const r = await col('battles').updateOne(guard,
        { ...($set ? { $set } : {}), $unset: { auto_settle_at: '' } }, { session });
      return r.matchedCount === 1;
    };

    const claims = await col('battle_claims').find({ battle_id: battleId }, { session }).toArray();

    if (claims.length !== 1) {
      // Both sides reported (a genuine conflict) or neither did. Either way
      // this is not something to decide automatically.
      if (!await claim(null)) return { state: 'skipped' };
      return { state: 'left-for-admin' };
    }

    const [only] = claims;
    const decision = decideLoneClaim(only.claim, only.user_id, b.creator_id, b.acceptor_id);

    if (decision.action === 'refund') {
      // Claim the transition before any money moves, so a lost race refunds nothing.
      const settledAt = now();
      if (!await claim({ status: 'cancelled', settled_at: settledAt })) return { state: 'skipped' };
      for (const uid of [b.creator_id, b.acceptor_id]) {
        if (!uid) continue;
        await credit(uid, 'deposit', b.amount, 'Battle cancelled — refund', b.id, 'success', session);
        notes.push([uid, 'Battle cancelled', 'Your stake was refunded — your opponent never reported.']);
      }
      return { state: 'cancelled',
               battle: settledDoc(b, { status: 'cancelled', settled_at: settledAt }) };
    }

    const winner = decision.winner;
    if (decision.action !== 'award' || !winner) {
      if (!await claim(null)) return { state: 'skipped' };
      return { state: 'left-for-admin' };
    }

    const payout = prizeFor(b.amount, settings);
    const settledAt = now();
    if (!await claim({ status: 'completed', winner_id: winner, payout, settled_at: settledAt }))
      return { state: 'skipped' };
    await credit(winner, 'winnings', payout,
      `Battle won — #${String(b.id).slice(-5)}`, b.id, 'success', session);

    notes.push([winner, 'You won!',
      `₹${payout} credited — your opponent did not report within ${GRACE_LABEL}.`]);
    const loser = winner === b.creator_id ? b.acceptor_id : b.creator_id;
    if (loser) notes.push([loser, 'Battle settled',
      'You did not report a result in time, so your opponent’s report stands.']);

    await payReferralCuts(session, b, settings, notes);
    return { state: 'completed', winner, payout,
             battle: settledDoc(b, { status: 'completed', winner_id: winner, payout,
                                     settled_at: settledAt }) };
  });

  for (const [uid, title, body] of notes) {
    try { await notify(uid, title, body); } catch (e) { console.error('[sweeper] notify failed', e?.message); }
  }
  return outcome;
}

/* Broadcast a settled battle to its room, in the same shape the routes emit.

   The battle document is already in hand from the transaction, so only the two
   display names are missing — one users lookup, rather than re-running the
   full two-$lookup aggregation. The room admits only the two players, so the
   payload is shaped for a participant and keeps the room code they can see. */
async function emitSettled(io, b) {
  const ids = [b.creator_id, b.acceptor_id].filter(id => id != null);
  const users = ids.length
    ? await col('users').find({ id: { $in: ids } }, { projection: { _id: 0, id: 1, name: 1 } }).toArray()
    : [];
  const nameOf = Object.fromEntries(users.map(u => [u.id, u.name]));
  const doc = { ...b, creator_name: nameOf[b.creator_id], acceptor_name: nameOf[b.acceptor_id] };
  io.to(`battle:${b.id}`).emit('battle:updated', shape(doc, doc.creator_id));
}

/** Find every battle whose grace period has lapsed and settle it. */
export async function runSettlementSweep(app) {
  const due = await col('battles')
    .find({ status: 'disputed', auto_settle_at: { $lte: now() } }, { projection: { _id: 0, id: 1 } })
    // Oldest first: the battle that has been waiting longest settles first, and
    // a backlog larger than BATCH drains in order instead of arbitrarily.
    .sort({ auto_settle_at: 1 })
    .limit(BATCH).toArray();
  if (!due.length) return [];

  // Settings cannot meaningfully change mid-sweep, so read the single document
  // once rather than once per battle.
  const settings = await getSettings();
  const results = [];
  const broadcasts = [];
  for (const { id } of due) {
    try {
      const outcome = await settleOne(id, settings);
      results.push({ id, ...outcome });
      if (outcome?.state === 'completed' || outcome?.state === 'cancelled') {
        console.log(`[sweeper] battle ${id} auto-settled: ${outcome.state}`);
        // Queue the broadcast: settling the next battle must not wait on it.
        if (outcome.battle) broadcasts.push(outcome.battle);
      }
    } catch (e) {
      // One bad battle must not stop the rest, and must never crash the server.
      console.error(`[sweeper] battle ${id} failed:`, e?.stack || e);
      const attempts = await recordFailure(id);
      results.push({ id, state: 'error', attempts, error: e?.message });
    }
  }

  const io = app?.get?.('io');
  if (io) {
    for (const b of broadcasts) {
      try { await emitSettled(io, b); }
      catch (e) { console.error(`[sweeper] broadcast for ${b.id} failed:`, e?.message); }
    }
  }
  return results;
}

/** Count a failed settlement and, once it has failed enough times, stop
    sweeping it. Without this a battle that always throws is retried every
    tick forever and occupies a slot other battles need. */
async function recordFailure(battleId) {
  const after = await col('battles').findOneAndUpdate(
    { id: battleId },
    { $inc: { settle_attempts: 1 } },
    { returnDocument: 'after' });
  const attempts = after?.settle_attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) {
    // Stays `disputed` so an admin still sees it — it just stops auto-settling.
    await col('battles').updateOne({ id: battleId }, { $unset: { auto_settle_at: '' } });
    console.error(`[sweeper] battle ${battleId} failed ${attempts}x — parked for an admin`);
  }
  return attempts;
}

export function startSettlementSweeper(app, intervalMs = TICK_MS) {
  /* A slow sweep must not have the next one start on top of it: overlapping
     runs contend on the same battle documents and compound under load. */
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runSettlementSweep(app); }
    catch (e) { console.error('[sweeper] sweep failed:', e?.stack || e); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();                       // never hold the process open
  const bootTimer = setTimeout(tick, 5000);   // one pass shortly after boot
  bootTimer.unref?.();
  console.log(`[sweeper] settlement sweeper running every ${Math.round(intervalMs / 1000)}s`);
  // Stopping must cancel the boot pass too, or a sweep fires after shutdown.
  return () => { clearInterval(timer); clearTimeout(bootTimer); };
}
