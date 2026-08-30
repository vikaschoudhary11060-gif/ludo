/* Live support chat — player side (MongoDB). */
import express from 'express';
import { SafeRouter } from '../lib/safe-router.js';
import { z } from 'zod';
import { col, nextId, now } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = SafeRouter();

/** Every player has exactly one thread; create it lazily. */
export async function threadFor(userId) {
  let t = await col('chat_threads').findOne({ user_id: userId });
  if (!t) {
    t = { id: await nextId('chat_threads'), user_id: userId, status: 'open', subject: null,
          unread_user: 0, unread_admin: 0, last_message: null, last_at: null, created_at: now() };
    await col('chat_threads').insertOne(t);
  }
  return t;
}

const shape = m => ({
  id: m.id, fromAdmin: !!m.from_admin, author: m.author, kind: m.kind,
  body: m.body, attachment: m.attachment, duration: m.duration, readAt: m.read_at, at: m.created_at,
});

/* GET /api/chat */
router.get('/', requireAuth, async (req, res) => {
  const t = await threadFor(req.user.id);
  const messages = await col('chat_messages').find({ thread_id: t.id }).sort({ created_at: 1 }).limit(300).toArray();
  res.json({ thread: { id: t.id, status: t.status, unread: t.unread_user },
             messages: messages.map(shape), adminOnline: !!req.app.get('adminOnline') });
});

/* GET /api/chat/unread */
router.get('/unread', requireAuth, async (req, res) => {
  const t = await col('chat_threads').findOne({ user_id: req.user.id });
  res.json({ unread: t ? t.unread_user : 0 });
});

/* POST /api/chat/message */
router.post('/message', requireAuth, async (req, res) => {
  const schema = z.object({
    body: z.string().trim().max(2000).optional(),
    kind: z.enum(['text', 'image', 'voice']).default('text'),
    attachment: z.string().max(400).optional(),
    duration: z.number().int().min(0).max(600).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Message could not be sent.' });
  const { body, kind, attachment, duration } = parsed.data;
  if (kind === 'text' && !body) return res.status(400).json({ error: 'Type a message first.' });
  if (kind !== 'text' && !attachment) return res.status(400).json({ error: 'Attachment missing.' });

  const t = await threadFor(req.user.id);
  if (t.status === 'blocked') return res.status(403).json({ error: 'This conversation is closed.' });

  const preview = kind === 'text' ? body : kind === 'image' ? '📷 Photo' : '🎤 Voice message';
  const msg = { id: await nextId('chat_messages'), thread_id: t.id, from_admin: 0, admin_id: null,
    author: req.user.name, kind, body: body ?? null, attachment: attachment ?? null,
    duration: duration ?? null, read_at: null, created_at: now() };
  await col('chat_messages').insertOne(msg);
  await col('chat_threads').updateOne({ id: t.id }, {
    $inc: { unread_admin: 1 },
    $set: { last_message: preview, last_at: now(), ...(t.status === 'resolved' ? { status: 'open' } : {}) },
  });

  const message = shape(msg);
  const io = req.app.get('io');
  io?.to(`chat:${t.id}`).emit('chat:message', { threadId: t.id, message });
  io?.to('admins').emit('chat:activity', { threadId: t.id, userId: req.user.id, userName: req.user.name, preview, at: now() });
  res.status(201).json({ message });
});

/* POST /api/chat/read */
router.post('/read', requireAuth, async (req, res) => {
  const t = await threadFor(req.user.id);
  await col('chat_threads').updateOne({ id: t.id }, { $set: { unread_user: 0 } });
  await col('chat_messages').updateMany({ thread_id: t.id, from_admin: 1, read_at: null }, { $set: { read_at: now() } });
  req.app.get('io')?.to('admins').emit('chat:read', { threadId: t.id });
  res.json({ ok: true });
});

export default router;
