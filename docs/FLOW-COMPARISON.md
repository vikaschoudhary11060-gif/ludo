# KheloAdda vs Khelbro — flow-by-flow comparison

Decoded from KheloAdda's production bundle (its exact conditional rendering), plus a
signed-in walkthrough. Every screen state and branch below is what the reference actually
does, not a guess.

---

## ⚠️ Two corrections to my earlier analysis

**1. KheloAdda HAS a playable Ludo board.** In Phase 1 I called `/gameboard` "a stub that
hands you a room code". That was wrong. The bundle contains a full in-app game:

| Evidence in the bundle | What it proves |
|---|---|
| `pawns` array checked as `16 === m.length` | 4 players × 4 tokens rendered |
| `nowMoving`, `movingPlayer`, `rolledNumber` | turn engine + dice |
| `.mainboard`, `.container_`, `.pawn`, `.dice` in CSS | a real board is drawn |
| `game:roll`, `game:move`, `game:winner`, `room:exit` | server-authoritative play |
| "Quit Game? — Your opponent will win if you quit." | forfeit rule |
| `winPopup` → "Game Result" with winner and loser | win screen |
| mute toggle persisted to `localStorage.isMuted`, `.mp3` assets | sound + mute |
| "Connection lost. Retrying…" | reconnect handling |
| `time:` / turn timer, spinner while pawns load | timed turns |

The room code is shown **inside** the board, not as a hand-off to Ludo King. You decided to
skip building this — that decision is yours to keep, but it is the single largest
functional difference between the two sites, and it was based partly on my incorrect
description.

**2. Joining a battle is a request, not an instant join.** Detailed below.

---

## Flow 1 — Battle lifecycle *(the biggest gap)*

### KheloAdda: four states with a creator handshake

```
  new ──(someone taps Play)──▶ requested ──(creator taps START)──▶ running ──▶ result
   │                               │
   │                               └──(creator taps REJECT)──▶ back to new
   └──(creator taps DELETE)──▶ removed
```

**What each user sees, per state** — taken from the bundle's conditionals:

| State | Creator sees | Other player sees |
|---|---|---|
| `new` | **DELETE** button · "Finding Player!" with spinner | **Play** button |
| `requested` | **START** + **REJECT** buttons · requester's avatar + name · **plays a sound** | **"requested"** label + **cancel** button |
| `running` | (enters the game) | **start** button → `/viewgame1/:id` |

### Khelbro: three states, no handshake

```
  open ──(someone taps Play)──▶ waiting ──(creator sets room code)──▶ running ──▶ result
```

| Difference | KheloAdda | Khelbro | Impact |
|---|---|---|---|
| Joining | A **request** the creator must approve | **Instant** join | Creator has no say over who they play |
| Creator accept | **START** button | — | missing |
| Creator reject | **REJECT** button | ✅ we have reject | partial |
| Requester cancel | **cancel** while pending | — | missing |
| Creator delete | **DELETE** while `new` | ✅ cancel | equivalent |
| Sound on request | `<audio autoPlay>` | — | missing |
| "Finding Player!" inline | on the card itself | separate page | minor |

**Also on the bet card:** KheloAdda shows **Entry Fee *and* Prize** side by side, each with
its own icon. We show entry fee only, with the prize on the battle page.

---

## Flow 2 — In-game *(we have none of this)*

| Step | KheloAdda | Khelbro |
|---|---|---|
| Board | 15×15, 16 pawns, live | ❌ none |
| Dice | rolled server-side, animated | ❌ |
| Turn timer | yes | ❌ |
| Room code | shown in the board header | shown on the battle page |
| Mute | toggle, persisted | ❌ |
| Quit | "Quit Game?" → opponent wins | ❌ |
| Reconnect | "Connection lost. Retrying…" | ❌ |
| Win screen | "Game Result", winner + loser cards | ❌ |
| Result recorded | automatically by the server | manual claim + screenshot |

**Consequence:** because their server runs the game, it *knows* the winner. Our screenshot
+ two-sided claim system exists only because we have no board. Building the board would
delete our entire dispute pipeline.

---

## Flow 3 — Everything else, side by side

| Flow | KheloAdda | Khelbro | Verdict |
|---|---|---|---|
| **Sign in** | phone → OTP → auto-register | same | ✅ match (theirs sends real SMS) |
| **Home** | carousel · Our Tournaments (2 cards) · footer card | same | ✅ match |
| **Sidebar** | 10 items + logout | same 10 + logout | ✅ match |
| **Header (out)** | logo + LOGIN | same | ✅ match |
| **Header (in)** | ☰ · logo · Cash+ · Earning | same | ✅ match |
| **Lobby** | title, Hindi stake line, Create a Battle, Open/Running | same | ✅ match |
| **Create battle** | max 2 open · no duplicate amount · min/max · step | same | ✅ match |
| **Room code** | 8 digits, copy | same | ✅ match |
| **Result** | I Won / I Lost / Cancel + reason + screenshot | same | ✅ match |
| **Settlement** | single claim settles | **both must agree** | ⚠️ ours is stricter |
| **Wallet** | 3 balances, notice modal | same | ✅ match |
| **Add cash** | amount, 28% GST line, gateway **+ manual UTR** | same, **gateway simulated** | ⚠️ no real payment |
| **Withdraw** | UPI/bank, ~60 banks, KYC gate, closed switch | same (63 banks) | ✅ match |
| **KYC** | Aadhaar number + 3 photos + **Aadhaar OTP** | offline eKYC (instant) **+** 3 photos | ⚠️ different method |
| **Profile** | avatar picker, email, stats, logout | same **+ photo upload, email verify** | ✅ ahead |
| **Refer** | code, share, history, redeem | same | ✅ match |
| **Histories** | filter chips + pagination | same | ✅ match |
| **Notifications** | list | same **+ web push** | ✅ ahead |
| **Support** | 3 buttons + live chat (typing, files, voice) | same + chat (typing, files) | ⚠️ no voice notes |
| **Legal pages** | 6 pages | 6 pages | ✅ match |
| **PWA** | installable, offline | same | ✅ match |
| **Dark theme** | ❌ none | ✅ | ahead |
| **Hindi** | partial (some Hindi copy) | ✅ full toggle | ahead |
| **Admin** | separate system | ✅ full console + audit | ahead |

---

## Every scenario, checked

### Battle creation
| Scenario | KheloAdda | Khelbro |
|---|---|---|
| Amount below minimum | blocked | ✅ blocked |
| Amount above maximum | blocked | ✅ blocked |
| Not a multiple of 10 / 50 | blocked | ✅ blocked |
| Insufficient balance | "Insufficient balance" | ✅ same |
| 3rd open battle | "You can set maximum 2 battle." | ✅ same |
| Same amount twice | "cannot create same amount challenge" | ✅ same |
| Not signed in | redirect to login | ✅ same |

### Joining
| Scenario | KheloAdda | Khelbro |
|---|---|---|
| Join own battle | button hidden | ✅ blocked |
| Already in another battle | "You have already enrolled" | ✅ blocked |
| Insufficient balance | blocked | ✅ blocked |
| Battle taken meanwhile | error + refresh | ✅ 409 + refresh |
| **Creator approves the join** | **START** | ❌ **missing** |
| **Creator rejects the join** | REJECT → refund, back to `new` | ✅ have |
| **Requester cancels the request** | cancel button | ❌ **missing** |

### Room code
| Scenario | KheloAdda | Khelbro |
|---|---|---|
| Fewer/more than 8 digits | "must be exactly 8 digits" | ✅ same |
| Non-creator tries to set | not offered | ✅ 403 |
| Set before opponent joins | not offered | ✅ 409 |
| Copy | toast | ✅ same |

### Result
| Scenario | KheloAdda | Khelbro |
|---|---|---|
| Win without screenshot | blocked | ✅ blocked |
| Submit twice | "already updated your battle result" | ✅ blocked |
| Both claim win | admin review | ✅ `disputed`, funds held |
| Both cancel | refund both | ✅ same |
| One claims, other silent | settles on the single claim | ⚠️ we wait for both |
| Non-participant submits | blocked | ✅ 403 |

### Wallet
| Scenario | KheloAdda | Khelbro |
|---|---|---|
| Deposit under ₹100 | blocked | ✅ blocked |
| Deposit over ₹10,000 | blocked | ✅ blocked |
| Duplicate UTR | "already submitted" | ✅ blocked |
| UTR wrong length | 10–20 chars enforced | ✅ same |
| Withdraw without KYC | blocked | ✅ blocked + explains why |
| Withdraw > winnings | blocked | ✅ blocked |
| Withdrawals disabled | "Withdraw Closed" screen | ✅ same |
| Withdrawal rejected | refunded | ✅ refunded |

---

## What to build to reach parity

**Priority 1 — the request/accept handshake.** Three sub-features: creator START, creator
REJECT (have), requester cancel, plus the sound cue. Changes the battle state machine from
3 states to 4. **~half a day.**

**Priority 2 — Prize on the bet card.** Entry Fee + Prize side by side. **~1 hour.**

**Priority 3 — the playable board.** The rules engine and its 28 tests already exist in
`src/game/`. Remaining: rendering, dice, animation, server authority, turn timer,
reconnect, mute, win screen. **~3–4 days.** Would remove the entire dispute pipeline.

**Priority 4 — voice messages in chat.** **~half a day.**

**Not worth copying:** their single-claim settlement is weaker than our two-sided model,
and Aadhaar OTP needs a licence our offline-eKYC route avoids.
