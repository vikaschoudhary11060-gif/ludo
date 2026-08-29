/* Add cash — server-validated deposit. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, $$, money, toast, copy } = K;
  const CHIPS = [100, 250, 500, 1000, 2500, 5000];
  let LIM = { min: 100, max: 10000 };
  let activeQrImage = null;

  function paint(amount) {
    const qrWrap = $('#qr-wrap');
    const qrLimitNote = $('#qr-limit-note');
    if (activeQrImage) {
      if (amount > 2000) {
        if (qrWrap) qrWrap.hidden = true;
        if (qrLimitNote) qrLimitNote.classList.remove('hidden');
      } else {
        if (qrWrap) qrWrap.hidden = false;
        if (qrLimitNote) qrLimitNote.classList.add('hidden');
      }
    } else {
      if (qrWrap) qrWrap.hidden = true;
      if (qrLimitNote) qrLimitNote.classList.add('hidden');
    }
  }

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    let conf = {};
    try { conf = await Api.config(); LIM = conf.deposit; } catch {}
    // Each player is assigned one of the active UPI/QR accounts.
    try {
      const { method } = await Api.wallet.depositMethod();
      if (method) {
        $('#upi-id-value').textContent = method.upiId;
        if (method.label) { const el = $('#upi-label'); if (el) el.textContent = method.label; }
        if (method.qrImage) {
          activeQrImage = method.qrImage;
          $('#qr-img').src = (window.KHELBRO_API || '') + method.qrImage;
          $('#qr-wrap').hidden = false;
        }
      } else if (conf.upiId) {
        $('#upi-id-value').textContent = conf.upiId;
        if (conf.qrImage) {
          activeQrImage = conf.qrImage;
          $('#qr-img').src = (window.KHELBRO_API || '') + conf.qrImage;
          $('#qr-wrap').hidden = false;
        }
      }
    } catch {}

    // Route switch: instant vs pay-by-UPI
    $$('[data-route]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-route]').forEach(b => b.classList.toggle('is-active', b === btn));
      const manual = btn.dataset.route === 'manual';
      $('#manual-route').hidden = !manual;
      $('#pay-btn').hidden = manual;
      $('#instant-note').hidden = manual;
      if (manual) {
        paint(Number($('#deposit').value) || 0);
        renderRequests();
      }
    }));

    $('#copy-upi').addEventListener('click', () => copy($('#upi-id-value').textContent, 'UPI ID copied'));

    $('#utr').addEventListener('input', () => $('#utr-err').classList.add('hidden'));
    if ($('#proof-file')) $('#proof-file').addEventListener('change', () => $('#utr-err').classList.add('hidden'));

    $('#utr-btn').addEventListener('click', async () => {
      const amount = Number($('#deposit').value);
      const utr = $('#utr').value.trim();
      const proofFile = $('#proof-file') ? $('#proof-file').files[0] : null;
      const fail = m => { $('#utr-err').textContent = m; $('#utr-err').classList.remove('hidden'); };
      if (!amount) return fail('Choose an amount first.');
      if (!utr) return fail('UTR number is required.');
      if (utr.length < 10 || utr.length > 20) return fail('UTR number length should be between 10-20 characters.');
      if (!proofFile) return fail('Please attach payment screenshot.');

      const btn = $('#utr-btn');
      btn.disabled = true; btn.textContent = 'Uploading screenshot…';
      try {
        const up = await Api.uploads.proof(proofFile);
        btn.textContent = 'Submitting request…';
        await Api.wallet.depositRequest(amount, utr, up.url);
        toast('Deposit request submitted for verification', 'success');
        $('#utr').value = '';
        if ($('#proof-file')) $('#proof-file').value = '';
        await renderRequests();
      } catch (err) { fail(err.message); }
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
      $$('#amount-chips .chip').forEach(c => c.classList.remove('is-active'));
      paint(Number(e.target.value) || 0);
    });

    $('#pay-btn').addEventListener('click', async () => {
      const v = Number($('#deposit').value);
      const btn = $('#pay-btn');
      btn.disabled = true; btn.textContent = 'Processing…';
      try {
        const res = await Api.wallet.deposit(v);
        toast(`${money(res.credited)} added to your wallet`, 'success');
        await K.refresh(); K.paint();
        setTimeout(() => (location.href = 'wallet.html'), 600);
      } catch (err) {
        $('#deposit-err').textContent = err.message;
        $('#deposit-err').classList.remove('hidden');
        $('#deposit').classList.add('field-error');
        btn.disabled = false; btn.textContent = 'Add cash';
      }
    });
    paint(0);
  });
})();
