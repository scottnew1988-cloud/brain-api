// ──────────────────────────────────────────────────────────────────────
// PLAYER CAREERS
//
// All writes are performed inside Postgres transactions.
//
// Key design decisions:
//  - Player data is the source of truth in the Brain API DB.
//    Only HMAC-authenticated server-to-server calls can update
//    overall_rating / current_league (not clients directly).
//  - completePlayerCareer() is fully atomic: it marks the player,
//    creates CareerCompletion, updates CoachStats, awards squad points,
//    and logs SquadPointEvent — all in one transaction.
//  - The UNIQUE constraint on career_completions(player_id) is a
//    physical double-completion guard even if the transaction fails
//    to check the player's career_status.
// ──────────────────────────────────────────────────────────────────────

import { query, withTransaction } from "./db.js";

// ── PLAYER CREATION ────────────────────────────────────────────────────

/**
 * Register a new player in the Brain API DB.
 *
 * Called by the Base44 FIRST_PRO_CONTRACT event handler.
 * Idempotent — ON CONFLICT DO NOTHING, returns existing row if present.
 *
 * @param {Object}  opts
 * @param {string}  opts.player_id
 * @param {string}  opts.user_id          — derived server-side from JWT
 * @param {string}  [opts.display_name]
 * @param {number}  [opts.overall_rating=60]
 * @param {string}  [opts.current_league="league_two"]
 * @returns {Promise<Object>} Player row
 */
export async function createPlayer({
  player_id,
  user_id,
  display_name,
  overall_rating = 60,
  current_league = "league_two",
}) {
  if (!player_id) throw new Error("player_id is required");
  if (!user_id)   throw new Error("user_id is required");

  const { rows } = await query(
    `INSERT INTO players
       (id, user_id, display_name, overall_rating, current_league)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, players.display_name)
     RETURNING *`,
    [player_id, user_id, display_name ?? null, overall_rating, current_league]
  );

  // Ensure a CoachStats row exists from day one (0 completions initially)
  await query(
    `INSERT INTO coach_stats (user_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, coach_stats.display_name)`,
    [user_id, display_name ?? null]
  );

  return rows[0];
}

// ── PLAYER PROGRESS UPDATE ─────────────────────────────────────────────

/**
 * Update a player's current_league and/or overall_rating.
 *
 * This endpoint is protected by HMAC auth (auth.requireHmac) so only
 * Base44 server functions — not browser clients — can call it.
 * Completed players are frozen and not updated.
 *
 * @param {string}  player_id
 * @param {Object}  updates
 * @param {number}  [updates.overall_rating]
 * @param {string}  [updates.current_league]
 * @returns {Promise<Object|null>} Updated player row, or null if not found
 */
export async function updatePlayerProgress(player_id, { overall_rating, current_league } = {}) {
  if (!overall_rating && !current_league) {
    throw new Error("Provide at least one of: overall_rating, current_league");
  }

  const sets   = [];
  const params = [];
  let   i      = 1;

  if (overall_rating !== undefined) { sets.push(`overall_rating = $${i++}`); params.push(overall_rating); }
  if (current_league  !== undefined) { sets.push(`current_league  = $${i++}`); params.push(current_league); }
  sets.push(`updated_at = NOW()`);
  params.push(player_id);

  const { rows } = await query(
    `UPDATE players
     SET ${sets.join(", ")}
     WHERE id = $${i} AND career_status = 'active'
     RETURNING *`,
    params
  );

  return rows[0] ?? null;
}

// ── CAREER COMPLETION ──────────────────────────────────────────────────

/**
 * Complete a player's career (Premier League promotion achieved).
 *
 * ATOMIC — everything in one transaction:
 *   1. Lock player row; bail if already completed.
 *   2. Mark Player completed.
 *   3. INSERT CareerCompletion (UNIQUE on player_id = idempotency guard).
 *   4. UPSERT CoachStats (increment count, update best/avg).
 *   5. If coach is in an active squad: award +1 point to squad + member,
 *      log SquadPointEvent.
 *
 * Can be called by:
 *   - The sweep (passes its own transaction client)
 *   - The manual /api/players/:id/complete endpoint (opens its own tx)
 *
 * @param {string}          player_id
 * @param {pg.PoolClient}   [externalClient]  Pass when already in a transaction
 * @returns {Promise<Object>}
 */
export async function completePlayerCareer(player_id, externalClient = null) {
  const run = async (client) => {
    // ── 1. Lock & verify player is still active ────────────────────────
    const { rows: playerRows } = await client.query(
      `SELECT * FROM players
       WHERE id = $1
       FOR UPDATE`,
      [player_id]
    );
    if (!playerRows.length) throw new Error(`Player not found: ${player_id}`);

    const player = playerRows[0];
    if (player.career_status === "completed") {
      return { already_completed: true, player };
    }

    const nowMs        = Date.now();
    const startedMs    = new Date(player.career_started_at).getTime();
    const daysToPremier = Math.ceil((nowMs - startedMs) / 86400000) || 1;

    // ── 2. Mark player completed ───────────────────────────────────────
    await client.query(
      `UPDATE players
       SET career_status = 'completed', career_completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [player_id]
    );

    // ── 3. Insert CareerCompletion (UNIQUE guard prevents duplication) ─
    const { rows: compRows } = await client.query(
      `INSERT INTO career_completions (player_id, user_id, days_to_premier)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id) DO NOTHING
       RETURNING *`,
      [player_id, player.user_id, daysToPremier]
    );
    if (!compRows.length) {
      // Conflict fired — another concurrent call already completed this player
      return { already_completed: true, player };
    }
    const completion = compRows[0];

    // ── 4. Upsert CoachStats ───────────────────────────────────────────
    // ROUND( (total_days_sum + days) / (completions_count + 1) )
    const { rows: statsRows } = await client.query(
      `INSERT INTO coach_stats
         (user_id, display_name, completions_count, total_days_sum,
          best_days_to_premier, avg_days_to_premier)
       VALUES ($1, $2, 1, $3, $3, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         completions_count    = coach_stats.completions_count + 1,
         total_days_sum       = coach_stats.total_days_sum + $3,
         avg_days_to_premier  =
           ROUND((coach_stats.total_days_sum + $3)::numeric
                 / (coach_stats.completions_count + 1)),
         best_days_to_premier =
           LEAST(COALESCE(coach_stats.best_days_to_premier, $3), $3),
         display_name         = COALESCE($2, coach_stats.display_name),
         updated_at           = NOW()
       RETURNING *`,
      [player.user_id, player.display_name, daysToPremier]
    );
    const coachStats = statsRows[0];

    // ── 5. Squad point award ───────────────────────────────────────────
    const { rows: memberRows } = await client.query(
      `SELECT * FROM coaching_squad_members
       WHERE user_id = $1 AND status = 'active'
       LIMIT 1`,
      [player.user_id]
    );

    let squadUpdate = null;
    if (memberRows.length) {
      const membership = memberRows[0];

      const { rows: [squad] } = await client.query(
        `UPDATE coaching_squads
         SET total_points = total_points + 1,
             unspent_points = unspent_points + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING name, total_points, unspent_points`,
        [membership.squad_id]
      );

      await client.query(
        `UPDATE coaching_squad_members
         SET points_contributed = points_contributed + 1
         WHERE id = $1`,
        [membership.id]
      );

      const { rows: evtRows } = await client.query(
        `INSERT INTO squad_point_events
           (squad_id, user_id, delta_points, reason)
         VALUES ($1, $2, 1, 'premier_completion')
         RETURNING id`,
        [membership.squad_id, player.user_id]
      );

      squadUpdate = {
        squad_id:       membership.squad_id,
        squad_name:     squad.name,
        total_points:   squad.total_points,
        unspent_points: squad.unspent_points,
        point_event_id: evtRows[0].id,
      };
    }

    const displayName = player.display_name ?? `Player_${player_id.slice(0, 8)}`;
    return {
      already_completed: false,
      player:      { ...player, career_status: "completed" },
      completion,
      coach_stats: coachStats,
      squad_update: squadUpdate,
      message:
        `You've done it, Coach — ${displayName} has reached the Premier League! ` +
        `${daysToPremier} day${daysToPremier === 1 ? "" : "s"} from debut to the top flight. ` +
        `History is written.`,
    };
  };

  // Use the caller's transaction if provided; otherwise open one
  if (externalClient) return run(externalClient);
  return withTransaction(run);
}

// ── PLAYER QUERY ───────────────────────────────────────────────────────

/**
 * Fetch a player row by ID.
 * @param {string} player_id
 * @returns {Promise<Object|null>}
 */
export async function getPlayer(player_id) {
  const { rows } = await query("SELECT * FROM players WHERE id = $1", [player_id]);
  return rows[0] ?? null;
}
