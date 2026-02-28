// ──────────────────────────────────────────────────────────────────────
// CONSTANTS
// Shared game-logic constants used by multiple modules.
// All state has moved to Postgres — this file no longer exports a store.
// ──────────────────────────────────────────────────────────────────────

/** Minimum overall_rating in Championship to trigger career completion */
export const PREMIER_COMPLETION_RATING = 86;

/** Promotion rating thresholds for the transfer sweep */
export const PROMOTION_THRESHOLDS = {
  league_two:   70,  // league_two  → league_one
  league_one:   78,  // league_one  → championship
  championship: PREMIER_COMPLETION_RATING, // → COMPLETED
};

/** Base point cost per facility type */
export const FACILITY_BASE_COSTS = {
  training_equipment: 5,
  spa:                8,
  analysis_room:      6,
  medical_center:     7,
};

export const FACILITY_TYPES = Object.keys(FACILITY_BASE_COSTS);

/** Cost to upgrade a facility from currentLevel → currentLevel+1 */
export function upgradeCost(facilityType, currentLevel) {
  const base = FACILITY_BASE_COSTS[facilityType];
  if (!base) throw new Error(`Unknown facility type: ${facilityType}`);
  return base * (currentLevel + 1);
}
