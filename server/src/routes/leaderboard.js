/* Leaderboard — ranked by battles won in the selected window. */
import express from 'express';
import { db } from '../lib/db.js';
import { optionalAuth } from '../lib/auth.js';

const router = express.Router();
const WINDOWS = { today: 864e5, week: 7 * 864e5, all: null };

router.get('/', optionalAuth, (req, res) => {
  const range = WINDOWS[req.query.range] !== undefined ? req.query.range : 'today';
  const since = WINDOWS[range] ? Date.now() - WINDOWS[range] : 0;

  const rows = db.prepare(`
    SELECT u.id, u.name, COUNT(b.id) AS wins, COALESCE(SUM(b.payout),0) AS earned
    FROM battles b JOIN users u ON u.id = b.winner_id
    WHERE b.status = 'completed' AND b.settled_at >= ?
    GROUP BY u.id ORDER BY wins DESC, earned DESC LIMIT 100`).all(since);

  const leaders = rows.map((r, i) => ({ rank: i + 1, ...r }));
  const me = req.user ? leaders.find(l => l.id === req.user.id) || null : null;
  res.json({ range, leaders, me });
});

export default router;
