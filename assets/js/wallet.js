/* Wallet — balances straight from the API. */
(function () {
  'use strict';
  const K = window.Khelbro;
  K.ready.then(() => {
    if (!K.state.user) return;
    if (!sessionStorage.getItem('khelbro.walletNotice')) {
      const m = K.$('#wallet-notice');
      if (m) { m.hidden = false; sessionStorage.setItem('khelbro.walletNotice', '1'); (m.querySelector('button') || m).focus(); }
    }
  });
})();
