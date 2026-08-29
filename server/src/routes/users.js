/* Profile, KYC, notifications, referrals. */
import express from 'express';
import { z } from 'zod';
import { db, now, publicUser, notify } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

/* PATCH /api/users/me  { name?, avatar?, email? } */
router.patch('/me', requireAuth, (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(3).max(20).optional(),
    avatar: z.number().int().min(0).max(15).optional(),
    email: z.string().email().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const fields = Object.entries(parsed.data);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    db.prepare(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map(([, v]) => v), req.user.id);
    // A new address is unverified until proven.
    if (parsed.data.email) db.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(req.user.id);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'That name is taken.' });
    throw e;
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

/* POST /api/users/kyc  { legalName, dob, idNumber } */
router.post('/kyc', requireAuth, (req, res) => {
  if (req.user.kyc_status === 'done')  return res.status(409).json({ error: 'KYC is already complete.' });
  if (req.user.kyc_status === 'pending') return res.status(409).json({ error: 'Already submitted. Awaiting review.' });

  const schema = z.object({
    legalName: z.string().trim().min(3).max(60),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    idNumber: z.string().regex(/^\d{12}$/, 'Enter a valid 12-digit ID number.'),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const dob = new Date(parsed.data.dob);
  const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 18) return res.status(400).json({ error: 'You must be 18 or older.' });

  db.prepare("UPDATE users SET kyc_status = 'pending', legal_name = ? WHERE id = ?")
    .run(parsed.data.legalName, req.user.id);
  res.json({ ok: true, kyc: 'pending' });
});

/* POST /api/users/email/verify-request
   Issues a 6-digit code. No mail provider is wired, so in development the code
   comes back in the response (same switch as the login OTP). */
router.post('/email/verify-request', requireAuth, (req, res) => {
  if (!req.user.email) return res.status(400).json({ error: 'Add an email address first.' });
  if (req.user.email_verified) return res.status(409).json({ error: 'Email is already verified.' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare(`INSERT INTO otps (phone, code, expires_at, attempts) VALUES (?,?,?,0)
              ON CONFLICT(phone) DO UPDATE SET code=excluded.code,
                expires_at=excluded.expires_at, attempts=0`)
    .run('email:' + req.user.id, code, now() + 10 * 60 * 1000);

  console.log(`[email-verify] ${req.user.email} -> ${code}`);
  res.json({ ok: true, ...(process.env.EXPOSE_OTP === 'true' ? { devCode: code } : {}) });
});

/* POST /api/users/email/verify  { code } */
router.post('/email/verify', requireAuth, (req, res) => {
  const code = String(req.body?.code ?? '');
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get('email:' + req.user.id);
  if (!row) return res.status(400).json({ error: 'Request a code first.' });
  if (row.expires_at < now()) return res.status(400).json({ error: 'That code expired.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many attempts.' });
  if (row.code !== code) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run('email:' + req.user.id);
    return res.status(400).json({ error: "That code doesn't match." });
  }
  db.prepare('DELETE FROM otps WHERE phone = ?').run('email:' + req.user.id);
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(req.user.id);
  notify(req.user.id, 'Email verified', 'Your email address is confirmed.');
  res.json({ ok: true });
});

/* GET /api/users/notifications */
router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ?
                           ORDER BY created_at DESC LIMIT 60`).all(req.user.id);
  res.json({ notifications: rows, unread: rows.filter(n => !n.read).length });
});

/* POST /api/users/notifications/read */
router.post('/notifications/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* GET /api/users/referrals */
router.get('/referrals', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT r.earned, r.created_at, u.name
                           FROM referrals r JOIN users u ON u.id = r.referee_id
                           WHERE r.referrer_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
  res.json({ code: req.user.referral_code, referrals: rows,
             total: rows.reduce((s, r) => s + r.earned, 0) });
});

export default router;
