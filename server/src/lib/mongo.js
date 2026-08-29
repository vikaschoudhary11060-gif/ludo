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

const URI = (process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL || '').trim();
if (!URI) {
  console.error('❌ Missing MongoDB connection string!');
  console.error('Please set MONGO_URI in your environment variables.');
  console.error('Available env variables:', Object.keys(process.env).filter(k => !k.startsWith('npm_') && !k.startsWith('LESS')));
  throw new Error('MONGO_URI is not set. Please add MONGO_URI to your environment variables on Render.');
}

const client = new MongoClient(URI, { maxPoolSize: 20 });
let database = null;

export async function connect() {
  if (database) return database;
  await client.connect();
  database = client.db('khelbro');
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
  return client.startSession();
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
    d.collection('payment_methods').createIndex({ id: 1 }, { unique: true }),
    d.collection('watchlist').createIndex({ user_id: 1 }, { unique: true }),
    d.collection('settings').createIndex({ id: 1 }, { unique: true }),
  ]);
}

export async function close() {
  await client.close();
  database = null;
}
