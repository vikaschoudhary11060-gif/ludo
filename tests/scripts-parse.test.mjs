/* ============================================================
   Every shipped script must parse.

   A syntax error in a page script is silent and total: the file
   never executes, so nothing it was going to reveal is revealed
   and the page renders as an empty shell under the header. That
   is exactly how the withdraw page went blank — a lost `try {`
   left a dangling `catch`, and the whole file stopped running.

   Cheap to check, and it fails loudly the moment it happens.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — the repo path contains a space.
const root = fileURLToPath(new URL('..', import.meta.url));

const scripts = fs.readdirSync(path.join(root, 'assets/js'))
  .filter(f => f.endsWith('.js'))
  .sort();

test('every browser script parses', async t => {
  assert.ok(scripts.length > 10, 'expected to find the page scripts');

  for (const name of scripts) {
    await t.test(name, () => {
      const file = path.join(root, 'assets/js', name);
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (e) {
        const detail = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n');
        assert.fail(`assets/js/${name} does not parse — the whole file would never run:\n${detail}`);
      }
    });
  }
});

test('no script has a catch without a try', async () => {
  /* The specific shape that broke the withdraw page: an await left at one
     indent level deeper than its neighbours because the `try {` above it was
     removed, and a `} catch` with nothing opening it. `node --check` catches
     this too; naming it here is what makes the failure legible. */
  for (const name of scripts) {
    const js = fs.readFileSync(path.join(root, 'assets/js', name), 'utf8');
    const tries = (js.match(/(^|[^.\w])try\s*\{/g) || []).length;
    const catches = (js.match(/\}\s*catch\b/g) || []).length;
    assert.ok(catches <= tries,
      `assets/js/${name} has ${catches} catch blocks but only ${tries} try blocks`);
  }
});
