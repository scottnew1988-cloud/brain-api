// ──────────────────────────────────────────────────────────────────────
// INDIVIDUAL GLOBAL LEADERBOARD
//
// All reads come from the coach_stats table — no full user scans.
// Global rank is computed with a window function so the requesting
// user always gets their exact position even when outside the top 100.
// ──────────────────────────────────────────────────────────────────────

import { query } from "./db.js";

// ── SORT ORDER ─────────────────────────────────────────────────────────
// 1. completions_count DESC
// 2. best_days_to_premier ASC NULLS LAST
// 3. avg_days_to_premier  ASC NULLS LAST

const ORDER_CLAUSE = `
  ORDER BY completions_count DESC,
           best_days_to_premier ASC NULLS LAST,
           avg_days_to_premier  ASC NULLS LAST
`;

// ── GLOBAL LEADERBOARD ─────────────────────────────────────────────────

/**
 * Return:
 *  - leaderboard: top 100 coaches with rank
 *  - my_entry:    requesting coach's row with their true global rank
 *                 (always present, even if outside top 100)
 *  - total_coaches: total number of coaches on the board
 *
 * @param {string} userId  — derived from JWT (req.userId); never trusted from client
 * @returns {Promise<Object>}
 */
export async function getGlobalLeaderboard(userId) {
  // Single query: rank all coaches, then select top 100 + the user's row
  const { rows } = await query(
    `WITH ranked AS (
       SELECT
         user_id,
         display_name,
         completions_count,
         best_days_to_premier,
         avg_days_to_premier,
         updated_at,
         ROW_NUMBER() OVER (${ORDER_CLAUSE}) AS rank,
         COUNT(*) OVER ()                    AS total_coaches
       FROM coach_stats
     )
     SELECT * FROM ranked
     WHERE rank <= 100 OR user_id = $1
     ${ORDER_CLAUSE}`,
    [userId]
  );

  if (!rows.length) {
    // No coaches on the board yet — upsert a zeroed entry for this user
    await query(
      `INSERT INTO coach_stats (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    return {
      leaderboard:   [],
      my_entry:      { rank: 1, user_id: userId, display_name: null, completions_count: 0, best_days_to_premier: null, avg_days_to_premier: null },
      total_coaches: 0,
    };
  }

  const totalCoaches = Number(rows[0].total_coaches);
  const top100       = rows.filter((r) => Number(r.rank) <= 100).map(formatRow);

  let myEntry = rows.find((r) => r.user_id === userId);
  if (!myEntry && userId) {
    // User not yet on the board — show them at rank total+1 with zeros
    await query(
      `INSERT INTO coach_stats (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    myEntry = { user_id: userId, display_name: null, completions_count: 0, best_days_to_premier: null, avg_days_to_premier: null, rank: totalCoaches + 1, updated_at: null };
  }

  return {
    leaderboard:   top100,
    my_entry:      myEntry ? formatRow(myEntry) : null,
    total_coaches: totalCoaches,
  };
}

function formatRow(r) {
  return {
    rank:                 Number(r.rank),
    user_id:              r.user_id,
    display_name:         r.display_name,
    completions_count:    Number(r.completions_count),
    best_days_to_premier: r.best_days_to_premier !== null ? Number(r.best_days_to_premier) : null,
    avg_days_to_premier:  r.avg_days_to_premier  !== null ? Number(r.avg_days_to_premier)  : null,
    updated_at:           r.updated_at,
  };
}
