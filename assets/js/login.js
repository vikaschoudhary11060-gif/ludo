/* Login — OTP first, password after.

   A number the server does not yet hold a password for goes through the OTP,
   then is asked to create one. Every later sign-in on that number opens the
   password screen, with the OTP kept as the forgot-password route. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, toast } = K;
  let phone = '', timer = null;
  let appliedReferral = null;
  /* True when the OTP step was reached from "forgot password". Such a session
     is OTP-proved, so the server lets it replace the existing password without
     the old one — which is the entire point of asking for a code. */
  let resettingPassword = false;

  /* Only one step is ever on screen. Routing through one function keeps that
     true — hiding the old step at each call site is how two of them end up
     visible at once. */
  const STEPS = ['step-phone', 'step-password', 'step-otp', 'step-setpw'];
  function showStep(id) {
    STEPS.forEach(s => { const el = $('#' + s); if (el) el.hidden = s !== id; });
  }

  const nextUrl = () => new URLSearchParams(location.search).get('next') || 'index.html';
  const goNext = () => setTimeout(() => (location.href = nextUrl()), 400);

  /* Show/hide toggles on the two password fields. */
  function bindReveal(btnSel, inputSel) {
    const btn = $(btnSel), input = $(inputSel);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      input.focus();
    });
  }

  const fail = (sel, msg) => {
    const el = $(sel);
    el.textContent = msg;
    el.classList.remove('hidden');
  };
  const clearFail = sel => $(sel).classList.add('hidden');

  function startTimer(seconds = 30) {
    clearInterval(timer);
    let left = seconds;
    const el = $('#otp-timer'), resend = $('#otp-resend');
    resend.disabled = true;
    el.textContent = `Resend in ${left}s`;
    timer = setInterval(() => {
      if (--left <= 0) { clearInterval(timer); el.textContent = 'Didn’t get it?'; resend.disabled = false; }
      else el.textContent = `Resend in ${left}s`;
    }, 1000);
  }

  async function sendOtp() {
    const res = await Api.auth.requestOtp(phone);
    const code = res.devCode || res.otp;
    const hint = $('#otp-hint');
    const demo = $('#otp-demo');
    if (code) {
      if (demo) demo.textContent = code;
      if (hint) {
        hint.hidden = false;
        hint.classList.remove('hidden');
      }
      // Auto-fill OTP boxes for instant test sign-in
      const boxes = $$('#otp-boxes input');
      if (boxes.length === 6) {
        const chars = String(code).split('');
        boxes.forEach((b, i) => { b.value = chars[i] || ''; });
      }
    } else {
      if (hint) hint.hidden = true;
    }
    startTimer(30);
  }

  /* Move to the OTP step, sending a fresh code on the way in. */
  async function goToOtp() {
    await sendOtp();
    $('#otp-target').textContent = '+91 ' + phone;
    showStep('step-otp');
    $$('#otp-boxes input').forEach(b => (b.value = ''));
    $$('#otp-boxes input')[0].focus();
    toast('Code sent', 'success');
  }

  function goToPassword() {
    $('#pw-target').textContent = '+91 ' + phone;
    $('#login-password').value = '';
    clearFail('#login-pw-err');
    showStep('step-password');
    $('#login-password').focus();
  }

  /* After an OTP sign-in on an account with no password. The session already
     exists at this point, so backing out is not offered — leaving without a
     password would put them straight back on the OTP path next time. */
  function goToSetPassword() {
    const reset = resettingPassword;
    $('#setpw-title').textContent = reset ? 'Set a new password' : 'Create your password';
    $('#setpw-lede').textContent = reset
      ? 'Your code checked out. Choose a new password — it replaces the old one on every device.'
      : 'You are signed in. Set a password now — you will use it instead of an OTP next time.';
    $('#setpw-submit').textContent = reset ? 'Save new password' : 'Save password & continue';
    $('#new-password').value = '';
    $('#confirm-password').value = '';
    clearFail('#setpw-err');
    showStep('step-setpw');
    $('#new-password').focus();
  }

  async function validateAndApplyReferral(rawCode) {
    const code = (rawCode || '').trim().toUpperCase();
    if (!code) return false;
    try {
      const data = await Api.referrals.lookup(code);
      if (data && data.valid) {
        appliedReferral = data.code;
        localStorage.setItem('khelbro.referral', data.code);
        $('#ref-referrer-name').textContent = data.name || 'Khelbro Player';
        $('#ref-badge-code').textContent = data.code;
        $('#referral-banner').classList.remove('hidden');
        $('#manual-ref-container').classList.add('hidden');
        return true;
      }
    } catch {
      // Invalid code
    }
    return false;
  }

  K.ready.then(async () => {
    /* A finished account has nothing to do here — leave before touching the
       page, so the sign-in form never flashes on the way out. */
    if (K.state.user && K.state.user.hasPassword !== false) {
      location.replace('profile.html');
      return;
    }

    /* Everything else wires up first and routes afterwards. Returning early to
       show the password-setup step used to skip the code below it, so the form
       rendered with no submit handler at all: the Save button reloaded the
       page and the password was never stored. */
    bindReveal('#login-pw-eye', '#login-password');
    bindReveal('#setpw-eye', '#new-password');

    // Check referral from URL param or localStorage
    const params = new URLSearchParams(location.search);
    const initialRef = params.get('ref') || params.get('r') || params.get('referral') || localStorage.getItem('khelbro.referral');
    if (initialRef) {
      await validateAndApplyReferral(initialRef);
    }

    // Manual referral toggle
    const toggleBtn = $('#toggle-manual-ref');
    const manualForm = $('#manual-ref-form');
    const arrow = $('#manual-ref-arrow');
    if (toggleBtn && manualForm) {
      toggleBtn.addEventListener('click', () => {
        const isHidden = manualForm.classList.contains('hidden');
        if (isHidden) {
          manualForm.classList.remove('hidden');
          arrow.textContent = '▴';
          $('#manual-ref-input').focus();
        } else {
          manualForm.classList.add('hidden');
          arrow.textContent = '▾';
        }
      });
    }

    // Apply manual referral code button
    const applyBtn = $('#apply-ref-btn');
    const manualInput = $('#manual-ref-input');
    const manualMsg = $('#manual-ref-msg');
    if (applyBtn && manualInput) {
      applyBtn.addEventListener('click', async () => {
        const val = manualInput.value.trim().toUpperCase();
        if (!val) return;
        applyBtn.disabled = true;
        applyBtn.textContent = '...';
        manualMsg.classList.add('hidden');
        const ok = await validateAndApplyReferral(val);
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply';
        if (ok) {
          toast('Referral code applied! 🎁', 'success');
        } else {
          manualMsg.textContent = 'Invalid referral code. Please check and try again.';
          manualMsg.classList.remove('hidden');
        }
      });
    }

    /* No "Remove" here on purpose. Arriving through someone's referral link
       settles who referred you; the banner states that and nothing more. The
       manual "Have a referral code?" box is hidden once one is applied, so
       there is no second way to change it either. */

    const input = $('#phone');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 10);
      $('#phone-err').classList.add('hidden');
      input.classList.remove('field-error');
    });

    /* Step 1 — the number decides which door opens next. If the check itself
       fails we fall back to the OTP, which every account can always use. */
    $('#phone-form').addEventListener('submit', async e => {
      e.preventDefault();
      const v = input.value.trim();
      if (!/^[6-9]\d{9}$/.test(v)) {
        $('#phone-err').textContent = 'Enter a valid 10-digit mobile number.';
        $('#phone-err').classList.remove('hidden');
        input.classList.add('field-error'); input.focus();
        return;
      }
      phone = v;
      const btn = $('#phone-submit');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        let hasPassword = false;
        try { hasPassword = (await Api.auth.check(phone)).hasPassword === true; } catch {}
        if (hasPassword) goToPassword();
        else { resettingPassword = false; btn.textContent = 'Sending…'; await goToOtp(); }
      } catch (err) {
        $('#phone-err').textContent = err.message;
        $('#phone-err').classList.remove('hidden');
      } finally { btn.disabled = false; btn.textContent = 'Continue'; }
    });

    /* Step 2a — password sign-in. */
    $('#password-form').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = $('#login-password').value;
      if (!pw) return fail('#login-pw-err', 'Enter your password.');
      const btn = $('#password-submit');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await Api.auth.loginPassword(phone, pw);
        toast('Welcome back!', 'success');
        goNext();
      } catch (err) {
        fail('#login-pw-err', err.message);
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });

    $('#login-password').addEventListener('input', () => clearFail('#login-pw-err'));

    $('#use-otp').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      resettingPassword = true;
      try { await goToOtp(); }
      catch (err) { resettingPassword = false; fail('#login-pw-err', err.message); }
      finally { btn.disabled = false; }
    });

    $('#pw-change').addEventListener('click', () => {
      showStep('step-phone');
      input.focus();
    });

    const boxes = $$('#otp-boxes input');
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        $('#otp-err').classList.add('hidden');
        if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
        if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
        if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
      });
      box.addEventListener('paste', e => {
        e.preventDefault();
        const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6).split('');
        d.forEach((c, k) => { if (boxes[k]) boxes[k].value = c; });
        boxes[Math.min(d.length, boxes.length - 1)].focus();
      });
    });

    /* Step 2 — OTP. A verified account with no password goes on to set one. */
    $('#otp-form').addEventListener('submit', async e => {
      e.preventDefault();
      const code = boxes.map(b => b.value).join('');
      const btn = $('#otp-submit');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const res = await Api.auth.verifyOtp(phone, code, appliedReferral);
        localStorage.removeItem('khelbro.referral');
        clearInterval(timer);
        toast(res.isNew && appliedReferral ? 'Welcome! Referral bonus activated 🎉' : 'Welcome to Khelbro!', 'success');
        if (res.isNew || res.needsPassword || resettingPassword || res.user?.hasPassword === false) {
          goToSetPassword();
        } else {
          goNext();
        }
      } catch (err) {
        $('#otp-err').textContent = err.message;
        $('#otp-err').classList.remove('hidden');
        boxes.forEach(b => b.classList.add('border-live'));
        setTimeout(() => boxes.forEach(b => b.classList.remove('border-live')), 1200);
      } finally { btn.disabled = false; btn.textContent = 'Verify & sign in'; }
    });

    /* Step 3 — create the password. The confirm field is checked here; the
       strength rules are the server's, so its message is what gets shown. */
    $('#setpw-form').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = $('#new-password').value;
      const confirm = $('#confirm-password').value;
      if (pw.length < 6) return fail('#setpw-err', 'Password must be at least 6 characters.');
      if (pw !== confirm) return fail('#setpw-err', 'Both passwords must match.');
      const btn = $('#setpw-submit');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await Api.auth.setPassword(pw);
        toast(resettingPassword ? 'Password updated' : 'Password saved — use it to sign in next time', 'success');
        goNext();
      } catch (err) {
        fail('#setpw-err', err.message);
        btn.disabled = false;
        btn.textContent = resettingPassword ? 'Save new password' : 'Save password & continue';
      }
    });

    [$('#new-password'), $('#confirm-password')].forEach(el =>
      el.addEventListener('input', () => clearFail('#setpw-err')));

    $('#otp-resend').addEventListener('click', async () => {
      try { await sendOtp(); toast('New code sent', 'info'); }
      catch (err) { toast(err.message, 'error'); }
    });

    $('#otp-change').addEventListener('click', () => {
      clearInterval(timer);
      resettingPassword = false;
      showStep('step-phone');
      input.focus();
    });

    /* A session with no password yet: someone who closed the tab on the setup
       step. Finish it rather than letting them stay on the OTP path forever.
       Every handler above is bound by now, so the form actually works. */
    if (K.state.user && K.state.user.hasPassword === false) {
      phone = K.state.user.phone || '';
      goToSetPassword();
    }
  });
})();
