/* ============================================================
   Web Push — free. VAPID keys are self-generated (see .env);
   delivery runs through the browser vendors' own push services,
   so there is no account and no per-message cost.
   ============================================================ */
import webpush from 'web-push';
import { col, nextId, now } from './db.js';

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
export const pushEnabled = !!(PUBLIC && PRIVATE);

if (pushEnabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@example.com', PUBLIC, PRIVATE);
} else {
  console.warn('[push] VAPID keys missing — push notifications are disabled.');
}

export const publicKey = () => PUBLIC || null;

export async function saveSubscription(userId, sub) {
  await col('push_subscriptions').updateOne(
    { endpoint: sub.endpoint },
    { $set: { user_id: userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      $setOnInsert: { id: await nextId('push_subscriptions'), endpoint: sub.endpoint, created_at: now() } },
    { upsert: true });
}

export async function removeSubscription(endpoint) {
  await col('push_subscriptions').deleteOne({ endpoint });
}

/**
 * Fire-and-forget push to every device a user has registered.
 * A 404/410 means the subscription is dead — drop it rather than retrying forever.
 */
export async function sendToUser(userId, payload) {
  if (!pushEnabled) return { sent: 0, skipped: true };
  const subs = await col('push_subscriptions').find({ user_id: userId }).toArray();
  let sent = 0;
  await Promise.all(subs.map(async row => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(row.endpoint);
      else console.warn('[push] send failed', err.statusCode || err.message);
    }
  }));
  return { sent };
}
