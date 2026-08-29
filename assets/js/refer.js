/* Refer & earn — code, share, referral list, redeem. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, money, toast } = K;

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    let data = { code: K.state.user.referralCode, referrals: [], total: 0 };
    try { data = await Api.users.referrals(); } catch {}

    $('#refer-code').textContent = data.code;
    $('#ref-count').textContent = data.referrals.length;
    $('#ref-empty').hidden = data.referrals.length > 0;
    $('#ref-list').innerHTML = data.referrals.map(r => `
      <li class="flex items-center gap-3 rounded-tile border border-line bg-surface p-3">
        <span class="grid h-9 w-9 place-items-center rounded-full bg-brand text-body font-bold text-white"
              aria-hidden="true">${r.name.slice(0,1)}</span>
        <span class="flex-1 text-body font-bold text-ink">${r.name}</span>
        <span class="text-body-sm font-bold text-cta">${money(r.earned)}</span>
      </li>`).join('');

    $('#copy-code').addEventListener('click', () => copy(data.code, 'Referral code copied'));
    $('#share-wa').addEventListener('click', () => {
      const text = `Play Ludo with me on Khelbro! Use my code ${data.code} for a bonus on your first battle.`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    });

    const redeem = $('#redeem-btn');
    if (redeem) redeem.addEventListener('click', e => busy(e.currentTarget, 'Redeeming', async () => {
      try {
        const r = await Api.wallet.redeemReferral();
        toast(`${money(r.redeemed)} moved to your deposit balance`, 'success');
        await K.refresh(); K.paint();
      } catch (err) { toast(err.message, 'error'); }
    }));
  });
})();
