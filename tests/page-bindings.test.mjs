/* ============================================================
   Page scripts against the pages that load them.

   Every `$('#id')` in a page script must resolve on at least one
   page that includes that script. A missing element is not a
   cosmetic problem: `$('#x').textContent = ...` throws, and when
   it happens on the first line of a submit handler — as it did
   with #proof-status — the action never runs at all.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — the repo path contains a space.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

/* Elements a script creates at runtime rather than finding in the markup. */
const CREATED_AT_RUNTIME = new Set(['live-dot']);

/** Which pages load each assets/js/<name>.js. */
function scriptOwners() {
  const owners = {};
  for (const page of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {
    for (const m of read(page).matchAll(/<script src="assets\/js\/([a-z0-9-]+)\.js"/g)) {
      (owners[m[1]] ??= []).push(page);
    }
  }
  return owners;
}

const owners = scriptOwners();

test('page scripts only reference elements their pages contain', async t => {
  assert.ok(Object.keys(owners).length > 5, 'expected to find the page scripts');

  for (const [script, pages] of Object.entries(owners)) {
    const file = `assets/js/${script}.js`;
    if (!fs.existsSync(path.join(root, file))) continue;

    await t.test(`${file} → ${pages.join(', ')}`, () => {
      const js = read(file);
      const ids = new Set([...js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]));
      const html = pages.map(read).join('\n');

      const missing = [...ids]
        .filter(id => !CREATED_AT_RUNTIME.has(id))
        .filter(id => !html.includes(`id="${id}"`))
        // Name the write, since those are the ones that throw.
        .map(id => {
          const writes = new RegExp(`\\$\\('#${id}'\\)\\.(textContent|innerHTML|value|src|checked|disabled|hidden)\\s*=`).test(js);
          return writes ? `#${id} (assigned to — would throw)` : `#${id}`;
        });

      assert.deepEqual(missing, [], `${file} references elements no page defines`);
    });
  }
});

test('the screenshot status line the submit handler needs exists', () => {
  // Regression guard for the reported crash: submitting a win writes this
  // element before uploading, and threw again from inside its own catch.
  assert.ok(read('battle.html').includes('id="proof-status"'),
    'battle.html must define #proof-status');
  assert.ok(!/\$\('#proof-status'\)\.textContent\s*=/.test(read('assets/js/battle.js')),
    'battle.js must not dereference #proof-status directly');
});

test('built pages stay in sync with their templates', async t => {
  // build.py generates the root pages from src/pages; a template edit that was
  // never rebuilt would ship the old markup.
  for (const src of fs.readdirSync(path.join(root, 'src/pages')).filter(f => f.endsWith('.html'))) {
    if (!fs.existsSync(path.join(root, src))) continue;
    await t.test(src, () => {
      const body = read(`src/pages/${src}`);
      const built = read(src);
      // Every element id declared in the template must survive into the build.
      for (const m of body.matchAll(/id="([a-zA-Z0-9_-]+)"/g)) {
        assert.ok(built.includes(`id="${m[1]}"`), `${src} is missing #${m[1]} — run \`npm run pages\``);
      }
    });
  }
});
