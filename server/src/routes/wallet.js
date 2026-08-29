/* Wallet — balance, deposit (simulated), withdraw, transactions, referral redeem. */
import express from 'express';
import { z } from 'zod';
import { db, now, credit, debit, getWallet, notify, getSettings } from '../lib/db.js';
import { methodForUser } from './payments.js';
import { requireAuth } from '../lib/auth.js';
import { DEPOSIT, WITHDRAW } from '../lib/config.js';

const router = express.Router();

/* GET /api/wallet */
router.get('/', requireAuth, (req, res) => {
  const w = getWallet(req.user.id);
  res.json({ wallet: { ...w, total: w.deposit + w.winnings } });
});

/* GET /api/wallet/transactions?type=credit|debit */
router.get('/transactions', requireAuth, (req, res) => {
  const type = ['credit', 'debit'].includes(req.query.type) ? req.query.type : null;
  const rows = type
    ? db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND type = ?
                  ORDER BY created_at DESC LIMIT 200`).all(req.user.id, type)
    : db.prepare(`SELECT * FROM transactions WHERE user_id = ?
                  ORDER BY created_at DESC LIMIT 200`).all(req.user.id);
  res.json({ transactions: rows });
});

/* POST /api/wallet/deposit  { amount }
   NOTE: there is no payment gateway. Wire your PSP's webhook here and only
   credit the wallet after the provider confirms the payment. */
router.post('/deposit', requireAuth, (req, res) => {
  if (!getSettings().deposit_open)
    return res.status(503).json({ error: 'Deposits are temporarily closed. Please come back later.' });
  const parsed = z.object({ amount: z.number().int().positive() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Enter a whole-rupee amount.' });
  const { amount } = parsed.data;
  if (amount < DEPOSIT.min) return res.status(400).json({ error: `Minimum deposit is ₹${DEPOSIT.min}.` });
  if (amount > DEPOSIT.max) return res.status(400).json({ error: `Maximum deposit is ₹${DEPOSIT.max}.` });

  const bonus = amount >= 500 ? Math.round(amount * 0.05) : 0;
  db.transaction(() => {
    credit(req.user.id, 'deposit', amount, 'Deposit');
    if (bonus) credit(req.user.id, 'deposit', bonus, 'Cashback bonus');
  })();

  const w = getWallet(req.user.id);
  res.json({ ok: true, credited: amount + bonus, bonus, wallet: { ...w, total: w.deposit + w.winnings } });
});

/* POST /api/wallet/deposit-request  { amount, utr }
   The manual UPI path: the user pays to our UPI ID, then submits the UTR
   for an admin to verify. Nothing is credited until it is approved. */
router.post('/deposit-request', requireAuth, (req, res) => {
  if (!getSettings().deposit_open)
    return res.status(503).json({ error: 'Deposits are temporarily closed. Please come back later.' });

  const schema = z.object({
    amount: z.number().int().positive(),
    utr: z.string().trim().min(10, 'UTR number length should be between 10-20 characters.')
                          .max(20, 'UTR number length should be between 10-20 characters.'),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { amount, utr } = parsed.data;
  if (amount < DEPOSIT.min) return res.status(400).json({ error: `Minimum deposit is ₹${DEPOSIT.min}.` });
  if (amount > DEPOSIT.max) return res.status(400).json({ error: `Maximum deposit is ₹${DEPOSIT.max}.` });

  const dupe = db.prepare("SELECT 1 FROM deposit_requests WHERE utr = ? AND status != 'rejected'").get(utr);
  if (dupe) return res.status(409).json({ error: 'You have submitted this request already.' });

  const m = methodForUser(req.user.id);
  db.prepare('INSERT INTO deposit_requests (user_id, amount, utr, method_id, created_at) VALUES (?,?,?,?,?)')
    .run(req.user.id, amount, utr, m ? m.id : null, now());
  res.status(201).json({ ok: true, status: 'pending' });
});

/* GET /api/wallet/deposit-requests */
router.get('/deposit-requests', requireAuth, (req, res) => {
  res.json({ requests: db.prepare(
    'SELECT id, amount, utr, status, created_at FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id) });
});

/* POST /api/wallet/withdraw  { amount, method, upiId?|accountName?,accountNumber?,ifsc? } */
router.post('/withdraw', requireAuth, (req, res) => {
  if (!getSettings().withdraw_open) {
    return res.status(503).json({
      error: 'Withdraw is currently disabled for security reasons. Please come back later.',
      code: 'WITHDRAW_CLOSED',
    });
  }
  if (req.user.kyc_status !== 'done')
    return res.status(403).json({ error: 'Complete KYC before withdrawing.', code: 'KYC_REQUIRED' });

  const schema = z.object({
    amount: z.number().int().positive(),
    method: z.enum(['upi', 'bank']),
    upiId: z.string().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/).optional(),
    bankName: z.string().max(80).optional(),
    accountName: z.string().min(3).optional(),
    accountNumber: z.string().regex(/^\d{9,18}$/).optional(),
    ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Check the withdrawal details.' });
  const { amount, method, upiId, bankName, accountName, accountNumber, ifsc } = parsed.data;

  if (amount < WITHDRAW.min) return res.status(400).json({ error: `Minimum withdrawal is ₹${WITHDRAW.min}.` });
  if (method === 'upi' && !upiId) return res.status(400).json({ error: 'Enter a valid UPI ID.' });
  if (method === 'bank' && !(accountName && accountNumber && ifsc))
    return res.status(400).json({ error: 'Enter the full bank details.' });

  const w = getWallet(req.user.id);
  // Only winnings are withdrawable; deposit money never is. A user must play and
  // win before they can cash out — deposits can only be spent on battles.
  if (w.winnings <= 0)
    return res.status(400).json({
      error: 'Only winnings can be withdrawn. Play a battle and win to build a withdrawable balance.',
      code: 'NO_WINNINGS',
    });
  if (w.winnings < amount)
    return res.status(400).json({
      error: `You can withdraw up to ₹${w.winnings} (your winnings). Deposit money cannot be withdrawn.`,
      code: 'EXCEEDS_WINNINGS',
    });

  // Funds leave the wallet now and sit in the queue; a rejection refunds them.
  db.transaction(() => {
    db.prepare('UPDATE wallets SET winnings = winnings - ? WHERE user_id = ?').run(amount, req.user.id);
    db.prepare(`INSERT INTO transactions (user_id, type, bucket, amount, note, status, created_at)
                VALUES (?,'debit','winnings',?,?, 'pending', ?)`)
      .run(req.user.id, amount,
           method === 'upi' ? `Withdrawal to ${upiId}` : `Withdrawal to ${accountNumber.slice(-4)}`,
           now());
    db.prepare(`INSERT INTO withdrawal_requests
                (user_id, amount, method, upi_id, account_name, account_number, ifsc, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.user.id, amount, method, upiId ?? null,
           accountName ? `${accountName}${bankName ? ' · ' + bankName : ''}` : null,
           accountNumber ?? null, ifsc ?? null, now());
    notify(req.user.id, 'Withdrawal requested', `₹${amount} is being processed.`);
  })();

  res.json({ ok: true, status: 'pending' });
});

/* POST /api/wallet/redeem-referral — move referral earnings into the deposit balance. */
router.post('/redeem-referral', requireAuth, (req, res) => {
  const w = getWallet(req.user.id);
  if (w.referral <= 0) return res.status(400).json({ error: 'Nothing to redeem.' });
  const amount = w.referral;
  db.transaction(() => {
    db.prepare('UPDATE wallets SET referral = 0 WHERE user_id = ?').run(req.user.id);
    credit(req.user.id, 'deposit', amount, 'Referral earnings redeemed');
  })();
  res.json({ ok: true, redeemed: amount });
});

export default router;
