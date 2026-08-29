/* ============================================================
   Referral System Integration Tests
   ============================================================ */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from '../server/node_modules/mongodb/lib/index.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://vikaschoudhary11060_db_user:MbejATQnH8OiK4CY@cluster0.ouvpidm.mongodb.net/khelbro?retryWrites=true&w=majority';

test('Referral System End-to-End Test Suite', async t => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('khelbro');

  // Test setup: create test parent user and test referee phone numbers
  const parentPhone = '9999911111';
  const refereePhone = '9999922222';
  const parentRefCode = 'KHEL-TEST' + Math.floor(1000 + Math.random() * 9000);

  // Clean up any test records
  await db.collection('users').deleteMany({ phone: { $in: [parentPhone, refereePhone] } });
  await db.collection('otps').deleteMany({ phone: { $in: [parentPhone, refereePhone] } });

  let parentUser = null;
  let refereeUser = null;

  await t.test('1. Setup Parent User', async () => {
    // Generate parent user
    const parentId = 999901;
    parentUser = {
      id: parentId,
      phone: parentPhone,
      name: 'Vikas Referrer',
      avatar: 2,
      email: 'parent@example.com',
      avatar_url: null,
      email_verified: 1,
      kyc_status: 'done',
      kyc_method: 'manual',
      kyc_reference: '123456789012',
      kyc_masked: 'XXXXXXXX9012',
      kyc_dob: '1995-01-01',
      legal_name: 'Vikas Referrer',
      referral_code: parentRefCode,
      referred_by: null,
      banned: 0,
      session_epoch: 0,
      created_at: Date.now(),
    };
    await db.collection('users').insertOne(parentUser);
    await db.collection('wallets').insertOne({ user_id: parentId, deposit: 1000, winnings: 500, referral: 0 });

    const found = await db.collection('users').findOne({ referral_code: parentRefCode });
    assert.ok(found, 'Parent user created with referral code');
    assert.equal(found.name, 'Vikas Referrer');
  });

  await t.test('2. Referral Code Lookup', async () => {
    // Lookup with exact case
    const exact = await db.collection('users').findOne(
      { referral_code: { $regex: new RegExp('^' + parentRefCode + '$', 'i') } },
      { projection: { id: 1, name: 1, referral_code: 1, avatar: 1 } }
    );
    assert.ok(exact, 'Lookup finds referral code');
    assert.equal(exact.name, 'Vikas Referrer');

    // Lookup with lower case
    const lower = await db.collection('users').findOne(
      { referral_code: { $regex: new RegExp('^' + parentRefCode.toLowerCase() + '$', 'i') } },
      { projection: { id: 1, name: 1, referral_code: 1 } }
    );
    assert.ok(lower, 'Case-insensitive lookup succeeds');

    // Invalid lookup
    const invalid = await db.collection('users').findOne(
      { referral_code: { $regex: new RegExp('^KHEL-NONEXISTENT999$', 'i') } }
    );
    assert.equal(invalid, null, 'Invalid code returns null');
  });

  await t.test('3. Register Referee User with Parent Referral Code', async () => {
    const refereeId = 999902;
    refereeUser = {
      id: refereeId,
      phone: refereePhone,
      name: 'PlayerReferee',
      avatar: 1,
      email: null,
      avatar_url: null,
      email_verified: 0,
      kyc_status: 'none',
      kyc_method: null,
      kyc_reference: null,
      kyc_masked: null,
      kyc_dob: null,
      legal_name: null,
      referral_code: 'KHEL-REF2222',
      referred_by: parentUser.id,
      banned: 0,
      session_epoch: 0,
      created_at: Date.now(),
    };
    await db.collection('users').insertOne(refereeUser);
    await db.collection('wallets').insertOne({ user_id: refereeId, deposit: 500, winnings: 0, referral: 0 });

    // Insert referral record
    await db.collection('referrals').updateOne(
      { referrer_id: parentUser.id, referee_id: refereeId },
      { $setOnInsert: { referrer_id: parentUser.id, referee_id: refereeId, earned: 0, created_at: Date.now() } },
      { upsert: true }
    );

    const refRecord = await db.collection('referrals').findOne({ referrer_id: parentUser.id, referee_id: refereeId });
    assert.ok(refRecord, 'Referral tracking document created');
    assert.equal(refRecord.earned, 0);

    const u = await db.collection('users').findOne({ id: refereeId });
    assert.equal(u.referred_by, parentUser.id, 'Referee bound to parent referrer');
  });

  await t.test('4. Battle Completion & Referral Commission Calculation', async () => {
    const stake = 500;
    const commissionRate = 0.02; // 2%
    const cut = Math.round(stake * commissionRate); // ₹10

    // Simulate referee completing a battle
    await db.collection('wallets').updateOne(
      { user_id: parentUser.id },
      { $inc: { referral: cut } }
    );
    await db.collection('referrals').updateOne(
      { referrer_id: parentUser.id, referee_id: refereeUser.id },
      { $inc: { earned: cut } }
    );
    await db.collection('transactions').insertOne({
      id: 888801,
      user_id: parentUser.id,
      type: 'credit',
      bucket: 'referral',
      amount: cut,
      note: 'Referral commission — battle #test01',
      status: 'success',
      ref_id: 'test01',
      created_at: Date.now(),
    });

    const parentWallet = await db.collection('wallets').findOne({ user_id: parentUser.id });
    assert.equal(parentWallet.referral, 10, 'Parent wallet referral bucket received ₹10 commission');

    const updatedRef = await db.collection('referrals').findOne({ referrer_id: parentUser.id, referee_id: refereeUser.id });
    assert.equal(updatedRef.earned, 10, 'Referral document tracked ₹10 earned');
  });

  await t.test('5. Referral Dashboard Aggregation', async () => {
    const rows = await db.collection('referrals').aggregate([
      { $match: { referrer_id: parentUser.id } },
      { $lookup: { from: 'users', localField: 'referee_id', foreignField: 'id', as: 'u' } },
      {
        $project: {
          _id: 0,
          referee_id: 1,
          earned: 1,
          created_at: 1,
          name: { $arrayElemAt: ['$u.name', 0] },
        },
      },
    ]).toArray();

    assert.equal(rows.length, 1, 'Parent has 1 referee');
    assert.equal(rows[0].name, 'PlayerReferee');
    assert.equal(rows[0].earned, 10);
  });

  await t.test('6. Referral Redemption to Deposit Wallet', async () => {
    const wBefore = await db.collection('wallets').findOne({ user_id: parentUser.id });
    assert.equal(wBefore.referral, 10);
    const depositBefore = wBefore.deposit;

    const redeemAmount = wBefore.referral;

    // Execute atomic redemption
    await db.collection('wallets').updateOne(
      { user_id: parentUser.id },
      { $set: { referral: 0 }, $inc: { deposit: redeemAmount } }
    );
    await db.collection('transactions').insertOne({
      id: 888802,
      user_id: parentUser.id,
      type: 'credit',
      bucket: 'deposit',
      amount: redeemAmount,
      note: 'Referral earnings redeemed',
      status: 'success',
      ref_id: null,
      created_at: Date.now(),
    });

    const wAfter = await db.collection('wallets').findOne({ user_id: parentUser.id });
    assert.equal(wAfter.referral, 0, 'Referral balance reset to 0');
    assert.equal(wAfter.deposit, depositBefore + redeemAmount, 'Deposit balance credited with redeemed referral amount');
  });

  // Cleanup test data
  await db.collection('users').deleteMany({ phone: { $in: [parentPhone, refereePhone] } });
  await db.collection('wallets').deleteMany({ user_id: { $in: [parentUser.id, refereeUser.id] } });
  await db.collection('referrals').deleteMany({ referrer_id: parentUser.id });
  await db.collection('transactions').deleteMany({ id: { $in: [888801, 888802] } });

  await client.close();
});
