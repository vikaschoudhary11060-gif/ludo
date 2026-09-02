/* Auth — OTP request + verify (MongoDB). */
import express from 'express';
import { SafeRouter } from '../lib/safe-router.js';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { col, nextId, now, publicUser, notify, getWallet, getSettings, credit } from '../lib/db.js';
import { sign, requireAuth } from '../lib/auth.js';
import { passwordProblem, hashPassword, checkPassword, shouldLock, lockUpdate,
         lockoutRemaining, lockoutMessage, LOCKOUT_MS, PASSWORD_MIN, PASSWORD_MAX } from '../lib/password.js';
import { OTP_TTL_MS, OTP_MAX_ATTEMPTS, IS_PROD, signupBonuses } from '../lib/config.js';

const router = SafeRouter();



/* Returning the OTP in response so users can test login during testing phase. */
const EXPOSE_OTP = String(process.env.EXPOSE_OTP ?? 'true').toLowerCase() !== 'false';

/* The cap is a brute-force control, so production keeps a strict ceiling
   even when the env var says otherwise. */
const OTP_MAX_PER_WINDOW = (() => {
  const configured = Number(process.env.OTP_RATE_LIMIT);
  if (!Number.isFinite(configured) || configured <= 0) return 5;
  return IS_PROD ? Math.min(configured, 10) : configured;
})();

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: OTP_MAX_PER_WINDOW,
  message: { error: 'Too many code requests. Try again in a few minutes.' },
});

const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.');
const randomCode = () => String(Math.floor(100000 + Math.random() * 900000));
const makeReferralCode = phone => 'KHEL-' + phone.slice(-4) + Math.random().toString(36).slice(2, 4).toUpperCase();

/** One row per successful sign-in, whichever door it came through. */
async function recordLogin(req, userId, via) {
  await col('login_events').insertOne({
    id: await nextId('login_events'), user_id: userId, via,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
    user_agent: (req.headers['user-agent'] || '').slice(0, 200), created_at: now(),
  });
}

/* Password guessing is spread across addresses in practice, so this IP cap is
   only the outer fence — lib/password.js locks the individual account. */
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PASSWORD_RATE_LIMIT) || 20,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});

/* POST /api/auth/check  { phone }

   Tells the sign-in screen which door to open: a returning player with a
   password gets the password field, everyone else gets an OTP. It does reveal
   whether a number is registered — unavoidable for this flow, since the screen
   has to differ — so it is capped tightly and returns nothing else. */
const checkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.CHECK_RATE_LIMIT) || 30,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

router.post('/check', checkLimiter, async (req, res) => {
  const parsed = phoneSchema.safeParse(req.body?.phone);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const user = await col('users').findOne({ phone: parsed.data },
    { projection: { _id: 0, id: 1, password_hash: 1, banned: 1 } });
  res.json({
    exists: !!user,
    // A banned account is offered the OTP door and refused there, so the
    // block is stated once, by the code that owns it.
    hasPassword: !!(user && user.password_hash && !user.banned),
  });
});

/* POST /api/auth/login-password  { phone, password } */
router.post('/login-password', passwordLimiter, async (req, res) => {
  const parsed = z.object({
    phone: phoneSchema,
    password: z.string().min(1, 'Enter your password.').max(200),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { phone, password } = parsed.data;

  const user = await col('users').findOne({ phone });
  /* One message for "no such account", "no password set" and "wrong password".
     Three different messages would turn this endpoint into a way to map which
     numbers are registered and which have passwords. */
  const reject = () => res.status(401).json({ error: 'Wrong mobile number or password.', code: 'BAD_CREDENTIALS' });

  // Still hashed, so a number with no account costs the same time as one with.
  if (!user || !user.password_hash) { await checkPassword(password, null); return reject(); }
  if (user.banned) return res.status(403).json({ error: 'You are blocked by admin.' });

  const locked = lockoutRemaining(user);
  if (locked > 0) return res.status(429).json({ error: lockoutMessage(locked), code: 'LOCKED' });

  if (!(await checkPassword(password, user.password_hash))) {
    /* Increment first and read the result, so guesses fired in parallel are
       each counted exactly once. Counting from the value read above would let
       several in-flight attempts share one increment. */
    const after = await col('users').findOneAndUpdate({ id: user.id },
      { $inc: { pw_attempts: 1 } }, { returnDocument: 'after' });
    if (shouldLock(after?.pw_attempts)) {
      const at = now();
      await col('users').updateOne({ id: user.id }, lockUpdate(at));
      return res.status(429).json({ error: lockoutMessage(LOCKOUT_MS), code: 'LOCKED' });
    }
    return reject();
  }

  await col('users').updateOne({ id: user.id },
    { $set: { pw_attempts: 0 }, $unset: { pw_locked_until: '' } });
  await recordLogin(req, user.id, 'password');
  res.json({ token: sign(user.id, user.session_epoch || 0, 'password'), user: publicUser(user), isNew: false });
});

/* POST /api/auth/set-password  { password, currentPassword? }

   Used twice: the forced setup straight after a first OTP sign-in, and a
   later change. A change without the current password is allowed only on an
   OTP-proved session, which is the forgot-password route. */
router.post('/set-password', requireAuth, async (req, res) => {
  const parsed = z.object({
    password: z.string().min(1).max(200),
    currentPassword: z.string().max(200).optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Enter a password.' });
  const { password, currentPassword } = parsed.data;
  const user = req.user;

  if (user.password_hash && req.authVia !== 'otp') {
    if (!currentPassword) return res.status(400).json({ error: 'Enter your current password.', code: 'CURRENT_REQUIRED' });
    if (!(await checkPassword(currentPassword, user.password_hash)))
      return res.status(401).json({ error: 'That is not your current password.', code: 'BAD_CURRENT' });
  }

  const problem = passwordProblem(password, user.phone);
  if (problem) return res.status(400).json({ error: problem });
  if (user.password_hash && await checkPassword(password, user.password_hash))
    return res.status(400).json({ error: 'That is already your password. Choose a different one.' });

  /* Bumping the epoch signs out every other device — the point of changing a
     password. The caller gets a token on the new epoch so it is not signed out
     of the session it just used. */
  const epoch = (user.session_epoch || 0) + 1;
  await col('users').updateOne({ id: user.id }, {
    $set: { password_hash: await hashPassword(password), session_epoch: epoch, pw_attempts: 0,
            password_set_at: now() },
    $unset: { pw_locked_until: '' },
  });
  res.json({ ok: true, token: sign(user.id, epoch, 'password') });
});

/* POST /api/auth/request-otp */
router.post('/request-otp', otpLimiter, async (req, res) => {
  const parsed = phoneSchema.safeParse(req.body?.phone);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const phone = parsed.data;
  const code = randomCode();
  await col('otps').updateOne({ phone },
    { $set: { phone, code, expires_at: now() + OTP_TTL_MS, attempts: 0 } }, { upsert: true });
  // TODO: hand `code` to an SMS provider. Never log it in production.
  if (!IS_PROD) console.log(`[otp] ${phone} -> ${code}`);
  res.json({ ok: true, expiresIn: Math.floor(OTP_TTL_MS / 1000),
             ...(EXPOSE_OTP ? { devCode: code, otp: code } : {}) });
});

/* POST /api/auth/verify-otp */
router.post('/verify-otp', async (req, res) => {
  const schema = z.object({
    phone: phoneSchema,
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
    referralCode: z.string().trim().nullable().optional(),
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
  /* Say so here rather than issuing a token that every later request refuses.
     login-password already turns a banned account away; the two doors must
     agree, or a blocked player gets a working-looking sign-in followed by
     errors everywhere. */
  if (user?.banned) return res.status(403).json({ error: 'You are blocked by admin.' });

  let isNew = false;
  if (!user) {
    isNew = true;
    const rawRef = String(referralCode || '').trim();
    let referrer = null;
    if (rawRef) {
      const escaped = rawRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      referrer = await col('users').findOne(
        { referral_code: { $regex: new RegExp('^' + escaped + '$', 'i') } },
        { projection: { id: 1, name: 1 } }
      );
    }

    const id = await nextId('users');
    user = {
      id, phone, name: 'Player' + phone.slice(-4), avatar: 0, email: null,
      avatar_url: null, email_verified: 0, kyc_status: 'none', kyc_method: null,
      kyc_reference: null, kyc_masked: null, kyc_dob: null, legal_name: null,
      referral_code: makeReferralCode(phone), referred_by: (referrer && referrer.id !== id) ? referrer.id : null,
      banned: 0, session_epoch: 0, created_at: now(),
    };
    await col('users').insertOne(user);
    await col('wallets').insertOne({ user_id: id, deposit: 0, winnings: 0, referral: 0 });

    /* Joining credits, read live from settings so the admin can change or
       switch them off without a deploy. They land in the cash bucket: playable
       immediately, but not withdrawable straight back out. A failure here must
       not cost the player their account — they are already signed up. */
    try {
      for (const [amount, label] of signupBonuses(await getSettings(), !!referrer)) {
        await credit(id, 'deposit', amount, label);
        await notify(id, 'Bonus credited 🎁', `₹${amount} ${label.toLowerCase()} added to your cash balance.`);
      }
    } catch (e) {
      console.error('[auth] signup bonus failed for user', id, '-', e?.message);
    }

    if (referrer && referrer.id !== id) {
      await col('referrals').updateOne(
        { referrer_id: referrer.id, referee_id: id },
        { $setOnInsert: { referrer_id: referrer.id, referee_id: id, earned: 0, created_at: now() } },
        { upsert: true }
      );
      await notify(referrer.id, 'New Referral Joined! 🎉', `${user.name} registered using your referral code.`);
      await notify(id, 'Welcome to Khelbro! 🎁', `You joined with ${referrer.name}'s referral.`);
    }
  }

  await recordLogin(req, user.id, 'otp');
  /* The client uses this to push the "create your password" step. Every
     account without a password gets it, not only brand-new ones, so accounts
     that predate passwords are brought across on their next sign-in. */
  const hasPw = !!user.password_hash;
  res.json({ token: sign(user.id, user.session_epoch || 0, 'otp'),
             user: { ...publicUser(user), hasPassword: hasPw }, isNew,
             needsPassword: !hasPw,
             passwordRules: { min: PASSWORD_MIN, max: PASSWORD_MAX } });
});

/* GET /api/auth/me */
router.get('/me', requireAuth, async (req, res) => {
  // Every page load hits this, so pay one round trip rather than three.
  const [wallet, played, won] = await Promise.all([
    getWallet(req.user.id),        // creates the row if it is missing
    col('battles').countDocuments({
      status: { $in: ['completed', 'cancelled'] },
      $or: [{ creator_id: req.user.id }, { acceptor_id: req.user.id }],
    }),
    col('battles').countDocuments({ winner_id: req.user.id }),
  ]);
  /* `hasPassword` lets the app finish an interrupted setup: someone who
     closed the tab on the "create your password" step is asked again on their
     next visit rather than silently keeping an OTP-only account. */
  res.json({ user: { ...req.publicUser, hasPassword: !!req.user.password_hash },
             wallet, stats: { played, won } });
});

export default router;
