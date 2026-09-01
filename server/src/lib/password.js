/* ============================================================
   Player passwords.

   A first-time account signs in with an OTP; once a password is
   set, that phone number signs in with the password and the OTP
   route becomes the "forgot password" fallback.

   Everything about how a password is checked, judged and locked
   out lives here, so the login route and the set-password route
   can never disagree about what counts as acceptable.
   ============================================================ */
import bcrypt from 'bcryptjs';

export const PASSWORD_MIN = 6;
/* bcrypt silently truncates past 72 bytes, so a longer password would be a
   password the user cannot fully rely on. Reject rather than truncate. */
export const PASSWORD_MAX = 72;

/* Compared against a fixed hash when the account has none, so a request for a
   phone number with no password costs the same time as one that has a
   password. Without it the response time alone reveals which is which. */
const DUMMY_HASH = '$2a$10$NGOdzE6vxgKHBKcWIdwqW.j63mpH5hxhTZ5W1/Y41kPMfpeDGPS7C';

/* Passwords guessed first in every credential-stuffing list. Six characters is
   already a thin secret for a wallet; letting it be one of these makes it no
   secret at all. */
const BANNED = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'password1', 'passw0rd', 'qwerty', 'qwerty123', 'abc123',
  '111111', '000000', '654321', 'iloveyou', 'admin123', 'welcome',
  'ludoking', 'khelbro', 'letmein', 'monkey', 'dragon',
]);

/** Why this password is not acceptable, or null if it is.
    `phone` is rejected because "my number is my password" is the single most
    common choice here, and it is public to every opponent they have played. */
export function passwordProblem(password, phone = '') {
  /* Only a real string. Coercing instead would turn `undefined` into the
     nine-character word "undefined" and wave it through as a valid password —
     the route's schema catches that today, but this function is the one that
     decides, so it decides on its own terms. */
  if (typeof password !== 'string') return 'Enter a password.';
  const pw = password;
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (Buffer.byteLength(pw, 'utf8') > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  if (/^(.)\1+$/.test(pw)) return 'Choose a password that is not the same character repeated.';
  if (BANNED.has(pw.toLowerCase())) return 'That password is too easy to guess. Choose another.';
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits && (pw === digits || pw === digits.slice(-6) || pw === digits.slice(0, 6)))
    return 'Your password cannot be your phone number.';
  return null;
}

/* Async, not the `*Sync` pair. bcrypt at cost 10 is ~110ms of pure
   computation, and the sync calls spend all of it blocking the event loop —
   nothing else on the process runs, not a battle, not a wallet read, not a
   socket frame. bcryptjs's async form chunks the same work across ticks, so a
   burst of sign-ins queues instead of stalling the server. */
export const hashPassword = pw => bcrypt.hash(String(pw), 10);

/** Constant-ish time check that tolerates an account with no password set. */
export const checkPassword = async (pw, storedHash) =>
  (await bcrypt.compare(String(pw ?? ''), storedHash || DUMMY_HASH)) && !!storedHash;

/* ---------- lockout ----------
   Rate limiting is per IP, which does nothing against an attacker spreading
   guesses across addresses. This is per account: five wrong tries and that
   phone number stops accepting password logins for fifteen minutes. The OTP
   route is deliberately still open, so a real owner is never locked out of
   their own account — only out of the password door. */
export const MAX_PASSWORD_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Milliseconds still to wait, or 0 when the account is not locked. */
export const lockoutRemaining = (user, at = Date.now()) =>
  Math.max(0, (Number(user?.pw_locked_until) || 0) - at);

/** How the lockout should read to the person who is waiting. */
export function lockoutMessage(ms) {
  const mins = Math.ceil(ms / 60000);
  return `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or sign in with an OTP.`;
}

/** Has this account now run out of attempts?

    Takes the count *after* an atomic increment, deliberately. Deciding from
    the count read before the write let two guesses in flight at the same time
    both read 3, both write 4, and hand the attacker a free attempt — repeated
    across enough parallel requests, the lockout never arrives at all. */
export const shouldLock = attemptsAfter => (Number(attemptsAfter) || 0) >= MAX_PASSWORD_ATTEMPTS;

/** The write that starts the lock, once shouldLock() says so. */
export const lockUpdate = (at = Date.now()) =>
  ({ $set: { pw_attempts: 0, pw_locked_until: at + LOCKOUT_MS } });
