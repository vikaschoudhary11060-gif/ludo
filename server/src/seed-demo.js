/* ============================================================
   Demo data seeder:  npm run seed:demo

   DESTRUCTIVE — wipes every table and rebuilds a realistic
   dataset so the site and the admin console have something to
   show. Deterministic: the same seed always produces the same
   data, so screenshots and demos are repeatable.

   Timestamps are deliberately spread over 45 days so the
   admin console's 1d / 7d / 30d / all-time filters each return
   different numbers.
   ============================================================ */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, now } from './lib/db.js';

/* ---------- deterministic RNG ---------- */
let _s = 20260828;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = p => rnd() < p;
const newId = () => crypto.randomBytes(6).toString('hex');

const DAY = 86400000;
const NOW = Date.now();
/** A timestamp `daysAgo` days back, with a random time of day. */
const ago = days => NOW - Math.round(days * DAY) - int(0, 20) * 3600000;

/* ---------- a tiny PNG writer, so evidence images are real ---------- */
const UPLOADS = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
function png(file, [r, g, b], size = 96) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  // Node <22.7 has no zlib.crc32 — fall back to a local implementation.
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(size).fill(Buffer.from([r, g, b])))]);
  const raw = Buffer.concat(Array(size).fill(row));
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(UPLOADS, file), buf);
  return '/uploads/' + file;
}

/* ---------- reference data ---------- */
const NAMES = [
  'RaviTheKing','PriyaPlays','AmitRolls','SnehaSix','VikramV','NehaN','ArjunA','KavyaK',
  'RohitR','MeeraM','DevDhaba','AnjaliA','KabirK','IshaI','ManavM','RiyaR','YashY','ZaraZ',
  'SuritS','TaraT','FarhanF','GauriG','HarshH','IndraI','JyotiJ','KiranK','LakshL','MohitM',
  'NitinN','OjasO','PoojaP','QaisQ','RahulR','SimranS','TanviT','UdayU',
];
const CANCEL_REASONS = ['Opponent did not join', 'Opponent abusing', 'Game did not start', 'Do not want to play'];
const SUPPORT = [
  '[gameplay] My opponent left mid-game and I still lost the amount.',
  '[account] I am not receiving the OTP on my number.',
  '[bug] The room code screen went blank after I pressed Set.',
  '[withdrawal] My withdrawal has been pending since yesterday.',
  '[feedback] Please add a two-player quick mode, the tables are always full.',
];

/* ---------- timestamped ledger helpers (the shared ones stamp `now`) ---------- */
const txStmt = db.prepare(`INSERT INTO transactions (user_id,type,bucket,amount,note,status,ref_id,created_at)
                           VALUES (?,?,?,?,?,?,?,?)`);
const addTx = (uid, type, bucket, amount, note, at, status = 'success', ref = null) =>
  txStmt.run(uid, type, bucket, amount, note, status, ref, at);

const bump = (uid, bucket, delta) =>
  db.prepare(`UPDATE wallets SET ${bucket} = ${bucket} + ? WHERE user_id = ?`).run(delta, uid);

const noteStmt = db.prepare('INSERT INTO notifications (user_id,title,body,read,created_at) VALUES (?,?,?,?,?)');

const balOf = (uid, bucket) =>
  db.prepare(`SELECT ${bucket} v FROM wallets WHERE user_id = ?`).get(uid).v;

/** Credit a real top-up if `uid` cannot cover `amount`. Keeps wallet == ledger. */
function ensureFunds(uid, amount, at) {
  const have = balOf(uid, 'deposit');
  if (have >= amount) return;
  const short = amount - have;
  const topUp = Math.ceil(short / 500) * 500;      // players top up in round numbers
  bump(uid, 'deposit', topUp);
  addTx(uid, 'credit', 'deposit', topUp, 'Deposit', at - 120000);
}

/* ---------- wipe ---------- */
function wipe() {
  db.pragma('foreign_keys = OFF');
  for (const t of ['battle_claims','battles','transactions','notifications','referrals',
                   'support_messages','deposit_requests','withdrawal_requests','kyc_documents',
                   'otps','wallets','users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name NOT IN ('settings')").run();
  db.pragma('foreign_keys = ON');
  fs.mkdirSync(UPLOADS, { recursive: true });
  for (const f of fs.readdirSync(UPLOADS)) if (f.endsWith('.png')) fs.unlinkSync(path.join(UPLOADS, f));
}

/* ---------- build ---------- */
const build = db.transaction(() => {
  wipe();

  // Evidence images reused across claims and KYC.
  const SHOTS = [
    png('demo-win-red.png', [214, 60, 60]),
    png('demo-win-blue.png', [45, 104, 196]),
    png('demo-win-green.png', [30, 150, 90]),
    png('demo-win-amber.png', [230, 170, 40]),
  ];
  const DOCS = [png('demo-doc-front.png', [120, 130, 145]),
                png('demo-doc-back.png', [140, 150, 165]),
                png('demo-doc-selfie.png', [175, 150, 130])];

  /* ---- users ---- */
  const users = [];
  NAMES.forEach((name, i) => {
    const created = ago(int(2, 45));
    const kyc = chance(0.30) ? 'done' : chance(0.18) ? 'pending' : chance(0.06) ? 'rejected' : 'none';
    const info = db.prepare(`INSERT INTO users (phone,name,avatar,email,kyc_status,legal_name,referral_code,created_at)
                             VALUES (?,?,?,?,?,?,?,?)`)
      .run('9' + String(100000000 + i * 137 + 11).slice(0, 9), name, int(0, 7),
           chance(0.4) ? name.toLowerCase() + '@example.com' : null,
           kyc, kyc === 'none' ? null : name.replace(/[A-Z]/g, m => ' ' + m).trim(),
           'KHEL-' + String(1000 + i * 7), created);
    const id = info.lastInsertRowid;
    db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(id);

    // Opening deposit, so balances have a real origin in the ledger.
    const dep = pick([500, 1000, 2000, 5000, 10000]);
    bump(id, 'deposit', dep);
    addTx(id, 'credit', 'deposit', dep, 'Deposit', created + 60000);
    if (dep >= 500) { const b = Math.round(dep * 0.05); bump(id, 'deposit', b);
                      addTx(id, 'credit', 'deposit', b, 'Cashback bonus', created + 61000); }

    users.push({ id, name, kyc, created });

    if (kyc !== 'none') {
      ['front', 'back', 'selfie'].forEach((slot, k) =>
        db.prepare('INSERT INTO kyc_documents (user_id,slot,path,created_at) VALUES (?,?,?,?)')
          .run(id, slot, DOCS[k], created + 120000));
    }
  });

  /* ---- referrals ---- */
  users.slice(6).forEach(u => {
    if (!chance(0.35)) return;
    const referrer = users[int(0, 5)];
    if (referrer.id === u.id) return;
    db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.id, u.id);
    db.prepare('INSERT OR IGNORE INTO referrals (referrer_id,referee_id,earned,created_at) VALUES (?,?,?,?)')
      .run(referrer.id, u.id, 0, u.created);
  });

  /* ---- battles ---- */
  const COMMISSION = db.prepare('SELECT commission FROM settings WHERE id = 1').get().commission;
  const LITE = [50, 100, 200, 250, 500, 750, 1000, 2000, 5000, 10000];
  const RICH = [25000, 30000, 40000, 50000, 75000, 100000];

  let counts = {};
  for (let n = 0; n < 220; n++) {
    // Weight recent days more heavily, but keep a long tail for the 30d/all filters.
    const daysAgo = chance(0.18) ? rnd() * 1               // today
                  : chance(0.35) ? 1 + rnd() * 6           // this week
                  : chance(0.6)  ? 7 + rnd() * 23          // this month
                  : 30 + rnd() * 15;                       // older
    const at = ago(daysAgo);
    const rich = chance(0.15);
    const amount = rich ? pick(RICH) : pick(LITE);
    const mode = rich ? 'rich' : 'lite';

    const a = pick(users);
    let b = pick(users);
    if (b.id === a.id) b = users[(users.indexOf(a) + 3) % users.length];

    const roll = rnd();
    const status = roll < 0.55 ? 'completed'
                 : roll < 0.65 ? 'cancelled'
                 : roll < 0.74 ? 'disputed'
                 : roll < 0.82 ? 'running'
                 : roll < 0.88 ? 'waiting'
                 : 'open';
    counts[status] = (counts[status] || 0) + 1;

    const id = newId();
    const room = String(int(10000000, 99999999));
    const solo = status === 'open';

    // Both players stake up front.
    ensureFunds(a.id, amount, at);
    bump(a.id, 'deposit', -amount); addTx(a.id, 'debit', 'deposit', amount, 'Battle stake', at, 'success', id);
    if (!solo) {
      ensureFunds(b.id, amount, at);
      bump(b.id, 'deposit', -amount); addTx(b.id, 'debit', 'deposit', amount, 'Battle stake', at + 30000, 'success', id);
    }

    let winner = null, payout = null, settled = null;

    // Insert the battle first so claims have a row to reference.
    db.prepare(`INSERT INTO battles (id,mode,amount,status,creator_id,acceptor_id,room_code,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, mode, amount, status, a.id, solo ? null : b.id,
           ['running', 'completed', 'disputed'].includes(status) ? room : null, at);

    if (status === 'completed') {
      const w = chance(0.5) ? a : b;
      winner = w.id;
      payout = Math.round(amount * 2 * (1 - COMMISSION));
      settled = at + int(5, 90) * 60000;
      bump(w.id, 'winnings', payout);
      addTx(w.id, 'credit', 'winnings', payout, `Battle won — #${id.slice(-5)}`, settled, 'success', id);
      noteStmt.run(w.id, 'You won!', `₹${payout} credited for battle #${id.slice(-5)}.`, chance(0.6) ? 1 : 0, settled);
      const l = w.id === a.id ? b : a;
      noteStmt.run(l.id, 'Battle lost', 'Better luck next time.', chance(0.6) ? 1 : 0, settled);
      // claims that agree
      db.prepare('INSERT INTO battle_claims (battle_id,user_id,claim,reason,proof,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, w.id, 'won', null, pick(SHOTS), settled - 60000);
      db.prepare('INSERT INTO battle_claims (battle_id,user_id,claim,reason,proof,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, l.id, 'lost', null, null, settled - 30000);

      // referral commission
      for (const u of [a, b]) {
        const row = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(u.id);
        if (!row?.referred_by) continue;
        const cut = Math.round(amount * 0.02);
        if (cut <= 0) continue;
        bump(row.referred_by, 'referral', cut);
        addTx(row.referred_by, 'credit', 'referral', cut, 'Referral commission', settled, 'success', id);
        db.prepare('UPDATE referrals SET earned = earned + ? WHERE referrer_id = ? AND referee_id = ?')
          .run(cut, row.referred_by, u.id);
      }
    } else if (status === 'cancelled') {
      settled = at + int(3, 40) * 60000;
      bump(a.id, 'deposit', amount); addTx(a.id, 'credit', 'deposit', amount, 'Battle cancelled — refund', settled, 'success', id);
      bump(b.id, 'deposit', amount); addTx(b.id, 'credit', 'deposit', amount, 'Battle cancelled — refund', settled, 'success', id);
      [a, b].forEach(u => db.prepare('INSERT INTO battle_claims (battle_id,user_id,claim,reason,proof,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, u.id, 'cancel', pick(CANCEL_REASONS), null, settled - 20000));
    } else if (status === 'disputed') {
      // both claim a win — money stays locked until an admin decides
      db.prepare('INSERT INTO battle_claims (battle_id,user_id,claim,reason,proof,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, a.id, 'won', null, pick(SHOTS), at + 1800000);
      db.prepare('INSERT INTO battle_claims (battle_id,user_id,claim,reason,proof,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, b.id, 'won', null, pick(SHOTS), at + 1900000);
      [a, b].forEach(u => noteStmt.run(u.id, 'Result under review',
        'Both players claimed differently. Support will review the proof.', 0, at + 1900000));
    }


    if (winner || settled) {
      db.prepare('UPDATE battles SET winner_id = ?, payout = ?, settled_at = ? WHERE id = ?')
        .run(winner, payout, settled, id);
    }
  }

  /* ---- deposit requests (manual UPI) ---- */
  for (let i = 0; i < 26; i++) {
    const u = pick(users);
    const at = ago(rnd() * 40);
    const amount = pick([100, 200, 500, 1000, 2000, 5000]);
    const r = rnd();
    const status = r < 0.3 ? 'pending' : r < 0.85 ? 'approved' : 'rejected';
    const settled = status === 'pending' ? null : at + int(10, 300) * 60000;
    db.prepare('INSERT INTO deposit_requests (user_id,amount,utr,status,note,created_at,settled_at) VALUES (?,?,?,?,?,?,?)')
      .run(u.id, amount,
           pick(['AXIS','HDFC','SBIN','ICIC','UTIB']) + String(int(100000000, 999999999)),
           status, status === 'rejected' ? 'Invalid UTR number.' : null, at, settled);
    if (status === 'approved') {
      bump(u.id, 'deposit', amount);
      addTx(u.id, 'credit', 'deposit', amount, 'Deposit verified', settled);
      noteStmt.run(u.id, 'Deposit added', `₹${amount} credited to your wallet.`, 1, settled);
    }
  }

  /* ---- withdrawal requests ---- */
  const verified = users.filter(u => u.kyc === 'done');
  for (let i = 0; i < 22; i++) {
    const u = pick(verified.length ? verified : users);
    const at = ago(rnd() * 40);
    const available = balOf(u.id, 'winnings');
    if (available < 100) continue;                       // nothing to withdraw
    const amount = Math.min(available, pick([100, 250, 500, 1000, 2500, 5000]));
    const r = rnd();
    const status = r < 0.27 ? 'pending' : r < 0.85 ? 'paid' : 'rejected';
    const settled = status === 'pending' ? null : at + int(20, 600) * 60000;
    const upi = chance(0.6);
    db.prepare(`INSERT INTO withdrawal_requests
                (user_id,amount,method,upi_id,account_name,account_number,ifsc,status,note,created_at,settled_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(u.id, amount, upi ? 'upi' : 'bank',
           upi ? u.name.toLowerCase() + '@' + pick(['okaxis','ybl','paytm','oksbi']) : null,
           upi ? null : u.name.replace(/[A-Z]/g, m => ' ' + m).trim(),
           upi ? null : String(int(100000000000, 999999999999)),
           upi ? null : pick(['HDFC','ICIC','SBIN','UTIB']) + '0' + String(int(100000, 999999)),
           status, status === 'rejected' ? 'Bank details did not match.' : null, at, settled);
    // The amount leaves winnings at request time.
    bump(u.id, 'winnings', -amount);
    addTx(u.id, 'debit', 'winnings', amount, `Withdrawal to ${upi ? 'UPI' : 'bank'}`, at,
          status === 'pending' ? 'pending' : status === 'paid' ? 'success' : 'failed');
    if (status === 'rejected') {
      // Debit is void (status 'failed'), so the wallet is restored without a second row.
      bump(u.id, 'winnings', amount);
      noteStmt.run(u.id, 'Withdrawal rejected', 'The amount was returned to your winnings.', 0, settled);
    }
    if (status === 'paid') noteStmt.run(u.id, 'Withdrawal successful', `₹${amount} has been sent.`, 1, settled);
  }

  /* ---- support messages ---- */
  for (let i = 0; i < 14; i++) {
    const u = pick(users);
    db.prepare('INSERT INTO support_messages (user_id,body,created_at) VALUES (?,?,?)')
      .run(u.id, pick(SUPPORT), ago(rnd() * 35));
  }

  return counts;
});

const counts = build();

/* ---------- report ---------- */
const one = sql => db.prepare(sql).get();
console.log('\nDemo data seeded.\n');
console.log('  users              ', one('SELECT COUNT(*) c FROM users').c);
console.log('  battles            ', one('SELECT COUNT(*) c FROM battles').c,
            JSON.stringify(counts));
console.log('  transactions       ', one('SELECT COUNT(*) c FROM transactions').c);
console.log('  deposit requests   ', one('SELECT COUNT(*) c FROM deposit_requests').c,
            `(${one("SELECT COUNT(*) c FROM deposit_requests WHERE status='pending'").c} pending)`);
console.log('  withdrawals        ', one('SELECT COUNT(*) c FROM withdrawal_requests').c,
            `(${one("SELECT COUNT(*) c FROM withdrawal_requests WHERE status='pending'").c} pending)`);
console.log('  KYC pending        ', one("SELECT COUNT(*) c FROM users WHERE kyc_status='pending'").c);
console.log('  notifications      ', one('SELECT COUNT(*) c FROM notifications').c);
console.log('  referrals          ', one('SELECT COUNT(*) c FROM referrals').c);
console.log('  support messages   ', one('SELECT COUNT(*) c FROM support_messages').c);
console.log('\n  Games per range:');
for (const [label, ms] of [['1 day', DAY], ['7 days', 7 * DAY], ['30 days', 30 * DAY], ['all time', null]]) {
  const from = ms ? Date.now() - ms : 0;
  console.log('   ', label.padEnd(9),
    db.prepare('SELECT COUNT(*) c FROM battles WHERE created_at >= ?').get(from).c);
}
// Every wallet must equal the sum of its ledger entries.
let bad = 0;
for (const u of db.prepare('SELECT user_id, deposit, winnings, referral FROM wallets').all()) {
  for (const bucket of ['deposit', 'winnings', 'referral']) {
    const v = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0) v
                          FROM transactions WHERE user_id=? AND bucket=? AND status!='failed'`).get(u.user_id, bucket).v;
    if (u[bucket] !== v) bad++;
  }
}
console.log('\n  Ledger reconciliation:', bad === 0 ? 'OK — every wallet matches its ledger'
                                                    : `FAILED — ${bad} bucket(s) out of balance`);
console.log('  Negative balances:   ',
  db.prepare('SELECT COUNT(*) c FROM wallets WHERE deposit<0 OR winnings<0 OR referral<0').get().c);

console.log('\n  Sign in as any demo player with EXPOSE_OTP=true, e.g. phone',
  db.prepare('SELECT phone FROM users LIMIT 1').get().phone, '\n');
