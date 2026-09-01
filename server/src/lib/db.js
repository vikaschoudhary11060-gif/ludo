/* ============================================================
   Data layer — MongoDB.

   Preserves the exact interface and money semantics of the
   original SQLite version: integer ids, three wallet buckets,
   deposit-spent-before-winnings, transactional credit/debit.

   All helpers are async now. Pass a Mongo `session` to run inside
   a transaction (the wallet paths do).
   ============================================================ */
import { col, nextId, withTransaction, connect } from './mongo.js';
import { SETTINGS_DEFAULTS } from './config.js';

export { col, nextId, withTransaction, connect };
export const now = () => Date.now();

/* One-time: ensure the singleton settings document exists and active battles have recorded stakes. */
export async function ensureSeed() {
  const existing = await col('settings').findOne({ id: 1 });
  if (!existing) {
    await col('settings').insertOne({ id: 1, ...SETTINGS_DEFAULTS });
  } else {
    // Backfill any key an older settings document predates, so routes never
    // read undefined for a number they are about to multiply.
    const missing = Object.fromEntries(
      Object.entries(SETTINGS_DEFAULTS).filter(([k]) => existing[k] === undefined));
    if (Object.keys(missing).length) await col('settings').updateOne({ id: 1 }, { $set: missing });
  }

  // Ensure active battles have creator_stake recorded so refunds go back to original wallets
  try {
    const unbacked = await col('battles').find({
      status: { $in: ['open', 'requested', 'waiting', 'running', 'disputed'] },
      creator_stake: { $exists: false }
    }).toArray();
    for (const b of unbacked) {
      if (!b.creator_id) continue;
      const txs = await col('transactions').find({ ref_id: b.id, user_id: b.creator_id, type: 'debit' }).toArray();
      let dep = 0, win = 0;
      for (const t of txs) {
        if (t.bucket === 'deposit') dep += t.amount;
        if (t.bucket === 'winnings') win += t.amount;
      }
      const split = (dep + win === b.amount) ? { deposit: dep, winnings: win } : { deposit: b.amount, winnings: 0 };
      await col('battles').updateOne({ id: b.id }, { $set: { creator_stake: split } });
    }
  } catch {}
}

/** Settings with every key guaranteed present and numeric fields sane. */
export async function getSettings() {
  const row = (await col('settings').findOne({ id: 1 })) || {};
  const s = { ...SETTINGS_DEFAULTS, ...row };
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  s.commission    = num(s.commission,    SETTINGS_DEFAULTS.commission);
  s.referral_rate = num(s.referral_rate, SETTINGS_DEFAULTS.referral_rate);
  s.battle_limit  = num(s.battle_limit,  SETTINGS_DEFAULTS.battle_limit);
  return s;
}

/* ---------- wallet ---------- */

/** A user's wallet, creating the row if it somehow went missing.
    Callers read .deposit/.winnings directly, so this must never be null. */
export async function getWallet(userId, session = null) {
  const opts = { projection: { _id: 0, deposit: 1, winnings: 1, referral: 1 } };
  if (session) opts.session = session;
  const w = await col('wallets').findOne({ user_id: userId }, opts);
  if (w) return { deposit: w.deposit || 0, winnings: w.winnings || 0, referral: w.referral || 0 };
  await col('wallets').updateOne({ user_id: userId },
    { $setOnInsert: { user_id: userId, deposit: 0, winnings: 0, referral: 0 } },
    session ? { upsert: true, session } : { upsert: true });
  return { deposit: 0, winnings: 0, referral: 0 };
}

export async function spendable(userId, session = null) {
  const w = await getWallet(userId, session);
  return w.deposit + w.winnings;
}

async function insertTx(entry, session) {
  const doc = { id: await nextId('transactions'), created_at: now(), status: 'success', ref_id: null, ...entry };
  await col('transactions').insertOne(doc, session ? { session } : undefined);
}

/** Credit a bucket and log a transaction. */
export async function credit(userId, bucket, amount, note, refId = null, status = 'success', session = null) {
  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error(`credit() refused a non-positive amount (${amount}) for user ${userId}`);
  if (!['deposit', 'winnings', 'referral'].includes(bucket))
    throw new Error(`credit() refused an unknown bucket: ${bucket}`);
  /* Create the wallet if it is somehow absent, so a credit is never lost.
     Every bucket is seeded, because debit()'s `$gte` guards do not match a
     field that is missing rather than zero. */
  const seed = { user_id: userId };
  for (const b of ['deposit', 'winnings', 'referral']) if (b !== bucket) seed[b] = 0;
  await col('wallets').updateOne({ user_id: userId },
    { $inc: { [bucket]: amount }, $setOnInsert: seed },
    session ? { upsert: true, session } : { upsert: true });
  await insertTx({ user_id: userId, type: 'credit', bucket, amount, note, status, ref_id: refId }, session);
}

/** Spend deposit first, then winnings.

    Returns null when the wallet is short, otherwise `{ deposit, winnings }`
    naming how much came from each bucket. Callers record that split so a
    refund can put the money back where it came from — crediting it all to
    deposit would quietly convert a player's withdrawable winnings into
    play-only balance.

    The balance guard is repeated in the update filter, so the deduction is
    atomic even if two requests read the same balance: whichever lands second
    matches nothing and is reported as short rather than going negative. */
export async function debit(userId, amount, note, refId = null, session = null) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const opts = session ? { session } : undefined;
  const w = await col('wallets').findOne({ user_id: userId }, opts);
  if (!w) return null;
  const deposit = w.deposit || 0, winnings = w.winnings || 0;
  if (deposit + winnings < amount) return null;

  const fromDeposit = Math.min(deposit, amount);
  const fromWinnings = amount - fromDeposit;
  /* `$gte` does not match a missing field, so guard only the buckets this
     debit actually draws from — a zero draw needs no guard. */
  const filter = { user_id: userId };
  if (fromDeposit > 0) filter.deposit = { $gte: fromDeposit };
  if (fromWinnings > 0) filter.winnings = { $gte: fromWinnings };
  const res = await col('wallets').updateOne(filter,
    { $inc: { deposit: -fromDeposit, winnings: -fromWinnings } }, opts);
  if (res.matchedCount === 0) return null;       // balance moved under us

  if (fromDeposit) await insertTx({ user_id: userId, type: 'debit', bucket: 'deposit', amount: fromDeposit, note, ref_id: refId }, session);
  if (fromWinnings) await insertTx({ user_id: userId, type: 'debit', bucket: 'winnings', amount: fromWinnings, note, ref_id: refId }, session);
  return { deposit: fromDeposit, winnings: fromWinnings };
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
