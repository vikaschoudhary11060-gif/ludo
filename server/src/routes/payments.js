/* ============================================================
   Payment methods — admin manages up to N UPI IDs + QR codes;
   players are spread across the active ones.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now, audit } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { requireAdmin } from '../lib/admin-auth.js';

export const MAX_METHODS = 10;

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
const qrUpload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, UPLOAD_ROOT),
    filename: (_r, file, cb) => cb(null, 'qr-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') +
      ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype] || '.png')),
  }),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_r, f, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype)),
}).single('file');

const activeMethods = () =>
  db.prepare('SELECT * FROM payment_methods WHERE active = 1 ORDER BY id').all();

/** Stable per-user assignment: same user keeps seeing the same account,
 *  and users are evenly spread across the active methods. */
export function methodForUser(userId) {
  const list = activeMethods();
  if (!list.length) return null;
  return list[userId % list.length];
}

/* ---------- player: which UPI/QR do I pay to? ---------- */
export const userRouter = Router();
userRouter.get('/deposit-method', requireAuth, (req, res) => {
  const m = methodForUser(req.user.id);
  if (!m) {
    // fall back to the single legacy UPI in settings
    const s = db.prepare('SELECT upi_id, qr_image FROM settings WHERE id = 1').get();
    if (s?.upi_id) return res.json({ method: { upiId: s.upi_id, qrImage: s.qr_image, label: 'UPI' } });
    return res.json({ method: null });
  }
  res.json({ method: { id: m.id, upiId: m.upi_id, qrImage: m.qr_image, label: m.label || 'UPI' } });
});

/* ---------- admin: manage methods ---------- */
export const adminRouter = Router();

/* GET /admin/payment-methods — each with total collected + request count. */
adminRouter.get('/payment-methods', (_req, res) => {
  const methods = db.prepare('SELECT * FROM payment_methods ORDER BY id').all();
  const totals = db.prepare(`
    SELECT method_id,
           COALESCE(SUM(CASE WHEN status='approved' THEN amount END),0) collected,
           SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
    FROM deposit_requests GROUP BY method_id`).all();
  const byId = Object.fromEntries(totals.map(t => [t.method_id, t]));
  res.json({
    max: MAX_METHODS,
    methods: methods.map(m => ({
      id: m.id, upiId: m.upi_id, qrImage: m.qr_image, label: m.label, active: !!m.active,
      collected: byId[m.id]?.collected || 0,
      approved: byId[m.id]?.approved || 0,
      pending: byId[m.id]?.pending || 0,
    })),
  });
});

adminRouter.post('/payment-methods', requireAdmin('owner'), (req, res) => {
  const schema = z.object({
    upiId: z.string().trim().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/, 'Enter a valid UPI ID.'),
    label: z.string().trim().max(40).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const count = db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c;
  if (count >= MAX_METHODS) return res.status(400).json({ error: `You can add at most ${MAX_METHODS} payment methods.` });

  const info = db.prepare('INSERT INTO payment_methods (upi_id, label, created_at) VALUES (?,?,?)')
    .run(parsed.data.upiId, parsed.data.label || null, now());
  audit(req.admin, 'payment.add', { targetType: 'method', targetId: String(info.lastInsertRowid),
                                    detail: parsed.data, ip: req.clientIp });
  res.status(201).json({ id: info.lastInsertRowid });
});

adminRouter.patch('/payment-methods/:id', requireAdmin('owner'), (req, res) => {
  const fields = [], args = [];
  if (typeof req.body?.active === 'boolean') { fields.push('active = ?'); args.push(req.body.active ? 1 : 0); }
  if (typeof req.body?.label === 'string') { fields.push('label = ?'); args.push(req.body.label.slice(0, 40)); }
  if (typeof req.body?.upiId === 'string' && /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(req.body.upiId)) {
    fields.push('upi_id = ?'); args.push(req.body.upiId);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE payment_methods SET ${fields.join(', ')} WHERE id = ?`).run(...args, req.params.id);
  audit(req.admin, 'payment.update', { targetType: 'method', targetId: req.params.id, detail: req.body, ip: req.clientIp });
  res.json({ ok: true });
});

adminRouter.delete('/payment-methods/:id', requireAdmin('owner'), (req, res) => {
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(req.params.id);
  audit(req.admin, 'payment.delete', { targetType: 'method', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

adminRouter.post('/payment-methods/:id/qr', requireAdmin('owner'), (req, res) => {
  qrUpload(req, res, err => {
    if (err) return res.status(400).json({ error: 'Upload failed (PNG/JPG/WebP, max 3MB).' });
    if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
    const url = '/uploads/' + req.file.filename;
    db.prepare('UPDATE payment_methods SET qr_image = ? WHERE id = ?').run(url, req.params.id);
    audit(req.admin, 'payment.qr', { targetType: 'method', targetId: req.params.id, ip: req.clientIp });
    res.status(201).json({ url });
  });
});

export default adminRouter;
