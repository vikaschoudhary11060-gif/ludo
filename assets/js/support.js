/* Support — real live chat over the API + Socket.IO, plus the contact form. */
(function () {
  'use strict';
  const K = window.Khelbro;
  const { $, $$, toast, busy } = K;

  let threadId = null;
  let typingTimer = null;
  let lastId = 0;

  const time = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  function render(message) {
    if (message.id && message.id <= lastId) return;      // no duplicates from socket + fetch
    lastId = Math.max(lastId, message.id || 0);

    const mine = !message.fromAdmin;
    const wrap = document.createElement('div');
    wrap.className = mine
      ? 'ml-auto max-w-[85%] rounded-tile rounded-br-none bg-brand px-3 py-2 text-body-sm text-white'
      : 'max-w-[85%] rounded-tile rounded-tl-none bg-surface px-3 py-2 text-body-sm text-ink shadow-tile';

    let inner = '';
    if (message.kind === 'image' && message.attachment) {
      inner = `<a href="${(window.KHELBRO_API || '') + message.attachment}" target="_blank" rel="noopener">
                 <img src="${(window.KHELBRO_API || '') + message.attachment}" alt="attachment"
                      class="max-h-48 rounded-md"></a>`;
    } else {
      inner = `<span>${esc(message.body)}</span>`;
    }
    wrap.innerHTML = inner +
      `<span class="mt-1 block text-right text-[10px] ${mine ? 'text-white/70' : 'text-muted'}">${time(message.at)}</span>`;

    $('#chat-body').appendChild(wrap);
    $('#chat-body').scrollTop = $('#chat-body').scrollHeight;
  }

  function setPresence(online) {
    $('#presence-dot').className =
      'h-1.5 w-1.5 rounded-full ' + (online ? 'bg-cta' : 'bg-white/40');
    $('#presence-text').textContent = online ? 'Online now' : 'Typically replies in a few minutes';
  }

  async function load() {
    try {
      const data = await Api.chat.get();
      threadId = data.thread.id;
      $('#chat-body').innerHTML = '';
      lastId = 0;
      if (!data.messages.length) {
        $('#chat-body').innerHTML =
          '<p class="py-6 text-center text-body-sm text-muted">Start a conversation. We typically reply in a few minutes.</p>';
      }
      data.messages.forEach(render);
      setPresence(data.adminOnline);
      await Api.chat.read();
      paintUnread(0);
      if (K.socket) K.socket.emit('chat:join', { threadId });
    } catch (err) { toast(err.message, 'error'); }
  }

  function paintUnread(n) {
    const b = $('#chat-unread');
    if (!b) return;
    b.textContent = n > 0 ? n : '';
    b.classList.toggle('hidden', !n);
  }

  async function send(payload) {
    try {
      const { message } = await Api.chat.send(payload);
      render(message);
    } catch (err) { toast(err.message, 'error'); }
  }

  K.ready.then(async () => {
    /* ---- contact form (works signed out) ---- */
    $('#support-form').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#sup-email'), msg = $('#sup-msg');
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim());
      const msgOk = msg.value.trim().length >= 5;
      $('#sup-email-err').classList.toggle('hidden', emailOk);
      email.classList.toggle('field-error', !emailOk);
      $('#sup-msg-err').classList.toggle('hidden', msgOk);
      msg.classList.toggle('field-error', !msgOk);
      if (!emailOk) return email.focus();
      if (!msgOk) return msg.focus();
      await busy($('#sup-submit'), 'Sending', async () => {
        try {
          await Api.support.send({ topic: $('#sup-topic').value, email: email.value.trim(), message: msg.value.trim() });
          $('#support-form').reset();
          toast('Message sent — we’ll reply by email', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    /* ---- live chat needs an account ---- */
    if (!K.state.user) {
      $('#open-chat').addEventListener('click', e => {
        e.stopImmediatePropagation();
        toast('Sign in to use live chat', 'error');
        setTimeout(() => (location.href = 'login.html?next=support.html'), 700);
      }, true);
      return;
    }

    try { paintUnread((await Api.chat.unread()).unread); } catch {}
    $('#open-chat').addEventListener('click', () => setTimeout(load, 100));

    $('#chat-options').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn) send({ body: btn.textContent.trim() });
    });

    $('#chat-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send({ body: text });
    });

    // Photo attachment
    $('#chat-file').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const up = await Api.uploads.proof(file);      // same validated image endpoint
        await send({ kind: 'image', attachment: up.url });
      } catch (err) { toast(err.message, 'error'); }
      e.target.value = '';
    });

    // Typing indicator, throttled
    $('#chat-input').addEventListener('input', () => {
      if (!K.socket || !threadId) return;
      K.socket.emit('chat:typing', { threadId, typing: true });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => K.socket.emit('chat:typing', { threadId, typing: false }), 1200);
    });

    /* ---- realtime ---- */
    K.on('chat:message', ({ threadId: id, message }) => {
      if (id !== threadId) return;
      render(message);
      if (message.fromAdmin) {
        Api.chat.read().catch(() => {});
        if (document.hidden) toast('Support replied', 'info');
      }
    });
    K.on('chat:typing', ({ threadId: id, typing, fromAdmin }) => {
      if (id !== threadId || !fromAdmin) return;
      $('#chat-typing').classList.toggle('hidden', !typing);
    });
    K.on('chat:admin-online', ({ online }) => setPresence(online));
    K.on('chat:status', ({ threadId: id, status }) => {
      if (id === threadId && status === 'blocked') toast('This conversation was closed', 'info');
    });
  });
})();
