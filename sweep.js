// ──────────────────────────────────────────────────────────────────────
// TRANSFER SWEEP
//
// The sweep runs every 4 days (UTC dayNumber % 4 === 0).
// It checks all active players and either:
//   - Promotes them one league tier (if rating meets threshold)
//   - Completes their career (if in championship with rating >= 86)
//
// The cron entrypoint at the bottom calls runTransferSweep() every 6 h
// and lets the due-date logic decide whether to actually execute.
// ──────────────────────────────────────────────────────────────────────

import {
  store,
  nowISO,
  utcDayNumber,
  withRetry,
  PROMOTION_THRESHOLDS,
} from "./data-store.js";

import { getActivePlayers, completePlayerCareer } from "./player-careers.js";

// ── PROMOTION HELPERS ──────────────────────────────────────────────────

const LEAGUE_ORDER = ["league_two", "league_one", "championship"];

function nextLeague(current) {
  const idx = LEAGUE_ORDER.indexOf(current);
  return idx >= 0 && idx < LEAGUE_ORDER.length - 1 ? LEAGUE_ORDER[idx + 1] : null;
}

function meetsThreshold(player) {
  const threshold = PROMOTION_THRESHOLDS[player.current_league];
  return threshold !== undefined && player.overall_rating >= threshold;
}

// ── MAIN SWEEP ─────────────────────────────────────────────────────────

/**
 * Run the transfer sweep.
 *
 * @param {boolean} [force=false]
 *   When true, bypass the due-date check and always execute.
 *   Use POST /api/sweep/run { force: true } for testing.
 *
 * @returns {Object} Summary of promotions, completions, and skips.
 */
export async function runTransferSweep(force = false) {
  const today  = utcDayNumber();
  const isDue  = today % 4 === 0;

  // Skip unless it's a scheduled day (or forced)
  if (!force && !isDue) {
    const daysUntilNext = 4 - (today % 4);
    return {
      ran:           false,
      reason:        `Not due today (UTC day ${today}). Next sweep in ${daysUntilNext} day(s).`,
      last_run_day:  store.sweep.lastRunDay,
      last_run_at:   store.sweep.lastRunAt,
      next_due_info: getSweepStatus(),
    };
  }

  // Prevent double-run on same day (unless forced)
  if (!force && store.sweep.lastRunDay === today) {
    return {
      ran:          false,
      reason:       "Sweep already ran today.",
      last_run_day: store.sweep.lastRunDay,
      last_run_at:  store.sweep.lastRunAt,
    };
  }

  const now         = nowISO();
  const promotions  = [];
  const completions = [];
  const skipped     = [];
  const errors      = [];

  const activePlayers = getActivePlayers();

  for (const player of activePlayers) {
    if (!meetsThreshold(player)) {
      skipped.push({
        player_id:      player.id,
        user_id:        player.user_id,
        current_league: player.current_league,
        overall_rating: player.overall_rating,
        threshold:      PROMOTION_THRESHOLDS[player.current_league],
      });
      continue;
    }

    if (player.current_league === "championship") {
      // ── CAREER COMPLETION ──────────────────────────────────────────
      try {
        const result = await withRetry(() =>
          completePlayerCareer(player.id, {
            user_id:      player.user_id,
            display_name: player.display_name,
          })
        );

        if (!result.already_completed) {
          completions.push({
            player_id:       player.id,
            user_id:         player.user_id,
            days_to_premier: result.completion.days_to_premier,
            squad_update:    result.squad_update,
            message:         result.message,
          });
        }
      } catch (err) {
        console.error(`[Sweep] Career completion failed for ${player.id}:`, err.message);
        errors.push({ player_id: player.id, error: err.message });
      }
    } else {
      // ── NORMAL PROMOTION ───────────────────────────────────────────
      const fromLeague = player.current_league;
      const toLeague   = nextLeague(fromLeague);

      if (toLeague) {
        player.current_league = toLeague;
        player.updated_at     = now;
        promotions.push({
          player_id:      player.id,
          user_id:        player.user_id,
          from:           fromLeague,
          to:             toLeague,
          overall_rating: player.overall_rating,
        });
      }
    }
  }

  // Update sweep state
  store.sweep.lastRunDay = today;
  store.sweep.lastRunAt  = now;
  store.sweep.runCount  += 1;

  const summary = {
    ran:                   true,
    forced:                force,
    utc_day:               today,
    ran_at:                now,
    run_number:            store.sweep.runCount,
    total_active_players:  activePlayers.length,
    promotions_count:      promotions.length,
    completions_count:     completions.length,
    skipped_count:         skipped.length,
    errors_count:          errors.length,
    promotions:            promotions.slice(0, 100),  // cap response payload
    completions,
    skipped:               skipped.slice(0, 100),
    errors,
  };

  console.log(
    `[Sweep #${store.sweep.runCount}] ` +
    `Promotions: ${promotions.length} | ` +
    `Completions: ${completions.length} | ` +
    `Skipped: ${skipped.length} | ` +
    `Errors: ${errors.length}`
  );

  return summary;
}

// ── STATUS CHECK ───────────────────────────────────────────────────────

/**
 * Return sweep scheduling info without running it.
 */
export function getSweepStatus() {
  const today       = utcDayNumber();
  const remainder   = today % 4;
  const nextDueDay  = remainder === 0 ? today : today + (4 - remainder);
  const nextDueDate = new Date(nextDueDay * 86400000).toISOString().slice(0, 10);

  return {
    last_run_day:     store.sweep.lastRunDay,
    last_run_at:      store.sweep.lastRunAt,
    run_count:        store.sweep.runCount,
    current_utc_day:  today,
    is_due_today:     today % 4 === 0,
    already_ran_today: store.sweep.lastRunDay === today,
    next_due_day:     nextDueDay,
    next_due_date:    nextDueDate,
  };
}

// ── CRON SCHEDULER ─────────────────────────────────────────────────────

/**
 * Starts a background interval that fires every 6 hours.
 * The due-date check inside runTransferSweep() means execution only
 * happens on UTC days where dayNumber % 4 === 0.
 *
 * Call once at server startup (in server.js).
 */
export function startSweepCron() {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  // Run once at startup (in case the server restarted on a due day)
  runTransferSweep(false).then((result) => {
    if (result.ran) {
      console.log(`[SweepCron] Startup sweep ran: ${result.promotions_count} promotions, ${result.completions_count} completions`);
    } else {
      console.log(`[SweepCron] Startup check: ${result.reason}`);
    }
  }).catch((err) => console.error("[SweepCron] Startup sweep error:", err));

  setInterval(async () => {
    try {
      const result = await runTransferSweep(false);
      if (result.ran) {
        console.log(
          `[SweepCron] Sweep #${result.run_number}: ` +
          `${result.promotions_count} promotions, ${result.completions_count} completions`
        );
      }
    } catch (err) {
      console.error("[SweepCron] Error:", err.message);
    }
  }, SIX_HOURS_MS);

  console.log("[SweepCron] Scheduled — checks every 6 hours, runs on UTC days divisible by 4");
}
