/* Withdraw — KYC-gated, server-validated. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money, toast } = K;
  let method = 'upi';
  let MIN = 100;                       // replaced by /api/config below

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    let conf = {};
    try { conf = await Api.config(); } catch {}
    if (conf.withdraw && Number.isFinite(conf.withdraw.min)) MIN = conf.withdraw.min;
    if (conf.withdrawOpen === false) { $('#withdraw-closed').hidden = false; return; }
    if (K.state.user.kyc !== 'done') { $('#kyc-gate').hidden = false; return; }
    $('#withdraw-form-wrap').hidden = false;

    // No winnings? Deposit money can't be withdrawn — steer them to play.
    const winnings = (K.state.wallet && K.state.wallet.winnings) || 0;
    if (winnings <= 0) {
      $('#no-winnings').hidden = false;
      $('#wd-amount').closest('section').style.opacity = '.5';
      $('#wd-amount').disabled = true;
      $('#wd-btn').disabled = true;
    }

    $('#wd-amount').placeholder = `Min ${MIN}`;

    // Populate the bank list (kept in banks.js so the page stays small).
    const bankSel = $('#bank-name');
    if (bankSel && window.KHELBRO_BANKS) {
      bankSel.insertAdjacentHTML('beforeend',
        window.KHELBRO_BANKS.map(b => `<option>${b}</option>`).join(''));
    }

    // Pre-fill previously saved bank and UPI details if present
    try {
      const savedBank = JSON.parse(localStorage.getItem('khelbro.saved_bank') || 'null');
      if (savedBank) {
        if (savedBank.bankName && $('#bank-name')) $('#bank-name').value = savedBank.bankName;
        if (savedBank.accountName && $('#acc-name')) $('#acc-name').value = savedBank.accountName;
        if (savedBank.accountNumber && $('#acc-no')) $('#acc-no').value = savedBank.accountNumber;
        if (savedBank.ifsc && $('#ifsc')) $('#ifsc').value = savedBank.ifsc;
      }
      const savedUpi = localStorage.getItem('khelbro.saved_upi');
      if (savedUpi && $('#upi-id')) $('#upi-id').value = savedUpi;
    } catch {}

    $$('[data-method]').forEach(btn => btn.addEventListener('click', () => {
      method = btn.dataset.method;
      $$('[data-method]').forEach(b => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      $('#upi-fields').hidden = method !== 'upi';
      $('#bank-fields').hidden = method !== 'bank';
      // Switching method must not leave the other method's error on screen.
      $('#wd-err').classList.add('hidden');
    }));

    $('#wd-amount').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
      $('#wd-err').classList.add('hidden');
    });

    /* Normalise as they type, so what the field shows is what gets sent —
       a pasted "HDFC0001234 " or "1234-5678" would otherwise fail validation
       for a reason the player cannot see. */
    $('#acc-no').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 18);
      $('#wd-err').classList.add('hidden');
    });
    $('#ifsc').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11);
      $('#wd-err').classList.add('hidden');
    });
    $('#upi-id').addEventListener('input', () => $('#wd-err').classList.add('hidden'));
    $('#acc-name').addEventListener('input', () => $('#wd-err').classList.add('hidden'));

    const fail = msg => { $('#wd-err').textContent = msg; $('#wd-err').classList.remove('hidden'); };

    /* The same shapes the server validates. Kept in step deliberately: a
       mismatch here means a form that either rejects valid details or lets
       through details the API will refuse with a generic message. */
    const UPI_RE = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;
    const ACCOUNT_RE = /^\d{9,18}$/;
    const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

    $('#wd-btn').addEventListener('click', async () => {
      const amount = Number($('#wd-amount').value);
      if (!amount) return fail('Enter an amount.');
      if (amount < MIN) return fail(`Minimum withdrawal is ${money(MIN)}.`);

      const payload = { amount, method };
      if (method === 'upi') {
        payload.upiId = $('#upi-id').value.trim();
        if (!UPI_RE.test(payload.upiId)) return fail('Enter a valid UPI ID, e.g. 9876543210@ybl.');
      } else {
        if (!$('#bank-name').value) return fail('Select your bank.');
        payload.bankName = $('#bank-name').value;
        payload.accountName = $('#acc-name').value.trim();
        payload.accountNumber = $('#acc-no').value.trim();
        payload.ifsc = $('#ifsc').value.trim().toUpperCase();
        if (payload.accountName.length < 3) return fail('Enter the account holder name.');
        if (!ACCOUNT_RE.test(payload.accountNumber)) return fail('Account number must be 9 to 18 digits.');
        if (!IFSC_RE.test(payload.ifsc)) return fail('Enter a valid IFSC code, e.g. HDFC0001234.');
      }
      const btn = $('#wd-btn');
      btn.disabled = true; btn.textContent = 'Requesting…';
      try {
        await Api.wallet.withdraw(payload);
        /* Remembered only once the server has accepted them, so a rejected
           set of details is never the one offered back next time. */
        if (method === 'upi') {
          localStorage.setItem('khelbro.saved_upi', payload.upiId);
        } else {
          localStorage.setItem('khelbro.saved_bank', JSON.stringify({
            bankName: payload.bankName,
            accountName: payload.accountName,
            accountNumber: payload.accountNumber,
            ifsc: payload.ifsc
          }));
        }
        toast('Withdrawal requested', 'success');
        await K.refresh(); K.paint();
        setTimeout(() => (location.href = 'transactions.html'), 600);
      } catch (err) {
        fail(err.message);
        btn.disabled = false; btn.textContent = 'Request withdrawal';
      }
    });
  });
})();
