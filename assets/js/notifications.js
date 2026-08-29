/* Notifications — from the API. */
(function () {
  'use strict';
  const K = window.Khelbro; const { $, toast } = K;

  async function render() {
    let list = [];
    try { list = (await Api.users.notifications()).notifications; } catch {}
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
