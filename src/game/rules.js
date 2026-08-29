/* ============================================================
   Khelbro — Ludo rules engine

   Pure functions over a serialisable state object. No DOM, no
   timers, no randomness inside: the die value is always passed
   in, so the same module runs unchanged in the browser and on
   the server (where the server is the one rolling).

   Every token is described by a single integer, `steps`:

       0        in base
       1..51    on the 52-square shared track
       52..56   in its own home column
       57       home (finished)

   That makes every rule arithmetic on one number. The board
   geometry lives in board-layout.js and is only needed to draw.
   ============================================================ */

export const TRACK_LENGTH = 52;
export const LAST_TRACK_STEP = 51;   // after this a token turns into its home column
export const HOME_STEP = 57;         // all four tokens here = win
export const TOKENS_PER_PLAYER = 4;
export const MAX_CONSECUTIVE_SIXES = 3;

const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Ring index of a token that is on the shared track. */
export function ringIndex(colour, steps) {
  return (START[colour] + steps - 1) % TRACK_LENGTH;
}

export const isOnTrack = steps => steps >= 1 && steps <= LAST_TRACK_STEP;
export const isSafeRing = ring => SAFE.has(ring);

/* ---------- deterministic RNG, so tests and replays are reproducible ---------- */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rollWith = rng => 1 + Math.floor(rng() * 6);

/* ---------- state ---------- */

/**
 * @param {string[]} players 2 or 4 colours, in turn order
 */
export function createGame({ players, id = 'local' } = {}) {
  if (!Array.isArray(players) || ![2, 4].includes(players.length)) {
    throw new Error('A game needs 2 or 4 players.');
  }
  const tokens = {};
  for (const colour of players) {
    tokens[colour] = Array.from({ length: TOKENS_PER_PLAYER }, (_, i) => ({
      id: `${colour}-${i}`, colour, index: i, steps: 0,
    }));
  }
  return {
    id,
    players: [...players],
    turn: players[0],
    die: null,               // set by setDie(); cleared once a move is applied
    consecutiveSixes: 0,
    tokens,
    finished: [],            // colours in the order they completed
    winner: null,
    version: 0,
    log: [],
  };
}

const clone = s => (typeof structuredClone === 'function'
  ? structuredClone(s)
  : JSON.parse(JSON.stringify(s)));

const allTokens = state => state.players.flatMap(c => state.tokens[c]);
const findToken = (state, tokenId) => allTokens(state).find(t => t.id === tokenId) || null;

/** Colours still playing, in seating order. */
const activePlayers = state => state.players.filter(c => !state.finished.includes(c));

function nextTurn(state) {
  const active = activePlayers(state);
  if (!active.length) return state.turn;
  const i = active.indexOf(state.turn);
  return active[(i + 1) % active.length];   // if the current player just finished, i === -1 -> first active
}

/* ---------- move generation ---------- */

/**
 * Every legal move for the player to move, given `state.die`.
 * Returns [] when there is nothing legal — the caller should pass the turn.
 */
export function legalMoves(state) {
  const die = state.die;
  if (!die || state.winner) return [];
  const colour = state.turn;
  const moves = [];

  for (const token of state.tokens[colour]) {
    // A six releases a token from base onto its start square.
    if (token.steps === 0) {
      if (die === 6) moves.push(buildMove(state, token, 1, 'release'));
      continue;
    }
    if (token.steps >= HOME_STEP) continue;              // already home

    const target = token.steps + die;
    // The home column needs an exact roll; overshooting is simply not legal.
    if (target > HOME_STEP) continue;

    moves.push(buildMove(state, token, target, 'advance'));
  }
  return moves;
}

function buildMove(state, token, to, type) {
  const captures = capturesAt(state, token.colour, to);
  return {
    tokenId: token.id,
    colour: token.colour,
    from: token.steps,
    to,
    type,
    captures: captures.map(t => t.id),
    entersHome: to === HOME_STEP,
    lands: to <= LAST_TRACK_STEP ? ringIndex(token.colour, to) : null,
    onSafe: to <= LAST_TRACK_STEP ? isSafeRing(ringIndex(token.colour, to)) : false,
  };
}

/** Opponent tokens that would be sent home if `colour` landed on `steps`. */
function capturesAt(state, colour, steps) {
  if (!isOnTrack(steps)) return [];              // home column is private
  const ring = ringIndex(colour, steps);
  if (isSafeRing(ring)) return [];               // starred squares are protected
  return allTokens(state).filter(t =>
    t.colour !== colour && isOnTrack(t.steps) && ringIndex(t.colour, t.steps) === ring);
}

/* ---------- applying a die ---------- */

/**
 * Record a roll. Handles the three-sixes forfeit and the
 * automatic pass when no move is legal.
 * @returns {{state: object, moves: object[], events: string[]}}
 */
export function setDie(state, die) {
  if (die < 1 || die > 6) throw new Error('A die shows 1 to 6.');
  const next = clone(state);
  const events = [];

  if (next.winner) return { state: next, moves: [], events: ['gameOver'] };

  next.die = die;
  next.consecutiveSixes = die === 6 ? next.consecutiveSixes + 1 : 0;
  events.push('roll');

  // Three sixes in a row forfeits the turn — stops a player stalling forever.
  if (next.consecutiveSixes >= MAX_CONSECUTIVE_SIXES) {
    next.consecutiveSixes = 0;
    next.die = null;
    next.turn = nextTurn(next);
    next.version++;
    next.log.push({ type: 'forfeit', reason: 'three-sixes' });
    events.push('forfeitThreeSixes', 'turnEnd');
    return { state: next, moves: [], events };
  }

  const moves = legalMoves(next);
  if (moves.length === 0) {
    next.die = null;
    next.consecutiveSixes = 0;
    next.turn = nextTurn(next);
    next.version++;
    next.log.push({ type: 'pass', colour: state.turn, die });
    events.push('noMove', 'turnEnd');
  }
  return { state: next, moves, events };
}

/* ---------- applying a move ---------- */

/**
 * Apply one of the moves returned by legalMoves.
 * @returns {{state: object, events: string[], move: object}}
 */
export function applyMove(state, tokenId) {
  const moves = legalMoves(state);
  const move = moves.find(m => m.tokenId === tokenId);
  if (!move) throw new Error('Illegal move.');

  const next = clone(state);
  const events = [];
  const token = findToken(next, tokenId);

  token.steps = move.to;
  events.push(move.type === 'release' ? 'release' : 'move');

  // Send any captured opponents back to base.
  for (const id of move.captures) {
    findToken(next, id).steps = 0;
  }
  if (move.captures.length) events.push('capture');
  if (move.onSafe) events.push('safe');

  let extraTurn = false;
  if (move.entersHome) { events.push('home'); extraTurn = true; }
  if (move.captures.length) extraTurn = true;
  if (next.die === 6) extraTurn = true;

  // Has this colour brought all four tokens home?
  const colour = move.colour;
  const done = next.tokens[colour].every(t => t.steps === HOME_STEP);
  if (done && !next.finished.includes(colour)) {
    next.finished.push(colour);
    events.push('playerFinished');
    if (next.finished.length === 1) {
      next.winner = colour;
      events.push('win');
    }
    extraTurn = false;
  }

  // The game ends when only one player is left unfinished.
  if (activePlayers(next).length <= 1 && next.finished.length) {
    events.push('gameOver');
  }

  next.log.push({ type: 'move', ...move, die: next.die });
  next.die = null;

  if (extraTurn && !next.finished.includes(colour)) {
    events.push('extraTurn');
  } else {
    next.consecutiveSixes = 0;
    next.turn = nextTurn(next);
    events.push('turnEnd');
  }

  next.version++;
  return { state: next, events, move };
}

export function isGameOver(state) {
  return !!state.winner && activePlayers(state).length <= 1;
}

/** Steps remaining for a colour — handy for the AI and for labels. */
export function progress(state, colour) {
  return state.tokens[colour].reduce((sum, t) => sum + t.steps, 0);
}
