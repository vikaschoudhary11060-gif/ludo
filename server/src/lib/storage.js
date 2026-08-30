/* ============================================================
   Persistent File Storage — MongoDB Atlas + Local Disk Cache.

   Solves the ephemeral filesystem issue on Render by storing
   all uploaded images permanently in MongoDB Atlas while caching
   locally on disk for fast static delivery.
   ============================================================ */
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { col, now } from './db.js';

export const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

export const memoryStorage = multer.memoryStorage();

const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const ALLOWED_TYPES = new Set(Object.keys(EXTENSIONS));

/**
 * Save an uploaded file buffer permanently to MongoDB Atlas and local disk cache.
 * Returns the public URL path (e.g. `/uploads/user1-1788085-abcd.jpg`).
 */
export async function saveFile(file, prefix = 'up', userId = null) {
  if (!file || !file.buffer) throw new Error('NO_FILE_BUFFER');

  const ext = EXTENSIONS[file.mimetype] || path.extname(file.originalname || '') || '.png';
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${cleanExt}`;

  // 1. Save permanently in MongoDB
  await col('uploads').insertOne({
    filename,
    mimetype: file.mimetype,
    size: file.size || file.buffer.length,
    data: file.buffer,
    uploaded_by: userId,
    created_at: now(),
  });

  // 2. Write to local disk as read-through cache
  try {
    const diskPath = path.join(UPLOAD_ROOT, filename);
    await fs.promises.writeFile(diskPath, file.buffer);
  } catch (err) {
    console.warn('[storage] Failed to write local cache file:', err.message);
  }

  return `/uploads/${filename}`;
}

/**
 * Retrieve a file by filename from local disk cache or MongoDB Atlas.
 * Returns { buffer, mimetype } or null.
 */
export async function getFile(filename) {
  const cleanName = path.basename(filename);
  const diskPath = path.join(UPLOAD_ROOT, cleanName);

  // Try local disk cache first
  if (fs.existsSync(diskPath)) {
    try {
      const ext = path.extname(cleanName).toLowerCase();
      const mimetype = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : 'application/octet-stream';
      const buffer = await fs.promises.readFile(diskPath);
      return { buffer, mimetype };
    } catch {
      // Fall through to Mongo
    }
  }

  // Fallback to MongoDB Atlas
  const doc = await col('uploads').findOne({ filename: cleanName });
  if (!doc || !doc.data) return null;

  const buffer = doc.data.buffer ? doc.data.buffer : doc.data;

  // Re-populate disk cache
  try {
    await fs.promises.writeFile(diskPath, buffer);
  } catch {}

  return {
    buffer,
    mimetype: doc.mimetype || 'image/jpeg',
  };
}
