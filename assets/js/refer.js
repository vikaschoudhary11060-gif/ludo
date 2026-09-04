/* Refer & earn — code, shareable link, social sharing, stats, and redemption. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, money, toast, copy, busy } = K;

  /* `Api.warm` may be absent for one navigation after a deploy: the service
     worker keeps api.js in its cached shell and serves it stale-while-
     revalidate, so a fresh copy of THIS file can be paired with the previous
     api.js. Falling back to calling the function directly is exactly what this
     page did before warming existed, so the worst case is the old timing —
     never a broken page. */
  const warm = (window.Api && Api.warm) || (fn => fn);
  /* Issued now instead of after /api/auth/me and /api/config, neither of
     which this request depends on. Gated on the token, the same condition
     requireSession() resolves to, so a signed-out visitor still issues
     nothing. Only the first call is served from the warm one. */
  const getReferralStats = Api.isLoggedIn()
    ? warm(() => Api.referrals.stats())
    : () => Api.referrals.stats();

  function formatDate(ts) {
    if (!ts) return 'Recently';
    const d = new Date(ts);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  K.ready.then(async () => {
    if (!K.requireSession()) return;

    let stats = {
      code: K.state.user?.referralCode || 'KHEL-0000',
      rate: 0.02,
      ratePercentage: 2,
      totalEarned: 0,
      unredeemed: K.state.wallet?.referral || 0,
      referralsCount: 0,
      referrals: [],
    };

    try {
      stats = await getReferralStats();
    } catch (e) {
      console.error('Failed to load referral stats', e);
    }

    const code = stats.code || K.state.user?.referralCode || 'KHEL-0000';
    const origin = window.location.origin;
    const shareUrl = `${origin}/login.html?ref=${encodeURIComponent(code)}`;

    // Set UI code and link
    const codeEl = $('#refer-code');
    if (codeEl) codeEl.textContent = code;

    const linkInput = $('#refer-link-input');
    if (linkInput) linkInput.value = shareUrl;

    const rateBadge = $('#ref-rate-badge');
    if (rateBadge) rateBadge.textContent = `${stats.ratePercentage || 2}%`;

    // Set stats
    const countEl = $('#ref-count');
    if (countEl) countEl.textContent = stats.referralsCount || stats.referrals?.length || 0;

    const totalEl = $('#ref-total-earned');
    if (totalEl) totalEl.textContent = money(stats.totalEarned || 0);

    const unredeemedEl = $('#ref-unredeemed');
    const unredeemedAmount = stats.unredeemed || K.state.wallet?.referral || 0;
    if (unredeemedEl) unredeemedEl.textContent = money(unredeemedAmount);

    const summaryCountEl = $('#ref-summary-count');
    if (summaryCountEl) summaryCountEl.textContent = `${stats.referrals?.length || 0} players`;

    // Redeem button state
    const redeemBtn = $('#redeem-btn');
    if (redeemBtn) {
      redeemBtn.disabled = unredeemedAmount <= 0;
      redeemBtn.addEventListener('click', e => busy(e.currentTarget, 'Redeeming', async () => {
        try {
          const res = await Api.wallet.redeemReferral();
          toast(`${money(res.redeemed)} added to your winnings! 🎁`, 'success');
          if (unredeemedEl) unredeemedEl.textContent = money(0);
          redeemBtn.disabled = true;
          await K.refresh();
          K.paint();
        } catch (err) {
          toast(err.message, 'error');
        }
      }));
    }

    // Render list of referred players
    const listEl = $('#ref-list');
    const emptyEl = $('#ref-empty');
    if (listEl && emptyEl) {
      if (stats.referrals && stats.referrals.length > 0) {
        emptyEl.hidden = true;
        listEl.innerHTML = stats.referrals.map(r => `
          <li class="flex items-center gap-3 rounded-tile border border-line bg-surface p-3 transition hover:border-brand/40">
            <span class="grid h-10 w-10 place-items-center rounded-full bg-brand text-body font-bold text-white shadow-sm"
                  aria-hidden="true">${(r.name || 'P').slice(0, 1).toUpperCase()}</span>
            <div class="flex-1 min-w-0">
              <p class="truncate text-body font-bold text-ink">${r.name || 'Player'}</p>
              <p class="text-[11px] text-muted">Joined ${formatDate(r.created_at)}</p>
            </div>
            <div class="text-right">
              <span class="block text-body-sm font-bold text-cta">+${money(r.earned || 0)}</span>
              <span class="text-[10px] text-muted font-medium">Earned</span>
            </div>
          </li>
        `).join('');
      } else {
        emptyEl.hidden = false;
        listEl.innerHTML = '';
      }
    }

    // Copy Code button
    const copyCodeBtn = $('#copy-code');
    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', () => copy(code, 'Referral code copied! 📋'));
    }

    // Copy Link button
    const copyLinkBtn = $('#copy-link');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => copy(shareUrl, 'Referral link copied! 🔗'));
    }

    // Share message text
    const shareMessage = `🔥 Play Ludo on Khelbro and win real cash prizes! Use my referral code *${code}* or join directly with this link: ${shareUrl}`;

    // WhatsApp Share
    const shareWaBtn = $('#share-wa');
    if (shareWaBtn) {
      shareWaBtn.addEventListener('click', () => {
        window.open('https://api.whatsapp.com/send?text=' + encodeURIComponent(shareMessage), '_blank', 'noopener');
      });
    }

    // Telegram Share
    const shareTgBtn = $('#share-tg');
    if (shareTgBtn) {
      shareTgBtn.addEventListener('click', () => {
        window.open('https://t.me/share/url?url=' + encodeURIComponent(shareUrl) + '&text=' + encodeURIComponent(`Play Ludo with me on Khelbro! Use code ${code}`), '_blank', 'noopener');
      });
    }

    // Native Web Share API
    const shareNativeBtn = $('#share-native');
    if (shareNativeBtn) {
      shareNativeBtn.addEventListener('click', async () => {
        if (navigator.share) {
          try {
            await navigator.share({
              title: 'Play Ludo on Khelbro',
              text: `Play Ludo on Khelbro with me! Use my referral code ${code}`,
              url: shareUrl,
            });
          } catch {
            // User cancelled or share failed
          }
        } else {
          copy(shareUrl, 'Referral link copied to clipboard! 🔗');
        }
      });
    }
  });
})();
