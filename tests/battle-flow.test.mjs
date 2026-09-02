/* ============================================================
   Battles, end to end through the real routes.

   The headline case is the reported bug: ₹1,000 cash plus ₹1,000
   winnings, a ₹2,000 battle, then a cancel. The refund used to
   land entirely in cash, quietly turning withdrawable winnings
   into play-only balance. Every cancellation path is checked, not
   just the one that was reported.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApi, seedSettings, seedUser, walletOf, fake } from './helpers/api-harness.mjs';

const api = await startApi({ auth: true, battles: true });
test.after(() => api.stop());

const reset = async (settings = {}) => { fake.reset(); await seedSettings(settings); };
const buckets = async id => { const w = await walletOf(id); return [w.deposit, w.winnings]; };

/** Host and guest, each with the same starting balances. */
async function twoPlayers(start = { deposit: 1000, winnings: 1000 }) {
  const host = await seedUser({ phone: '9800000001', name: 'Host', ...start });
  const guest = await seedUser({ phone: '9800000002', name: 'Guest', ...start });
  return { host, guest };
}

/** Create → request → accept, i.e. both stakes taken, no room code yet. */
async function toWaiting(host, guest, amount = 2000) {
  const created = await api.post('/api/battles', { mode: 'lite', amount }, host.token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.battle.id;
  assert.equal((await api.post(`/api/battles/${id}/accept`, {}, guest.token)).status, 200);
  assert.equal((await api.post(`/api/battles/${id}/accept-request`, {}, host.token)).status, 200);
  return id;
}

/* ---------------------------------------------------------------- */
test('staking records where the money came from', async t => {
  t.beforeEach(() => reset());

  await t.test('the reported case: ₹1,000 cash + ₹1,000 winnings for a ₹2,000 battle', async () => {
    const { host } = await twoPlayers();
    const r = await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token);
    assert.equal(r.status, 201, JSON.stringify(r.body));

    assert.deepEqual(await buckets(host.id), [0, 0]);
    const b = fake.dump('battles')[0];
    assert.deepEqual(b.creator_stake, { deposit: 1000, winnings: 1000 },
      'without this split the refund cannot know where to put the money back');
  });

  await t.test('spends cash before winnings', async () => {
    const host = await seedUser({ deposit: 5000, winnings: 5000 });
    await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token);
    assert.deepEqual(await buckets(host.id), [3000, 5000], 'winnings were spent first');
    assert.deepEqual(fake.dump('battles')[0].creator_stake, { deposit: 2000, winnings: 0 });
  });

  await t.test('records the joining player’s split too', async () => {
    const { host, guest } = await twoPlayers({ deposit: 500, winnings: 3000 });
    await toWaiting(host, guest);
    assert.deepEqual(fake.dump('battles')[0].acceptor_stake, { deposit: 500, winnings: 1500 });
  });

  await t.test('an unaffordable battle is refused and nothing moves', async () => {
    const host = await seedUser({ deposit: 500, winnings: 500 });
    const r = await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token);
    assert.equal(r.status, 400);
    assert.deepEqual(await buckets(host.id), [500, 500]);
    assert.equal(fake.dump('battles').length, 0);
  });
});

/* ---------------------------------------------------------------- */
test('cancelling returns money to the bucket it came from', async t => {
  t.beforeEach(() => reset());

  await t.test('the reported case, end to end', async () => {
    const { host } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;

    const r = await api.post(`/api/battles/${id}/cancel`, { reason: 'changed_mind' }, host.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await buckets(host.id), [1000, 1000],
      'the winnings half came back as cash — the reported bug');
  });

  await t.test('refunds both players when the host walks away after accepting', async () => {
    const { host, guest } = await twoPlayers({ deposit: 400, winnings: 5000 });
    const id = await toWaiting(host, guest, 500);
    assert.deepEqual(await buckets(host.id), [0, 4900]);

    assert.equal((await api.post(`/api/battles/${id}/cancel`, { reason: 'no_room' }, host.token)).status, 200);
    assert.deepEqual(await buckets(host.id), [400, 5000]);
    assert.deepEqual(await buckets(guest.id), [400, 5000]);
  });

  await t.test('either side may cancel once both have staked', async () => {
    const { host, guest } = await twoPlayers();
    const id = await toWaiting(host, guest);
    // The guest calls it off, not the host — a host who vanishes must not be
    // able to strand the other player's stake.
    assert.equal((await api.post(`/api/battles/${id}/cancel`, { reason: 'no_room' }, guest.token)).status, 200);
    assert.deepEqual(await buckets(host.id), [1000, 1000]);
    assert.deepEqual(await buckets(guest.id), [1000, 1000]);
  });

  await t.test('rejecting a joining player refunds them to their own buckets', async () => {
    const { host, guest } = await twoPlayers({ deposit: 400, winnings: 5000 });
    const id = await toWaiting(host, guest, 500);
    assert.equal((await api.post(`/api/battles/${id}/reject-request`, {}, host.token)).status, 200);
    assert.deepEqual(await buckets(guest.id), [400, 5000], 'the rejected player lost winnings to cash');
    assert.deepEqual(await buckets(host.id), [0, 4900], 'the host is still staked — the battle reopened');
  });

  await t.test('withdrawing a join request before it is accepted moves nothing', async () => {
    const { host, guest } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;
    await api.post(`/api/battles/${id}/accept`, {}, guest.token);
    assert.deepEqual(await buckets(guest.id), [1000, 1000], 'a request should not take a stake');
    assert.equal((await api.post(`/api/battles/${id}/cancel-request`, {}, guest.token)).status, 200);
    assert.deepEqual(await buckets(guest.id), [1000, 1000]);
  });

  await t.test('both players reporting "cancel" refunds both to source', async () => {
    const { host, guest } = await twoPlayers({ deposit: 400, winnings: 5000 });
    const id = await toWaiting(host, guest, 500);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);

    await api.post(`/api/battles/${id}/result`, { claim: 'cancel' }, host.token);
    const r = await api.post(`/api/battles/${id}/result`, { claim: 'cancel' }, guest.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'cancelled');
    assert.deepEqual(await buckets(host.id), [400, 5000]);
    assert.deepEqual(await buckets(guest.id), [400, 5000]);
  });

  await t.test('cancelling twice does not refund twice', async () => {
    const { host } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;
    assert.equal((await api.post(`/api/battles/${id}/cancel`, {}, host.token)).status, 200);
    assert.equal((await api.post(`/api/battles/${id}/cancel`, {}, host.token)).status, 409);
    assert.deepEqual(await buckets(host.id), [1000, 1000], 'the stake came back twice');
  });

  await t.test('a stranger cannot cancel someone else’s battle', async () => {
    const { host } = await twoPlayers();
    const other = await seedUser({ phone: '9800000003' });
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;
    assert.equal((await api.post(`/api/battles/${id}/cancel`, {}, other.token)).status, 403);
    assert.deepEqual(await buckets(host.id), [0, 0], 'the stake was released to an outsider');
  });

  await t.test('a joining player cannot cancel a battle nobody has accepted yet', async () => {
    const { host, guest } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;
    await api.post(`/api/battles/${id}/accept`, {}, guest.token);      // status: requested
    const r = await api.post(`/api/battles/${id}/cancel`, {}, guest.token);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Only the host can cancel before the battle starts.');
  });

  await t.test('a legacy battle with no recorded split still refunds to source', async () => {
    /* Exactly the state the live database was left in by the build that ran
       before the split was stored: the stake was taken and the ledger rows
       written, but the battle document carries no creator_stake. Every one of
       these used to refund straight into cash. */
    const { host } = await twoPlayers();
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 2000 }, host.token)).body.battle.id;
    await fake.col('battles').updateOne({ id }, { $unset: { creator_stake: '' } });
    assert.equal((await fake.col('battles').findOne({ id })).creator_stake, undefined);

    assert.equal((await api.post(`/api/battles/${id}/cancel`, { reason: 'changed_mind' }, host.token)).status, 200);
    assert.deepEqual(await buckets(host.id), [1000, 1000],
      'a battle predating the split turned winnings into cash');
  });

  await t.test('a legacy battle refunds both players to their own sources', async () => {
    const { host, guest } = await twoPlayers({ deposit: 400, winnings: 5000 });
    const id = await toWaiting(host, guest, 500);
    await fake.col('battles').updateOne({ id },
      { $unset: { creator_stake: '', acceptor_stake: '' } });

    assert.equal((await api.post(`/api/battles/${id}/cancel`, { reason: 'no_room' }, host.token)).status, 200);
    assert.deepEqual(await buckets(host.id), [400, 5000]);
    assert.deepEqual(await buckets(guest.id), [400, 5000]);
  });

  await t.test('every rupee is accounted for across the whole round trip', async () => {
    for (const start of [
      { deposit: 1000, winnings: 1000 },
      { deposit: 0, winnings: 2000 },
      { deposit: 2000, winnings: 0 },
      { deposit: 1990, winnings: 10 },
      { deposit: 10, winnings: 1990 },
    ]) {
      await reset();
      const { host, guest } = await twoPlayers(start);
      const id = await toWaiting(host, guest, 2000);
      await api.post(`/api/battles/${id}/cancel`, { reason: 'no_room' }, host.token);
      for (const who of [host, guest]) {
        assert.deepEqual(await buckets(who.id), [start.deposit, start.winnings],
          `round trip changed the buckets for ${JSON.stringify(start)}`);
      }
    }
  });
});

/* ---------------------------------------------------------------- */
test('settling a battle uses the commission the admin set', async t => {
  const play = async (host, guest, amount) => {
    const id = await toWaiting(host, guest, amount);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/uploads/p.png' }, host.token);
    return api.post(`/api/battles/${id}/result`, { claim: 'lost' }, guest.token);
  };

  await t.test('the default tiers: 8% up to ₹500, 5% above it, on one stake', async () => {
    await reset();
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const r = await play(host, guest, 100);
    assert.equal(r.body.state, 'completed');
    assert.equal(r.body.payout, 192, 'pot ₹200 less 8% of one ₹100 stake');

    // ₹500 is the threshold and belongs to the 8% tier, not the 5% one.
    await reset();
    const at = await twoPlayers({ deposit: 10000, winnings: 0 });
    assert.equal((await play(at.host, at.guest, 500)).body.payout, 960,
      'a ₹500 v ₹500 battle takes ₹40 and pays ₹960');

    await reset();
    const above = await twoPlayers({ deposit: 10000, winnings: 0 });
    assert.equal((await play(above.host, above.guest, 1000)).body.payout, 1950,
      'a ₹1,000 v ₹1,000 battle takes ₹50 and pays ₹1,950');
  });

  await t.test('the house takes exactly the quoted rate on one stake', async () => {
    await reset();
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const r = await play(host, guest, 500);
    assert.equal(1000 - r.body.payout, 40,
      'the pot is ₹1,000 and 8% of one ₹500 stake is ₹40');
  });

  await t.test('a rate the admin changes applies to the very next settlement', async () => {
    await reset({ commission_under: 0.10, commission_from: 0.10 });
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const r = await play(host, guest, 1000);
    assert.equal(r.body.payout, 1900, '10% of one ₹1,000 stake is ₹100, leaving ₹1,900');
  });

  await t.test('zero commission pays the whole pot', async () => {
    await reset({ commission_under: 0, commission_from: 0 });
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const r = await play(host, guest, 1000);
    assert.equal(r.body.payout, 2000);
  });

  await t.test('the winner is paid into winnings, so it is withdrawable', async () => {
    await reset();
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const r = await play(host, guest, 1000);
    assert.deepEqual(await buckets(host.id), [9000, r.body.payout]);
    assert.deepEqual(await buckets(guest.id), [9000, 0]);
  });

  await t.test('the referrer’s cut follows the rate the admin set', async () => {
    await reset({ referral_rate: 0.05 });
    const sponsor = await seedUser({ phone: '9800000009', name: 'Sponsor' });
    const host = await seedUser({ phone: '9800000001', name: 'Host', deposit: 10000, referred_by: sponsor.id });
    const guest = await seedUser({ phone: '9800000002', name: 'Guest', deposit: 10000 });
    await play(host, guest, 1000);
    assert.equal((await walletOf(sponsor.id)).referral, 50, '5% of a ₹1,000 battle is ₹50');
  });

  await t.test('conflicting claims settle nobody and pay nothing', async () => {
    await reset();
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const id = await toWaiting(host, guest, 1000);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/a.png' }, host.token);
    const r = await api.post(`/api/battles/${id}/result`, { claim: 'won', proof: '/b.png' }, guest.token);
    assert.equal(r.body.state, 'disputed');
    assert.deepEqual(await buckets(host.id), [9000, 0]);
    assert.deepEqual(await buckets(guest.id), [9000, 0]);
  });

  await t.test('a win claim without a screenshot is refused', async () => {
    await reset();
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const id = await toWaiting(host, guest, 1000);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);
    const r = await api.post(`/api/battles/${id}/result`, { claim: 'won' }, host.token);
    assert.equal(r.status, 400);
  });
});

/* ---------------------------------------------------------------- */
test('the cancel window after the room code', async t => {
  t.beforeEach(() => reset());

  await t.test('is open for ten minutes', async () => {
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const id = await toWaiting(host, guest, 1000);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);

    // Nine minutes in: still allowed.
    await fake.col('battles').updateOne({ id }, { $set: { room_set_at: Date.now() - 9 * 60_000 } });
    assert.equal((await api.post(`/api/battles/${id}/result`, { claim: 'cancel' }, host.token)).status, 200);
  });

  await t.test('is closed a moment past ten minutes', async () => {
    const { host, guest } = await twoPlayers({ deposit: 10000, winnings: 0 });
    const id = await toWaiting(host, guest, 1000);
    await api.post(`/api/battles/${id}/room`, { roomCode: '12345678' }, host.token);

    await fake.col('battles').updateOne({ id }, { $set: { room_set_at: Date.now() - 10 * 60_000 - 1000 } });
    const r = await api.post(`/api/battles/${id}/result`, { claim: 'cancel' }, host.token);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /10 minutes/, 'the message must state the window the code enforces');
  });
});

/* ---------------------------------------------------------------- */
test('lobby bots are decoration, not opponents', async t => {
  t.beforeEach(() => reset());

  const botBattle = async (extra = {}) => {
    const bot = await seedUser({ phone: '1000000001', name: 'RohitPlays', is_bot: true });
    const id = 'bbbbbbbbbbbb';
    await fake.col('battles').insertOne({
      id, mode: 'lite', amount: 500, status: 'open', creator_id: bot.id, acceptor_id: null,
      room_code: null, winner_id: null, payout: null, created_at: Date.now(), settled_at: null,
      creator_stake: null, acceptor_stake: null, is_bot: true, ...extra,
    });
    return id;
  };

  await t.test('a real player cannot join one', async () => {
    const id = await botBattle();
    const u = await seedUser({ phone: '9800000005', deposit: 5000 });
    const r = await api.post(`/api/battles/${id}/accept`, {}, u.token);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'That battle is no longer open.');
    assert.equal((await walletOf(u.id)).deposit, 5000, 'a stake was taken for a fake battle');
    assert.equal((await fake.col('battles').findOne({ id })).acceptor_id, null);
  });

  await t.test('its detail page does not exist', async () => {
    const id = await botBattle();
    const u = await seedUser({ phone: '9800000005' });
    assert.equal((await api.get(`/api/battles/${id}`, u.token)).status, 404);
    assert.equal((await api.get(`/api/battles/${id}`)).status, 404, 'even to an anonymous viewer');
  });

  await t.test('bot battles are excluded from the public open lobby', async () => {
    await botBattle();
    const r = await api.get('/api/battles?mode=lite&status=open');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.battles.map(b => b.creator.name), []);
  });

  await t.test('a running bot battle never leaks a room code to onlookers', async () => {
    await botBattle({ status: 'running', room_code: '99887766', acceptor_id: 999 });
    const u = await seedUser({ phone: '9800000005' });
    const r = await api.get('/api/battles?mode=lite&status=running', u.token);
    assert.equal(r.body.battles[0].roomCode, null);
  });

  await t.test('never appears among a real player’s own battles', async () => {
    await botBattle();
    const u = await seedUser({ phone: '9800000005' });
    const r = await api.get('/api/battles/mine', u.token);
    assert.deepEqual(r.body.battles, []);
  });
});

/* ---------------------------------------------------------------- */
test('the guards around creating a battle', async t => {
  t.beforeEach(() => reset());

  await t.test('honours the per-player open-battle limit', async () => {
    await reset({ battle_limit: 2 });
    const host = await seedUser({ deposit: 10000 });
    for (const amount of [100, 200]) {
      assert.equal((await api.post('/api/battles', { mode: 'lite', amount }, host.token)).status, 201);
    }
    const third = await api.post('/api/battles', { mode: 'lite', amount: 300 }, host.token);
    assert.equal(third.status, 409);
    assert.match(third.body.error, /maximum 2/);
    assert.equal((await walletOf(host.id)).deposit, 9700, 'the refused battle still took a stake');
  });

  await t.test('a limit the admin raises takes effect immediately', async () => {
    await reset({ battle_limit: 3 });
    const host = await seedUser({ deposit: 10000 });
    for (const amount of [100, 200, 300]) {
      assert.equal((await api.post('/api/battles', { mode: 'lite', amount }, host.token)).status, 201);
    }
  });

  await t.test('refuses two open battles for the same amount', async () => {
    const host = await seedUser({ deposit: 10000 });
    await api.post('/api/battles', { mode: 'lite', amount: 100 }, host.token);
    const dupe = await api.post('/api/battles', { mode: 'lite', amount: 100 }, host.token);
    assert.equal(dupe.status, 409);
  });

  await t.test('refuses amounts outside the mode, or off the step', async () => {
    const host = await seedUser({ deposit: 200000 });
    for (const [mode, amount] of [['lite', 40], ['lite', 25010], ['lite', 105],
                                  ['rich', 24000], ['rich', 100050], ['rich', 25025]]) {
      const r = await api.post('/api/battles', { mode, amount }, host.token);
      assert.equal(r.status, 400, `accepted ${mode} ₹${amount}`);
    }
  });

  await t.test('the host cannot join their own battle', async () => {
    const host = await seedUser({ deposit: 10000 });
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 500 }, host.token)).body.battle.id;
    assert.equal((await api.post(`/api/battles/${id}/accept`, {}, host.token)).status, 400);
  });

  await t.test('only one player can take an open battle', async () => {
    const host = await seedUser({ phone: '9800000001', deposit: 10000 });
    const a = await seedUser({ phone: '9800000002', deposit: 10000 });
    const b = await seedUser({ phone: '9800000003', deposit: 10000 });
    const id = (await api.post('/api/battles', { mode: 'lite', amount: 500 }, host.token)).body.battle.id;

    const [ra, rb] = await Promise.all([
      api.post(`/api/battles/${id}/accept`, {}, a.token),
      api.post(`/api/battles/${id}/accept`, {}, b.token),
    ]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409],
      `both players got in: ${ra.status}/${rb.status}`);
  });
});
