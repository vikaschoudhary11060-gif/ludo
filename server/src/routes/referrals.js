/* ============================================================
   Referrals API — lookup, stats & history (MongoDB)
   ============================================================ */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { col, getSettings } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

const lookupLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Too many lookup requests. Please slow down.' },
});

/* GET /api/referrals/lookup/:code — Public lookup to get referrer name */
router.get('/lookup/:code', lookupLimiter, async (req, res) => {
  const raw = String(req.params.code || '').trim();
  if (!raw || raw.length < 3 || raw.length > 25) {
    return res.status(400).json({ valid: false, error: 'Invalid referral code format.' });
  }

  // Case-insensitive lookup for referral code
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const user = await col('users').findOne(
    { referral_code: { $regex: new RegExp('^' + escaped + '$', 'i') } },
    { projection: { id: 1, name: 1, avatar: 1, referral_code: 1, banned: 1 } }
  );

  if (!user || user.banned) {
    return res.status(404).json({ valid: false, error: 'Referral code not found.' });
  }

  res.json({
    valid: true,
    code: user.referral_code,
    name: user.name || 'A Khelbro Player',
    avatar: user.avatar || 0,
  });
});

/* GET /api/referrals/stats — Authenticated player referral dashboard data */
router.get('/stats', requireAuth, async (req, res) => {
  const settings = await getSettings();
  const wallet = await col('wallets').findOne(
    { user_id: req.user.id },
    { projection: { referral: 1 } }
  );

  const rows = await col('referrals').aggregate([
    { $match: { referrer_id: req.user.id } },
    { $sort: { created_at: -1 } },
    { $lookup: { from: 'users', localField: 'referee_id', foreignField: 'id', as: 'u' } },
    {
      $project: {
        _id: 0,
        referee_id: 1,
        earned: 1,
        created_at: 1,
        name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, 'Player'] },
        avatar: { $ifNull: [{ $arrayElemAt: ['$u.avatar', 0] }, 0] },
      },
    },
  ]).toArray();

  const totalEarned = rows.reduce((s, r) => s + (r.earned || 0), 0);

  res.json({
    code: req.user.referral_code,
    rate: settings.referral_rate || 0.02,
    ratePercentage: Math.round((settings.referral_rate || 0.02) * 100),
    totalEarned,
    unredeemed: wallet?.referral || 0,
    referralsCount: rows.length,
    referrals: rows,
  });
});

export default router;
