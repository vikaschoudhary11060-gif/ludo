/* Push subscription management. */
import express from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { publicKey, saveSubscription, removeSubscription, sendToUser, pushEnabled } from '../lib/push.js';

const router = express.Router();

/* GET /api/push/key — the VAPID public key the browser needs to subscribe. */
router.get('/key', (_req, res) => res.json({ enabled: pushEnabled, publicKey: publicKey() }));

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(5) }),
});

/* POST /api/push/subscribe */
router.post('/subscribe', requireAuth, (req, res) => {
  const parsed = subSchema.safeParse(req.body?.subscription ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid subscription.' });
  saveSubscription(req.user.id, parsed.data);
  res.status(201).json({ ok: true });
});

/* POST /api/push/unsubscribe */
router.post('/unsubscribe', requireAuth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Endpoint required.' });
  removeSubscription(endpoint);
  res.json({ ok: true });
});

/* POST /api/push/test — sends one to the caller, for checking a device. */
router.post('/test', requireAuth, async (req, res) => {
  const result = await sendToUser(req.user.id, {
    title: 'Khelbro', body: 'Push notifications are working.', url: '/notifications.html',
  });
  res.json(result);
});

export default router;
