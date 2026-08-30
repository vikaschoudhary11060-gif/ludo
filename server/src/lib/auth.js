import jwt from 'jsonwebtoken';
import { col, publicUser } from './db.js';

const DEV_SECRET = 'dev-only-insecure-secret';

/* Values that appear in the repository, so they are public knowledge and
   cannot authenticate anything. */
const PUBLIC_SECRETS = new Set([
  DEV_SECRET,
  'change-me-to-a-long-random-string',
  'change-me',
  'secret',
]);

/* This fallback is published in the repository, so a deployment running on it
   lets anyone mint a token for any account. Refuse to start rather than serve
   forgeable sessions; only an explicit NODE_ENV=development may use it. */
const SECRET = (() => {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (configured && !PUBLIC_SECRETS.has(configured)) {
    // Short secrets are weak but private — warn rather than refuse to boot,
    // so hardening this cannot take a working deployment offline.
    if (configured.length < 32) console.warn(`[auth] JWT_SECRET is only ${configured.length} characters — use at least 32.`);
    return configured;
  }
  if (process.env.NODE_ENV === 'development') {
    console.warn('[auth] JWT_SECRET is unset or public — using the insecure development secret.');
    return DEV_SECRET;
  }
  throw new Error(
    'JWT_SECRET is missing, too short, or set to a value published in this repository. Generate one with `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"` ' +
    'and set it in the environment before starting the server.');
})();

/* The single validated signing secret. Other modules derive from this rather
   than reading JWT_SECRET again, so the checks above cannot be bypassed. */
export const JWT_SECRET = SECRET;

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
