/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan the fragments too, so CSS is correct regardless of build order.
  content: ['./*.html', './admin.html', './src/pages/**/*.html', './assets/js/**/*.js'],
  // Classes assembled at runtime are invisible to the scanner — list them here.
  safelist: ['toast', 'toast-success', 'toast-error', 'toast-info'],
  theme: {
    screens: { xs: '400px', sm: '640px', md: '768px', lg: '1024px', xl: '1280px' },
    extend: {
      colors: {
        // Brand — blue chrome from the reference, gold accent from the Khelbro logo
        brand:   { DEFAULT: '#2d68c4', mid: '#3d80c5', dark: '#253d76', deep: '#1b2f5c' },
        gold:    { DEFAULT: '#f4bc41', light: '#ffd54f', deep: '#e0a020' },
        silver:  { DEFAULT: '#d8dde3', deep: '#9aa5b1' },
        cta:     { DEFAULT: '#0db25b', hover: '#0a9a4e', deep: '#088043' },
        // Neutrals — driven by CSS variables in input.css so the theme can swap them.
        ink:     { DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
                   body:    'rgb(var(--c-ink-body) / <alpha-value>)',
                   strong:  'rgb(var(--c-ink-strong) / <alpha-value>)' },
        muted:   { DEFAULT: 'rgb(var(--c-muted) / <alpha-value>)',
                   dark:    'rgb(var(--c-muted-dark) / <alpha-value>)' },
        line:    { DEFAULT: 'rgb(var(--c-line) / <alpha-value>)',
                   soft:    'rgb(var(--c-line-soft) / <alpha-value>)',
                   block:   'rgb(var(--c-line-block) / <alpha-value>)' },
        surface: { DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
                   alt:     'rgb(var(--c-surface-alt) / <alpha-value>)',
                   page:    'rgb(var(--c-surface-page) / <alpha-value>)',
                   chip:    'rgb(var(--c-surface-chip) / <alpha-value>)',
                   input:   'rgb(var(--c-surface-input) / <alpha-value>)' },
        // Accents that also need to shift between themes.
        accent:  { head:  'rgb(var(--c-accent-head) / <alpha-value>)',
                   hair:  'rgb(var(--c-accent-hair) / <alpha-value>)',
                   room:  'rgb(var(--c-accent-room) / <alpha-value>)',
                   fee:   'rgb(var(--c-accent-fee) / <alpha-value>)' },
        live:    '#e02d35',
        wa:      '#25d366',
        tg:      '#0088cc',
        chat:    '#075e54',
        // Ludo player colours
        ludo:    { red: '#e33d3d', green: '#28a745', yellow: '#f0b429', blue: '#2d68c4' },
      },
      fontFamily: {
        sans:    ['Roboto', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Saira Semi Condensed"', 'Roboto', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // Scale derived from the reference's 15px base, with a11y floors applied
        micro:  ['0.6875rem', { lineHeight: '1rem' }],                              // 11px
        label:  ['0.7125rem', { lineHeight: '1.0625rem', letterSpacing: '0.02em' }], // 11.4px — battleInputHeader
        meta:   ['0.75rem',   { lineHeight: '1.125rem' }],                          // 12px
        'body-sm': ['0.8125rem', { lineHeight: '1.25rem' }],                        // 13px
        body:   ['0.9375rem', { lineHeight: '1.375rem' }],                          // 15px — the reference base
        title:  ['0.9375rem', { lineHeight: '1.125rem', fontWeight: '700' }],        // 15px/700 — gamesSectionTitle
        h4:     ['1.40625rem',{ lineHeight: '1.6875rem', fontWeight: '500' }],       // 22.5px/500 — page h4
        h3:     ['1.25rem',   { lineHeight: '1.625rem' }],                           // 20px
        h2:     ['1.5rem',    { lineHeight: '1.875rem' }],                           // 24px
        h1:     ['1.875rem',  { lineHeight: '2.25rem' }],                            // 30px
      },
      maxWidth: { app: '480px' },       // the reference's exact column width
      spacing:  { app: '480px', header: '60px' },
      borderRadius: { tile: '10px', card: '12px', sheet: '16px' },
      boxShadow: {
        header: '0 2px 4px rgba(0,0,0,.08)',
        tile:   '0 1px 3px rgba(0,0,0,.06)',
        card:   '0 2px 10px rgba(0,0,0,.07)',
        sheet:  '0 -3px 16px rgba(0,0,0,.14)',
        fab:    '0 4px 14px rgba(37,211,102,.45)',
        gold:   '0 2px 12px rgba(244,188,65,.35)',
      },
      keyframes: {
        blink:      { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        shimmer:    { '100%': { transform: 'translateX(100%)' } },
        'slide-up': { from: { transform: 'translateY(12px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        'sheet-in': { from: { transform: 'translateY(100%)' },  to: { transform: 'translateY(0)' } },
        'toast-in': { from: { transform: 'translateY(-16px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        float:      { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-10px)' } },
        pop:        { '0%': { transform: 'scale(.8)', opacity: '0' }, '60%': { transform: 'scale(1.04)' }, '100%': { transform: 'scale(1)', opacity: '1' } },
        'fade-in':  { from: { opacity: '0' }, to: { opacity: '1' } },
        'reveal':   { from: { transform: 'translateY(14px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        'scale-in': { from: { transform: 'scale(.92)', opacity: '0' }, to: { transform: 'scale(1)', opacity: '1' } },
        'ripple':   { to: { transform: 'scale(2.6)', opacity: '0' } },
        'pulse-ring': { '0%': { transform: 'scale(.9)', opacity: '.7' }, '100%': { transform: 'scale(1.8)', opacity: '0' } },
        'glow':     { '0%,100%': { boxShadow: '0 0 0 0 rgba(244,188,65,.5)' }, '50%': { boxShadow: '0 0 0 6px rgba(244,188,65,0)' } },
        'shake':    { '0%,100%': { transform: 'translateX(0)' }, '20%,60%': { transform: 'translateX(-5px)' }, '40%,80%': { transform: 'translateX(5px)' } },
        'coin':     { '0%': { transform: 'translateY(0) scale(1)' }, '40%': { transform: 'translateY(-8px) scale(1.15)' }, '100%': { transform: 'translateY(0) scale(1)' } },
        'wiggle':   { '0%,100%': { transform: 'rotate(0)' }, '25%': { transform: 'rotate(-8deg)' }, '75%': { transform: 'rotate(8deg)' } },
        'draw-check': { from: { strokeDashoffset: '24' }, to: { strokeDashoffset: '0' } },
      },
      animation: {
        blink:      'blink 1.4s ease-in-out infinite',
        shimmer:    'shimmer 1.4s infinite',
        'slide-up': 'slide-up .28s cubic-bezier(.22,.61,.36,1) both',
        'sheet-in': 'sheet-in .26s cubic-bezier(0,0,.3,1) both',
        'toast-in': 'toast-in .22s cubic-bezier(.22,.61,.36,1) both',
        float:      'float 4s ease-in-out infinite',
        pop:        'pop .32s cubic-bezier(.22,.61,.36,1) both',
        'fade-in':  'fade-in .3s ease both',
        reveal:     'reveal .4s cubic-bezier(.22,.61,.36,1) both',
        'scale-in': 'scale-in .3s cubic-bezier(.22,.61,.36,1) both',
        ripple:     'ripple .6s ease-out forwards',
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
        glow:       'glow 2s ease-in-out infinite',
        shake:      'shake .4s ease-in-out',
        coin:       'coin .5s ease-out',
        wiggle:     'wiggle .5s ease-in-out',
      },
    },
  },
  plugins: [],
};
