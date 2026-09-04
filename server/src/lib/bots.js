/* ============================================================
   Bot battles — lobby activity.

   A fresh lobby with nothing in it reads as a dead product, so a
   small pool of house accounts keeps a board on it. The board is
   deliberately small and fixed:

     3 running   — matches in progress
     2 open      — challenges genuinely waiting for an opponent

   The open two are not a two-second staging post on the way to
   running; they sit there, which is what makes the lobby look
   like a place a real player could join. One is promoted only
   when a running battle retires and a slot opens, so an open
   challenge waits minutes, not seconds — and the oldest goes
   first, so nothing sits there going stale.

   Player names rotate every ten minutes from a large pool, so
   the same fifteen faces are not on the board all day. A bot
   currently named on a live battle keeps its name until that
   battle ends — renaming one player of a match already on screen
   is the one thing that would make the board look generated.

   Three rules hold this together and everything else follows:

     1. No money. A bot battle never debits, credits or writes a
        ledger row, and never settles, so it can neither create
        nor destroy a rupee. There is no bot commission to hide
        from the admin console because none is ever earned.
     2. No real player can join one. A tap on an open bot battle
        is answered honestly — "another player just joined this
        battle" — and the waiting bot takes it there and then, so
        the row is gone by the next refresh.
     3. Bots cannot sign in. Their phone numbers start with 1,
        which the signup schema (^[6-9]\d{9}$) rejects, so no real
        person can ever register one and no bot can ever hold a
        session.

   Everything the bots produce is marked `is_bot: true`, which is
   what the admin queries filter on and what the startup purge
   deletes. Rows without that flag are NOT ours: a demo seed run
   against a live database leaves battles that look like these
   and are not — see server/src/purge-demo.js.
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

/* Real first-and-last names, because these sit on the open board next to real
   players — a board of handles like "AmanRolls" beside "Priya Nair" reads as
   two different kinds of account.

   A pool much larger than the pool of accounts, so a rotation genuinely
   changes the faces rather than shuffling the same fifteen. */
const NAME_POOL = [
  'Rohit Sharma', 'Sneha Patil', 'Aman Verma', 'Priya Nair', 'Karan Mehta',
  'Deepak Yadav', 'Nisha Reddy', 'Arjun Iyer', 'Megha Joshi', 'Sahil Khan',
  'Pooja Desai', 'Vikas Chauhan', 'Ritu Singh', 'Harsh Malhotra', 'Ankit Bansal',
  'Neha Kulkarni', 'Rahul Pillai', 'Divya Menon', 'Manish Gupta', 'Kavya Rao',
  'Sandeep Bose', 'Anjali Saxena', 'Vivek Ranjan', 'Shreya Ghosh', 'Nikhil Jain',
  'Farhan Ansari', 'Ishita Bhat', 'Gaurav Thakur', 'Swati Kamble', 'Rajat Bhatia',
  'Tanvi Shetty', 'Imran Qureshi', 'Lakshmi Iyengar', 'Yogesh Pawar', 'Aarti Deshmukh',
  'Siddharth Rana', 'Preeti Chawla', 'Naveen Kurup', 'Bhavna Trivedi', 'Akash Dubey',
  'Ruchi Agarwal', 'Zaid Shaikh', 'Sonal Mishra', 'Pankaj Rathore', 'Aditi Sinha',
  'Varun Nambiar', 'Komal Bhardwaj', 'Suresh Naidu', 'Payal Chopra', 'Kunal Sarin',
  'Ayesha Siddiqui', 'Mohit Grover', 'Rekha Salvi', 'Devendra Joshi', 'Simran Kaur',
  'Abhinav Roy', 'Trisha Fernandes', 'Ramesh Patel', 'Juhi Mahajan', 'Om Prakash',
];

/** Is this a name from our pool, or a leftover from an older seed? */
const isPoolName = n => NAME_POOL.includes(n);

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

/** The board, exactly. Three matches in progress and two challenges genuinely
    waiting for an opponent — not five of anything, because the two halves say
    different things to somebody looking at the lobby. */
export const TARGET_RUNNING = Math.min(num(process.env.BOT_TARGET_RUNNING, 3), 25);
export const TARGET_OPEN    = Math.min(num(process.env.BOT_TARGET_OPEN, 2), 25);

/** How long a bot battle stays in Running before it is retired. This is also
    what sets how long an open challenge waits: one is promoted each time a
    running slot frees up. */
const LIFETIME_MIN_MS = num(process.env.BOT_LIFETIME_MIN_MS, 3 * 60 * 1000);
const LIFETIME_MAX_MS = Math.max(LIFETIME_MIN_MS, num(process.env.BOT_LIFETIME_MAX_MS, 8 * 60 * 1000));

/** How often the faces on the board change. */
export const NAME_ROTATE_MS = num(process.env.BOT_NAME_ROTATE_MS, 10 * 60 * 1000);

/* The board only changes when a battle retires, which is minutes apart, so
   there is nothing to gain from a fast tick. */
const TICK_MS = num(process.env.BOT_TICK_MS, 15000);

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
  const taken = new Set();
  for (let i = 0; i < BOT_COUNT; i++) {
    const phone = botPhone(i);
    const existing = await col('users').findOne({ phone },
      { projection: { _id: 0, id: 1, name: 1, is_bot: 1 } });

    if (existing) {
      /* Repair in place rather than recreate. An account seeded before the
         flag existed still has to carry it, or it shows up in the admin
         console as a real player.

         The name is only replaced when it is not one of ours — an old handle
         like "AmanRolls", or nothing at all. A name this pool rotated in
         legitimately is left alone, or every restart would undo the rotation
         and put the same fifteen faces back. */
      const $set = {};
      if (!existing.is_bot) $set.is_bot = true;
      if (!isPoolName(existing.name)) $set.name = freeName(taken);
      if (Object.keys($set).length) await col('users').updateOne({ phone }, { $set });
      taken.add($set.name || existing.name);
      continue;
    }

    const name = freeName(taken);
    taken.add(name);
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

/** A name from the pool that nobody in `taken` is using.

    Two bots sharing a name would put the same person on both sides of a
    match. The pool is four times the size of the account list, so the random
    pick almost always lands first time; the scan is the guarantee, not the
    strategy. */
function freeName(taken) {
  for (let i = 0; i < 40; i++) {
    const n = pick(NAME_POOL);
    if (!taken.has(n)) return n;
  }
  return NAME_POOL.find(n => !taken.has(n)) || pick(NAME_POOL);
}

/** Give the board new faces.

    Every bot that is not currently named on a live bot battle takes a fresh
    name. The ones that are keep theirs until their battle ends: renaming a
    player of a match already on somebody's screen is the single thing that
    would give the board away, and battles only live three to eight minutes,
    so a bot skipped by one rotation is almost always free for the next.

    Returns how many were renamed. */
export async function rotateBotNames(app = null) {
  // Retire any open bot battles older than 10 minutes so waiting challenges don't get stale
  const staleOpen = await col('battles').find(
    { is_bot: true, status: 'open', created_at: { $lte: now() - NAME_ROTATE_MS } },
    { projection: { _id: 0, id: 1 } }
  ).toArray();
  for (const b of staleOpen) {
    await col('battles').deleteOne({ id: b.id });
    ioOf(app)?.emit('battle:removed', { id: b.id });
  }

  const live = await col('battles').find(
    { is_bot: true, status: 'running' },
    { projection: { _id: 0, creator_id: 1, acceptor_id: 1 } }).toArray();
  const inRunningMatch = new Set();
  for (const b of live) {
    if (b.creator_id != null) inRunningMatch.add(b.creator_id);
    if (b.acceptor_id != null) inRunningMatch.add(b.acceptor_id);
  }

  const bots = await col('users').find({ is_bot: true },
    { projection: { _id: 0, id: 1, name: 1 } }).toArray();

  const taken = new Set(bots.filter(b => inRunningMatch.has(b.id)).map(b => b.name));

  let renamed = 0;
  for (const b of bots) {
    if (inRunningMatch.has(b.id)) continue;
    const name = freeName(taken);
    taken.add(name);
    if (name === b.name) continue;
    await col('users').updateOne({ id: b.id }, { $set: { name } });
    renamed++;
  }

  if (renamed > 0 || staleOpen.length > 0) {
    ioOf(app)?.emit('battle:updated');
  }

  return renamed;
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

/** Put one open bot battle on the board — a challenge genuinely waiting for
    an opponent, with the bot that will eventually take it chosen up front.

    Choosing the acceptor now rather than at acceptance time means a real
    player's tap can hand the battle straight to the bot that was always going
    to get it, in one conditional update with no second lookup. */
async function createOpen(app, ids) {
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
  await col('battles').insertOne({
    id, mode, amount, status: 'open', creator_id: creator, acceptor_id: null,
    room_code: null, winner_id: null, payout: null, created_at: now(), settled_at: null,
    room_set_at: null,
    creator_stake: null, acceptor_stake: null,
    is_bot: true,
    bot_acceptor_id: acceptor,
    bot_retire_at: null,          // set when it starts running, not before
  });

  const io = ioOf(app);
  if (io) {
    const b = await fetchBattle(id);
    // Shaped for an onlooker, never a player: no room code goes out.
    if (b) io.emit('battle:created', shape(b, null));
  }
  return id;
}

/** Hand an open bot battle to the bot that was waiting for it.

    Idempotent and safe to call from anywhere: the tick promotes with it when
    a running slot frees up, and a real player's tap triggers it. The update
    is conditional on the battle still being open, so whichever caller arrives
    second changes nothing and reports false. */
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
    }, $unset: { bot_acceptor_id: '' } });
  if (taken.matchedCount === 0) return false;         // someone got there first

  /* One event is enough. The lobby drops the row from its open list on
     `battle:removed` and then refetches, which is how the same battle
     reappears in Running a moment later. */
  ioOf(app)?.emit('battle:removed', { id });
  return true;
}

/** Promote the challenge that has been waiting longest.

    Oldest first, so an open battle cannot sit on the board indefinitely while
    newer ones are taken around it — that is what would make a waiting
    challenge look like scenery rather than an opportunity. */
async function promoteOldestOpen(app) {
  const [oldest] = await col('battles').find(
    { is_bot: true, status: 'open' },
    { projection: { _id: 0, id: 1 } }).sort({ created_at: 1 }).limit(1).toArray();
  if (!oldest) return false;
  return botTakeOver(app, oldest.id);
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

/** One pass: retire the old, refill Running by promoting a waiting challenge,
    then bring the waiting board back up to strength.

    The order is what produces the cycle. A running battle expires, the
    challenge that has waited longest is taken to replace it, and a fresh
    challenge goes up in its place — which is what a lobby with people in it
    actually looks like. */
export async function runBotTick(app) {
  await retireExpired(app);

  const ids = await botIds();
  const count = async status => col('battles').countDocuments({ is_bot: true, status });
  let running = await count('running');
  let open = await count('open');

  // Enforce upper bound on running matches (target: 3)
  if (running > TARGET_RUNNING) {
    const excess = running - TARGET_RUNNING;
    const toRetire = await col('battles').find(
      { is_bot: true, status: 'running' },
      { projection: { _id: 0, id: 1 } }
    ).sort({ bot_retire_at: 1 }).limit(excess).toArray();
    if (toRetire.length) {
      const rIds = toRetire.map(r => r.id);
      await col('battles').deleteMany({ id: { $in: rIds }, is_bot: true });
      const io = ioOf(app);
      for (const id of rIds) io?.emit('battle:removed', { id });
      running -= toRetire.length;
    }
  }

  // Enforce upper bound on open matches (target: 2)
  if (open > TARGET_OPEN) {
    const excess = open - TARGET_OPEN;
    const toRemove = await col('battles').find(
      { is_bot: true, status: 'open' },
      { projection: { _id: 0, id: 1 } }
    ).sort({ created_at: 1 }).limit(excess).toArray();
    if (toRemove.length) {
      const oIds = toRemove.map(o => o.id);
      await col('battles').deleteMany({ id: { $in: oIds }, is_bot: true });
      const io = ioOf(app);
      for (const id of oIds) io?.emit('battle:removed', { id });
      open -= toRemove.length;
    }
  }

  /* Fill Running from the waiting board. On a cold board there is nothing
     waiting yet, so one is created to be promoted immediately — that only
     happens on the first pass after a deploy. */
  let promoted = 0, created = 0;
  while (running < TARGET_RUNNING) {
    if (open === 0) {
      if (!await createOpen(app, ids)) break;
      open++; created++;
    }
    if (!await promoteOldestOpen(app)) break;
    open--; running++; promoted++;
  }

  while (open < TARGET_OPEN) {
    if (!await createOpen(app, ids)) break;
    open++; created++;
  }

  return { running, open, promoted, created };
}

/** Start the engine. Returns a stop function. */
export function startBotEngine(app, intervalMs = TICK_MS) {
  if (!BOTS_ENABLED) {
    console.log('[bots] disabled (BOT_BATTLES=false)');
    return () => {};
  }

  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;                      // never let two passes overlap
    isRunning = true;
    try { await runBotTick(app); }
    catch (e) { console.error('[bots] tick failed:', e?.message); }
    finally { isRunning = false; }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  // Name rotation timer: every 10 minutes rotate bot faces and retire stale waiting challenges
  const nameTimer = setInterval(async () => {
    try {
      const renamed = await rotateBotNames(app);
      if (renamed) console.log(`[bots] rotated ${renamed} bot name(s)`);
    } catch (e) {
      console.error('[bots] name rotation failed:', e?.message);
    }
  }, NAME_ROTATE_MS);
  nameTimer.unref?.();

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

  console.log(`[bots] lobby bots on — ${TARGET_RUNNING} running, ${TARGET_OPEN} open, ` +
    `name rotation every ${Math.round(NAME_ROTATE_MS / 60000)}m, tick ${Math.round(intervalMs / 1000)}s`);

  return () => {
    clearInterval(timer);
    clearInterval(nameTimer);
    clearTimeout(boot);
  };
}
