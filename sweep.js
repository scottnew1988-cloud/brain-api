// ──────────────────────────────────────────────────────────────────────
// TRANSFER SWEEP
//
// Promotion + completion logic that runs every 4 UTC days.
//
// Scheduling:
//   A Render Cron Job calls POST /api/sweep/run (with CRON_SECRET) daily.
//   The sweep itself only executes on days where utcDayNumber() % 4 === 0.
//
// Concurrency safety:
//   - A Postgres advisory lock (pg_advisory_xact_lock) ensures only one
//     instance runs at a time, even if Render scales or retries.
//   - last_sweep_utc_day in the sweep_state table is the durable guard:
//     if it equals today, the sweep is skipped (even after a restart).
//
// Data integrity:
//   - Each career completion is its own atomic transaction (see player-careers.js).
//   - Promotions are batched in a single UPDATE.
//   - Player data comes exclusively from the Brain API DB (populated via
//     HMAC-authenticated /api/players/create and /api/players/:id/progress).
// ──────────────────────────────────────────────────────────────────────

import { query, withTransaction, acquireAdvisoryLock } from "./db.js";
import { completePlayerCareer }                         from "./player-careers.js";
import { PROMOTION_THRESHOLDS, PREMIER_COMPLETION_RATING } from "./data-store.js";

// Application-level lock key — arbitrary integer, unique to this operation
const SWEEP_ADVISORY_LOCK = 20240101;

const LEAGUE_NEXT = {
  league_two:  "league_one",
  league_one:  "championship",
};

// ── UTC DAY HELPER ─────────────────────────────────────────────────────

export function utcDayNumber() {
  return Math.floor(Date.now() / 86400000);
}

// ── SWEEP STATUS ───────────────────────────────────────────────────────

/**
 * Return current sweep scheduling info (no writes).
 * @returns {Promise<Object>}
 */
export async function getSweepStatus() {
  const { rows } = await query("SELECT * FROM sweep_state WHERE id = 1");
  const state    = rows[0];
  const today    = utcDayNumber();
  const rem      = today % 4;
  const nextDay  = rem === 0 ? today + 4 : today + (4 - rem);

  return {
    last_run_day:      state?.last_sweep_utc_day ?? null,
    last_run_at:       state?.last_sweep_at      ?? null,
    run_count:         state?.run_count          ?? 0,
    current_utc_day:   today,
    is_due_today:      today % 4 === 0,
    already_ran_today: state?.last_sweep_utc_day === today,
    next_due_day:      nextDay,
    next_due_date:     new Date(nextDay * 86400000).toISOString().slice(0, 10),
  };
}

// ── MAIN SWEEP ─────────────────────────────────────────────────────────

/**
 * Execute the transfer sweep.
 *
 * @param {boolean} [force=false]
 *   Bypass the UTC-day schedule and last-ran guard.
 *   Only usable by the cron endpoint when called with the cron secret.
 *
 * @returns {Promise<Object>} Summary of all moves.
 */
export async function runTransferSweep(force = false) {
  const today = utcDayNumber();

  // ── Phase 1: acquire advisory lock, validate due-date, update state ──
  // All in one transaction so the lock is held while we check and update.
  let shouldRun = false;

  await withTransaction(async (client) => {
    // Block until we hold the exclusive advisory lock.
    // Any concurrent call waits here; by the time it proceeds,
    // last_sweep_utc_day will already be set, so it will return "already ran".
    await acquireAdvisoryLock(client, SWEEP_ADVISORY_LOCK);

    const { rows: [state] } = await client.query(
      "SELECT last_sweep_utc_day, run_count FROM sweep_state WHERE id = 1 FOR UPDATE"
    );

    const isDue         = today % 4 === 0;
    const alreadyRan    = state?.last_sweep_utc_day === today;

    if (!force && !isDue) {
      // Not a scheduled day — do nothing (shouldRun stays false)
      return;
    }
    if (!force && alreadyRan) {
      // Already executed today — do nothing
      return;
    }

    // Mark run as in-progress by writing today's day number
    await client.query(
      `UPDATE sweep_state
       SET last_sweep_utc_day = $1,
           last_sweep_at      = NOW(),
           run_count          = run_count + 1
       WHERE id = 1`,
      [today]
    );

    shouldRun = true;
  });

  if (!shouldRun) {
    const status = await getSweepStatus();
    const reason = today % 4 !== 0
      ? `Not due today (UTC day ${today}). Next sweep in ${4 - today % 4} day(s).`
      : "Sweep already ran today.";
    return { ran: false, reason, ...status };
  }

  // ── Phase 2: load active players (outside the advisory-lock tx) ──────
  const { rows: activePlayers } = await query(
    `SELECT id, user_id, display_name, overall_rating, current_league, career_started_at
     FROM players
     WHERE career_status = 'active'
     ORDER BY id`
  );

  // ── Phase 3: classify players ─────────────────────────────────────────
  const toComplete  = [];
  const toPromote   = [];
  const toSkip      = [];

  for (const p of activePlayers) {
    const threshold = PROMOTION_THRESHOLDS[p.current_league];
    if (threshold === undefined || p.overall_rating < threshold) {
      toSkip.push(p);
    } else if (p.current_league === "championship") {
      toComplete.push(p);
    } else {
      toPromote.push(p);
    }
  }

  // ── Phase 4: complete careers (one atomic transaction each) ───────────
  const completions = [];
  const errors      = [];

  for (const p of toComplete) {
    try {
      const result = await completePlayerCareer(p.id);
      if (!result.already_completed) {
        completions.push({
          player_id:       p.id,
          user_id:         p.user_id,
          days_to_premier: result.completion.days_to_premier,
          squad_update:    result.squad_update,
          message:         result.message,
        });
      }
    } catch (err) {
      console.error(`[Sweep] Career completion error for player ${p.id}:`, err.message);
      errors.push({ player_id: p.id, error: err.message });
    }
  }

  // ── Phase 5: promote (batch UPDATE — all-or-nothing per league) ────────
  const promotions = [];

  if (toPromote.length > 0) {
    // Group by target league for efficient batch updates
    const byTarget = {};
    for (const p of toPromote) {
      const next = LEAGUE_NEXT[p.current_league];
      if (!next) continue;
      if (!byTarget[next]) byTarget[next] = [];
      byTarget[next].push(p.id);
    }

    for (const [nextLeague, ids] of Object.entries(byTarget)) {
      try {
        // Build $1, $2, … placeholders from index 2 onward
        const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
        await query(
          `UPDATE players
           SET current_league = $1, updated_at = NOW()
           WHERE id IN (${placeholders}) AND career_status = 'active'`,
          [nextLeague, ...ids]
        );

        for (const p of toPromote.filter((x) => ids.includes(x.id))) {
          promotions.push({
            player_id:      p.id,
            user_id:        p.user_id,
            from:           p.current_league,
            to:             nextLeague,
            overall_rating: p.overall_rating,
          });
        }
      } catch (err) {
        console.error(`[Sweep] Batch promotion error (→${nextLeague}):`, err.message);
        errors.push({ league: nextLeague, error: err.message });
      }
    }
  }

  // ── Phase 6: re-read final sweep state for response ───────────────────
  const { rows: [finalState] } = await query(
    "SELECT run_count, last_sweep_at FROM sweep_state WHERE id = 1"
  );

  const summary = {
    ran:                  true,
    forced:               force,
    utc_day:              today,
    ran_at:               finalState.last_sweep_at,
    run_number:           finalState.run_count,
    total_active_players: activePlayers.length,
    promotions_count:     promotions.length,
    completions_count:    completions.length,
    skipped_count:        toSkip.length,
    errors_count:         errors.length,
    promotions:           promotions.slice(0, 100),
    completions,
    skipped:              toSkip.slice(0, 100).map((p) => ({
                            player_id:      p.id,
                            current_league: p.current_league,
                            overall_rating: p.overall_rating,
                            threshold:      PROMOTION_THRESHOLDS[p.current_league],
                          })),
    errors,
  };

  console.log(
    `[Sweep #${finalState.run_count}] ` +
    `Promotions: ${promotions.length} | ` +
    `Completions: ${completions.length} | ` +
    `Skipped: ${toSkip.length} | ` +
    `Errors: ${errors.length}`
  );

  return summary;
}
