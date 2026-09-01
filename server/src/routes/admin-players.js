/* Admin — players, money reporting, fraud & risk (MongoDB). */
import { SafeRouter } from '../lib/safe-router.js';
import { z } from 'zod';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { col, nextId, now, audit, notify, withTransaction } from '../lib/db.js';
import { requireAdmin } from '../lib/admin-auth.js';
import { memoryStorage, ALLOWED_TYPES, saveFile } from '../lib/storage.js';
import { NOT_BOT } from '../lib/bots.js';

const qrUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_r, file, cb) => cb(null, ALLOWED_TYPES.has(file.mimetype)),
}).single('file');

const router = SafeRouter();
const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: null };
const since = req => { const s = RANGES[req.query.range]; return s ? Date.now() - s : 0; };

const sum = async (coll, match, field = 'amount') => {
  const r = await col(coll).aggregate([{ $match: match }, { $group: { _id: null, v: { $sum: '$' + field }, n: { $sum: 1 } } }]).toArray();
  return r[0] || { v: 0, n: 0 };
};

/* ---------------- PLAYERS ---------------- */
router.get('/players', async (req, res) => {
  const q = (req.query.q || '').trim();
  // Lobby bots are house accounts with no wallet activity — never players.
  let match = { ...NOT_BOT };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    match = { ...match, $or: [{ name: rx }, { phone: rx }, ...(Number.isInteger(Number(q)) ? [{ id: Number(q) }] : [])] };
  }
  const users = await col('users').find(match, { projection: { _id: 0, id: 1, name: 1, phone: 1, kyc_status: 1, banned: 1, created_at: 1 } })
    .sort({ created_at: -1 }).limit(50).toArray();
  const ids = users.map(u => u.id);
  const wallets = await col('wallets').find({ user_id: { $in: ids } }).toArray();
  const byId = Object.fromEntries(wallets.map(w => [w.user_id, w]));
  res.json({ players: users.map(u => ({ ...u, deposit: byId[u.id]?.deposit || 0, winnings: byId[u.id]?.winnings || 0, referral: byId[u.id]?.referral || 0 })) });
});

router.get('/players/:id', async (req, res) => {
  const id = Number(req.params.id);
  const u = await col('users').findOne({ id });
  if (!u) return res.status(404).json({ error: 'Player not found.' });
  const w = await col('wallets').findOne({ user_id: id }) || { deposit: 0, winnings: 0, referral: 0 };

  const played = await col('battles').countDocuments({ $or: [{ creator_id: id }, { acceptor_id: id }], status: { $in: ['completed', 'cancelled'] } });
  const settled = await col('battles').countDocuments({ $or: [{ creator_id: id }, { acceptor_id: id }], status: 'completed' });
  const won = await col('battles').countDocuments({ winner_id: id });
  const depAgg = await col('transactions').aggregate([
    { $match: { user_id: id, type: 'credit', note: /^Deposit/ } }, { $group: { _id: null, v: { $sum: '$amount' } } }]).toArray();
  const wdAgg = await col('transactions').aggregate([
    { $match: { user_id: id, type: 'debit', note: /^Withdrawal/ } }, { $group: { _id: null, v: { $sum: '$amount' } } }]).toArray();

  const recentTx = await col('transactions').find({ user_id: id }, { projection: { _id: 0, type: 1, bucket: 1, amount: 1, note: 1, status: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(20).toArray();

  const recentGames = await col('battles').aggregate([
    { $match: { $or: [{ creator_id: id }, { acceptor_id: id }] } },
    { $sort: { created_at: -1 } },
    { $limit: 40 },
    { $lookup: { from: 'users', localField: 'creator_id', foreignField: 'id', as: 'c' } },
    { $lookup: { from: 'users', localField: 'acceptor_id', foreignField: 'id', as: 'a' } },
    { $addFields: {
      creator_name: { $arrayElemAt: ['$c.name', 0] },
      creator_phone: { $arrayElemAt: ['$c.phone', 0] },
      acceptor_name: { $arrayElemAt: ['$a.name', 0] },
      acceptor_phone: { $arrayElemAt: ['$a.phone', 0] },
    } },
    { $project: { _id: 0, c: 0, a: 0 } },
  ]).toArray();

  const battleIds = recentGames.map(b => b.id);
  const claims = await col('battle_claims').find(
    { battle_id: { $in: battleIds } },
    { projection: { _id: 0, battle_id: 1, user_id: 1, claim: 1, reason: 1, proof: 1, created_at: 1 } }
  ).toArray();

  const gamesWithDetails = recentGames.map(b => ({
    id: b.id,
    mode: b.mode || 'lite',
    amount: b.amount,
    payout: b.payout,
    status: b.status,
    roomCode: b.room_code,
    creatorId: b.creator_id,
    creatorName: b.creator_name || ('Player' + String(b.creator_id).slice(-4)),
    creatorPhone: b.creator_phone || '',
    acceptorId: b.acceptor_id,
    acceptorName: b.acceptor_name || (b.acceptor_id ? 'Player' + String(b.acceptor_id).slice(-4) : '—'),
    acceptorPhone: b.acceptor_phone || '',
    isCreator: b.creator_id === id,
    winnerId: b.winner_id,
    isWinner: b.winner_id === id,
    isLoser: b.status === 'completed' && b.winner_id && b.winner_id !== id,
    createdAt: b.created_at,
    settledAt: b.settled_at,
    claims: claims.filter(c => c.battle_id === b.id),
  }));

  const devices = await col('login_events').find({ user_id: id }, { projection: { _id: 0, ip: 1, user_agent: 1, created_at: 1 } }).sort({ created_at: -1 }).limit(15).toArray();
  const refAgg = await col('referrals').aggregate([{ $match: { referrer_id: id } }, { $group: { _id: null, c: { $sum: 1 }, earned: { $sum: '$earned' } } }]).toArray();
  const watch = await col('watchlist').findOne({ user_id: id }, { projection: { _id: 0 } });
  const thread = await col('chat_threads').findOne({ user_id: id }, { projection: { _id: 0, id: 1, status: 1, unread_admin: 1 } });

  res.json({
    player: { id: u.id, name: u.name, phone: u.phone, email: u.email, avatar: u.avatar,
      kyc: u.kyc_status, kycMasked: u.kyc_masked, banned: !!u.banned,
      referralCode: u.referral_code, referredBy: u.referred_by, createdAt: u.created_at },
    wallet: { deposit: w.deposit, winnings: w.winnings, referral: w.referral, total: w.deposit + w.winnings },
    stats: { played, won, winRate: settled ? Math.round((won / settled) * 100) : 0,
      deposited: depAgg[0]?.v || 0, withdrawn: wdAgg[0]?.v || 0,
      referrals: refAgg[0]?.c || 0, referralEarned: refAgg[0]?.earned || 0 },
    recentTx, recentGames: gamesWithDetails, devices, watch: watch || null, thread: thread || null,
  });
});

/* POST /admin/players/:id/adjust
   mode 'adjust' (default) moves a bucket by ±amount.
   mode 'set' writes an exact new balance — an admin editing a player's money
   directly — and records the difference as the transaction, so the ledger
   still reconciles against the wallet. */
router.post('/players/:id/adjust', requireAdmin('admin'), async (req, res) => {
  const parsed = z.object({
    amount: z.number().int(),
    bucket: z.enum(['deposit', 'winnings', 'referral']).default('deposit'),
    mode: z.enum(['adjust', 'set']).default('adjust'),
    reason: z.string().trim().min(3).max(200),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { amount, bucket, mode, reason } = parsed.data;
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid player id.' });
  if (mode === 'set' && amount < 0) return res.status(400).json({ error: 'A balance cannot be negative.' });
  if (mode === 'adjust' && amount === 0) return res.status(400).json({ error: 'Enter a non-zero amount.' });

  const user = await col('users').findOne({ id }, { projection: { id: 1 } });
  if (!user) return res.status(404).json({ error: 'Player not found.' });

  const w = (await col('wallets').findOne({ user_id: id })) || { deposit: 0, winnings: 0, referral: 0 };
  const current = w[bucket] || 0;
  const delta = mode === 'set' ? amount - current : amount;

  if (delta === 0) {
    return res.json({ ok: true, unchanged: true,
      wallet: { deposit: w.deposit || 0, winnings: w.winnings || 0, referral: w.referral || 0 } });
  }
  if (current + delta < 0) {
    return res.status(400).json({ error: `That would take ${bucket} below zero (currently ₹${current}).` });
  }

  await withTransaction(async session => {
    await col('wallets').updateOne({ user_id: id },
      { $inc: { [bucket]: delta }, $setOnInsert: { user_id: id } }, { upsert: true, session });
    await col('transactions').insertOne({
      id: await nextId('transactions'), user_id: id,
      type: delta > 0 ? 'credit' : 'debit', bucket, amount: Math.abs(delta),
      note: mode === 'set' ? `Admin set ${bucket} to ₹${amount}: ${reason}` : `Admin adjust: ${reason}`,
      status: 'success', ref_id: null, created_at: now(),
    }, { session });
  });

  await notify(id, 'Wallet updated',
    delta > 0 ? `₹${Math.abs(delta)} was added to your ${bucket} balance.`
              : `₹${Math.abs(delta)} was deducted from your ${bucket} balance.`);
  await audit(req.admin, 'wallet.adjust', { targetType: 'user', targetId: String(id),
    detail: { mode, bucket, requested: amount, delta, from: current, to: current + delta, reason }, ip: req.clientIp });

  const after = await col('wallets').findOne({ user_id: id },
    { projection: { _id: 0, deposit: 1, winnings: 1, referral: 1 } });
  res.json({ ok: true, from: current, to: current + delta, delta, wallet: after });
});

router.post('/players/:id/logout', requireAdmin('admin'), async (req, res) => {
  const r = await col('users').updateOne({ id: Number(req.params.id) }, { $inc: { session_epoch: 1 } });
  if (!r.matchedCount) return res.status(404).json({ error: 'Player not found.' });
  await audit(req.admin, 'user.force_logout', { targetType: 'user', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------------- WATCHLIST ---------------- */
router.get('/watchlist', async (_req, res) => {
  const rows = await col('watchlist').find({}, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray();
  const ids = rows.map(r => r.user_id);
  const users = await col('users').find({ id: { $in: ids } }, { projection: { _id: 0, id: 1, name: 1, phone: 1 } }).toArray();
  const byId = Object.fromEntries(users.map(u => [u.id, u]));
  res.json({ watchlist: rows.map(r => ({ ...r, name: byId[r.user_id]?.name, phone: byId[r.user_id]?.phone })) });
});

router.post('/players/:id/watch', requireAdmin('admin'), async (req, res) => {
  const on = req.body?.watch !== false;
  const id = Number(req.params.id);
  if (on) {
    await col('watchlist').updateOne({ user_id: id },
      { $set: { reason: req.body?.reason || null, added_by: req.admin.username },
        $setOnInsert: { user_id: id, created_at: now() } }, { upsert: true });
  } else {
    await col('watchlist').deleteOne({ user_id: id });
  }
  await audit(req.admin, on ? 'watchlist.add' : 'watchlist.remove', { targetType: 'user', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------------- MONEY & REPORTING ---------------- */
router.get('/charts', async (req, res) => {
  const from = since(req) || (Date.now() - 30 * 864e5);
  const day = 864e5;
  const byDay = {};
  const put = (k, key, v) => { byDay[k] = byDay[k] || { date: k, deposits: 0, withdrawals: 0, signups: 0, commission: 0 }; byDay[k][key] = v; };

  const tx = await col('transactions').aggregate([
    { $match: { created_at: { $gte: from } } },
    { $group: { _id: { $floor: { $divide: ['$created_at', day] } },
        deposits: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'credit'] }, { $eq: ['$bucket', 'deposit'] }, { $regexMatch: { input: '$note', regex: /^Deposit/ } }] }, '$amount', 0] } },
        withdrawals: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'debit'] }, { $eq: ['$status', 'success'] }, { $regexMatch: { input: '$note', regex: /^Withdrawal/ } }] }, '$amount', 0] } } } },
  ]).toArray();
  tx.forEach(r => { put(r._id * day, 'deposits', r.deposits); put(r._id * day, 'withdrawals', r.withdrawals); });
  const signups = await col('users').aggregate([
    { $match: { created_at: { $gte: from }, ...NOT_BOT } },
    { $group: { _id: { $floor: { $divide: ['$created_at', day] } }, n: { $sum: 1 } } }]).toArray();
  signups.forEach(r => put(r._id * day, 'signups', r.n));
  const commission = await col('battles').aggregate([
    { $match: { status: 'completed', settled_at: { $gte: from }, ...NOT_BOT } },
    { $group: { _id: { $floor: { $divide: ['$settled_at', day] } }, c: { $sum: { $subtract: [{ $multiply: ['$amount', 2] }, { $ifNull: ['$payout', 0] }] } } } }]).toArray();
  commission.forEach(r => put(r._id * day, 'commission', r.c));
  res.json({ series: Object.values(byDay).sort((a, b) => a.date - b.date) });
});

router.get('/revenue', async (req, res) => {
  const from = since(req);
  const s = await sum('battles', { status: 'completed', settled_at: { $gte: from }, ...NOT_BOT });
  const paid = (await sum('battles', { status: 'completed', settled_at: { $gte: from }, ...NOT_BOT }, 'payout')).v;
  const referralPaid = (await sum('transactions', { bucket: 'referral', type: 'credit', created_at: { $gte: from } })).v;
  const commission = Math.max(0, s.v * 2 - paid);
  res.json({ range: req.query.range || 'all', battlesSettled: s.n, totalStaked: s.v * 2,
    totalPaidOut: paid, grossCommission: commission, referralPaid, netRevenue: commission - referralPaid });
});

router.get('/pending-money', async (_req, res) => {
  res.json({
    openStakes: await sum('battles', { status: { $in: ['open', 'waiting', 'running'] }, ...NOT_BOT }),
    pendingWithdrawals: await sum('withdrawal_requests', { status: 'pending' }),
    pendingDeposits: await sum('deposit_requests', { status: 'pending' }),
    disputed: await sum('battles', { status: 'disputed', ...NOT_BOT }),
  });
});

router.get('/reconcile', async (_req, res) => {
  /* Single aggregation: compute ledger balance per user per bucket,
     then compare against the wallets collection via $lookup. */
  const ledger = await col('transactions').aggregate([
    { $match: { status: { $ne: 'failed' } } },
    { $group: {
      _id: { user_id: '$user_id', bucket: '$bucket' },
      balance: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$amount', { $multiply: ['$amount', -1] }] } },
    } },
  ]).toArray();

  // Build a map: userId -> { deposit, winnings, referral }
  const ledgerMap = {};
  for (const r of ledger) {
    const uid = r._id.user_id;
    if (!ledgerMap[uid]) ledgerMap[uid] = { deposit: 0, winnings: 0, referral: 0 };
    ledgerMap[uid][r._id.bucket] = r.balance;
  }

  const wallets = await col('wallets').find({}, { projection: { _id: 0, user_id: 1, deposit: 1, winnings: 1, referral: 1 } }).toArray();
  const mismatches = [];
  for (const w of wallets) {
    const led = ledgerMap[w.user_id] || { deposit: 0, winnings: 0, referral: 0 };
    for (const bucket of ['deposit', 'winnings', 'referral']) {
      if (w[bucket] !== led[bucket]) {
        mismatches.push({ userId: w.user_id, bucket, wallet: w[bucket], ledger: led[bucket], diff: w[bucket] - led[bucket] });
      }
    }
  }
  res.json({ ok: mismatches.length === 0, checked: wallets.length, mismatches });
});

/* ---------------- FRAUD & RISK ---------------- */
router.get('/fraud/multi-account', async (_req, res) => {
  const rows = await col('login_events').aggregate([
    { $match: { ip: { $nin: [null, ''] } } },
    { $group: { _id: '$ip', users: { $addToSet: '$user_id' } } },
    { $match: { $expr: { $gt: [{ $size: '$users' }, 1] } } },
    { $sort: { 'users.length': -1 } }, { $limit: 50 },
  ]).toArray();
  const groups = [];
  for (const r of rows) {
    const users = await col('users').find({ id: { $in: r.users.slice(0, 10) } }, { projection: { _id: 0, id: 1, name: 1, phone: 1 } }).toArray();
    groups.push({ ip: r._id, count: r.users.length, users });
  }
  res.json({ groups });
});

router.get('/fraud/collusion', async (_req, res) => {
  const rows = await col('battles').aggregate([
    { $match: { status: 'completed', acceptor_id: { $ne: null }, ...NOT_BOT } },
    { $project: { winner_id: 1,
        a: { $min: ['$creator_id', '$acceptor_id'] }, b: { $max: ['$creator_id', '$acceptor_id'] } } },
    { $group: { _id: { a: '$a', b: '$b' }, games: { $sum: 1 },
        aWins: { $sum: { $cond: [{ $eq: ['$winner_id', '$a'] }, 1, 0] } } } },
    { $match: { games: { $gte: 3 } } }, { $sort: { games: -1 } }, { $limit: 50 },
  ]).toArray();
  const flagged = [];
  for (const r of rows) {
    const skew = Math.abs(r.aWins / r.games - 0.5);
    const risk = skew > 0.4 ? 'high' : skew > 0.25 ? 'medium' : 'low';
    if (risk === 'low') continue;
    const ua = await col('users').findOne({ id: r._id.a }, { projection: { name: 1 } });
    const ub = await col('users').findOne({ id: r._id.b }, { projection: { name: 1 } });
    flagged.push({ a: r._id.a, aName: ua?.name, b: r._id.b, bName: ub?.name, games: r.games, aWins: r.aWins, bWins: r.games - r.aWins, risk });
  }
  res.json({ pairs: flagged });
});

router.get('/withdrawals/risk', async (_req, res) => {
  const pend = await col('withdrawal_requests').find({ status: 'pending' }).sort({ created_at: 1 }).toArray();
  if (!pend.length) return res.json({ withdrawals: [] });

  const userIds = [...new Set(pend.map(w => w.user_id))];

  // Batch all lookups in parallel
  const [users, winCounts, priorWdCounts, loginEvents] = await Promise.all([
    col('users').find({ id: { $in: userIds } }, { projection: { id: 1, name: 1, phone: 1, created_at: 1, kyc_status: 1 } }).toArray(),
    col('battles').aggregate([
      { $match: { winner_id: { $in: userIds } } },
      { $group: { _id: '$winner_id', count: { $sum: 1 } } },
    ]).toArray(),
    col('withdrawal_requests').aggregate([
      { $match: { user_id: { $in: userIds }, status: 'paid' } },
      { $group: { _id: '$user_id', count: { $sum: 1 } } },
    ]).toArray(),
    col('login_events').find({ user_id: { $in: userIds }, ip: { $nin: [null, ''] } },
      { projection: { user_id: 1, ip: 1 } }).toArray(),
  ]);

  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  const winMap = Object.fromEntries(winCounts.map(r => [r._id, r.count]));
  const wdMap = Object.fromEntries(priorWdCounts.map(r => [r._id, r.count]));

  // Build per-user IP sets and count shared IPs
  const ipsByUser = {};
  const usersByIp = {};
  for (const le of loginEvents) {
    if (!ipsByUser[le.user_id]) ipsByUser[le.user_id] = new Set();
    ipsByUser[le.user_id].add(le.ip);
    if (!usersByIp[le.ip]) usersByIp[le.ip] = new Set();
    usersByIp[le.ip].add(le.user_id);
  }

  const scored = pend.map(w => {
    const u = userMap[w.user_id];
    const reasons = []; let score = 0;
    const ageDays = (Date.now() - (u?.created_at || 0)) / 864e5;
    if (ageDays < 1) { score += 40; reasons.push('account < 1 day old'); }
    else if (ageDays < 7) { score += 15; reasons.push('account < 1 week old'); }
    if (!(winMap[w.user_id] > 0)) { score += 35; reasons.push('no games won'); }
    if (!(wdMap[w.user_id] > 0)) { score += 10; reasons.push('first withdrawal'); }
    if (w.amount >= 10000) { score += 20; reasons.push('large amount'); }
    if (u?.kyc_status !== 'done') { score += 30; reasons.push('KYC not complete'); }
    const myIps = ipsByUser[w.user_id] || new Set();
    let sharedCount = 0;
    for (const ip of myIps) {
      const others = usersByIp[ip];
      if (others) for (const uid of others) { if (uid !== w.user_id) sharedCount++; }
    }
    if (sharedCount > 0) { score += 15; reasons.push(`shares device with ${sharedCount} login(s)`); }
    return { ...w, name: u?.name, phone: u?.phone, riskScore: Math.min(100, score),
      riskLevel: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', reasons };
  });

  res.json({ withdrawals: scored });
});

/* Legacy single deposit QR (kept; multi-UPI lives in payments.js). */
router.post('/deposit-qr', requireAdmin('owner'), (req, res) => {
  qrUpload(req, res, async err => {
    if (err) return res.status(400).json({ error: 'Upload failed (PNG/JPG/WebP, max 3MB).' });
    if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
    const url = await saveFile(req.file, 'qr-settings');
    await col('settings').updateOne({ id: 1 }, { $set: { qr_image: url } });
    await audit(req.admin, 'settings.qr', { detail: { url }, ip: req.clientIp });
    res.status(201).json({ url });
  });
});

export default router;
