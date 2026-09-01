/* Redeem page — move referral earnings into withdrawable winnings */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, money, toast, busy } = K;

  K.ready.then(async () => {
    if (!K.requireSession()) return;

    const btn = $('#redeem-btn');
    const referralBal = K.state.wallet?.referral || 0;
    if (btn) btn.disabled = referralBal <= 0;

    btn?.addEventListener('click', e => busy(e.currentTarget, 'Redeeming', async () => {
      try {
        const res = await Api.wallet.redeemReferral();
        toast(`${money(res.redeemed)} redeemed into your winnings! 🎁`, 'success');
        btn.disabled = true;
        await K.refresh();
        K.paint();
        setTimeout(() => { location.href = 'wallet.html'; }, 1000);
      } catch (err) {
        toast(err.message, 'error');
      }
    }));
  });
})();
