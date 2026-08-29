/* Business rules shared by every route. Keep in sync with assets/js/store.js. */
export const COMMISSION = 0.05;          // platform cut on each settled battle

export const MODES = {
  lite: { id: 'lite', name: 'Ludo Classic Lite Mode', min: 50,    max: 25000,  step: 10 },
  rich: { id: 'rich', name: 'Ludo Classic Rich Mode', min: 25000, max: 100000, step: 50 },
};

export const DEPOSIT  = { min: 100, max: 10000 };
export const WITHDRAW = { min: 100 };
export const REFERRAL_RATE = 0.02;       // referrer earns 2% of each battle stake
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export const payoutFor = amount => Math.round(amount * 2 * (1 - COMMISSION));
