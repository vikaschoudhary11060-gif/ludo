/* ============================================================
   Admin — players, money reporting, fraud & risk.

   Mounted under /api/admin (after the auth gate in admin.js),
   so every route here already has req.admin and req.clientIp.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { db, now, credit, audit, getSettings } from '../lib/db.js';
import { requireAdmin } from '../lib/admin-auth.js';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
const qrUpload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, UPLOAD_ROOT),
    filename: (_r, file, cb) => cb(null, 'qr-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') +
      ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype] || '.png')),
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_r, f, cb) => cb(null, ['image/png','image/jpeg','image/webp'].includes(f.mimetype)),
}).single('file');

const router = Router();

const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: null };
const since = req => { const s = RANGES[req.query.range]; return s ? Date.now() - s : 0; };

/* ---------------- PLAYERS ---------------- */

/* P1 — search. GET /admin/players?q= */
router.get('/players', (req, res) => {
  const q = (req.query.q || '').trim();
  const rows = q
    ? db.prepare(`SELECT u.id, u.name, u.phone, u.kyc_status, u.banned, u.created_at,
                         w.deposit, w.winnings, w.referral
                  FROM users u JOIN wallets w ON w.user_id = u.id
                  WHERE u.name LIKE ? OR u.phone LIKE ? OR CAST(u.id AS TEXT) = ?
                  ORDER BY u.created_at DESC LIMIT 50`).all(`%${q}%`, `%${q}%`, q)
    : db.prepare(`SELECT u.id, u.name, u.phone, u.kyc_status, u.banned, u.created_at,
                         w.deposit, w.winnings, w.referral
                  FROM users u JOIN wallets w ON w.user_id = u.id
                  ORDER BY u.created_at DESC LIMIT 50`).all();
  res.json({ players: rows });
});

/* P2 — 360° view. GET /admin/players/:id */
router.get('/players/:id', (req, res) => {
  const id = req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Player not found.' });
  const w = db.prepare('SELECT deposit, winnings, referral FROM wallets WHERE user_id = ?').get(id);

  const games = db.prepare(`
    SELECT COUNT(*) played,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) settled,
           SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) won
    FROM battles WHERE (creator_id = ? OR acceptor_id = ?) AND status IN ('completed','cancelled')`)
    .get(id, id, id);

  const money = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='credit' AND note LIKE 'Deposit%' THEN amount END),0) deposited,
      COALESCE(SUM(CASE WHEN type='debit'  AND note LIKE 'Withdrawal%' THEN amount END),0) withdrawn
    FROM transactions WHERE user_id = ?`).get(id);

  const recentTx = db.prepare(
    'SELECT type, bucket, amount, note, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 15').all(id);
  const recentGames = db.prepare(`
    SELECT id, amount, status, winner_id, created_at FROM battles
    WHERE creator_id = ? OR acceptor_id = ? ORDER BY created_at DESC LIMIT 10`).all(id, id);
  const devices = db.prepare(
    'SELECT ip, user_agent, created_at FROM login_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 15').all(id);
  const referrals = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(earned),0) earned FROM referrals WHERE referrer_id = ?').get(id);
  const watch = db.prepare('SELECT * FROM watchlist WHERE user_id = ?').get(id);
  const thread = db.prepare('SELECT id, status, unread_admin FROM chat_threads WHERE user_id = ?').get(id);

  res.json({
    player: {
      id: u.id, name: u.name, phone: u.phone, email: u.email, avatar: u.avatar,
      kyc: u.kyc_status, kycMasked: u.kyc_masked, banned: !!u.banned,
      referralCode: u.referral_code, referredBy: u.referred_by, createdAt: u.created_at,
    },
    wallet: { ...w, total: w.deposit + w.winnings },
    stats: {
      played: games.played || 0, won: games.won || 0,
      winRate: games.settled ? Math.round((games.won / games.settled) * 100) : 0,
      deposited: money.deposited, withdrawn: money.withdrawn,
      referrals: referrals.c, referralEarned: referrals.earned,
    },
    recentTx, recentGames, devices, watch: watch || null, thread: thread || null,
  });
});

/* P3 — manual wallet adjust. POST /admin/players/:id/adjust  { amount, bucket, reason } */
router.post('/players/:id/adjust', requireAdmin('admin'), (req, res) => {
  const schema = z.object({
    amount: z.number().int().refine(n => n !== 0, 'Non-zero amount required.'),
    bucket: z.enum(['deposit', 'winnings', 'referral']).default('deposit'),
    reason: z.string().trim().min(3).max(200),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { amount, bucket, reason } = parsed.data;
  const id = Number(req.params.id);

  const w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(id);
  if (!w) return res.status(404).json({ error: 'Player not found.' });
  if (amount < 0 && w[bucket] + amount < 0)
    return res.status(400).json({ error: `Not enough in ${bucket} to deduct that.` });

  db.transaction(() => {
    db.prepare(`UPDATE wallets SET ${bucket} = ${bucket} + ? WHERE user_id = ?`).run(amount, id);
    db.prepare(`INSERT INTO transactions (user_id, type, bucket, amount, note, status, created_at)
                VALUES (?,?,?,?,?, 'success', ?)`)
      .run(id, amount > 0 ? 'credit' : 'debit', bucket, Math.abs(amount),
           `Admin adjust: ${reason}`, now());
  })();
  audit(req.admin, 'wallet.adjust', { targetType: 'user', targetId: String(id),
                                      detail: { amount, bucket, reason }, ip: req.clientIp });
  res.json({ ok: true, wallet: db.prepare('SELECT deposit,winnings,referral FROM wallets WHERE user_id=?').get(id) });
});

/* P5 — force logout. POST /admin/players/:id/logout */
router.post('/players/:id/logout', requireAdmin('admin'), (req, res) => {
  const info = db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Player not found.' });
  audit(req.admin, 'user.force_logout', { targetType: 'user', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------------- WATCHLIST (R4) ---------------- */

router.get('/watchlist', (_req, res) => {
  res.json({ watchlist: db.prepare(`
    SELECT wl.*, u.name, u.phone FROM watchlist wl JOIN users u ON u.id = wl.user_id
    ORDER BY wl.created_at DESC`).all() });
});

router.post('/players/:id/watch', requireAdmin('admin'), (req, res) => {
  const on = req.body?.watch !== false;
  if (on) {
    db.prepare(`INSERT INTO watchlist (user_id, reason, added_by, created_at) VALUES (?,?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason`)
      .run(req.params.id, req.body?.reason || null, req.admin.username, now());
  } else {
    db.prepare('DELETE FROM watchlist WHERE user_id = ?').run(req.params.id);
  }
  audit(req.admin, on ? 'watchlist.add' : 'watchlist.remove',
        { targetType: 'user', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

/* ---------------- MONEY & REPORTING ---------------- */

/* M1 — time-series for charts. GET /admin/charts?range= */
router.get('/charts', (req, res) => {
  const from = since(req) || (Date.now() - 30 * 864e5);
  // bucket by day
  const day = 864e5;
  const rows = db.prepare(`
    SELECT (created_at / ${day}) AS d,
      SUM(CASE WHEN type='credit' AND bucket='deposit' AND note LIKE 'Deposit%' THEN amount ELSE 0 END) deposits,
      SUM(CASE WHEN type='debit' AND note LIKE 'Withdrawal%' AND status='success' THEN amount ELSE 0 END) withdrawals
    FROM transactions WHERE created_at >= ? GROUP BY d ORDER BY d`).all(from);
  const signups = db.prepare(`
    SELECT (created_at / ${day}) AS d, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY d`).all(from);
  const commission = db.prepare(`
    SELECT (settled_at / ${day}) AS d, COALESCE(SUM(amount*2 - payout),0) c
    FROM battles WHERE status='completed' AND settled_at >= ? GROUP BY d`).all(from);

  const byDay = {};
  const put = (arr, key, field) => arr.forEach(r => {
    const k = r.d * day; byDay[k] = byDay[k] || { date: k, deposits: 0, withdrawals: 0, signups: 0, commission: 0 };
    byDay[k][key] = r[field];
  });
  put(rows, 'deposits', 'deposits'); put(rows, 'withdrawals', 'withdrawals');
  put(signups, 'signups', 'n'); put(commission, 'commission', 'c');
  res.json({ series: Object.values(byDay).sort((a, b) => a.date - b.date) });
});

/* M2 — revenue report. GET /admin/revenue?range= */
router.get('/revenue', (req, res) => {
  const from = since(req);
  const settled = db.prepare(
    "SELECT COUNT(*) n, COALESCE(SUM(amount),0) staked, COALESCE(SUM(payout),0) paid FROM battles WHERE status='completed' AND settled_at >= ?").get(from);
  const referralPaid = db.prepare(
    "SELECT COALESCE(SUM(amount),0) v FROM transactions WHERE bucket='referral' AND type='credit' AND created_at >= ?").get(from).v;
  const commission = Math.max(0, settled.staked * 2 - settled.paid);
  res.json({
    range: req.query.range || 'all',
    battlesSettled: settled.n,
    totalStaked: settled.staked * 2,
    totalPaidOut: settled.paid,
    grossCommission: commission,
    referralPaid: referralPaid,
    netRevenue: commission - referralPaid,
  });
});

/* M4 — pending money summary. GET /admin/pending-money */
router.get('/pending-money', (_req, res) => {
  const openStakes = db.prepare("SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM battles WHERE status IN ('open','waiting','running')").get();
  const pendingWd = db.prepare("SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM withdrawal_requests WHERE status='pending'").get();
  const pendingDep = db.prepare("SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM deposit_requests WHERE status='pending'").get();
  const disputed = db.prepare("SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM battles WHERE status='disputed'").get();
  res.json({ openStakes, pendingWithdrawals: pendingWd, pendingDeposits: pendingDep, disputed });
});

/* M5 — reconciliation. GET /admin/reconcile */
router.get('/reconcile', (_req, res) => {
  const mismatches = [];
  for (const w of db.prepare('SELECT user_id, deposit, winnings, referral FROM wallets').all()) {
    for (const bucket of ['deposit', 'winnings', 'referral']) {
      const led = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0) v
                              FROM transactions WHERE user_id=? AND bucket=? AND status!='failed'`).get(w.user_id, bucket).v;
      if (w[bucket] !== led) mismatches.push({ userId: w.user_id, bucket, wallet: w[bucket], ledger: led, diff: w[bucket] - led });
    }
  }
  res.json({ ok: mismatches.length === 0, checked: db.prepare('SELECT COUNT(*) c FROM wallets').get().c, mismatches });
});

/* ---------------- FRAUD & RISK ---------------- */

/* R1 — multi-account: users sharing an IP. GET /admin/fraud/multi-account */
router.get('/fraud/multi-account', (_req, res) => {
  const rows = db.prepare(`
    SELECT ip, COUNT(DISTINCT user_id) users, GROUP_CONCAT(DISTINCT user_id) ids
    FROM login_events WHERE ip IS NOT NULL AND ip != ''
    GROUP BY ip HAVING users > 1 ORDER BY users DESC LIMIT 50`).all();
  const enrich = rows.map(r => ({
    ip: r.ip, count: r.users,
    users: r.ids.split(',').slice(0, 10).map(id =>
      db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(id)).filter(Boolean),
  }));
  res.json({ groups: enrich });
});

/* R2 — collusion: pairs who play each other a lot with lopsided results. */
router.get('/fraud/collusion', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      MIN(creator_id, acceptor_id) a, MAX(creator_id, acceptor_id) b,
      COUNT(*) games,
      SUM(CASE WHEN winner_id = MIN(creator_id, acceptor_id) THEN 1 ELSE 0 END) aWins
    FROM battles
    WHERE status='completed' AND acceptor_id IS NOT NULL
    GROUP BY a, b HAVING games >= 3 ORDER BY games DESC LIMIT 50`).all();
  const flagged = rows.map(r => {
    const ua = db.prepare('SELECT name FROM users WHERE id=?').get(r.a);
    const ub = db.prepare('SELECT name FROM users WHERE id=?').get(r.b);
    const skew = Math.abs(r.aWins / r.games - 0.5);
    return { a: r.a, aName: ua?.name, b: r.b, bName: ub?.name, games: r.games,
             aWins: r.aWins, bWins: r.games - r.aWins,
             risk: skew > 0.4 ? 'high' : skew > 0.25 ? 'medium' : 'low' };
  }).filter(x => x.risk !== 'low');
  res.json({ pairs: flagged });
});

/* R3 — withdrawal risk score. GET /admin/withdrawals/risk */
router.get('/withdrawals/risk', (_req, res) => {
  const rows = db.prepare(`
    SELECT w.*, u.name, u.phone, u.created_at AS joined, u.kyc_status
    FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
    WHERE w.status='pending' ORDER BY w.created_at ASC`).all();
  const scored = rows.map(w => {
    const reasons = []; let score = 0;
    const ageDays = (Date.now() - w.joined) / 864e5;
    if (ageDays < 1) { score += 40; reasons.push('account < 1 day old'); }
    else if (ageDays < 7) { score += 15; reasons.push('account < 1 week old'); }
    const gamesWon = db.prepare('SELECT COUNT(*) c FROM battles WHERE winner_id=?').get(w.user_id).c;
    if (gamesWon === 0) { score += 35; reasons.push('no games won'); }
    const priorWd = db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE user_id=? AND status='paid'").get(w.user_id).c;
    if (priorWd === 0) { score += 10; reasons.push('first withdrawal'); }
    if (w.amount >= 10000) { score += 20; reasons.push('large amount'); }
    if (w.kyc_status !== 'done') { score += 30; reasons.push('KYC not complete'); }
    const shared = db.prepare(`SELECT COUNT(DISTINCT le2.user_id) c FROM login_events le1
      JOIN login_events le2 ON le1.ip = le2.ip AND le2.user_id != le1.user_id
      WHERE le1.user_id = ?`).get(w.user_id).c;
    if (shared > 0) { score += 15; reasons.push(`shares device with ${shared} account(s)`); }
    return { ...w, riskScore: Math.min(100, score),
             riskLevel: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', reasons };
  });
  res.json({ withdrawals: scored });
});

/* Admin uploads the deposit QR image. POST /admin/deposit-qr */
router.post('/deposit-qr', requireAdmin('owner'), (req, res) => {
  qrUpload(req, res, err => {
    if (err) return res.status(400).json({ error: 'Upload failed (PNG/JPG/WebP, max 3MB).' });
    if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
    const url = '/uploads/' + req.file.filename;
    db.prepare('UPDATE settings SET qr_image = ? WHERE id = 1').run(url);
    audit(req.admin, 'settings.qr', { detail: { url }, ip: req.clientIp });
    res.status(201).json({ url });
  });
});

export default router;
