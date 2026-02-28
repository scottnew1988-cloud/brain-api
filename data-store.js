// ──────────────────────────────────────────────────────────────────────
// DATA STORE
// Central in-memory store for all Online system entities.
// Replace Maps/arrays with a real DB (Postgres/SQLite) for persistence.
// ──────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";

// ── CONSTANTS ──────────────────────────────────────────────────────────

/** Minimum overall_rating in Championship to trigger career completion */
export const PREMIER_COMPLETION_RATING = 86;

/** Overall-rating thresholds to qualify for promotion during a sweep */
export const PROMOTION_THRESHOLDS = {
  league_two:   70,  // league_two → league_one
  league_one:   78,  // league_one → championship
  championship: PREMIER_COMPLETION_RATING, // championship → COMPLETED
};

/** Base point cost per facility type (cost to go level N → N+1 = base * (N+1)) */
export const FACILITY_BASE_COSTS = {
  training_equipment: 5,
  spa:                8,
  analysis_room:      6,
  medical_center:     7,
};

export const FACILITY_TYPES = Object.keys(FACILITY_BASE_COSTS);

/** Cost to upgrade a facility from currentLevel to currentLevel+1 */
export function upgradeCost(facilityType, currentLevel) {
  const base = FACILITY_BASE_COSTS[facilityType];
  if (!base) throw new Error(`Unknown facility type: ${facilityType}`);
  return base * (currentLevel + 1);
}

// ── ENTITY STORES ──────────────────────────────────────────────────────

export const store = {
  /** Map<playerId, Player> */
  players: new Map(),

  /** Map<userId, CoachStats> */
  coachStats: new Map(),

  /** CareerCompletion[] */
  careerCompletions: [],

  /** Map<groupId, LeaderboardGroup> */
  groups: new Map(),

  /** LeaderboardGroupMember[] */
  groupMembers: [],

  /**
   * Map<squadId, CoachingSquad>
   * Squad-level metadata: name, tag, points, privacy, leader_user_id
   */
  squads: new Map(),

  /** CoachingSquadMember[] — status: "active" | "inactive" */
  squadMembers: [],

  /** CoachingSquadJoinRequest[] — status: "pending" | "approved" | "rejected" */
  squadJoinRequests: [],

  /**
   * Map<squadId, Object<facilityType, SquadFacility>>
   * Initialized lazily on squad creation.
   */
  squadFacilities: new Map(),

  /** SquadSpendTransaction[] — recorded when unspent_points are spent */
  squadSpendTransactions: [],

  /** SquadPointEvent[] — recorded when a coach earns points for their squad */
  squadPointEvents: [],

  /** Sweep run metadata */
  sweep: {
    lastRunDay: null,  // UTC day number (Math.floor(Date.now()/86400000))
    lastRunAt:  null,  // ISO timestamp of last run
    runCount:   0,
  },
};

// ── UTILITIES ──────────────────────────────────────────────────────────

export function genId() {
  return randomUUID();
}

export function nowISO() {
  return new Date().toISOString();
}

/** UTC day number — days elapsed since Unix epoch */
export function utcDayNumber() {
  return Math.floor(Date.now() / 86400000);
}

/**
 * Exponential-backoff retry wrapper.
 * Use around any async operation that may transiently fail.
 */
export async function withRetry(fn, maxAttempts = 3, baseDelayMs = 200) {
  let delay = baseDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ── COACH STATS HELPERS ────────────────────────────────────────────────

/**
 * Get or lazily create a CoachStats record for a user.
 * Called both on player creation and on completion.
 */
export function getOrCreateCoachStats(userId, displayName = null) {
  if (!store.coachStats.has(userId)) {
    store.coachStats.set(userId, {
      user_id:              userId,
      display_name:         displayName ?? `Coach_${userId.slice(0, 8)}`,
      completions_count:    0,
      best_days_to_premier: null,
      avg_days_to_premier:  null,
      _total_days_sum:      0,   // private accumulator for running avg
      updated_at:           nowISO(),
    });
  }
  return store.coachStats.get(userId);
}

/**
 * Increment completions_count and update best/avg timing.
 * Called exactly once per career completion.
 */
export function updateCoachStatsOnCompletion(userId, displayName, daysToPremier) {
  const stats = getOrCreateCoachStats(userId, displayName);
  stats.completions_count += 1;
  stats._total_days_sum   += daysToPremier;
  stats.avg_days_to_premier = Math.round(stats._total_days_sum / stats.completions_count);
  if (stats.best_days_to_premier === null || daysToPremier < stats.best_days_to_premier) {
    stats.best_days_to_premier = daysToPremier;
  }
  if (displayName) stats.display_name = displayName;
  stats.updated_at = nowISO();
  return stats;
}

// ── SQUAD FACILITY HELPERS ─────────────────────────────────────────────

/** Initialise all four facility slots at level 0 for a new squad */
export function initSquadFacilities(squadId) {
  if (store.squadFacilities.has(squadId)) return;
  const facilities = {};
  for (const ft of FACILITY_TYPES) {
    facilities[ft] = {
      id:            genId(),
      squad_id:      squadId,
      facility_type: ft,
      level:         0,
      updated_at:    nowISO(),
    };
  }
  store.squadFacilities.set(squadId, facilities);
}

export function getSquadFacilities(squadId) {
  if (!store.squadFacilities.has(squadId)) initSquadFacilities(squadId);
  return store.squadFacilities.get(squadId);
}

/**
 * Compute squad level = 1 + floor(sum of all facility levels / 4).
 * A squad starts at level 1 (all facilities at 0).
 */
export function computeSquadLevel(squadId) {
  const facilities = store.squadFacilities.get(squadId);
  if (!facilities) return 1;
  const sum = Object.values(facilities).reduce((acc, f) => acc + (f.level || 0), 0);
  return 1 + Math.floor(sum / 4);
}

// ── SQUAD MEMBER HELPERS ───────────────────────────────────────────────

/** Return the active squad membership for a user, or null */
export function getUserSquadMembership(userId) {
  return store.squadMembers.find(
    (m) => m.user_id === userId && m.status === "active"
  ) ?? null;
}

export function getSquadMembers(squadId) {
  return store.squadMembers.filter(
    (m) => m.squad_id === squadId && m.status === "active"
  );
}

export function isSquadLeaderOrCoLeader(userId, squadId) {
  const m = store.squadMembers.find(
    (m) => m.squad_id === squadId && m.user_id === userId && m.status === "active"
  );
  return !!(m && (m.role === "leader" || m.role === "co_leader"));
}
