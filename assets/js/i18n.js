/* ============================================================
   Khelbro — theme and language

   Loaded before app.js. The theme is applied before first paint
   (see the inline snippet in the page head) so there is no flash
   of the wrong theme.

   Translation works on exact English strings rather than keys, so
   markup does not need annotating. Dynamically rendered content is
   picked up by a MutationObserver.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- theme ---------------- */
  const THEME_KEY = 'khelbro.theme';

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function currentTheme() {
    return localStorage.getItem(THEME_KEY) || systemTheme();
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#131720' : '#2d68c4');
    document.querySelectorAll('[data-theme-toggle]').forEach(el => {
      el.setAttribute('aria-pressed', String(theme === 'dark'));
      const label = el.querySelector('[data-theme-label]');
      if (label) label.textContent = theme === 'dark' ? t('Dark') : t('Light');
    });
  }
  function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }
  const toggleTheme = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

  // Follow the OS while the user has not chosen explicitly.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
    });
  }

  /* ---------------- language ---------------- */
  const LANG_KEY = 'khelbro.lang';
  const HI = {
    // nav / shell
    'My Profile': 'मेरी प्रोफ़ाइल', 'Dashboard': 'डैशबोर्ड', 'Win Cash': 'कैश जीतें',
    'My Wallet': 'मेरा वॉलेट', 'Game History': 'गेम हिस्ट्री', 'Transaction History': 'लेन-देन इतिहास',
    'Refer and Earn': 'रेफ़र करें और कमाएँ', 'Refer History': 'रेफ़र हिस्ट्री',
    'Notification': 'सूचनाएँ', 'Notifications': 'सूचनाएँ', 'Support': 'सहायता',
    'Log out': 'लॉग आउट', 'LOGIN': 'लॉगिन', 'Sign in': 'साइन इन', 'Sign in to play': 'खेलने के लिए साइन इन करें',
    'Not signed in': 'साइन इन नहीं है', 'Close menu': 'मेन्यू बंद करें', 'Open menu': 'मेन्यू खोलें',
    'Cash': 'कैश', 'Earning': 'कमाई', 'Balance': 'बैलेंस', 'Add cash': 'कैश जोड़ें',
    'Skip to content': 'सामग्री पर जाएँ',

    // home
    'Our Tournaments': 'हमारे टूर्नामेंट', 'Ludo Classic': 'लूडो क्लासिक', 'Live': 'लाइव',
    'Terms, Privacy & Support': 'नियम, गोपनीयता और सहायता',

    // battles
    'Ludo Classic Lite Mode': 'लूडो क्लासिक लाइट मोड',
    'Ludo Classic Rich Mode': 'लूडो क्लासिक रिच मोड',
    'Create a Battle!': 'बैटल बनाएँ!', 'Bet amount:': 'शर्त राशि:', 'to': 'से',
    'Challenge from': 'चुनौती', 'Playing for': 'खेल रहे हैं', 'VS': 'बनाम', 'Amount': 'राशि', 'Set': 'सेट करें',
    'Open Battles': 'खुली बैटल', 'Running Battles': 'चल रही बैटल', 'Rules': 'नियम',
    'Play': 'खेलें', 'Cancel': 'रद्द करें', 'Entry fee': 'एंट्री फ़ीस',
    'Battle rules': 'बैटल के नियम', 'Got it': 'समझ गया', 'Commission rates': 'कमीशन दरें',
    'No open battles right now. Create one above.': 'अभी कोई खुली बैटल नहीं है। ऊपर एक बनाएँ।',
    'No battles running right now.': 'अभी कोई बैटल नहीं चल रही है।',
    'Sign in to create or play a battle.': 'बैटल बनाने या खेलने के लिए साइन इन करें।',

    // battle room
    'Back to battles': 'बैटल पर वापस जाएँ', 'Creator': 'क्रिएटर', 'Opponent': 'प्रतिद्वंद्वी',
    'Room code': 'रूम कोड', 'Copy code': 'कोड कॉपी करें', 'Submit result': 'रिज़ल्ट सबमिट करें',
    'I won': 'मैं जीता', 'I lost': 'मैं हारा', 'Waiting…': 'प्रतीक्षा…',
    'Match in progress': 'मैच चल रहा है', 'Battle settled': 'बैटल पूरी हुई',
    'You won!': 'आप जीत गए!', 'Battle lost': 'बैटल हार गए', 'Battle cancelled': 'बैटल रद्द',
    'Play another': 'दूसरी बैटल खेलें', 'Reject this player': 'इस खिलाड़ी को अस्वीकार करें',
    'Cancel battle & refund': 'बैटल रद्द करें और रिफ़ंड लें',
    'Waiting for an opponent to join': 'प्रतिद्वंद्वी के जुड़ने की प्रतीक्षा',
    'Opponent joined — waiting for the room code': 'प्रतिद्वंद्वी जुड़ गया — रूम कोड की प्रतीक्षा',
    'Open your Ludo app and join this room code.': 'अपना लूडो ऐप खोलें और इस रूम कोड से जुड़ें।',

    // wallet / money
    'Wallet': 'वॉलेट', 'Deposit': 'जमा', 'Winnings': 'जीत', 'Referral': 'रेफ़रल',
    'Total balance': 'कुल बैलेंस', 'Add Cash': 'कैश जोड़ें', 'Withdraw': 'निकासी',
    'Order history': 'ऑर्डर हिस्ट्री', 'Game history': 'गेम हिस्ट्री', 'Refer & earn': 'रेफ़र करें और कमाएँ',
    'Choose amount': 'राशि चुनें', 'Summary': 'सारांश', 'Payment method': 'भुगतान का तरीका',
    'Instant': 'तुरंत', 'Pay via UPI': 'UPI से भुगतान करें', 'UTR number': 'UTR नंबर',
    'Submit deposit request': 'जमा अनुरोध भेजें', 'Your requests': 'आपके अनुरोध',
    'Pay to this UPI ID': 'इस UPI ID पर भुगतान करें', 'Copy': 'कॉपी',
    'Request withdrawal': 'निकासी का अनुरोध करें', 'Withdraw to': 'निकासी कहाँ',
    'UPI ID': 'UPI ID', 'Bank transfer': 'बैंक ट्रांसफ़र', 'Account holder name': 'खाताधारक का नाम',
    'Account number': 'खाता संख्या', 'IFSC code': 'IFSC कोड',

    // profile / kyc
    'Complete Profile': 'प्रोफ़ाइल पूरी करें', 'Complete KYC': 'KYC पूरी करें',
    'KYC completed ✅': 'KYC पूरी ✅', 'KYC under review ⏳': 'KYC समीक्षा में ⏳',
    'Choose Avatar': 'अवतार चुनें', 'Add Email': 'ईमेल जोड़ें', 'Save email': 'ईमेल सेव करें',
    'Cash won': 'जीती गई रकम', 'Battles played': 'खेली गई बैटल', 'Referral earning': 'रेफ़रल कमाई',
    'Your details': 'आपकी जानकारी', 'Documents': 'दस्तावेज़', 'Submit for review': 'समीक्षा के लिए भेजें',
    'Full name (as on ID)': 'पूरा नाम (ID के अनुसार)', 'Date of birth': 'जन्म तिथि',

    // leaderboard / lists
    'Leaderboard': 'लीडरबोर्ड', 'Rankings': 'रैंकिंग', 'Today': 'आज', 'This week': 'इस सप्ताह',
    'All time': 'सर्वकालिक', 'Player': 'खिलाड़ी', 'Wins': 'जीत', 'Rank': 'रैंक',
    'Previous': 'पिछला', 'Next': 'अगला', 'All': 'सभी', 'Won': 'जीते', 'Lost': 'हारे',
    'Mark all read': 'सभी पढ़े हुए चिह्नित करें', 'No notification yet!': 'अभी कोई सूचना नहीं!',
    'No Game History': 'कोई गेम हिस्ट्री नहीं', 'No transactions': 'कोई लेन-देन नहीं',

    // support
    'Talk to us': 'हमसे बात करें', 'Live chat support': 'लाइव चैट सहायता',
    'Deposit or withdrawal help': 'डिपॉज़िट या विदड्रॉल में मदद',
    'Problem with a game or result': 'गेम या रिजल्ट में समस्या',
    'Live chat': 'लाइव चैट', 'Fastest': 'सबसे तेज़',
    'All three open the same conversation with our team. Prefer email? Use the form below.':
      'तीनों हमारी टीम के साथ एक ही चैट खोलते हैं। ईमेल पसंद है? नीचे दिया फ़ॉर्म भरें।',
    'Sign in to use live chat, or send us the form below':
      'लाइव चैट के लिए साइन इन करें, या नीचे दिया फ़ॉर्म भेजें',
    'Common questions': 'सामान्य प्रश्न', 'Send a message': 'संदेश भेजें',
    'Topic': 'विषय', 'Email': 'ईमेल', 'Message': 'संदेश', 'Send message': 'संदेश भेजें',

    // toasts
    'Battle created': 'बैटल बन गई', 'Battle joined': 'बैटल में शामिल हुए',
    'Room code set': 'रूम कोड सेट हो गया', 'Room code copied': 'रूम कोड कॉपी हो गया',
    'Referral code copied': 'रेफ़रल कोड कॉपी हो गया', 'UPI ID copied': 'UPI ID कॉपी हो गई',
    'Result submitted': 'रिज़ल्ट भेज दिया गया', 'Logged out': 'लॉग आउट हो गए',
    'You are offline': 'आप ऑफ़लाइन हैं', 'Back online': 'फिर से ऑनलाइन',
    'Insufficient balance. Add cash to continue.': 'बैलेंस कम है। जारी रखने के लिए कैश जोड़ें।',
    'Upload screenshot.': 'स्क्रीनशॉट अपलोड करें।',
    'Invalid room code. It must be exactly 8 digits.': 'ग़लत रूम कोड। इसमें ठीक 8 अंक होने चाहिए।',

    // misc
    'Light': 'लाइट', 'Dark': 'डार्क', 'Theme': 'थीम', 'Language': 'भाषा',
    'How to play': 'कैसे खेलें', 'How to Play': 'कैसे खेलें', 'Continue': 'जारी रखें',
    'Sign in first': 'पहले साइन इन करें', 'Loading…': 'लोड हो रहा है…',
  };

  const DICTS = { en: null, hi: HI };
  /* Hindi unless the player has chosen otherwise. Most of the audience reads
     Hindi first, and the rules screen is written in it — an English shell
     around Hindi rules is the worst of both. A stored choice always wins, so
     switching to English is one tap and it sticks. */
  const DEFAULT_LANG = 'hi';
  let lang = localStorage.getItem(LANG_KEY) || DEFAULT_LANG;

  /** Translate a single string. Falls back to the original. */
  function t(text) {
    const d = DICTS[lang];
    if (!d) return text;
    const key = String(text).trim();
    const hit = d[key];
    if (!hit) return text;
    return String(text).replace(key, hit);
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

  /* Content that is already written in the target language, and must be left
     exactly as the author wrote it. Translating word-by-word inside it does
     real damage: the rules say "गेम को सीधा Cancel कर दिया जायेगा", and
     swapping the one English word for its dictionary entry produced "सीधा
     रद्द करें कर दिया जायेगा" — grammatical nonsense in a screen players are
     expected to take seriously. Mark such a subtree `data-no-i18n`. */
  const isProtected = node => {
    const el = node.nodeType === 1 ? node : node.parentNode;
    return !!(el && el.closest && el.closest('[data-no-i18n]'));
  };

  function translateTree(root) {
    if (lang === 'en' || !DICTS[lang]) return;
    if (isProtected(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (SKIP.has(node.parentNode.nodeName)) return NodeFilter.FILTER_REJECT;
        if (isProtected(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const key = n.nodeValue.trim();
      const hit = DICTS[lang][key];
      if (hit) n.nodeValue = n.nodeValue.replace(key, hit);
    }
    // placeholders and labels are not text nodes
    root.querySelectorAll('[placeholder]').forEach(el => {
      if (isProtected(el)) return;
      const hit = DICTS[lang][el.getAttribute('placeholder').trim()];
      if (hit) el.setAttribute('placeholder', hit);
    });
    root.querySelectorAll('[aria-label]').forEach(el => {
      if (isProtected(el)) return;
      const hit = DICTS[lang][el.getAttribute('aria-label').trim()];
      if (hit) el.setAttribute('aria-label', hit);
    });
  }

  function setLang(next) {
    if (next === lang) return;
    localStorage.setItem(LANG_KEY, next);
    location.reload();                  // simplest correct way to re-render everything
  }

  function applyLangUi() {
    document.documentElement.setAttribute('lang', lang === 'hi' ? 'hi' : 'en');
    document.querySelectorAll('[data-lang-set]').forEach(el => {
      const on = el.dataset.langSet === lang;
      el.classList.toggle('bg-white', on);
      el.classList.toggle('!text-brand', on);
      el.setAttribute('aria-pressed', String(on));
    });
  }

  /* Dynamically rendered lists must be translated too. */
  function observe() {
    if (lang === 'en') return;
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (isProtected(node)) continue;
          if (node.nodeType === 1) translateTree(node);
          else if (node.nodeType === 3) {
            const hit = DICTS[lang][node.nodeValue.trim()];
            if (hit) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), hit);
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme());
    applyLangUi();
    translateTree(document.body);
    observe();

    document.addEventListener('click', e => {
      const th = e.target.closest('[data-theme-toggle]');
      if (th) { e.preventDefault(); toggleTheme(); return; }
      const ln = e.target.closest('[data-lang-set]');
      if (ln) { e.preventDefault(); setLang(ln.dataset.langSet); }
    });
  });

  window.KhelbroI18n = { t, lang: () => lang, setLang, theme: currentTheme, setTheme, toggleTheme, translateTree };
})();
