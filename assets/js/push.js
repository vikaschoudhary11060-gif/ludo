/* ============================================================
   Push notification opt-in.

   The prompt is deliberately NOT shown on page load: a denial is
   permanent, so we ask only after the user has done something
   that makes the value obvious (created or joined a battle).
   ============================================================ */
(function () {
  'use strict';

  const SUPPORTED = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ASKED_KEY = 'khelbro.pushAsked';

  const urlBase64ToUint8Array = base64 => {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  };

  async function currentSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function subscribe() {
    if (!SUPPORTED) return { ok: false, reason: 'unsupported' };
    if (!window.Api || !Api.isLoggedIn()) return { ok: false, reason: 'signed-out' };

    const permission = await Notification.requestPermission();
    localStorage.setItem(ASKED_KEY, '1');
    if (permission !== 'granted') return { ok: false, reason: permission };

    const { enabled, publicKey } = await Api.push.key();
    if (!enabled || !publicKey) return { ok: false, reason: 'server-disabled' };

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await Api.push.subscribe(sub.toJSON());
    return { ok: true };
  }

  async function unsubscribe() {
    const sub = await currentSubscription();
    if (!sub) return;
    try { await Api.push.unsubscribe(sub.endpoint); } catch {}
    await sub.unsubscribe();
  }

  /* A small opt-in card, shown once, after a meaningful action. */
  function offer(reason) {
    if (!SUPPORTED || localStorage.getItem(ASKED_KEY)) return;
    if (Notification.permission !== 'default') return;
    if (document.getElementById('push-offer')) return;

    const card = document.createElement('div');
    card.id = 'push-offer';
    card.className =
      'fixed inset-x-0 bottom-4 z-[85] mx-auto flex w-[min(92%,440px)] items-start gap-3 ' +
      'rounded-card border border-line bg-surface p-4 shadow-card animate-slide-up';
    card.innerHTML =
      '<span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand/10 text-h3" aria-hidden="true">🔔</span>' +
      '<span class="flex-1"><span class="block text-body font-bold text-ink">Get notified</span>' +
      `<span class="block text-body-sm text-muted">${reason}</span></span>`;

    const actions = document.createElement('span');
    actions.className = 'flex shrink-0 flex-col gap-1.5';
    const yes = document.createElement('button');
    yes.className = 'btn btn-primary !min-h-[34px] !px-3 !text-meta';
    yes.textContent = 'Turn on';
    const no = document.createElement('button');
    no.className = 'btn btn-outline !min-h-[34px] !px-3 !text-meta';
    no.textContent = 'Not now';
    actions.append(yes, no);
    card.appendChild(actions);

    yes.addEventListener('click', async () => {
      card.remove();
      const r = await subscribe();
      if (window.Khelbro) {
        Khelbro.toast(r.ok ? 'Notifications on' :
          r.reason === 'denied' ? 'Notifications blocked in your browser settings' :
          'Could not enable notifications', r.ok ? 'success' : 'error');
      }
    });
    no.addEventListener('click', () => { localStorage.setItem(ASKED_KEY, '1'); card.remove(); });

    document.body.appendChild(card);
    setTimeout(() => card.isConnected && card.remove(), 15000);
  }

  window.KhelbroPush = { supported: () => SUPPORTED, subscribe, unsubscribe, offer, currentSubscription };
})();
