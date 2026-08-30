/* ============================================================
   Payment methods — admin manages up to N UPI IDs + QR codes;
   players are spread across the active ones.
   ============================================================ */
import { SafeRouter } from '../lib/safe-router.js';
import { z } from 'zod';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { col, nextId, now, audit } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { requireAdmin } from '../lib/admin-auth.js';
import { memoryStorage, ALLOWED_TYPES, saveFile } from '../lib/storage.js';

export const MAX_METHODS = 10;

const qrUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_r, file, cb) => cb(null, ALLOWED_TYPES.has(file.mimetype)),
}).single('file');

const activeMethods = () =>
  col('payment_methods').find({ active: 1 }).sort({ id: 1 }).toArray();

/** Stable per-user assignment across the active methods. */
export async function methodForUser(userId) {
  const list = await activeMethods();
  if (!list.length) return null;
  return list[userId % list.length];
}

/* ---------- player: which UPI/QR do I pay to? ---------- */
export const userRouter = SafeRouter();
userRouter.get('/deposit-method', requireAuth, async (req, res) => {
  const m = await methodForUser(req.user.id);
  if (!m) {
    const st = await col('settings').findOne({ id: 1 });
    if (st?.upi_id) return res.json({ method: { upiId: st.upi_id, qrImage: st.qr_image, label: 'UPI' } });
    return res.json({ method: null });
  }
  res.json({ method: { id: m.id, upiId: m.upi_id, qrImage: m.qr_image, label: m.label || 'UPI' } });
});

/* ---------- admin: manage methods ---------- */
export const adminRouter = SafeRouter();

/* GET /admin/payment-methods — each with total collected + request count. */
adminRouter.get('/payment-methods', async (_req, res) => {
  const methods = await col('payment_methods').find().sort({ id: 1 }).toArray();
  const totals = await col('deposit_requests').aggregate([
    { $group: { _id: '$method_id',
        collected: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] } },
        approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } } } },
  ]).toArray();
  const byId = Object.fromEntries(totals.map(t => [t._id, t]));
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

adminRouter.post('/payment-methods', requireAdmin('owner'), async (req, res) => {
  const schema = z.object({
    upiId: z.string().trim().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/, 'Enter a valid UPI ID.'),
    label: z.string().trim().max(40).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const count = await col('payment_methods').countDocuments();
  if (count >= MAX_METHODS) return res.status(400).json({ error: `You can add at most ${MAX_METHODS} payment methods.` });
  const id = await nextId('payment_methods');
  await col('payment_methods').insertOne({ id, upi_id: parsed.data.upiId, qr_image: null,
    label: parsed.data.label || null, active: 1, created_at: now() });
  await audit(req.admin, 'payment.add', { targetType: 'method', targetId: String(id), detail: parsed.data, ip: req.clientIp });
  res.status(201).json({ id });
});

adminRouter.patch('/payment-methods/:id', requireAdmin('owner'), async (req, res) => {
  const set = {};
  if (typeof req.body?.active === 'boolean') set.active = req.body.active ? 1 : 0;
  if (typeof req.body?.label === 'string') set.label = req.body.label.slice(0, 40);
  if (typeof req.body?.upiId === 'string' && /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(req.body.upiId)) set.upi_id = req.body.upiId;
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  await col('payment_methods').updateOne({ id: Number(req.params.id) }, { $set: set });
  await audit(req.admin, 'payment.update', { targetType: 'method', targetId: req.params.id, detail: req.body, ip: req.clientIp });
  res.json({ ok: true });
});

adminRouter.delete('/payment-methods/:id', requireAdmin('owner'), async (req, res) => {
  await col('payment_methods').deleteOne({ id: Number(req.params.id) });
  await audit(req.admin, 'payment.delete', { targetType: 'method', targetId: req.params.id, ip: req.clientIp });
  res.json({ ok: true });
});

adminRouter.post('/payment-methods/:id/qr', requireAdmin('owner'), (req, res) => {
  qrUpload(req, res, async err => {
    if (err) return res.status(400).json({ error: 'Upload failed (PNG/JPG/WebP, max 3MB).' });
    if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
    const url = await saveFile(req.file, `qr-method-${req.params.id}`);
    await col('payment_methods').updateOne({ id: Number(req.params.id) }, { $set: { qr_image: url } });
    await audit(req.admin, 'payment.qr', { targetType: 'method', targetId: req.params.id, ip: req.clientIp });
    res.status(201).json({ url });
  });
});

export default adminRouter;
