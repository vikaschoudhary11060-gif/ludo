/* ============================================================
   Request warming.

   Page scripts issue their own first GET at script-evaluation
   time instead of waiting inside K.ready behind /api/auth/me and
   /api/config — two documents they do not depend on. On this API
   host one round trip costs the better part of a second, so that
   wait was the single largest cost of opening a page.

   The optimisation is only safe if warming is invisible: the
   first consumer gets the warmed response, and every consumer
   after it gets a fresh request. A poll, a socket update or a
   refetch after an action must never be handed a body that was
   fetched before the thing it is refetching to see.

   These tests run the real warm() out of assets/js/api.js, and
   the real fallback expression the page scripts use.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — the repo path contains a space.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(root + 'assets/js/api.js', 'utf8');

/** Lift warm() and its TTL out of the shipped file, so these test the code
    that actually runs rather than a copy that can drift from it. */
function loadWarm() {
  const ttl = source.match(/const WARM_TTL_MS = (\d+);/);
  const fn = source.match(/\n {2}function warm\(fn\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(ttl, 'WARM_TTL_MS not found in api.js');
  assert.ok(fn, 'warm() not found in api.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${ttl[0]}\n${fn[0]}\nreturn warm;`)();
}

const warm = loadWarm();

/** Source with comments removed, for rules that are about code rather than
    prose. Good enough for this repo's style: no regex literal here contains a
    sequence that would be mistaken for a comment opener. */
const stripComments = js => js
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A stand-in request function that counts calls and can be made to fail. */
function counted(result = { ok: true }) {
  const calls = [];
  const fn = () => {
    calls.push(Date.now());
    return typeof result === 'function' ? result(calls.length) : Promise.resolve(result);
  };
  fn.calls = calls;
  return fn;
}

test('warming issues the request immediately', async t => {
  await t.test('fires once at warm time, before anybody asks', () => {
    const fn = counted();
    warm(fn);
    assert.equal(fn.calls.length, 1, 'the whole point is that it is already in flight');
  });

  await t.test('hands the in-flight response to the first caller', async () => {
    const body = { battles: [1, 2, 3] };
    const fn = counted(body);
    const get = warm(fn);
    assert.deepEqual(await get(), body);
    assert.equal(fn.calls.length, 1, 'the first caller must not open a second request');
  });
});

test('warming is invisible to every caller after the first', async t => {
  await t.test('the second call goes to the network', async () => {
    const fn = counted();
    const get = warm(fn);
    await get();
    await get();
    assert.equal(fn.calls.length, 2, 'a refetch was served the warmed body');
  });

  await t.test('a poll never sees a body older than the poll', async () => {
    /* The lobby refetches every few seconds and after every action. Serving
       any of those from the warm would show a board from before the action. */
    let n = 0;
    const fn = () => Promise.resolve({ generation: ++n });
    const get = warm(fn);
    assert.equal((await get()).generation, 1);
    assert.equal((await get()).generation, 2);
    assert.equal((await get()).generation, 3);
  });

  await t.test('a warm too old to still be current is discarded', async () => {
    const ttl = Number(source.match(/const WARM_TTL_MS = (\d+);/)[1]);
    const fn = counted();
    const get = warm(fn);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + ttl + 1;
      await get();
    } finally {
      Date.now = realNow;
    }
    assert.equal(fn.calls.length, 2, 'a stale warm was served instead of refetching');
  });
});

test('warming never breaks the page it is speeding up', async t => {
  await t.test('a rejection reaches the caller unchanged', async () => {
    const boom = new Error('Cannot reach the server. Check your connection.');
    const get = warm(() => Promise.reject(boom));
    await assert.rejects(() => get(), e => e === boom,
      'the caller must see the same failure it would have seen');
  });

  await t.test('an unclaimed rejection does not go unhandled', async () => {
    /* A warm nobody consumes — a signed-out visitor on a page that warms an
       authenticated call — must not surface as an unhandled rejection and
       take down the console. */
    const seen = [];
    const onUnhandled = e => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    warm(() => Promise.reject(new Error('nobody claims me')));
    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(seen, []);
  });

  await t.test('a function that throws synchronously still works when called', async () => {
    let first = true;
    const fn = () => {
      if (first) { first = false; throw new Error('boom at warm time'); }
      return Promise.resolve({ ok: true });
    };
    const get = warm(fn);           // must not throw out of the page script
    assert.deepEqual(await get(), { ok: true });
  });
});

test('the page scripts degrade when api.js is a version behind', async t => {
  /* The service worker keeps api.js in its cached shell and serves it
     stale-while-revalidate, so for one navigation after a deploy a fresh page
     script can be paired with the previous api.js — one that has no warm().
     Every warmed script guards for that. */
  const guarded = ['battles', 'battle', 'waitingroom', 'gamehistory',
                   'transactions', 'notifications', 'refer'];

  for (const name of guarded) {
    await t.test(`${name}.js guards against a warm-less api.js`, () => {
      const js = fs.readFileSync(`${root}assets/js/${name}.js`, 'utf8');
      assert.match(js, /const warm = \(window\.Api && Api\.warm\) \|\| \(fn => fn\);/,
        'this page would throw "Api.warm is not a function" during an update');
      assert.doesNotMatch(js, /Api\.warm\(/,
        'a direct Api.warm() call bypasses the guard');
    });
  }

  await t.test('the fallback behaves exactly as the page did before warming', async () => {
    const fallback = (fn => fn);            // what the guard resolves to
    const fn = counted();
    const get = fallback(fn);
    assert.equal(fn.calls.length, 0, 'nothing should be issued at evaluation time');
    await get();
    assert.equal(fn.calls.length, 1);
    await get();
    assert.equal(fn.calls.length, 2, 'every call is its own request, as before');
  });
});

test('config is fetched once per page, as its comment promises', async t => {
  /* app.js memoises /api/config and every page script is supposed to go
     through that. Three did not, and on the lobby the duplicate queued behind
     the original on the API host and pushed the battle list a full round trip
     later than it needed to be. */
  const scripts = fs.readdirSync(`${root}assets/js`)
    .filter(f => f.endsWith('.js') && f !== 'admin.js' && f !== 'api.js' && f !== 'app.js');

  for (const name of scripts) {
    await t.test(`${name} does not open its own /api/config`, () => {
      const js = fs.readFileSync(`${root}assets/js/${name}`, 'utf8');
      // The rule is about code. A comment may name Api.config() to explain why
      // it is not used, and that must not read as a violation.
      assert.doesNotMatch(stripComments(js), /Api\.config\(\)/,
        'use K.config() — the shared fetch that is already in flight from boot');
    });
  }
});
