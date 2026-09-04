/* ============================================================
   Khelbro API client

   A thin, promise-based wrapper over the Node backend in /server.
   Load it BEFORE the page scripts:

     <script src="assets/js/api.js" defer></script>

   Every method returns the parsed JSON body and throws an Error
   carrying the server's message, so callers can do:

     try { await Api.battles.create('lite', 500); }
     catch (e) { toast(e.message, 'error'); }

   NOTE: the pages currently run on the local mock store in
   store.js. Point them at this client to go live — the method
   names deliberately mirror KhelbroStore.
   ============================================================ */
(function () {
  'use strict';

  const BASE = (window.KHELBRO_API || 'https://ludo-qu3q.onrender.com') + '/api';
  const TOKEN_KEY = 'khelbro.token';

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = t => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

  /* The API sleeps when idle and its host answers 502/503/504 while it wakes,
     which can take the better part of a minute. A GET is safe to repeat, so we
     ride that out silently. Anything that changes state is NOT repeated — a
     502 cannot tell us whether the server processed the request first, and a
     retried withdrawal would be a second withdrawal. */
  const WAKING = new Set([502, 503, 504]);
  const RETRY_FOR_MS = 45000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (auth && token) headers.Authorization = 'Bearer ' + token;

    const idempotent = method === 'GET';
    const deadline = Date.now() + RETRY_FOR_MS;
    let res, attempt = 0;

    for (;;) {
      try {
        res = await fetch(BASE + path, {
          method, headers, body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        // Never silently repeat a state-changing request we cannot vouch for.
        if (!idempotent || Date.now() >= deadline) {
          throw new Error('Cannot reach the server. Check your connection.');
        }
        await sleep(Math.min(1000 * 2 ** attempt++, 5000));
        continue;
      }

      if (WAKING.has(res.status)) {
        if (idempotent && Date.now() < deadline) {
          await sleep(Math.min(1000 * 2 ** attempt++, 5000));
          continue;
        }
        const err = new Error('The server is starting up. Give it a moment and try again.');
        err.status = res.status;
        err.code = 'WAKING';
        throw err;
      }
      break;
    }

    let data = null;
    try { data = await res.json(); } catch { /* empty body is fine */ }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.code;
      if (res.status === 401) setToken(null);   // token expired or revoked
      throw err;
    }
    return data;
  }

  /* ---- warming a page's own first request ----

     Every page script evaluates before K.ready resolves, and everything
     inside K.ready waits first on /api/auth/me and /api/config. On this host
     one round trip costs the better part of a second, so that put each page's
     own data a full trip behind two documents it does not depend on — the
     lobby measured 1.9s waiting for /api/config before it even asked for the
     battle list.

     warm(fn) issues the request now and hands it to the first caller that
     asks. Nothing renders earlier or in a different order: the page still
     consumes the result exactly where it always did, and the two waits simply
     overlap instead of running end to end.

     One consumer, once. The returned function gives up the warmed promise on
     its first call and issues a fresh request on every call after, so a poll,
     a socket update or a refetch after an action is never served a body that
     was fetched before it happened. A warm that is never claimed, or claimed
     too late to still be current, falls back to a normal request — so the
     worst case is exactly today's behaviour plus one unused GET. */
  const WARM_TTL_MS = 30000;

  function warm(fn) {
    let pending;
    try { pending = fn(); } catch { return fn; }      // never let warming break a page
    /* The original promise is what the caller gets, rejection and all. This
       only stops an unclaimed failure surfacing as an unhandled rejection. */
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    const at = Date.now();
    return () => {
      const claimed = pending;
      pending = null;
      return claimed && Date.now() - at < WARM_TTL_MS ? claimed : fn();
    };
  }

  const Api = {
    warm,
    get token() { return getToken(); },
    setToken,
    isLoggedIn: () => !!getToken(),

    config: () => request('/config', { auth: false }),
    health: () => request('/health', { auth: false }),
    /* Fire-and-forget: starts the host waking so the first real call does not
       have to. Never rejects — nothing should depend on it. */
    wake: () => request('/health', { auth: false }).catch(() => null),

    auth: {
      /* Which door this number should be shown: password for a returning
         player who has set one, OTP for everyone else. */
      check: phone => request('/auth/check', { method: 'POST', auth: false, body: { phone } }),
      requestOtp: phone => request('/auth/request-otp', { method: 'POST', auth: false, body: { phone } }),
      loginPassword: async (phone, password) => {
        const data = await request('/auth/login-password',
          { method: 'POST', auth: false, body: { phone, password } });
        setToken(data.token);
        return data;
      },
      /* Setting a password signs every other device out, so the server hands
         back a token on the new epoch — store it or this session dies too. */
      setPassword: async (password, currentPassword) => {
        const body = { password };
        if (currentPassword) body.currentPassword = currentPassword;
        const data = await request('/auth/set-password', { method: 'POST', body });
        if (data && data.token) setToken(data.token);
        return data;
      },
      verifyOtp: async (phone, code, referralCode) => {
        const body = { phone, code };
        if (referralCode) body.referralCode = referralCode;
        const data = await request('/auth/verify-otp', { method: 'POST', auth: false, body });
        setToken(data.token);
        return data;
      },
      me: () => request('/auth/me'),
      logout: () => setToken(null),
    },

    users: {
      update: patch => request('/users/me', { method: 'PATCH', body: patch }),
      submitKyc: payload => request('/users/kyc', { method: 'POST', body: payload }),
      notifications: () => request('/users/notifications'),
      markRead: () => request('/users/notifications/read', { method: 'POST' }),
      referrals: () => request('/users/referrals'),
      requestEmailCode: () => request('/users/email/verify-request', { method: 'POST' }),
      verifyEmail: code => request('/users/email/verify', { method: 'POST', body: { code } }),
    },

    /* Multipart upload — must not set Content-Type, the browser adds the boundary. */
    async upload(path, file, field = 'file') {
      const body = new FormData();
      body.append(field, file);
      const headers = {};
      const token = getToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      let res;
      try { res = await fetch(BASE + path, { method: 'POST', headers, body }); }
      catch { throw new Error('Cannot reach the server. Check your connection.'); }
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        const err = new Error((data && data.error) || 'Upload failed. Try again.');
        err.status = res.status;
        throw err;
      }
      return data;
    },

    uploads: {
      proof: file => Api.upload('/uploads/proof', file),
      avatar: file => Api.upload('/uploads/avatar', file),
      kyc: (slot, file) => Api.upload('/uploads/kyc/' + slot, file),
      async ekyc(file, shareCode) {
        const body = new FormData();
        body.append('file', file);
        body.append('shareCode', shareCode);
        const headers = {};
        if (getToken()) headers.Authorization = 'Bearer ' + getToken();
        const res = await fetch(BASE + '/uploads/ekyc', { method: 'POST', headers, body });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error((data && data.error) || 'Verification failed.');
        return data;
      },
    },

    wallet: {
      get: () => request('/wallet'),
      depositRequest: (amount, utr, proof, method = 'upi') =>
        request('/wallet/deposit-request', { method: 'POST', body: { amount, utr, proof, method } }),
      depositRequests: () => request('/wallet/deposit-requests'),
      depositMethod: () => request('/payments/deposit-method'),
      transactions: type => request('/wallet/transactions' + (type ? `?type=${type}` : '')),
      /* No `deposit()` here on purpose: the instant top-up endpoint was
         removed. Every deposit goes through depositRequest() and is credited
         by an admin after the UTR is checked. */
      withdraw: payload => request('/wallet/withdraw', { method: 'POST', body: payload }),
      redeemReferral: () => request('/wallet/redeem-referral', { method: 'POST' }),
    },

    battles: {
      list: (mode, status) =>
        request(`/battles?mode=${mode}${status ? `&status=${status}` : ''}`),
      mine:   params => request('/battles/mine' + (params?.active ? '?active=true' : '')),
      /* The history screen, with the wallet balance before and after each
         game. Separate from mine() because the balance reconstruction reads
         the ledger, and the lobby polls mine() every few seconds. */
      history: () => request('/battles/history'),
      get:    id => request('/battles/' + id),
      create: (mode, amount) => request('/battles', { method: 'POST', body: { mode, amount } }),
      accept: id => request(`/battles/${id}/accept`, { method: 'POST' }),
      join:   id => request(`/battles/${id}/accept`, { method: 'POST' }),
      acceptRequest: id => request(`/battles/${id}/accept-request`, { method: 'POST' }),
      rejectRequest: id => request(`/battles/${id}/reject-request`, { method: 'POST' }),
      cancelRequest: id => request(`/battles/${id}/cancel-request`, { method: 'POST' }),
      cancel: (id, reason) => request(`/battles/${id}/cancel`, { method: 'POST', body: { reason } }),
      reject: id => request(`/battles/${id}/reject`, { method: 'POST' }),
      setRoom: (id, roomCode) => request(`/battles/${id}/room`, { method: 'POST', body: { roomCode } }),
      result: (id, claim, extra = {}) =>
        request(`/battles/${id}/result`, { method: 'POST', body: { claim, ...extra } }),
    },

    push: {
      key: () => request('/push/key', { auth: false }),
      subscribe: subscription => request('/push/subscribe', { method: 'POST', body: { subscription } }),
      unsubscribe: endpoint => request('/push/unsubscribe', { method: 'POST', body: { endpoint } }),
      test: () => request('/push/test', { method: 'POST' }),
    },

    leaderboard: range => request(`/leaderboard?range=${range || 'today'}`, { auth: true }),

    referrals: {
      lookup: code => request('/referrals/lookup/' + encodeURIComponent(code), { auth: false }),
      stats: () => request('/referrals/stats'),
    },

    chat: {
      get: () => request('/chat'),
      unread: () => request('/chat/unread'),
      send: payload => request('/chat/message', { method: 'POST', body: payload }),
      read: () => request('/chat/read', { method: 'POST' }),
    },

    support: {
      send: payload => request('/support', { method: 'POST', body: payload }),
      mine: () => request('/support/mine'),
    },

    /* Realtime. Requires the socket.io client script on the page:
       <script src="/socket.io/socket.io.js"></script>  (served by the API)
       Returns null when the library is absent. */
    connectRealtime(handlers = {}) {
      if (typeof window.io !== 'function') return null;
      const socket = window.io(window.KHELBRO_API || 'https://ludo-qu3q.onrender.com', {
        auth: { token: getToken() },
        transports: ['websocket', 'polling'],
      });
      Object.entries(handlers).forEach(([event, fn]) => socket.on(event, fn));
      return socket;
    },
  };

  window.Api = Api;
})();
