#!/usr/bin/env python3
"""Khelbro static page builder.

Assembles complete, standalone HTML pages from a shared shell plus one
content fragment per page (src/pages/*.html). Output goes to the project
root as fully self-contained files -- no client-side templating, so the
markup is crawlable and there is no layout shift on load.

    python3 build.py
"""
import pathlib, re, sys, hashlib, time

ROOT = pathlib.Path(__file__).parent
FRAG = ROOT / 'src' / 'pages'

SITE = 'Khelbro'
TAGLINE = 'Play Ludo. Climb the board.'
# ⚠️ DEPLOY: change this to your real domain before building for production.
BASE_URL = 'https://ludo-ludo19.vercel.app'
TWITTER = '@khelbro'   # your Twitter/X handle, or '' to omit
# ⚠️ DEPLOY: your API server's public origin (no trailing slash).
API_URL = 'https://ludo-qu3q.onrender.com'

# name, file, nav label, icon, in bottom nav?
NAV = [
    ('Home',        'index.html',        'Home',    'home',   True),
    ('Rules',       'how-to-play.html',  'Rules',   'book',   True),
    ('Ranks',       'leaderboard.html',  'Ranks',   'trophy', True),
    ('Wallet',      'wallet.html',       'Wallet',  'wallet', True),
    ('Profile',     'profile.html',      'Profile', 'user',   True),
]

ICONS = {
 'home':   '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
 'book':   '<path d="M4 4.5h7a2.5 2.5 0 0 1 2.5 2.5v13A2 2 0 0 0 11.5 18H4z"/><path d="M20 4.5h-2.5A2.5 2.5 0 0 0 15 7v13a2 2 0 0 1 2-2h3z"/>',
 'trophy': '<path d="M7.5 4h9v5.5a4.5 4.5 0 0 1-9 0z"/><path d="M16.5 5.5H20V7a3 3 0 0 1-3 3M7.5 5.5H4V7a3 3 0 0 0 3 3"/><path d="M12 14v3M8.5 20h7"/>',
 'wallet': '<path d="M3 8a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2M3 8v9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3M3 8h16a2 2 0 0 1 2 2v1h-4a1.5 1.5 0 0 0 0 3h4"/>',
 'help':   '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.4a2.4 2.4 0 1 1 2.9 2.7v1.2"/><path d="M12 16.4h.01"/>',
 'game':   '<rect x="2.5" y="7.5" width="19" height="10" rx="4"/><path d="M7 11v3M5.5 12.5h3M15.5 12h.01M18 13.5h.01"/>',
 'history':'<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V9H8"/><path d="M12 7.5V12l3 1.8"/>',
 'user':   '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
 'bell':   '<path d="M6.5 9a5.5 5.5 0 0 1 11 0v4l1.6 2.6H4.9L6.5 13z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>',
 'gift':   '<path d="M3.5 9.5h17v3.5h-17zM5 13v7.5h14V13"/><path d="M12 9.5v11"/><path d="M12 9.5C10.4 6.2 7 6 7 8s3.3 1.5 5 1.5 5 .5 5-1.5-3.4-1.8-5 1.5z"/>',
 'logout': '<path d="M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3.5"/><path d="m9.5 8.5-4 3.5 4 3.5M5.5 12H15"/>',
 'receipt':'<path d="M6 3.5h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z"/><path d="M9 8h6M9 12h6"/>',
 'users':  '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 6.2M17.5 19a5.6 5.6 0 0 0-2-4"/>',
 'plus':   '<path d="M12 5v14M5 12h14"/>',
 'copy':   '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
}

def icon(name, cls='h-5 w-5'):
    body = ICONS.get(name, '')
    return (f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
            f'aria-hidden="true" focusable="false">{body}</svg>')


WORDMARK = (
 '<span class="font-display text-[22px] font-bold italic leading-none tracking-tight">'
 '<span class="bg-gradient-to-b from-white to-silver bg-clip-text text-transparent">khel</span>'
 '<span class="bg-gradient-to-b from-gold-light to-gold-deep bg-clip-text text-transparent">bro</span>'
 '</span>')

DRAWER_LINKS = [
    ('My Profile',          'profile.html',      'user'),
    ('Dashboard',           'leaderboard.html',  'trophy'),
    ('Win Cash',            'index.html#play',   'game'),
    ('My Wallet',           'wallet.html',       'wallet'),
    ('Game History',        'game-history.html', 'history'),
    ('Transaction History', 'transactions.html', 'receipt'),
    ('Refer and Earn',      'refer.html',        'gift'),
    ('Refer History',       'refer.html#history','users'),
    ('Notification',        'notifications.html','bell'),
    ('Support',             'support.html',      'help'),
]

LEGAL = [('Terms & Conditions','terms.html'),('Privacy Policy','privacy.html'),
         ('Refund Policy','refund-policy.html'),('Responsible Gaming','responsible-gaming.html'),
         ('About Us','about.html'),('Contact Us','support.html')]


def header():
    items = []
    for label, href, ic in DRAWER_LINKS:
        items.append(
            f'<a class="drawer-item" href="{href}" data-drawer-close>'
            f'<span class="drawer-item__icon">{icon(ic,"h-4 w-4")}</span>'
            f'<span class="flex-1 text-body">{label}</span>'
            f'<span aria-hidden="true" class="text-white/50">&rsaquo;</span></a>')
    items.append(
        '<button class="drawer-item w-full" type="button" data-action="logout" data-when="in" hidden>'
        f'<span class="drawer-item__icon">{icon("logout","h-4 w-4")}</span>'
        '<span class="flex-1 text-left text-body">Log out</span></button>')
    drawer_items = '\n        '.join(items)

    return f'''<div id="scrim" class="scrim lg:max-w-app" aria-hidden="true"></div>

    <!-- Slide-in navigation -->
    <nav id="drawer" class="drawer" aria-label="Main navigation" aria-hidden="true" tabindex="-1">
      <div class="flex items-center gap-3 bg-brand-dark px-5 py-4">
        <img src="assets/img/mark.svg" alt="" width="40" height="40" class="h-10 w-10">
        <div class="flex-1">
          {WORDMARK}
          <p class="text-label text-white/70" data-when="out">Not signed in</p>
          <p class="text-label text-white/80" data-when="in" hidden data-bind="name">Player</p>
        </div>
        <button class="icon-btn" type="button" data-drawer-close aria-label="Close menu">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <!-- Theme and language sit first: they are settings, not destinations. -->
      <div class="border-b border-white/15 px-4 py-3">
        <div class="flex items-center gap-2">
          <button class="flex flex-1 items-center justify-center gap-2 rounded-tile border border-white/25
                         bg-white/10 px-3 py-2.5 text-body text-white transition hover:bg-white/20 active:scale-95"
                  type="button" data-theme-toggle aria-pressed="false">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
            <span data-theme-label>Light</span>
          </button>

          <div class="flex flex-1 overflow-hidden rounded-tile border border-white/25" role="group" aria-label="Language">
            <button class="flex-1 px-2 py-2.5 text-body font-bold text-white transition hover:bg-white/20 active:scale-95"
                    type="button" data-lang-set="en">EN</button>
            <button class="flex-1 border-l border-white/25 px-2 py-2.5 text-body font-bold text-white transition hover:bg-white/20 active:scale-95"
                    type="button" data-lang-set="hi">हिंदी</button>
          </div>
        </div>
      </div>

      <div class="flex flex-col">
        {drawer_items}
      </div>
      <a class="btn btn-gold btn-block mx-5 mb-5 mt-auto !w-auto" href="login.html" data-when="out">Sign in to play</a>
    </nav>

    <!-- Top bar -->
    <header class="site-header">
      <button class="icon-btn" type="button" id="drawer-open" aria-label="Open menu"
              aria-controls="drawer" aria-expanded="false">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>

      <a href="index.html" class="flex shrink-0 items-center gap-2" aria-label="{SITE} home">
        <img src="assets/img/mark.svg" alt="" width="36" height="36" class="h-9 w-9">
        <span class="hidden xs:inline">{WORDMARK}</span>
      </a>

      <!-- Shown only when the browser offers an install prompt. -->
      <div class="ml-auto flex items-center gap-1.5 rounded-md bg-white/15 px-2 py-1" data-install hidden>
        <span class="hidden text-[9px] font-bold leading-tight text-white xs:block">Install<br>app</span>
        <button class="rounded bg-cta px-2 py-1 text-[10px] font-bold text-white transition hover:bg-cta-hover active:scale-95"
                type="button" data-install-go>Install</button>
        <button class="grid h-5 w-5 place-items-center rounded text-white/70 hover:text-white"
                type="button" data-install-close aria-label="Dismiss install prompt">&times;</button>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <a class="btn btn-login" href="login.html" data-when="out">LOGIN</a>
        <a class="money-box" href="wallet.html" data-when="in" hidden aria-label="Cash balance">
          <span class="text-base leading-none" aria-hidden="true">&#128181;</span>
          <span class="flex flex-col gap-0.5">
            <span class="money-box__label">Cash</span>
            <span class="money-box__value" data-bind="cash">&#8377;0</span>
          </span>
          <span class="money-box__add" aria-hidden="true">+</span>
        </a>
        <!-- Winnings, not referral: this is the withdrawable balance, so it is
             the number a player most needs in front of them. Referral sits on
             the wallet, profile and refer screens. -->
        <a class="money-box !min-w-[84px] !pr-2" href="wallet.html" data-when="in" hidden
           aria-label="Winnings balance, withdrawable">
          <span class="text-base leading-none" aria-hidden="true">&#127942;</span>
          <span class="flex flex-col gap-0.5">
            <span class="money-box__label">Winnings</span>
            <span class="money-box__value" data-bind="winnings">&#8377;0</span>
          </span>
        </a>
      </div>
    </header>'''


def bottom_nav():
    out = []
    for label, href, short, ic, show in NAV:
        if not show:
            continue
        out.append(f'<a href="{href}">{icon(ic,"h-5 w-5")}<span>{short}</span></a>')
    return '<nav class="bottom-nav lg:hidden" aria-label="Quick navigation">\n      ' + \
           '\n      '.join(out) + '\n    </nav>'


def footer():
    links = '\n          '.join(
        f'<a class="link-muted" href="{h}">{t}</a>' for t, h in LEGAL)
    return f'''<div class="divider-x"></div>
    <footer class="bg-surface-alt px-4 py-6">
      <details class="group rounded-tile border border-line bg-surface">
        <summary class="flex cursor-pointer list-none items-center gap-3 p-4">
          <img src="assets/img/mark.svg" alt="" width="44" height="44"
               class="h-11 w-11 rounded-tile bg-surface-page p-1">
          <span class="flex-1 text-body-sm text-muted">Terms, Privacy &amp; Support</span>
          <svg class="h-5 w-5 text-muted transition-transform duration-300 group-open:rotate-180"
               viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        <div class="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line px-4 py-4">
          {links}
        </div>
      </details>

      <p class="mt-5 text-meta leading-relaxed text-muted">
        {SITE} is a free-to-play skill gaming site. Play responsibly and only if you are
        18 or older. No real-money wagering is offered on this site.
      </p>
      <p class="mt-3 text-meta text-muted">&copy; <span data-year>2026</span> {SITE}. All rights reserved.</p>
    </footer>'''


SHELL = '''<!doctype html>
<html lang="en" class="scroll-pt-16">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="keywords" content="ludo, play ludo online, ludo cash game, ludo tournament, khelbro, online ludo, ludo battle">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="author" content="{site}">
<meta name="theme-color" content="#2d68c4">
<link rel="icon" href="assets/img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="assets/img/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="assets/img/icon-192.png">
<link rel="manifest" href="manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Khelbro">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="canonical" href="{base}/{slug}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{site}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{base}/assets/img/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Khelbro — Play Ludo & Win">
<meta property="og:url" content="{base}/{slug}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="{twitter}">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{base}/assets/img/og.png">
{jsonld}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="{api}" crossorigin>
<link rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&family=Saira+Semi+Condensed:wght@600;700&display=swap">
<link rel="stylesheet" href="assets/css/app.css">
<script>window.KHELBRO_API = "{api}"; window.KHELBRO_BUILD = "{build}";
// Runs before paint so the theme never flashes.
(function(){{try{{var t=localStorage.getItem('khelbro.theme')||
(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
document.documentElement.setAttribute('data-theme',t);
if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('anim');
if(t==='dark'){{var m=document.querySelector('meta[name=theme-color]');if(m)m.content='#131720';}}
var l=localStorage.getItem('khelbro.lang');if(l)document.documentElement.lang=l;}}catch(e){{}}}})();</script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<div class="app-shell">
  <div class="app-column">
    {header}

    <main id="main" class="main-area lg:pb-8">
{content}
    </main>

    {footer}

    <a class="fab-wa" href="support.html" aria-label="Contact support">
      <svg class="h-7 w-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2a10 10 0 0 0-8.7 15l-1.2 4.3 4.4-1.2A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.2 14.8l-.4-.2-2.3.6.6-2.2-.3-.4A8 8 0 0 1 12 4zm-3.2 4c-.2 0-.5.1-.7.4-.3.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.7 2.7 4.2 3.7 2.1.8 2.5.7 3 .6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.6-.3-1.5-.7c-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.2-2.8c-.1-.2 0-.4.1-.5l.4-.5.3-.5v-.4l-.7-1.7c-.2-.4-.4-.4-.5-.4z"/>
      </svg>
    </a>
  </div>

  <!-- Decorative brand panel: desktop only, hidden from assistive tech -->
  <aside class="brand-panel" aria-hidden="true">
    <div class="flex flex-col items-center gap-6 px-10 text-center">
      <img src="assets/img/mark.svg" alt="" width="220" height="220"
           class="h-52 w-52 animate-float drop-shadow-2xl">
      <div>
        <span class="font-display text-[54px] font-bold italic leading-none tracking-tight">
          <span class="bg-gradient-to-b from-white to-silver bg-clip-text text-transparent">khel</span><span
                class="bg-gradient-to-b from-gold-light to-gold-deep bg-clip-text text-transparent">bro</span>
        </span>
        <p class="mt-3 font-display text-h3 uppercase tracking-[0.35em] text-white/85">{tagline}</p>
      </div>
    </div>
  </aside>
</div>

<script src="{api}/socket.io/socket.io.js" async data-socket-io></script>
<script src="assets/js/pwa.js" defer></script>
<script src="assets/js/push.js" defer></script>
<script src="assets/js/i18n.js" defer></script>
<script src="assets/js/api.js" defer></script>
<script src="assets/js/app.js" defer></script>
<script src="assets/js/anim.js" defer></script>
{pagescript}
</body>
</html>
'''

PAGES = [
  ('index.html',        'Khelbro — Play Ludo &amp; Win',
   'Play Ludo battles on Khelbro. Create a battle, set your amount and take on real players in Lite or Rich mode.', 'home.js'),
  ('battles.html',      'Ludo Battles | Khelbro',
   'Create a Ludo battle or join an open one. Lite mode and Rich mode tables with live opponents.', 'alert.js, battles.js'),
  ('battle.html',       'Battle Room | Khelbro',
   'Your Ludo battle room — share the room code, play the match and submit the result.', 'alert.js, battle.js'),
  ('how-to-play.html',  'How to Play Ludo — Rules &amp; Strategy | Khelbro',
   'Learn Ludo in two minutes: rolling, unlocking with a six, capturing, safe squares and the exact roll home.', ''),
  ('leaderboard.html',  'Leaderboard — Top Ludo Players | Khelbro',
   'See the top Ludo players on Khelbro. Daily, weekly and all-time rankings.', 'leaderboard.js'),
  ('profile.html',      'My Profile | Khelbro',
   'Your Khelbro profile — avatar, KYC status, games played and referral earnings.', 'banks.js, profile.js'),
  ('wallet.html',       'My Wallet | Khelbro',
   'Your Khelbro wallet balance, deposits, winnings and order history.', 'wallet.js'),
  ('add-cash.html',     'Add Cash | Khelbro',
   'Top up your Khelbro balance to join higher battles.', 'addcash.js'),
  ('withdraw.html',     'Withdraw | Khelbro',
   'Withdraw your Khelbro winnings to UPI or a bank account.', 'banks.js, withdraw.js'),
  ('game-history.html', 'Game History | Khelbro',
   'Every Ludo battle you have played on Khelbro, with results and amounts.', 'gamehistory.js'),
  ('transactions.html', 'Transaction History | Khelbro',
   'All deposits, withdrawals, winnings and penalties on your Khelbro account.', 'transactions.js'),
  ('refer.html',        'Refer &amp; Earn | Khelbro',
   'Share your Khelbro referral code and earn a commission on every battle your friends play.', 'refer.js'),
  ('notifications.html','Notifications | Khelbro',
   'Match results, payouts and announcements from Khelbro.', 'notifications.js'),
  ('kyc.html',          'Complete KYC | Khelbro',
   'Verify your identity to unlock withdrawals on Khelbro.', 'kyc.js'),
  ('login.html',        'Sign in | Khelbro',
   'Sign in to Khelbro with your mobile number and a one-time password.', 'login.js'),
  ('support.html',      'Support &amp; Help | Khelbro',
   'Get help with Khelbro. FAQs on gameplay, battles, wallet and KYC, or message support.', 'support.js'),
  ('waiting-room.html','Finding a Player | Khelbro',
   'Waiting for an opponent to join your Ludo battle.', 'waitingroom.js'),
  ('redeem.html',      'Redeem Referral | Khelbro',
   'Move your Khelbro referral earnings into your playable balance.', 'redeem.js'),
  ('terms.html',       'Terms &amp; Conditions | Khelbro',
   'The terms that govern your use of Khelbro, including fair play, battles and commission.', ''),
  ('privacy.html',     'Privacy Policy | Khelbro',
   'What data Khelbro collects, how it is used, and the choices you have.', ''),
  ('refund-policy.html','Refund &amp; Cancellation Policy | Khelbro',
   'When a Khelbro battle can be cancelled and how refunds and disputed results are handled.', ''),
  ('responsible-gaming.html','Responsible Gaming | Khelbro',
   'Play within your limits. Warning signs, self-limits and where to get help.', ''),
  ('about.html',       'About Us | Khelbro',
   'What Khelbro is, how battles work, and why Ludo is a game of skill.', ''),
]



import json as _json

def _ld(obj):
    return '<script type="application/ld+json">' + _json.dumps(obj, ensure_ascii=False) + '</script>'

def jsonld_for(slug):
    org = {
        "@context": "https://schema.org", "@type": "Organization",
        "name": SITE, "url": BASE_URL, "logo": BASE_URL + "/assets/img/icon-512.png",
        "sameAs": [],
    }
    site = {
        "@context": "https://schema.org", "@type": "WebSite",
        "name": SITE, "url": BASE_URL,
        "potentialAction": {
            "@type": "SearchAction",
            "target": BASE_URL + "/leaderboard.html?q={search_term_string}",
            "query-input": "required name=search_term_string",
        },
    }
    blocks = [org, site]

    if slug == 'how-to-play.html':
        blocks.append({
            "@context": "https://schema.org", "@type": "HowTo",
            "name": "How to play Ludo",
            "description": "Learn Ludo: roll to release with a six, capture opponents, use safe squares and get the exact roll home.",
            "step": [
                {"@type": "HowToStep", "name": "Roll a six to start",
                 "text": "Your tokens stay in base until a six frees one. A six also gives an extra roll."},
                {"@type": "HowToStep", "name": "Race and capture",
                 "text": "Land on an opponent outside a starred square to send it back to base."},
                {"@type": "HowToStep", "name": "Get all four home",
                 "text": "The home column needs an exact roll. First player with all four tokens home wins."},
            ],
        })

    if slug == 'support.html':
        blocks.append({
            "@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": "Is Khelbro free to play?",
                 "acceptedAnswer": {"@type": "Answer", "text": "Yes. Every mode is free to play."}},
                {"@type": "Question", "name": "How do I withdraw my winnings?",
                 "acceptedAnswer": {"@type": "Answer", "text": "Only winnings can be withdrawn. Deposit money is for playing battles. Complete KYC, then withdraw winnings to UPI or bank."}},
                {"@type": "Question", "name": "How does a battle work?",
                 "acceptedAnswer": {"@type": "Answer", "text": "Create a battle for an amount, share the room code, play, then submit the result with a screenshot."}},
            ],
        })

    if slug != 'index.html':
        name = slug.replace('.html', '').replace('-', ' ').title()
        blocks.append({
            "@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": BASE_URL + "/index.html"},
                {"@type": "ListItem", "position": 2, "name": name, "item": BASE_URL + "/" + slug},
            ],
        })

    return "\n".join(_ld(b) for b in blocks)



def build_id():
    """A short id over everything the browser caches.

    The service worker only updates when sw.js itself changes, so a deploy that
    touched only app.js used to leave every returning visitor on the old code.
    Hashing the shipped assets means any real change produces a new id, and an
    unchanged rebuild produces the same one (no pointless cache churn)."""
    h = hashlib.sha256()
    for f in sorted(ROOT.glob('assets/js/*.js')) + sorted(ROOT.glob('assets/css/*.css')):
        if f.exists():
            h.update(f.name.encode())
            h.update(f.read_bytes())
    # The worker's own logic counts too — with its VERSION line stripped, since
    # that line is what this id gets written into.
    sw = ROOT / 'sw.js'
    if sw.exists():
        h.update(b'sw.js')
        h.update(re.sub(r"const VERSION = '[^']*';", '', sw.read_text(encoding='utf-8')).encode())
    return h.hexdigest()[:12]


def write_version_file(bid):
    """A tiny always-fresh endpoint the running app polls to see if it is stale.

    The service-worker update dance is not enough on its own: it never runs
    where service workers are unavailable, and it depends on event timing we
    do not control. Comparing this id against the one baked into the page is
    deterministic."""
    (ROOT / 'version.json').write_text(
        '{"build": "%s"}\n' % bid, encoding='utf-8')


def stamp_service_worker(bid):
    """Write the build id into sw.js so a deploy invalidates the old cache."""
    sw = ROOT / 'sw.js'
    if not sw.exists():
        return None
    text = sw.read_text(encoding='utf-8')
    new = re.sub(r"const VERSION = '[^']*';", f"const VERSION = 'khelbro-{bid}';", text, count=1)
    if new != text:
        sw.write_text(new, encoding='utf-8')
    return bid


def css_escape(cls):
    """Tailwind escapes these when it emits the selector."""
    out = ''
    for ch in cls:
        out += '\\' + ch if ch in '.:[]/()#%!+,<>=' else ch
    return out


def warn_if_css_stale(pages):
    """Tailwind strips classes it cannot find, and this script does not run it.

    Comparing timestamps cried wolf — Tailwind skips the write when its output
    is unchanged, so the file is often older than the markup and still correct.
    Check the thing that actually matters instead: every class the built pages
    reference should have a selector in the stylesheet."""
    css_path = ROOT / 'assets' / 'css' / 'app.css'
    if not css_path.exists():
        print('  !! assets/css/app.css is missing — run `npm run build`', file=sys.stderr)
        return
    css = css_path.read_text(encoding='utf-8')

    used = set()
    for slug in pages:
        for attr in re.findall(r'class="([^"]*)"', (ROOT / slug).read_text(encoding='utf-8')):
            for cls in attr.split():
                # Skip anything templated or clearly not a utility.
                if '${' in cls or '{' in cls or not cls or cls[0] in '$#':
                    continue
                used.add(cls)

    missing = sorted(c for c in used if ('.' + css_escape(c)) not in css)
    if missing:
        shown = ', '.join(missing[:6])
        extra = f' (+{len(missing) - 6} more)' if len(missing) > 6 else ''
        print(f'\n  !! {len(missing)} class(es) used in the markup have no rule in app.css:', file=sys.stderr)
        print(f'     {shown}{extra}', file=sys.stderr)
        print('     They will do nothing. Rebuild the stylesheet:', file=sys.stderr)
        print('       npx tailwindcss -i ./src/input.css -o ./assets/css/app.css --minify\n', file=sys.stderr)


def build():
    hdr, ftr = header(), footer()
    bid = build_id()
    stamp_service_worker(bid)
    write_version_file(bid)
    built = []
    for slug, title, desc, script in PAGES:
        frag = FRAG / slug
        if not frag.exists():
            print(f'  !! missing fragment: {frag}', file=sys.stderr)
            continue
        content = frag.read_text(encoding='utf-8')
        page_script = '\n'.join(
            f'<script src="assets/js/{f.strip()}" defer></script>'
            for f in script.split(',') if f.strip())
        html = SHELL.format(
            title=title, desc=desc, slug=slug, site=SITE, base=BASE_URL,
            twitter=TWITTER, jsonld=jsonld_for(slug), api=API_URL, build=bid,
            tagline=TAGLINE, header=hdr, footer=ftr,
            content=content, pagescript=page_script)
        (ROOT / slug).write_text(html, encoding='utf-8')
        built.append(slug)
        print(f'  built {slug:20s} {len(html):>7,} bytes')
    # After writing, so the check reads exactly what ships.
    warn_if_css_stale(built + ['admin.html'])
    print(f'\n  build id {bid} (stamped into sw.js)')
    return built


if __name__ == '__main__':
    print('Khelbro build')
    pages = build()
    print(f'\n{len(pages)} pages written.')
