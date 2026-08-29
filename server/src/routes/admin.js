/* Admin — accounts, disputes, KYC, deposits, withdrawals, chat, settings (MongoDB). */
import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { col, nextId, now, credit, notify, getSettings, audit, withTransaction } from '../lib/db.js';
import { verifyLogin, signAdmin, requireAdmin, createAdmin, adminCount, ROLES } from '../lib/admin-auth.js';
import playerRoutes from './admin-players.js';
import paymentAdminRoutes from './payments.js';

const router = express.Router();

const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: null };
const since = req => { const s = RANGES[req.query.range]; return s ? Date.now() - s : 0; };
const ip = req => req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

/* Join user name/phone onto a list of docs by a user-id field. */
async function withUser(rows, field = 'user_id') {
  const ids = [...new Set(rows.map(r => r[field]).filter(v => v != null))];
  const users = await col('users').find({ id: { $in: ids } },
    { projection: { _id: 0, id: 1, name: 1, phone: 1, kyc_status: 1 } }).toArray();
  const byId = Object.fromEntries(users.map(u => [u.id, u]));
  return rows.map(r => ({ ...r, name: byId[r[field]]?.name, phone: byId[r[field]]?.phone, kyc_status: byId[r[field]]?.kyc_status }));
}

/* ---------- sign in ---------- */
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await verifyLogin(username, password);
  if (!admin) {
    await audit({ username: String(username || 'unknown') }, 'login.failed', { ip: ip(req) });
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  await audit(admin, 'login', { ip: ip(req) });
  res.json({ token: signAdmin(admin), admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role } });
});

router.get('/bootstrap', async (_req, res) => res.json({ needsSetup: (await adminCount()) === 0 }));

router.use(requireAdmin('viewer'));
router.use(playerRoutes);
router.use(paymentAdminRoutes);

router.get('/me', (req, res) => res.json({
  admin: { id: req.admin.id, username: req.admin.username, name: req.admin.name, role: req.admin.role } }));

/* ---------- audit ---------- */
router.get('/audit', requireAdmin('admin'), async (req, res) => {
  const rows = await col('audit_log').find({ created_at: { $gte: since(req) } }, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(300).toArray();
  res.json({ entries: rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
});

/* ---------- admin management ---------- */
router.get('/admins', requireAdmin('owner'), async (_req, res) => {
  const admins = await col('admin_users').find({},
    { projection: { _id: 0, id: 1, username: 1, name: 1, role: 1, active: 1, last_login_at: 1, created_at: 1 } })
    .sort({ id: 1 }).toArray();
  res.json({ admins });
});

router.post('/admins', requireAdmin('owner'), async (req, res) => {
  try {
    const a = await createAdmin(req.body || {});
    await audit(req.admin, 'admin.create', { targetType: 'admin', targetId: String(a.id),
      detail: { username: a.username, role: a.role }, ip: req.clientIp });
    res.status(201).json({ admin: a });
  } catch (e) {
    if (e.code === 'UNIQUE') return res.status(409).json({ error: 'That username is taken.' });
    res.status(400).json({ error: e.message });
  }
});

router.patch('/admins/:id', requireAdmin('owner'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.admin.id && req.body?.active === false)
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  const set = {};
  if (typeof req.body?.active === 'boolean') set.active = req.body.active ? 1 : 0;
  if (ROLES.includes(req.body?.role)) set.role = req.body.role;
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  await col('admin_users').updateOne({ id }, { $set: set });
  await audit(req.admin, 'admin.update', { targetType: 'admin', targetId: String(id), detail: req.body, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- overview stats ---------- */
router.get('/stats', async (req, res) => {
  const from = since(req);
  const sumWhere = async (coll, match, field = 'amount') => {
    const r = await col(coll).aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: '$' + field } } }]).toArray();
    return r[0]?.v || 0;
  };

  const [battleAgg, settledAgg, users, kycPending,
         instantDep, pendingDep, approvedDep,
         pendingWd, pendingWdVal, paidWd] = await Promise.all([
    col('battles').aggregate([
      { $match: { created_at: { $gte: from } } },
      { $group: { _id: '$status', n: { $sum: 1 }, staked: { $sum: '$amount' } } },
    ]).toArray(),
    col('battles').aggregate([
      { $match: { status: 'completed', settled_at: { $gte: from } } },
      { $group: { _id: null, staked: { $sum: '$amount' }, paid: { $sum: { $ifNull: ['$payout', 0] } } } },
    ]).toArray(),
    col('users').countDocuments({ created_at: { $gte: from } }),
    col('users').countDocuments({ kyc_status: 'pending' }),
    sumWhere('transactions', { type: 'credit', bucket: 'deposit', note: { $in: ['Deposit', 'Cashback bonus'] }, created_at: { $gte: from } }),
    col('deposit_requests').countDocuments({ status: 'pending', created_at: { $gte: from } }),
    sumWhere('deposit_requests', { status: 'approved', created_at: { $gte: from } }),
    col('withdrawal_requests').countDocuments({ status: 'pending', created_at: { $gte: from } }),
    sumWhere('withdrawal_requests', { status: 'pending', created_at: { $gte: from } }),
    sumWhere('withdrawal_requests', { status: 'paid', created_at: { $gte: from } }),
  ]);

  const byStatus = Object.fromEntries(battleAgg.map(b => [b._id, b.n]));
  const settled = settledAgg[0] || { staked: 0, paid: 0 };

  res.json({
    range: req.query.range || 'all',
    users,
    battles: {
      total: battleAgg.reduce((s, b) => s + b.n, 0),
      open: byStatus.open || 0, waiting: byStatus.waiting || 0, running: byStatus.running || 0,
      completed: byStatus.completed || 0, cancelled: byStatus.cancelled || 0, disputed: byStatus.disputed || 0,
    },
    commission: Math.max(0, settled.staked * 2 - settled.paid),
    deposits: {
      instant: instantDep,
      pending: pendingDep,
      approved: approvedDep,
    },
    withdrawals: {
      pending: pendingWd,
      pendingValue: pendingWdVal,
      paid: paidWd,
    },
    kycPending,
  });
});

/* ---------- games ---------- */
router.get('/battles', async (req, res) => {
  const from = since(req);
  const status = ['open','waiting','running','completed','cancelled','disputed'].includes(req.query.status) ? req.query.status : null;
  const q = (req.query.q || '').trim();
  const match = { created_at: { $gte: from }, ...(status ? { status } : {}) };
  let rows = await col('battles').aggregate([
    { $match: match },
    { $sort: { created_at: -1 } }, { $limit: 300 },
    { $lookup: { from: 'users', localField: 'creator_id', foreignField: 'id', as: 'c' } },
    { $lookup: { from: 'users', localField: 'acceptor_id', foreignField: 'id', as: 'a' } },
    { $addFields: { creator_name: { $arrayElemAt: ['$c.name', 0] }, acceptor_name: { $arrayElemAt: ['$a.name', 0] } } },
    { $project: { _id: 0, c: 0, a: 0 } },
  ]).toArray();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    rows = rows.filter(b => rx.test(b.creator_name || '') || rx.test(b.acceptor_name || '') || rx.test(b.id) || rx.test(b.room_code || ''));
  }
  const battleIds = rows.map(b => b.id);
  const claims = await col('battle_claims').find({ battle_id: { $in: battleIds } }, { projection: { _id: 0, battle_id: 1, user_id: 1, claim: 1, reason: 1, proof: 1 } }).toArray();
  res.json({ battles: rows.map(b => ({ ...b, claims: claims.filter(c => c.battle_id === b.id) })) });
});

/* ---------- money lists ---------- */
router.get('/deposits/all', async (req, res) => {
  const from = since(req);
  const status = ['pending','approved','rejected'].includes(req.query.status) ? req.query.status : null;
  const reqRows = await withUser(await col('deposit_requests')
    .find({ created_at: { $gte: from }, ...(status ? { status } : {}) }, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(300).toArray());
  const instant = await withUser(await col('transactions')
    .find({ type: 'credit', bucket: 'deposit', note: { $in: ['Deposit', 'Cashback bonus'] }, created_at: { $gte: from } },
      { projection: { _id: 0, id: 1, amount: 1, created_at: 1, note: 1, user_id: 1 } })
    .sort({ created_at: -1 }).limit(300).toArray());
  res.json({ requests: reqRows, instant });
});

router.get('/withdrawals', async (req, res) => {
  const from = since(req);
  const status = ['pending','paid','rejected'].includes(req.query.status) ? req.query.status : null;
  const rows = await withUser(await col('withdrawal_requests')
    .find({ created_at: { $gte: from }, ...(status ? { status } : {}) }, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(300).toArray());
  res.json({ withdrawals: rows });
});

router.post('/withdrawals/:id', requireAdmin('admin'), async (req, res) => {
  const approve = req.body?.approve === true;
  try {
    await withTransaction(async session => {
      const w = await col('withdrawal_requests').findOne({ id: Number(req.params.id), status: 'pending' }, { session });
      if (!w) throw new Error('NOTFOUND');
      await col('withdrawal_requests').updateOne({ id: w.id },
        { $set: { status: approve ? 'paid' : 'rejected', settled_at: now(), note: req.body?.note ?? null } }, { session });
      await col('transactions').updateOne(
        { user_id: w.user_id, type: 'debit', status: 'pending', amount: w.amount },
        { $set: { status: approve ? 'success' : 'failed' } }, { session });
      if (!approve) await col('wallets').updateOne({ user_id: w.user_id }, { $inc: { winnings: w.amount } }, { session });
      req._wd = w;
    });
  } catch (e) {
    if (e.message === 'NOTFOUND') return res.status(404).json({ error: 'No such pending withdrawal.' });
    throw e;
  }
  const w = req._wd;
  if (approve) await notify(w.user_id, 'Withdrawal successful', `₹${w.amount} has been sent.`);
  else await notify(w.user_id, 'Withdrawal rejected', req.body?.note || 'The amount was returned to your winnings.');
  await audit(req.admin, approve ? 'withdrawal.paid' : 'withdrawal.reject',
    { targetType: 'withdrawal', targetId: req.params.id, detail: { note: req.body?.note }, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- disputes ---------- */
router.get('/disputes', async (req, res) => {
  const rows = await col('battles').aggregate([
    { $match: { status: 'disputed', created_at: { $gte: since(req) } } },
    { $sort: { created_at: 1 } },
    { $lookup: { from: 'users', localField: 'creator_id', foreignField: 'id', as: 'c' } },
    { $lookup: { from: 'users', localField: 'acceptor_id', foreignField: 'id', as: 'a' } },
    { $addFields: { creator_name: { $arrayElemAt: ['$c.name', 0] }, acceptor_name: { $arrayElemAt: ['$a.name', 0] } } },
    { $project: { _id: 0, id: 1, amount: 1, mode: 1, room_code: 1, created_at: 1, creator_id: 1, acceptor_id: 1, creator_name: 1, acceptor_name: 1 } },
  ]).toArray();
  const disputeIds = rows.map(b => b.id);
  const claims = await col('battle_claims').find({ battle_id: { $in: disputeIds } }, { projection: { _id: 0, battle_id: 1, user_id: 1, claim: 1, reason: 1, proof: 1 } }).toArray();
  res.json({ disputes: rows.map(b => ({ ...b, claims: claims.filter(c => c.battle_id === b.id) })) });
});

router.post('/disputes/:id/resolve', requireAdmin('admin'), async (req, res) => {
  const parsed = z.object({ outcome: z.enum(['creator', 'acceptor', 'refund']), note: z.string().max(300).optional() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Choose creator, acceptor or refund.' });
  const { outcome, note } = parsed.data;
  const id = req.params.id;
  const notes = [];
  try {
    await withTransaction(async session => {
      const b = await col('battles').findOne({ id }, { session });
      if (!b) throw new Error('NOTFOUND');
      if (b.status !== 'disputed') throw new Error('NOTDISPUTED');
      if (outcome === 'refund') {
        await credit(b.creator_id, 'deposit', b.amount, 'Dispute refunded by support', id, 'success', session);
        await credit(b.acceptor_id, 'deposit', b.amount, 'Dispute refunded by support', id, 'success', session);
        await col('battles').updateOne({ id }, { $set: { status: 'cancelled', settled_at: now() } }, { session });
        [b.creator_id, b.acceptor_id].forEach(u => notes.push([u, 'Dispute resolved', `Your ₹${b.amount} stake was refunded.${note ? ' ' + note : ''}`]));
      } else {
        const winner = outcome === 'creator' ? b.creator_id : b.acceptor_id;
        const loser = outcome === 'creator' ? b.acceptor_id : b.creator_id;
        const payout = Math.round(b.amount * 2 * (1 - (await getSettings()).commission));
        await credit(winner, 'winnings', payout, `Dispute resolved in your favour — #${id.slice(-5)}`, id, 'success', session);
        await col('battles').updateOne({ id }, { $set: { status: 'completed', winner_id: winner, payout, settled_at: now() } }, { session });
        notes.push([winner, 'Dispute resolved — you won', `₹${payout} credited.${note ? ' ' + note : ''}`],
                   [loser, 'Dispute resolved', `The battle was awarded to your opponent.${note ? ' ' + note : ''}`]);
      }
    });
  } catch (e) {
    const map = { NOTFOUND: [404, 'Battle not found.'], NOTDISPUTED: [409, 'That battle is not disputed.'] };
    if (map[e.message]) return res.status(map[e.message][0]).json({ error: map[e.message][1] });
    throw e;
  }
  for (const [u, t, b] of notes) await notify(u, t, b);
  await audit(req.admin, 'dispute.resolve', { targetType: 'battle', targetId: id, detail: { outcome, note }, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- KYC ---------- */
router.get('/kyc', async (_req, res) => {
  const rows = await col('users').find({ kyc_status: 'pending' },
    { projection: { _id: 0, id: 1, name: 1, phone: 1, legal_name: 1, kyc_status: 1 } }).sort({ id: 1 }).toArray();
  const kycIds = rows.map(u => u.id);
  const docs = await col('kyc_documents').find({ user_id: { $in: kycIds } }, { projection: { _id: 0, user_id: 1, slot: 1, path: 1 } }).toArray();
  res.json({ pending: rows.map(u => ({ ...u, documents: docs.filter(d => d.user_id === u.id) })) });
});

router.post('/kyc/:userId', requireAdmin('admin'), async (req, res) => {
  const approve = req.body?.approve === true;
  const r = await col('users').updateOne({ id: Number(req.params.userId), kyc_status: 'pending' },
    { $set: { kyc_status: approve ? 'done' : 'rejected' } });
  if (!r.matchedCount) return res.status(404).json({ error: 'No pending KYC for that user.' });
  await notify(Number(req.params.userId), approve ? 'KYC approved' : 'KYC rejected',
    approve ? 'Withdrawals are now unlocked.' : 'Please re-submit clearer documents.');
  await audit(req.admin, approve ? 'kyc.approve' : 'kyc.reject', { targetType: 'user', targetId: req.params.userId, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- manual deposits ---------- */
router.get('/deposits', async (_req, res) => {
  const rows = await withUser(await col('deposit_requests').find({ status: 'pending' }, { projection: { _id: 0 } }).sort({ created_at: 1 }).toArray());
  res.json({ pending: rows });
});

router.post('/deposits/:id', requireAdmin('admin'), async (req, res) => {
  const approve = req.body?.approve === true;
  let d;
  try {
    await withTransaction(async session => {
      d = await col('deposit_requests').findOne({ id: Number(req.params.id), status: 'pending' }, { session });
      if (!d) throw new Error('NOTFOUND');
      await col('deposit_requests').updateOne({ id: d.id },
        { $set: { status: approve ? 'approved' : 'rejected', settled_at: now(), note: req.body?.note ?? null } }, { session });
      if (approve) await credit(d.user_id, 'deposit', d.amount, `Deposit verified (UTR ${d.utr})`, null, 'success', session);
    });
  } catch (e) {
    if (e.message === 'NOTFOUND') return res.status(404).json({ error: 'No such pending request.' });
    throw e;
  }
  if (approve) await notify(d.user_id, 'Deposit added', `₹${d.amount} credited to your wallet.`);
  else await notify(d.user_id, 'Deposit rejected', 'Transaction rejected due to an invalid UTR number.');
  await audit(req.admin, approve ? 'deposit.approve' : 'deposit.reject', { targetType: 'deposit', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- penalties & bans ---------- */
router.post('/users/:id/penalty', requireAdmin('admin'), async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a whole-rupee amount.' });
  const uid = Number(req.params.id);
  const w = await col('wallets').findOne({ user_id: uid });
  if (!w) return res.status(404).json({ error: 'User not found.' });
  const fromWin = Math.min(w.winnings, amount);
  await col('wallets').updateOne({ user_id: uid }, { $inc: { winnings: -fromWin, deposit: -(amount - fromWin) } });
  await col('transactions').insertOne({ id: await nextId('transactions'), user_id: uid, type: 'debit',
    bucket: 'winnings', amount, note: req.body?.reason || 'Penalty', status: 'success', ref_id: null, created_at: now() });
  await notify(uid, 'Penalty applied', req.body?.reason || 'A penalty was applied to your account.');
  await audit(req.admin, 'user.penalty', { targetType: 'user', targetId: req.params.id, detail: { amount, reason: req.body?.reason }, ip: req.clientIp });
  res.json({ ok: true });
});

router.post('/users/:id/ban', requireAdmin('admin'), async (req, res) => {
  await col('users').updateOne({ id: Number(req.params.id) }, { $set: { banned: req.body?.banned ? 1 : 0 } });
  await audit(req.admin, req.body?.banned ? 'user.ban' : 'user.unban', { targetType: 'user', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------- live chat (agent side) ---------- */
router.get('/chats', async (req, res) => {
  const status = ['open', 'resolved', 'blocked'].includes(req.query.status) ? req.query.status : null;
  const rows = await withUser(await col('chat_threads').find(status ? { status } : {}, { projection: { _id: 0 } })
    .sort({ unread_admin: -1, last_at: -1 }).limit(200).toArray());
  res.json({ threads: rows, waiting: await col('chat_threads').countDocuments({ unread_admin: { $gt: 0 } }) });
});

router.get('/chats/:id', async (req, res) => {
  const t = await col('chat_threads').findOne({ id: Number(req.params.id) });
  if (!t) return res.status(404).json({ error: 'Conversation not found.' });
  const u = await col('users').findOne({ id: t.user_id }, { projection: { _id: 0, name: 1, phone: 1 } });
  const messages = await col('chat_messages').find({ thread_id: t.id }, { projection: { _id: 0 } }).sort({ created_at: 1 }).limit(300).toArray();
  await col('chat_threads').updateOne({ id: t.id }, { $set: { unread_admin: 0 } });
  res.json({ thread: { ...t, name: u?.name, phone: u?.phone }, messages });
});

router.post('/chats/:id/reply', requireAdmin('admin'), async (req, res) => {
  const parsed = z.object({ body: z.string().trim().max(2000).optional(), kind: z.enum(['text', 'image', 'voice']).default('text'), attachment: z.string().max(400).optional() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Reply could not be sent.' });
  const { body, kind, attachment } = parsed.data;
  if (kind === 'text' && !body) return res.status(400).json({ error: 'Type a reply first.' });
  const t = await col('chat_threads').findOne({ id: Number(req.params.id) });
  if (!t) return res.status(404).json({ error: 'Conversation not found.' });

  const preview = kind === 'text' ? body : kind === 'image' ? '📷 Photo' : '🎤 Voice message';
  const row = { id: await nextId('chat_messages'), thread_id: t.id, from_admin: 1, admin_id: req.admin.id,
    author: req.admin.name, kind, body: body ?? null, attachment: attachment ?? null, duration: null, read_at: null, created_at: now() };
  await col('chat_messages').insertOne(row);
  await col('chat_threads').updateOne({ id: t.id }, { $inc: { unread_user: 1 }, $set: { last_message: preview, last_at: now() } });

  const message = { id: row.id, fromAdmin: true, author: row.author, kind: row.kind, body: row.body, attachment: row.attachment, at: row.created_at };
  req.app.get('io')?.to(`chat:${t.id}`).emit('chat:message', { threadId: t.id, message });
  await notify(t.user_id, 'Support replied', preview.slice(0, 80), { url: '/support.html' });
  await audit(req.admin, 'chat.reply', { targetType: 'thread', targetId: String(t.id), ip: req.clientIp });
  res.status(201).json({ message });
});

router.post('/chats/:id/status', requireAdmin('admin'), async (req, res) => {
  const status = req.body?.status;
  if (!['open', 'resolved', 'blocked'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  await col('chat_threads').updateOne({ id: Number(req.params.id) }, { $set: { status } });
  await audit(req.admin, 'chat.status', { targetType: 'thread', targetId: req.params.id, detail: { status }, ip: req.clientIp });
  req.app.get('io')?.to(`chat:${req.params.id}`).emit('chat:status', { threadId: Number(req.params.id), status });
  res.json({ ok: true });
});

/* ---------- settings ---------- */
router.get('/settings', async (_req, res) => res.json({ settings: await getSettings() }));

router.patch('/settings', requireAdmin('owner'), async (req, res) => {
  const parsed = z.object({
    withdraw_open: z.boolean().optional(), deposit_open: z.boolean().optional(), maintenance: z.boolean().optional(),
    notice: z.string().max(300).nullable().optional(), commission: z.number().min(0).max(0.3).optional(),
    battle_limit: z.number().int().min(1).max(10).optional(), referral_rate: z.number().min(0).max(0.2).optional(),
    upi_id: z.string().max(100).optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid settings.' });
  const entries = Object.entries(parsed.data);
  if (!entries.length) return res.status(400).json({ error: 'Nothing to update.' });
  const set = Object.fromEntries(entries.map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 1 : 0) : v]));
  await col('settings').updateOne({ id: 1 }, { $set: set });
  await audit(req.admin, 'settings.update', { detail: parsed.data, ip: req.clientIp });
  res.json({ settings: await getSettings() });
});

export default router;
