# Khelbro API — Reference

Node + Express + MongoDB + Socket.IO. All responses are JSON. Base path: **`/api`**.

- **Local:** `http://localhost:4000`
- **Deployed:** whatever your API host gives you (e.g. `https://khelbro-api.onrender.com`)

## Authentication

Two independent token systems, both **JWT via `Authorization: Bearer <token>`**:

- **Player token** — from `POST /api/auth/verify-otp`. Protects player routes.
- **Admin token** — from `POST /api/admin/login`. Protects `/api/admin/*`. Roles: `owner` > `admin` > `viewer`.

A player token cannot access admin routes and vice-versa. Banned users and force-logged-out
sessions are rejected with 401/403.

---

## Public

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, at }` |
| GET | `/api/config` | — | modes, deposit/withdraw limits, commission tiers, referralRate, battleLimit, withdrawOpen, depositOpen, maintenance, notice, upiId, qrImage, signupBonus, cancelWindowMs (10 min), claimGraceMs |

## Auth (player)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/check` | `{ phone }` | `{ exists, hasPassword }` — which sign-in screen to show. Rate-limited. |
| POST | `/api/auth/request-otp` | `{ phone }` | `{ ok, expiresIn, devCode? }` — `devCode` only when `EXPOSE_OTP=true`. Rate-limited. |
| POST | `/api/auth/verify-otp` | `{ phone, code, referralCode? }` | `{ token, user, isNew, needsPassword }` — creates the account on first use; pays the signup bonus |
| POST | `/api/auth/login-password` | `{ phone, password }` | `{ token, user }` — 5 wrong tries lock the account for 15 minutes (`code: LOCKED`); the OTP route stays open |
| POST | `/api/auth/set-password` | `{ password, currentPassword? }` 🔒 | `{ ok, token }` — **store the new token**: setting a password bumps the session epoch and signs every other device out. `currentPassword` is required only when one is already set *and* the session came from a password login |
| GET | `/api/auth/me` | — 🔒 | `{ user: {…, hasPassword}, wallet, stats:{played,won} }` |

**Sign-in flow.** First time: `check` → `request-otp` → `verify-otp` → (`needsPassword`) → `set-password`.
Afterwards: `check` → `login-password`. Forgotten: `request-otp` → `verify-otp` → `set-password`.

## Users / profile 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| PATCH | `/api/users/me` | `{ name?, avatar?, email? }` | changing email resets verification; name must be unique |
| POST | `/api/users/kyc` | `{ legalName, dob, idNumber }` | manual KYC → `pending`; 18+ enforced |
| POST | `/api/users/email/verify-request` | — | issues a 6-digit code (`devCode` in dev) |
| POST | `/api/users/email/verify` | `{ code }` | marks email verified |
| GET | `/api/users/notifications` | — | `{ notifications, unread }` |
| POST | `/api/users/notifications/read` | — | mark all read |
| GET | `/api/users/referrals` | — | `{ code, referrals, total }` |

## Wallet 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/wallet` | — | `{ wallet:{deposit,winnings,referral,total} }` |
| GET | `/api/wallet/transactions` | `?type=credit|debit` | last 200 |
| POST | `/api/wallet/deposit-request` | `{ amount, utr, proof? }` | **the only deposit route.** Records the UTR and the user's assigned payment method; nothing is credited until an admin approves it. The screenshot is optional. |
| GET | `/api/wallet/deposit-requests` | — | the caller's requests |
| POST | `/api/wallet/withdraw` | `{ amount, method:'upi'|'bank', upiId? | accountName,accountNumber,ifsc,bankName? }` | requires KYC; **winnings only** — deposit money is never withdrawable |
| POST | `/api/wallet/redeem-referral` | — | move referral earnings into deposit |

## Payments (player) 🔒

| Method | Path | Returns |
|---|---|---|
| GET | `/api/payments/deposit-method` | the UPI id + QR image assigned to this user (spread across active methods) |

## Battles 🔒 (list/get allow anonymous)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/battles` | `?mode=lite|rich&status=open|waiting|running` | open lobby |
| GET | `/api/battles/mine` | — 🔒 | your battles |
| GET | `/api/battles/:id` | — | `{ battle, claims }` |
| POST | `/api/battles` | `{ mode, amount }` 🔒 | stake held immediately; guards: min/max, step multiple, max 2 open, no duplicate amount, sufficient balance |
| POST | `/api/battles/:id/accept` | — 🔒 | join an open battle; guards: not own, not already enrolled, sufficient balance |
| POST | `/api/battles/:id/cancel` | — 🔒 | creator only, while open → refund |
| POST | `/api/battles/:id/reject` | — 🔒 | creator sends the joiner away → refund, battle reopens |
| POST | `/api/battles/:id/room` | `{ roomCode }` 🔒 | creator sets 8-digit code → `running` |
| POST | `/api/battles/:id/result` | `{ claim:'won'|'lost'|'cancel', proof?, reason? }` 🔒 | two-sided settlement; win needs `proof`; conflict → `disputed` |

## Uploads 🔒 (multipart `file`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/uploads/proof` | battle screenshot (JPG/PNG/WebP, ≤5MB) → `{ url }` |
| POST | `/api/uploads/avatar` | profile photo → `{ url }` |
| POST | `/api/uploads/kyc/:slot` | slot = front|back|selfie |
| POST | `/api/uploads/ekyc` | offline Aadhaar ZIP + `shareCode` → parsed identity; auto-approves on valid UIDAI signature + phone match |

## Chat 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/chat` | — | thread + messages + adminOnline |
| GET | `/api/chat/unread` | — | `{ unread }` |
| POST | `/api/chat/message` | `{ body?, kind:'text'|'image'|'voice', attachment? }` | |
| POST | `/api/chat/read` | — | clear unread |

## Push 🔒 (except `/key`)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/push/key` | — | `{ enabled, publicKey }` (VAPID) |
| POST | `/api/push/subscribe` | `{ subscription }` | |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | |
| POST | `/api/push/test` | — | send a test push to self |

## Leaderboard / Support

| Method | Path | Notes |
|---|---|---|
| GET | `/api/leaderboard` | `?range=today|week|all` → ranked winners |
| POST | `/api/support` | `{ topic?, email?, message }` (anonymous ok) |
| GET | `/api/support/mine` 🔒 | your support messages |

---

## Admin API — `/api/admin/*`

`POST /login` and `GET /bootstrap` are public; everything else needs an admin bearer token.
Role required shown as (viewer)/(admin)/(owner).

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/admin/login` | — | `{ username, password }` → `{ token, admin }`. Rate-limited. |
| GET | `/api/admin/bootstrap` | — | `{ needsSetup }` (true if no admins exist) |
| GET | `/api/admin/me` | viewer | current admin |
| GET | `/api/admin/stats` | viewer | `?range=1d|7d|30d|all` — headline numbers |
| GET | `/api/admin/audit` | admin | append-only action log |
| **Players** | | | |
| GET | `/api/admin/players` | viewer | `?q=` search by name/phone/id |
| GET | `/api/admin/players/:id` | viewer | 360° view (wallet, games, tx, devices, referrals) |
| POST | `/api/admin/players/:id/adjust` | admin | `{ amount, bucket, reason }` — manual wallet change (audited) |
| POST | `/api/admin/players/:id/logout` | admin | force-logout (invalidates their token) |
| POST | `/api/admin/players/:id/watch` | admin | `{ watch, reason? }` |
| POST | `/api/admin/users/:id/ban` | admin | `{ banned }` |
| POST | `/api/admin/users/:id/penalty` | admin | `{ amount, reason? }` |
| GET | `/api/admin/watchlist` | viewer | |
| **Money & reporting** | | | |
| GET | `/api/admin/charts` | viewer | daily deposits/withdrawals/signups/commission |
| GET | `/api/admin/revenue` | viewer | commission, payouts, net revenue |
| GET | `/api/admin/pending-money` | viewer | open stakes, pending in/out, disputed |
| GET | `/api/admin/reconcile` | viewer | wallet-vs-ledger integrity check |
| **Fraud & risk** | | | |
| GET | `/api/admin/fraud/multi-account` | viewer | accounts sharing an IP |
| GET | `/api/admin/fraud/collusion` | viewer | suspicious repeat-opponent pairs |
| GET | `/api/admin/withdrawals/risk` | viewer | pending withdrawals scored 0–100 |
| **Games / disputes** | | | |
| GET | `/api/admin/battles` | viewer | `?status=&range=&q=` |
| GET | `/api/admin/disputes` | viewer | disputed battles + both claims/proofs |
| POST | `/api/admin/disputes/:id/resolve` | admin | `{ outcome:'creator'|'acceptor'|'refund', note? }` |
| **KYC** | | | |
| GET | `/api/admin/kyc` | viewer | pending queue + documents |
| POST | `/api/admin/kyc/:userId` | admin | `{ approve }` |
| **Deposits** | | | |
| GET | `/api/admin/deposits` | viewer | pending UPI requests |
| GET | `/api/admin/deposits/all` | viewer | requests + instant top-ups |
| POST | `/api/admin/deposits/:id` | admin | `{ approve, note? }` |
| **Withdrawals** | | | |
| GET | `/api/admin/withdrawals` | viewer | `?status=&range=` |
| POST | `/api/admin/withdrawals/:id` | admin | `{ approve, note? }` — paid, or rejected+refunded |
| **Payment methods (UPI/QR)** | | | |
| GET | `/api/admin/payment-methods` | viewer | list with per-method collection totals |
| POST | `/api/admin/payment-methods` | owner | `{ upiId, label? }` (max 10) |
| PATCH | `/api/admin/payment-methods/:id` | owner | `{ active?, label?, upiId? }` |
| DELETE | `/api/admin/payment-methods/:id` | owner | |
| POST | `/api/admin/payment-methods/:id/qr` | owner | multipart `file` — QR image |
| **Chat (agent)** | | | |
| GET | `/api/admin/chats` | viewer | `?status=open|resolved|blocked` |
| GET | `/api/admin/chats/:id` | viewer | thread + messages |
| POST | `/api/admin/chats/:id/reply` | admin | `{ body?, kind?, attachment? }` |
| POST | `/api/admin/chats/:id/status` | admin | `{ status }` |
| **Admins & settings** | | | |
| GET | `/api/admin/admins` | owner | list admins |
| POST | `/api/admin/admins` | owner | `{ username, name, password, role }` |
| PATCH | `/api/admin/admins/:id` | owner | `{ active?, role? }` |
| GET | `/api/admin/settings` | viewer | current settings |
| PATCH | `/api/admin/settings` | owner | `withdraw_open`, `deposit_open`, `maintenance`, `commission_threshold`, `commission_under`, `commission_from`, `referral_rate`, `signup_bonus`, `referral_bonus`, `battle_limit`, `upi_id`, `notice`. Rates are fractions (0.08 = 8%) and are charged on one player's stake, not the pot; `commission_under` includes the threshold itself. Bonuses are whole rupees. Every value applies to the next request — no restart. |

---

## Realtime (Socket.IO)

Connect to the API origin with the player token in `auth.token`. Admin console emits
`chat:admin-join`.

**Server → client:** `battle:created`, `battle:removed`, `battle:updated`, `presence`,
`chat:message`, `chat:typing`, `chat:activity`, `chat:read`, `chat:status`, `chat:admin-online`

**Client → server:** `battle:watch {id}`, `battle:leave {id}`, `chat:join {threadId}`,
`chat:leave {threadId}`, `chat:typing {threadId,typing}`, `chat:admin-join`

---

## Errors

Standard HTTP codes with `{ error: "message" }`. Common: 400 validation, 401 not signed in,
403 role/permission or banned, 404 not found, 409 conflict (duplicate/wrong state), 429 rate
limited, 503 deposits/withdrawals closed.

---

## Deploying the API

**Stack:** Node ≥ 20, MongoDB (Atlas). Root directory: `server/`.

```
Build command:  npm install
Start command:  npm start
```

**Required env vars:**

| Var | Value |
|---|---|
| `MONGO_URI` | your Atlas string ending in `/khelbro` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `CORS_ORIGIN` | your frontend URL (e.g. `https://ludo-ludo19.vercel.app`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `node -e "console.log(require('web-push').generateVAPIDKeys())"` |
| `VAPID_SUBJECT` | `mailto:you@domain.com` |
| `UPLOAD_DIR` | `./data/uploads` (put on a persistent disk so images survive) |
| `EXPOSE_OTP` | leave unset in production |

**First run:** `npm run admin:create -- <username> <password> owner "Your Name"`

**Uploaded files** are served at `/uploads/*` (static). On a host with an ephemeral
filesystem, mount a persistent disk at `UPLOAD_DIR` or move to S3/R2.
