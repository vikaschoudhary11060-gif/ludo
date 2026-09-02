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

/* ---------- signup bonus ----------
   A flat welcome credit, set by the admin and applied live. It lands in the
   deposit (cash) bucket, so it can be played with but never withdrawn
   straight back out. Zero — the default — switches it off entirely.

   Two knobs, because "signup bonus" and "referral bonus" are different
   promises: everyone gets `signup_bonus`, and an account that arrived through
   somebody's referral code gets `referral_bonus` on top. */
export const SIGNUP_BONUS_LABEL = 'Welcome bonus';
export const REFERRAL_BONUS_LABEL = 'Referral signup bonus';

/** Whole rupees only, never negative, never NaN — this is credited straight
    into a wallet, and credit() throws on anything else. */
const bonusAmount = v => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** What a brand-new account is credited, as [amount, label] pairs.
    `hasReferrer` adds the referral tier on top of the plain welcome credit. */
export function signupBonuses(settings = {}, hasReferrer = false) {
  const out = [];
  const welcome = bonusAmount(settings.signup_bonus);
  if (welcome > 0) out.push([welcome, SIGNUP_BONUS_LABEL]);
  if (hasReferrer) {
    const referred = bonusAmount(settings.referral_bonus);
    if (referred > 0) out.push([referred, REFERRAL_BONUS_LABEL]);
  }
  return out;
}

/* ---------- battle timing ----------
   Once the room code is set the match is live, so a player gets a window to
   back out and after that must play it through and report. Ten minutes: long
   enough that an opponent who never actually opens the Ludo room can be
   walked away from, short enough that a played match cannot be undone. */
export const CANCEL_WINDOW_MS = 10 * 60 * 1000;     // 10 minutes

/** Can this battle still be cancelled? Open until CANCEL_WINDOW_MS after the
    room code went up (falling back to creation for battles with no code yet). */
export const cancelWindowOpen = (roomSetAt, createdAt, at = Date.now()) =>
  at - (roomSetAt || createdAt || 0) <= CANCEL_WINDOW_MS;

/* ---------- cancellation ----------
   A fixed list, so the reason can be validated, counted, and shown back to
   the other player rather than being free text nobody reads. */
export const CANCEL_REASONS = [
  { id: 'no_room',      label: 'Host never shared the room code' },
  { id: 'opponent_afk', label: 'Opponent is not responding' },
  { id: 'wrong_amount', label: 'Wrong amount entered' },
  { id: 'changed_mind', label: 'No longer want to play' },
  { id: 'app_issue',    label: 'Ludo app or network problem' },
  { id: 'other',        label: 'Something else' },
];
export const CANCEL_REASON_IDS = CANCEL_REASONS.map(r => r.id);

/** Who may call off a battle, and whose stake comes back.

    Before anyone joins, only the host can cancel and only the host has staked.
    Once the host accepts but no room code exists, the match is stuck: either
    player may cancel and BOTH stakes are returned, because both were taken.
    After the room code goes up (running status), a 10-minute cancellation timer applies
    allowing either player to cancel and get refunded if the game did not start. */
export function cancelPlan(status, { isCreator, isAcceptor, creatorId, acceptorId, roomSetAt, createdAt }) {
  if (!isCreator && !isAcceptor) return { allowed: false, error: 'FORBIDDEN' };

  if (status === 'open' || status === 'requested') {
    if (!isCreator) return { allowed: false, error: 'HOSTONLY' };
    return { allowed: true, refund: [creatorId].filter(id => id != null) };
  }
  if (status === 'waiting') {
    return { allowed: true, refund: [creatorId, acceptorId].filter(id => id != null) };
  }
  if (status === 'running') {
    if (cancelWindowOpen(roomSetAt, createdAt)) {
      return { allowed: true, refund: [creatorId, acceptorId].filter(id => id != null) };
    }
    return { allowed: false, error: 'CLOSED' };
  }
  return { allowed: false, error: 'CLOSED' };
}
export const cancelReasonLabel = id =>
  (CANCEL_REASONS.find(r => r.id === id) || {}).label || 'No reason given';

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
  /* Flat joining credits, in whole rupees. 0 = switched off. */
  signup_bonus: 0,
  referral_bonus: 0,
  upi_id: 'khelbro@upi',
  qr_image: null,
  bank_name: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_ifsc: '',
  notices: [],
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
