# KheloAdda Rebuild — Phase 1 Design Spec

Reference: `https://kheloadda.club/`
Analysed: 2026-08-28 — from the live DOM, computed styles, the production CSS bundle
(`main.2e959cf9.css`, 708 KB) and the production JS bundle (`main.a523ed3f.js`, 985 KB).

The reference is a **Create React App SPA**, jQuery + Bootstrap 5 + MUI v4 + W3.CSS +
Font Awesome + DataTables + Socket.IO, served as a PWA (manifest, service worker,
`apple-mobile-web-app-capable`).

---

## 1. Layout model (the single most important thing to copy)

The whole site is a **fixed 480 px mobile column** pinned to the left of the viewport,
with a decorative brand panel filling the rest of the screen on desktop. It is not a
responsive desktop site — it is a phone app rendered inside a desktop window.

```
Desktop (≥ 481px)                     Mobile (≤ 480px)
┌──────────┬────────────────────┐     ┌──────────────────┐
│ .left    │ .rightContainer    │     │ .leftContainer   │
│ Container│ fixed, left:480px  │     │ width:100%       │
│ 480px    │ blue + ray bg      │     │                  │
│ the app  │ big logo, bouncing │     │ .rightContainer  │
│          │ (decorative only)  │     │ display:none     │
└──────────┴────────────────────┘     └──────────────────┘
```

| Element | Rule |
|---|---|
| `#root` | `display:flex; height:100vh` |
| `.leftContainer` | `max-width:480px; width:100%; background:#f9f9f9; min-height:100%; position:relative` |
| `.headerContainer` | `position:fixed; top:0; z-index:2; height:60px; max-width:480px; width:100%; display:flex; align-items:center; justify-content:space-between; padding:0 10px; background:#2d68c4; box-shadow:0 .125rem .25rem rgba(0,0,0,.08)` |
| `.main-area` | `padding-top:60px` (clears the fixed header), `width:100%; overflow:hidden` |
| `.rightContainer` | `position:fixed; top:0; bottom:0; left:480px; right:0; z-index:4; background:#2d68c4 url(rays.svg) 50%/cover no-repeat; background-blend-mode:soft-light; border-left:10px solid #e0e0e0` |
| `.rcBanner-img-container` | `position:absolute; bottom:30%; width:300px`, image `transform:scale(1.8)`, class `animate__bounce infinite` |

**Breakpoint: there is effectively only one — 480px.** Everything else in the bundle
is unused vendor CSS. That is the entire responsive strategy.

---

## 2. Colour palette (exact hex, in-use only)

### Brand
| Token | Hex | Used for |
|---|---|---|
| `--brand-blue` | `#2d68c4` | Header bar, sidebar, right panel, login page bg, splash gradient |
| `--brand-blue-dark` | `#253d76` | Sticky footer gradient end |
| `--brand-blue-mid` | `#3d80c5` | Sticky footer / button gradient start |
| `--brand-indigo` | `#3e51b5` | LOGIN button text + border (header, logged-out) |
| `--link-blue` | `#4b85f3` | Room-code value text |
| `--gold` | `#f4bc41` | Referral-badge ring, `box-shadow 0 0 .2rem`, button borders |

### Action
| Token | Hex | Used for |
|---|---|---|
| `--green-cta` | `#0db25b` | Primary CTA (`.Login-button`, `.bg-green`) |
| `--green-withdraw` | `#55da60` | Withdraw button |
| `--green-wa` | `#25d366` | WhatsApp FAB (gradient `#2fe676 → #25d366 45% → #1faa52`) |
| `--green-success` | `#28a745` | PWA "Install" pill |
| `--red-live` | `#ff2b2b` / `#fc424a` | LIVE pulse text / `.text-danger` |
| `--teal-overlay` | `#008cba` | Game-card hover overlay |

### Neutrals
| Token | Hex | Used for |
|---|---|---|
| `--ink` | `#2c2c2c` | Primary text, titles, money values |
| `--ink-body` | `#2e383e` | `body` default colour |
| `--muted` | `#959595` | Section headlines, footer links, labels |
| `--muted-dark` | `#676767` | Collapse-card title, chevron icon |
| `--line` | `#e0e0e0` | All card borders, dividers, right-panel border |
| `--line-2` | `#ededed` | Money-box border + "+" button bg |
| `--divider` | `#f1f1f1` | 10px `.divider-x` block separators |
| `--surface` | `#ffffff` | Cards, sections |
| `--surface-alt` | `#fafafa` | `.collapseCard-container`, chat body |
| `--page` | `#f9f9f9` | `.leftContainer` page bg |
| `--page-alt` | `#f8f7f7` | `.battleCard-bg` |
| `--chip` | `#f8f8f8` | Money box bg |
| `--chat-dark` | `#161616` | Support-chat header |
| `--overlay` | `rgba(0,0,0,.5)` | Sidebar scrim |

### Odd ones actually rendered
`#dfa8ff` bet-card subtitle · `#f5e3ff` bet-card title underline · `#cfb7ab` right-panel
caption · `#e8eeee` room-code block · `#100068` / `#000051` withdrawal & referral text.

> Note: ~40 further hex values exist in the bundle (`#0090e7`, `#8f5fe8`, `#fc424a`…) —
> these are from an unused "Purple Admin" vendor theme. **Do not copy them.**

---

## 3. Typography

Seven font families are loaded. This is a bug in the original, not a design system:

| Family | Where it actually lands | Loaded from |
|---|---|---|
| **Roboto** 400/500/700/900 | Everything — `*{font-family:Roboto}` | Google Fonts |
| **Rubik** 300–700 | `body` (overridden almost everywhere) | Google Fonts |
| **Saira Semi Condensed** | `<picture>`, some sections — a later `*{}` rule | Google Fonts |
| **Dosis** 600 | `h1`–`h6` | Google Fonts |
| Roboto Condensed | `.rcBanner-text` only | Google Fonts |
| Poppins | Withdrawal/bank labels only | Google Fonts |
| Open Sans, Luckiest Guy | Loaded, never used | Google Fonts |

**Recommendation for the rebuild:** ship **two** families — Roboto (UI) and one display
face for headings/logo lockups. Drop the other five. Saves ~5 render-blocking requests.

### Type scale
Base is **15px** (not 16). Everything is `em`-relative, so real px values are:

| Class | em | px | Weight | Colour |
|---|---|---|---|---|
| `.font-15` ("Sign in") | 1.5em | 22.5 | 700 | #fff |
| `.rcBanner-text` | 2em | 30 | 400 / 900 bold variant | #cfb7ab |
| `.rcBanner-footer` | 1.5em | 22.5 | 400, line-height 32px | #fff |
| `.Profile_header_text` | 1.2em | 18 | 600 | #2c2c2c |
| `.games-section-title` | 1em | 15 | **100** | #2c2c2c |
| `.footer-links > a` | 1.1em | 16.5 | 400 | #959595 |
| `.Profile_mytext` | .95em | 14.25 | 400, lh 21px | #2c2c2c |
| `.footer-text` | .9em | 13.5 | 400 | #959595 |
| `.betCardAmount` | .9em | 13.5 | 900 | inherit |
| `.moneyBox_text` | .8em | 12 | 900 | #2c2c2c |
| `.games-section-headline` | .75em | 11.25 | 400, lh 18px | #959595 |
| `.battleCard .players` / `.amount` | .75em | 11.25 | 700 / 1000 | #959595 |
| `.collapseCard-title` | .7em | 10.5 | 700, uppercase | #676767 |
| `.playButton` | .7em | 10.5 | 700, uppercase | #fff |
| `.betCard_playerName` | .7em | 10.5 | 500 | inherit |
| `.betCard-title` | .65em | 9.75 | 700 | #2c2c2c |
| `.moneyBox_header` | .6em | 9 | 500, uppercase | #959595 |
| `.betCardSubTitle` | .55em | 8.25 | 500, uppercase | #dfa8ff |
| Login footer legal | .75em | 11.25 | 400, lh 15px | #fff |

> 8–11px body copy fails WCAG readability on phones. In Phase 4 I'll floor UI text at
> 12px and legal text at 11px while keeping the visual hierarchy.

---

## 4. Spacing, radius, elevation

- **Spacing:** no token system. Bootstrap utilities (`p-3`, `mt-1`, `mx-5`, `py-4`) on a
  1rem = 15px base → the real ladder is `3.75 / 7.5 / 15 / 22.5 / 45px`.
  Section padding is `15px`; `.collapseCard-container` is `30px 20px 20px`;
  card content `15px 20px 10px`.
- **Radius:** `3px` (money box, LOGIN btn) · `5px` (cards, CTAs, inputs) ·
  `10px` (battle card, sidebar icon tiles, chat bubbles) · `12px` (chat panel) ·
  `14px` (PWA install pill) · `16px 16px 0 0` (bottom sheets) · `20px` (chat input) ·
  `50%` (avatars, FAB).
- **Shadows:** header `0 .125rem .25rem rgba(0,0,0,.08)` · bottom sheet
  `0 -3px 8px rgba(0,0,0,.12)` · chat card `0 1px 4px rgba(0,0,0,.06)` ·
  FAB `0 4px 14px rgba(37,211,102,.45)`.
- **Dividers:** a solid **10px tall `#f1f1f1` block** (`.divider-x`) between sections —
  a signature of this layout. Also `1px #e0e0e0` hairlines inset `left:57px`.

---

## 5. Page-by-page structure

### 5.1 Header — logged OUT
`[ logo 64×64 → / ]` ······· `[ LOGIN ]`
LOGIN = white bg, `1px solid #3e51b5`, `#3e51b5` text, radius 3px, 30px tall,
`padding 2px 21px`, font-weight 700, `margin-right:10px`.

### 5.2 Header — logged IN
`[ ☰ 16.5×14 ]` `[ logo 64×64 ]` ····· `[ ₹ Cash ▸ + ]` `[ 🏆 Earning ]`

- Money box: `min-width:90px; height:30px; bg #f8f8f8; border 1px #ededed; radius 3px`
- Label `CASH` / `EARNING` — 9px, 500, uppercase, `#959595`
- Value — 12px, 900, `#2c2c2c`
- "+" tab — `17px` wide, `#ededed`, full height, links to `/addcase`
- Cash box → `/wallet`, Earning box → `/redeem/refer`
- A "Download App for Better Experience" + green **Install** pill appears when the PWA
  `beforeinstallprompt` fires.

### 5.3 Sidebar drawer (logged in)
`.w3-sidebar` — `position:fixed; left:-500px; width:70%; max-width:300px; height:100vh;
background:#2d68c4; transition:all .5s; z-index:99999999`. Opens by setting `left:0`;
`#sidebarOverlay` (`rgba(0,0,0,.5)`, fills viewport) fades in and closes on click.

Items are `74px` tall, full width, `#2d68c4`, white text, icon tile
(`28×28`, `bg #eee`, `1px solid #fff`, `radius 10px`, `padding 5px`) + label:

1. My Profile (avatar) → `/Profile`
2. Dashboard → `/dashboard`
3. Win cash → `/landing`
4. My wallet → `/wallet`
5. Game History → `/Gamehistory`
6. Transaction History → `/transaction-history`
7. Refer and Earn → `/refer`
8. Refer History → `/Referral-history`
9. Notification → `/Notification`
10. Support → `/support`
11. Logout (POSTs `/logout`, clears `authToken`, reloads)

### 5.4 Home `/`
1. **Carousel** — Bootstrap `carousel-fade`, `bg #eee`, `1px solid #eee`, radius 5px,
   slide images 80px tall, prev/next chevrons. Sits in `.collapseCard-container` (`#fafafa`).
2. **"Our Tournaments"** — `.games-section` (`bg #fff`, padding 15px).
   - Title `.games-section-title` (15px / weight 100 / `#2c2c2c`)
   - `.games-window` — `display:flex; flex-wrap:wrap; justify-content:space-between`
   - `.gameCard-container` — **`width:46.8%`** (two-up grid)
   - Above each card: a blinking `◉ LIVE` in `#fc424a`, right-aligned
   - `.gameCard-image` — `height:68.33%`, radius 5px
   - `.gameCard-title` — `1px solid #e0e0e0`, no top border, `radius 0 0 5px 5px`,
     `padding 15px 20px 10px`, 700, `#2c2c2c`
   - **Hover:** `.goverlay` — `#008cba`, `opacity 0 → 1`, `transition .5s ease`,
     centred white 20px label ("Comming Soon")
   - Cards link to `/HomePage/ludo-classic-light-mode` (₹50–₹25 000) and
     `/HomePage/ludo-classic-rich-mode` (₹25 000–₹1 00 000)
3. **Footer collapse card** — `.collapseCard-container` (`#fafafa`, `30px 20px 20px`)
   with a floating `.collapseCard-header` label overlapping the top border at `top:-13px`.
   Row: logo tile 56px (`bg #eee`, radius 10px, padding 5px) + ". Terms, Privacy, Support"
   + `mdi-chevron-down` at 21px. Expands to reveal the six legal links.
4. **WhatsApp FAB** — `position:fixed; right:25px; bottom:95px; 58×58; radius 50%;
   background:linear-gradient(145deg,#2fe676,#25d366 45%,#1faa52);
   box-shadow:0 4px 14px rgba(37,211,102,.45)`.

### 5.5 Login `/login`
- Full-bleed `#2d68c4`. A dice photo sits behind the top ~45% with
  `.splash-overlay` = `linear-gradient(180deg, transparent -315px, #2d68c4 283.5px)`
  fading it into the flat blue.
- `.splash-screen` runs `splashAnim 22s linear infinite` (slow pan).
- **"Sign in"** — 22.5px / 700 / white, centred.
- White card wrapper containing: `+91` prefix chip (`#f0f0f0`-ish, 13px) +
  `input[name=mobile]` (`1px solid #d8d6de`, radius 4px, focus border `#7367f0`).
- **CONTINUE** — `.Login-button`: `bg #0db25b; width:85%; height:48px; radius 5px;
  color #fff; font-weight 900; text-transform:uppercase; border:none`.
- **OTP step** (same screen, state swap): 4–6 digit input, `.login-timer`
  (right-aligned, 85% wide) counting "Resend OTP in {n}", then a resend link.
- Legal block — `.login-footer`: white 11.25px, `padding:120px 10px 0`, `max-width:480px`,
  `position:sticky; bottom:0`. Links are `#ffd54f` underlined, hover `#ffe082`.
  Text names the seven states where play is barred.

### 5.6 Wallet `/wallet`, Add Cash `/addcase`, Withdraw `/Withdrawopt`, `/Redeem`
- `.wallet` tile — `1px solid #e0e0e0`, radius 5px, height 70px, full width.
- Balance split into **Cash won** ("Can be withdrawn to Paytm or Bank") vs
  **Deposit cash** ("Cannot be withdrawn") vs **Referral earning**.
- Add-cash: amount chips + free entry, `Min: 100, Max: 10000`, validation
  "Minimum deposit is 100" / "Amount should be more than 95"; a **28% GST** line
  ("GOVT TAX (28% GST)", "Deposit Amount (excl. Govt. Tax)").
- Payment rails present in the bundle: Razorpay order, UPI (`depositeupi`, Decentro),
  PhonePe, MyPay, and a manual UTR-entry flow ("Enter UTR Number", "Copy UPI ID").
- Withdraw: choose UPI / Bank transfer / Paytm; a full **Indian bank dropdown** (~60 banks);
  fields Account holder name, Account number, IFSC; "Instant withdrawal within 30sec";
  `.withdrawl_btn` `bg #55da60`, radius .3rem, uppercase.

### 5.7 Profile `/Profile`, KYC `/Aadhar`, `/kyc2`
- Avatar picker (`/Images/avatars/Avatar1.png` …, 50×50 grid), editable username,
  email, DOB, "Battle Played" stat, referral code with copy.
- KYC bottom sheet: `border-radius:16px 16px 0 0`, `transform:translate3d(0,360px,0)`
  → `translateZ(0)` on enter, `transition .2s cubic-bezier(0,0,.3,1)`, scrim
  `#2c2c2c` fading opacity, `max-height:88%`.
- Aadhaar: 12-digit number, front photo, back photo, selfie holding Aadhaar,
  "SUBMIT FOR REVIEW" → "KYC pending admin approval".

### 5.8 Battle lobby `/landing`, `/HomePage/:Game`
- **Create a Battle!** — amount input (`.Home_formControl`), "Set Battle in denomination
  of 10 / 50", range ₹50–₹25 000.
- **Open Battles** list — `.betCard`: title bar `.betCard-title`
  (`border-bottom:1px solid #f5e3ff`, height 30px, 9.75px/700), creator avatar 25px round
  + name, amount with `.betCardAmount` (13.5px/900), subtitle in `#dfa8ff`.
- **Running Battles** — two avatars vs each other.
- `.playButton` — `position:absolute; right:10px; bottom:10px; height:30px;
  padding:0 22px; radius 5px; bg #0db25b; 10.5px/700 uppercase white`.
- Flow: create → opponent accepts → **"Finding Player!" / "Prepare for an exciting match!"**
  → room-code screen: `.battleCard .roomCode` (`bg #e8eeee`, radius 10px, `margin 30px 20px`,
  `padding 30px 20px`) with the code in `#4b85f3` 22.5px/700 and "Room Code Copied" toast.
  Validation: "Invalid room code. It must be exactly 8 digits."
- **Result submission** — radio group (I Won / I Lost / Cancel), screenshot upload,
  "For cancellation of game, video proof is necessary", cancel reasons
  ("Opponment Abusing", "Game Not Start", "Don't want to Play").

### 5.9 Game board `/gameboard`, `/waiting-room`
`.game_gameContainer` — `background:linear-gradient(180deg,#a00000,#7d0000);
color:#fff; min-height:100vh; padding-top:50px`. Socket events `game:roll`,
`game:move`, `game:winner`, `room:create`, `room:data`, `room:exit`.
A `Dice_container` CSS module and a `1_second_tone.mp3` asset exist.
*(On the live site this is a room-code handoff to the real Ludo King app — the board
itself is a stub. This is exactly the gap Phase 3 fills.)*

### 5.10 Support `/support`, `/chat`
`/support` is **not** the chat — it is a contact hub (illustration + three stacked
buttons, see §12.5). The chat is the floating panel launched from the FAB.

Floating chat panel, `max-width` snaps to full width under 450px, `border-radius 14px 14px 0 0`.
Header `#161616`, body `#fafafa`, bubbles radius 10px / 14px / max-width 85%,
quick-reply pills (`1px solid #2c2c2c`, radius 20px, hover inverts to `#2c2c2c` bg),
input radius 20px, file + voice message upload, typing indicator, unread badge,
"Select Your Issue" intake, Hinglish copy ("Message likho…", "Chat End Karo?"),
plus Telegram and WhatsApp escape hatches.

### 5.11 Static pages
`/term-condition`, `/PrivacyPolicy`, `/RefundPolicy`, `/refund-policy`, `/contact-us`,
`/about`, `/responsible-gaming`, `/Gamerules`, `/Rules` — long-form text on white,
`.Profile_mytext` 14.25px / line-height 21px.

---

## 6. Interaction inventory

### Buttons
| Name | Style |
|---|---|
| Primary CTA | `#0db25b`, white, 900, uppercase, h48, r5, w85% |
| Play (in-card) | absolute br, `#0db25b`, h30, r5, 10.5px/700 uppercase |
| Secondary | `#6c757d`, white, 700, r5, hover `#545b62` |
| LOGIN (header) | white on blue bar, `1px solid #3e51b5`, r3, h30 |
| Withdraw | `#55da60`, r.3rem, uppercase |
| Gold-bordered | `linear-gradient(#3d80c5,#253d76)`, `2px solid #f4bc41`, r14 |
| Chat quick reply | ghost pill, `1px solid #2c2c2c`, r20, hover fills |
| WhatsApp FAB | 58px circle, green gradient, glow shadow |

### Forms
`+91` prefix + 10-digit mobile · OTP with resend countdown · amount entry with min/max ·
MUI underline text fields (`:before 1px rgba(0,0,0,.42)`, `:after 2px #3f51b5 scaleX(0)→1`) ·
MUI radio groups · bank `<select>` · file upload with name + size chips ·
IFSC / Aadhaar / UPI / email regex validation.

### Modals & overlays
SweetAlert2 alerts · bottom sheets (`translate3d(0,360px,0)` → `0`, `.2s
cubic-bezier(0,0,.3,1)`, radius `16px 16px 0 0`, scrim opacity fade) ·
sidebar drawer + scrim · react-hot-toast toasts · `.blink-overlay`
(full-screen black, `blinkBlack 1s infinite`) used as an attention flash.

### Animations
| Name | Definition |
|---|---|
| `animate` (`.blink`) | `opacity 0 → .5 → 1`, 1s linear infinite |
| `TournamentBanner_blink` | `opacity 1 → 0 → 1`, 1s infinite, red |
| `TournamentBanner_heartbeat` | `scale 1→1.15→1→1.1→1` + red `text-shadow` pulse, 1.2s |
| `splashAnim` | 22s linear infinite pan on the login dice image |
| `leftToRight` | `left:-500px → 0` (drawer) |
| `blinkBlack` | full-screen black flash, 1s infinite |
| `animate__bounce infinite` | Animate.css, on the right-panel logo |
| Sidebar | `transition:all .5s` |
| Card overlay | `transition:.5s ease` on opacity |
| **`*{transition:all .5s ease}`** | ⚠️ global — animates every property on every element |

> The global `transition:all .5s` and `animate__bounce infinite` are the two biggest
> perf/UX problems in the original. I'll use scoped transitions (150–300ms on
> `transform`/`opacity`/`background-color`) and honour `prefers-reduced-motion`.

### Hover states
`a:hover → #0056b3` (later overridden to `#6c7293`) · game card → teal overlay fade ·
`#hambergar:hover → #fff` bg · chat pills invert · WhatsApp FAB lifts.
**Everything else has no hover** — it was designed touch-first.

---

## 7. Complete functionality inventory

All 37 routes from the bundle, and what each does.

**Public:** `/` home · `/login` OTP sign-in · `/about` · `/contact-us` ·
`/term-condition` · `/PrivacyPolicy` · `/RefundPolicy` + `/refund-policy` ·
`/responsible-gaming` · `/Gamerules` · `/Rules` · `*` 404.

**Account:** `/Profile` (avatar picker, username, email, DOB, stats) ·
`/Aadhar` + `/kyc2` (Aadhaar KYC, 3 uploads, admin review) · `/Notification` · `/notify`.

**Money:** `/wallet` (3 balances) · `/addcase` (Razorpay, UPI, Decentro, PhonePe, MyPay,
manual UTR, 28% GST) · `/Withdrawopt` (UPI / bank / Paytm, ~60-bank list, IFSC) ·
`/Redeem` (referral → cash) · `/transaction-history` · `/return`.

**Growth:** `/refer` (code + WhatsApp share) · `/Referral-history` · `/landing/:id`
(referral deep link) · `/dashboard`.

**Game:** `/landing` (battle lobby) · `/HomePage/:Game` + `/MyLudoHomePage/:Game`
(lite ₹50–25k / rich ₹25k–1L) · `/waiting-room` ("Finding Player!") ·
`/gameboard` · `/viewgame1/:id` · `/Gamehistory`.

**Support:** `/support` · `/chat` (live agent chat, file + voice, quick replies,
unread counts, Telegram/WhatsApp fallback).

**Realtime (Socket.IO):** `room:create` `room:data` `room:exit` `game:roll` `game:move`
`game:winner` `gameCreated` `acceptGame` `challengeAccepted` `gameRejected` `deleteGame`
`joiningStatusUpdated` `updateWaitingStatus` `roomCode` `popularroomCode` `guestJoined`
`player:login` `supportChat` `typing` `message:delivered` `adminOnline` `endChat`
`chatBlocked` `chatReopened` `chatResolved` `fileMessage` `voiceMessage`.

**Platform:** PWA install prompt · service worker + offline mode · push notifications ·
JWT in `localStorage.authToken` · Cloudflare analytics · Google site verification.

---

## 8. What I'm mapping to YOUR six pages

| Your page | Source | Notes |
|---|---|---|
| **Home** | `/` | Carousel + game grid + collapse footer, 1:1 |
| **How to Play** | `/Gamerules` + `/Rules` | Restyled as a real illustrated rules page |
| **Leaderboard** | `/dashboard` | **Correction:** it does exist — see §12.6 for exact markup |
| **Wallet / Profile** | `/wallet` + `/Profile` | **UI shell with mock data only** |
| **Login (OTP)** | `/login` | Full two-step, client-side mock OTP |
| **Support** | `/support` + `/chat` | Chat UI + FAQ accordion, no live backend |

One thing to flag, then I'll build exactly what you asked: the reference is a real-money
platform, so its wallet/KYC/GST flows carry licensing, payment-gateway and state-by-state
legal obligations (its own copy bars seven Indian states). I'm building those screens as a
**visual shell with fake data and no payment integration** — that keeps Phase 2 shippable
as a demo. Wiring real payments is a separate decision for you, with a real backend.

---

## 9. Component list for Phase 2

**Layout:** `AppShell` · `LeftContainer` · `RightPanel` · `Header` (2 states) ·
`Sidebar` + `Scrim` · `MainArea` · `DividerX` · `CollapseCard` · `BottomSheet`

**Nav:** `Logo` · `HamburgerButton` · `MoneyBox` (label/value/+ tab) · `SidebarItem` ·
`FooterLinks` · `TabBar`

**Content:** `Carousel` · `SectionTitle` · `SectionHeadline` · `GameCard`
(image + title + LIVE badge + hover overlay) · `GamesWindow` (46.8% two-up) ·
`BetCard` · `BattleCard` · `RoomCodeBlock` · `PlayerChip` · `WalletTile` ·
`BalanceRow` · `TransactionRow` · `LeaderboardRow` · `StatTile` · `EmptyState` ·
`Skeleton` (card / row / text)

**Forms:** `PhoneInput` (+91) · `OtpInput` · `ResendTimer` · `AmountInput` ·
`AmountChips` · `TextField` (MUI-underline look) · `RadioGroup` · `SelectField` ·
`FileUpload` · `CopyField`

**Feedback:** `Button` (primary/secondary/ghost/play/withdraw) · `Toast` ·
`Modal` · `ConfirmDialog` · `Spinner` · `LiveBadge` (blink) · `Chip` · `Tooltip`

**Support:** `ChatPanel` · `ChatBubble` · `QuickReplyPill` · `ChatComposer` ·
`FaqAccordion` · `WhatsAppFab`

**Game (Phase 3):** `LudoBoard` (15×15) · `BoardCell` · `SafeStar` · `HomeBase` ·
`HomeColumn` · `HomeTriangle` · `Token` · `Dice` · `TurnIndicator` · `PlayerPanel` ·
`ModeSelect` · `DifficultySelect` · `MuteToggle` · `WinScreen` + `Confetti` ·
`RematchButton` · `MoveHintOverlay`

---

## 10. Recommendation: stack

**Stick with HTML + Tailwind + vanilla JS.** Reasons: the site is 6 mostly-static pages
plus one self-contained game; the game's state is a single reducer that does not need a
component tree; no build step means the sub-2s-on-4G target in Phase 4 is easy (the
reference ships a 985 KB JS bundle to render a header and two cards — we can beat that by
an order of magnitude); and a plain data model + event bus is *easier* to bolt Socket.IO
onto later than React state would be.

I'd reach for React only if you later add real auth, a live battle lobby with many
simultaneously-updating rows, and a payments dashboard. The Phase 3 game model I'm writing
is framework-agnostic (pure functions over a serialisable state object), so that migration
stays cheap if you ever want it.

---

## 11. Open items for Phase 2

- Your logo file — send it, or I'll ship a neutral placeholder mark.
- Brand name/wordmark to replace "KheloAdda".
- Keep the 480px column, or let the desktop breathe with a wider layout? (I recommend
  keeping the column — it's the site's identity — but widening to 520px and adding a
  real desktop layout for Leaderboard and How to Play.)


---

## 12. Logged-in screens — captured live (2026-08-28)

Verified against a real signed-in session. Read-only: navigation and measurement only,
no forms submitted, no deposits, no settings changed.

### 12.1 Header, confirmed
`[☰]` `[logo 64px]` ······ `[💵 CASH  0  |+]` `[🎁 EARNING  0]`
Both money boxes are 90px wide / 30px tall, `#f8f8f8` on `#ededed` border, radius 3px,
sitting in the blue bar. The `+` is a separate 17px tab on the Cash box only.
Right-panel logo does **not** bounce on inner pages — only on `/` and `/login`.

### 12.2 Profile `/Profile`
Centred avatar (~90px round) with a blue circular pencil badge below it, then two
full-width rows in `.wallet`-style tiles (icon 40px + label, `1px solid #e0e0e0`, r5):
**My Wallet**, **Add Email**. `divider-x` → **"Complete Profile"** section (15px/700 ink)
holding a **Complete KYC** tile (shows `Completed Kyc ✅` once approved). `divider-x` →
three stat rows, each a 30px round coloured icon + uppercase muted label + bold value:
**CASH WON** (green ₹), **BATTLE PLAYED** (red ✕), **REFERRAL EARNING** (gift).
`divider-x` → centred **LOG OUT** in muted caps.

### 12.3 Wallet `/wallet`
Fires a **SweetAlert-style notice modal on load** — bold Hindi copy warning that
withdrawal must go to the same account used to deposit, with a single green **Ok**
button (~62×28, `#0db25b`, r4). Behind it: an **Order History** tile
(clock icon + label, `1px solid #e0e0e0`, r5, ~70px tall) inside a white section.

> Worth copying as a pattern: a dismissible first-load notice card. I'll implement it as
> a proper modal with a focus trap rather than a blocking alert.

### 12.4 Battle lobby `/HomePage/ludo-classic-light-mode`
- Title **"Ludo Classic Lite Mode"** — ~24px, centred, ink
- Subtitle in Hindi: `शर्त राशि: ₹50 से ₹25,000/-` — ~15px muted, centred
- `CREATE A BATTLE!` — 10.5px/700 uppercase muted, centred
- Row: `Amount` input (~165×32, `1px solid #ced4da`, r4) + green **SET** button
  (~64×32, `#0db25b`, white, r4)
- `divider-x` → **Open Battles** header (red ✕ icon + 15px/700 label) with
  **RULES ⓘ** on the right (10.5px uppercase muted + 24px outlined info circle)
- `divider-x` → **Running Battles** header, same treatment
- Both lists empty here; `.betCard` markup from §5.8 applies when populated

### 12.5 Support `/support`
Illustration (~250px, support-agent vector) → **"📞 Need Help?"** 15px/700 centred →
"Contact our support team on Telegram or WhatsApp" 15px/400 `#6c7293` centred →
three **full-bleed** stacked buttons (width 100%, height 25px, `padding 5.625px 11.25px`,
`radius 2.8125px`, `font-size 12px`, `margin-bottom 15px`):

| Button | Background |
|---|---|
| 💬 Live Chat Support | `#075e54` |
| Open Telegram | `#0088cc` |
| Chat on WhatsApp | `#25d366` |

Footer: "Available 24×7 • Fast Response", 12px muted, centred.

> ⚠️ **Contrast bug in the original:** all three buttons render text at `#212529`
> (near-black) on those dark backgrounds — 1.4:1 on the teal. They clearly meant white.
> I'll ship white text and 44px tall touch targets (25px fails minimum tap size).

### 12.6 Leaderboard `/dashboard` — the page I said was missing
It exists and it's a plain table:
- Heading **"Leaderboard"** ~24px, centred, ink, in a 95px block with `padding-top:22.5px`
- `<table>` full width (480px)
- `<thead>` background **`#bcd7ff`**, text `#6c7293`
- `<th>` **Rubik 13.125px / weight 500**, `padding:12px 10px`, left-aligned
- Columns: **Rank · Name · Amount**

This is the thinnest screen on the site — a bare unstyled table. For your Leaderboard
I'll keep the `#bcd7ff` header and column set for continuity, but build it as ranked
rows with medal badges for the top 3, avatars, and a sticky "your rank" row.

### 12.7 Game History `/Gamehistory` & Transactions `/transaction-history`
Identical shell: a horizontal row of **filter chips** at the top (outlined pills,
~28px tall, r4, coloured borders with emoji), then the list, then **Previous / Next**
pagination as bordered link-buttons.

- Game History chips: `📋 All` (filled `#2196f3`, white) · `✅ Completed` (green border) ·
  `❌ Cancelled` (red border) · `⏳ Running` (amber border)
- Transactions chips: `📋 All` · `✅ Success` · `❌ Failed` · `🎁 Bonus` · `🚫 Penalty`
- **Empty state:** centred illustration (~200px) + title 24px/700 ("No Game History")
  + muted 15px subtitle ("You have no game history yet.")

### 12.8 Notifications `/Notification`
Same empty-state pattern: phone-with-bell illustration, **"No notification yet!"**
24px/700, "Seems like you haven't done any activity yet" 13px muted.

### 12.9 Gated routes
`/refer` and `/Withdrawopt` render **blank** on an account without approved KYC — no
message, no redirect, no skeleton. `/addcase` shows only a Hindi instruction paragraph
(3-minute payment window, ₹2 000 self-scan cap, ₹10 000 other-device cap) before the
deposit UI appears.

> Three empty-state bugs to fix in our build: gated routes must explain *why* they're
> gated and link to KYC; every list needs a skeleton on load; and `/addcase` should show
> the amount UI with the notice as a collapsible, not instead of it.

### 12.10 Design patterns worth carrying over
1. **`divider-x`** — the 10px `#f1f1f1` block between sections. Signature move.
2. **Tile row** — icon + label, `1px solid #e0e0e0`, radius 5px, ~70px tall. Used for
   wallet, profile, KYC, order history. One component covers a dozen screens.
3. **Illustrated empty states** with title + subtitle — consistent everywhere.
4. **Filter chips + Prev/Next** for every list.
5. **Uppercase muted micro-labels** (9–10.5px) above values. The whole app's texture.
