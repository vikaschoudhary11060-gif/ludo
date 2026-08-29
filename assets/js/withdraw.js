/* Withdraw — KYC-gated, server-validated. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money, toast } = K;
  let method = 'upi';

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    let conf = {};
    try { conf = await Api.config(); } catch {}
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

    // Populate the bank list (kept in banks.js so the page stays small).
    const bankSel = $('#bank-name');
    if (bankSel && window.KHELBRO_BANKS) {
      bankSel.insertAdjacentHTML('beforeend',
        window.KHELBRO_BANKS.map(b => `<option>${b}</option>`).join(''));
    }

    $$('[data-method]').forEach(btn => btn.addEventListener('click', () => {
      method = btn.dataset.method;
      $$('[data-method]').forEach(b => b.classList.toggle('is-active', b === btn));
      $('#upi-fields').hidden = method !== 'upi';
      $('#bank-fields').hidden = method !== 'bank';
    }));

    $('#wd-amount').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
      $('#wd-err').classList.add('hidden');
    });

    const fail = msg => { $('#wd-err').textContent = msg; $('#wd-err').classList.remove('hidden'); };

    $('#wd-btn').addEventListener('click', async () => {
      const payload = { amount: Number($('#wd-amount').value), method };
      if (method === 'upi') payload.upiId = $('#upi-id').value.trim();
      else {
        if (!$('#bank-name').value) return fail('Select your bank.');
        payload.bankName = $('#bank-name') ? $('#bank-name').value : '';
        payload.accountName = $('#acc-name').value.trim();
        payload.accountNumber = $('#acc-no').value.trim();
        payload.ifsc = $('#ifsc').value.trim().toUpperCase();
      }
      const btn = $('#wd-btn');
      btn.disabled = true; btn.textContent = 'Requesting…';
      try {
        await Api.wallet.withdraw(payload);
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
