/* ============================================================
   Web Push — free. VAPID keys are self-generated (see .env);
   delivery runs through the browser vendors' own push services,
   so there is no account and no per-message cost.
   ============================================================ */
import webpush from 'web-push';
import { db, now } from './db.js';

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
export const pushEnabled = !!(PUBLIC && PRIVATE);

if (pushEnabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@example.com', PUBLIC, PRIVATE);
} else {
  console.warn('[push] VAPID keys missing — push notifications are disabled.');
}

export const publicKey = () => PUBLIC || null;

export function saveSubscription(userId, sub) {
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET
                user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/**
 * Fire-and-forget push to every device a user has registered.
 * A 404/410 means the subscription is dead — drop it rather than retrying forever.
 */
export async function sendToUser(userId, payload) {
  if (!pushEnabled) return { sent: 0, skipped: true };
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  await Promise.all(subs.map(async row => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(row.endpoint);
      else console.warn('[push] send failed', err.statusCode || err.message);
    }
  }));
  return { sent };
}
