/* Profile, KYC, notifications, referrals (MongoDB). */
import express from 'express';
import { z } from 'zod';
import { col, now, publicUser, notify } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

/* PATCH /api/users/me */
router.patch('/me', requireAuth, async (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(3).max(20).optional(),
    avatar: z.number().int().min(0).max(15).optional(),
    email: z.string().email().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const set = { ...parsed.data };
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  if (set.name) {
    const dupe = await col('users').findOne({ name: set.name, id: { $ne: req.user.id } });
    if (dupe) return res.status(409).json({ error: 'That name is taken.' });
  }
  if (set.email) set.email_verified = 0;
  await col('users').updateOne({ id: req.user.id }, { $set: set });
  res.json({ user: publicUser(await col('users').findOne({ id: req.user.id })) });
});

/* POST /api/users/kyc */
router.post('/kyc', requireAuth, async (req, res) => {
  if (req.user.kyc_status === 'done') return res.status(409).json({ error: 'KYC is already complete.' });
  if (req.user.kyc_status === 'pending') return res.status(409).json({ error: 'Already submitted. Awaiting review.' });
  const schema = z.object({
    legalName: z.string().trim().min(3).max(60),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    idNumber: z.string().regex(/^\d{12}$/, 'Enter a valid 12-digit ID number.'),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const age = (Date.now() - new Date(parsed.data.dob).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 18) return res.status(400).json({ error: 'You must be 18 or older.' });
  await col('users').updateOne({ id: req.user.id }, { $set: { kyc_status: 'pending', legal_name: parsed.data.legalName } });
  res.json({ ok: true, kyc: 'pending' });
});

/* POST /api/users/email/verify-request */
router.post('/email/verify-request', requireAuth, async (req, res) => {
  if (!req.user.email) return res.status(400).json({ error: 'Add an email address first.' });
  if (req.user.email_verified) return res.status(409).json({ error: 'Email is already verified.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await col('otps').updateOne({ phone: 'email:' + req.user.id },
    { $set: { phone: 'email:' + req.user.id, code, expires_at: now() + 10 * 60 * 1000, attempts: 0 } }, { upsert: true });
  console.log(`[email-verify] ${req.user.email} -> ${code}`);
  res.json({ ok: true, ...(process.env.EXPOSE_OTP === 'true' ? { devCode: code } : {}) });
});

/* POST /api/users/email/verify */
router.post('/email/verify', requireAuth, async (req, res) => {
  const code = String(req.body?.code ?? '');
  const key = 'email:' + req.user.id;
  const row = await col('otps').findOne({ phone: key });
  if (!row) return res.status(400).json({ error: 'Request a code first.' });
  if (row.expires_at < now()) return res.status(400).json({ error: 'That code expired.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many attempts.' });
  if (row.code !== code) {
    await col('otps').updateOne({ phone: key }, { $inc: { attempts: 1 } });
    return res.status(400).json({ error: "That code doesn't match." });
  }
  await col('otps').deleteOne({ phone: key });
  await col('users').updateOne({ id: req.user.id }, { $set: { email_verified: 1 } });
  await notify(req.user.id, 'Email verified', 'Your email address is confirmed.');
  res.json({ ok: true });
});

/* GET /api/users/notifications */
router.get('/notifications', requireAuth, async (req, res) => {
  const rows = await col('notifications').find({ user_id: req.user.id }, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(60).toArray();
  res.json({ notifications: rows, unread: rows.filter(n => !n.read).length });
});

/* POST /api/users/notifications/read */
router.post('/notifications/read', requireAuth, async (req, res) => {
  await col('notifications').updateMany({ user_id: req.user.id }, { $set: { read: 1 } });
  res.json({ ok: true });
});

/* GET /api/users/referrals */
router.get('/referrals', requireAuth, async (req, res) => {
  const rows = await col('referrals').aggregate([
    { $match: { referrer_id: req.user.id } },
    { $sort: { created_at: -1 } },
    { $lookup: { from: 'users', localField: 'referee_id', foreignField: 'id', as: 'u' } },
    { $project: { _id: 0, earned: 1, created_at: 1, name: { $arrayElemAt: ['$u.name', 0] } } },
  ]).toArray();
  res.json({ code: req.user.referral_code, referrals: rows, total: rows.reduce((s, r) => s + r.earned, 0) });
});

export default router;
