/* Battles — create, list, accept, cancel, room code, result claims (MongoDB).

   Two-sided settlement: each player files a claim; agreement settles the
   battle, conflict marks it disputed for an admin. Money moves inside Mongo
   transactions; notifications are sent after commit. */
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { col, nextId, now, credit, debit, notify, getSettings, withTransaction } from '../lib/db.js';
import { requireAuth, optionalAuth } from '../lib/auth.js';
import { MODES } from '../lib/config.js';

const router = express.Router();
const newId = () => crypto.randomBytes(6).toString('hex');

function shape(b) {
  return {
    id: b.id, mode: b.mode, amount: b.amount, status: b.status,
    creator:  b.creator_id  ? { id: b.creator_id,  name: b.creator_name }  : null,
    acceptor: b.acceptor_id ? { id: b.acceptor_id, name: b.acceptor_name } : null,
    roomCode: b.room_code, winnerId: b.winner_id, payout: b.payout,
    createdAt: b.created_at, settledAt: b.settled_at,
  };
}

/* Fetch battles with creator/acceptor names joined in. */
async function fetchBattles(match, limit = 100) {
  return col('battles').aggregate([
    { $match: match },
    { $sort: { created_at: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: 'creator_id', foreignField: 'id', as: 'c' } },
    { $lookup: { from: 'users', localField: 'acceptor_id', foreignField: 'id', as: 'a' } },
    { $addFields: { creator_name: { $arrayElemAt: ['$c.name', 0] }, acceptor_name: { $arrayElemAt: ['$a.name', 0] } } },
    { $project: { c: 0, a: 0, _id: 0 } },
  ]).toArray();
}
async function fetchBattle(id) {
  const [b] = await fetchBattles({ id }, 1);
  return b || null;
}

/* GET /api/battles?mode=lite&status=open */
router.get('/', optionalAuth, async (req, res) => {
  const mode = MODES[req.query.mode] ? req.query.mode : 'lite';
  const status = ['open', 'requested', 'waiting', 'running'].includes(req.query.status) ? req.query.status : null;
  const match = { mode, status: status ? status : { $in: ['open', 'requested', 'waiting', 'running'] } };
  const rows = await fetchBattles(match, 100);
  res.json({ battles: rows.map(shape) });
});

/* GET /api/battles/mine */
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await fetchBattles({ $or: [{ creator_id: req.user.id }, { acceptor_id: req.user.id }] }, 200);
  res.json({ battles: rows.map(shape) });
});

/* GET /api/battles/:id */
router.get('/:id', optionalAuth, async (req, res) => {
  const b = await fetchBattle(req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle not found.' });
  const claims = await col('battle_claims').find({ battle_id: b.id },
    { projection: { _id: 0, user_id: 1, claim: 1, reason: 1 } }).toArray();
  res.json({ battle: shape(b), claims });
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
      if (!(await debit(req.user.id, amount, 'Battle stake', id, session))) throw new Error('INSUFFICIENT');
      await col('battles').insertOne({
        id, mode, amount, status: 'open', creator_id: req.user.id, acceptor_id: null,
        room_code: null, winner_id: null, payout: null, created_at: now(), settled_at: null,
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
  const battle = shape(await fetchBattle(id));
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
      if (b.creator_id === req.user.id) throw new Error('OWN');
      const already = await col('battles').findOne({ acceptor_id: req.user.id, status: { $in: ['requested', 'waiting', 'running'] } }, { session });
      if (already) throw new Error('ENROLLED');
      const { spendable } = await import('../lib/db.js');
      if ((await spendable(req.user.id)) < b.amount) throw new Error('INSUFFICIENT');
      await col('battles').updateOne({ id }, { $set: { acceptor_id: req.user.id, status: 'requested' } }, { session });
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
  const battle = shape(await fetchBattle(id));
  const io = req.app.get('io');
  io?.to(`battle:${id}`).emit('battle:updated', battle);
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
      if (!(await debit(b.acceptor_id, b.amount, 'Battle stake', id, session))) throw new Error('OPPONENT_INSUFFICIENT');
      await col('battles').updateOne({ id }, { $set: { status: 'waiting' } }, { session });
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
  const battle = shape(await fetchBattle(id));
  const io = req.app.get('io');
  io?.to(`battle:${id}`).emit('battle:updated', battle);
  res.json({ battle });
});

/* POST /api/battles/:id/reject-request (Host rejects opponent's request) */
router.post('/:id/reject-request', requireAuth, async (req, res) => {
  const id = req.params.id;
  let acceptorId, amount;
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.creator_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'requested' && b.status !== 'waiting') throw new Error('WRONGSTATE');
      if (b.status === 'waiting' && b.acceptor_id) {
        await credit(b.acceptor_id, 'deposit', b.amount, 'Challenge rejected — refund', id, 'success', session);
      }
      await col('battles').updateOne({ id }, { $set: { acceptor_id: null, status: 'open' } }, { session });
      acceptorId = b.acceptor_id; amount = b.amount;
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'Only the creator can reject.'],
      WRONGSTATE: [409, 'Nobody is waiting to be rejected.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  if (acceptorId) await notify(acceptorId, 'Request declined', `${req.user.name} declined your request for the ₹${amount} battle.`);
  const battle = shape(await fetchBattle(id));
  const io = req.app.get('io');
  io?.to(`battle:${id}`).emit('battle:updated', battle);
  io?.emit('battle:created', battle);
  res.json({ battle });
});

/* POST /api/battles/:id/cancel-request (Opponent cancels their own join request) */
router.post('/:id/cancel-request', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.acceptor_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'requested') throw new Error('WRONGSTATE');
      await col('battles').updateOne({ id }, { $set: { acceptor_id: null, status: 'open' } }, { session });
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'You are not the requesting player.'],
      WRONGSTATE: [409, 'This request can no longer be cancelled.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  const battle = shape(await fetchBattle(id));
  const io = req.app.get('io');
  io?.to(`battle:${id}`).emit('battle:updated', battle);
  io?.emit('battle:created', battle);
  res.json({ ok: true, battle });
});

/* POST /api/battles/:id/cancel (Host cancels battle) */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.creator_id !== req.user.id) throw new Error('FORBIDDEN');
      if (!['open', 'requested'].includes(b.status)) throw new Error('CLOSED');
      await credit(req.user.id, 'deposit', b.amount, 'Battle cancelled — refund', id, 'success', session);
      await col('battles').updateOne({ id }, { $set: { status: 'cancelled', settled_at: now() } }, { session });
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'Only the creator can cancel.'],
      CLOSED: [409, 'This battle can no longer be cancelled.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  req.app.get('io')?.emit('battle:removed', { id });
  res.json({ ok: true });
});

/* POST /api/battles/:id/reject (Legacy alias for reject-request) */
router.post('/:id/reject', requireAuth, async (req, res) => {
  return router.handle({ ...req, url: `/${req.params.id}/reject-request` }, res);
});

/* POST /api/battles/:id/room  { roomCode } */
router.post('/:id/room', requireAuth, async (req, res) => {
  const code = String(req.body?.roomCode ?? '');
  if (!/^\d{8}$/.test(code)) return res.status(400).json({ error: 'Invalid room code. It must be exactly 8 digits.' });
  const b = await col('battles').findOne({ id: req.params.id });
  if (!b) return res.status(404).json({ error: 'Battle not found.' });
  if (b.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator sets the room code.' });
  if (b.status !== 'waiting') return res.status(409).json({ error: 'Wait for an opponent to join first.' });
  await col('battles').updateOne({ id: b.id }, { $set: { room_code: code, status: 'running' } });
  if (b.acceptor_id) await notify(b.acceptor_id, 'Room code ready', `Join room ${code} to start the match.`);
  const battle = shape(await fetchBattle(b.id));
  req.app.get('io')?.to(`battle:${b.id}`).emit('battle:updated', battle);
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
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (![b.creator_id, b.acceptor_id].includes(req.user.id)) throw new Error('FORBIDDEN');
      if (b.status !== 'running') throw new Error('NOTRUNNING');
      if (claim === 'won' && !proof) throw new Error('PROOF');

      const existing = await col('battle_claims').findOne({ battle_id: id, user_id: req.user.id }, { session });
      if (existing) throw new Error('ALREADY:' + existing.claim);
      await col('battle_claims').insertOne({
        battle_id: id, user_id: req.user.id, claim, reason: reason ?? null, proof: proof ?? null, created_at: now(),
      }, { session });

      const claims = await col('battle_claims').find({ battle_id: id }, { session }).toArray();
      if (claims.length < 2) return { state: 'pending' };

      const byUser = Object.fromEntries(claims.map(c => [c.user_id, c.claim]));
      const a = b.creator_id, c2 = b.acceptor_id;

      if (byUser[a] === 'cancel' && byUser[c2] === 'cancel') {
        await credit(a, 'deposit', b.amount, 'Battle cancelled — refund', id, 'success', session);
        await credit(c2, 'deposit', b.amount, 'Battle cancelled — refund', id, 'success', session);
        await col('battles').updateOne({ id }, { $set: { status: 'cancelled', settled_at: now() } }, { session });
        notes.push([a, 'Battle cancelled', 'Your stake was refunded.'], [c2, 'Battle cancelled', 'Your stake was refunded.']);
        return { state: 'cancelled' };
      }

      const winner = byUser[a] === 'won' && byUser[c2] === 'lost' ? a
                   : byUser[c2] === 'won' && byUser[a] === 'lost' ? c2 : null;
      if (!winner) {
        await col('battles').updateOne({ id }, { $set: { status: 'disputed' } }, { session });
        notes.push([a, 'Result under review', 'Both players claimed differently. Support will review the proof.'],
                   [c2, 'Result under review', 'Both players claimed differently. Support will review the proof.']);
        return { state: 'disputed' };
      }

      const payout = Math.round(b.amount * 2 * (1 - settings.commission));
      await credit(winner, 'winnings', payout, `Battle won — #${id.slice(-5)}`, id, 'success', session);
      await col('battles').updateOne({ id }, { $set: { status: 'completed', winner_id: winner, payout, settled_at: now() } }, { session });
      notes.push([winner, 'You won!', `₹${payout} credited for battle #${id.slice(-5)}.`],
                 [winner === a ? c2 : a, 'Battle lost', 'Better luck next time.']);

      for (const uid of [a, c2]) {
        const u = await col('users').findOne({ id: uid }, { session });
        if (!u?.referred_by) continue;
        const cut = Math.round(b.amount * (settings.referral_rate || 0.01));
        if (cut <= 0) continue;
        await credit(u.referred_by, 'referral', cut, `Referral bonus — battle #${id.slice(-5)}`, id, 'success', session);
        await col('referrals').updateOne({ referrer_id: u.referred_by, referee_id: uid }, { $inc: { earned: cut } }, { session });
        notes.push([u.referred_by, 'Referral bonus earned! 💰', `You earned ₹${cut} from ${u.name || 'your referral'}'s match.`]);
      }
      return { state: 'completed', winner, payout };
    });
  } catch (e) {
    if (e.message.startsWith('ALREADY:'))
      return res.status(409).json({ error: `You have already updated your battle result for ${e.message.slice(8).toUpperCase()}.` });
    const map = { NOTFOUND: [404, 'Battle not found.'], FORBIDDEN: [403, 'You are not in this battle.'],
      NOTRUNNING: [409, 'This battle is not in progress.'], PROOF: [400, 'Attach a screenshot to claim a win.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  for (const [uid, title, body] of notes) await notify(uid, title, body);
  const battle = shape(await fetchBattle(id));
  req.app.get('io')?.to(`battle:${id}`).emit('battle:updated', battle);
  res.json({ battle, ...outcome });
});

export default router;
