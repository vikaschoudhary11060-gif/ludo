/* ============================================================
   Fast2SMS Quick OTP Sender (India)
   https://www.fast2sms.com/dev/bulkV2
   ============================================================ */

/**
 * Send a 6-digit OTP SMS to an Indian 10-digit mobile number via Fast2SMS.
 * 
 * @param {string} phone - 10-digit mobile number (e.g. '9876543210')
 * @param {string} code  - 6-digit OTP string (e.g. '123456')
 * @returns {Promise<{ ok: boolean, message?: string, error?: string }>}
 */
export async function sendOtpSms(phone, code) {
  const apiKey = process.env.FAST2SMS_API_KEY?.trim();

  // If no API key is provided, log in non-prod and skip gracefully
  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[sms] No FAST2SMS_API_KEY configured. Mock SMS to ${phone}: ${code}`);
    }
    return { ok: false, error: 'NO_API_KEY' };
  }

  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
    return { ok: false, error: 'INVALID_PHONE' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000); // 7s timeout

    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        variables_values: String(code),
        route: 'otp',
        numbers: cleanPhone,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.return === true) {
      console.log(`[sms] Fast2SMS OTP sent successfully to ${cleanPhone.slice(0, 3)}****${cleanPhone.slice(-3)}`);
      return { ok: true, message: data.message?.[0] || 'SMS sent' };
    }

    console.warn(`[sms] Fast2SMS error for ${cleanPhone}:`, data.message || data);
    return { ok: false, error: data.message?.[0] || 'FAST2SMS_FAILED' };
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error(`[sms] Failed to deliver SMS (${isTimeout ? 'Timeout' : err.message})`);
    return { ok: false, error: isTimeout ? 'TIMEOUT' : err.message };
  }
}
