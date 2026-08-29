import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, setDie, legalMoves, applyMove, isGameOver,
  ringIndex, HOME_STEP, LAST_TRACK_STEP, makeRng, rollWith,
} from '../src/game/rules.js';

/* Helper: put a specific board on the table. */
function board(spec, turn = 'red', players = ['red', 'blue']) {
  const g = createGame({ players });
  for (const [tokenId, steps] of Object.entries(spec)) {
    const [colour, i] = tokenId.split('-');
    g.tokens[colour][Number(i)].steps = steps;
  }
  g.turn = turn;
  return g;
}
const movesFor = (g, die) => setDie(g, die).moves;
const ids = moves => moves.map(m => m.tokenId).sort();

/* ---------------- releasing from base ---------------- */

test('only a six releases a token from base', () => {
  const g = createGame({ players: ['red', 'blue'] });
  for (const die of [1, 2, 3, 4, 5]) assert.equal(movesFor(g, die).length, 0, `die ${die}`);
  assert.equal(movesFor(g, 6).length, 4);
});

test('a non-six with everything in base passes the turn automatically', () => {
  const g = createGame({ players: ['red', 'blue'] });
  const r = setDie(g, 4);
  assert.deepEqual(r.events, ['roll', 'noMove', 'turnEnd']);
  assert.equal(r.state.turn, 'blue');
  assert.equal(r.state.die, null);
});

test('a released token lands on its own start square', () => {
  const g = createGame({ players: ['red', 'blue'] });
  const { state } = applyMove(setDie(g, 6).state, 'red-0');
  assert.equal(state.tokens.red[0].steps, 1);
  assert.equal(ringIndex('red', 1), 0);
});

/* ---------------- extra turns ---------------- */

test('rolling a six grants another turn', () => {
  const g = createGame({ players: ['red', 'blue'] });
  const { state, events } = applyMove(setDie(g, 6).state, 'red-0');
  assert.ok(events.includes('extraTurn'));
  assert.equal(state.turn, 'red');
});

test('a normal move ends the turn', () => {
  const g = board({ 'red-0': 5 });
  const { state, events } = applyMove(setDie(g, 3).state, 'red-0');
  assert.ok(events.includes('turnEnd'));
  assert.equal(state.turn, 'blue');
});

test('three sixes in a row forfeits the turn and voids the third roll', () => {
  let g = board({ 'red-0': 5 });
  g = applyMove(setDie(g, 6).state, 'red-0').state;      // six #1
  assert.equal(g.consecutiveSixes, 1);
  g = applyMove(setDie(g, 6).state, 'red-0').state;      // six #2
  assert.equal(g.consecutiveSixes, 2);
  const before = g.tokens.red[0].steps;
  const r = setDie(g, 6);                                 // six #3
  assert.ok(r.events.includes('forfeitThreeSixes'));
  assert.equal(r.moves.length, 0);
  assert.equal(r.state.turn, 'blue');
  assert.equal(r.state.tokens.red[0].steps, before, 'the third six must not move anything');
  assert.equal(r.state.consecutiveSixes, 0);
});

test('a non-six resets the six counter', () => {
  let g = board({ 'red-0': 5 });
  g = applyMove(setDie(g, 6).state, 'red-0').state;
  assert.equal(g.consecutiveSixes, 1);
  g = applyMove(setDie(g, 2).state, 'red-0').state;
  assert.equal(g.consecutiveSixes, 0);
});

/* ---------------- capture ---------------- */

test('landing on a lone opponent sends it back to base', () => {
  // Both colours must land on the same ring square. Red reaches ring 20 at
  // steps 21; blue reaches ring 20 at steps 34 (its start offset is 39).
  assert.equal(ringIndex('red', 21), 20);
  assert.equal(ringIndex('blue', 34), 20);
  const g = board({ 'red-0': 18, 'blue-0': 34 });
  const move = movesFor(g, 3).find(m => m.tokenId === 'red-0');
  assert.deepEqual(move.captures, ['blue-0']);
  const { state, events } = applyMove(setDie(g, 3).state, 'red-0');
  assert.equal(state.tokens.blue[0].steps, 0, 'captured token returns to base');
  assert.ok(events.includes('capture'));
});

test('a capture grants an extra turn', () => {
  const g = board({ 'red-0': 18, 'blue-0': 34 });
  const { state, events } = applyMove(setDie(g, 3).state, 'red-0');
  assert.ok(events.includes('extraTurn'));
  assert.equal(state.turn, 'red');
});

test('no capture on a starred safe square', () => {
  // Ring 21 is a starred square. Red reaches it at steps 22, blue at steps 35.
  assert.equal(ringIndex('red', 22), 21);
  assert.equal(ringIndex('blue', 35), 21);
  const g = board({ 'red-0': 20, 'blue-0': 35 });
  const move = movesFor(g, 2).find(m => m.tokenId === 'red-0');
  assert.equal(move.to, 22);
  assert.deepEqual(move.captures, [], 'safe square must protect the occupant');
  assert.ok(move.onSafe);
  const { state } = applyMove(setDie(g, 2).state, 'red-0');
  assert.equal(state.tokens.blue[0].steps, 35, 'occupant stays put');
});

test('own tokens stack without capturing each other', () => {
  const g = board({ 'red-0': 10, 'red-1': 7 });
  const move = movesFor(g, 3).find(m => m.tokenId === 'red-1');
  assert.equal(move.to, 10);
  assert.deepEqual(move.captures, []);
  const { state } = applyMove(setDie(g, 3).state, 'red-1');
  assert.equal(state.tokens.red[0].steps, 10);
  assert.equal(state.tokens.red[1].steps, 10);
});

test('tokens in a home column cannot be captured', () => {
  // A home-column token shares no ring index with anyone by construction.
  const g = board({ 'red-0': 54, 'blue-0': 20 });
  for (let die = 1; die <= 6; die++) {
    for (const m of movesFor(board({ 'blue-0': 20, 'red-0': 54 }, 'blue'), die)) {
      assert.deepEqual(m.captures, [], `die ${die} must not capture into a home column`);
    }
  }
});

/* ---------------- home entry ---------------- */

test('entering home needs the exact roll', () => {
  const g = board({ 'red-0': 54 });                      // 3 steps from home (57)
  assert.equal(movesFor(g, 3).length, 1, 'exact roll is legal');
  assert.equal(movesFor(g, 3)[0].to, HOME_STEP);
  for (const die of [4, 5, 6]) {
    const m = movesFor(g, die).find(x => x.tokenId === 'red-0');
    assert.equal(m, undefined, `overshooting with ${die} must be illegal`);
  }
});

test('a short roll inside the home column is still legal', () => {
  const g = board({ 'red-0': 54 });
  const m = movesFor(g, 2).find(x => x.tokenId === 'red-0');
  assert.equal(m.to, 56);
  assert.equal(m.entersHome, false);
});

test('reaching home grants an extra turn', () => {
  const g = board({ 'red-0': 54, 'red-1': 10 });
  const { events, state } = applyMove(setDie(g, 3).state, 'red-0');
  assert.ok(events.includes('home'));
  assert.ok(events.includes('extraTurn'));
  assert.equal(state.turn, 'red');
});

test('a finished token cannot move again', () => {
  const g = board({ 'red-0': HOME_STEP, 'red-1': 10 });
  const m = movesFor(g, 3).find(x => x.tokenId === 'red-0');
  assert.equal(m, undefined);
});

test('the last track step is 51 and step 52 is the first home-column square', () => {
  const g = board({ 'red-0': LAST_TRACK_STEP });
  const m = movesFor(g, 1).find(x => x.tokenId === 'red-0');
  assert.equal(m.to, 52);
  assert.equal(m.lands, null, 'home column has no ring index');
});

/* ---------------- winning ---------------- */

test('all four tokens home wins the game', () => {
  const g = board({
    'red-0': HOME_STEP, 'red-1': HOME_STEP, 'red-2': HOME_STEP, 'red-3': 54,
    'blue-0': 10,
  });
  const { state, events } = applyMove(setDie(g, 3).state, 'red-3');
  assert.ok(events.includes('win'));
  assert.equal(state.winner, 'red');
  assert.deepEqual(state.finished, ['red']);
  assert.ok(isGameOver(state));
});

test('a winner does not keep the turn', () => {
  const g = board({
    'red-0': HOME_STEP, 'red-1': HOME_STEP, 'red-2': HOME_STEP, 'red-3': 54,
    'blue-0': 10,
  });
  const { state } = applyMove(setDie(g, 3).state, 'red-3');
  assert.notEqual(state.turn, 'red');
});

/* ---------------- turn order ---------------- */

test('four-player turn order cycles', () => {
  let g = createGame({ players: ['red', 'green', 'yellow', 'blue'] });
  const seen = [];
  for (let i = 0; i < 4; i++) { seen.push(g.turn); g = setDie(g, 1).state; }
  assert.deepEqual(seen, ['red', 'green', 'yellow', 'blue']);
});

test('a finished player is skipped in the rotation', () => {
  let g = createGame({ players: ['red', 'green', 'yellow', 'blue'] });
  g.finished = ['green'];
  g.turn = 'red';
  g = setDie(g, 1).state;                                  // nothing legal -> pass
  assert.equal(g.turn, 'yellow', 'green is finished and must be skipped');
});

/* ---------------- integrity ---------------- */

test('applyMove rejects an illegal token', () => {
  const g = createGame({ players: ['red', 'blue'] });
  const s = setDie(g, 6).state;
  assert.throws(() => applyMove(s, 'blue-0'), /Illegal move/);
});

test('applyMove never mutates the state it was given', () => {
  const g = board({ 'red-0': 5 });
  const before = JSON.stringify(g);
  applyMove(setDie(g, 3).state, 'red-0');
  assert.equal(JSON.stringify(g), before);
});

test('the die is cleared after a move', () => {
  const g = board({ 'red-0': 5 });
  const { state } = applyMove(setDie(g, 3).state, 'red-0');
  assert.equal(state.die, null);
});

test('a die outside 1..6 is rejected', () => {
  const g = createGame({ players: ['red', 'blue'] });
  assert.throws(() => setDie(g, 0), /1 to 6/);
  assert.throws(() => setDie(g, 7), /1 to 6/);
});

test('a game needs 2 or 4 players', () => {
  assert.throws(() => createGame({ players: ['red'] }));
  assert.throws(() => createGame({ players: ['red', 'green', 'blue'] }));
});

/* ---------------- soak test ---------------- */

test('100 random games all finish without crashing or stalling', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rng = makeRng(seed);
    let g = createGame({ players: ['red', 'green', 'yellow', 'blue'] });
    let turns = 0;
    while (!g.winner && turns < 20000) {
      turns++;
      const r = setDie(g, rollWith(rng));
      g = r.state;
      if (!r.moves.length) continue;
      g = applyMove(g, r.moves[Math.floor(rng() * r.moves.length)].tokenId).state;
    }
    assert.ok(g.winner, `seed ${seed} never produced a winner in ${turns} turns`);
    assert.equal(g.tokens[g.winner].filter(t => t.steps === HOME_STEP).length, 4);
  }
});

test('token count is conserved across a whole game', () => {
  const rng = makeRng(42);
  let g = createGame({ players: ['red', 'blue'] });
  while (!g.winner) {
    const r = setDie(g, rollWith(rng));
    g = r.state;
    if (!r.moves.length) continue;
    g = applyMove(g, r.moves[Math.floor(rng() * r.moves.length)].tokenId).state;
    for (const c of g.players) {
      assert.equal(g.tokens[c].length, 4);
      for (const t of g.tokens[c]) assert.ok(t.steps >= 0 && t.steps <= HOME_STEP, 'steps in range');
    }
  }
});
