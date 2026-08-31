/* Business rules shared by every route. */

/* Fail safe: only an explicit NODE_ENV=development counts as development.
   An unset NODE_ENV on the host must never be what decides whether a
   test-only affordance (free top-ups, login codes in the response) is live. */
export const IS_DEV = process.env.NODE_ENV === 'development';
export const IS_PROD = !IS_DEV;

export const MODES = {
  lite: { id: 'lite', name: 'Ludo Classic Lite Mode', min: 50,    max: 25000,  step: 10 },
  rich: { id: 'rich', name: 'Ludo Classic Rich Mode', min: 25000, max: 100000, step: 50 },
};

export const DEPOSIT  = { min: 100, max: 10000 };
export const WITHDRAW = { min: 100 };

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/* ---------- deposit cashback ----------
   ₹50 for every full ₹5,000 deposited. */
export const BONUS_PER = 5000;
export const BONUS_AMOUNT = 50;
export const BONUS_LABEL = `Cashback bonus (₹${BONUS_AMOUNT} per ₹${BONUS_PER.toLocaleString('en-IN')})`;
export const bonusFor = amount =>
  Math.floor(Math.max(0, Number(amount) || 0) / BONUS_PER) * BONUS_AMOUNT;

/* ---------- battle timing ----------
   Once the room code is set the match is live, so a player gets a short
   window to back out and after that must play it through and report. */
export const CANCEL_WINDOW_MS = 60 * 1000;          // 1 minute

/** Can this battle still be cancelled? Open until CANCEL_WINDOW_MS after the
    room code went up (falling back to creation for battles with no code yet). */
export const cancelWindowOpen = (roomSetAt, createdAt, at = Date.now()) =>
  at - (roomSetAt || createdAt || 0) <= CANCEL_WINDOW_MS;

/* A single unanswered result claim parks the battle in dispute. If the
   opponent has still not reported when this elapses, the lone claim is
   taken at face value and the battle settles automatically. */
export const CLAIM_GRACE_MS = 10 * 60 * 1000;       // 10 minutes

/* Human-readable forms of the two windows, so player-facing copy can never
   state a duration the code no longer enforces. Rounding would reintroduce
   exactly that, so a window that is not a whole number of minutes is described
   in seconds rather than approximated. */
export function durationLabel(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (totalSeconds < 60) return plural(totalSeconds, 'second');
  if (totalSeconds % 60 === 0) return plural(totalSeconds / 60, 'minute');
  const mins = Math.floor(totalSeconds / 60);
  return `${plural(mins, 'minute')} ${plural(totalSeconds % 60, 'second')}`;
}

export const GRACE_LABEL = durationLabel(CLAIM_GRACE_MS);
export const CANCEL_LABEL = durationLabel(CANCEL_WINDOW_MS);

/* ---------- settings fallbacks ----------
   getSettings() must never hand a route `undefined` for a number it is
   about to multiply — that silently produced NaN payouts and disabled
   the battle limit. */
export const SETTINGS_DEFAULTS = {
  withdraw_open: 1,
  deposit_open: 1,
  maintenance: 0,
  notice: null,
  commission: 0.05,               // legacy flat rate, superseded by the tiers
  commission_threshold: 500,      // stakes below this take the higher rate
  commission_under: 0.035,        // 3.5% below the threshold
  commission_from: 0.025,         // 2.5% at or above it
  battle_limit: 2,
  referral_rate: 0.01,
  upi_id: 'khelbro@upi',
  qr_image: null,
};

export const COMMISSION = SETTINGS_DEFAULTS.commission;
export const REFERRAL_RATE = SETTINGS_DEFAULTS.referral_rate;

/* ---------- commission tiers ----------
   Small battles carry a higher rate than large ones: below the threshold
   3.5%, at or above it 2.5%. A battle of exactly the threshold amount takes
   the lower rate — "below ₹500" is the higher tier, ₹500 itself is not. */
export const COMMISSION_THRESHOLD = 500;
export const COMMISSION_UNDER = 0.035;   // stake < threshold
export const COMMISSION_FROM  = 0.025;   // stake >= threshold

const rate = (v, fallback) =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1 ? v : fallback);

/** The commission rate that applies to a given stake. */
export function commissionFor(amount, settings = {}) {
  const threshold = (typeof settings.commission_threshold === 'number'
    && Number.isFinite(settings.commission_threshold) && settings.commission_threshold >= 0)
    ? settings.commission_threshold : COMMISSION_THRESHOLD;
  return Number(amount) < threshold
    ? rate(settings.commission_under, COMMISSION_UNDER)
    : rate(settings.commission_from, COMMISSION_FROM);
}

/** Winner's take: both stakes less the commission that applies to this stake. */
export const payoutFor = (amount, commission = COMMISSION_FROM) =>
  Math.round(amount * 2 * (1 - commission));

/** Convenience for callers that hold settings rather than a resolved rate. */
export const prizeFor = (amount, settings = {}) =>
  payoutFor(amount, commissionFor(amount, settings));
