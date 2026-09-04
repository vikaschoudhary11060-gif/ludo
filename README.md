# Khelbro

A Ludo gaming site rebuilt on the structure of `kheloadda.club`, with a Node API behind it.

```
.
├── index.html …                16 built pages (do not edit — generated)
├── build.py                    page builder: shell + fragments -> static HTML
├── tailwind.config.js          design tokens
├── src/
│   ├── input.css               Tailwind source + component layer
│   └── pages/*.html            page content fragments (edit these)
├── assets/
│   ├── css/app.css             compiled (8 KB gzipped)
│   ├── js/                     app shell, mock store, API client, page scripts
│   └── img/                    self-drawn SVG logo + placeholder card art
├── server/                     Node + Express + SQLite + Socket.IO API
└── docs/DESIGN-SPEC.md         the Phase 1 analysis this is built from
```

## Run the front end

```bash
npm install
npm run build          # compile Tailwind
python3 build.py       # generate the 16 HTML pages
npm run serve          # http://localhost:5173
```

Use `npm run dev` for Tailwind in watch mode while editing.

**Edit `src/pages/*.html`, never the root `.html` files** — those are generated and
overwritten by `build.py`. The shared header, drawer, footer and bottom nav live in
`build.py`.

## Run the API

```bash
cd server
npm install
cp .env.example .env       # then change JWT_SECRET
npm run seed               # minimal: a few players + an open lobby
npm run seed:demo          # full demo dataset (DESTRUCTIVE — wipes and rebuilds)
npm start                  # http://localhost:4000
```

`EXPOSE_OTP=true` returns the OTP in the response so you can sign in without an SMS
gateway. Turn it off outside development. `OTP_RATE_LIMIT` loosens the 5-per-10-minutes
cap while testing; leave it unset in production.

### Demo dataset

`npm run seed:demo` **wipes every table** and rebuilds a deterministic dataset — the same
seed always produces the same data, so demos and screenshots are repeatable:

| | |
|---|---|
| 36 players | mixed KYC states (none / pending / done / rejected), avatars, referrers |
| 220 games | 123 completed · 23 cancelled · 17 disputed · 21 running · 15 waiting · 21 open |
| 1,015 ledger entries | stakes, payouts, refunds, commission, bonuses |
| 26 UPI deposit requests | 9 awaiting verification |
| 22 withdrawals | 6 pending, rest paid or rejected |
| 311 notifications, 6 referrals, 14 support messages | |
| Real PNG evidence | generated on disk, so claims and KYC show actual images |

Timestamps are spread over 45 days, so the admin console's range filter returns genuinely
different figures:

| Range | Games | Commission |
|---|---|---|
| 1 day | 21 | ₹17,825 |
| 7 days | 105 | ₹32,695 |
| 30 days | 174 | ₹66,425 |
| All time | 220 | ₹94,310 |

The seeder finishes with a **ledger reconciliation check** — every wallet must equal the
sum of its own transactions, or the run reports a failure. It will not silently produce
books that do not balance.

## API

| Method | Endpoint | Notes |
|---|---|---|
| GET  | `/api/config` | modes, commission, limits — the front end should read rules from here |
| GET  | `/api/health` | liveness |
| POST | `/api/auth/check` | `{ phone }` → `{ exists, hasPassword }`; decides which sign-in screen to show |
| POST | `/api/auth/request-otp` | `{ phone }`, rate-limited 5 / 10 min |
| POST | `/api/auth/verify-otp` | `{ phone, code, referralCode? }` → JWT; creates the account on first use |
| POST | `/api/auth/login-password` | `{ phone, password }` → JWT; 5 wrong tries lock the account for 15 min |
| POST | `/api/auth/set-password` | first-time setup and later changes; returns a fresh token |
| GET  | `/api/auth/me` | profile + wallet + stats |
| PATCH| `/api/users/me` | name, avatar, email |
| POST | `/api/users/kyc` | submit for review |
| GET  | `/api/users/notifications` · POST `/notifications/read` | |
| GET  | `/api/users/referrals` | code, referred players, earnings |
| GET  | `/api/wallet` · `/wallet/transactions` | |
| POST | `/api/wallet/withdraw` | requires KYC; winnings only |
| POST | `/api/wallet/redeem-referral` | referral → deposit balance |
| GET  | `/api/battles?mode=&status=` · `/battles/mine` · `/battles/:id` | |
| POST | `/api/battles` | create; stake debited immediately |
| POST | `/api/battles/:id/accept` · `/cancel` · `/room` · `/result` | |
| GET  | `/api/leaderboard?range=today\|week\|all` | |
| POST | `/api/battles/:id/reject` | creator sends the joiner away; their stake is refunded |
| POST | `/api/uploads/proof` | multipart screenshot upload (JPG/PNG/WebP, 5 MB) |
| POST | `/api/uploads/kyc/:slot` | `front` \| `back` \| `selfie` |
| POST | `/api/wallet/deposit-request` | the only deposit route: amount + UTR, credited after an admin approves |
| GET  | `/api/wallet/deposit-requests` | your pending/approved/rejected requests |
| GET  | `/api/chat` · `/chat/unread` | the player's conversation and unread count |
| POST | `/api/chat/message` · `/chat/read` | send, mark read |
| POST | `/api/support` | |

### Sign-in

First sign-in on a number is an OTP, and the account is then required to create a
password. Afterwards that number signs in with the password, and the OTP becomes the
forgotten-password route. Five wrong passwords lock the *password door* for fifteen
minutes; the OTP door stays open, so nobody can be locked out of their own account.

### Lobby bots

Fifteen house accounts keep battles appearing on the lobby: one is created, a second
bot accepts it two to three seconds later so it lands in **Running**, and it is removed
a few minutes on. They never touch a wallet, never write a ledger row and never settle,
and every admin figure filters them out — so there is no bot commission to report. Real
players cannot join one or open its detail page. Switch them off with `BOT_BATTLES=false`.

### Settings the admin owns

Commission tiers, referral commission, signup and referral bonuses, the withdrawal and
deposit switches, the per-player battle limit, the deposit UPI ID and the player notice
shown on the battles page are all edited in **Admin → Settings** and take effect on the
next request. Rates are typed as percentages in the panel and stored as fractions.

### Admin API (Bearer token from `POST /api/admin/login`)

Create the first account on the server:

```bash
cd server && npm run admin:create -- <username> <password> owner "Your Name"
```

**Roles.** `owner` — everything, including managing admins and site settings.
`admin` — day-to-day operations (disputes, KYC, payouts, chat). `viewer` — read-only.

**Every mutating action is written to an append-only `audit_log`** with the admin's name,
the target, the detail, the IP and the timestamp. Failed logins are recorded too. The
console has an Audit log tab.

| Method | Endpoint | Notes |
|---|---|---|
| POST | `/api/admin/login` | `{ username, password }` → JWT; rate-limited 10 / 15 min |
| GET  | `/api/admin/me` · `/audit` · `/admins` | identity, audit trail, account list |
| GET  | `/api/admin/chats` · `/chats/:id` | agent-side conversations |
| POST | `/api/admin/chats/:id/reply` · `/status` | reply, resolve or block a thread |
| GET  | `/api/admin/stats?range=` | headline numbers for the selected window |
| GET  | `/api/admin/battles?status=&range=&q=` | every game — open, waiting, running, completed, cancelled, disputed — with search |
| GET  | `/api/admin/deposits/all?range=&status=` | UPI requests **and** instant top-ups |
| GET  | `/api/admin/withdrawals?range=&status=` | every withdrawal request |
| GET  | `/api/admin/referrals?range=&type=&q=&limit=` | every referral payout with both ends named; `type=split\|full` filters on whether the rate was halved |
| POST | `/api/admin/withdrawals/:id` | `{ approve }` — paid, or rejected and refunded to winnings |
| GET  | `/api/admin/disputes` | disputed battles with both claims and their screenshots |
| POST | `/api/admin/disputes/:id/resolve` | `{ outcome: creator \| acceptor \| refund }` |
| GET  | `/api/admin/kyc` · POST `/api/admin/kyc/:userId` | queue and approve/reject |
| GET  | `/api/admin/deposits` · POST `/api/admin/deposits/:id` | verify manual UTR deposits |
| POST | `/api/admin/users/:id/penalty` · `/ban` | deduct funds, suspend an account |
| GET/PATCH | `/api/admin/settings` | withdrawals open, deposits open, maintenance, commission, referral rate, battle limit, UPI ID, site notice |

All list endpoints accept `range=1d|7d|30d|all` (default `all`).

Open `admin.html` in a browser and paste the key. It is not linked from the site and
carries `noindex`. Tabs: **Overview** (stat cards, games-by-status, money in/out),
**Players** (search, then a full 360 on one player: wallet buckets, KYC and legal
name, every UPI ID and bank account they have ever withdrawn to, deposits,
withdrawals, referral position in both directions, match history, ledger and
logins), **Referrals** (every referral payout, who was paid, whose game paid it,
and which were halved because both players were referred),
**Games** (all statuses, search by player/id/room code, expandable claims with evidence),
**Disputes**, **Deposits**, **Withdrawals**, **KYC**, **Settings**. A time-range switch
and an auto-refresh toggle apply across every tab, and the tab badges show what is
waiting on you.

**Mobile.** Under 640px the console swaps to a phone layout: sections, time range and
every status filter become native `<select>` dropdowns, and each table row becomes a
labelled card (one renderer, two layouts — see `.rtable` in `admin.html`). Above 640px
it is the chip rows and full tables. Everything an admin can do on a desktop can be done
on a phone, including approving KYC, verifying deposits, paying withdrawals and resolving
disputes with the evidence images.

### Battle rules enforced server-side

- **Max 2 open battles** per user (configurable in admin settings)
- **No two open battles at the same amount** from one user
- **One battle at a time** as a joiner — "you have already enrolled"
- **One result per player** — a second submission is rejected
- A win claim **requires an uploaded screenshot**, stored on disk and shown to support
- The creator may **reject** a joiner: their stake is refunded and the battle reopens

### Withdrawal lifecycle

`request` → funds leave `winnings` immediately and a row lands in `withdrawal_requests`
as `pending`. An admin then either **marks it paid** (ledger entry flips to `success`) or
**rejects it** (the amount is credited back to `winnings` and the ledger entry flips to
`failed`). Nothing is ever stranded.

### Money rules

- All amounts are **integer rupees**.
- Three buckets: `deposit` (spendable, not withdrawable), `winnings` (spendable **and**
  withdrawable), `referral` (must be redeemed into deposit first).
- Spending takes from `deposit` first, then `winnings`.
- Winner receives `round(stake × (2 − rate))` — the commission is charged on **one**
  player's stake, not on the pot. Default tiers: 8% up to ₹500 (inclusive), 5% above it.
  A ₹500 v ₹500 battle takes ₹40 and pays the winner ₹960.
- Referrers earn `referral_rate` (default 1%, set in Admin → Settings) of each
  settled battle stake. **When both players in a battle were referred, each
  referrer earns half that rate** — 0.5% each at the default — so one game never
  costs the house more than one full rate however many referrers it touches.
  Every payout is written to `referral_earnings` as its own row (referrer,
  referee, battle, stake, rate applied, whether it was halved), which is what
  the admin console's **Referrals** tab reads.
- Every balance change is wrapped in a SQLite transaction and written to `transactions`.

### Result settlement

Each player files one claim. **Both must agree** before money moves:

| Player A | Player B | Outcome |
|---|---|---|
| won | lost | A paid out |
| lost | won | B paid out |
| cancel | cancel | both refunded |
| won | won *(or any conflict)* | `disputed` — held for admin review, no payout |

A win claim requires a proof reference. This is stricter than the reference site, which
settles on a single player's word.

### Realtime (Socket.IO)

Emits `battle:created`, `battle:removed`, `battle:updated`, `presence`.
Accepts `battle:watch` / `battle:leave` with `{ id }`.

## Push notifications (free)

Web Push costs nothing: the VAPID key pair is self-generated and delivery runs through
the browser vendors' own push services. No account, no per-message fee.

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"   # then put them in .env
```

`notify()` in `lib/db.js` writes the in-app notification **and** pushes to every device the
user has registered, so battle events, payouts and dispute outcomes all reach the phone.
Dead subscriptions are pruned automatically on a 404/410 — verified against a real 410
endpoint. Permission is requested **after** the user joins a battle, never on page load,
because a denial is permanent.

iOS needs the PWA installed to the home screen (Safari 16.4+); Android/Chrome does not.

## Offline Aadhaar eKYC (free, no UIDAI licence)

The user downloads their own eKYC ZIP from `myaadhaar.uidai.gov.in` (or DigiLocker) and
gives us the 4-character share code. We open the ZIP, verify **UIDAI's XML signature**, and
keep only name, DOB and the last 4 digits. We never call a UIDAI API, so no AUA/KUA
licence is involved and there is no per-check fee.

Auto-approval requires **both**: a valid UIDAI signature **and** a mobile-hash match
against the account's phone number. Anything else falls to manual review.

Set `UIDAI_CERT_PATH` to UIDAI's public certificate (`.cer`, downloaded from uidai.gov.in).
**Without it the signature cannot be checked and every submission goes to manual review** —
which is the safe default, not a silent pass.

> Aadhaar and Indian online-gaming rules change. Confirm with a lawyer that this method is
> acceptable for your use case before relying on it.

## Installable app (PWA)

`manifest.webmanifest` + `sw.js` make the site installable and openable offline.

- **Static shell is cache-first** — the app opens instantly and still opens with no signal
- **API and socket traffic is never cached** — a stale balance is worse than no balance
- **Uploaded evidence is cached after first fetch**, since it never changes
- **Navigations** fall back to cache, then to `offline.html`
- An **install prompt** appears in the header when the browser offers one, dismissible and
  remembered; an **update bar** appears when a new build is deployed
- Verified: service worker active at scope `/`, 20 files cached

## Theme and language

Both controls sit at the **top of the slide-in menu**, above the navigation, and persist
in `localStorage`.

**Dark theme.** The neutral palette (surface, ink, line, muted, plus four accents) is
driven by CSS variables declared on `:root` and swapped under `[data-theme="dark"]`
in `src/input.css`. Brand, action and status colours stay fixed because they read
correctly on both grounds. A tiny inline script in every page `<head>` applies the stored
theme **before first paint**, so there is no white flash for a dark-theme user. With no
explicit choice stored the site follows `prefers-color-scheme` and reacts to OS changes
live. `<meta name="theme-color">` updates too, so the phone browser chrome matches.

**Hindi.** `assets/js/i18n.js` holds a dictionary keyed on the exact English string, so
markup needs no annotation. On load it walks the text nodes plus `placeholder` and
`aria-label` attributes; a `MutationObserver` catches anything rendered later, which is
how the battle lists and toasts get translated. Strings assembled at runtime — "Challenge
from {name}", "Bet amount: X to Y" — call `KhelbroI18n.t()` on their fixed fragments.
`<html lang>` is set to match.

Adding a language is a matter of adding one dictionary to `DICTS` in `i18n.js` and a
button to the drawer.

## Mobile

The site is built mobile-first — a 480px app column that fills the phone and sits beside
the brand panel on desktop. Specifically for touch:

- **No flash of the wrong state.** `data-when` blocks stay invisible until the session
  resolves, so a signed-in user never sees the signed-out screen first.
- **16px inputs**, because anything smaller makes iOS Safari zoom on focus.
- **40px+ tap targets** on chips, play buttons and tile rows, with `active:` press feedback.
- **Busy buttons** — every async action swaps to a spinner and locks, so a slow connection
  never looks like a dead tap (`Khelbro.busy(btn, label, fn)`).
- **Toasts** on success, error, copy, offline and reconnect (`Khelbro.toast`).
- **Skeletons** on every page that fetches before it can render, including the
  bet detail screen and the waiting room — both used to show an empty page (or
  a ₹0 stake) until the API answered.
- **Safe-area padding** for the iOS home indicator.
- Offline/online detection with a toast and an automatic refresh on reconnect.

The admin console gets the same treatment: under 640px its filters become native
`<select>` dropdowns and its tables become labelled cards.

## Status

**Wired and working**
- 16 responsive pages, mobile-first, 480→520 px app column with the desktop brand panel
- Full battle flow on the front end (create / play / cancel / room code / result) against
  the local mock store in `assets/js/store.js`
- Node API with every endpoint above, tested end to end including the dispute path
- `assets/js/api.js` — complete client for that API

### Recently added

Avatar photo upload · email verification (code-based) · 63-bank dropdown on withdrawals ·
splash animation on sign-in · installable PWA with offline support.

### Live chat

Real conversations, not a scripted demo: persisted messages, per-side unread counters,
typing indicators, photo attachments, and an agent-online indicator driven by whether any
admin socket is connected. Socket.IO events: `chat:join`, `chat:message`, `chat:typing`,
`chat:activity`, `chat:admin-online`, `chat:status`. Agent replies also fire a push
notification, so a player gets it with the app closed.

Every "talk to us" route lands in this one thread. The floating support button on
every page, the three buttons under **Talk to us** on the support page, "Contact
Us" in the footer and the contact links on the About page all open the same live
chat — `support.html?chat=1` opens the sheet on arrival, and on the support page
itself the floating button opens it without a reload. The floating button carries
a chat-bubble mark rather than WhatsApp's, because it opens our chat and not
WhatsApp. (The WhatsApp button on **Refer & Earn** is a share sheet for a
referral link, not a support channel, and is unchanged.)

**Not yet wired**
- **No payment gateway.** `POST /wallet/deposit` credits instantly with no PSP. The manual
  UPI + UTR route is real end-to-end (user submits, admin verifies) and is the safer of
  the two until a gateway is integrated.
- **No playable board.** Matches are played in the Ludo King app and settled by room code
  plus screenshot, which is the flow you chose. `src/game/` holds an unused rules engine
  and its tests; nothing loads them.
- Admin auth is a shared key in a header. Replace with real admin accounts before
  production.

## Legal note

This is a demo. Real-money gaming in India carries licensing, GST, KYC and state-level
restrictions (the reference site bars seven states). No payment processing is connected
and nothing here constitutes a compliant real-money product.
