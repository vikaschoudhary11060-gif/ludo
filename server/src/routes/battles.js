/* Battles — create, list, accept, cancel, room code, result claims (MongoDB).

   Two-sided settlement: each player files a claim; agreement settles the
   battle, conflict marks it disputed for an admin. Money moves inside Mongo
   transactions; notifications are sent after commit. */
import express from 'express';
import { SafeRouter } from '../lib/safe-router.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { col, now, credit, debit, spendable, notify, getSettings, getWallet, withTransaction } from '../lib/db.js';
import { requireAuth, optionalAuth } from '../lib/auth.js';
import { MODES, CLAIM_GRACE_MS, GRACE_LABEL, CANCEL_LABEL, cancelWindowOpen, prizeFor,
         CANCEL_REASON_IDS, cancelReasonLabel, cancelPlan } from '../lib/config.js';
import { payReferralCuts, refundStake } from '../lib/settlement.js';
import { isPlayer, shape, fetchBattles, fetchBattle } from '../lib/battle-view.js';

const router = SafeRouter();
const newId = () => crypto.randomBytes(6).toString('hex');


/* Tell everyone who has a stake in a battle that it changed, wherever they are.

   Emitting only to `battle:<id>` reached the two detail pages and nobody else,
   so a player sitting on the lobby had to refresh to see the other side cancel,
   accept or reject.

   Each recipient is shaped for themselves rather than sharing one payload:
   shape() redacts by viewer, and broadcasting one person's view to another is
   how a redaction quietly stops redacting.

   `also` carries players the battle no longer names — a rejected or withdrawn
   opponent has already been cleared off the document by the time we emit, and
   they are exactly the person who needs to hear about it. */
function emitBattle(req, b, also = []) {
  const io = req.app.get('io');
  if (!io || !b) return;
  const recipients = new Set(
    [b.creator_id, b.acceptor_id, ...also].filter(uid => uid != null));
  for (const uid of recipients) {
    // Every socket in `battle:<id>` is a participant (battle:watch enforces it)
    // and so is already in its own user room — no separate room emit needed.
    io.to(`user:${uid}`).emit('battle:updated', shape(b, uid));
  }
}

/* GET /api/battles?mode=lite&status=open */
router.get('/', optionalAuth, async (req, res) => {
  const mode = MODES[req.query.mode] ? req.query.mode : 'lite';
  const status = ['open', 'requested', 'waiting', 'running'].includes(req.query.status) ? req.query.status : null;
  const match = { mode, status: status ? status : { $in: ['open', 'requested', 'waiting', 'running'] } };
  if (status === 'open' || !status) match.is_bot = { $ne: true };
  const rows = await fetchBattles(match, 100);
  res.json({ battles: rows.map(b => shape(b, req.user?.id ?? null)) });
});

/* GET /api/battles/mine */
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await fetchBattles({ $or: [{ creator_id: req.user.id }, { acceptor_id: req.user.id }] }, 200);
  res.json({ battles: rows.map(b => shape(b, req.user.id)) });
});

/* GET /api/battles/history

   The player's own games with the wallet balance before and after each one.

   The balances are reconstructed backwards from the wallet as it stands now
   rather than forwards from zero: walking forwards needs every transaction
   the account has ever had to be correct, while walking backwards is exact
   for the recent rows and simply runs out for the oldest — which is the right
   direction to be wrong in, since those are the rows nobody scrolls to.

   Must stay above `/:id`, or Express matches "history" as a battle id. */
router.get('/history', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const TX_WINDOW = 2000;

  const [rows, wallet] = await Promise.all([
    fetchBattles({ $or: [{ creator_id: uid }, { acceptor_id: uid }] }, 200),
    getWallet(uid),
  ]);

  /* Only the two spendable buckets: `referral` is not part of the balance the
     player sees. `failed` rows are excluded because a rejected withdrawal is
     reversed by re-crediting the wallet and marking its debit failed — no
     second row is written, so counting it would double the reversal. This is
     the same rule /admin/reconcile uses. */
  const txs = await col('transactions').find(
    { user_id: uid, bucket: { $in: ['deposit', 'winnings'] }, status: { $ne: 'failed' } },
    { projection: { _id: 0, id: 1, type: 1, amount: 1, ref_id: 1, created_at: 1 } },
  ).sort({ created_at: -1, id: -1 }).limit(TX_WINDOW).toArray();

  const balances = new Map();          // battle id -> { opening, closing }
  let running = wallet.deposit + wallet.winnings;
  for (const tx of txs) {
    const after = running;
    const before = tx.type === 'credit' ? after - tx.amount : after + tx.amount;
    if (tx.ref_id != null) {
      const seen = balances.get(tx.ref_id);
      /* Walking newest to oldest, the first row seen for a battle is its last
         movement and the last row seen is its first — so `closing` is set
         once and `opening` keeps moving back. */
      if (!seen) balances.set(tx.ref_id, { opening: before, closing: after });
      else seen.opening = before;
    }
    running = before;
  }

  /* If the window filled up, anything at or before its oldest row may have
     had earlier movements we never read — reporting a balance for those would
     be a guess. Say nothing rather than something wrong. */
  const truncatedAt = txs.length === TX_WINDOW ? txs[txs.length - 1].created_at : null;

  res.json({
    battles: rows.map(b => {
      const bal = balances.get(b.id);
      const trustworthy = bal && (truncatedAt == null || b.created_at > truncatedAt);
      return {
        ...shape(b, uid),
        openingBalance: trustworthy ? bal.opening : null,
        closingBalance: trustworthy ? bal.closing : null,
      };
    }),
  });
});

/* GET /api/battles/:id */
router.get('/:id', optionalAuth, async (req, res) => {
  const b = await fetchBattle(req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle not found.' });
  // Lobby bots exist to fill the board, not to be opened. Nobody is a player
  // in one, so there is nothing on the detail page for anyone to act on.
  if (b.is_bot) return res.status(404).json({ error: 'Battle not found.' });
  const viewerId = req.user?.id ?? null;
  const claims = await col('battle_claims').find({ battle_id: b.id },
    { projection: { _id: 0, user_id: 1, claim: 1, reason: 1 } }).toArray();
  // Onlookers see that a claim exists, not what was written in it.
  const visible = isPlayer(b, viewerId) ? claims : claims.map(c => ({ user_id: c.user_id, claim: c.claim }));
  res.json({ battle: shape(b, viewerId), claims: visible });
});

/* POST /api/battles  { mode, amount } */
router.post('/', requireAuth, async (req, res) => {
  const parsed = z.object({ mode: z.enum(['lite', 'rich']), amount: z.number().int().positive() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose a mode and a whole-rupee amount.' });
  const { mode, amount } = parsed.data;
  const cfg = MODES[mode];
  if (amount < cfg.min || amount > cfg.max) return res.status(400).json({ error: `Amount must be between ₹${cfg.min} and ₹${cfg.max}.` });
  if (amount % cfg.step !== 0) return res.status(400).json({ error: `Set the battle in multiples of ${cfg.step}.` });

  const settings = await getSettings();
  const id = newId();
  try {
    await withTransaction(async session => {
      const openCount = await col('battles').countDocuments(
        { creator_id: req.user.id, status: { $in: ['open', 'requested', 'waiting'] } }, { session });
      if (openCount >= settings.battle_limit) throw new Error('LIMIT');
      const dupe = await col('battles').findOne({ creator_id: req.user.id, amount, status: { $in: ['open', 'requested'] } }, { session });
      if (dupe) throw new Error('DUPLICATE');
      const stake = await debit(req.user.id, amount, 'Battle stake', id, session);
      if (!stake) throw new Error('INSUFFICIENT');
      await col('battles').insertOne({
        id, mode, amount, status: 'open', creator_id: req.user.id, acceptor_id: null,
        room_code: null, winner_id: null, payout: null, created_at: now(), settled_at: null,
        // Remembered so a refund returns the money to the same buckets.
        creator_stake: stake, acceptor_stake: null,
      }, { session });
    });
  } catch (e) {
    const map = {
      LIMIT: [409, `You can set maximum ${settings.battle_limit} battles.`],
      DUPLICATE: [409, 'You cannot create two battles for the same amount.'],
      INSUFFICIENT: [400, 'Insufficient balance. Add cash to continue.'],
    };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  const battle = shape(await fetchBattle(id), req.user.id);
  req.app.get('io')?.emit('battle:created', battle);
  res.status(201).json({ battle });
});

/* POST /api/battles/:id/accept (Opponent sends join request) */
router.post('/:id/accept', requireAuth, async (req, res) => {
  const id = req.params.id;
  let creatorId, amount;
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.status !== 'open') throw new Error('CLOSED');
      /* A lobby bot has no wallet behind it and cannot play a real Ludo
         match, so nobody joins one. It is only open for two or three seconds,
         but a tap inside that window has to land somewhere honest. */
      if (b.is_bot) throw new Error('CLOSED');
      if (b.creator_id === req.user.id) throw new Error('OWN');
      const already = await col('battles').findOne({ acceptor_id: req.user.id, status: { $in: ['requested', 'waiting', 'running'] } }, { session });
      if (already) throw new Error('ENROLLED');
      if ((await spendable(req.user.id, session)) < b.amount) throw new Error('INSUFFICIENT');
      const taken = await col('battles').updateOne({ id, status: 'open' },
        { $set: { acceptor_id: req.user.id, status: 'requested' } }, { session });
      if (taken.matchedCount === 0) throw new Error('CLOSED');   // someone got there first
      creatorId = b.creator_id; amount = b.amount;
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], CLOSED: [409, 'That battle is no longer open.'],
      OWN: [400, 'You created this battle.'], INSUFFICIENT: [400, 'Insufficient balance. Add cash to continue.'],
      ENROLLED: [409, 'You have already requested or joined another battle.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  await notify(creatorId, 'Opponent request', `${req.user.name} wants to join your ₹${amount} battle.`);
  const fresh = await fetchBattle(id);
  const battle = shape(fresh, req.user.id);
  emitBattle(req, fresh);
  const io = req.app.get('io');
  io?.emit('battle:removed', { id });
  res.json({ battle });
});

/* POST /api/battles/:id/accept-request (Host accepts opponent's request) */
router.post('/:id/accept-request', requireAuth, async (req, res) => {
  const id = req.params.id;
  let acceptorId, amount;
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.creator_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'requested') throw new Error('WRONGSTATE');
      if (!b.acceptor_id) throw new Error('NOOPPONENT');
      // Claim the transition first: if it does not apply, no money moves.
      const claimed = await col('battles').updateOne({ id, status: 'requested' },
        { $set: { status: 'waiting' } }, { session });
      if (claimed.matchedCount === 0) throw new Error('WRONGSTATE');
      const stake = await debit(b.acceptor_id, b.amount, 'Battle stake', id, session);
      if (!stake) throw new Error('OPPONENT_INSUFFICIENT');
      await col('battles').updateOne({ id, status: 'waiting' },
        { $set: { acceptor_stake: stake } }, { session });
      acceptorId = b.acceptor_id; amount = b.amount;
    });
  } catch (e) {
    const map = {
      NOTFOUND: [404, 'Battle not found.'],
      FORBIDDEN: [403, 'Only the creator can accept requests.'],
      WRONGSTATE: [409, 'No pending request for this battle.'],
      NOOPPONENT: [400, 'No opponent has requested to join.'],
      OPPONENT_INSUFFICIENT: [400, 'Opponent has insufficient balance.'],
    };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  await notify(acceptorId, 'Request accepted!', `Your request for the ₹${amount} battle was accepted. Waiting for room code.`);
  const fresh = await fetchBattle(id);
  const battle = shape(fresh, req.user.id);
  emitBattle(req, fresh);
  const io = req.app.get('io');
  res.json({ battle });
});

/* POST /api/battles/:id/reject-request (Host rejects opponent's request) */
const rejectRequestHandler = async (req, res) => {
  const id = req.params.id;
  let acceptorId, amount;
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.creator_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'requested' && b.status !== 'waiting') throw new Error('WRONGSTATE');
      // Claim the transition before refunding, so a double tap cannot pay twice.
      const rejected = await col('battles').updateOne(
        { id, status: b.status },
        { $set: { acceptor_id: null, status: 'open' } }, { session });
      if (rejected.matchedCount === 0) throw new Error('WRONGSTATE');
      if (b.status === 'waiting' && b.acceptor_id) {
        await refundStake(session, b, b.acceptor_id, 'Challenge rejected — refund');
      }
      acceptorId = b.acceptor_id; amount = b.amount;
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'Only the creator can reject.'],
      WRONGSTATE: [409, 'Nobody is waiting to be rejected.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  if (acceptorId) await notify(acceptorId, 'Request declined', `${req.user.name} declined your request for the ₹${amount} battle.`);
  const fresh = await fetchBattle(id);
  const battle = shape(fresh, req.user.id);
  emitBattle(req, fresh, [acceptorId]);          // they are no longer on the doc
  const io = req.app.get('io');
  io?.emit('battle:created', battle);
  res.json({ battle });
};
router.post('/:id/reject-request', requireAuth, rejectRequestHandler);

/* POST /api/battles/:id/cancel-request (Opponent cancels their own join request) */
router.post('/:id/cancel-request', requireAuth, async (req, res) => {
  const id = req.params.id;
  const withdrawer = req.user.id;                // cleared off the doc below
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.acceptor_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'requested') throw new Error('WRONGSTATE');
      const undone = await col('battles').updateOne({ id, status: 'requested', acceptor_id: req.user.id },
        { $set: { acceptor_id: null, status: 'open' } }, { session });
      if (undone.matchedCount === 0) throw new Error('WRONGSTATE');
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'You are not the requesting player.'],
      WRONGSTATE: [409, 'This request can no longer be cancelled.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  const fresh = await fetchBattle(id);
  const battle = shape(fresh, req.user.id);
  emitBattle(req, fresh, [withdrawer]);
  const io = req.app.get('io');
  io?.emit('battle:created', battle);
  res.json({ ok: true, battle });
});

/* POST /api/battles/:id/cancel  { reason }

   Before an opponent joins, only the host can call this off. Once both have
   staked but no room code exists yet, EITHER player may — otherwise a host who
   walks away without sharing a code leaves the opponent's stake locked until
   an admin steps in. Both stakes come back in that case. */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const id = req.params.id;
  const parsed = z.object({ reason: z.enum(CANCEL_REASON_IDS).optional() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose a reason for cancelling.' });
  const reason = parsed.data.reason || 'other';

  const notes = [];
  let cancelledBattle = null;
  try {
    await withTransaction(async session => {
      notes.length = 0;                       // cleared per attempt, see /result
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');

      const isCreator = b.creator_id === req.user.id;
      const isAcceptor = b.acceptor_id === req.user.id;
      const stuckWaiting = b.status === 'waiting';

      const plan = cancelPlan(b.status, {
        isCreator, isAcceptor, creatorId: b.creator_id, acceptorId: b.acceptor_id,
        roomSetAt: b.room_set_at, createdAt: b.created_at,
      });
      if (!plan.allowed) throw new Error(plan.error);

      const cancelled = await col('battles').updateOne(
        { id, status: b.status },
        { $set: { status: 'cancelled', settled_at: now(),
                  cancel_reason: reason, cancelled_by: req.user.id } }, { session });
      if (cancelled.matchedCount === 0) throw new Error('CLOSED');

      // Refund exactly who the plan says staked.
      for (const uid of plan.refund) {
        await refundStake(session, b, uid, 'Battle cancelled — refund');
      }

      const other = isCreator ? b.acceptor_id : b.creator_id;
      if (other && stuckWaiting) {
        notes.push([other, 'Battle cancelled',
          `Your ₹${b.amount} battle was cancelled — ${cancelReasonLabel(reason)}. Your entry fee was refunded.`]);
      }
      cancelledBattle = b;
    });
  } catch (e) {
    const map = {
      NOTFOUND: [404, 'Battle not found.'],
      FORBIDDEN: [403, 'You are not in this battle.'],
      HOSTONLY: [403, 'Only the host can cancel before the battle starts.'],
      CLOSED: [409, 'This battle can no longer be cancelled.'],
    };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  for (const [uid, title, body] of notes) await notify(uid, title, body);
  const io = req.app.get('io');
  io?.emit('battle:removed', { id });
  if (cancelledBattle) emitBattle(req, await fetchBattle(id));
  res.json({ ok: true, reason });
});

/* POST /api/battles/:id/reject (Legacy alias for reject-request) */
router.post('/:id/reject', requireAuth, rejectRequestHandler);

/* POST /api/battles/:id/room  { roomCode } */
router.post('/:id/room', requireAuth, async (req, res) => {
  const code = String(req.body?.roomCode ?? '');
  if (!/^\d{8}$/.test(code)) return res.status(400).json({ error: 'Invalid room code. It must be exactly 8 digits.' });
  const b = await col('battles').findOne({ id: req.params.id });
  if (!b) return res.status(404).json({ error: 'Battle not found.' });
  if (b.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator sets the room code.' });
  if (b.status !== 'waiting') return res.status(409).json({ error: 'Wait for an opponent to join first.' });
  /* Filter on the status we expect so two taps cannot both apply. Re-stamping
     room_set_at would silently reopen the one-minute cancel window. */
  const set = await col('battles').updateOne({ id: b.id, status: 'waiting' },
    { $set: { room_code: code, status: 'running', room_set_at: now() } });
  if (set.matchedCount === 0) return res.status(409).json({ error: 'The room code has already been set.' });
  if (b.acceptor_id) await notify(b.acceptor_id, 'Room code ready', `Join room ${code} to start the match.`);
  const fresh = await fetchBattle(b.id);
  const battle = shape(fresh, req.user.id);
  emitBattle(req, fresh);
  res.json({ battle });
});

/* POST /api/battles/:id/result  { claim, reason?, proof? } */
router.post('/:id/result', requireAuth, async (req, res) => {
  const parsed = z.object({
    claim: z.enum(['won', 'lost', 'cancel']),
    reason: z.string().max(200).optional(),
    proof: z.string().max(500).optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose won, lost or cancel.' });
  const { claim, reason, proof } = parsed.data;
  const id = req.params.id;
  const settings = await getSettings();
  const notes = [];   // sent after the transaction commits

  let outcome;
  try {
    outcome = await withTransaction(async session => {
      // withTransaction re-runs this callback on a write conflict, so any
      // state gathered here must be cleared or a retry doubles it.
      notes.length = 0;
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (![b.creator_id, b.acceptor_id].includes(req.user.id)) throw new Error('FORBIDDEN');
      // A battle awaiting the opponent's report sits in `disputed`, and that
      // opponent still has to be able to answer.
      const awaitingOpponent = b.status === 'disputed' && !!b.auto_settle_at;
      if (b.status !== 'running' && !awaitingOpponent) throw new Error('NOTRUNNING');
      if (claim === 'won' && !proof) throw new Error('PROOF');

      // Backing out is only allowed in the first minute after the room code
      // goes up; after that the match must be played and reported.
      if (claim === 'cancel' && !cancelWindowOpen(b.room_set_at, b.created_at, now()))
        throw new Error('CANCEL_CLOSED');

      const existing = await col('battle_claims').findOne({ battle_id: id, user_id: req.user.id }, { session });
      if (existing) throw new Error('ALREADY:' + existing.claim);
      await col('battle_claims').insertOne({
        battle_id: id, user_id: req.user.id, claim, reason: reason ?? null, proof: proof ?? null, created_at: now(),
      }, { session });

      const claims = await col('battle_claims').find({ battle_id: id }, { session }).toArray();
      if (claims.length < 2) {
        /* One side has reported and the other has not. Hold the battle in
           dispute; the sweeper settles it on this claim if the opponent is
           still silent when the grace period runs out. */
        const settleAt = now() + CLAIM_GRACE_MS;
        // Guarded like every other transition: never resurrect a battle that
        // was settled while this claim was in flight.
        const parked = await col('battles').updateOne({ id, status: b.status },
          { $set: { status: 'disputed', auto_settle_at: settleAt } }, { session });
        if (parked.matchedCount === 0) throw new Error('NOTRUNNING');
        const opponent = req.user.id === b.creator_id ? b.acceptor_id : b.creator_id;
        if (opponent) notes.push([opponent, 'Confirm your result',
          `Your opponent reported the ₹${b.amount} battle. Report yours within ${GRACE_LABEL} or theirs stands.`]);
        return { state: 'awaiting-opponent', autoSettleAt: settleAt };
      }

      const byUser = Object.fromEntries(claims.map(c => [c.user_id, c.claim]));
      const a = b.creator_id, c2 = b.acceptor_id;

      if (byUser[a] === 'cancel' && byUser[c2] === 'cancel') {
        await refundStake(session, b, a, 'Battle cancelled — refund');
        await refundStake(session, b, c2, 'Battle cancelled — refund');
        await col('battles').updateOne({ id },
          { $set: { status: 'cancelled', settled_at: now() }, $unset: { auto_settle_at: '' } }, { session });
        notes.push([a, 'Battle cancelled', 'Your stake was refunded.'], [c2, 'Battle cancelled', 'Your stake was refunded.']);
        return { state: 'cancelled' };
      }

      const winner = byUser[a] === 'won' && byUser[c2] === 'lost' ? a
                   : byUser[c2] === 'won' && byUser[a] === 'lost' ? c2 : null;
      if (!winner) {
        await col('battles').updateOne({ id },
          { $set: { status: 'disputed' }, $unset: { auto_settle_at: '' } }, { session });
        notes.push([a, 'Result under review', 'Both players claimed differently. Support will review the proof.'],
                   [c2, 'Result under review', 'Both players claimed differently. Support will review the proof.']);
        return { state: 'disputed' };
      }

      const payout = prizeFor(b.amount, settings);
      await credit(winner, 'winnings', payout, `Battle won — #${id.slice(-5)}`, id, 'success', session);
      await col('battles').updateOne({ id },
        { $set: { status: 'completed', winner_id: winner, payout, settled_at: now() },
          $unset: { auto_settle_at: '' } }, { session });
      notes.push([winner, 'You won!', `₹${payout} credited for battle #${id.slice(-5)}.`],
                 [winner === a ? c2 : a, 'Battle lost', 'Better luck next time.']);

      await payReferralCuts(session, b, settings, notes);
      return { state: 'completed', winner, payout };
    });
  } catch (e) {
    if (e.message.startsWith('ALREADY:'))
      return res.status(409).json({ error: `You have already updated your battle result for ${e.message.slice(8).toUpperCase()}.` });
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'You are not in this battle.'],
      NOTRUNNING: [409, 'This battle is not in progress.'], PROOF: [400, 'Attach a screenshot to claim a win.'],
      CANCEL_CLOSED: [409, `The cancel window closed ${CANCEL_LABEL} after the room code went up. Play the match and report the result.`] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  for (const [uid, title, body] of notes) await notify(uid, title, body);
  const fresh = await fetchBattle(id);
  const battle = shape(fresh, req.user.id);
  emitBattle(req, fresh);
  res.json({ battle, ...outcome });
});

export default router;
