// ──────────────────────────────────────────────────────────────────────
// INDIVIDUAL GLOBAL LEADERBOARD
// Ranks coaches by:
//   1) completions_count DESC
//   2) best_days_to_premier ASC (nulls last)
//   3) avg_days_to_premier ASC (nulls last)
//
// The requesting user always appears in my_entry regardless of rank.
// ──────────────────────────────────────────────────────────────────────

import { store, getOrCreateCoachStats } from "./data-store.js";

// ── SORT COMPARATOR ────────────────────────────────────────────────────

export function compareCoaches(a, b) {
  // 1. Most completions first
  if (b.completions_count !== a.completions_count) {
    return b.completions_count - a.completions_count;
  }

  // 2. Fastest best run first (nulls go to the bottom)
  const aBest = a.best_days_to_premier;
  const bBest = b.best_days_to_premier;
  if (aBest === null && bBest === null) { /* fall through */ }
  else if (aBest === null) return 1;
  else if (bBest === null) return -1;
  else if (aBest !== bBest) return aBest - bBest;

  // 3. Lowest average days first (nulls go to the bottom)
  const aAvg = a.avg_days_to_premier;
  const bAvg = b.avg_days_to_premier;
  if (aAvg === null && bAvg === null) return 0;
  if (aAvg === null) return 1;
  if (bAvg === null) return -1;
  return aAvg - bAvg;
}

function formatCoach(stats, rank) {
  return {
    rank,
    user_id:              stats.user_id,
    display_name:         stats.display_name,
    completions_count:    stats.completions_count,
    best_days_to_premier: stats.best_days_to_premier,
    avg_days_to_premier:  stats.avg_days_to_premier,
    updated_at:           stats.updated_at,
  };
}

// ── GLOBAL LEADERBOARD ─────────────────────────────────────────────────

/**
 * Returns the top-100 coaches plus the requesting user's entry.
 *
 * my_entry is guaranteed to be present even when the user is:
 *   - Outside the top 100 (their true rank is shown)
 *   - Not yet on the board (rank = total + 1, all zeros)
 *
 * @param {string} userId - Requesting coach's user_id
 * @returns {{ leaderboard: Object[], my_entry: Object, total_coaches: number }}
 */
export function getGlobalLeaderboard(userId) {
  const sorted  = [...store.coachStats.values()].sort(compareCoaches);
  const top100  = sorted.slice(0, 100).map((s, i) => formatCoach(s, i + 1));

  let myEntry = null;
  if (userId) {
    const myIdx = sorted.findIndex((s) => s.user_id === userId);
    if (myIdx !== -1) {
      myEntry = formatCoach(sorted[myIdx], myIdx + 1);
    } else {
      // User has no stats yet — create a zeroed placeholder
      const stats = getOrCreateCoachStats(userId);
      myEntry = formatCoach(stats, sorted.length + 1);
    }
  }

  return {
    leaderboard:    top100,
    my_entry:       myEntry,
    total_coaches:  sorted.length,
  };
}
