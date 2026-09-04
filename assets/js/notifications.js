/* Notifications — from the API. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, toast } = K;
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
  const getNotifications = Api.isLoggedIn()
    ? warm(() => Api.users.notifications())
    : () => Api.users.notifications();


  async function render() {
    let list = [];
    try { list = (await getNotifications()).notifications; } catch {}
    $('#note-empty').hidden = list.length > 0;
    $('#note-list').innerHTML = list.map(n => `
      <li class="rounded-tile border ${n.read ? 'border-line bg-surface' : 'border-brand/40 bg-brand/5'} p-3.5">
        <div class="flex items-start gap-3">
          <span class="mt-1 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-line' : 'bg-brand'}" aria-hidden="true"></span>
          <div class="flex-1">
            <p class="text-body font-bold text-ink">${n.title}</p>
            <p class="mt-0.5 text-body-sm text-muted">${n.body || ''}</p>
            <p class="mt-1 text-meta text-muted">${new Date(n.created_at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</p>
          </div>
        </div>
      </li>`).join('');
  }

  K.ready.then(async () => {
    if (!K.requireSession()) return;
    await render();
    $('#mark-read').addEventListener('click', async () => {
      await Api.users.markRead(); await render(); toast('All marked read', 'success');
    });
  });
})();
