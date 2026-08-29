# Khelbro — Feature Backlog

Pick the ones you want; I'll build those. Effort: **S** = a few hours · **M** = ~a day ·
**L** = multi-day. "Blocked" = needs an account/key only you can create.

---

## A. KheloAdda parity (flows they have, we don't)

| # | Feature | What it does | Effort | Blocked |
|---|---|---|---|---|
| A1 | **Battle request → accept handshake** | Joining sends a *request*; creator taps START to approve or REJECT. Adds requester-cancel + a sound cue. Matches KheloAdda exactly. | M | — |
| A2 | **Prize on the bet card** | Show Entry Fee **and** Prize side by side, like theirs. | S | — |
| A3 | **Playable Ludo board** | Real in-app 4-player board, dice, turn timer, capture, win screen, reconnect. Server runs the game → removes the whole dispute/screenshot system. Rules engine + 28 tests already exist. | L | — |
| A4 | **Voice messages in support chat** | Record + send audio notes (they have this). | M | — |
| A5 | **Popular / suggested room codes** | Surface commonly-used amounts. | S | — |

## B. Player-facing features (new value)

| # | Feature | What it does | Effort | Blocked |
|---|---|---|---|---|
| B1 | **Daily bonus / login streak** | Reward for returning; drives retention. | S | — |
| B2 | **Spin-the-wheel / scratch card** | Gamified small rewards on deposit or daily. | M | — |
| B3 | **Coupon / promo codes** | Admin-created codes for bonus cash. | M | — |
| B4 | **Tournaments (multi-round)** | Bracket play beyond 1v1 battles, prize pool. | L | — |
| B5 | **Achievements / badges** | "10 wins", "first ₹1000" — profile flair. | S | — |
| B6 | **Player stats & win-rate** | Richer profile: win %, biggest win, streak. | S | — |
| B7 | **Head-to-head history** | "You vs this opponent" record. | S | — |
| B8 | **Favorite / block a player** | Choose or avoid opponents. | M | — |
| B9 | **In-app help / onboarding tour** | First-time walkthrough of the battle flow. | S | — |

## C. Trust, safety & compliance (important for real-money)

| # | Feature | What it does | Effort | Blocked |
|---|---|---|---|---|
| C1 | **Responsible-gaming controls** | Deposit limits, daily-loss limits, self-exclusion / cool-off, session-time reminders. | M | — |
| C2 | **State geo-restriction** | Block the states real-money gaming is barred in (KheloAdda bars 7). | S | — |
| C3 | **Age-verification gate** | Confirm 18+ before real play. | S | — |
| C4 | **Fair-play / anti-fraud** | Flag same-device multi-account, collusion patterns, rapid win/loss. | M | — |
| C5 | **TDS handling** | 30% TDS on net winnings per Indian law, with statements. | M | Legal input |
| C6 | **Audit-friendly money reports** | Exportable ledgers for accounting/compliance. | S | — |

## D. Admin & operations

| # | Feature | What it does | Effort | Blocked |
|---|---|---|---|---|
| D1 | **Player search & 360° view** | Look up any user, see wallet, games, KYC, chats. | M | — |
| D2 | **Manual wallet adjust** | Credit/debit with a reason (goes to audit log). | S | — |
| D3 | **Broadcast / announcement** | Push + in-app banner to all users. | S | — |
| D4 | **Admin dashboard charts** | Revenue, DAU, deposits/withdrawals over time. | M | — |
| D5 | **Bulk KYC / withdrawal actions** | Approve many at once. | S | — |
| D6 | **Export CSV** | Any admin list → CSV. | S | — |

## E. Growth & marketing

| # | Feature | What it does | Effort | Blocked |
|---|---|---|---|---|
| E1 | **Multi-tier referrals** | Referral leaderboard, milestones, bonuses. | M | — |
| E2 | **Share result card** | Auto-generated "I won ₹X" image to share. | M | — |
| E3 | **Email/SMS campaigns** | Win-back, inactive nudges. | M | Provider |
| E4 | **App store wrapper** | Package the PWA as a real Android APK (TWA). | M | Play account |

## F. Technical & infra

| # | Feature | What it does | Effort | Blocked |
|---|---|---|---|---|
| F1 | **MongoDB Atlas port** | Move the data layer off SQLite (your earlier ask). | L | Atlas string |
| F2 | **Automated test suite** | Full API + flow tests in CI, run on every change. | M | — |
| F3 | **Error monitoring** | Sentry-style crash/error capture. | S | Account |
| F4 | **Analytics** | Privacy-friendly usage analytics (self-hosted). | S | — |
| F5 | **Rate-limit hardening** | Per-user throttles on money endpoints. | S | — |
| F6 | **Database backups** | Scheduled DB snapshots. | S | — |

## G. Blocked on your accounts (build now, paste keys later)

| # | Feature | Needs |
|---|---|---|
| G1 | **Real SMS OTP** | MSG91 / Twilio + DLT registration *(hard blocker — nobody can log in without it)* |
| G2 | **Real email sending** | SendGrid / Resend |
| G3 | **Razorpay payments** | Merchant key + secret *(no real deposits without it)* |
| G4 | **UIDAI cert for auto-KYC** | UIDAI public certificate file |

---

## My recommended first cut (if you want a steer)

**To make it real:** G1 (SMS) → G3 (payments) → C1 + C2 + C3 (responsible gaming, geo, age).
Those turn it from a demo into something you can legally run.

**For product feel:** A1 (handshake) + A2 (prize) → B1 (daily bonus) → B6 (stats).

**Skip for now:** A3 (board) unless you want to replace the room-code flow; F1 (Mongo)
unless deployment forces it.

Mark the numbers you want and I'll start.
