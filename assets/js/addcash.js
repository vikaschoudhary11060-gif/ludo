/* Add cash — manual UPI only.

   There is no instant top-up any more: the player pays our UPI ID or QR,
   submits the UTR, and an admin credits the wallet after checking it. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money, toast, copy } = K;
  const CHIPS = [100, 250, 500, 1000, 2500, 5000];
  let LIM = { min: 100, max: 10000 };
  let BONUS = null;                       // { per, amount } from /api/config
  let activeQrImage = null;

  /* The cashback rule lives on the server, so read it from /api/config
     rather than restating it here where the two can drift apart. */
  function paintBonus(amount) {
    const note = $('#bonus-note');
    if (!note) return;
    if (!BONUS || !BONUS.per || !BONUS.amount) { note.hidden = true; return; }
    const earned = Math.floor(Math.max(0, amount || 0) / BONUS.per) * BONUS.amount;
    note.textContent = earned > 0
      ? `Includes ${money(earned)} cashback — you will be credited ${money((amount || 0) + earned)}.`
      : `Add ${money(BONUS.per)} or more to earn ${money(BONUS.amount)} cashback.`;
    note.hidden = false;
  }

  function paint(amount) {
    paintBonus(amount);
    const qrWrap = $('#qr-wrap');
    const qrLimitNote = $('#qr-limit-note');
    if (activeQrImage) {
      /* A UPI QR carries a ₹2,000 ceiling for most banks, so above that the
         code would simply fail at the payment app — show the ID instead. */
      const overLimit = amount > 2000;
      if (qrWrap) qrWrap.hidden = overLimit;
      if (qrLimitNote) qrLimitNote.classList.toggle('hidden', !overLimit);
    } else {
      if (qrWrap) qrWrap.hidden = true;
      if (qrLimitNote) qrLimitNote.classList.add('hidden');
    }
  }

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    let conf = {};
    try {
      conf = await Api.config();
      if (conf.deposit) LIM = conf.deposit;
      BONUS = conf.bonus || null;
    } catch {}

    /* Deposits can be switched off from the admin console. Say so up front
       rather than letting someone pay us and then fail on submit. */
    if (conf.depositOpen === false) {
      $('#deposit-closed').hidden = false;
      $('#deposit-flow').hidden = true;
      return;
    }

    // Each player is assigned one of the active UPI/QR accounts.
    try {
      const { method } = await Api.wallet.depositMethod();
      if (method) {
        $('#upi-id-value').textContent = method.upiId;
        if (method.label) { const el = $('#upi-label'); if (el) el.textContent = method.label; }
        if (method.qrImage) activeQrImage = method.qrImage;
      } else if (conf.upiId) {
        $('#upi-id-value').textContent = conf.upiId;
        if (conf.qrImage) activeQrImage = conf.qrImage;
      }
      if (activeQrImage) $('#qr-img').src = (window.KHELBRO_API || '') + activeQrImage;
    } catch {}

    $('#copy-upi').addEventListener('click', () => copy($('#upi-id-value').textContent, 'UPI ID copied'));

    $('#utr').addEventListener('input', () => $('#utr-err').classList.add('hidden'));
    if ($('#proof-file')) $('#proof-file').addEventListener('change', () => $('#utr-err').classList.add('hidden'));

    const failUtr = m => { $('#utr-err').textContent = m; $('#utr-err').classList.remove('hidden'); };

    $('#utr-btn').addEventListener('click', async () => {
      const amount = Number($('#deposit').value);
      const utr = $('#utr').value.trim();
      const proofFile = $('#proof-file') ? $('#proof-file').files[0] : null;
      if (!amount) return failUtr('Choose an amount first.');
      if (amount < LIM.min) return failUtr(`Minimum deposit is ${money(LIM.min)}.`);
      if (amount > LIM.max) return failUtr(`Maximum deposit is ${money(LIM.max)}.`);
      if (!utr) return failUtr('UTR number is required.');
      if (utr.length < 10 || utr.length > 20) return failUtr('UTR number length should be between 10-20 characters.');

      const btn = $('#utr-btn');
      btn.disabled = true;
      try {
        /* The screenshot is optional, so a failed upload must not cost the
           player their request — fall through and submit the UTR alone. */
        let proofUrl;
        if (proofFile) {
          btn.textContent = 'Uploading screenshot…';
          try { proofUrl = (await Api.uploads.proof(proofFile)).url; }
          catch { toast('Screenshot could not be uploaded — sending the UTR on its own', 'info'); }
        }
        btn.textContent = 'Submitting request…';
        await Api.wallet.depositRequest(amount, utr, proofUrl);
        toast('Deposit request submitted for verification', 'success');
        $('#utr').value = '';
        if ($('#proof-file')) $('#proof-file').value = '';
        await renderRequests();
      } catch (err) { failUtr(err.message); }
      finally { btn.disabled = false; btn.textContent = 'Submit deposit request'; }
    });

    async function renderRequests() {
      let list = [];
      try { list = (await Api.wallet.depositRequests()).requests; } catch {}
      $('#req-empty').classList.toggle('hidden', list.length > 0);
      const tone = { pending: 'bg-gold/25 text-gold-deep', approved: 'bg-cta/15 text-cta-deep', rejected: 'bg-live/15 text-live' };
      const apiHost = window.KHELBRO_API || '';
      $('#req-list').innerHTML = list.map(r => `
        <li class="flex items-center gap-3 rounded-tile border border-line bg-surface p-3">
          ${r.proof ? `<a href="${apiHost + r.proof}" target="_blank" rel="noopener" class="shrink-0">
            <img src="${apiHost + r.proof}" alt="receipt" class="h-10 w-10 rounded border border-line object-cover"></a>` : ''}
          <span class="flex-1 min-w-0">
            <span class="block text-body font-bold text-ink">${money(r.amount)}</span>
            <span class="block text-meta text-muted truncate">UTR ${r.utr}</span>
          </span>
          <span class="rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase ${tone[r.status] || ''}">${r.status}</span>
        </li>`).join('');
    }

    $('#amount-chips').innerHTML = CHIPS.map(a =>
      `<button class="chip justify-center" type="button" data-amt="${a}">${money(a)}</button>`).join('');
    $('#amount-chips').addEventListener('click', e => {
      const b = e.target.closest('[data-amt]'); if (!b) return;
      $$('#amount-chips .chip').forEach(c => c.classList.toggle('is-active', c === b));
      $('#deposit').value = b.dataset.amt;
      $('#deposit-err').classList.add('hidden');
      paint(Number(b.dataset.amt));
    });
    $('#deposit').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5);
      $('#deposit-err').classList.add('hidden');
      $('#utr-err').classList.add('hidden');
      $$('#amount-chips .chip').forEach(c => c.classList.remove('is-active'));
      paint(Number(e.target.value) || 0);
    });

    paint(0);
    renderRequests();
  });
})();
