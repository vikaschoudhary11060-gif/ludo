/* Support messages (MongoDB). */
import express from 'express';
import { z } from 'zod';
import { col, nextId, now } from '../lib/db.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';

const router = express.Router();

router.post('/', optionalAuth, async (req, res) => {
  const schema = z.object({
    topic: z.string().max(60).optional(),
    email: z.string().email().optional(),
    message: z.string().trim().min(5).max(2000),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Add a few more words to your message.' });
  const { topic, email, message } = parsed.data;
  await col('support_messages').insertOne({
    id: await nextId('support_messages'), user_id: req.user?.id ?? null,
    body: `[${topic || 'general'}]${email ? ' <' + email + '>' : ''} ${message}`, created_at: now(),
  });
  res.status(201).json({ ok: true });
});

router.get('/mine', requireAuth, async (req, res) => {
  const messages = await col('support_messages').find({ user_id: req.user.id }, { projection: { _id: 0 } })
    .sort({ created_at: 1 }).limit(200).toArray();
  res.json({ messages });
});

export default router;
