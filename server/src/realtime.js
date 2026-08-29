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
import { db } from './lib/db.js';

export function attachRealtime(io, app) {
  // How many agent sockets are connected — surfaced to players as "we're online".
  let adminSockets = 0;
  const setAdminOnline = () => {
    app?.set('adminOnline', adminSockets > 0);
    io.emit('chat:admin-online', { online: adminSockets > 0 });
  };
  // Optional auth: the lobby is public, but we tag the socket when a token is sent.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = token && verify(token);
    if (payload) {
      const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(payload.uid);
      if (user) socket.data.user = user;
    }
    next();
  });

  io.on('connection', socket => {
    socket.join('lobby');

    socket.on('battle:watch', ({ id } = {}) => {
      if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) return;
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
    socket.on('chat:admin-join', () => {
      socket.data.isAdmin = true;
      socket.join('admins');
      adminSockets++;
      setAdminOnline();
    });

    socket.on('chat:join', ({ threadId } = {}) => {
      if (!Number.isInteger(threadId)) return;
      // A player may only join their own thread; agents may join any.
      if (!socket.data.isAdmin) {
        const own = db.prepare('SELECT id FROM chat_threads WHERE user_id = ?').get(socket.data.user?.id);
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
