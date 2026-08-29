/* Auth — OTP request + verify (MongoDB). */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { col, nextId, now, publicUser } from '../lib/db.js';
import { sign, requireAuth } from '../lib/auth.js';
import { OTP_TTL_MS, OTP_MAX_ATTEMPTS } from '../lib/config.js';

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.OTP_RATE_LIMIT) || 5,
  message: { error: 'Too many code requests. Try again in a few minutes.' },
});

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.');
const randomCode = () => String(Math.floor(100000 + Math.random() * 900000));
const makeReferralCode = phone => 'KHEL-' + phone.slice(-4) + Math.random().toString(36).slice(2, 4).toUpperCase();

/* POST /api/auth/request-otp */
router.post('/request-otp', otpLimiter, async (req, res) => {
  const parsed = phoneSchema.safeParse(req.body?.phone);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const phone = parsed.data;
  const code = randomCode();
  await col('otps').updateOne({ phone },
    { $set: { phone, code, expires_at: now() + OTP_TTL_MS, attempts: 0 } }, { upsert: true });
  console.log(`[otp] ${phone} -> ${code}`);   // replace with your SMS provider
  res.json({ ok: true, expiresIn: Math.floor(OTP_TTL_MS / 1000),
             ...(process.env.EXPOSE_OTP === 'true' ? { devCode: code } : {}) });
});

/* POST /api/auth/verify-otp */
router.post('/verify-otp', async (req, res) => {
  const schema = z.object({
    phone: phoneSchema,
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
    referralCode: z.string().trim().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { phone, code, referralCode } = parsed.data;

  const row = await col('otps').findOne({ phone });
  if (!row) return res.status(400).json({ error: 'Request a code first.' });
  if (row.expires_at < now()) return res.status(400).json({ error: 'That code expired. Request a new one.' });
  if (row.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  if (row.code !== code) {
    await col('otps').updateOne({ phone }, { $inc: { attempts: 1 } });
    return res.status(400).json({ error: "That code doesn't match. Try again." });
  }
  await col('otps').deleteOne({ phone });

  let user = await col('users').findOne({ phone });
  let isNew = false;
  if (!user) {
    isNew = true;
    const referrer = referralCode
      ? await col('users').findOne({ referral_code: referralCode.toUpperCase() }, { projection: { id: 1 } })
      : null;
    const id = await nextId('users');
    user = {
      id, phone, name: 'Player' + phone.slice(-4), avatar: 0, email: null,
      avatar_url: null, email_verified: 0, kyc_status: 'none', kyc_method: null,
      kyc_reference: null, kyc_masked: null, kyc_dob: null, legal_name: null,
      referral_code: makeReferralCode(phone), referred_by: referrer?.id ?? null,
      banned: 0, session_epoch: 0, created_at: now(),
    };
    await col('users').insertOne(user);
    await col('wallets').insertOne({ user_id: id, deposit: 0, winnings: 0, referral: 0 });
    if (referrer) {
      await col('referrals').updateOne(
        { referrer_id: referrer.id, referee_id: id },
        { $setOnInsert: { referrer_id: referrer.id, referee_id: id, earned: 0, created_at: now() } },
        { upsert: true });
    }
  }

  await col('login_events').insertOne({
    id: await nextId('login_events'), user_id: user.id,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
    user_agent: (req.headers['user-agent'] || '').slice(0, 200), created_at: now(),
  });
  res.json({ token: sign(user.id, user.session_epoch || 0), user: publicUser(user), isNew });
});

/* GET /api/auth/me */
router.get('/me', requireAuth, async (req, res) => {
  const wallet = await col('wallets').findOne({ user_id: req.user.id },
    { projection: { _id: 0, deposit: 1, winnings: 1, referral: 1 } });
  const played = await col('battles').countDocuments({
    status: { $in: ['completed', 'cancelled'] },
    $or: [{ creator_id: req.user.id }, { acceptor_id: req.user.id }],
  });
  const won = await col('battles').countDocuments({ winner_id: req.user.id });
  res.json({ user: req.publicUser, wallet, stats: { played, won } });
});

export default router;
