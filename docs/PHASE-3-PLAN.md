# Phase 3 — The Ludo Game

## 0. The decision that shapes everything

Your original brief asked for a playable board with **pass-and-play plus vs-computer AI
(easy/medium/hard)**. Since then you asked for the site to match KheloAdda exactly and
for the practice game to be removed — and KheloAdda has no computer opponent, because
its `/gameboard` route is a stub that hands you a room code and sends you to the real
Ludo King app.

So "the same as KheloAdda" and "a playable board" pull in opposite directions. Three ways
to resolve it:

### Option A — Server-authoritative online board *(recommended)*
The board **replaces** the room-code handoff. Two players in a battle play the actual
match on Khelbro. The server owns the dice and the rules.

Why this is the strongest option:
- **Disputes disappear.** Today two players file claims, and a conflict parks the money
  in `disputed` for manual review. If the server runs the game it *knows* who won —
  no claims, no screenshots, no review queue, no "record every game" rule.
- **Cheating gets much harder.** The client never generates a dice roll.
- **It deletes code**: the claims table, the proof upload, the cancel-reason flow and the
  dispute state all become unnecessary for online battles.
- KheloAdda's own JS bundle already contains `game:roll`, `game:move`, `game:winner`,
  `room:create`, `room:data` and a `Dice_container` module — they were building toward
  exactly this and never shipped it.

Cost: the rules engine has to run on the server as well as the client, and needs
reconnect handling and a turn timer.

### Option B — Offline board only
Pass-and-play and vs-computer, exactly as the original brief. Simpler, no server work.
But you just removed practice mode, so this would add back a section you deleted, and
online battles would still settle by manual claims.

### Option C — Both
One rules engine, two front-ends: online battles (Option A) and a practice board hidden
behind a "Practice" entry. Most work, most flexibility.

**My recommendation: A**, then add the offline board later reusing the same engine — the
AI is a small addition once the rules engine exists, and having it makes the engine much
easier to test.

---

## 1. Board model

### Geometry
Standard 15×15 cross. Rendered as CSS grid, one `<div>` per cell, so it scales from a
320px phone to a desktop panel with no canvas and no layout maths.

| Region | Cells |
|---|---|
| Shared track | 52 squares, indices `0–51` clockwise |
| Base (per colour) | 6×6 corner block holding 4 tokens |
| Home column (per colour) | 6 squares running into the centre |
| Home triangle | centre 3×3, split into 4 |

### The one number that makes the rules simple

Each token stores **`steps` (0–57)**, not an x/y coordinate:

```
steps = 0        token is in base
steps = 1..51    on the shared track
steps = 52..57   in its own home column
steps = 57       finished (home triangle)
```

Converting to a board position:

```js
ringIndex(player, steps) = (START[player] + steps - 1) % 52   // only for steps 1..51
```

`START = { red: 0, green: 13, yellow: 26, blue: 39 }`

This means every rule is arithmetic on one integer:
- **Capture** — two tokens of different colours with the same `ringIndex`
- **Own stack** — same colour, same `ringIndex`
- **Home column is private** — `steps >= 52` can never collide across colours
- **Exact roll to finish** — `steps + die <= 57`, otherwise the move is illegal

### Safe squares
Eight, matching the standard board: the four coloured start squares
`0, 13, 26, 39` and four more at `8, 21, 34, 47`. No capture on any of them.

---

## 2. Rules engine

A single pure module, `src/game/rules.js`, shared byte-for-byte between browser and
server. No DOM, no timers, no randomness inside it — the die is passed in.

```js
createGame({ players, seed })      -> GameState
legalMoves(state, die)             -> Move[]          // never throws
applyMove(state, move)             -> { state, events[] }
isGameOver(state)                  -> boolean
```

`GameState` is a plain serialisable object:

```js
{
  id, players: ['red','blue'], turn: 'red', die: null, rolled: false,
  consecutiveSixes: 0,
  tokens: { red: [ {id:'r0', steps:0}, ... ], blue: [...] },
  finished: [], history: [], version: 12
}
```

`events` is what drives animation and sound: `['move', 'capture', 'safe', 'home', 'extraTurn', 'win']`.

### Rules encoded
- Roll 6 → may release a token from base onto its start square
- Roll 6 → extra turn; **three sixes in a row forfeits the turn** (anti-stalling)
- No legal move → turn passes automatically
- Landing on a lone opponent outside a safe square sends it to base (`steps = 0`)
- Own tokens stack; opponents cannot capture a stack of two on a safe square
- A capture grants an extra turn (configurable)
- Home column entry needs the exact roll; overshooting is not a legal move
- First player with all four tokens at `steps = 57` wins; others may play on for places

### Why pure functions matter here
Every rule becomes a unit test with no browser: `legalMoves` given a crafted state must
return exactly the expected set. I plan ~40 such tests covering the awkward cases —
exact-roll refusal, three-sixes forfeit, capture on a safe square, stacking, no-legal-move
pass, and the last-token-home win.

---

## 3. Rendering and animation

- Board: CSS grid, `aspect-ratio: 1`, `width: min(100%, 480px)`
- Tokens: absolutely positioned, moved with `transform: translate()` — GPU-composited
- **Square-by-square movement**: a token moving 5 steps runs 5 sequential `transform`
  transitions of ~120ms each, not one tween. Uses `Element.animate()` with a queue so
  animations can't overlap or desync from state.
- Legal-move highlight: a pulsing ring on every movable token before you choose
- Capture: the captured token arcs back to its base over ~400ms
- Every animation respects `prefers-reduced-motion` — motion collapses to instant snaps

### Dice
- 3D CSS cube, `rotateX/rotateY` keyframes, ~700ms tumble, settling on the rolled face
- The value is decided *before* the animation (server-supplied in online play) — the
  animation only reveals it
- Disabled while another player's turn is animating

---

## 4. Computer opponent (offline, or to cover a disconnect)

Three levels sharing one scoring function over `legalMoves`:

| Level | Behaviour |
|---|---|
| **Easy** | Picks uniformly at random from legal moves |
| **Medium** | Greedy on immediate value: capture > release from base > land on safe > furthest advance |
| **Hard** | Scores each move on capture value, capture *risk* (opponents within 1–6 squares behind), safe-square occupancy, home progress, and spread across tokens; adds a small random tiebreak so it isn't perfectly predictable |

Hard is deliberately not a search — one-ply scoring already plays a strong Ludo game, and
it stays fast and readable.

---

## 5. Sound

Five short WAVs generated as data URIs (no third-party audio): `roll`, `move`, `capture`,
`home`, `win`. Preloaded, pooled so rapid moves don't cut each other off. Mute button in
the board header, state persisted to `localStorage`, defaults to **on but muted until the
first user gesture** so autoplay policy never throws.

---

## 6. Win screen

Full-screen overlay: canvas confetti (~150 particles, self-written, ~40 lines), winner
name and avatar, final placings, amount won for online battles, and **Rematch** —
which for online play creates a fresh battle at the same amount and invites the same
opponent.

---

## 7. Server side (Option A only)

`server/src/game/` reuses the same `rules.js`.

New socket events (names already present in KheloAdda's bundle):

| Direction | Event | Payload |
|---|---|---|
| in | `game:join` | `{ battleId }` |
| in | `game:roll` | `{ battleId }` — **server rolls**, client never sends a value |
| in | `game:move` | `{ battleId, tokenId }` |
| out | `game:state` | full state on join/reconnect |
| out | `game:rolled` | `{ die, legalMoves }` |
| out | `game:moved` | `{ move, events, state }` |
| out | `game:winner` | `{ winnerId, payout }` |
| out | `game:timeout` | a turn expired |

Guarantees:
- Dice come from server-side `crypto.randomInt` — a client cannot influence a roll
- Every inbound move is re-validated against `legalMoves`; illegal input is rejected
- **30-second turn timer**; three consecutive timeouts forfeits the match
- State persisted per move, so a refresh or a dropped connection resumes exactly
- On `game:winner` the server settles the battle **directly** — credits the payout, writes
  the ledger entry, no claims involved

New table:
```sql
CREATE TABLE game_states (
  battle_id TEXT PRIMARY KEY REFERENCES battles(id),
  state     TEXT NOT NULL,      -- JSON GameState
  version   INTEGER NOT NULL,   -- optimistic concurrency
  updated_at INTEGER NOT NULL
);
```

---

## 8. Accessibility

- Board is a `role="grid"`; each token is a button with a label like
  *"Red token 2, 14 steps from home, can move to a safe square"*
- **Full keyboard play**: `R` or Space rolls, arrow keys or `1–4` select a token,
  Enter confirms, `M` mutes
- Turn changes and every capture announced via `aria-live="polite"`
- Tokens carry a shape as well as a colour (circle / square / triangle / star) so the
  board is readable with colour-vision deficiency
- All four token colours tested to ≥3:1 against the board background

---

## 9. Files

```
src/game/rules.js          pure rules engine (shared with the server)
src/game/ai.js             three difficulty levels
src/game/board-layout.js   the 15x15 grid map + ring index maths
assets/js/game.js          rendering, animation, input, sound
assets/js/confetti.js      win-screen particles
src/pages/game.html        board page fragment
server/src/game/engine.js  server-side turn authority (imports rules.js)
server/src/game/rules.js   symlink / copy of the shared engine
tests/rules.test.mjs       ~40 unit tests, `node --test`
```

---

## 10. Order of work

1. `rules.js` + the test suite — nothing renders until the rules are provably right
2. `board-layout.js` and static board render (no interaction)
3. Dice, turn loop, animated movement, capture, home entry — pass-and-play locally
4. Win screen, confetti, sound, mute
5. AI (all three levels), tested by simulating a few thousand games for crashes/stalls
6. Server engine + socket events + turn timer + reconnect
7. Wire the battle room: "Play" opens the board instead of showing a room code
8. Accessibility pass and reduced-motion checks

Steps 1–5 are the offline board. Step 6–7 make it the online product.

---

## 11. What this changes elsewhere

If you take Option A, these become obsolete for online battles and I would remove them:
- the result panel (I won / I lost / Cancel) in the battle room
- the screenshot upload
- the `battle_claims` table and the `disputed` status
- the "record every game while playing" rule

The room code stays useful only if you *also* want to keep supporting matches played in
the external Ludo King app. Worth deciding now, because it's the difference between the
battle room having two settlement paths or one.
