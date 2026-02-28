// ──────────────────────────────────────────────────────────────────────
// PLAYER CAREERS
// Handles player registration, progress tracking, and Premier League
// career completion — including squad point awards.
// ──────────────────────────────────────────────────────────────────────

import {
  store,
  genId,
  nowISO,
  getOrCreateCoachStats,
  updateCoachStatsOnCompletion,
  getUserSquadMembership,
  withRetry,
} from "./data-store.js";

// ── PLAYER CREATION ────────────────────────────────────────────────────

/**
 * Register a new player in the Brain API store.
 *
 * Called when Base44 fires the FIRST_PRO_CONTRACT event.
 * Idempotent — safe to call multiple times for the same player_id.
 *
 * @param {Object} opts
 * @param {string} opts.player_id   - Unique player identifier (from Base44)
 * @param {string} opts.user_id     - Owning coach's user identifier
 * @param {string} [opts.display_name] - Coach display name for leaderboards
 * @param {number} [opts.overall_rating=60]
 * @param {string} [opts.current_league="league_two"]
 * @returns {Object} Player record
 */
export function createPlayer({
  player_id,
  user_id,
  display_name,
  overall_rating = 60,
  current_league = "league_two",
}) {
  if (!player_id || !user_id) {
    throw new Error("player_id and user_id are required");
  }

  // Idempotency — return existing record unchanged
  if (store.players.has(player_id)) {
    return store.players.get(player_id);
  }

  const now = nowISO();
  const player = {
    id:                  player_id,
    user_id,
    display_name:        display_name ?? `Player_${player_id.slice(0, 8)}`,
    overall_rating,
    current_league,
    career_status:       "active",
    career_started_at:   now,
    career_completed_at: null,
    created_at:          now,
    updated_at:          now,
  };

  store.players.set(player_id, player);

  // Ensure the coach has a CoachStats row from day one
  getOrCreateCoachStats(user_id, display_name);

  return player;
}

/**
 * Update a player's rating and/or league assignment.
 *
 * Called from Base44 after training sessions or match events so the sweep
 * always works with up-to-date data.
 *
 * @param {string} player_id
 * @param {Object} updates
 * @param {number} [updates.overall_rating]
 * @param {string} [updates.current_league]
 * @returns {Object|null} Updated player record, or null if not found
 */
export function updatePlayerProgress(player_id, { overall_rating, current_league } = {}) {
  const player = store.players.get(player_id);
  if (!player) return null;

  // Completed players are frozen — no further progress updates
  if (player.career_status === "completed") return player;

  if (overall_rating !== undefined) player.overall_rating = overall_rating;
  if (current_league  !== undefined) player.current_league  = current_league;
  player.updated_at = nowISO();

  return player;
}

/**
 * Return all active (non-completed) players.
 * Used by the sweep to find promotion/completion candidates.
 */
export function getActivePlayers() {
  return [...store.players.values()].filter(
    (p) => p.career_status === "active"
  );
}

// ── CAREER COMPLETION ──────────────────────────────────────────────────

/**
 * Complete a player's career (Premier League promotion achieved).
 *
 * Idempotent — if already completed, returns { already_completed: true }.
 *
 * Side-effects (atomic within this call):
 *  1. Player.career_status = "completed", career_completed_at = now
 *  2. CareerCompletion record created
 *  3. CoachStats updated (completions_count, best_days, avg_days)
 *  4. If coach is in a squad → squad total/unspent +1, member contribution +1,
 *     SquadPointEvent logged
 *
 * @param {string} player_id
 * @param {Object} [opts]
 * @param {string} [opts.user_id]      - Overrides player.user_id if provided
 * @param {string} [opts.display_name] - Coach display name for leaderboard
 * @returns {Object} Completion result
 */
export async function completePlayerCareer(player_id, { user_id, display_name } = {}) {
  return withRetry(async () => {
    const player = store.players.get(player_id);
    if (!player) throw new Error(`Player not found: ${player_id}`);

    // Idempotency guard — only fire once per player
    if (player.career_status === "completed") {
      return { already_completed: true, player };
    }

    const now    = nowISO();
    const nowMs  = Date.now();
    const startMs = new Date(player.career_started_at).getTime();
    const daysToPremier = Math.ceil((nowMs - startMs) / 86400000);

    // 1. Mark player completed
    player.career_status       = "completed";
    player.career_completed_at = now;
    player.updated_at          = now;

    const effectiveUserId = user_id ?? player.user_id;
    const effectiveName   = display_name ?? player.display_name;

    // 2. CareerCompletion record
    const completion = {
      id:             genId(),
      player_id,
      user_id:        effectiveUserId,
      days_to_premier: daysToPremier,
      completed_at:   now,
    };
    store.careerCompletions.push(completion);

    // 3. Update CoachStats
    const stats = updateCoachStatsOnCompletion(effectiveUserId, effectiveName, daysToPremier);

    // 4. Squad points (only if coach is an active squad member)
    let squadUpdate = null;
    const membership = getUserSquadMembership(effectiveUserId);
    if (membership) {
      const squad = store.squads.get(membership.squad_id);
      if (squad) {
        squad.total_points    += 1;
        squad.unspent_points  += 1;
        squad.updated_at       = now;
        membership.points_contributed += 1;

        const pointEvent = {
          id:          genId(),
          squad_id:    squad.id,
          user_id:     effectiveUserId,
          delta_points: 1,
          reason:      "premier_completion",
          created_at:  now,
        };
        store.squadPointEvents.push(pointEvent);

        squadUpdate = {
          squad_id:       squad.id,
          squad_name:     squad.name,
          total_points:   squad.total_points,
          unspent_points: squad.unspent_points,
          point_event_id: pointEvent.id,
        };
      }
    }

    const message =
      `You've done it, Coach — ${player.display_name} has reached the Premier League! ` +
      `${daysToPremier} day${daysToPremier === 1 ? "" : "s"} from debut to the top flight. ` +
      `History is written.`;

    return {
      already_completed: false,
      player,
      completion,
      coach_stats: stats,
      squad_update: squadUpdate,
      message,
    };
  });
}
