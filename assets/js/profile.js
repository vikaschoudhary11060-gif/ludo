/* Profile — avatar, email, KYC status. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, toast, busy } = K;
  const GLYPHS = ['♟','♕','♛','♞','♜','⚑','★','⚽'];
  const TINTS = ['bg-ludo-red','bg-ludo-green','bg-ludo-yellow','bg-ludo-blue','bg-brand','bg-gold','bg-cta','bg-muted'];

  K.ready.then(() => {
    if (!K.requireSession()) return;
    const u = K.state.user;

    function paintAvatar(user) {
      if (user.avatarUrl) {
        const img = $('#avatar-photo');
        img.src = (window.KHELBRO_API || '') + user.avatarUrl;
        img.hidden = false;
        $('#avatar-glyph').style.visibility = 'hidden';
      } else {
        $('#avatar-photo').hidden = true;
        $('#avatar-glyph').style.visibility = '';
        $('#avatar-glyph').textContent = GLYPHS[user.avatar || 0];
      }
    }
    paintAvatar(u);

    if (u.email) $('#email-label').textContent = u.email;
    $('#email-verified').hidden = !u.emailVerified;

    // Photo upload
    $('#avatar-file').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const up = await Api.uploads.avatar(file);
        await K.refresh();
        paintAvatar(K.state.user || { avatarUrl: up.url });
        $('#avatar-sheet').hidden = true;
        toast('Photo updated', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    // Email verification
    async function askForCode() {
      try {
        const r = await Api.users.requestEmailCode();
        $('#verify-block').hidden = false;
        if (r.devCode) { $('#verify-hint').classList.remove('hidden'); $('#verify-demo').textContent = r.devCode; }
        toast('Verification code sent', 'success');
      } catch (err) { toast(err.message, 'error'); }
    }
    if (u.email && !u.emailVerified) $('#verify-block').hidden = true;

    $('#verify-btn').addEventListener('click', e => busy(e.currentTarget, '', async () => {
      try {
        await Api.users.verifyEmail($('#verify-code').value.trim());
        toast('Email verified', 'success');
        await K.refresh();
        $('#email-verified').hidden = false;
        $('#email-sheet').hidden = true;
      } catch (err) {
        $('#verify-err').textContent = err.message;
        $('#verify-err').classList.remove('hidden');
      }
    }));
    $('#kyc-label').textContent =
      u.kyc === 'done' ? 'KYC completed ✅' : u.kyc === 'pending' ? 'KYC under review ⏳' : 'Complete KYC';

    $('#avatar-grid').innerHTML = GLYPHS.map((g, i) =>
      `<button class="grid aspect-square place-items-center rounded-tile ${TINTS[i]} text-h2 text-white transition hover:scale-105"
               type="button" data-avatar="${i}" aria-label="Avatar ${i + 1}">${g}</button>`).join('');

    $('#avatar-grid').addEventListener('click', async e => {
      const btn = e.target.closest('[data-avatar]'); if (!btn) return;
      try {
        await Api.users.update({ avatar: Number(btn.dataset.avatar) });
        $('#avatar-glyph').textContent = GLYPHS[btn.dataset.avatar];
        $('#avatar-sheet').hidden = true;
        await K.refresh(); K.paint();
        toast('Avatar updated', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    $('#email-form').addEventListener('submit', async e => {
      e.preventDefault();
      const v = $('#email-input').value.trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
      $('#email-err').classList.toggle('hidden', ok);
      $('#email-input').classList.toggle('field-error', !ok);
      if (!ok) return;
      try {
        await Api.users.update({ email: v });
        $('#email-label').textContent = v;
        $('#email-verified').hidden = true;
        toast('Email saved', 'success');
        await askForCode();          // straight into verification
      } catch (err) { toast(err.message, 'error'); }
    });
  });
})();
