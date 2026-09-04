/* ============================================================
   Admin — referral money transfers.

   Every rupee the referral programme pays out is one row in
   `referral_earnings`: which referrer was paid, for which
   player's game, from which battle, at what rate, and whether
   the rate was halved because both players in that battle had
   referrers.

   The wallet ledger alone cannot answer this. Its referral
   credit names the referrer and the battle but never the
   player whose match earned it, so the console would have to
   guess the referee from `users.referred_by` — a field that
   can be edited afterwards, at which point the history would
   silently rewrite itself.
   ============================================================ */
import { SafeRouter } from '../lib/safe-router.js';
import { col, getSettings } from '../lib/db.js';
import { referralRateFor } from '../lib/settlement.js';

const router = SafeRouter();

const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: null };
const since = req => { const s = RANGES[req.query.range]; return s ? Date.now() - s : 0; };

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** A page size the caller asked for, clamped to something a browser can render. */
const pageSize = raw => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : DEFAULT_LIMIT;
};

const escapeRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name/phone/id lookup for a batch of user ids, as a Map. */
async function usersById(ids) {
  const unique = [...new Set(ids.filter(id => id != null))];
  if (!unique.length) return new Map();
  const rows = await col('users').find({ id: { $in: unique } },
    { projection: { _id: 0, id: 1, name: 1, phone: 1, referral_code: 1, banned: 1 } }).toArray();
  return new Map(rows.map(u => [u.id, u]));
}

const shapeUser = (id, map) => {
  const u = map.get(id);
  return {
    id,
    name: u?.name || (id != null ? 'Player' + String(id).slice(-4) : '—'),
    phone: u?.phone || '',
    code: u?.referral_code || null,
    banned: !!u?.banned,
  };
};

/* GET /api/admin/referrals?range=&q=&type=all|split|full&limit=

   `type` filters on how the transfer was rated:
     split — both players in the battle were referred, so each referrer took
             half the configured rate
     full  — only one player was referred, so their referrer took the whole rate */
router.get('/referrals', async (req, res) => {
  const from = since(req);
  const type = ['split', 'full'].includes(req.query.type) ? req.query.type : 'all';
  const limit = pageSize(req.query.limit);
  const q = String(req.query.q || '').trim();

  const match = {};
  if (from) match.created_at = { $gte: from };
  if (type === 'split') match.split = true;
  if (type === 'full') match.split = { $ne: true };

  /* A search names a person or a battle, so resolve it to ids first and then
     filter on either end of the transfer. Matching the stored row directly is
     not an option — it holds ids, not names. */
  if (q) {
    const rx = new RegExp(escapeRx(q), 'i');
    const or = [{ name: rx }, { phone: rx }, { referral_code: rx }];
    if (Number.isInteger(Number(q))) or.push({ id: Number(q) });
    const hits = await col('users').find({ $or: or }, { projection: { _id: 0, id: 1 } }).limit(500).toArray();
    const ids = hits.map(u => u.id);
    match.$or = [{ referrer_id: { $in: ids } }, { referee_id: { $in: ids } }, { battle_id: q }];
  }

  const rows = await col('referral_earnings').find(match, { projection: { _id: 0 } })
    .sort({ created_at: -1 }).limit(limit).toArray();

  /* Totals cover every transfer the filter selects, not just the page shown —
     an operator reading "₹4,120 paid this week" under a 200-row table must be
     reading the week, not the first two hundred rows of it. Grouping on
     `split` gives both halves of the breakdown in one pass. */
  const buckets = await col('referral_earnings').aggregate([
    { $match: match },
    { $group: {
      _id: '$split',
      amount: { $sum: '$amount' },
      stake: { $sum: '$stake' },
      transfers: { $sum: 1 },
      referrers: { $addToSet: '$referrer_id' },
      referees: { $addToSet: '$referee_id' },
    } },
  ]).toArray();

  const totals = { transfers: 0, amount: 0, stake: 0, splitTransfers: 0, splitAmount: 0 };
  const referrerSet = new Set(), refereeSet = new Set();
  for (const b of buckets) {
    totals.transfers += b.transfers;
    totals.amount += b.amount;
    totals.stake += b.stake;
    if (b._id === true) { totals.splitTransfers += b.transfers; totals.splitAmount += b.amount; }
    for (const id of b.referrers) referrerSet.add(id);
    for (const id of b.referees) refereeSet.add(id);
  }
  totals.referrers = referrerSet.size;
  totals.referees = refereeSet.size;

  /* Who earned the most, over the same window. Built from the grouped rows
     rather than the page, so the leaderboard does not change meaning when an
     operator narrows the table. */
  const perReferrer = await col('referral_earnings').aggregate([
    { $match: match },
    { $group: {
      _id: '$referrer_id',
      amount: { $sum: '$amount' },
      transfers: { $sum: 1 },
      referees: { $addToSet: '$referee_id' },
    } },
  ]).toArray();
  perReferrer.sort((a, b) => b.amount - a.amount);
  const top = perReferrer.slice(0, 10);

  const names = await usersById([
    ...rows.flatMap(r => [r.referrer_id, r.referee_id]),
    ...top.map(t => t._id),
  ]);

  const settings = await getSettings();
  const baseRate = settings.referral_rate || 0;

  res.json({
    range: req.query.range || 'all',
    type,
    limit,
    truncated: rows.length === limit,
    rate: baseRate,
    ratePercent: +(baseRate * 100).toFixed(3),
    splitRatePercent: +(referralRateFor(baseRate, 2) * 100).toFixed(3),
    totals,
    topReferrers: top.map(t => ({
      ...shapeUser(t._id, names),
      amount: t.amount,
      transfers: t.transfers,
      referees: t.referees.length,
    })),
    transfers: rows.map(r => ({
      id: r.id,
      amount: r.amount,
      stake: r.stake,
      rate: r.rate,
      ratePercent: +((r.rate || 0) * 100).toFixed(3),
      split: !!r.split,
      source: r.source || 'battle',
      mode: r.mode || null,
      battleId: r.battle_id,
      createdAt: r.created_at,
      referrer: shapeUser(r.referrer_id, names),
      referee: shapeUser(r.referee_id, names),
    })),
  });
});

export default router;
