import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { col, nextId, now } from './db.js';
import { JWT_SECRET } from './auth.js';

// Derived from the validated app secret, so admin tokens inherit its checks.
const SECRET = JWT_SECRET + ':admin';
const EXPIRES = process.env.ADMIN_JWT_EXPIRES || '12h';

export const ROLES = ['owner', 'admin', 'viewer'];
const RANK = { viewer: 0, admin: 1, owner: 2 };

export const hash = pw => bcrypt.hashSync(pw, 10);

export async function createAdmin({ username, name, password, role = 'admin' }) {
  if (!/^[a-z0-9._-]{3,24}$/i.test(username)) throw new Error('Username must be 3-24 letters, digits, dot, dash or underscore.');
  if (String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  const existing = await col('admin_users').findOne({ username: username.toLowerCase() });
  if (existing) { const e = new Error('UNIQUE'); e.code = 'UNIQUE'; throw e; }
  const admin = {
    id: await nextId('admin_users'), username: username.toLowerCase(), name: name || username,
    password_hash: hash(password), role, active: 1, last_login_at: null, created_at: now(),
  };
  await col('admin_users').insertOne(admin);
  return { id: admin.id, username: admin.username, name: admin.name, role: admin.role };
}

export async function verifyLogin(username, password) {
  const row = await col('admin_users').findOne({ username: String(username || '').toLowerCase() });
  const stored = row ? row.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = bcrypt.compareSync(String(password || ''), stored);
  if (!row || !ok || !row.active) return null;
  await col('admin_users').updateOne({ id: row.id }, { $set: { last_login_at: now() } });
  return row;
}

export const signAdmin = admin => jwt.sign({ aid: admin.id, role: admin.role }, SECRET, { expiresIn: EXPIRES });

/** Verify an admin token. The one place that knows the admin secret, so HTTP
    and socket admin auth can never diverge. */
export function verifyAdminToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

export function requireAdmin(min = 'viewer') {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyAdminToken(token);
    if (!payload) return res.status(401).json({ error: 'Sign in to continue.' });
    const admin = await col('admin_users').findOne({ id: payload.aid });
    if (!admin || !admin.active) return res.status(401).json({ error: 'Account is no longer active.' });
    if (RANK[admin.role] < RANK[min]) return res.status(403).json({ error: 'Your role does not allow that.' });
    req.admin = admin;
    req.clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    next();
  };
}

export const adminCount = async () => await col('admin_users').countDocuments();
