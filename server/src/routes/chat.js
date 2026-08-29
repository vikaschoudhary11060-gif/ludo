/* ============================================================
   Live support chat — player side.

   Messages persist, unread counters are per-side, and delivery is
   pushed over Socket.IO to whichever side is not looking. Admin
   endpoints live in routes/admin.js.
   ============================================================ */
import express from 'express';
import { z } from 'zod';
import { db, now, notify } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

/** Every player has exactly one thread; create it lazily. */
export function threadFor(userId) {
  let t = db.prepare('SELECT * FROM chat_threads WHERE user_id = ?').get(userId);
  if (!t) {
    const info = db.prepare('INSERT INTO chat_threads (user_id, created_at) VALUES (?,?)')
      .run(userId, now());
    t = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(info.lastInsertRowid);
  }
  return t;
}

const shape = m => ({
  id: m.id, fromAdmin: !!m.from_admin, author: m.author, kind: m.kind,
  body: m.body, attachment: m.attachment, duration: m.duration,
  readAt: m.read_at, at: m.created_at,
});

/* GET /api/chat — the caller's thread and its messages. */
router.get('/', requireAuth, (req, res) => {
  const t = threadFor(req.user.id);
  const messages = db.prepare(
    'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 300').all(t.id);
  res.json({
    thread: { id: t.id, status: t.status, unread: t.unread_user },
    messages: messages.map(shape),
    adminOnline: !!req.app.get('adminOnline'),
  });
});

/* GET /api/chat/unread */
router.get('/unread', requireAuth, (req, res) => {
  const t = db.prepare('SELECT unread_user FROM chat_threads WHERE user_id = ?').get(req.user.id);
  res.json({ unread: t ? t.unread_user : 0 });
});

/* POST /api/chat/message  { body?, kind?, attachment?, duration? } */
router.post('/message', requireAuth, (req, res) => {
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

  const t = threadFor(req.user.id);
  if (t.status === 'blocked') return res.status(403).json({ error: 'This conversation is closed.' });

  const preview = kind === 'text' ? body : kind === 'image' ? '📷 Photo' : '🎤 Voice message';
  const info = db.transaction(() => {
    const i = db.prepare(`INSERT INTO chat_messages
        (thread_id, from_admin, author, kind, body, attachment, duration, created_at)
        VALUES (?,0,?,?,?,?,?,?)`)
      .run(t.id, req.user.name, kind, body ?? null, attachment ?? null, duration ?? null, now());
    db.prepare(`UPDATE chat_threads SET unread_admin = unread_admin + 1,
                  last_message = ?, last_at = ?, status = CASE WHEN status='resolved' THEN 'open' ELSE status END
                WHERE id = ?`).run(preview, now(), t.id);
    return i;
  })();

  const message = shape(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(info.lastInsertRowid));
  const io = req.app.get('io');
  io?.to(`chat:${t.id}`).emit('chat:message', { threadId: t.id, message });
  io?.to('admins').emit('chat:activity', {
    threadId: t.id, userId: req.user.id, userName: req.user.name, preview, at: now(),
  });
  res.status(201).json({ message });
});

/* POST /api/chat/read — the player has seen the agent's replies. */
router.post('/read', requireAuth, (req, res) => {
  const t = threadFor(req.user.id);
  db.prepare('UPDATE chat_threads SET unread_user = 0 WHERE id = ?').run(t.id);
  db.prepare('UPDATE chat_messages SET read_at = ? WHERE thread_id = ? AND from_admin = 1 AND read_at IS NULL')
    .run(now(), t.id);
  req.app.get('io')?.to('admins').emit('chat:read', { threadId: t.id });
  res.json({ ok: true });
});

export default router;
