/* Socket.IO — live lobby and per-battle rooms.

   Events out:
     battle:created  a new open battle appeared in the lobby
     battle:removed  an open battle is gone (accepted or cancelled)
     battle:updated  a battle this socket watches changed
     presence        how many sockets are watching a battle

   Events in:
     battle:watch  { id }   join that battle's room
     battle:leave  { id }
*/
import { verify } from './lib/auth.js';
import { verifyAdminToken } from './lib/admin-auth.js';
import { col } from './lib/db.js';

/* An admin socket must prove it holds a real admin token, not merely claim
   to. The verification is admin-auth's own, so socket and HTTP admin auth can
   never drift apart — and it inherits that module's refusal of a published
   secret rather than re-deriving one here. */
async function adminFromToken(token) {
  if (!token) return null;
  const payload = verifyAdminToken(token);
  if (!payload) return null;
  const admin = await col('admin_users').findOne({ id: payload.aid }, { projection: { id: 1, active: 1 } });
  return admin && admin.active ? admin : null;
}

export function attachRealtime(io, app) {
  // How many agent sockets are connected — surfaced to players as "we're online".
  let adminSockets = 0;
  const setAdminOnline = () => {
    app?.set('adminOnline', adminSockets > 0);
    io.emit('chat:admin-online', { online: adminSockets > 0 });
  };
  // Optional auth: the lobby is public, but we tag the socket when a token is sent.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token && verify(token);
    if (payload) {
      const user = await col('users').findOne({ id: payload.uid }, { projection: { id: 1, name: 1 } });
      if (user) socket.data.user = user;
    }
    next();
  });

  io.on('connection', socket => {
    socket.join('lobby');

    socket.on('battle:watch', async ({ id } = {}) => {
      if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) return;
      /* battle:updated carries the room code, which is what gets you into the
         actual Ludo match — so the room is for its two players only. */
      const uid = socket.data.user?.id;
      if (uid == null) return;
      const b = await col('battles').findOne({ id },
        { projection: { _id: 0, creator_id: 1, acceptor_id: 1 } });
      if (!b || (b.creator_id !== uid && b.acceptor_id !== uid)) return;

      socket.join(`battle:${id}`);
      const size = io.sockets.adapter.rooms.get(`battle:${id}`)?.size ?? 0;
      io.to(`battle:${id}`).emit('presence', { id, watchers: size });
    });

    socket.on('battle:leave', ({ id } = {}) => {
      if (typeof id !== 'string') return;
      socket.leave(`battle:${id}`);
    });

    /* ---- live chat ---- */

    // Agents identify themselves so players can see an online indicator.
    socket.on('chat:admin-join', async () => {
      if (socket.data.isAdmin) return;                       // already counted
      // Without this check any visitor could join the `admins` room and read
      // every player's support conversation.
      const admin = await adminFromToken(socket.handshake.auth?.adminToken);
      if (!admin) return;
      socket.data.isAdmin = true;
      socket.join('admins');
      adminSockets++;
      setAdminOnline();
    });

    socket.on('chat:join', async ({ threadId } = {}) => {
      if (!Number.isInteger(threadId)) return;
      // A player may only join their own thread; agents may join any.
      if (!socket.data.isAdmin) {
        const own = await col('chat_threads').findOne({ user_id: socket.data.user?.id }, { projection: { id: 1 } });
        if (!own || own.id !== threadId) return;
      }
      socket.join(`chat:${threadId}`);
      socket.emit('chat:admin-online', { online: adminSockets > 0 });
    });

    socket.on('chat:leave', ({ threadId } = {}) => {
      if (Number.isInteger(threadId)) socket.leave(`chat:${threadId}`);
    });

    // Typing is ephemeral — broadcast to the room, never stored.
    socket.on('chat:typing', ({ threadId, typing } = {}) => {
      if (!Number.isInteger(threadId)) return;
      socket.to(`chat:${threadId}`).emit('chat:typing', {
        threadId, typing: !!typing, fromAdmin: !!socket.data.isAdmin,
      });
      if (socket.data.isAdmin) socket.to('admins').emit('chat:typing', { threadId, typing: !!typing, fromAdmin: true });
    });

    socket.on('disconnect', () => {
      if (socket.data.isAdmin) { adminSockets = Math.max(0, adminSockets - 1); setAdminOnline(); }
    });
  });
}
