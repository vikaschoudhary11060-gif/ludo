/* ============================================================
   The parts of these features that live in the pages.

   A route can be perfect and the feature still absent, because
   the button was never added or the built page was never
   regenerated. These assertions are about what actually ships.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — the repo path contains a space.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

/* ---------------------------------------------------------------- */
test('the admin notice banner on the battles page', async t => {
  const page = read('battles.html');
  const js = read('assets/js/battles.js');

  await t.test('exists, above the amount box', () => {
    assert.ok(page.includes('id="site-notice"'), 'no banner element');
    assert.ok(page.includes('id="site-notice-text"'), 'no place to put the text');
    assert.ok(page.indexOf('id="site-notice"') < page.indexOf('id="amount"'),
      'the notice must sit above the "enter game amount" input');
  });

  await t.test('starts hidden, so an empty notice shows nothing', () => {
    const tag = page.slice(page.indexOf('id="site-notice"') - 400, page.indexOf('id="site-notice"'));
    assert.match(tag, /\bhidden\b/, 'the banner is not hidden by default');
  });

  await t.test('is filled from the server setting, as text', () => {
    assert.match(js, /showNotice\(/, 'the notice is never read from config');
    assert.match(js, /body\.textContent =/, 'the notice must be written as text, never as markup');
    assert.doesNotMatch(js, /toast\(conf\.notice/,
      'the notice moved into the banner; a toast as well would double it up');
  });

  await t.test('the title block above it was kept', () => {
    // The layout the change was signed off on: notice, then title, then form.
    assert.ok(page.includes('id="mode-title"') && page.includes('id="mode-range"'));
    assert.ok(page.indexOf('id="site-notice"') < page.indexOf('id="mode-title"'));
  });
});

/* ---------------------------------------------------------------- */
test('the instant deposit is gone from the front end', async t => {
  const page = read('add-cash.html');

  await t.test('no instant route chip, no instant pay button', () => {
    for (const gone of ['data-route="instant"', 'data-route="manual"', 'id="pay-btn"', 'id="instant-note"']) {
      assert.ok(!page.includes(gone), `add-cash.html still has ${gone}`);
    }
  });

  await t.test('the API client no longer offers the endpoint', () => {
    const api = read('assets/js/api.js');
    assert.doesNotMatch(api, /deposit:\s*amount\s*=>/, 'Api.wallet.deposit still exists');
    assert.doesNotMatch(api, /'\/wallet\/deposit'/, 'the instant endpoint is still called');
  });

  await t.test('and nothing else calls it', () => {
    for (const f of fs.readdirSync(path.join(root, 'assets/js')).filter(f => f.endsWith('.js'))) {
      assert.doesNotMatch(read(`assets/js/${f}`), /Api\.wallet\.deposit\(/, `${f} calls the removed endpoint`);
    }
  });
});

/* ---------------------------------------------------------------- */
test('the manual QR deposit flow', async t => {
  const page = read('add-cash.html');

  await t.test('shows the QR, the UPI id and a copy button', () => {
    for (const id of ['qr-img', 'qr-wrap', 'upi-id-value', 'copy-upi']) {
      assert.ok(page.includes(`id="${id}"`), `add-cash.html is missing #${id}`);
    }
  });

  await t.test('takes an amount and a UTR', () => {
    for (const id of ['deposit', 'amount-chips', 'utr', 'utr-btn']) {
      assert.ok(page.includes(`id="${id}"`), `add-cash.html is missing #${id}`);
    }
  });

  await t.test('lists the player’s own requests and their status', () => {
    assert.ok(page.includes('id="req-list"') && page.includes('id="req-empty"'));
  });

  await t.test('says money is credited only after approval', () => {
    assert.match(page, /credited only after/i,
      'the page must be explicit that nothing lands until an admin approves');
  });
});

/* ---------------------------------------------------------------- */
test('the withdrawal method picker', async t => {
  const page = read('withdraw.html');
  const js = read('assets/js/withdraw.js');

  await t.test('offers both methods', () => {
    assert.ok(page.includes('data-method="upi"'), 'no UPI option');
    assert.ok(page.includes('data-method="bank"'), 'no bank transfer option');
  });

  await t.test('has the fields each method needs', () => {
    for (const id of ['upi-id', 'bank-name', 'acc-name', 'acc-no', 'ifsc']) {
      assert.ok(page.includes(`id="${id}"`), `withdraw.html is missing #${id}`);
    }
    assert.ok(page.includes('id="upi-fields"') && page.includes('id="bank-fields"'),
      'the two field groups must be separable, or both would always show');
  });

  await t.test('shows only the chosen method’s fields', () => {
    assert.match(js, /#upi-fields'\)\.hidden = method !== 'upi'/);
    assert.match(js, /#bank-fields'\)\.hidden = method !== 'bank'/);
  });

  await t.test('checks the details before sending them', () => {
    // Same shapes the server enforces, so a typo is caught in the form.
    assert.match(js, /IFSC_RE/, 'no IFSC check');
    assert.match(js, /ACCOUNT_RE/, 'no account number check');
    assert.match(js, /UPI_RE/, 'no UPI id check');
  });

  await t.test('no longer claims to be a demo', () => {
    assert.doesNotMatch(page, /Demo only/i, 'the page still tells players no money moves');
  });
});

/* ---------------------------------------------------------------- */
test('the Ludo King links on the bet details page', async t => {
  const page = read('battle.html');

  await t.test('links to both stores', () => {
    assert.ok(page.includes('https://play.google.com/store/apps/details?id=com.ludo.king'),
      'no Play Store link');
    assert.ok(page.includes('https://apps.apple.com/in/app/ludo-king/id993090598'),
      'no App Store link');
  });

  await t.test('shows an icon for each', () => {
    const card = page.slice(page.indexOf('id="ludoking-section"'));
    const section = card.slice(0, card.indexOf('</section>'));
    assert.equal((section.match(/<svg/g) || []).length, 2, 'expected one icon per store');
    assert.ok(section.includes('Google Play') && section.includes('App Store'));
  });

  await t.test('carries a heading that explains why they are there', () => {
    assert.match(page, /Play this match on Ludo King/);
    assert.match(page, /room code/i);
  });

  await t.test('opens the stores safely in a new tab', () => {
    const card = page.slice(page.indexOf('id="ludoking-section"'));
    const section = card.slice(0, card.indexOf('</section>'));
    assert.equal((section.match(/rel="noopener noreferrer"/g) || []).length, 2);
  });
});

/* ---------------------------------------------------------------- */
test('the cancel window on the bet details page', async t => {
  const js = read('assets/js/battle.js');
  const config = read('server/src/lib/config.js');

  await t.test('is ten minutes on the server', () => {
    assert.match(config, /CANCEL_WINDOW_MS = 10 \* 60 \* 1000/);
  });

  await t.test('shows the 10-minute cancellation window in battle details', () => {
    assert.match(js, /10-minute timer/);
  });
});

/* ---------------------------------------------------------------- */
test('the match alerts', async t => {
  const js = read('assets/js/alert.js');

  await t.test('load on both the lobby and the battle room', () => {
    for (const page of ['battles.html', 'battle.html']) {
      assert.match(read(page), /<script src="assets\/js\/alert\.js"/, `${page} does not load alert.js`);
    }
  });

  await t.test('fire when a host gets an opponent', () => {
    for (const f of ['assets/js/battle.js', 'assets/js/battles.js']) {
      assert.match(read(f), /Opponent found!/, `${f} never alerts the host`);
    }
  });

  await t.test('fire when the host starts the match', () => {
    for (const f of ['assets/js/battle.js', 'assets/js/battles.js']) {
      assert.match(read(f), /has started the match/, `${f} never alerts the opponent`);
    }
  });

  await t.test('ring for five seconds, not one chirp', () => {
    assert.match(js, /const ALERT_MS = 5000;/, 'the alert duration is not five seconds');
    // A loop over the duration, rather than a fixed pair of notes.
    assert.match(js, /for \(let at = 0; at < seconds; at \+= PERIOD\)/,
      'the tone is not repeated across the alert window');
    assert.match(js, /ring\(ms\)/, 'fire() does not ring for the full duration');
  });

  await t.test('schedule on the audio clock, not on a repeating timer', () => {
    /* A setInterval is throttled to once a second in a background tab and
       may be stopped outright — exactly when a five-second alert matters. */
    // The call, not the word: the comment above the scheduler names it too.
    assert.doesNotMatch(js, /setInterval\(/, 'the ring is driven by a timer');
    assert.match(js, /osc\.start\(from\)/, 'notes are not scheduled on the context clock');
  });

  await t.test('buzz for the same five seconds', () => {
    assert.match(js, /for \(let at = 0; at < ms; at \+= 620\) pattern\.push/,
      'the vibration is a single pulse rather than the full window');
  });

  await t.test('can be silenced, and dismissing the banner does it', () => {
    assert.match(js, /function stop\(\)/, 'a ringing alert cannot be stopped');
    assert.match(js, /banner\(title, body, \(\) => \{ if \(mine === ringSeq\) stop\(\); \}\)/,
      'closing the banner must stop the sound — it is the same interruption');
    assert.match(js, /navigator\.vibrate\(0\)/, 'stopping does not cancel the vibration');
  });

  await t.test('a second alert replaces the first rather than layering', () => {
    assert.match(js, /\/\/ A second alert replaces the first[\s\S]{0,40}stop\(\);/);
  });

  await t.test('ring again after the context has been suspended', () => {
    /* The reported failure: it sounded once and never again. An idle
       AudioContext gets suspended between alerts, and resume() is
       asynchronous — reading ctx.state on the line after a bare resume() call
       still says "suspended", so every later ring gave up before the context
       had come back. Measured in a browser: state is still 'suspended'
       immediately after an un-awaited resume(). */
    assert.match(js, /await ctx\.resume\(\)/,
      'resume() is not awaited — every alert after the first goes silent');
    assert.match(js, /if \(!ctx \|\| ctx\.state !== 'running'\) await unlock\(\)/,
      'ring() does not wait for the context to come back');
  });

  await t.test('keep the context from idling in the first place', () => {
    assert.match(js, /function keepAlive/, 'nothing stops the context suspending itself');
    assert.match(js, /gain\.gain\.value = 0;/, 'the keep-alive source must be silent');
    assert.match(js, /keeper = osc;\s*\/\/ deliberately never added to `ringing`/,
      'the keep-alive must not be killed by stop()');
  });

  await t.test('an older banner closing does not silence a newer alert', () => {
    /* The banner lives ten seconds and the ring five, so an alert raised
       eight seconds after another used to be cut off when the first banner
       timed out and called stop(). */
    assert.match(js, /const mine = \+\+ringSeq;/);
    assert.match(js, /if \(mine === ringSeq\) stop\(\)/,
      'any banner closing stops any ring, including a newer one');
  });

  await t.test('keep re-unlocking audio, not just on the first gesture', () => {
    /* The first gesture can land while the context is still suspended, and
       iOS suspends it again whenever the page is backgrounded. */
    assert.match(js, /'pointerdown', 'keydown', 'touchstart'/);
    assert.doesNotMatch(js, /unlock, \{ once: true/, 'audio unlocks only once');
    assert.match(js, /visibilitychange[\s\S]{0,120}unlock\(\)/,
      'a context suspended by backgrounding is never resumed');
  });

  await t.test('play at a normal listening level', () => {
    assert.match(js, /exponentialRampToValueAtTime\(0\.[34]/,
      'the alert should play at a normal listening level');
  });

  await t.test('never render an opponent’s name as markup', () => {
    assert.match(js, /\.textContent = title/);
    assert.match(js, /\.textContent = body/);
  });
});

/* ---------------------------------------------------------------- */
test('the alert does not depend on a socket frame arriving', async t => {
  const lobby = read('assets/js/battles.js');
  const room = read('assets/js/battle.js');

  await t.test('the lobby decides from the data it fetched', () => {
    assert.match(lobby, /announceChanges\(before, mine\)/,
      'the lobby only alerts on a socket payload');
    assert.doesNotMatch(lobby, /battle:updated', b => \{ announce\(b\)/,
      'the socket handler still owns the alert');
  });

  await t.test('the battle room decides from the data it fetched', () => {
    assert.match(room, /announceChange\(before, battle\)/,
      'the battle room only alerts on a socket payload');
  });

  await t.test('both refresh on a timer as well', () => {
    for (const [name, js] of [['battles.js', lobby], ['battle.js', room]]) {
      assert.match(js, /function startPolling/, `${name} has no polling fallback`);
      assert.match(js, /startPolling\(\)/, `${name} never starts polling`);
      assert.match(js, /document\.hidden/, `${name} polls a tab nobody is looking at`);
    }
  });

  await t.test('and refresh immediately when the tab comes back', () => {
    for (const [name, js] of [['battles.js', lobby], ['battle.js', room]]) {
      assert.match(js, /visibilitychange[\s\S]{0,120}load\(\)/,
        `${name} makes a returning player wait out the interval`);
    }
  });

  await t.test('never announce the same moment twice', () => {
    // Both the socket and the poll can notice the same change.
    assert.match(lobby, /announced\.has\(once\)/);
    assert.match(room, /announced\.has\('opponent'\)/);
    assert.match(room, /announced\.has\('started'\)/);
  });

  await t.test('stay silent about what happened before the page opened', () => {
    /* On the first load there is nothing to compare against; alerting there
       would ring for a battle the player has already seen. */
    assert.match(lobby, /if \(!wasById\.has\(b\.id\)\) continue;/);
    assert.match(room, /if \(!alerts \|\| !after \|\| !before\) return;/);
  });
});

/* ---------------------------------------------------------------- */
test('the game history screen', async t => {
  const js = read('assets/js/gamehistory.js');

  await t.test('hides a battle that was called off before it started', () => {
    /* Set a battle, cancel it, nothing happened. The stake went out and came
       straight back and there is no game to look at. */
    assert.match(js, /const isNoise = b => b\.status === 'cancelled' && !everStarted\(b\)/);
    assert.match(js, /all = list\.filter\(b => !isNoise\(b\)\)/,
      'the noise filter is never applied');
  });

  await t.test('keeps a cancellation that happened after the room code', () => {
    // Once the code is shared the two players were in a Ludo room; that
    // cancellation is a real event with a story behind it.
    assert.match(js, /const everStarted = b => !!\(b\.roomSetAt \|\| b\.roomCode\)/);
  });

  await t.test('shows the opening and closing balance on each row', () => {
    assert.match(js, /function balanceLine/);
    assert.match(js, /Opening/);
    assert.match(js, /Closing/);
    assert.match(js, /openingBalance/);
    assert.match(js, /closingBalance/);
  });

  await t.test('draws no balance line when the server could not compute one', () => {
    assert.match(js, /if \(!Number\.isFinite\(open\) \|\| !Number\.isFinite\(close\)\) return ''/,
      'a missing balance would render as ₹NaN');
  });

  await t.test('falls back to the plain list against an older server', () => {
    assert.match(js, /Api\.battles\.history\(\)/);
    assert.match(js, /Api\.battles\.mine\(\)/, 'no fallback if /history is not deployed yet');
  });
});

/* ---------------------------------------------------------------- */
test('the rules screen', async t => {
  const page = read('battles.html');
  const js = read('assets/js/battles.js');

  await t.test('states the fraud penalty', () => {
    assert.match(page, /गलत रिजल्ट डालता है या किसी भी प्रकार का फ्रॉड/);
    assert.match(page, /को 0/);
  });

  await t.test('covers every section that was asked for', () => {
    for (const heading of [
      'Game Exit करने पर',
      'रिजल्ट पोस्ट करने का समय',
      'गलत स्क्रीनशॉट पोस्ट करना',
      'गेम कैंसिल',
      'रिजल्ट पोस्ट करने के बाद बदलाव नहीं',
      'नेटवर्क समस्या',
      'Commission Rates',
    ]) {
      assert.ok(page.includes(heading), `the rules are missing "${heading}"`);
    }
  });

  await t.test('the exit penalties are stated exactly', () => {
    assert.match(page, /30% Loss/);
    assert.match(page, /100% Loss/);
  });

  await t.test('the reporting window is rendered, never hard-coded', () => {
    /* The sweeper decides this. Writing "15 मिनट" into the markup would let
       the promise and the enforcement drift apart silently. */
    assert.ok(page.includes('id="rule-grace"'), 'no element to render the window into');
    assert.match(js, /conf\.claimGraceMs \/ 60000/,
      'the window is not taken from the server');
  });

  await t.test('the commission table matches the published tiers', () => {
    assert.match(page, /50 से 500 तक/);
    assert.match(page, /500 से ज्यादा/);
    assert.match(js, /से ज्यादा`, pct\(tiers\.from\)/,
      'the table is not driven by the live rates');
  });

  await t.test('quotes 8% and 5%, the rate on the player’s own bet', () => {
    /* The static fallback shown before /api/config lands has to state the
       same tiers the server will send, or the table changes under the reader. */
    const table = page.slice(page.indexOf('Commission Rates'));
    assert.match(table, /50 से 500 तक[\s\S]{0,200}8%/);
    assert.match(table, /500 से ज्यादा[\s\S]{0,200}5%/);
  });

  await t.test('shows exactly the rate that is charged, with no conversion', () => {
    /* The stored rate is the share of one player's bet: the number taken and
       the number shown are the same number. Any factor between them is a way
       for the rules and the ledger to disagree — the rules would promise 8%
       while 16% (or 4%) came out of the pot. */
    assert.match(read('assets/js/battles.js'), /const pct = r => \(r \* 100\)/,
      'the rules table scales the stored rate before showing it');
    assert.match(read('assets/js/battle.js'), /commissionFor\(battle\.amount\) \* 100/,
      'the battle page scales the stored rate before showing it');
  });

  await t.test('says the rate is on your own bet, not on the pot', () => {
    // 8% of a stake and 4% of the pot are the same money; saying which one
    // the number refers to is what stops it reading as double.
    assert.match(page, /कमीशन आपकी अपनी बेट राशि पर लगता है, दोनों की कुल राशि पर नहीं/);
    // The built page writes the rupee sign as &#8377;, so match around it.
    assert.match(page, /500 बनाम [^<]{0,20}500[\s\S]{0,160}8%[\s\S]{0,80}40 कमीशन/,
      'the worked example should show the actual rupees taken');
  });
});

/* ---------------------------------------------------------------- */
test('the commission tiers players are shown', async t => {
  const app = read('assets/js/app.js');

  await t.test('the browser agrees with the server on the boundary', () => {
    /* "50 से 500 तक — 5%" puts the threshold on the higher tier. If the
       client used `<` the advertised prize for a ₹500 battle would be ₹975
       and the paid prize ₹960 — a number that is wrong on the busiest stake
       on the board. */
    assert.match(app, /Number\(amount\) <= threshold \? t\.under : t\.from/);
    assert.match(app, /under: 0\.08, from: 0\.05/);
  });

  await t.test('the prize shown is the prize paid — one stake, not the pot', () => {
    /* The two formulas must be the same shape. `2 * (1 - rate)` charges the
       rate against both stakes and advertises a prize ₹40 below what the
       server actually pays on a ₹500 battle. */
    assert.match(app, /Math\.round\(amount \* \(2 - commissionFor\(amount\)\)\)/,
      'the browser charges commission on the pot, not on one stake');
    assert.doesNotMatch(app, /amount \* 2 \* \(1 - commissionFor/,
      'the old pot-based formula is still in the browser');

    const config = read('server/src/lib/config.js');
    assert.match(config, /Math\.round\(amount \* \(2 - commission\)\)/,
      'the server no longer matches the browser');
  });

  await t.test('the server publishes the above-threshold rate from past it', () => {
    const index = read('server/src/index.js');
    assert.match(index, /commissionFor\(s\.commission_threshold \+ 1, s\)/,
      'sampling at the threshold now returns the *under* rate, not the above one');
  });
});

/* ---------------------------------------------------------------- */
test('the interface speaks Hindi by default', async t => {
  const js = read('assets/js/i18n.js');

  await t.test('defaults to hi', () => {
    assert.match(js, /const DEFAULT_LANG = 'hi';/);
    assert.match(js, /localStorage\.getItem\(LANG_KEY\) \|\| DEFAULT_LANG/);
  });

  await t.test('leaves already-Hindi copy alone', () => {
    /* The rules keep some English on purpose — Game Exit, Win, Live Chat,
       Cancel. Word-by-word translation turned "गेम को सीधा Cancel कर दिया
       जायेगा" into "सीधा रद्द करें कर दिया जायेगा", which is nonsense on a
       screen players are meant to take seriously. */
    assert.match(js, /const isProtected = node =>/);
    assert.match(js, /closest\('\[data-no-i18n\]'\)/);
    assert.match(js, /if \(isProtected\(node\)\) return NodeFilter\.FILTER_REJECT/,
      'the tree walker still descends into protected copy');
    assert.match(js, /if \(isProtected\(node\)\) continue;/,
      'the mutation observer still rewrites protected copy');
    assert.ok(read('battles.html').includes('data-no-i18n'),
      'the rules card is not marked as already translated');
  });

  await t.test('a stored choice still wins', () => {
    // Switching to English has to stick, or the toggle is decorative.
    assert.ok(js.indexOf("localStorage.getItem(LANG_KEY) ||") < js.indexOf("DEFAULT_LANG;") + 200);
    assert.match(js, /localStorage\.setItem\(LANG_KEY, next\)/);
  });
});

/* ---------------------------------------------------------------- */
test('the moment animations', async t => {
  const anim = read('assets/js/anim.js');

  await t.test('every moment has a preset', () => {
    for (const kind of ['win', 'deposit', 'withdraw', 'start', 'code', 'loss']) {
      assert.match(anim, new RegExp(`\\b${kind}:\\s*\\{`), `no preset for "${kind}"`);
    }
  });

  await t.test('they all share one loop, not one effect each', () => {
    /* The whole point of the refactor: adding a moment costs a line of
       config. More than one requestAnimationFrame loop in here means the
       effects have started diverging. */
    assert.equal((anim.match(/requestAnimationFrame\(draw\)/g) || []).length, 1);
    assert.equal((anim.match(/document\.createElement\('canvas'\)/g) || []).length, 1);
  });

  await t.test('the canvas is removed when the burst ends', () => {
    // Otherwise every deposit leaves a full-screen element behind.
    assert.match(anim, /else canvas\.remove\(\);/);
  });

  await t.test('does nothing when motion is reduced or the tab is hidden', () => {
    assert.match(anim, /if \(reduce \|\| document\.hidden\) return;/,
      'a backgrounded tab would queue frames it cannot draw');
  });

  await t.test('an unknown moment is a no-op, not a crash', () => {
    /* These fire in the middle of a payout and a deposit; a typo at a call
       site must not throw there. */
    assert.match(anim, /const p = PRESETS\[kind\];\s*\n\s*if \(!p\) return;/);
  });

  await t.test('each themed moment has the scene that was asked for', () => {
    assert.match(anim, /start:\s*\{ scene: board/, 'start should show the Ludo board');
    assert.match(anim, /code:\s*\{ scene: digits/, 'the code should show its digits');
    assert.match(anim, /loss:\s*\{ scene: sadFace/, 'a loss should show the sad face');
    assert.match(anim, /withdraw:.*shape: 'note'/, 'a withdrawal should show money, not coins');
  });

  await t.test('the board is a real Ludo board — four homes, four goti', () => {
    assert.match(anim, /const board = \(\) =>/);
    assert.match(anim, /const LUDO = \['#e33d3d', '#28a745', '#f0b429', '#2d68c4'\]/,
      'the goti must use the board colours');
    assert.match(anim, /class="kb-goti"/);
    assert.match(anim, /homes\.map/);
  });

  await t.test('the room code digits each get their own colour', () => {
    assert.match(anim, /\[\.\.\.code\]\.map\(\(ch, i\) =>/);
    assert.match(anim, /color:\$\{LUDO\[i % LUDO\.length\]\}/);
    // Staggered, so they land one at a time rather than all at once.
    assert.match(anim, /animation-delay:\$\{i \* 80\}ms/);
  });

  await t.test('a code scene with no code renders nothing', () => {
    // mark('code') can only pass what the battle actually has.
    assert.match(anim, /if \(!code\) return '';/);
  });

  await t.test('the tears fall from the face, not from the top of the screen', () => {
    assert.match(anim, /shape: 'tear'.*atY: 0\.44/);
    assert.match(anim, /o\.atY != null \? innerHeight \* o\.atY/);
  });

  await t.test('the scenes are CSS, not a second animation loop', () => {
    /* The whole cost argument rests on this: the browser composites the
       scenes, the JS only builds markup and sets a timer. */
    assert.match(anim, /stage\.className = 'kb-stage'/);
    assert.match(anim, /setTimeout\(\) => stage\.remove\(\), 400\)|stage\.remove\(\), 400\)/,
      'the stage must be removed after it plays');
    for (const cls of ['kb-stage', 'kb-scene', 'kb-board', 'kb-goti', 'kb-digit', 'kb-sad']) {
      assert.ok(read('assets/css/app.css').includes(cls), `${cls} was purged from the stylesheet`);
    }
  });

  await t.test('the win burst is unchanged from the confetti it replaced', () => {
    assert.match(anim, /win:\s*\{ n: 200/, 'the win moment should look exactly as it did');
  });

  await t.test('no new dependency, no always-on loop', () => {
    assert.doesNotMatch(anim, /import |require\(/, 'the animations must stay self-contained');
    assert.doesNotMatch(anim, /setInterval/, 'nothing here should run continuously');
  });
});

/* ---------------------------------------------------------------- */
test('where the moment animations fire', async t => {
  await t.test('a deposit request', () => {
    const js = read('assets/js/addcash.js');
    assert.match(js, /KhelbroAnim\.celebrate\('deposit'\)/);
    // After the server accepted it, never before.
    assert.ok(js.indexOf('Api.wallet.depositRequest') < js.indexOf("celebrate('deposit')"));
  });

  await t.test('a withdrawal request', () => {
    const js = read('assets/js/withdraw.js');
    assert.match(js, /KhelbroAnim\.celebrate\('withdraw'\)/);
    assert.ok(js.indexOf('Api.wallet.withdraw(payload)') < js.indexOf("celebrate('withdraw')"));
  });

  await t.test('starting the match, and receiving the code', () => {
    const js = read('assets/js/battle.js');
    assert.match(js, /mark\('start'\)/, 'the host setting the room code');
    assert.match(js, /mark\('code', \{ text: after\.roomCode \}\)/,
      'the opponent receiving it — and the scene needs the digits to show');
    assert.ok(js.indexOf('Api.battles.setRoom') < js.indexOf("mark('start')"));
  });

  await t.test('winning, and losing', () => {
    const js = read('assets/js/battle.js');
    assert.match(js, /if \(iWon\) mark\('win'\)/);
    assert.match(js, /inBattle && battle\.status === 'completed'\) mark\('loss'\)/,
      'a loss should not fire on a cancellation, a dispute, or for an onlooker');
  });

  await t.test('each moment fires once, however often the page re-renders', () => {
    /* render() runs on every refresh and every socket update; without the
       guard a settled battle would replay its animation on each one. */
    const js = read('assets/js/battle.js');
    assert.match(js, /const marked = new Set\(\);/);
    assert.match(js, /if \(marked\.has\(kind\)\) return;/);
  });

  await t.test('a missing anim.js never breaks the action', () => {
    for (const f of ['addcash.js', 'withdraw.js', 'battle.js']) {
      assert.match(read(`assets/js/${f}`), /window\.KhelbroAnim && KhelbroAnim\.celebrate/,
        `${f} calls the animation without checking it loaded`);
    }
  });
});

/* ---------------------------------------------------------------- */
test('the admin alerts inbox', async t => {
  const page = read('admin.html');
  const js = read('assets/js/admin.js');

  await t.test('has a tab, on desktop and on mobile', () => {
    assert.ok(page.includes('data-tab="alerts"'), 'no Alerts chip');
    assert.ok(page.includes('<option value="alerts">'), 'the mobile section list omits it');
    assert.ok(page.includes('id="tab-alerts"') && page.includes('id="alerts"'));
  });

  await t.test('every row carries where to go and how to filter', () => {
    assert.match(js, /data-inbox-tab=/, 'rows do not say which tab they belong to');
    assert.match(js, /data-inbox-filter=/, 'rows cannot narrow the tab they open');
    assert.match(js, /if \(to === 'deposits'\) syncDepStatus\(filter\)/,
      'a deposit row must land on the pending queue, not on "all"');
  });

  await t.test('the inbox row is handled before the plain tab chip', () => {
    /* Both match [data-tab]-style handling; if the generic chip handler ran
       first it would swallow the row and drop the pending filter. */
    assert.ok(js.indexOf("t.closest('[data-inbox-tab]')") < js.indexOf("t.closest('[data-tab]')"));
  });

  await t.test('rings only when a queue actually grows', () => {
    assert.match(js, /\.filter\(k => \(c\[k\] \|\| 0\) > \(lastCounts\[k\] \|\| 0\)\)/,
      'the ring is not driven by a rise in the queues');
    assert.match(js, /if \(lastCounts\) \{/,
      'the first poll must not ring for a backlog that was already there');
  });

  await t.test('rings per queue, not on the total', () => {
    /* One deposit approved and one arriving in the same window leaves the
       total unchanged, and the new one still needs somebody. */
    assert.match(js, /'deposits', 'withdrawals', 'disputes', 'kyc', 'chat'/);
  });

  await t.test('an operator can turn the sound off', () => {
    assert.ok(page.includes('id="alert-sound"'));
    assert.match(js, /\$\('#alert-sound'\)\.checked/);
  });

  await t.test('polls on its own, not only when Auto is ticked', () => {
    assert.match(js, /function watchInbox/, 'the inbox has no heartbeat');
    assert.match(js, /watchInbox\(\);/, 'the heartbeat is never started');
    assert.match(js, /if \(document\.hidden \|\| !TOKEN\) return;/,
      'it polls a hidden tab, or one with no session');
  });

  await t.test('forgets its baseline on sign-out', () => {
    // Otherwise signing back in rings for the backlog that was already there.
    assert.match(js, /lastCounts = null;/);
    assert.match(js, /clearInterval\(inboxTimer\)/, 'the heartbeat outlives the session');
  });

  await t.test('the queue badges come from the inbox, not the ranged stats', () => {
    /* /admin/stats is scoped to the selected range, so a deposit still
       pending from last week vanished from the badge on "1 day". */
    assert.match(js, /setCount\('deposits', c\.deposits \|\| 0\)/);
    assert.doesNotMatch(js, /setCount\('deposits', s\.deposits\.pending\)/,
      'the ranged stat still writes the deposits badge');
    assert.doesNotMatch(js, /setCount\('kyc', s\.kycPending\)/,
      'the ranged stat still writes the KYC badge');
  });

  await t.test('loads the alert script so it can actually ring', () => {
    assert.match(page, /<script src="assets\/js\/alert\.js"/, 'admin.html cannot make a sound');
    assert.ok(page.indexOf('assets/js/alert.js') < page.indexOf('assets/js/admin.js'),
      'alert.js must load before admin.js uses it');
  });
});

/* ---------------------------------------------------------------- */
test('the admin settings panel', async t => {
  const js = read('assets/js/admin.js');
  const page = read('admin.html');

  await t.test('has a field for every configurable rule', () => {
    /* Either passed to a field helper, which templates the binding, or bound
       inline. Both end up as [data-set=key], which is what the save handler
       collects. */
    for (const key of ['commission_under', 'commission_from', 'commission_threshold',
                       'referral_rate', 'signup_bonus', 'referral_bonus',
                       'withdraw_open', 'deposit_open', 'battle_limit']) {
      const bound = js.includes(`'${key}'`) || js.includes(`data-set="${key}"`);
      assert.ok(bound, `the settings panel has no control for ${key}`);
    }
  });

  await t.test('says the number typed is the number players see', () => {
    assert.match(js, /A percentage of ONE player’s bet/);
    assert.match(js, /there is no conversion in between/);
    assert.match(js, /8 → a ₹500 v ₹500 battle: ₹40 taken, winner gets ₹960/);
    assert.match(js, /5 → a ₹1,000 v ₹1,000 battle: ₹50 taken, winner gets ₹1,950/);
  });

  await t.test('takes rates as percentages and stores them as fractions', () => {
    // An admin typing "5" into a fraction field would set a 500% commission.
    assert.match(js, /data-scale="100"/, 'percentage fields are not marked for conversion');
    assert.match(js, /raw \/ scale/, 'the conversion never happens on save');
    assert.match(js, /pctOf/, 'stored fractions are not shown back as percentages');
  });

  await t.test('refuses to save a field that is not a number', () => {
    assert.match(js, /Enter a valid number for/);
  });

  await t.test('mounts where the console expects it', () => {
    assert.ok(page.includes('id="settings"'));
    assert.ok(page.includes('data-tab="settings"'));
  });
});

/* ---------------------------------------------------------------- */
test('the sign-in page has all four steps', async t => {
  const page = read('login.html');
  const js = read('assets/js/login.js');

  await t.test('phone, password, OTP and password setup', () => {
    for (const id of ['step-phone', 'step-password', 'step-otp', 'step-setpw']) {
      assert.ok(page.includes(`id="${id}"`), `login.html is missing #${id}`);
    }
  });

  await t.test('asks the server which door to open', () => {
    assert.match(js, /Api\.auth\.check\(phone\)/);
    assert.match(js, /hasPassword\) goToPassword\(\)/);
  });

  await t.test('forces the setup step after a first OTP sign-in', () => {
    assert.match(js, /goToSetPassword\(\)/);
  });

  await t.test('shows who referred you, with no way to remove them', () => {
    /* Arriving through someone's link settles who referred you. The banner
       states it; there is no Remove, and the manual code box is hidden once a
       code is applied, so there is no second way round either. */
    assert.ok(page.includes('id="ref-referrer-name"'), 'the referrer name is not shown');
    assert.ok(page.includes('id="ref-badge-code"'), 'the referral code is not shown');
    assert.ok(!page.includes('id="ref-remove-btn"'), 'the Remove button is still there');
    assert.doesNotMatch(js, /ref-remove-btn/, 'login.js still wires a Remove button');
    assert.doesNotMatch(js, /function removeReferral/, 'dead removal code was left behind');
    assert.match(js, /manual-ref-container'\)\.classList\.add\('hidden'\)/,
      'the manual code box must hide once a referral is applied');
  });

  await t.test('keeps an OTP route for a forgotten password', () => {
    assert.ok(page.includes('id="use-otp"'), 'no way back in without the password');
    assert.match(js, /resettingPassword = true/);
  });

  await t.test('finishes an interrupted setup on the next visit', () => {
    assert.match(js, /hasPassword !== false/,
      'someone who closed the tab mid-setup would stay on the OTP path forever');
  });

  await t.test('wires the setup form before deciding to show it', () => {
    /* The routing used to return early and skip every binding below it, so
       the setup form rendered with no submit handler: Save reloaded the page
       and the password was never stored. */
    const bind = js.indexOf("$('#setpw-form').addEventListener");
    const route = js.lastIndexOf('goToSetPassword();');
    assert.ok(bind > -1 && route > -1, 'expected both the binding and the routing');
    assert.ok(bind < route,
      'the setup step is shown before its submit handler is bound — Save would do nothing');
  });
});

/* ---------------------------------------------------------------- */
test('no page states a commission the settings can change', async () => {
  /* The rate is an admin setting and depends on the stake, so a hardcoded
     percentage in the copy is wrong the moment anyone touches the panel. */
  for (const page of ['battle.html', 'battles.html']) {
    assert.doesNotMatch(read(page), /\b5% commission\b/, `${page} states a fixed 5% commission`);
    assert.doesNotMatch(read(page), /minus a 5% commission/, `${page} states a fixed 5% commission`);
  }
  assert.match(read('assets/js/battle.js'), /K\.commissionFor\(battle\.amount\)/,
    'the battle page should read the live rate');
});
