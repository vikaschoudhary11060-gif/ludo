/* KYC — submitted to the API for review. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, toast, busy } = K;

  K.ready.then(() => {
    if (!K.requireSession()) return;
    const state = K.state.user.kyc || 'none';
    $('#kyc-done').hidden = state !== 'done';
    $('#kyc-pending').hidden = state !== 'pending';
    $('#kyc-form').hidden = true;
    $('#kyc-choose').hidden = state !== 'none';
    if (state !== 'none') return;

    // Route picker
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-kyc-route]');
      if (!btn) return;
      const route = btn.dataset.kycRoute;
      $('#kyc-choose').hidden = route !== 'choose';
      $('#kyc-ekyc').hidden = route !== 'ekyc';
      $('#kyc-form').hidden = route !== 'manual';
    });

    $('#ekyc-code').addEventListener('input', e => {
      e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4);
      $('#ekyc-err').classList.add('hidden');
    });

    $('#ekyc-submit').addEventListener('click', e => busy(e.currentTarget, 'Verifying', async () => {
      const file = $('#ekyc-file').files[0];
      const code = $('#ekyc-code').value.trim();
      const fail = m => { $('#ekyc-err').textContent = m; $('#ekyc-err').classList.remove('hidden'); };
      if (!file) return fail('Choose your eKYC ZIP file.');
      if (code.length !== 4) return fail('Enter the 4-character share code.');
      try {
        const r = await Api.uploads.ekyc(file, code);
        const box = $('#ekyc-result');
        box.classList.remove('hidden');
        box.innerHTML =
          `<p class="text-body font-bold text-ink">${r.name || '—'}</p>
           <p class="text-body-sm text-muted">DOB ${r.dob || '—'} · ${r.maskedAadhaar || ''}</p>
           <p class="mt-2 text-body-sm ${r.status === 'done' ? 'text-cta' : 'text-gold-deep'}">
             ${r.status === 'done'
               ? 'Verified — withdrawals unlocked.'
               : 'Received. ' + (r.certificateConfigured
                   ? 'Signature could not be confirmed, so a reviewer will check it.'
                   : 'Awaiting reviewer confirmation.')}
           </p>`;
        toast(r.status === 'done' ? 'KYC verified' : 'KYC submitted for review',
              r.status === 'done' ? 'success' : 'info');
        await K.refresh();
        setTimeout(() => location.reload(), 1800);
      } catch (err) { fail(err.message); }
    }));

    $('#kyc-id').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g,'').slice(0,12); });

    $('#kyc-form').addEventListener('submit', async e => {
      e.preventDefault();
      const docs = ['#doc-front','#doc-back','#doc-selfie'].every(s => $(s).files.length);
      $('#doc-err').classList.toggle('hidden', docs);
      if (!docs) { toast('Attach all three documents', 'error'); return $('#doc-front').focus(); }
      const submitBtn = e.target.querySelector('button[type=submit]');
      await busy(submitBtn, 'Submitting', async () => {
      try {
        await Api.users.submitKyc({
          legalName: $('#kyc-name').value.trim(),
          dob: $('#kyc-dob').value,
          idNumber: $('#kyc-id').value.trim(),
        });
        toast('Documents submitted — KYC pending review', 'success');
        await K.refresh();
        setTimeout(() => location.reload(), 700);
      } catch (err) { toast(err.message, 'error'); }
      });
    });
  });
})();
