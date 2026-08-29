/* Support messages. Persisted so an admin tool can pick them up. */
import express from 'express';
import { z } from 'zod';
import { db, now } from '../lib/db.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';

const router = express.Router();

router.post('/', optionalAuth, (req, res) => {
  const schema = z.object({
    topic: z.string().max(60).optional(),
    email: z.string().email().optional(),
    message: z.string().trim().min(5).max(2000),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Add a few more words to your message.' });
  const { topic, email, message } = parsed.data;

  db.prepare('INSERT INTO support_messages (user_id, body, created_at) VALUES (?,?,?)')
    .run(req.user?.id ?? null,
         `[${topic || 'general'}]${email ? ' <' + email + '>' : ''} ${message}`, now());
  res.status(201).json({ ok: true });
});

router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM support_messages WHERE user_id = ?
                           ORDER BY created_at ASC LIMIT 200`).all(req.user.id);
  res.json({ messages: rows });
});

export default router;
