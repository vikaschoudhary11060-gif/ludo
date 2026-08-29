/* Login — real OTP against the API. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, toast } = K;
  let phone = '', timer = null;

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
    if (res.devCode) { $('#otp-demo').textContent = res.devCode; $('#otp-hint').hidden = false; }
    else $('#otp-hint').hidden = true;
    startTimer(30);
  }

  K.ready.then(() => {
    if (K.state.user) { location.replace('profile.html'); return; }

    const input = $('#phone');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 10);
      $('#phone-err').classList.add('hidden');
      input.classList.remove('field-error');
    });

    $('#phone-form').addEventListener('submit', async e => {
      e.preventDefault();
      const v = input.value.trim();
      if (!/^[6-9]\d{9}$/.test(v)) {
        $('#phone-err').classList.remove('hidden');
        input.classList.add('field-error'); input.focus();
        return;
      }
      phone = v;
      const btn = $('#phone-submit');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await sendOtp();
        $('#otp-target').textContent = '+91 ' + phone;
        $('#step-phone').hidden = true;
        $('#step-otp').hidden = false;
        $$('#otp-boxes input')[0].focus();
        toast('Code sent', 'success');
      } catch (err) {
        $('#phone-err').textContent = err.message;
        $('#phone-err').classList.remove('hidden');
      } finally { btn.disabled = false; btn.textContent = 'Continue'; }
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

    $('#otp-form').addEventListener('submit', async e => {
      e.preventDefault();
      const code = boxes.map(b => b.value).join('');
      const btn = $('#otp-submit');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await Api.auth.verifyOtp(phone, code);
        toast('Welcome to Khelbro!', 'success');
        const next = new URLSearchParams(location.search).get('next') || 'index.html';
        setTimeout(() => (location.href = next), 400);
      } catch (err) {
        $('#otp-err').textContent = err.message;
        $('#otp-err').classList.remove('hidden');
        boxes.forEach(b => b.classList.add('border-live'));
        setTimeout(() => boxes.forEach(b => b.classList.remove('border-live')), 1200);
        btn.disabled = false; btn.textContent = 'Verify & sign in';
      }
    });

    $('#otp-resend').addEventListener('click', async () => {
      try { await sendOtp(); toast('New code sent', 'info'); }
      catch (err) { toast(err.message, 'error'); }
    });

    $('#otp-change').addEventListener('click', () => {
      clearInterval(timer);
      $('#step-otp').hidden = true; $('#step-phone').hidden = false; input.focus();
    });
  });
})();
