/* ============================================================
   Game history.

   Two promises:
     - a battle that was set and called off before a room code
       existed is not history, it is noise
     - every game that IS history shows what the wallet held
       before it and after it
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, walletOf, fake } from './helpers/api-harness.mjs';

const api = await startApi({ auth: true, battles: true });
test.after(() => api.stop());

const reset = async () => { fake.reset(); await seedSettings(); };
const buckets = async id => { const w = await walletOf(id); return [w.deposit, w.winnings]; };

async function twoPlayers(start = { deposit: 5000, winnings: 5000 }) {
  const host = await seedUser({ phone: '9800000001', name: 'Host', ...start });
  const guest = await seedUser({ phone: '9800000002', name: 'Guest', ...start });
  return { host, guest };
}
async function toWaiting(host, guest, amount) {
  const id = (await api.post('/api/battles', { mode: 'lite', amount }, host.token)).body.battle.id;
  await api.post(`/api/battles/${id}/accept`, {}, guest.token);
  await api.post(`/api/battles/${id}/accept-request`, {}, host.token);
  return id;
}
const history = who => api.get('/api/battles/history', who.token);

/* ---------------------------------------------------------------- */
test('which games belong in the history', async t => {
  t.beforeEach(reset);

  await t.test('a battle called off before a room code is still returned, and flagged as such', async () => {
    /* The server returns everything; the page hides the noise. Keeping the
       decision on the client means the raw record is never lost. */
    const { host } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 500 }, host.token)).body.battle.id;
    await api.post(`/api/battles/${id}/cancel`, { reason: 'changed_mind' }, host.token);

    const { body } = await history(host);
    const b = body.battles.find(x => x.id === id);
    assert.equal(b.status, 'cancelled');
    assert.equal(b.roomSetAt, null, 'no room code was ever shared');
    assert.equal(b.roomCode, null);
  });

  await t.test('a battle cancelled after the room code keeps its marker', async () => {
    const { host, guest } = await twoPlayers();
    const id = await toWaiting(host, guest, 500);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'cancel' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'cancel' }, guest.token);

    const { body } = await history(host);
    const b = body.battles.find(x => x.id === id);
    assert.equal(b.status, 'cancelled');
    assert.ok(b.roomSetAt > 0, 'the room stamp must survive cancellation, or the page cannot tell them apart');
    assert.equal(b.roomCode, '12345678');
  });

  await t.test('only the caller’s own games', async () => {
    const { host, guest } = await twoPlayers();
    const other = await seedUser({ phone: '9800000003', deposit: 5000 });
    await api.post('/api/battles', { mode: 'lite', amount: 500 }, host.token);
    await api.post('/api/battles', { mode: 'lite', amount: 700 }, other.token);

    const { body } = await history(guest);
    assert.deepEqual(body.battles, [], 'a player with no games should see none');
    assert.equal((await history(other)).body.battles.length, 1);
  });

  await t.test('needs a session', async () => {
    assert.equal((await api.get('/api/battles/history')).status, 401);
  });
});

/* ---------------------------------------------------------------- */
test('opening and closing balance', async t => {
  t.beforeEach(reset);

  await t.test('a won battle: staked out, prize in', async () => {
    const { host, guest } = await twoPlayers({ deposit: 5000, winnings: 0 });
    const id = await toWaiting(host, guest, 500);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/p.png' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'lost' }, guest.token);

    const b = (await history(host)).body.battles.find(x => x.id === id);
    assert.equal(b.openingBalance, 5000, 'the wallet before the game');
    // ₹500 staked, ₹960 won back (pot ₹1,000 less 8% of one ₹500 stake).
    assert.equal(b.closingBalance, 5460);
    assert.equal(b.closingBalance - b.openingBalance, 460);
  });

  await t.test('a lost battle: staked out, nothing back', async () => {
    const { host, guest } = await twoPlayers({ deposit: 5000, winnings: 0 });
    const id = await toWaiting(host, guest, 500);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/p.png' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'lost' }, guest.token);

    const b = (await history(guest)).body.battles.find(x => x.id === id);
    assert.equal(b.openingBalance, 5000);
    assert.equal(b.closingBalance, 4500);
  });

  await t.test('a cancelled battle comes back to where it started', async () => {
    const { host } = await twoPlayers({ deposit: 1000, winnings: 1000 });
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;
    await api.post(`/api/battles/${id}/cancel`, { reason: 'changed_mind' }, host.token);

    const b = (await history(host)).body.battles.find(x => x.id === id);
    assert.equal(b.openingBalance, 2000);
    assert.equal(b.closingBalance, 2000, 'a refund must land the wallet exactly where it began');
  });

  await t.test('the closing balance of one game is the opening of the next', async () => {
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const played = [];
    for (const amount of [100, 200, 300]) {
      const id = await toWaiting(host, guest, amount);
      await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
      await api.post(`/api/battles/${id}/result`, { claim: 'lost' }, host.token);
      await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/p.png' }, guest.token);
      played.push(id);
    }
    const byId = Object.fromEntries((await history(host)).body.battles.map(b => [b.id, b]));
    for (let i = 1; i < played.length; i++) {
      assert.equal(byId[played[i]].openingBalance, byId[played[i - 1]].closingBalance,
        `game ${i} does not start where game ${i - 1} ended`);
    }
    assert.equal(byId[played[0]].openingBalance, 10000);
  });

  await t.test('the closing balance of the newest game is the wallet now', async () => {
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const id = await toWaiting(host, guest, 500);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/p.png' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'lost' }, guest.token);

    const [dep, win] = await buckets(host.id);
    const b = (await history(host)).body.battles.find(x => x.id === id);
    assert.equal(b.closingBalance, dep + win,
      'the reconstruction is anchored on the current wallet, so this must be exact');
  });

  await t.test('counts both wallets, since that is the balance a player sees', async () => {
    const { host } = await twoPlayers({ deposit: 1000, winnings: 1000 });
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 1500 }, host.token)).body.battle.id;
    const b = (await history(host)).body.battles.find(x => x.id === id);
    assert.equal(b.openingBalance, 2000, 'cash and winnings together');
    assert.equal(b.closingBalance, 500);
  });

  await t.test('deposits and withdrawals between games move the balance', async () => {
    const { host, guest } = await twoPlayers({ deposit: 1000, winnings: 0 });
    const first = await toWaiting(host, guest, 100);
    await api.post(`/api/battles/${first}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${first}/result`, { claim: 'lost' }, host.token);
    await api.post(`/api/battles/${first}/result`, { claim: 'won', proof: '/p.png' }, guest.token);

    // An admin credits the wallet between the two games.
    const { credit } = await import('../server/src/lib/db.js');
    await credit(host.id, 'deposit', 5000, 'Deposit verified (UTR X)');

    const second = (await api.post('/api/battles', { mode: 'lite', amount: 200 }, host.token)).body.battle.id;
    const byId = Object.fromEntries((await history(host)).body.battles.map(b => [b.id, b]));
    assert.equal(byId[first].closingBalance, 900);
    assert.equal(byId[second].openingBalance, 5900, 'the deposit between games must be reflected');
  });

  await t.test('says nothing rather than guessing when a game has no ledger rows', async () => {
    /* A join request that was never accepted takes no stake, so there is
       nothing to compute a balance from. */
    const { host, guest } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 500 }, host.token)).body.battle.id;
    await api.post(`/api/battles/${id}/accept`, {}, guest.token);

    const b = (await history(guest)).body.battles.find(x => x.id === id);
    assert.equal(b.openingBalance, null);
    assert.equal(b.closingBalance, null);
  });

  await t.test('a rejected withdrawal does not distort the history', async () => {
    /* Rejecting re-credits the wallet and marks the debit `failed` — no
       second row is written. Counting the failed debit would show every
       earlier game at a balance that never existed. */
    const { host, guest } = await twoPlayers({ deposit: 0, winnings: 5000 });
    const id = await toWaiting(host, guest, 500);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/p.png' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'lost' }, guest.token);

    // A withdrawal that was raised and then rejected.
    await fake.col('transactions').insertOne({
      id: await fake.nextId('transactions'), user_id: host.id, type: 'debit', bucket: 'winnings',
      amount: 1000, note: 'Withdrawal to x@ybl', status: 'failed', ref_id: null, created_at: Date.now() + 1000,
    });

    const b = (await history(host)).body.battles.find(x => x.id === id);
    assert.equal(b.openingBalance, 5000, 'a reversed withdrawal was counted as real');
    assert.equal(b.closingBalance, 5460);
  });
});
