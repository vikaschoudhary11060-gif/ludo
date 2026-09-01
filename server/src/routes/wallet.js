/* Wallet — balance, deposit (simulated), withdraw, transactions, referral redeem (MongoDB). */
import express from 'express';
import { SafeRouter } from '../lib/safe-router.js';
import { z } from 'zod';
import { col, nextId, now, credit, getWallet, notify, getSettings, withTransaction } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { DEPOSIT, WITHDRAW, bonusFor, BONUS_LABEL, IS_DEV } from '../lib/config.js';
import { methodForUser } from './payments.js';

const router = SafeRouter();

/* GET /api/wallet */
router.get('/', requireAuth, async (req, res) => {
  const w = await getWallet(req.user.id);   // never null — created on demand
  res.json({ wallet: { ...w, total: w.deposit + w.winnings } });
});

/* GET /api/wallet/transactions?type=credit|debit */
router.get('/transactions', requireAuth, async (req, res) => {
  const type = ['credit', 'debit'].includes(req.query.type) ? req.query.type : null;
  const q = { user_id: req.user.id, ...(type ? { type } : {}) };
  const rows = await col('transactions').find(q, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(200).toArray();
  res.json({ transactions: rows });
});

/* POST /api/wallet/deposit — SIMULATED top-up.
   This credits a wallet with no payment behind it, so it is a local testing
   aid only. Exposed in production it is an unlimited free-money endpoint:
   any signed-in user could mint balance and withdraw it. Real deposits go
   through /deposit-request, which an admin verifies against the UTR. */
router.post('/deposit', requireAuth, async (req, res) => {
  if (!IS_DEV) return res.status(404).json({ error: 'Not found.' });
  if (!(await getSettings()).deposit_open)
    return res.status(503).json({ error: 'Deposits are temporarily closed. Please come back later.' });
  const parsed = z.object({ amount: z.number().int().positive() }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Enter a whole-rupee amount.' });
  const { amount } = parsed.data;
  if (amount < DEPOSIT.min) return res.status(400).json({ error: `Minimum deposit is ₹${DEPOSIT.min}.` });
  if (amount > DEPOSIT.max) return res.status(400).json({ error: `Maximum deposit is ₹${DEPOSIT.max}.` });

  const bonus = bonusFor(amount);
  await withTransaction(async session => {
    await credit(req.user.id, 'deposit', amount, 'Deposit', null, 'success', session);
    if (bonus > 0) await credit(req.user.id, 'deposit', bonus, BONUS_LABEL, null, 'success', session);
  });
  const w = await getWallet(req.user.id);
  res.json({ ok: true, credited: amount + bonus, bonus, wallet: { ...w, total: w.deposit + w.winnings } });
});

/* POST /api/wallet/deposit-request  { amount, utr, proof? } */
router.post('/deposit-request', requireAuth, async (req, res) => {
  if (!(await getSettings()).deposit_open)
    return res.status(503).json({ error: 'Deposits are temporarily closed. Please come back later.' });
  const schema = z.object({
    amount: z.number().int().positive(),
    utr: z.string().trim().min(10, 'UTR number length should be between 10-20 characters.')
                          .max(20, 'UTR number length should be between 10-20 characters.'),
    proof: z.string().max(500).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { amount, utr, proof } = parsed.data;
  if (amount < DEPOSIT.min) return res.status(400).json({ error: `Minimum deposit is ₹${DEPOSIT.min}.` });
  if (amount > DEPOSIT.max) return res.status(400).json({ error: `Maximum deposit is ₹${DEPOSIT.max}.` });

  const dupe = await col('deposit_requests').findOne({ utr, status: { $ne: 'rejected' } });
  if (dupe) return res.status(409).json({ error: 'You have submitted this request already.' });

  const m = await methodForUser(req.user.id);
  await col('deposit_requests').insertOne({
    id: await nextId('deposit_requests'), user_id: req.user.id, amount, utr,
    proof: proof || null,
    method_id: m ? m.id : null, status: 'pending', note: null, created_at: now(), settled_at: null,
  });
  res.status(201).json({ ok: true, status: 'pending' });
});

/* GET /api/wallet/deposit-requests */
router.get('/deposit-requests', requireAuth, async (req, res) => {
  const requests = await col('deposit_requests')
    .find({ user_id: req.user.id }, { projection: { _id: 0, id: 1, amount: 1, utr: 1, proof: 1, status: 1, created_at: 1 } })
    .sort({ created_at: -1 }).limit(50).toArray();
  res.json({ requests });
});

/* POST /api/wallet/withdraw */
router.post('/withdraw', requireAuth, async (req, res) => {
  if (!(await getSettings()).withdraw_open)
    return res.status(503).json({ error: 'Withdraw is currently disabled for security reasons. Please come back later.', code: 'WITHDRAW_CLOSED' });
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

  // Friendly pre-checks. These are advisory only — the authoritative check is
  // the conditional update below, because two requests can pass this point
  // concurrently and both believe there is enough to withdraw.
  const w = await getWallet(req.user.id);
  if (w.winnings <= 0)
    return res.status(400).json({ error: 'Only winnings can be withdrawn. Play a battle and win to build a withdrawable balance.', code: 'NO_WINNINGS' });
  if (w.winnings < amount)
    return res.status(400).json({ error: `You can withdraw up to ₹${w.winnings} (your winnings). Deposit money cannot be withdrawn.`, code: 'EXCEEDS_WINNINGS' });

  try {
    await withTransaction(async session => {
      /* Filter and update in one atomic operation. An unconditional $inc here
         let two concurrent withdrawals both pass the check above and drive the
         balance negative — the player could cash out the same winnings twice. */
      const debited = await col('wallets').updateOne(
        { user_id: req.user.id, winnings: { $gte: amount } },
        { $inc: { winnings: -amount } }, { session });
      if (debited.matchedCount === 0) throw new Error('EXCEEDS_WINNINGS');
      await col('transactions').insertOne({
        id: await nextId('transactions'), user_id: req.user.id, type: 'debit', bucket: 'winnings',
        amount, note: method === 'upi' ? `Withdrawal to ${upiId}` : `Withdrawal to ${accountNumber.slice(-4)}`,
        status: 'pending', ref_id: null, created_at: now(),
      }, { session });
      await col('withdrawal_requests').insertOne({
        id: await nextId('withdrawal_requests'), user_id: req.user.id, amount, method,
        upi_id: upiId ?? null,
        account_name: accountName ? `${accountName}${bankName ? ' · ' + bankName : ''}` : null,
        account_number: accountNumber ?? null, ifsc: ifsc ?? null,
        status: 'pending', note: null, created_at: now(), settled_at: null,
      }, { session });
    });
  } catch (e) {
    if (e.message === 'EXCEEDS_WINNINGS')
      return res.status(400).json({ error: 'Your withdrawable balance changed. Refresh and try again.', code: 'EXCEEDS_WINNINGS' });
    throw e;
  }
  await notify(req.user.id, 'Withdrawal requested', `₹${amount} is being processed.`);
  res.json({ ok: true, status: 'pending' });
});

/* POST /api/wallet/redeem-referral */
router.post('/redeem-referral', requireAuth, async (req, res) => {
  /* Zero the bucket and learn what it held in one atomic step. Reading the
     amount first and zeroing afterwards let two concurrent redeems both read
     the same balance and both credit it. */
  let amount = 0;
  await withTransaction(async session => {
    const before = await col('wallets').findOneAndUpdate(
      { user_id: req.user.id, referral: { $gt: 0 } },
      { $set: { referral: 0 } },
      { session, returnDocument: 'before' });
    if (!before) throw new Error('NO_REFERRAL');
    amount = before.referral;
    /* Into winnings, not deposit: referral money is earned, so it should be
       withdrawable rather than locked into play-only balance. */
    await credit(req.user.id, 'winnings', amount, 'Referral earnings redeemed', null, 'success', session);
  }).catch(e => {
    if (e.message === 'NO_REFERRAL') return null;
    throw e;
  });
  if (!amount) return res.status(400).json({ error: 'No referral balance to redeem.' });
  await notify(req.user.id, 'Referral redeemed! 🎁', `₹${amount} moved to your winnings — you can withdraw it.`);
  const updatedWallet = await getWallet(req.user.id);
  res.json({ ok: true, redeemed: amount, wallet: { ...updatedWallet, total: updatedWallet.deposit + updatedWallet.winnings } });
});

export default router;
