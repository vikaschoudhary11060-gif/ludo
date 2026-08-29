/* Battles — create, list, accept, cancel, room code, result claims.

   Settlement model (better than trusting one side):
   each player files a claim; when both agree the battle settles
   automatically, and when they conflict it is marked `disputed`
   for an admin to resolve. */
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, now, credit, debit, spendable, notify, getSettings } from '../lib/db.js';
import { requireAuth, optionalAuth } from '../lib/auth.js';
import { MODES, REFERRAL_RATE, payoutFor } from '../lib/config.js';

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

const SELECT = `
  SELECT b.*, c.name AS creator_name, a.name AS acceptor_name
  FROM battles b
  JOIN users c ON c.id = b.creator_id
  LEFT JOIN users a ON a.id = b.acceptor_id`;

/* GET /api/battles?mode=lite&status=open */
router.get('/', optionalAuth, (req, res) => {
  const mode = MODES[req.query.mode] ? req.query.mode : 'lite';
  const status = ['open', 'waiting', 'running'].includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare(`${SELECT} WHERE b.mode = ? AND b.status = ? ORDER BY b.created_at DESC LIMIT 100`).all(mode, status)
    : db.prepare(`${SELECT} WHERE b.mode = ? AND b.status IN ('open','waiting','running')
                  ORDER BY b.created_at DESC LIMIT 100`).all(mode);
  res.json({ battles: rows.map(shape) });
});

/* GET /api/battles/mine */
router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`${SELECT} WHERE b.creator_id = ? OR b.acceptor_id = ?
                           ORDER BY b.created_at DESC LIMIT 200`).all(req.user.id, req.user.id);
  res.json({ battles: rows.map(shape) });
});

/* GET /api/battles/:id */
router.get('/:id', optionalAuth, (req, res) => {
  const b = db.prepare(`${SELECT} WHERE b.id = ?`).get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle not found.' });
  const claims = db.prepare('SELECT user_id, claim, reason FROM battle_claims WHERE battle_id = ?').all(b.id);
  res.json({ battle: shape(b), claims });
});

/* POST /api/battles  { mode, amount } */
router.post('/', requireAuth, (req, res) => {
  const schema = z.object({
    mode: z.enum(['lite', 'rich']),
    amount: z.number().int().positive(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose a mode and a whole-rupee amount.' });
  const { mode, amount } = parsed.data;
  const cfg = MODES[mode];

  if (amount < cfg.min || amount > cfg.max)
    return res.status(400).json({ error: `Amount must be between ₹${cfg.min} and ₹${cfg.max}.` });
  if (amount % cfg.step !== 0)
    return res.status(400).json({ error: `Set the battle in multiples of ${cfg.step}.` });

  const settings = getSettings();
  const id = newId();
  try {
    db.transaction(() => {
      // Guard 1: a user may only have N battles open at once (reference: 2).
      const openCount = db.prepare(
        "SELECT COUNT(*) c FROM battles WHERE creator_id = ? AND status IN ('open','waiting')"
      ).get(req.user.id).c;
      if (openCount >= settings.battle_limit) throw new Error('LIMIT');

      // Guard 2: no two open battles from the same user at the same amount.
      const dupe = db.prepare(
        "SELECT 1 FROM battles WHERE creator_id = ? AND amount = ? AND status = 'open'"
      ).get(req.user.id, amount);
      if (dupe) throw new Error('DUPLICATE');

      if (spendable(req.user.id) < amount) throw new Error('INSUFFICIENT');
      if (!debit(req.user.id, amount, 'Battle stake', id)) throw new Error('INSUFFICIENT');
      db.prepare(`INSERT INTO battles (id, mode, amount, status, creator_id, created_at)
                  VALUES (?,?,?,'open',?,?)`).run(id, mode, amount, req.user.id, now());
    })();
  } catch (e) {
    const map = {
      LIMIT:     [409, `You can set maximum ${settings.battle_limit} battles.`],
      DUPLICATE: [409, 'You cannot create two battles for the same amount.'],
      INSUFFICIENT: [400, 'Insufficient balance. Add cash to continue.'],
    };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }

  const battle = shape(db.prepare(`${SELECT} WHERE b.id = ?`).get(id));
  req.app.get('io')?.emit('battle:created', battle);
  res.status(201).json({ battle });
});

/* POST /api/battles/:id/accept */
router.post('/:id/accept', requireAuth, (req, res) => {
  const id = req.params.id;
  try {
    db.transaction(() => {
      const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
      if (!b) throw new Error('NOTFOUND');
      if (b.status !== 'open') throw new Error('CLOSED');
      if (b.creator_id === req.user.id) throw new Error('OWN');
      const already = db.prepare(
        "SELECT 1 FROM battles WHERE acceptor_id = ? AND status IN ('waiting','running')"
      ).get(req.user.id);
      if (already) throw new Error('ENROLLED');
      if (!debit(req.user.id, b.amount, 'Battle stake', id)) throw new Error('INSUFFICIENT');
      db.prepare("UPDATE battles SET acceptor_id = ?, status = 'waiting' WHERE id = ?")
        .run(req.user.id, id);
      notify(b.creator_id, 'Challenge accepted',
             `${req.user.name} joined your ₹${b.amount} battle. Set the room code.`);
    })();
  } catch (e) {
    const map = {
      NOTFOUND: [404, 'Battle not found.'],
      CLOSED:   [409, 'That battle is no longer open.'],
      OWN:      [400, 'You created this battle.'],
      INSUFFICIENT: [400, 'Insufficient balance. Add cash to continue.'],
      ENROLLED: [409, 'You have already enrolled in another battle.'],
    };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }

  const battle = shape(db.prepare(`${SELECT} WHERE b.id = ?`).get(id));
  const io = req.app.get('io');
  io?.to(`battle:${id}`).emit('battle:updated', battle);
  io?.emit('battle:removed', { id });
  res.json({ battle });
});

/* POST /api/battles/:id/cancel — creator only, while still open. */
router.post('/:id/cancel', requireAuth, (req, res) => {
  const id = req.params.id;
  try {
    db.transaction(() => {
      const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
      if (!b) throw new Error('NOTFOUND');
      if (b.creator_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'open') throw new Error('CLOSED');
      credit(req.user.id, 'deposit', b.amount, 'Battle cancelled — refund', id);
      db.prepare("UPDATE battles SET status = 'cancelled', settled_at = ? WHERE id = ?").run(now(), id);
    })();
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'],
                  FORBIDDEN: [403, 'Only the creator can cancel.'],
                  CLOSED: [409, 'This battle can no longer be cancelled.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  req.app.get('io')?.emit('battle:removed', { id });
  res.json({ ok: true });
});

/* POST /api/battles/:id/reject — creator sends the joiner away; their stake is refunded
   and the battle goes back on the board. Mirrors the reference's challange/reject. */
router.post('/:id/reject', requireAuth, (req, res) => {
  const id = req.params.id;
  try {
    db.transaction(() => {
      const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
      if (!b) throw new Error('NOTFOUND');
      if (b.creator_id !== req.user.id) throw new Error('FORBIDDEN');
      if (b.status !== 'waiting') throw new Error('WRONGSTATE');
      credit(b.acceptor_id, 'deposit', b.amount, 'Challenge rejected — refund', id);
      notify(b.acceptor_id, 'Challenge rejected', `${req.user.name} rejected your request. ₹${b.amount} refunded.`);
      db.prepare("UPDATE battles SET acceptor_id = NULL, status = 'open' WHERE id = ?").run(id);
    })();
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'],
                  FORBIDDEN: [403, 'Only the creator can reject.'],
                  WRONGSTATE: [409, 'Nobody is waiting to be rejected.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  const battle = shape(db.prepare(`${SELECT} WHERE b.id = ?`).get(id));
  const io = req.app.get('io');
  io?.to(`battle:${id}`).emit('battle:updated', battle);
  io?.emit('battle:created', battle);        // back on the open board
  res.json({ battle });
});

/* POST /api/battles/:id/room  { roomCode } — creator only. */
router.post('/:id/room', requireAuth, (req, res) => {
  const code = String(req.body?.roomCode ?? '');
  if (!/^\d{8}$/.test(code))
    return res.status(400).json({ error: 'Invalid room code. It must be exactly 8 digits.' });

  const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Battle not found.' });
  if (b.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator sets the room code.' });
  if (b.status !== 'waiting') return res.status(409).json({ error: 'Wait for an opponent to join first.' });

  db.prepare("UPDATE battles SET room_code = ?, status = 'running' WHERE id = ?").run(code, b.id);
  if (b.acceptor_id) notify(b.acceptor_id, 'Room code ready', `Join room ${code} to start the match.`);

  const battle = shape(db.prepare(`${SELECT} WHERE b.id = ?`).get(b.id));
  req.app.get('io')?.to(`battle:${b.id}`).emit('battle:updated', battle);
  res.json({ battle });
});

/* POST /api/battles/:id/result  { claim: won|lost|cancel, reason?, proof? } */
router.post('/:id/result', requireAuth, (req, res) => {
  const schema = z.object({
    claim: z.enum(['won', 'lost', 'cancel']),
    reason: z.string().max(200).optional(),
    proof: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose won, lost or cancel.' });
  const { claim, reason, proof } = parsed.data;
  const id = req.params.id;

  let outcome;
  try {
    outcome = db.transaction(() => {
      const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
      if (!b) throw new Error('NOTFOUND');
      if (![b.creator_id, b.acceptor_id].includes(req.user.id)) throw new Error('FORBIDDEN');
      if (b.status !== 'running') throw new Error('NOTRUNNING');
      if (claim === 'won' && !proof) throw new Error('PROOF');

      const existing = db.prepare(
        'SELECT claim FROM battle_claims WHERE battle_id = ? AND user_id = ?'
      ).get(id, req.user.id);
      if (existing) throw new Error('ALREADY:' + existing.claim);

      db.prepare(`INSERT INTO battle_claims (battle_id, user_id, claim, reason, proof, created_at)
                  VALUES (?,?,?,?,?,?)
                  ON CONFLICT(battle_id, user_id) DO UPDATE SET
                    claim=excluded.claim, reason=excluded.reason, proof=excluded.proof`)
        .run(id, req.user.id, claim, reason ?? null, proof ?? null, now());

      const claims = db.prepare('SELECT user_id, claim FROM battle_claims WHERE battle_id = ?').all(id);
      if (claims.length < 2) return { state: 'pending' };   // wait for the opponent

      const byUser = Object.fromEntries(claims.map(c => [c.user_id, c.claim]));
      const a = b.creator_id, c2 = b.acceptor_id;

      // Both asked to cancel -> refund both.
      if (byUser[a] === 'cancel' && byUser[c2] === 'cancel') {
        credit(a, 'deposit', b.amount, 'Battle cancelled — refund', id);
        credit(c2, 'deposit', b.amount, 'Battle cancelled — refund', id);
        db.prepare("UPDATE battles SET status='cancelled', settled_at=? WHERE id=?").run(now(), id);
        notify(a, 'Battle cancelled', 'Your stake was refunded.');
        notify(c2, 'Battle cancelled', 'Your stake was refunded.');
        return { state: 'cancelled' };
      }

      // Exactly one winner and one loser -> settle.
      const winner = byUser[a] === 'won' && byUser[c2] === 'lost' ? a
                   : byUser[c2] === 'won' && byUser[a] === 'lost' ? c2
                   : null;
      if (!winner) {
        db.prepare("UPDATE battles SET status='disputed' WHERE id=?").run(id);
        notify(a,  'Result under review', 'Both players claimed differently. Support will review the proof.');
        notify(c2, 'Result under review', 'Both players claimed differently. Support will review the proof.');
        return { state: 'disputed' };
      }

      const payout = Math.round(b.amount * 2 * (1 - getSettings().commission));
      credit(winner, 'winnings', payout, `Battle won — #${id.slice(-5)}`, id);
      db.prepare("UPDATE battles SET status='completed', winner_id=?, payout=?, settled_at=? WHERE id=?")
        .run(winner, payout, now(), id);
      notify(winner, 'You won!', `₹${payout} credited for battle #${id.slice(-5)}.`);
      notify(winner === a ? c2 : a, 'Battle lost', 'Better luck next time.');

      // Referral commission on the stake, paid to whoever referred each player.
      for (const uid of [a, c2]) {
        const u = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(uid);
        if (!u?.referred_by) continue;
        const cut = Math.round(b.amount * getSettings().referral_rate);
        if (cut <= 0) continue;
        credit(u.referred_by, 'referral', cut, 'Referral commission', id);
        db.prepare('UPDATE referrals SET earned = earned + ? WHERE referrer_id = ? AND referee_id = ?')
          .run(cut, u.referred_by, uid);
      }
      return { state: 'completed', winner, payout };
    })();
  } catch (e) {
    const map = {
      NOTFOUND: [404, 'Battle not found.'],
      FORBIDDEN: [403, 'You are not in this battle.'],
      NOTRUNNING: [409, 'This battle is not in progress.'],
      PROOF: [400, 'Attach a screenshot to claim a win.'],
    };
    if (e.message.startsWith('ALREADY:'))
      return res.status(409).json({ error: `You have already updated your battle result for ${e.message.slice(8).toUpperCase()}.` });
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }

  const battle = shape(db.prepare(`${SELECT} WHERE b.id = ?`).get(id));
  req.app.get('io')?.to(`battle:${id}`).emit('battle:updated', battle);
  res.json({ battle, ...outcome });
});

export default router;
