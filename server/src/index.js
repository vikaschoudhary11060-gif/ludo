/* ============================================================
   Khelbro API server
     node src/index.js        (or: npm run dev)
   ============================================================ */
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import walletRoutes from './routes/wallet.js';
import battleRoutes from './routes/battles.js';
import leaderboardRoutes from './routes/leaderboard.js';
import supportRoutes from './routes/support.js';
import uploadRoutes, { UPLOAD_ROOT } from './routes/uploads.js';
import { getFile } from './lib/storage.js';
import adminRoutes from './routes/admin.js';
import pushRoutes from './routes/push.js';
import chatRoutes from './routes/chat.js';
import referralRoutes from './routes/referrals.js';
import { userRouter as paymentUserRoutes } from './routes/payments.js';
import { attachRealtime } from './realtime.js';
import { startSettlementSweeper } from './lib/settle-sweeper.js';
import { runBackfills } from './lib/backfill.js';
import { startBotEngine } from './lib/bots.js';
import { MODES, DEPOSIT, WITHDRAW, BONUS_PER, BONUS_AMOUNT,
         CANCEL_WINDOW_MS, CLAIM_GRACE_MS, commissionFor, CANCEL_REASONS } from './lib/config.js';
import { getSettings, connect, ensureSeed } from './lib/db.js';

const app = express();
const server = http.createServer(app);

const defaultOrigins = ['http://localhost:5173', 'http://localhost:4000', 'https://ludo-ludo19.vercel.app'];
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ORIGINS = [...new Set([...defaultOrigins, ...configuredOrigins])];

const checkOrigin = (origin, callback) => {
  if (!origin) return callback(null, true);
  try {
    const hostname = new URL(origin).hostname;
    if (ORIGINS.includes(origin) || hostname.endsWith('.vercel.app') || hostname === 'localhost') {
      return callback(null, true);
    }
  } catch {}
  return callback(null, true);
};

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: checkOrigin, credentials: true, maxAge: 86400 }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 240 }));

/* Public config so the front end never hard-codes business rules. */
app.get('/api/config', async (_req, res) => {
  const s = await getSettings();
  res.json({
    modes: MODES, deposit: DEPOSIT, withdraw: WITHDRAW,
    commission: s.commission, referralRate: s.referral_rate, battleLimit: s.battle_limit,
    /* The commission depends on the stake, so the client is given the whole
       rule rather than one rate — otherwise the prize it advertises would not
       match the prize that gets paid. */
    commissionTiers: {
      threshold: s.commission_threshold,
      under: commissionFor(0, s),
      /* One rupee past the threshold: the threshold amount itself is on the
         higher tier now, so sampling at it would publish the wrong pair. */
      from: commissionFor(s.commission_threshold + 1, s),
    },
    withdrawOpen: !!s.withdraw_open, depositOpen: !!s.deposit_open,
    maintenance: !!s.maintenance,
    notice: (s.notices && s.notices[0]) || s.notice || null,
    notices: Array.isArray(s.notices) && s.notices.length ? s.notices : (s.notice ? [s.notice] : []),
    upiId: s.upi_id, qrImage: s.qr_image,
    bankDetails: {
      bankName: s.bank_name || '',
      accountName: s.bank_account_name || '',
      accountNumber: s.bank_account_number || '',
      ifsc: s.bank_ifsc || '',
    },
    bonus: { per: BONUS_PER, amount: BONUS_AMOUNT },
    signupBonus: { signup: s.signup_bonus || 0, referral: s.referral_bonus || 0 },
    /* The instant top-up is gone: every deposit is paid to our UPI/QR and
       verified by an admin. Kept in the payload as `false` so an older cached
       page hides the route rather than offering a button that 404s. */
    simulatedDeposit: false,
    cancelWindowMs: CANCEL_WINDOW_MS, claimGraceMs: CLAIM_GRACE_MS,
    cancelReasons: CANCEL_REASONS,
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, at: Date.now() }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/battles', battleRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/payments', paymentUserRoutes);

// Uploaded proof and KYC images (served from disk cache or MongoDB Atlas)
app.get('/uploads/:filename', async (req, res, next) => {
  try {
    const file = await getFile(req.params.filename);
    if (!file) return next();
    res.set('Content-Type', file.mimetype);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(file.buffer);
  } catch (err) {
    next(err);
  }
});
app.use('/uploads', express.static(UPLOAD_ROOT, { maxAge: '7d', index: false }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

/* Every route is a SafeRouter, so async rejections arrive here instead of
   hanging the request. Translate the failures we can name, log the rest. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (res.headersSent) return;

  // Body parser / payload problems are the caller's, not ours.
  if (err?.type === 'entity.too.large')
    return res.status(413).json({ error: 'That request is too large.' });
  if (err instanceof SyntaxError && 'body' in err)
    return res.status(400).json({ error: 'That request body is not valid JSON.' });
  if (err?.name === 'ZodError')
    return res.status(400).json({ error: err.issues?.[0]?.message || 'Check the values you sent.' });
  if (err?.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'That file is too large.' });

  // Mongo duplicate key — a unique index caught a repeat.
  if (err?.code === 11000)
    return res.status(409).json({ error: 'That record already exists.' });

  // Transient replica-set / network blips are worth retrying client-side.
  if (err?.hasErrorLabel?.('TransientTransactionError') || err?.name === 'MongoNetworkError')
    return res.status(503).json({ error: 'The service is busy. Please try again.' });

  console.error('[error]', req.method, req.originalUrl, '-', err?.stack || err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const io = new SocketServer(server, { cors: { origin: checkOrigin, credentials: true } });
app.set('io', io);
attachRealtime(io, app);

/* Route errors are handled by SafeRouter, so a rejection reaching here came
   from a timer, a socket handler or the sweeper. Log it and keep serving —
   one stray rejection should not disconnect every player mid-battle. */
process.on('unhandledRejection', reason => {
  console.error('[unhandledRejection]', reason?.stack || reason);
});

/* An uncaught exception leaves the process in an undefined state, so carrying
   on would mean serving money operations from a half-broken instance. Log it,
   close the listener so in-flight requests finish, and exit non-zero for the
   process manager to restart. */
let shuttingDown = false;
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err?.stack || err);
  /* Set the code up front: installing this handler suppresses Node's default
     exit-1, so a loop that simply drains would otherwise report success. */
  process.exitCode = 1;
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(1));
  // Do not let a hung close keep a broken instance alive.
  setTimeout(() => process.exit(1), 5000).unref();
});

const PORT = Number(process.env.PORT) || 4000;
await connect();
await ensureSeed();
await runBackfills();       // repairs old rows; safe to re-run
startSettlementSweeper(app);
startBotEngine(app);        // lobby activity; no money, no ledger rows
/* Print the commission actually in force, in both the framings the rules use.

   The stored number is a share of ONE stake ("8%"), which is always half the
   share of the pot ("4%"). It used to mean the pot share, so an instance
   carried over from before that change takes half of what its operator
   thinks — and nothing on screen would say so. One line at boot makes the
   effective rate checkable straight after a deploy. */
async function logCommission() {
  try {
    const s = await getSettings();
    const both = r => `${+(r * 100).toFixed(2)}% of a stake / ${+(r * 50).toFixed(2)}% of the pot`;
    console.log(`[commission] up to ₹${s.commission_threshold}: ${both(commissionFor(0, s))}`);
    console.log(`[commission] above ₹${s.commission_threshold}: ${both(commissionFor(s.commission_threshold + 1, s))}`);
  } catch (e) {
    console.error('[commission] could not read the rates:', e?.message);
  }
}
await logCommission();

server.listen(PORT, () => {
  console.log(`Khelbro API listening on http://localhost:${PORT}`);
  console.log(`CORS origins: ${ORIGINS.join(', ')} (and all *.vercel.app)`);
  if (process.env.EXPOSE_OTP === 'true') console.log('EXPOSE_OTP is on — dev only.');
});

export { app, server, io };
