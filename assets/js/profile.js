/* Profile — avatar, name, email, edit profile modal, KYC status. */
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
      const url = user.avatarUrl;
      const glyph = GLYPHS[user.avatar || 0] || '♟';

      // Main header avatar
      const mainImg = $('#avatar-photo');
      const mainGlyph = $('#avatar-glyph');
      if (mainImg && mainGlyph) {
        if (url) {
          mainImg.src = (window.KHELBRO_API || '') + url;
          mainImg.hidden = false;
          mainGlyph.style.visibility = 'hidden';
        } else {
          mainImg.hidden = true;
          mainGlyph.style.visibility = '';
          mainGlyph.textContent = glyph;
        }
      }

      // Edit sheet avatar preview
      const editImg = $('#edit-avatar-photo');
      const editGlyph = $('#edit-avatar-glyph');
      if (editImg && editGlyph) {
        if (url) {
          editImg.src = (window.KHELBRO_API || '') + url;
          editImg.hidden = false;
          editGlyph.style.visibility = 'hidden';
        } else {
          editImg.hidden = true;
          editGlyph.style.visibility = '';
          editGlyph.textContent = glyph;
        }
      }
    }

    function syncProfileForm(user) {
      if (!user) return;
      if ($('#edit-name')) $('#edit-name').value = user.name || '';
      if ($('#edit-email')) $('#edit-email').value = user.email || '';
      if ($('#edit-phone-display')) $('#edit-phone-display').textContent = user.phone ? '+91 ' + user.phone : '+91 —';
      if ($('#edit-profile-summary')) $('#edit-profile-summary').textContent = user.name ? `${user.name}` : 'Name & Details';
      if ($('#edit-name-err')) $('#edit-name-err').classList.add('hidden');
      if ($('#edit-email-err')) $('#edit-email-err').classList.add('hidden');
      paintAvatar(user);
    }

    paintAvatar(u);
    syncProfileForm(u);

    if (u.email) $('#email-label').textContent = u.email;
    $('#email-verified').hidden = !u.emailVerified;

    // Photo upload
    $('#avatar-file').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const up = await Api.uploads.avatar(file);
        await K.refresh();
        const updated = K.state.user || { avatarUrl: up.url };
        paintAvatar(updated);
        $('#avatar-sheet').hidden = true;
        toast('Photo updated', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    // Edit Profile Modal handlers
    $$('[data-modal-open="edit-profile-sheet"]').forEach(btn => {
      btn.addEventListener('click', () => {
        syncProfileForm(K.state.user || u);
      });
    });

    if ($('#edit-profile-form')) {
      $('#edit-name').addEventListener('input', () => {
        $('#edit-name-err').classList.add('hidden');
        $('#edit-name').classList.remove('field-error');
      });
      $('#edit-email').addEventListener('input', () => {
        $('#edit-email-err').classList.add('hidden');
        $('#edit-email').classList.remove('field-error');
      });

      $('#edit-profile-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#edit-name').value.trim();
        const email = $('#edit-email').value.trim();

        // Validation
        if (!name || name.length < 3 || name.length > 20) {
          $('#edit-name-err').textContent = 'Name must be between 3 and 20 characters.';
          $('#edit-name-err').classList.remove('hidden');
          $('#edit-name').classList.add('field-error');
          $('#edit-name').focus();
          return;
        }

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          $('#edit-email-err').textContent = 'Please enter a valid email address.';
          $('#edit-email-err').classList.remove('hidden');
          $('#edit-email').classList.add('field-error');
          $('#edit-email').focus();
          return;
        }

        await busy($('#save-profile-btn'), 'Saving…', async () => {
          try {
            const patch = { name };
            if (email) patch.email = email;

            const res = await Api.users.update(patch);
            if (res.user) {
              K.state.user = { ...K.state.user, ...res.user };
            }
            await K.refresh();
            K.paint();

            const refreshedUser = K.state.user || res.user;
            syncProfileForm(refreshedUser);
            if (refreshedUser.email) $('#email-label').textContent = refreshedUser.email;
            $('#email-verified').hidden = !refreshedUser.emailVerified;

            $('#edit-profile-sheet').hidden = true;
            toast('Profile updated successfully!', 'success');
          } catch (err) {
            if (err.message && err.message.toLowerCase().includes('name')) {
              $('#edit-name-err').textContent = err.message;
              $('#edit-name-err').classList.remove('hidden');
              $('#edit-name').classList.add('field-error');
            } else if (err.message && err.message.toLowerCase().includes('email')) {
              $('#edit-email-err').textContent = err.message;
              $('#edit-email-err').classList.remove('hidden');
              $('#edit-email').classList.add('field-error');
            } else {
              toast(err.message, 'error');
            }
          }
        });
      });
    }

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
        $('#avatar-sheet').hidden = true;
        await K.refresh();
        K.paint();
        paintAvatar(K.state.user);
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
