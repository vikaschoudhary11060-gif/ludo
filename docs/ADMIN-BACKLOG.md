# Admin Portal — What to Add

## What it already has (10 tabs)
Overview · Games · Disputes · Deposits · Withdrawals · KYC · Chat · Audit log ·
Admins (roles) · Settings — all with 1d/7d/30d/all-time filters, live counts,
mobile dropdowns, dark theme.

**The gap:** it can *react* to things (resolve, approve, reply) but it can't **search a
player**, **see money trends**, or **run the business proactively.** Below is what fills that.

Effort: **S** = hours · **M** = ~a day.

---

## 1. Players tab ⭐ (the biggest missing piece)

| # | Feature | What it does | Effort |
|---|---|---|---|
| P1 | **Player search** | Find any user by name, phone or id. | S |
| P2 | **Player 360 view** | One screen: wallet (all 3 balances), games played, win rate, deposits, withdrawals, KYC status, referrals, chat history. | M |
| P3 | **Manual wallet adjust** | Credit or debit a player with a required reason → written to audit log. | S |
| P4 | **Ban / unban from the profile** | With reason. (Ban API exists; needs UI.) | S |
| P5 | **Force-logout a player** | Invalidate their session. | S |
| P6 | **View a player's device/login history** | Spot multi-accounting. | M |

## 2. Money & reporting

| # | Feature | What it does | Effort |
|---|---|---|---|
| M1 | **Dashboard charts** | Deposits, withdrawals, commission, signups — line charts over the selected range. | M |
| M2 | **Revenue report** | Commission earned, GST collected, net position. | S |
| M3 | **CSV export** | Any list (games, deposits, withdrawals, transactions) → downloadable CSV. | S |
| M4 | **Pending-money summary** | Total ₹ locked in open battles, pending withdrawals, disputes — at a glance. | S |
| M5 | **Reconciliation check** | One button: does every wallet match its ledger? Flags mismatches. | S |

## 3. Fraud & risk

| # | Feature | What it does | Effort |
|---|---|---|---|
| R1 | **Multi-account detection** | Flag accounts sharing a device/IP. | M |
| R2 | **Suspicious-pattern flags** | Same two players always win/lose to each other (collusion), rapid deposit→withdraw. | M |
| R3 | **Withdrawal risk score** | Highlight risky payouts before approval (new account, no games, big amount). | S |
| R4 | **Watchlist** | Mark players to monitor. | S |

## 4. Content & communication

| # | Feature | What it does | Effort |
|---|---|---|---|
| C1 | **Broadcast** | Send a push + in-app notice to all / segment of users. | S |
| C2 | **Banner manager** | Edit the home carousel banners from admin (currently hard-coded). | M |
| C3 | **Promo / coupon codes** | Create bonus-cash codes, set limits, track usage. | M |
| C4 | **Canned chat replies** | Saved responses agents can insert. | S |
| C5 | **Edit legal pages** | Update Terms/Privacy/Refund text without a rebuild. | M |

## 5. Config & control

| # | Feature | What it does | Effort |
|---|---|---|---|
| G1 | **Bank/UPI settings** | Manage the deposit UPI ID + accepted banks from admin. | S |
| G2 | **Bet-amount presets** | Configure the Lite/Rich ranges and quick amounts. | S |
| G3 | **Feature flags** | Turn chat, referrals, specific modes on/off. | S |
| G4 | **Scheduled maintenance** | Set a maintenance window with a countdown notice. | S |

## 6. Admin-team quality-of-life

| # | Feature | What it does | Effort |
|---|---|---|---|
| Q1 | **Notification bell** | Live alert when a dispute/withdrawal/chat needs attention. | S |
| Q2 | **Assign / claim items** | "I'm handling this dispute" so two admins don't clash. | M |
| Q3 | **Change my password** | Admins can rotate their own password. | S |
| Q4 | **Audit-log filters** | Filter by admin, action type, target. | S |
| Q5 | **Session timeout + re-auth** | Auto-logout idle admin sessions. | S |

---

## My recommended first cut

**Most impactful, least effort:**
- **P1 + P2 + P3** — the Players tab. Right now you literally cannot look up a customer.
- **M3 + M5** — CSV export + reconciliation. Essential for handling money.
- **R3** — withdrawal risk score. Protects you at the exact moment money leaves.
- **Q1** — notification bell so nothing waiting gets missed.

That's a focused, ~2-day package that turns the console from "reactive queue-clearer" into
a real operations tool.

Mark the numbers you want.
