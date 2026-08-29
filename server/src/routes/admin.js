/* Admin — dispute resolution, KYC approval, deposit verification, site switches.

   Guarded by a shared secret in the x-admin-key header. Swap for real
   admin accounts before this goes anywhere near production. */
import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db, now, credit, notify, getSettings, audit } from '../lib/db.js';
import { verifyLogin, signAdmin, requireAdmin, createAdmin, adminCount, ROLES } from '../lib/admin-auth.js';
import { threadFor } from './chat.js';
import playerRoutes from './admin-players.js';
import paymentAdminRoutes from './payments.js';

const router = express.Router();

/* ---------- sign in (public) ---------- */

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const admin = verifyLogin(username, password);
  if (!admin) {
    audit({ username: String(username || 'unknown') }, 'login.failed',
          { ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip });
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  audit(admin, 'login', { ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip });
  res.json({
    token: signAdmin(admin),
    admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
  });
});

router.get('/bootstrap', (_req, res) => res.json({ needsSetup: adminCount() === 0 }));

/* Everything below needs a signed-in admin. */
router.use(requireAdmin('viewer'));

/* Players, money reporting, fraud & risk. */
router.use(playerRoutes);
/* Payment methods (UPI/QR). */
router.use(paymentAdminRoutes);

router.get('/me', (req, res) => res.json({
  admin: { id: req.admin.id, username: req.admin.username, name: req.admin.name, role: req.admin.role },
}));

/* ---------- audit log ---------- */

router.get('/audit', requireAdmin('admin'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM audit_log
                           WHERE created_at >= ? ORDER BY created_at DESC LIMIT 300`).all(since(req));
  res.json({ entries: rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
});

/* ---------- admin management (owner only) ---------- */

router.get('/admins', requireAdmin('owner'), (_req, res) => {
  res.json({ admins: db.prepare(
    'SELECT id, username, name, role, active, last_login_at, created_at FROM admin_users ORDER BY id').all() });
});

router.post('/admins', requireAdmin('owner'), (req, res) => {
  try {
    const a = createAdmin(req.body || {});
    audit(req.admin, 'admin.create', { targetType: 'admin', targetId: String(a.id),
                                       detail: { username: a.username, role: a.role }, ip: req.clientIp });
    res.status(201).json({ admin: a });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'That username is taken.' });
    res.status(400).json({ error: e.message });
  }
});

router.patch('/admins/:id', requireAdmin('owner'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.admin.id && req.body?.active === false)
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  const fields = [];
  const args = [];
  if (typeof req.body?.active === 'boolean') { fields.push('active = ?'); args.push(req.body.active ? 1 : 0); }
  if (ROLES.includes(req.body?.role)) { fields.push('role = ?'); args.push(req.body.role); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE admin_users SET ${fields.join(', ')} WHERE id = ?`).run(...args, id);
  audit(req.admin, 'admin.update', { targetType: 'admin', targetId: String(id), detail: req.body, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- shared: time-range filter ---------- */

const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: null };

/** Milliseconds-since-epoch floor for ?range=1d|7d|30d|all (default all). */
function since(req) {
  const span = RANGES[req.query.range];
  return span ? Date.now() - span : 0;
}

/* ---------- overview ---------- */

/* GET /api/admin/stats?range= */
router.get('/stats', (req, res) => {
  const from = since(req);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const battles = db.prepare(`
    SELECT status, COUNT(*) n, COALESCE(SUM(amount),0) staked
    FROM battles WHERE created_at >= ? GROUP BY status`).all(from);

  const byStatus = Object.fromEntries(battles.map(b => [b.status, b.n]));
  const settled = one(
    "SELECT COUNT(*) n, COALESCE(SUM(amount),0) staked, COALESCE(SUM(payout),0) paid FROM battles WHERE status='completed' AND settled_at >= ?", from);

  res.json({
    range: req.query.range || 'all',
    users: one('SELECT COUNT(*) n FROM users WHERE created_at >= ?', from).n,
    battles: {
      total: battles.reduce((s, b) => s + b.n, 0),
      open: byStatus.open || 0,
      waiting: byStatus.waiting || 0,
      running: byStatus.running || 0,
      completed: byStatus.completed || 0,
      cancelled: byStatus.cancelled || 0,
      disputed: byStatus.disputed || 0,
    },
    // Commission is the difference between what both players staked and what we paid out.
    commission: Math.max(0, settled.staked * 2 - settled.paid),
    deposits: {
      instant: one("SELECT COALESCE(SUM(amount),0) v FROM transactions WHERE type='credit' AND bucket='deposit' AND note IN ('Deposit','Cashback bonus') AND created_at >= ?", from).v,
      pending: one("SELECT COUNT(*) n FROM deposit_requests WHERE status='pending' AND created_at >= ?", from).n,
      approved: one("SELECT COALESCE(SUM(amount),0) v FROM deposit_requests WHERE status='approved' AND created_at >= ?", from).v,
    },
    withdrawals: {
      pending: one("SELECT COUNT(*) n FROM withdrawal_requests WHERE status='pending' AND created_at >= ?", from).n,
      pendingValue: one("SELECT COALESCE(SUM(amount),0) v FROM withdrawal_requests WHERE status='pending' AND created_at >= ?", from).v,
      paid: one("SELECT COALESCE(SUM(amount),0) v FROM withdrawal_requests WHERE status='paid' AND created_at >= ?", from).v,
    },
    kycPending: one("SELECT COUNT(*) n FROM users WHERE kyc_status='pending'").n,
  });
});

/* ---------- games ---------- */

/* GET /api/admin/battles?status=&range=&q= */
router.get('/battles', (req, res) => {
  const from = since(req);
  const status = ['open','waiting','running','completed','cancelled','disputed'].includes(req.query.status)
    ? req.query.status : null;
  const q = (req.query.q || '').trim();

  const where = ['b.created_at >= ?'];
  const args = [from];
  if (status) { where.push('b.status = ?'); args.push(status); }
  if (q) { where.push('(c.name LIKE ? OR a.name LIKE ? OR b.id LIKE ? OR b.room_code LIKE ?)');
           args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }

  const rows = db.prepare(`
    SELECT b.id, b.mode, b.amount, b.status, b.room_code, b.payout,
           b.created_at, b.settled_at, b.winner_id,
           c.name AS creator_name, c.id AS creator_id,
           a.name AS acceptor_name, a.id AS acceptor_id
    FROM battles b
    JOIN users c ON c.id = b.creator_id
    LEFT JOIN users a ON a.id = b.acceptor_id
    WHERE ${where.join(' AND ')}
    ORDER BY b.created_at DESC LIMIT 300`).all(...args);

  const claims = db.prepare('SELECT battle_id, user_id, claim, reason, proof FROM battle_claims').all();
  res.json({ battles: rows.map(b => ({ ...b, claims: claims.filter(c => c.battle_id === b.id) })) });
});

/* ---------- money lists ---------- */

/* GET /api/admin/deposits/all?range=&status= — every deposit request, not just pending. */
router.get('/deposits/all', (req, res) => {
  const from = since(req);
  const status = ['pending','approved','rejected'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`
    SELECT d.*, u.name, u.phone FROM deposit_requests d JOIN users u ON u.id = d.user_id
    WHERE d.created_at >= ? ${status ? 'AND d.status = ?' : ''}
    ORDER BY d.created_at DESC LIMIT 300`).all(...(status ? [from, status] : [from]));
  // Instant (gateway-simulated) top-ups live in the ledger, not the request queue.
  const instant = db.prepare(`
    SELECT t.id, t.amount, t.created_at, t.note, u.name, u.phone
    FROM transactions t JOIN users u ON u.id = t.user_id
    WHERE t.type='credit' AND t.bucket='deposit' AND t.note IN ('Deposit','Cashback bonus')
      AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT 300`).all(from);
  res.json({ requests: rows, instant });
});

/* GET /api/admin/withdrawals?range=&status= */
router.get('/withdrawals', (req, res) => {
  const from = since(req);
  const status = ['pending','paid','rejected'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`
    SELECT w.*, u.name, u.phone, u.kyc_status FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
    WHERE w.created_at >= ? ${status ? 'AND w.status = ?' : ''}
    ORDER BY w.created_at DESC LIMIT 300`).all(...(status ? [from, status] : [from]));
  res.json({ withdrawals: rows });
});

/* POST /api/admin/withdrawals/:id  { approve, note? }
   Approving marks it paid (money already left the wallet at request time).
   Rejecting returns the amount to the user's winnings. */
router.post('/withdrawals/:id', requireAdmin('admin'), (req, res) => {
  const approve = req.body?.approve === true;
  try {
    db.transaction(() => {
      const w = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
      if (!w) throw new Error('NOTFOUND');
      db.prepare('UPDATE withdrawal_requests SET status = ?, settled_at = ?, note = ? WHERE id = ?')
        .run(approve ? 'paid' : 'rejected', now(), req.body?.note ?? null, w.id);
      db.prepare(`UPDATE transactions SET status = ?
                  WHERE user_id = ? AND type='debit' AND status='pending' AND amount = ?`)
        .run(approve ? 'success' : 'failed', w.user_id, w.amount);
      if (approve) {
        notify(w.user_id, 'Withdrawal successful', `₹${w.amount} has been sent.`);
      } else {
        // The debit is now void, so return the money WITHOUT writing a second
        // ledger row — otherwise the wallet and the ledger disagree by the amount.
        db.prepare('UPDATE wallets SET winnings = winnings + ? WHERE user_id = ?')
          .run(w.amount, w.user_id);
        notify(w.user_id, 'Withdrawal rejected', req.body?.note || 'The amount was returned to your winnings.');
      }
    })();
  } catch (e) {
    if (e.message === 'NOTFOUND') return res.status(404).json({ error: 'No such pending withdrawal.' });
    throw e;
  }
  audit(req.admin, approve ? 'withdrawal.paid' : 'withdrawal.reject',
        { targetType: 'withdrawal', targetId: req.params.id, detail: { note: req.body?.note }, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- disputes ---------- */

/* GET /api/admin/disputes — battles where the two players disagree. */
router.get('/disputes', (_req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.amount, b.mode, b.room_code, b.created_at,
           c.name AS creator_name, c.id AS creator_id,
           a.name AS acceptor_name, a.id AS acceptor_id
    FROM battles b
    JOIN users c ON c.id = b.creator_id
    LEFT JOIN users a ON a.id = b.acceptor_id
    WHERE b.status = 'disputed' AND b.created_at >= ? ORDER BY b.created_at ASC`).all(since(_req));

  const claims = db.prepare('SELECT battle_id, user_id, claim, reason, proof FROM battle_claims').all();
  res.json({
    disputes: rows.map(b => ({ ...b, claims: claims.filter(c => c.battle_id === b.id) })),
  });
});

/* POST /api/admin/disputes/:id/resolve  { winnerId | 'refund', note? } */
router.post('/disputes/:id/resolve', requireAdmin('admin'), (req, res) => {
  const schema = z.object({
    outcome: z.enum(['creator', 'acceptor', 'refund']),
    note: z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose creator, acceptor or refund.' });
  const { outcome, note } = parsed.data;
  const id = req.params.id;

  try {
    db.transaction(() => {
      const b = db.prepare('SELECT * FROM battles WHERE id = ?').get(id);
      if (!b) throw new Error('NOTFOUND');
      if (b.status !== 'disputed') throw new Error('NOTDISPUTED');

      if (outcome === 'refund') {
        credit(b.creator_id, 'deposit', b.amount, 'Dispute refunded by support', id);
        credit(b.acceptor_id, 'deposit', b.amount, 'Dispute refunded by support', id);
        db.prepare("UPDATE battles SET status='cancelled', settled_at=? WHERE id=?").run(now(), id);
        [b.creator_id, b.acceptor_id].forEach(u =>
          notify(u, 'Dispute resolved', `Your ₹${b.amount} stake was refunded.${note ? ' ' + note : ''}`));
      } else {
        const winner = outcome === 'creator' ? b.creator_id : b.acceptor_id;
        const loser  = outcome === 'creator' ? b.acceptor_id : b.creator_id;
        const payout = Math.round(b.amount * 2 * (1 - getSettings().commission));
        credit(winner, 'winnings', payout, `Dispute resolved in your favour — #${id.slice(-5)}`, id);
        db.prepare("UPDATE battles SET status='completed', winner_id=?, payout=?, settled_at=? WHERE id=?")
          .run(winner, payout, now(), id);
        notify(winner, 'Dispute resolved — you won', `₹${payout} credited.${note ? ' ' + note : ''}`);
        notify(loser,  'Dispute resolved', `The battle was awarded to your opponent.${note ? ' ' + note : ''}`);
      }
    })();
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], NOTDISPUTED: [409, 'That battle is not disputed.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  audit(req.admin, 'dispute.resolve',
        { targetType: 'battle', targetId: id, detail: { outcome, note }, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- KYC ---------- */

router.get('/kyc', (_req, res) => {
  const rows = db.prepare(`SELECT id, name, phone, legal_name, kyc_status FROM users
                           WHERE kyc_status = 'pending' ORDER BY id`).all();
  const docs = db.prepare('SELECT user_id, slot, path FROM kyc_documents').all();
  res.json({ pending: rows.map(u => ({ ...u, documents: docs.filter(d => d.user_id === u.id) })) });
});

router.post('/kyc/:userId', requireAdmin('admin'), (req, res) => {
  const approve = req.body?.approve === true;
  const info = db.prepare("UPDATE users SET kyc_status = ? WHERE id = ? AND kyc_status = 'pending'")
    .run(approve ? 'done' : 'rejected', req.params.userId);
  if (!info.changes) return res.status(404).json({ error: 'No pending KYC for that user.' });
  notify(req.params.userId, approve ? 'KYC approved' : 'KYC rejected',
         approve ? 'Withdrawals are now unlocked.' : 'Please re-submit clearer documents.');
  audit(req.admin, approve ? 'kyc.approve' : 'kyc.reject',
        { targetType: 'user', targetId: req.params.userId, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- manual deposits ---------- */

router.get('/deposits', (_req, res) => {
  res.json({ pending: db.prepare(`
    SELECT d.*, u.name, u.phone FROM deposit_requests d JOIN users u ON u.id = d.user_id
    WHERE d.status = 'pending' ORDER BY d.created_at ASC`).all() });
});

router.post('/deposits/:id', requireAdmin('admin'), (req, res) => {
  const approve = req.body?.approve === true;
  try {
    db.transaction(() => {
      const d = db.prepare("SELECT * FROM deposit_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
      if (!d) throw new Error('NOTFOUND');
      db.prepare("UPDATE deposit_requests SET status = ?, settled_at = ?, note = ? WHERE id = ?")
        .run(approve ? 'approved' : 'rejected', now(), req.body?.note ?? null, d.id);
      if (approve) {
        credit(d.user_id, 'deposit', d.amount, `Deposit verified (UTR ${d.utr})`);
        notify(d.user_id, 'Deposit added', `₹${d.amount} credited to your wallet.`);
      } else {
        notify(d.user_id, 'Deposit rejected', 'Transaction rejected due to an invalid UTR number.');
      }
    })();
  } catch (e) {
    if (e.message === 'NOTFOUND') return res.status(404).json({ error: 'No such pending request.' });
    throw e;
  }
  audit(req.admin, approve ? 'deposit.approve' : 'deposit.reject',
        { targetType: 'deposit', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- penalties & bans ---------- */

router.post('/users/:id/penalty', requireAdmin('admin'), (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a whole-rupee amount.' });
  const w = db.prepare('SELECT deposit, winnings FROM wallets WHERE user_id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'User not found.' });
  const from = Math.min(w.winnings, amount);
  db.prepare('UPDATE wallets SET winnings = winnings - ?, deposit = deposit - ? WHERE user_id = ?')
    .run(from, amount - from, req.params.id);
  db.prepare(`INSERT INTO transactions (user_id, type, bucket, amount, note, status, created_at)
              VALUES (?,'debit','winnings',?,?, 'success', ?)`)
    .run(req.params.id, amount, req.body?.reason || 'Penalty', now());
  notify(req.params.id, 'Penalty applied', req.body?.reason || 'A penalty was applied to your account.');
  audit(req.admin, 'user.penalty', { targetType: 'user', targetId: req.params.id,
                                     detail: { amount, reason: req.body?.reason }, ip: req.clientIp });
  res.json({ ok: true });
});

router.post('/users/:id/ban', requireAdmin('admin'), (req, res) => {
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(req.body?.banned ? 1 : 0, req.params.id);
  audit(req.admin, req.body?.banned ? 'user.ban' : 'user.unban',
        { targetType: 'user', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- live chat (agent side) ---------- */

/* GET /api/admin/chats?status=open|resolved|blocked */
router.get('/chats', (req, res) => {
  const status = ['open', 'resolved', 'blocked'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`
    SELECT t.*, u.name, u.phone, u.kyc_status
    FROM chat_threads t JOIN users u ON u.id = t.user_id
    ${status ? 'WHERE t.status = ?' : ''}
    ORDER BY t.unread_admin DESC, t.last_at DESC NULLS LAST LIMIT 200`)
    .all(...(status ? [status] : []));
  res.json({
    threads: rows,
    waiting: db.prepare("SELECT COUNT(*) c FROM chat_threads WHERE unread_admin > 0").get().c,
  });
});

/* GET /api/admin/chats/:id */
router.get('/chats/:id', (req, res) => {
  const t = db.prepare(`SELECT t.*, u.name, u.phone FROM chat_threads t
                        JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Conversation not found.' });
  const messages = db.prepare(
    'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 300').all(t.id);
  // Opening a thread clears the agent-side unread count.
  db.prepare('UPDATE chat_threads SET unread_admin = 0 WHERE id = ?').run(t.id);
  res.json({ thread: t, messages });
});

/* POST /api/admin/chats/:id/reply  { body?, kind?, attachment? } */
router.post('/chats/:id/reply', requireAdmin('admin'), (req, res) => {
  const schema = z.object({
    body: z.string().trim().max(2000).optional(),
    kind: z.enum(['text', 'image', 'voice']).default('text'),
    attachment: z.string().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Reply could not be sent.' });
  const { body, kind, attachment } = parsed.data;
  if (kind === 'text' && !body) return res.status(400).json({ error: 'Type a reply first.' });

  const t = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Conversation not found.' });

  const preview = kind === 'text' ? body : kind === 'image' ? '📷 Photo' : '🎤 Voice message';
  const info = db.transaction(() => {
    const i = db.prepare(`INSERT INTO chat_messages
        (thread_id, from_admin, admin_id, author, kind, body, attachment, created_at)
        VALUES (?,1,?,?,?,?,?,?)`)
      .run(t.id, req.admin.id, req.admin.name, kind, body ?? null, attachment ?? null, now());
    db.prepare(`UPDATE chat_threads SET unread_user = unread_user + 1, last_message = ?, last_at = ?
                WHERE id = ?`).run(preview, now(), t.id);
    return i;
  })();

  const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(info.lastInsertRowid);
  const message = { id: row.id, fromAdmin: true, author: row.author, kind: row.kind,
                    body: row.body, attachment: row.attachment, at: row.created_at };
  const io = req.app.get('io');
  io?.to(`chat:${t.id}`).emit('chat:message', { threadId: t.id, message });
  // Reaches them even with the app closed.
  notify(t.user_id, 'Support replied', preview.slice(0, 80), { url: '/support.html' });
  audit(req.admin, 'chat.reply', { targetType: 'thread', targetId: String(t.id), ip: req.clientIp });
  res.status(201).json({ message });
});

/* POST /api/admin/chats/:id/status  { status } */
router.post('/chats/:id/status', requireAdmin('admin'), (req, res) => {
  const status = req.body?.status;
  if (!['open', 'resolved', 'blocked'].includes(status))
    return res.status(400).json({ error: 'Unknown status.' });
  db.prepare('UPDATE chat_threads SET status = ? WHERE id = ?').run(status, req.params.id);
  audit(req.admin, 'chat.status', { targetType: 'thread', targetId: req.params.id,
                                    detail: { status }, ip: req.clientIp });
  req.app.get('io')?.to(`chat:${req.params.id}`).emit('chat:status', { threadId: Number(req.params.id), status });
  res.json({ ok: true });
});

/* ---------- site switches ---------- */

router.get('/settings', (_req, res) => res.json({ settings: getSettings() }));

router.patch('/settings', requireAdmin('owner'), (req, res) => {
  const schema = z.object({
    withdraw_open: z.boolean().optional(),
    deposit_open: z.boolean().optional(),
    maintenance: z.boolean().optional(),
    notice: z.string().max(300).nullable().optional(),
    commission: z.number().min(0).max(0.3).optional(),
    battle_limit: z.number().int().min(1).max(10).optional(),
    referral_rate: z.number().min(0).max(0.2).optional(),
    upi_id: z.string().max(100).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid settings.' });
  const fields = Object.entries(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE settings SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = 1`)
    .run(...fields.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
  audit(req.admin, 'settings.update', { detail: parsed.data, ip: req.clientIp });
  res.json({ settings: getSettings() });
});

export default router;
