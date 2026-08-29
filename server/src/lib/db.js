/* ============================================================
   Data layer — MongoDB.

   Preserves the exact interface and money semantics of the
   original SQLite version: integer ids, three wallet buckets,
   deposit-spent-before-winnings, transactional credit/debit.

   All helpers are async now. Pass a Mongo `session` to run inside
   a transaction (the wallet paths do).
   ============================================================ */
import { col, nextId, withTransaction, connect } from './mongo.js';

export { col, nextId, withTransaction, connect };
export const now = () => Date.now();

/* One-time: ensure the singleton settings document exists. */
export async function ensureSeed() {
  const existing = await col('settings').findOne({ id: 1 });
  if (!existing) {
    await col('settings').insertOne({
      id: 1, withdraw_open: 1, deposit_open: 1, maintenance: 0, notice: null,
      commission: 0.05, battle_limit: 2, referral_rate: 0.02, upi_id: 'khelbro@upi', qr_image: null,
    });
  }
}

export async function getSettings() {
  return (await col('settings').findOne({ id: 1 })) || {};
}

/* ---------- wallet ---------- */

export async function getWallet(userId) {
  return await col('wallets').findOne({ user_id: userId }, { projection: { _id: 0, deposit: 1, winnings: 1, referral: 1 } });
}

export async function spendable(userId) {
  const w = await getWallet(userId);
  return w ? w.deposit + w.winnings : 0;
}

async function insertTx(entry, session) {
  const doc = { id: await nextId('transactions'), created_at: now(), status: 'success', ref_id: null, ...entry };
  await col('transactions').insertOne(doc, session ? { session } : undefined);
}

/** Credit a bucket and log a transaction. */
export async function credit(userId, bucket, amount, note, refId = null, status = 'success', session = null) {
  await col('wallets').updateOne({ user_id: userId }, { $inc: { [bucket]: amount } }, session ? { session } : undefined);
  await insertTx({ user_id: userId, type: 'credit', bucket, amount, note, status, ref_id: refId }, session);
}

/** Spend deposit first, then winnings. Returns false if short. */
export async function debit(userId, amount, note, refId = null, session = null) {
  const w = await getWallet(userId);
  if (!w || w.deposit + w.winnings < amount) return false;
  const fromDeposit = Math.min(w.deposit, amount);
  const fromWinnings = amount - fromDeposit;
  await col('wallets').updateOne({ user_id: userId },
    { $inc: { deposit: -fromDeposit, winnings: -fromWinnings } }, session ? { session } : undefined);
  if (fromDeposit) await insertTx({ user_id: userId, type: 'debit', bucket: 'deposit', amount: fromDeposit, note, ref_id: refId }, session);
  if (fromWinnings) await insertTx({ user_id: userId, type: 'debit', bucket: 'winnings', amount: fromWinnings, note, ref_id: refId }, session);
  return true;
}

/* ---------- notifications (also pushes to the device) ---------- */
export async function notify(userId, title, body, data = {}) {
  await col('notifications').insertOne({
    id: await nextId('notifications'), user_id: userId, title, body, read: 0, created_at: now(),
  });
  import('./push.js').then(m => m.sendToUser(userId, { title, body, ...data })).catch(() => {});
}

/* ---------- audit ---------- */
export async function audit(admin, action, { targetType = null, targetId = null, detail = null, ip = null } = {}) {
  await col('audit_log').insertOne({
    id: await nextId('audit_log'), admin_id: admin?.id ?? null, admin_name: admin?.username ?? 'unknown',
    action, target_type: targetType, target_id: targetId,
    detail: detail ? JSON.stringify(detail) : null, ip, created_at: now(),
  });
}

/* ---------- shaping ---------- */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, phone: u.phone, name: u.name, avatar: u.avatar, avatarUrl: u.avatar_url,
    email: u.email, emailVerified: !!u.email_verified,
    kyc: u.kyc_status, kycMethod: u.kyc_method, kycMasked: u.kyc_masked,
    referralCode: u.referral_code, createdAt: u.created_at,
  };
}
