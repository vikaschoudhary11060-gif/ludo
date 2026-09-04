/* ============================================================
   Bot battles — lobby activity.

   A fresh lobby with nothing in it reads as a dead product, so a
   small pool of house accounts keeps battles appearing. Each bot
   battle now lives the same life a real one does, in public:

     open  →  a second bot accepts within five seconds  →  running
           →  sits there a few minutes  →  removed

   The open window is the point. A board where challenges only
   ever appear already-running looks staged; one where a challenge
   goes up, is taken, and disappears looks like a room with people
   in it. Five battles are kept on the board at a time.

   Three rules hold this together and everything else follows from
   them:

     1. No money. A bot battle never debits, credits or writes a
        ledger row, and never settles, so it can neither create nor
        destroy a rupee. There is no bot commission to hide from
        the admin console because none is ever earned.
     2. No real player can join one. A tap inside the open window
        is answered honestly — "another player just joined this
        battle" — and the waiting bot takes it there and then, so
        the row is gone by the next refresh instead of sitting
        there looking free.
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

/* Full names, because these sit on the open board next to real players and a
   board of handles like "AmanRolls" next to "Priya Nair" reads as two
   different kinds of account. Indexed by position: the name at index i always
   belongs to botPhone(i), so ensureBots() can correct a renamed pool without
   shuffling anybody's identity. */
const BOT_NAMES = [
  'Rohit Sharma', 'Sneha Patil', 'Aman Verma', 'Priya Nair', 'Karan Mehta',
  'Deepak Yadav', 'Nisha Reddy', 'Arjun Iyer', 'Megha Joshi', 'Sahil Khan',
  'Pooja Desai', 'Vikas Chauhan', 'Ritu Singh', 'Harsh Malhotra', 'Ankit Bansal',
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

/** How many bot battles sit on the board at once, counting the one or two
    that are briefly open on their way to running. */
export const TARGET_LIVE = Math.min(num(process.env.BOT_TARGET_RUNNING, 5), 25);

/** The open window: how long a bot battle is visible on the open board before
    another bot takes it.

    Five seconds is a promise, not a preference, so the ceiling is clamped
    rather than merely defaulted — an operator cannot widen it by setting the
    environment variable, only narrow it. */
export const ACCEPT_CEILING_MS = 5000;
const ACCEPT_MAX_MS = Math.min(num(process.env.BOT_ACCEPT_MAX_MS, 4000), ACCEPT_CEILING_MS);
const ACCEPT_MIN_MS = Math.min(num(process.env.BOT_ACCEPT_MIN_MS, 1500), ACCEPT_MAX_MS);

/** How long a bot battle stays in Running before it is retired. */
const LIFETIME_MIN_MS = num(process.env.BOT_LIFETIME_MIN_MS, 3 * 60 * 1000);
const LIFETIME_MAX_MS = Math.max(LIFETIME_MIN_MS, num(process.env.BOT_LIFETIME_MAX_MS, 8 * 60 * 1000));

/* Half the open window, so the tick is a real safety net for an acceptance
   whose timer died with a restart rather than a second source of lateness. */
const TICK_MS = Math.min(num(process.env.BOT_TICK_MS, 2000), ACCEPT_CEILING_MS);
/* Creating one per tick would leave the board visibly thin for ten seconds
   after a deploy; creating all five at once would put five identical-aged
   challenges up together. Two is the middle. */
const CREATE_PER_TICK = 2;

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const newBattleId = () => crypto.randomBytes(6).toString('hex');
const roomCode = () => String(randInt(10_000_000, 99_999_999));

const ioOf = app => app?.get?.('io') || null;

/* ---------- accounts ---------- */

/** Create the bot pool if it is not there yet. Safe to re-run: it only fills
    in what is missing, so a restart is a no-op and a partially created pool
    is completed rather than duplicated. */
export async function ensureBots() {
  const created = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const phone = botPhone(i);
    const name = BOT_NAMES[i] || `Player${phone.slice(-4)}`;
    const existing = await col('users').findOne({ phone },
      { projection: { _id: 0, id: 1, name: 1, is_bot: 1 } });
    if (existing) {
      /* Repair in place rather than recreate. An account seeded before the
         flag existed still has to carry it, or it shows up in the admin
         console as a real player; and a pool seeded under the old handles
         has to pick up the real names, or the board stays half-renamed. */
      const $set = {};
      if (!existing.is_bot) $set.is_bot = true;
      if (existing.name !== name) $set.name = name;
      if (Object.keys($set).length) await col('users').updateOne({ phone }, { $set });
      continue;
    }
    const id = await nextId('users');
    await col('users').insertOne({
      id, phone, name,
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

/** Clear every bot battle off the board and tell the lobby they are gone.

    Runs once at startup. Bot battles are scenery, not state: nothing is owed
    on them and nobody is waiting for one, so carrying a previous process's
    rows across a deploy only leaves battles that no timer will ever accept or
    retire. Starting from an empty board is the only version of this with no
    orphans in it. */
export async function purgeBotBattles(app) {
  const rows = await col('battles').find({ is_bot: true },
    { projection: { _id: 0, id: 1 } }).limit(500).toArray();
  if (!rows.length) return 0;
  await col('battles').deleteMany({ is_bot: true });
  const io = ioOf(app);
  for (const r of rows) io?.emit('battle:removed', { id: r.id });
  return rows.length;
}

/** Put one open bot battle on the board, with the bot that will take it and
    the moment it will be taken both decided up front.

    Choosing the acceptor now rather than at acceptance time is what makes the
    takeover a single conditional update with no second lookup — and it means
    a real player's tap can hand the battle straight to the bot that was
    always going to get it. */
async function createOne(app, ids) {
  if (ids.length < 2) return null;
  const creator = pick(ids);
  const others = ids.filter(uid => uid !== creator);
  if (!others.length) return null;
  const acceptor = pick(others);

  const rich = Math.random() < 0.15;
  const mode = rich ? 'rich' : 'lite';
  const amount = rich ? pick(RICH_STAKES) : pick(LITE_STAKES);
  const cfg = MODES[mode];
  // Never publish a battle the lobby would reject as out of range.
  if (amount < cfg.min || amount > cfg.max || amount % cfg.step !== 0) return null;

  const id = newBattleId();
  const acceptIn = randInt(ACCEPT_MIN_MS, ACCEPT_MAX_MS);
  await col('battles').insertOne({
    id, mode, amount, status: 'open', creator_id: creator, acceptor_id: null,
    room_code: null, winner_id: null, payout: null, created_at: now(), settled_at: null,
    room_set_at: null,
    creator_stake: null, acceptor_stake: null,
    is_bot: true,
    bot_acceptor_id: acceptor,
    bot_accept_at: now() + acceptIn,
    bot_retire_at: null,          // set when it starts running, not before
  });

  const io = ioOf(app);
  if (io) {
    const b = await fetchBattle(id);
    // Shaped for an onlooker, never a player: no room code goes out.
    if (b) io.emit('battle:created', shape(b, null));
  }
  return { id, acceptIn };
}

/** Hand an open bot battle to the bot that was waiting for it.

    Idempotent and safe to call from anywhere: the timer fires it, the tick
    sweeps for it after a restart, and a real player's tap triggers it. The
    update is conditional on the battle still being open, so whichever caller
    arrives second changes nothing and reports false. */
export async function botTakeOver(app, id) {
  const b = await col('battles').findOne({ id, is_bot: true },
    { projection: { _id: 0, id: 1, status: 1, bot_acceptor_id: 1, creator_id: 1 } });
  if (!b || b.status !== 'open') return false;

  /* A pool that shrank under us would otherwise pair a battle with itself.
     Falling back to any other bot keeps the board consistent rather than
     leaving a battle open forever with nobody able to take it. */
  let acceptor = b.bot_acceptor_id;
  if (acceptor == null || acceptor === b.creator_id) {
    const others = (await botIds()).filter(uid => uid !== b.creator_id);
    if (!others.length) return false;
    acceptor = pick(others);
  }

  const at = now();
  const taken = await col('battles').updateOne(
    { id, is_bot: true, status: 'open' },
    { $set: {
      status: 'running', acceptor_id: acceptor,
      room_code: roomCode(), room_set_at: at,
      bot_retire_at: at + randInt(LIFETIME_MIN_MS, LIFETIME_MAX_MS),
    }, $unset: { bot_accept_at: '', bot_acceptor_id: '' } });
  if (taken.matchedCount === 0) return false;         // someone got there first

  /* One event is enough. The lobby drops the row from its open list on
     `battle:removed` and then refetches, which is how the same battle
     reappears in Running a moment later. */
  ioOf(app)?.emit('battle:removed', { id });
  return true;
}

/** Take over every open bot battle whose moment has passed.

    The per-battle timer in the engine is what actually delivers the five-second
    promise; this is the net under it, for the battles whose timers died with a
    restart. */
async function acceptDue(app) {
  const due = await col('battles').find(
    { is_bot: true, status: 'open', bot_accept_at: { $lte: now() } },
    { projection: { _id: 0, id: 1 } }).limit(50).toArray();
  let taken = 0;
  for (const d of due) if (await botTakeOver(app, d.id)) taken++;
  return taken;
}

/** Delete bot battles whose time is up, and tell the lobby they are gone. */
async function retireExpired(app) {
  const due = await col('battles')
    .find({ is_bot: true, bot_retire_at: { $lte: now() } }, { projection: { _id: 0, id: 1 } })
    .limit(50).toArray();
  if (!due.length) return 0;
  const ids = due.map(d => d.id);
  await col('battles').deleteMany({ id: { $in: ids }, is_bot: true });
  const io = ioOf(app);
  for (const id of ids) io?.emit('battle:removed', { id });
  return ids.length;
}

/** One pass: retire the old, take over anything due, top the board back up.

    `onCreated` is how the engine gets its per-battle acceptance timer; the
    tick itself stays a plain async function so tests can drive it directly. */
export async function runBotTick(app, onCreated = null) {
  await retireExpired(app);
  const accepted = await acceptDue(app);

  /* Open battles count towards the target. Without that, every tick inside a
     new battle's open window would see "only four running" and start another,
     and the board would overshoot by however many ticks fit in five seconds. */
  const live = await col('battles').countDocuments(
    { is_bot: true, status: { $in: ['open', 'running'] } });
  if (live >= TARGET_LIVE) return { live, accepted, created: 0 };

  const ids = await botIds();
  let created = 0;
  for (let i = 0; i < Math.min(TARGET_LIVE - live, CREATE_PER_TICK); i++) {
    const made = await createOne(app, ids);
    if (!made) break;
    created++;
    if (onCreated) onCreated(made.id, made.acceptIn);
  }
  return { live, accepted, created };
}

/** Start the engine. Returns a stop function. */
export function startBotEngine(app, intervalMs = TICK_MS) {
  if (!BOTS_ENABLED) {
    console.log('[bots] disabled (BOT_BATTLES=false)');
    return () => {};
  }

  /* Every pending acceptance, so stopping the engine does not leave timers
     firing against a database the process is done with. */
  const pending = new Set();
  const scheduleAccept = (id, delay) => {
    const t = setTimeout(async () => {
      pending.delete(t);
      try { await botTakeOver(app, id); }
      catch (e) { console.error(`[bots] accept failed for ${id}:`, e?.message); }
    }, delay);
    t.unref?.();
    pending.add(t);
  };

  let running = false;
  const tick = async () => {
    if (running) return;                      // never let two passes overlap
    running = true;
    try { await runBotTick(app, scheduleAccept); }
    catch (e) { console.error('[bots] tick failed:', e?.message); }
    finally { running = false; }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const boot = setTimeout(async () => {
    try {
      const made = await ensureBots();
      if (made.length) console.log(`[bots] created ${made.length} bot account(s)`);
      const cleared = await purgeBotBattles(app);
      if (cleared) console.log(`[bots] cleared ${cleared} bot battle(s) left by the previous run`);
      await tick();
    } catch (e) { console.error('[bots] startup failed:', e?.message); }
  }, 2000);
  boot.unref?.();

  console.log(`[bots] lobby bots on — ${TARGET_LIVE} battles on the board, ` +
    `each open ${(ACCEPT_MIN_MS / 1000).toFixed(1)}-${(ACCEPT_MAX_MS / 1000).toFixed(1)}s ` +
    `before another bot takes it, tick ${Math.round(intervalMs / 1000)}s`);

  return () => {
    clearInterval(timer);
    clearTimeout(boot);
    for (const t of pending) clearTimeout(t);
    pending.clear();
  };
}
