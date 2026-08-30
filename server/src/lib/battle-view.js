/* ============================================================
   Reading and shaping battles for clients.

   Lives in lib/ so both the battle routes and the settlement
   sweeper emit an identical payload — the sweeper previously
   hand-built its own and omitted creator/acceptor, which the
   client dereferences.
   ============================================================ */
import { col } from './db.js';
import { CANCEL_WINDOW_MS } from './config.js';

export const isPlayer = (b, viewerId) =>
  viewerId != null && (b.creator_id === viewerId || b.acceptor_id === viewerId);

/* `viewerId` decides whether the room code is included. It is the credential
   that lets someone into the actual Ludo match, so it goes to the two players
   and nobody else — the lobby lists running battles to everyone. */
export function shape(b, viewerId = null) {
  return {
    id: b.id, mode: b.mode, amount: b.amount, status: b.status,
    creator:  b.creator_id  ? { id: b.creator_id,  name: b.creator_name }  : null,
    acceptor: b.acceptor_id ? { id: b.acceptor_id, name: b.acceptor_name } : null,
    roomCode: isPlayer(b, viewerId) ? b.room_code : null,
    winnerId: b.winner_id, payout: b.payout,
    createdAt: b.created_at, settledAt: b.settled_at,
    roomSetAt: b.room_set_at ?? null,
    // Absolute instants, so a phone with a skewed clock still agrees with us.
    cancelDeadline: b.room_set_at ? b.room_set_at + CANCEL_WINDOW_MS : null,
    autoSettleAt: b.auto_settle_at ?? null,
    awaitingOpponent: b.status === 'disputed' && !!b.auto_settle_at,
  };
}

/* Fetch battles with creator/acceptor names joined in. */
export async function fetchBattles(match, limit = 100) {
  return col('battles').aggregate([
    { $match: match },
    { $sort: { created_at: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: 'creator_id', foreignField: 'id', as: 'c' } },
    { $lookup: { from: 'users', localField: 'acceptor_id', foreignField: 'id', as: 'a' } },
    { $addFields: { creator_name: { $arrayElemAt: ['$c.name', 0] }, acceptor_name: { $arrayElemAt: ['$a.name', 0] } } },
    { $project: { c: 0, a: 0, _id: 0 } },
  ]).toArray();
}
export async function fetchBattle(id) {
  const [b] = await fetchBattles({ id }, 1);
  return b || null;
}
