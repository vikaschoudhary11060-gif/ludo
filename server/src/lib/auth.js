import jwt from 'jsonwebtoken';
import { col, publicUser } from './db.js';

const SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const EXPIRES = process.env.JWT_EXPIRES || '7d';

export const sign = (userId, epoch = 0) => jwt.sign({ uid: userId, se: epoch }, SECRET, { expiresIn: EXPIRES });

export function verify(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verify(token);
  if (!payload) return res.status(401).json({ error: 'Not signed in.' });

  const user = await col('users').findOne({ id: payload.uid });
  if (!user) return res.status(401).json({ error: 'Account not found.' });
  if (user.banned) return res.status(403).json({ error: 'You are blocked by admin.' });
  if ((payload.se || 0) < (user.session_epoch || 0))
    return res.status(401).json({ error: 'Session ended. Please sign in again.' });

  req.user = user;
  req.publicUser = publicUser(user);
  req.clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  next();
}

export async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verify(token);
  if (payload) {
    const user = await col('users').findOne({ id: payload.uid });
    if (user && !user.banned) { req.user = user; req.publicUser = publicUser(user); }
  }
  next();
}
