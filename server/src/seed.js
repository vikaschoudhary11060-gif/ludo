/* Seeds demo players and a believable open lobby:  npm run seed */
import 'dotenv/config';
import crypto from 'node:crypto';
import { db, now, credit } from './lib/db.js';

const NAMES = ['RaviTheKing','PriyaPlays','AmitRolls','SnehaSix','VikramV','NehaN','ArjunA','KavyaK'];
const newId = () => crypto.randomBytes(6).toString('hex');

const seed = db.transaction(() => {
  const ids = [];
  NAMES.forEach((name, i) => {
    const phone = String(9000000000 + i);
    let u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!u) {
      const info = db.prepare(`INSERT INTO users (phone, name, referral_code, created_at)
                               VALUES (?,?,?,?)`).run(phone, name, 'KHEL-SEED' + i, now());
      db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(info.lastInsertRowid);
      credit(info.lastInsertRowid, 'deposit', 50000, 'Seed float');
      u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    ids.push(u.id);
  });

  const existing = db.prepare("SELECT COUNT(*) c FROM battles WHERE status='open'").get().c;
  if (existing < 5) {
    [[50,'lite'],[100,'lite'],[250,'lite'],[500,'lite'],[1000,'lite'],[5000,'lite'],
     [25000,'rich'],[50000,'rich']].forEach(([amount, mode], i) => {
      const id = newId();
      db.prepare(`INSERT INTO battles (id, mode, amount, status, creator_id, created_at)
                  VALUES (?,?,?,'open',?,?)`).run(id, mode, amount, ids[i % ids.length], now() - i * 60000);
      db.prepare('UPDATE wallets SET deposit = deposit - ? WHERE user_id = ?').run(amount, ids[i % ids.length]);
    });
  }
});

seed();
console.log('Seeded demo players and open battles.');
