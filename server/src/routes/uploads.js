/* File uploads — battle result screenshots and KYC documents.

   Stored on local disk under ./data/uploads. Swap the storage engine
   for S3/R2 in production; nothing else needs to change. */
import express from 'express';
import { SafeRouter } from '../lib/safe-router.js';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multerLib from 'multer';
import { col, now, nextId, notify } from '../lib/db.js';
import { parseOfflineEkyc, mobileMatches, certAvailable } from '../lib/aadhaar-offline.js';
import { requireAuth } from '../lib/auth.js';

const router = SafeRouter();

const ROOT = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
fs.mkdirSync(ROOT, { recursive: true });

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ROOT),
  filename: (req, file, cb) => {
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype];
    cb(null, `${req.user.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.has(file.mimetype) ? cb(null, true) : cb(new Error('BAD_TYPE')),
});

/* Multer errors are thrown, not passed as status codes — translate them. */
function handle(field) {
  return (req, res, next) =>
    upload.single(field)(req, res, err => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (max 5 MB).' });
      if (err.message === 'BAD_TYPE') return res.status(415).json({ error: 'Only JPG, PNG or WebP images are allowed.' });
      return res.status(400).json({ error: 'Upload failed. Try again.' });
    });
}

/* POST /api/uploads/proof  (multipart: file)  -> { url } */
router.post('/proof', requireAuth, handle('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload screenshot.' });
  res.status(201).json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

/* POST /api/uploads/avatar  (multipart: file) -> { url } */
router.post('/avatar', requireAuth, handle('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
  const url = `/uploads/${req.file.filename}`;
  await col('users').updateOne({ id: req.user.id }, { $set: { avatar_url: url } });
  res.status(201).json({ url });
});

/* POST /api/uploads/kyc/:slot  slot = front | back | selfie */
router.post('/kyc/:slot', requireAuth, handle('file'), async (req, res) => {
  const slot = req.params.slot;
  if (!['front', 'back', 'selfie'].includes(slot)) return res.status(400).json({ error: 'Unknown document slot.' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file.' });
  const path = `/uploads/${req.file.filename}`;
  await col('kyc_documents').updateOne({ user_id: req.user.id, slot },
    { $set: { path, created_at: now() }, $setOnInsert: { user_id: req.user.id, slot } }, { upsert: true });
  res.status(201).json({ url: path, slot });
});

/* ---------- offline Aadhaar eKYC (free, no UIDAI licence) ---------- */

// The eKYC file is a ZIP, so it needs its own memory-backed uploader.
const zipUpload = multerLib({
  storage: multerLib.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
}).single('file');

/* POST /api/uploads/ekyc   multipart: file=<zip>, shareCode=<4 chars> */
router.post('/ekyc', requireAuth, (req, res) => {
  zipUpload(req, res, async err => {
    if (err) return res.status(400).json({ error: 'Upload failed. Try again.' });
    if (!req.file) return res.status(400).json({ error: 'Choose your offline eKYC ZIP file.' });

    const shareCode = String(req.body?.shareCode || '').trim();
    if (!/^[A-Za-z0-9]{4}$/.test(shareCode))
      return res.status(400).json({ error: 'Enter the 4-character share code you set on the UIDAI site.' });

    let data;
    try {
      data = parseOfflineEkyc(req.file.buffer, shareCode);
    } catch (e) {
      const map = {
        BAD_SHARE_CODE: 'That share code does not open the file. Check and try again.',
        NO_XML: 'That ZIP does not contain an eKYC XML file.',
        NOT_OFFLINE_EKYC: 'That file is not an offline eKYC download.',
      };
      return res.status(400).json({ error: map[e.message] || 'Could not read that file.' });
    }

    // The eKYC must belong to the phone number on the account.
    const ownsNumber = mobileMatches(data.mobile, req.user.phone, shareCode);

    // Auto-approve only when UIDAI's signature checks out AND the mobile matches.
    const autoApprove = data.verified && ownsNumber;

    await col('users').updateOne({ id: req.user.id }, { $set: {
      kyc_status: autoApprove ? 'done' : 'pending', kyc_method: 'offline-ekyc',
      legal_name: data.name, kyc_reference: data.referenceId, kyc_masked: data.maskedAadhaar,
      kyc_dob: data.dob, kyc_verified_at: autoApprove ? now() : null } });

    await notify(req.user.id,
      autoApprove ? 'KYC verified' : 'KYC submitted',
      autoApprove ? 'Your identity is verified. Withdrawals are unlocked.'
                  : 'We received your documents. A reviewer will confirm shortly.');

    res.status(201).json({
      status: autoApprove ? 'done' : 'pending',
      signatureVerified: data.verified,
      signatureReason: data.verifyReason,
      mobileMatched: ownsNumber,
      certificateConfigured: certAvailable(),
      name: data.name, dob: data.dob, gender: data.gender,
      maskedAadhaar: data.maskedAadhaar, address: data.address,
    });
  });
});

export { router as default, ROOT as UPLOAD_ROOT };
