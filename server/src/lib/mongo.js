/* ============================================================
   MongoDB connection + collection accessors.

   The app was originally built on SQLite with integer AUTOINCREMENT
   ids that are referenced everywhere (creator_id, user_id, ...). To
   keep every foreign-key reference working unchanged, we reproduce
   auto-increment integer ids with a `counters` collection instead of
   using ObjectIds.

   connect() must be awaited once at startup before any route runs.
   ============================================================ */
import { MongoClient } from 'mongodb';

const readUri = () =>
  (process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL || '').trim();

/* The connection string is checked when we actually connect, not at import.
   Throwing during module evaluation made every module that transitively
   imports the data layer impossible to load at all — including from tests
   that never touch the database. */
let client = null;
let database = null;

function getClient() {
  if (client) return client;
  const uri = readUri();
  if (!uri) {
    console.error('❌ Missing MongoDB connection string!');
    console.error('Please set MONGO_URI in your environment variables.');
    console.error('Available env variables:',
      Object.keys(process.env).filter(k => !k.startsWith('npm_') && !k.startsWith('LESS')));
    throw new Error('MONGO_URI is not set. Please add MONGO_URI to your environment variables on Render.');
  }
  client = new MongoClient(uri, { maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 50 });
  return client;
}

export async function connect() {
  if (database) return database;
  const c = getClient();
  await c.connect();
  database = c.db('khelbro');
  await ensureIndexes();
  return database;
}

export const db = () => {
  if (!database) throw new Error('MongoDB not connected — call connect() first.');
  return database;
};

/** Collection accessor. */
export const col = name => db().collection(name);

/** Next integer id for a collection — the AUTOINCREMENT replacement. */
export async function nextId(name) {
  const r = await col('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return r.seq;
}

/** A session for multi-document transactions (the wallet needs these). */
export function startSession() {
  return getClient().startSession();
}

/** Run a function inside a transaction, retrying on transient errors. */
export async function withTransaction(fn) {
  const session = startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

async function ensureIndexes() {
  const d = db();
  await Promise.all([
    d.collection('users').createIndex({ id: 1 }, { unique: true }),
    d.collection('users').createIndex({ phone: 1 }, { unique: true }),
    d.collection('users').createIndex({ referral_code: 1 }, { unique: true, sparse: true }),
    d.collection('wallets').createIndex({ user_id: 1 }, { unique: true }),
    d.collection('otps').createIndex({ phone: 1 }, { unique: true }),
    d.collection('transactions').createIndex({ user_id: 1, created_at: -1 }),
    d.collection('battles').createIndex({ id: 1 }, { unique: true }),
    d.collection('battles').createIndex({ status: 1, mode: 1, created_at: -1 }),
    d.collection('battles').createIndex({ creator_id: 1 }),
    d.collection('battles').createIndex({ acceptor_id: 1 }),
    d.collection('battle_claims').createIndex({ battle_id: 1, user_id: 1 }, { unique: true }),
    d.collection('notifications').createIndex({ user_id: 1, created_at: -1 }),
    d.collection('login_events').createIndex({ user_id: 1, created_at: -1 }),
    d.collection('login_events').createIndex({ ip: 1 }),
    d.collection('admin_users').createIndex({ username: 1 }, { unique: true }),
    d.collection('audit_log').createIndex({ created_at: -1 }),
    d.collection('withdrawal_requests').createIndex({ status: 1, created_at: -1 }),
    d.collection('deposit_requests').createIndex({ status: 1, created_at: -1 }),
    d.collection('kyc_documents').createIndex({ user_id: 1, slot: 1 }, { unique: true }),
    d.collection('chat_threads').createIndex({ user_id: 1 }, { unique: true }),
    d.collection('chat_messages').createIndex({ thread_id: 1, created_at: 1 }),
    d.collection('push_subscriptions').createIndex({ endpoint: 1 }, { unique: true }),
    d.collection('referrals').createIndex({ referrer_id: 1, referee_id: 1 }, { unique: true }),
    /* One row per referral payout, so the admin console can list transfers by
       time, by referrer or by the player whose game paid for them without
       scanning the whole wallet ledger. */
    d.collection('referral_earnings').createIndex({ created_at: -1 }),
    d.collection('referral_earnings').createIndex({ referrer_id: 1, created_at: -1 }),
    d.collection('referral_earnings').createIndex({ referee_id: 1, created_at: -1 }),
    d.collection('referral_earnings').createIndex({ battle_id: 1 }),
    d.collection('payment_methods').createIndex({ id: 1 }, { unique: true }),
    d.collection('watchlist').createIndex({ user_id: 1 }, { unique: true }),
    d.collection('settings').createIndex({ id: 1 }, { unique: true }),
    d.collection('battles').createIndex({ created_at: -1 }),
    d.collection('battles').createIndex({ winner_id: 1 }),
    d.collection('battles').createIndex({ status: 1, settled_at: -1 }),
    d.collection('users').createIndex({ kyc_status: 1 }),
    d.collection('users').createIndex({ created_at: -1 }),
    d.collection('transactions').createIndex({ type: 1, bucket: 1, created_at: -1 }),
    d.collection('chat_threads').createIndex({ unread_admin: -1, last_at: -1 }),
    /* Lobby bots: the engine sweeps by these on every tick, and every admin
       figure filters battles and users on is_bot. */
    d.collection('battles').createIndex({ is_bot: 1, status: 1 }),
    d.collection('battles').createIndex({ is_bot: 1, bot_retire_at: 1 }, { sparse: true }),
    /* The open window's safety net sweeps on this every tick. */
    d.collection('battles').createIndex({ is_bot: 1, bot_accept_at: 1 }, { sparse: true }),
    d.collection('users').createIndex({ is_bot: 1 }),

    /* ---- indexes the hot paths were missing ----
       Pure performance: an index changes which rows are scanned, never which
       rows come back. */

    /* Refunds and the settlement sweeper rebuild a player's stake split from
       the ledger by battle id, and that runs INSIDE the settlement
       transaction — a collection scan there holds locks for as long as the
       ledger is big. The referral backfill reads the same field. */
    d.collection('transactions').createIndex({ ref_id: 1 }),

    /* /battles/mine is an $or over these two fields sorted by created_at, and
       the lobby asks for it on every load and every poll. With only the
       single-field indexes each branch came back unsorted and Mongo sorted
       the union in memory; carrying created_at in the index removes that
       blocking sort. They also serve the two counts on /auth/me, which every
       page load makes. */
    d.collection('battles').createIndex({ creator_id: 1, created_at: -1 }),
    d.collection('battles').createIndex({ acceptor_id: 1, created_at: -1 }),

    /* The admin player view reads a single player's requests newest-first.
       The existing indexes are keyed on status, which does not serve it. */
    d.collection('deposit_requests').createIndex({ user_id: 1, created_at: -1 }),
    d.collection('withdrawal_requests').createIndex({ user_id: 1, created_at: -1 }),
  ]);
}

export async function close() {
  if (client) await client.close();
  client = null;
  database = null;
}
