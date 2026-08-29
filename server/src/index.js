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
import adminRoutes from './routes/admin.js';
import pushRoutes from './routes/push.js';
import chatRoutes from './routes/chat.js';
import { userRouter as paymentUserRoutes } from './routes/payments.js';
import { attachRealtime } from './realtime.js';
import { MODES, DEPOSIT, WITHDRAW } from './lib/config.js';
import { getSettings } from './lib/db.js';

const app = express();
const server = http.createServer(app);

const ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',').map(s => s.trim());

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 240 }));

/* Public config so the front end never hard-codes business rules. */
app.get('/api/config', (_req, res) => {
  const s = getSettings();
  res.json({
    modes: MODES, deposit: DEPOSIT, withdraw: WITHDRAW,
    commission: s.commission, referralRate: s.referral_rate, battleLimit: s.battle_limit,
    withdrawOpen: !!s.withdraw_open, depositOpen: !!s.deposit_open,
    maintenance: !!s.maintenance, notice: s.notice, upiId: s.upi_id, qrImage: s.qr_image,
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
app.use('/api/payments', paymentUserRoutes);

// Uploaded proof and KYC images.
app.use('/uploads', express.static(UPLOAD_ROOT, { maxAge: '7d', index: false }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const io = new SocketServer(server, { cors: { origin: ORIGINS, credentials: true } });
app.set('io', io);
attachRealtime(io, app);

const PORT = Number(process.env.PORT) || 4000;
server.listen(PORT, () => {
  console.log(`Khelbro API listening on http://localhost:${PORT}`);
  console.log(`CORS origins: ${ORIGINS.join(', ')}`);
  if (process.env.EXPOSE_OTP === 'true') console.log('EXPOSE_OTP is on — dev only.');
});

export { app, server, io };
