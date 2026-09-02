# Khelbro — Feature List

*Generated 28 August 2026. 24 player pages + 1 admin console · 2,697 lines server ·
3,000 lines client · 10.6 KB CSS gzipped · 18 database tables.*

---

## 1. Accounts & identity

| Feature | Status |
|---|---|
| Mobile OTP sign-in (6-digit, 5-min expiry, 5-attempt cap) | ✅ |
| Auto account creation on first sign-in | ✅ |
| JWT sessions (7-day) | ✅ |
| Rate limiting on OTP requests (configurable) | ✅ |
| Display name with uniqueness check | ✅ |
| Avatar — 8 built-in glyphs **or** upload your own photo | ✅ |
| Email address + **code-based verification** (resets if email changes) | ✅ |
| Referral code per account, applied at signup | ✅ |
| Ban / suspend from admin | ✅ |
| **Real SMS delivery** — OTP currently logs to console | ❌ needs gateway |
| **Real email delivery** — codes log to console | ❌ needs provider |

## 2. KYC

| Feature | Status |
|---|---|
| **Offline Aadhaar eKYC** — ZIP + share code, UIDAI signature verified, instant | ✅ |
| Mobile-hash match against the account's phone before auto-approval | ✅ |
| Manual route — ID front, back, selfie, admin review | ✅ |
| Documents stored on disk, shown to reviewers | ✅ |
| Status gates withdrawals (`none / pending / done / rejected`) | ✅ |
| Aadhaar **OTP** authentication | ❌ needs AUA licence — not free |

## 3. Wallet & money

| Feature | Status |
|---|---|
| Three balances: deposit, winnings, referral | ✅ |
| Spend order: deposit first, then winnings | ✅ |
| Withdrawable = winnings only | ✅ |
| Double-entry ledger, every change recorded | ✅ |
| Instant deposit (simulated) with 5% cashback ≥ ₹500 | ✅ |
| **Manual UPI deposit** — copy UPI ID, submit UTR, admin verifies | ✅ |
| 28% GST breakdown on the add-cash screen | ✅ |
| Withdrawal queue — UPI or bank, 63-bank dropdown, IFSC validation | ✅ |
| Withdrawal approve / reject with automatic refund on reject | ✅ |
| Referral earnings, redeemable into deposit balance | ✅ |
| Transaction history with filters | ✅ |
| Penalties applied by admin | ✅ |
| **Payment gateway (Razorpay)** | ❌ needs merchant keys |

## 4. Battles

| Feature | Status |
|---|---|
| Two tables — Lite (₹50–25,000) and Rich (₹25,000–1,00,000) | ✅ |
| Create a battle; stake held immediately | ✅ |
| Amount validation: range + step multiples | ✅ |
| **Max 2 open battles per user** (configurable) | ✅ |
| **No two open battles at the same amount** | ✅ |
| **One battle at a time as joiner** ("already enrolled") | ✅ |
| Open Battles / Running Battles lists | ✅ |
| Play an open battle; both stakes held | ✅ |
| Creator can cancel while open → full refund | ✅ |
| Creator can **reject a joiner** → their stake refunded, battle reopens | ✅ |
| 8-digit room code, copy to clipboard | ✅ |
| Waiting room with live opponent detection | ✅ |
| Result submission: won / lost / cancel + cancel reasons | ✅ |
| **Screenshot required for a win**, stored and shown to reviewers | ✅ |
| **One result per player** — second submission rejected | ✅ |
| **Two-sided settlement** — both must agree before money moves | ✅ |
| Conflicting claims → `disputed`, funds held, no auto-payout | ✅ |
| Payout = pot − (rate × one stake); 8% up to ₹500, 5% above (server-configured) | ✅ |
| Referrer earns 2% of each settled stake | ✅ |
| Game history with status filters and pagination | ✅ |
| **Playable Ludo board** | ❌ by your decision — rules engine + 28 tests exist unused |

## 5. Realtime

| Feature | Status |
|---|---|
| Live lobby — battles appear/disappear across users | ✅ |
| Live battle room — opponent joins, room code, settlement | ✅ |
| Connection indicator in the header | ✅ |
| Polling fallback where websockets are blocked | ✅ |
| Events: `battle:created/removed/updated`, `presence` | ✅ |

## 6. Live support chat

| Feature | Status |
|---|---|
| Persistent conversations, one thread per player | ✅ |
| Per-side unread counters | ✅ |
| Typing indicators, both directions | ✅ |
| Photo attachments | ✅ |
| Agent-online indicator (driven by real agent sockets) | ✅ |
| Quick-reply chips | ✅ |
| Agent replies fire a **push notification** | ✅ |
| Resolve / block a conversation | ✅ |
| FAQ accordion + contact form | ✅ |
| Voice messages | ❌ |

## 7. Notifications

| Feature | Status |
|---|---|
| In-app notification centre, mark all read | ✅ |
| **Web push** (free — self-generated VAPID keys) | ✅ |
| Push on: opponent joined, room code, win/loss, payout, dispute, chat reply | ✅ |
| Permission asked *after* joining a battle, never on load | ✅ |
| Dead subscriptions pruned on 404/410 | ✅ |

## 8. Growth

| Feature | Status |
|---|---|
| Referral code, copy + WhatsApp share | ✅ |
| Referral history and earnings | ✅ |
| Redeem referral → deposit balance | ✅ |
| Leaderboard — today / week / all-time, podium + table | ✅ |

## 9. Experience

| Feature | Status |
|---|---|
| Mobile-first 480px app column; desktop brand panel | ✅ |
| **Dark theme** — CSS variables, follows OS, no flash on load | ✅ |
| **Hindi language** — full UI incl. dynamic content | ✅ |
| Both controls at the top of the slide-in menu | ✅ |
| **Installable PWA** — manifest, service worker, offline page | ✅ |
| Install prompt + update bar | ✅ |
| Toasts on success / error / copy / offline / reconnect | ✅ |
| Loading skeletons on every fetching page | ✅ |
| Busy buttons with spinners on async actions | ✅ |
| 16px inputs (no iOS zoom), 40px+ tap targets, safe-area padding | ✅ |
| Offline/online detection with auto-refresh | ✅ |
| Keyboard-accessible drawer with focus trap, ARIA labels | ✅ |
| `prefers-reduced-motion` respected | ✅ |

## 10. Admin console

| Feature | Status |
|---|---|
| **Individual accounts**, bcrypt passwords, JWT | ✅ |
| **Three roles** — owner / admin / viewer, enforced server-side | ✅ |
| **Append-only audit log** — who, what, target, detail, IP, time | ✅ |
| Failed logins recorded | ✅ |
| Self-deactivation blocked | ✅ |
| Overview: players, games, commission, "needs attention" | ✅ |
| Games list — all statuses, search, expandable claims + evidence | ✅ |
| Dispute resolution with both screenshots side by side | ✅ |
| KYC queue with documents, approve / reject | ✅ |
| Deposits — UPI requests + instant top-ups | ✅ |
| Withdrawals — approve (paid) / reject (auto-refund) | ✅ |
| Live chat console with reply, resolve, block | ✅ |
| Admin management (owner only) | ✅ |
| Site switches — withdrawals, deposits, maintenance, commission, limits, UPI ID, notice | ✅ |
| Time range 1 day / 7 days / 30 days / all time, across every tab | ✅ |
| Mobile layout — dropdown filters, tables become labelled cards | ✅ |
| Live counts, auto-refresh, toasts, skeletons, dark theme | ✅ |

## 11. Content

Home · Battle lobby · Battle room · Waiting room · How to Play · Leaderboard · Profile ·
Wallet · Add Cash · Withdraw · Redeem · Game History · Transactions · Refer & Earn ·
Notifications · KYC · Login · Support · Terms · Privacy · Refund Policy ·
Responsible Gaming · About · Offline

## 12. Engineering

- **18 tables**: users, wallets, otps, transactions, battles, battle_claims, notifications,
  referrals, admin_users, audit_log, push_subscriptions, withdrawal_requests,
  kyc_documents, settings, deposit_requests, chat_threads, chat_messages, support_messages
- Every money operation inside a database transaction; ledger reconciles against wallets
- zod validation on every input; helmet, CORS allow-list, rate limiting
- Static site build (no framework) — 10.6 KB CSS, no runtime dependency
- Deterministic demo seeder with a built-in reconciliation check
- 28 passing unit tests on the Ludo rules engine (unused, kept for later)

---

## Still missing

| Gap | Blocker |
|---|---|
| Payment gateway (Razorpay) | Your merchant keys |
| SMS gateway for real OTP | Account + Indian DLT registration |
| Email sending | Provider account |
| Aadhaar OTP authentication | AUA/KUA licence — not free, and restricted for gaming |
| Voice messages in chat | Not built |
| Playable Ludo board | Your decision to skip |
| MongoDB + hosting | Needs your Atlas and host accounts |
