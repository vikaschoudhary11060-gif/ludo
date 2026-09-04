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

/* Fetch battles with creator/acceptor names joined in efficiently. */
export async function fetchBattles(match, limit = 100) {
  const rows = await col('battles')
    .find(match, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();

  if (!rows.length) return [];

  const uids = new Set();
  for (const b of rows) {
    if (b.creator_id != null) uids.add(b.creator_id);
    if (b.acceptor_id != null) uids.add(b.acceptor_id);
  }

  if (uids.size > 0) {
    const userDocs = await col('users').find(
      { id: { $in: Array.from(uids) } },
      { projection: { _id: 0, id: 1, name: 1 } }
    ).toArray();
    const nameMap = new Map(userDocs.map(u => [u.id, u.name]));
    for (const b of rows) {
      b.creator_name = nameMap.get(b.creator_id) || null;
      b.acceptor_name = nameMap.get(b.acceptor_id) || null;
    }
  } else {
    for (const b of rows) {
      b.creator_name = null;
      b.acceptor_name = null;
    }
  }

  return rows;
}
export async function fetchBattle(id) {
  const [b] = await fetchBattles({ id }, 1);
  return b || null;
}
