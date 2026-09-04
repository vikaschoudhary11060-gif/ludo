/* ============================================================
   clean-and-reset-bets.js

   1. Finds any active/unsettled battles.
   2. Safely refunds stakes to any real (non-bot) players.
   3. Deletes all open, running, waiting, requested, and disputed battles.
   4. Runs bot tick to create exactly:
        - 3 running bot battles
        - 2 open bot battles (waiting for opponent)
   ============================================================ */
import 'dotenv/config';
import { connect, col, withTransaction } from './lib/db.js';
import { refundStake } from './lib/settlement.js';
import { ensureBots, runBotTick, TARGET_RUNNING, TARGET_OPEN } from './lib/bots.js';

async function main() {
  console.log('[reset] Connecting to database...');
  await connect();

  // 1. Find all active/live battles
  const liveBattles = await col('battles').find({
    status: { $in: ['open', 'running', 'waiting', 'requested', 'disputed'] }
  }).toArray();

  console.log(`[reset] Found ${liveBattles.length} active battle(s) on the board.`);

  // 2. Safely refund real players if they were in any active battles
  const botUserRows = await col('users').find({ is_bot: true }, { projection: { id: 1 } }).toArray();
  const botIdSet = new Set(botUserRows.map(u => u.id));

  let refundedCount = 0;
  for (const b of liveBattles) {
    // Check creator
    if (b.creator_id != null && !botIdSet.has(b.creator_id)) {
      try {
        await withTransaction(async session => {
          await refundStake(session, b, b.creator_id, `Battle reset refund — #${b.id}`);
        });
        console.log(`[reset] Refunded creator ${b.creator_id} for battle ${b.id} (₹${b.amount})`);
        refundedCount++;
      } catch (err) {
        console.warn(`[reset] Refund skipped/failed for creator ${b.creator_id} on ${b.id}:`, err.message);
      }
    }
    // Check acceptor
    if (b.acceptor_id != null && !botIdSet.has(b.acceptor_id)) {
      try {
        await withTransaction(async session => {
          await refundStake(session, b, b.acceptor_id, `Battle reset refund — #${b.id}`);
        });
        console.log(`[reset] Refunded acceptor ${b.acceptor_id} for battle ${b.id} (₹${b.amount})`);
        refundedCount++;
      } catch (err) {
        console.warn(`[reset] Refund skipped/failed for acceptor ${b.acceptor_id} on ${b.id}:`, err.message);
      }
    }
  }

  // 3. Delete all active battles from DB
  const liveIds = liveBattles.map(b => b.id);
  if (liveIds.length) {
    const res = await col('battles').deleteMany({ id: { $in: liveIds } });
    console.log(`[reset] Deleted ${res.deletedCount} active battles.`);
  }

  // Also clear any orphaned bot battles
  await col('battles').deleteMany({ is_bot: true });

  // 4. Ensure bot pool exists and populate fresh battles:
  // TARGET_RUNNING = 3, TARGET_OPEN = 2
  console.log('[reset] Initializing bot pool...');
  await ensureBots();

  console.log(`[reset] Populating board: targeting ${TARGET_RUNNING} running, ${TARGET_OPEN} open...`);
  const result = await runBotTick(null);
  console.log('[reset] Bot tick result:', result);

  const currentRunning = await col('battles').countDocuments({ status: 'running' });
  const currentOpen = await col('battles').countDocuments({ status: 'open' });
  console.log(`[reset] Board now has: ${currentRunning} running battles, ${currentOpen} open battles.`);

  const currentBattles = await col('battles').find({ status: { $in: ['open', 'running'] } }).toArray();
  for (const b of currentBattles) {
    const creator = await col('users').findOne({ id: b.creator_id });
    const acceptor = b.acceptor_id ? await col('users').findOne({ id: b.acceptor_id }) : null;
    console.log(` - [${b.status.toUpperCase()}] ₹${b.amount} | ${creator?.name || b.creator_id} vs ${acceptor?.name || 'Waiting'}`);
  }

  console.log('[reset] Done!');
  process.exit(0);
}

main().catch(err => {
  console.error('[reset] Fatal error:', err);
  process.exit(1);
});
