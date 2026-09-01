/* ============================================================
   Bot battles — lobby activity.

   A fresh lobby with nothing in it reads as a dead product, so a
   small pool of house accounts keeps battles appearing. A bot
   battle is created open, is accepted by a second bot two to three
   seconds later so it lands in Running, sits there for a few
   minutes and is then removed.

   Three rules hold this together and everything else follows from
   them:

     1. No money. A bot battle never debits, credits or writes a
        ledger row, and never settles, so it can neither create nor
        destroy a rupee. There is no bot commission to hide from
        the admin console because none is ever earned.
     2. No real player can join one. Every entry point checks the
        flag and refuses, so a tap in the two-second window is a
        clean "no longer open" rather than a match against nobody.
     3. Bots cannot sign in. Their phone numbers start with 1,
        which the signup schema (^[6-9]\d{9}$) rejects, so no real
        person can ever register one and no bot can ever hold a
        session.

   Everything the bots produce is marked `is_bot: true`, which is
   what the admin queries filter on.
   ============================================================ */
import crypto from 'node:crypto';
import { col, nextId, now } from './db.js';
import { MODES } from './config.js';
import { fetchBattle, shape } from './battle-view.js';

/** The one filter every admin figure applies. Exported so a query that forgets
    it is a missing import rather than a silently different object literal. */
export const NOT_BOT = { is_bot: { $ne: true } };

export const BOT_COUNT = 15;

/* 10 digits starting with 1. `phoneSchema` in routes/auth.js only accepts
   ^[6-9]\d{9}$, so these can never collide with a real signup and can never
   themselves request an OTP. Do not change the leading digit. */
const botPhone = i => '100000' + String(i + 1).padStart(4, '0');

const BOT_NAMES = [
  'RohitPlays', 'SnehaSix', 'AmanRolls', 'PriyaWins', 'KaranK',
  'DeepakD', 'NishaN', 'ArjunAce', 'MeghaM', 'SahilS',
  'PoojaP', 'VikasV', 'RituR', 'HarshH', 'AnkitA',
];

/* Stakes that look like the ones players actually set. */
const LITE_STAKES = [50, 50, 100, 100, 100, 150, 200, 250, 250, 300, 500, 500, 750, 1000, 1500, 2000, 5000];
const RICH_STAKES = [25000, 25000, 30000, 50000];

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/* Only an explicit "false" switches the bots off, so a host that simply has
   no BOT_BATTLES variable still gets the behaviour that was asked for. */
export const BOTS_ENABLED = String(process.env.BOT_BATTLES ?? 'true').toLowerCase() !== 'false';

/** How many bot battles to keep on the board at once. */
const TARGET_RUNNING = Math.min(num(process.env.BOT_TARGET_RUNNING, 6), 25);
/** How long a bot battle stays in Running before it is retired. */
const LIFETIME_MIN_MS = num(process.env.BOT_LIFETIME_MIN_MS, 3 * 60 * 1000);
const LIFETIME_MAX_MS = Math.max(LIFETIME_MIN_MS, num(process.env.BOT_LIFETIME_MAX_MS, 8 * 60 * 1000));
/* The delay before the second bot accepts. The brief the feature was written
   to: created, then Running within two to three seconds. */
const ACCEPT_MIN_MS = 2000, ACCEPT_MAX_MS = 3000;
const TICK_MS = num(process.env.BOT_TICK_MS, 4000);

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const newBattleId = () => crypto.randomBytes(6).toString('hex');
const roomCode = () => String(randInt(10_000_000, 99_999_999));

/* ---------- accounts ---------- */

/** Create the bot pool if it is not there yet. Safe to re-run: it only fills
    in what is missing, so a restart is a no-op and a partially created pool
    is completed rather than duplicated. */
export async function ensureBots() {
  const created = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const phone = botPhone(i);
    const existing = await col('users').findOne({ phone }, { projection: { _id: 0, id: 1, is_bot: 1 } });
    if (existing) {
      // An account seeded before the flag existed still has to carry it, or it
      // would show up in the admin console as a real player.
      if (!existing.is_bot) await col('users').updateOne({ phone }, { $set: { is_bot: true } });
      continue;
    }
    const id = await nextId('users');
    await col('users').insertOne({
      id, phone, name: BOT_NAMES[i] || `Player${phone.slice(-4)}`,
      avatar: i % 8, email: null, avatar_url: null, email_verified: 0,
      kyc_status: 'none', kyc_method: null, kyc_reference: null, kyc_masked: null,
      kyc_dob: null, legal_name: null,
      /* No `referral_code` field at all. The unique index on it is sparse,
         which skips a missing field but still indexes an explicit null — so
         fifteen nulls would collide on the second insert. */
      referred_by: null, banned: 0, session_epoch: 0, is_bot: true, created_at: now(),
    });
    // A zeroed wallet, so any code path that reads one finds a row rather
    // than creating a surprise. Nothing ever moves through it.
    await col('wallets').updateOne({ user_id: id },
      { $setOnInsert: { user_id: id, deposit: 0, winnings: 0, referral: 0 } }, { upsert: true });
    created.push(id);
  }
  return created;
}

/** The pool, as plain ids. */
async function botIds() {
  const rows = await col('users').find({ is_bot: true }, { projection: { _id: 0, id: 1 } }).toArray();
  return rows.map(r => r.id);
}

/* ---------- the board ---------- */

/** Broadcast helper — a bot battle is shaped for an onlooker, never a player,
    so the (meaningless) room code stays out of the payload. */
async function emitCreated(io, id) {
  if (!io) return;
  const b = await fetchBattle(id);
  if (b) io.emit('battle:created', shape(b, null));
}

/** Put one open bot battle on the board and schedule its acceptance. */
async function createOne(app, ids) {
  if (ids.length < 2) return null;
  const creator = pick(ids);
  const rich = Math.random() < 0.15;
  const mode = rich ? 'rich' : 'lite';
  const amount = rich ? pick(RICH_STAKES) : pick(LITE_STAKES);
  const cfg = MODES[mode];
  // Never publish a battle the lobby would reject as out of range.
  if (amount < cfg.min || amount > cfg.max || amount % cfg.step !== 0) return null;

  const id = newBattleId();
  const acceptAt = now() + randInt(ACCEPT_MIN_MS, ACCEPT_MAX_MS);
  await col('battles').insertOne({
    id, mode, amount, status: 'open', creator_id: creator, acceptor_id: null,
    room_code: null, winner_id: null, payout: null, created_at: now(), settled_at: null,
    /* Explicitly null, matching a real battle with no stake recorded — but
       nothing will ever read them, because a bot battle cannot be refunded. */
    creator_stake: null, acceptor_stake: null,
    is_bot: true, bot_accept_at: acceptAt,
    /* A retirement stamp from the start, overwritten when it is accepted.
       Without it, a battle whose acceptance never lands — the pool emptied,
       every attempt lost its race — would sit open on the lobby forever,
       showing a Play button that can only ever refuse. */
    bot_retire_at: now() + LIFETIME_MAX_MS,
  });

  await emitCreated(app?.get?.('io'), id);

  /* The timer gives the exact two-to-three seconds. The sweep below is the
     backstop: after a restart the timer is gone but `bot_accept_at` is not. */
  const t = setTimeout(() => { acceptOne(app, id).catch(() => {}); }, acceptAt - now());
  t.unref?.();
  return id;
}

/** Move one open bot battle straight into Running with a second bot. */
async function acceptOne(app, id) {
  const b = await col('battles').findOne({ id, is_bot: true, status: 'open' });
  if (!b) return false;                       // already accepted, or retired

  const ids = (await botIds()).filter(uid => uid !== b.creator_id);
  if (!ids.length) return false;

  /* Guarded on the status it was read at, so the timer and the sweep cannot
     both accept the same battle. */
  const taken = await col('battles').updateOne(
    { id, is_bot: true, status: 'open' },
    { $set: { acceptor_id: pick(ids), status: 'running', room_code: roomCode(),
              room_set_at: now(), bot_retire_at: now() + randInt(LIFETIME_MIN_MS, LIFETIME_MAX_MS) },
      $unset: { bot_accept_at: '' } });
  if (taken.matchedCount === 0) return false;

  const io = app?.get?.('io');
  // Off the open board, onto the running one — the same pair of events a real
  // acceptance produces, so the lobby needs no special case for bots.
  io?.emit('battle:removed', { id });
  await emitCreated(io, id);
  return true;
}

/** Delete bot battles whose time is up, and tell the lobby they are gone. */
async function retireExpired(app) {
  const due = await col('battles')
    .find({ is_bot: true, bot_retire_at: { $lte: now() } }, { projection: { _id: 0, id: 1 } })
    .limit(50).toArray();
  if (!due.length) return 0;
  const ids = due.map(d => d.id);
  await col('battles').deleteMany({ id: { $in: ids }, is_bot: true });
  const io = app?.get?.('io');
  for (const id of ids) io?.emit('battle:removed', { id });
  return ids.length;
}

/** One pass: retire the old, accept anything the timers missed, top up. */
export async function runBotTick(app) {
  await retireExpired(app);

  // Restart backstop — battles whose accept timer died with the old process.
  const stale = await col('battles')
    .find({ is_bot: true, status: 'open', bot_accept_at: { $lte: now() } },
      { projection: { _id: 0, id: 1 } }).limit(25).toArray();
  for (const s of stale) await acceptOne(app, s.id);

  const live = await col('battles').countDocuments({ is_bot: true, status: { $in: ['open', 'running'] } });
  if (live >= TARGET_RUNNING) return { live, created: 0 };

  const ids = await botIds();
  /* One per tick. Creating the whole shortfall at once produced a visible
     burst of identical timestamps, which is exactly what it must not look
     like. */
  const created = await createOne(app, ids);
  return { live, created: created ? 1 : 0 };
}

/** Start the engine. Returns a stop function. */
export function startBotEngine(app, intervalMs = TICK_MS) {
  if (!BOTS_ENABLED) {
    console.log('[bots] disabled (BOT_BATTLES=false)');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;                      // never let two passes overlap
    running = true;
    try { await runBotTick(app); }
    catch (e) { console.error('[bots] tick failed:', e?.message); }
    finally { running = false; }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const boot = setTimeout(async () => {
    try {
      const made = await ensureBots();
      if (made.length) console.log(`[bots] created ${made.length} bot account(s)`);
      await tick();
    } catch (e) { console.error('[bots] startup failed:', e?.message); }
  }, 2000);
  boot.unref?.();

  console.log(`[bots] lobby bots on — up to ${TARGET_RUNNING} battles, tick ${Math.round(intervalMs / 1000)}s`);
  return () => { clearInterval(timer); clearTimeout(boot); };
}
