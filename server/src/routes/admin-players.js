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
import { SIGNUP_BONUS_LABEL, REFERRAL_BONUS_LABEL, BONUS_LABEL } from '../lib/config.js';

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

  /* ---------- payout identity, money in, money out ----------

     A support agent looking at a player needs the same three answers every
     time: where their money goes, what has come in, and what has gone out.
     Those live in three different collections, so gather them here rather
     than making the console stitch four more calls together. */
  const [deposits, withdrawals, kycDocs] = await Promise.all([
    col('deposit_requests').find({ user_id: id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 }).limit(50).toArray(),
    col('withdrawal_requests').find({ user_id: id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 }).limit(50).toArray(),
    col('kyc_documents').find({ user_id: id }, { projection: { _id: 0, slot: 1, path: 1, created_at: 1 } }).toArray(),
  ]);

  /* Every payout destination this player has ever used, newest first and
     de-duplicated. A UPI ID is not stored on the account — it is typed per
     withdrawal — so the account's "UPI ID" is really the set of them, and an
     agent chasing a failed payout needs to see all of them, not the latest.
     `verified` marks a destination that has actually been paid out to. */
  const payoutMethods = [];
  const seenKey = new Set();
  for (const r of withdrawals) {
    const key = r.method === 'bank'
      ? `bank:${r.account_number || ''}:${r.ifsc || ''}`
      : `upi:${(r.upi_id || '').toLowerCase()}`;
    if (key === 'upi:' || key === 'bank::') continue;      // nothing recorded on this row
    const paid = r.status === 'paid';
    const seen = seenKey.has(key);
    if (seen) {
      const existing = payoutMethods.find(m => m.key === key);
      existing.used += 1;
      existing.paidOut += paid ? (r.amount || 0) : 0;
      existing.verified = existing.verified || paid;
      continue;
    }
    seenKey.add(key);
    payoutMethods.push({
      key, method: r.method || 'upi',
      upiId: r.upi_id || null,
      accountName: r.account_name || null,
      accountNumber: r.account_number || null,
      ifsc: r.ifsc || null,
      lastUsedAt: r.created_at,
      used: 1,
      paidOut: paid ? (r.amount || 0) : 0,
      verified: paid,
    });
  }

  const totalOf = (rows, status) => rows.filter(r => r.status === status)
    .reduce((n, r) => n + (Number(r.amount) || 0), 0);

  /* Staked and won come off the battles themselves rather than the ledger:
     a stake debit is split across two buckets and a payout is one credit, so
     counting ledger rows would double the first and miss cancelled games. */
  const stakedAgg = await col('battles').aggregate([
    { $match: { $or: [{ creator_id: id }, { acceptor_id: id }], status: 'completed' } },
    { $group: { _id: null, staked: { $sum: '$amount' }, n: { $sum: 1 } } },
  ]).toArray();
  const wonAgg = await col('battles').aggregate([
    { $match: { winner_id: id, status: 'completed' } },
    { $group: { _id: null, payout: { $sum: '$payout' }, staked: { $sum: '$amount' }, n: { $sum: 1 } } },
  ]).toArray();
  /* Joining credits only. Matching the exact labels rather than "every
     deposit-bucket credit with no battle attached" — that also catches the
     verified-deposit credit, which would report a player's own money back to
     the operator as a bonus the house gave away. */
  const bonusAgg = await col('transactions').aggregate([
    { $match: { user_id: id, type: 'credit', bucket: 'deposit',
      note: { $in: [SIGNUP_BONUS_LABEL, REFERRAL_BONUS_LABEL, BONUS_LABEL] } } },
    { $group: { _id: null, v: { $sum: '$amount' } } },
  ]).toArray();

  const staked = stakedAgg[0]?.staked || 0;
  const wonPayout = wonAgg[0]?.payout || 0;
  const wonStake = wonAgg[0]?.staked || 0;
  const lostStake = Math.max(0, staked - wonStake);

  /* ---------- referral position, both directions ---------- */
  const referrer = u.referred_by != null
    ? await col('users').findOne({ id: u.referred_by },
        { projection: { _id: 0, id: 1, name: 1, phone: 1, referral_code: 1 } })
    : null;

  const referredRows = await col('referrals').find({ referrer_id: id }, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(100).toArray();
  const refereeIds = referredRows.map(r => r.referee_id);
  const refereeUsers = refereeIds.length
    ? await col('users').find({ id: { $in: refereeIds } },
        { projection: { _id: 0, id: 1, name: 1, phone: 1, created_at: 1, kyc_status: 1, banned: 1 } }).toArray()
    : [];
  const refereeById = Object.fromEntries(refereeUsers.map(r => [r.id, r]));

  /* Every referral transfer this player has been paid, and every one their
     own referrer was paid because of them. Two directions, one collection. */
  const [earnedTransfers, generatedTransfers] = await Promise.all([
    col('referral_earnings').find({ referrer_id: id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 }).limit(100).toArray(),
    col('referral_earnings').find({ referee_id: id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 }).limit(100).toArray(),
  ]);

  const nameFor = uid => refereeById[uid]?.name
    || (uid === id ? u.name : null)
    || (uid === referrer?.id ? referrer.name : null)
    || (uid != null ? 'Player' + String(uid).slice(-4) : '—');

  res.json({
    player: { id: u.id, name: u.name, phone: u.phone, email: u.email,
      emailVerified: !!u.email_verified, avatar: u.avatar, avatarUrl: u.avatar_url,
      kyc: u.kyc_status, kycMethod: u.kyc_method, kycMasked: u.kyc_masked,
      kycDob: u.kyc_dob || null, legalName: u.legal_name || null,
      banned: !!u.banned,
      referralCode: u.referral_code, referredBy: u.referred_by, createdAt: u.created_at },
    wallet: { deposit: w.deposit, winnings: w.winnings, referral: w.referral,
      total: w.deposit + w.winnings, grand: w.deposit + w.winnings + (w.referral || 0) },
    stats: { played, won, winRate: settled ? Math.round((won / settled) * 100) : 0,
      deposited: depAgg[0]?.v || 0, withdrawn: wdAgg[0]?.v || 0,
      referrals: refAgg[0]?.c || 0, referralEarned: refAgg[0]?.earned || 0,
      // Money that actually cleared, as opposed to every row ever written.
      depositApproved: totalOf(deposits, 'approved'),
      depositPending: totalOf(deposits, 'pending'),
      depositRejected: totalOf(deposits, 'rejected'),
      withdrawPaid: totalOf(withdrawals, 'paid'),
      withdrawPending: totalOf(withdrawals, 'pending'),
      withdrawRejected: totalOf(withdrawals, 'rejected'),
      staked, wonPayout, lostStake,
      /* The player's own position across settled games: everything they were
         paid, less everything they staked. Negative means the house is up on
         them — which is the number an operator is actually looking for when
         a large withdrawal lands. */
      netProfit: wonPayout - staked,
      bonuses: bonusAgg[0]?.v || 0,
    },
    payoutMethods,
    deposits, withdrawals,
    kycDocuments: kycDocs,
    referral: {
      code: u.referral_code,
      referredBy: referrer ? { id: referrer.id, name: referrer.name, phone: referrer.phone, code: referrer.referral_code } : null,
      referredUsers: referredRows.map(r => ({
        id: r.referee_id,
        name: refereeById[r.referee_id]?.name || 'Player' + String(r.referee_id).slice(-4),
        phone: refereeById[r.referee_id]?.phone || '',
        kyc: refereeById[r.referee_id]?.kyc_status || 'none',
        banned: !!refereeById[r.referee_id]?.banned,
        joinedAt: refereeById[r.referee_id]?.created_at || r.created_at,
        earned: r.earned || 0,
      })),
      earnedTransfers: earnedTransfers.map(t => ({
        id: t.id, amount: t.amount, stake: t.stake, split: !!t.split,
        ratePercent: +((t.rate || 0) * 100).toFixed(3),
        battleId: t.battle_id, mode: t.mode, source: t.source, createdAt: t.created_at,
        counterparty: nameFor(t.referee_id), counterpartyId: t.referee_id,
      })),
      generatedTransfers: generatedTransfers.map(t => ({
        id: t.id, amount: t.amount, stake: t.stake, split: !!t.split,
        ratePercent: +((t.rate || 0) * 100).toFixed(3),
        battleId: t.battle_id, mode: t.mode, source: t.source, createdAt: t.created_at,
        counterparty: nameFor(t.referrer_id), counterpartyId: t.referrer_id,
      })),
    },
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
