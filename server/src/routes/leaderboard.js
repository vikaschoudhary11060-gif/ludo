/* Leaderboard — ranked by battles won in the selected window (MongoDB). */
import express from 'express';
import { SafeRouter } from '../lib/safe-router.js';
import { col } from '../lib/db.js';
import { optionalAuth } from '../lib/auth.js';

const router = SafeRouter();
const WINDOWS = { today: 864e5, week: 7 * 864e5, all: null };

router.get('/', optionalAuth, async (req, res) => {
  const range = WINDOWS[req.query.range] !== undefined ? req.query.range : 'today';
  const since = WINDOWS[range] ? Date.now() - WINDOWS[range] : 0;

  const rows = await col('battles').aggregate([
    { $match: { status: 'completed', settled_at: { $gte: since }, winner_id: { $ne: null } } },
    { $group: { _id: '$winner_id', wins: { $sum: 1 }, earned: { $sum: { $ifNull: ['$payout', 0] } } } },
    { $sort: { wins: -1, earned: -1 } },
    { $limit: 100 },
    { $lookup: { from: 'users', localField: '_id', foreignField: 'id', as: 'u' } },
    { $project: { _id: 0, id: '$_id', name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, '—'] }, wins: 1, earned: 1 } },
  ]).toArray();

  const leaders = rows.map((r, i) => ({ rank: i + 1, ...r }));
  const me = req.user ? leaders.find(l => l.id === req.user.id) || null : null;
  res.json({ range, leaders, me });
});

export default router;
