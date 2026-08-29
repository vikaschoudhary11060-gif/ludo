/* Demo data seeder for MongoDB:  npm run seed:demo
   DESTRUCTIVE — wipes the app collections and rebuilds a small,
   ledger-consistent dataset so the admin console has content. */
import 'dotenv/config';
import crypto from 'node:crypto';
import { connect, col, nextId, now, credit, ensureSeed } from './lib/db.js';

await connect();
await ensureSeed();

const COLLECTIONS = ['users', 'wallets', 'otps', 'transactions', 'battles', 'battle_claims',
  'notifications', 'referrals', 'login_events', 'withdrawal_requests', 'deposit_requests',
  'kyc_documents', 'chat_threads', 'chat_messages', 'support_messages', 'payment_methods',
  'watchlist'];
for (const c of COLLECTIONS) await col(c).deleteMany({});
await ensureSeed();   // re-create the settings row

const NAMES = ['RaviTheKing','PriyaPlays','AmitRolls','SnehaSix','VikramV','NehaN','ArjunA','KavyaK',
  'RohitR','MeeraM','DevDhaba','AnjaliA','KabirK','IshaI','ManavM','RiyaR','YashY','ZaraZ'];
const DAY = 864e5, NOW = Date.now();
const ago = d => NOW - Math.round(d * DAY);
const pick = a => a[Math.floor(Math.random() * a.length)];
const newId = () => crypto.randomBytes(6).toString('hex');

/* payment methods */
for (const [upi, label] of [['khelbro1@okaxis', 'Axis'], ['khelbro2@ybl', 'PhonePe'], ['khelbro3@paytm', 'Paytm']]) {
  await col('payment_methods').insertOne({ id: await nextId('payment_methods'), upi_id: upi, qr_image: null, label, active: 1, created_at: NOW });
}

/* users + wallets + opening deposit */
const users = [];
for (let i = 0; i < NAMES.length; i++) {
  const id = await nextId('users');
  const created = ago(2 + Math.random() * 40);
  const kyc = Math.random() < 0.3 ? 'done' : Math.random() < 0.25 ? 'pending' : 'none';
  await col('users').insertOne({ id, phone: '9' + String(100000000 + i * 137 + 11).slice(0, 9),
    name: NAMES[i], avatar: i % 8, email: null, avatar_url: null, email_verified: 0,
    kyc_status: kyc, kyc_method: null, kyc_reference: null, kyc_masked: null, kyc_dob: null,
    legal_name: kyc === 'none' ? null : NAMES[i], referral_code: 'KHEL-' + (1000 + i * 7),
    referred_by: null, banned: 0, session_epoch: 0, created_at: created });
  await col('wallets').insertOne({ user_id: id, deposit: 0, winnings: 0, referral: 0 });
  const dep = pick([1000, 2000, 5000, 10000]);
  await credit(id, 'deposit', dep, 'Deposit', null, 'success');
  await col('login_events').insertOne({ id: await nextId('login_events'), user_id: id,
    ip: '10.0.0.' + (i % 6), user_agent: 'DemoAgent', created_at: created });
  users.push({ id, name: NAMES[i], kyc });
}

/* battles across statuses */
const COMM = 0.05;
let stats = {};
for (let n = 0; n < 60; n++) {
  const at = ago(Math.random() * 35);
  const amount = pick([50, 100, 250, 500, 1000, 2500, 5000]);
  const a = pick(users); let b = pick(users); if (b.id === a.id) b = users[(users.indexOf(a) + 3) % users.length];
  const roll = Math.random();
  const status = roll < 0.5 ? 'completed' : roll < 0.62 ? 'cancelled' : roll < 0.72 ? 'disputed' : roll < 0.82 ? 'running' : roll < 0.9 ? 'waiting' : 'open';
  stats[status] = (stats[status] || 0) + 1;
  const id = newId();
  const solo = status === 'open';
  // fund + stake (top up so nobody goes negative)
  for (const u of solo ? [a] : [a, b]) {
    const w = await col('wallets').findOne({ user_id: u.id });
    if (w.deposit < amount) await credit(u.id, 'deposit', Math.ceil((amount - w.deposit) / 500) * 500, 'Deposit', null, 'success');
    await col('wallets').updateOne({ user_id: u.id }, { $inc: { deposit: -amount } });
    await col('transactions').insertOne({ id: await nextId('transactions'), user_id: u.id, type: 'debit', bucket: 'deposit', amount, note: 'Battle stake', status: 'success', ref_id: id, created_at: at });
  }
  let winner = null, payout = null, settled = null;
  if (status === 'completed') {
    const w = Math.random() < 0.5 ? a : b; winner = w.id; payout = Math.round(amount * 2 * (1 - COMM)); settled = at + 36e5;
    await credit(w.id, 'winnings', payout, `Battle won — #${id.slice(-5)}`, id, 'success');
    await col('battle_claims').insertOne({ battle_id: id, user_id: w.id, claim: 'won', reason: null, proof: '/uploads/demo.png', created_at: settled });
    await col('battle_claims').insertOne({ battle_id: id, user_id: (w.id === a.id ? b : a).id, claim: 'lost', reason: null, proof: null, created_at: settled });
  } else if (status === 'cancelled') {
    settled = at + 12e5;
    for (const u of [a, b]) await credit(u.id, 'deposit', amount, 'Battle cancelled — refund', id, 'success');
  } else if (status === 'disputed') {
    for (const u of [a, b]) await col('battle_claims').insertOne({ battle_id: id, user_id: u.id, claim: 'won', reason: null, proof: '/uploads/demo.png', created_at: at + 18e5 });
  }
  await col('battles').insertOne({ id, mode: amount >= 25000 ? 'rich' : 'lite', amount, status,
    creator_id: a.id, acceptor_id: solo ? null : b.id,
    room_code: ['running', 'completed', 'disputed'].includes(status) ? String(10000000 + Math.floor(Math.random() * 8e7)) : null,
    winner_id: winner, payout, created_at: at, settled_at: settled });
}

/* a few deposit + withdrawal requests */
for (let i = 0; i < 12; i++) {
  const u = pick(users), at = ago(Math.random() * 20), amount = pick([500, 1000, 2000]);
  const st = Math.random() < 0.4 ? 'pending' : 'approved';
  await col('deposit_requests').insertOne({ id: await nextId('deposit_requests'), user_id: u.id, amount, utr: 'AXIS' + Math.floor(1e8 + Math.random() * 9e8), method_id: 1 + (i % 3), status: st, note: null, created_at: at, settled_at: st === 'pending' ? null : at + 6e5 });
  if (st === 'approved') await credit(u.id, 'deposit', amount, 'Deposit verified', null, 'success');
}
const verified = users.filter(u => u.kyc === 'done');
for (let i = 0; i < 8; i++) {
  const u = pick(verified.length ? verified : users), at = ago(Math.random() * 20);
  const w = await col('wallets').findOne({ user_id: u.id });
  const amount = Math.min(w.winnings || 0, pick([250, 500, 1000])); if (amount < 100) continue;
  const st = Math.random() < 0.4 ? 'pending' : 'paid';
  await col('wallets').updateOne({ user_id: u.id }, { $inc: { winnings: -amount } });
  await col('transactions').insertOne({ id: await nextId('transactions'), user_id: u.id, type: 'debit', bucket: 'winnings', amount, note: 'Withdrawal to UPI', status: st === 'paid' ? 'success' : 'pending', ref_id: null, created_at: at });
  await col('withdrawal_requests').insertOne({ id: await nextId('withdrawal_requests'), user_id: u.id, amount, method: 'upi', upi_id: u.name.toLowerCase() + '@ybl', account_name: null, account_number: null, ifsc: null, status: st, note: null, created_at: at, settled_at: st === 'pending' ? null : at + 6e5 });
}

const one = async c => await col(c).countDocuments();
console.log('\nDemo data seeded to MongoDB.\n');
console.log('  users        ', await one('users'));
console.log('  battles      ', await one('battles'), JSON.stringify(stats));
console.log('  transactions ', await one('transactions'));
console.log('  deposits     ', await one('deposit_requests'), 'withdrawals', await one('withdrawal_requests'));
console.log('  payment UPIs ', await one('payment_methods'));
console.log('\n  Sign in as any demo player (EXPOSE_OTP=true), e.g. phone',
  (await col('users').findOne({})).phone, '\n');
process.exit(0);
