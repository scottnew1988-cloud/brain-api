-- ══════════════════════════════════════════════════════════════════════
-- BRAIN API — ONLINE SYSTEM SCHEMA
-- Run once against your Postgres database (Supabase or Render Postgres).
-- All tables use UUID primary keys and timestamptz timestamps.
-- ══════════════════════════════════════════════════════════════════════

-- Enable UUID generation (Postgres 13+ has gen_random_uuid() built-in)
-- If on Postgres ≤ 12, use: CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── SWEEP STATE (singleton) ────────────────────────────────────────────
-- Persistent record of the last sweep execution.
-- The DB-level advisory lock + last_sweep_utc_day guard prevents
-- duplicate runs even if the cron fires twice.

CREATE TABLE IF NOT EXISTS sweep_state (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  last_sweep_utc_day  INTEGER,           -- UTC day number (epoch days) of last run
  last_sweep_at       TIMESTAMPTZ,
  run_count           INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT sweep_state_single_row CHECK (id = 1)
);

-- Ensure the singleton row exists
INSERT INTO sweep_state (id, run_count) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- ── PLAYERS ────────────────────────────────────────────────────────────
-- Synced from Base44 via HMAC-authenticated server-to-server calls.
-- Clients CANNOT update this table directly.

CREATE TABLE IF NOT EXISTS players (
  id                  TEXT        PRIMARY KEY,          -- Base44 entity ID
  user_id             TEXT        NOT NULL,             -- Owning coach (Base44 user)
  display_name        TEXT,
  overall_rating      INTEGER     NOT NULL DEFAULT 60,
  current_league      TEXT        NOT NULL DEFAULT 'league_two'
                      CHECK (current_league IN ('league_two', 'league_one', 'championship')),
  career_status       TEXT        NOT NULL DEFAULT 'active'
                      CHECK (career_status IN ('active', 'completed')),
  career_started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  career_completed_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS players_user_id_idx       ON players(user_id);
CREATE INDEX IF NOT EXISTS players_career_status_idx ON players(career_status);

-- ── COACH STATS ────────────────────────────────────────────────────────
-- One row per coach; updated atomically on each career completion.
-- total_days_sum is the private accumulator used to compute avg.

CREATE TABLE IF NOT EXISTS coach_stats (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT        NOT NULL,
  display_name         TEXT,
  completions_count    INTEGER     NOT NULL DEFAULT 0,
  best_days_to_premier INTEGER,
  avg_days_to_premier  INTEGER,
  total_days_sum       INTEGER     NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT coach_stats_user_id_uq UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS coach_stats_leaderboard_idx
  ON coach_stats(completions_count DESC, best_days_to_premier ASC NULLS LAST, avg_days_to_premier ASC NULLS LAST);

-- ── CAREER COMPLETIONS ─────────────────────────────────────────────────
-- The UNIQUE constraint on player_id is the idempotency guard:
-- double-completing the same player is physically impossible.

CREATE TABLE IF NOT EXISTS career_completions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id        TEXT        NOT NULL,
  user_id          TEXT        NOT NULL,
  days_to_premier  INTEGER     NOT NULL CHECK (days_to_premier > 0),
  completed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT career_completions_player_id_uq UNIQUE (player_id)
);

CREATE INDEX IF NOT EXISTS career_completions_user_id_idx ON career_completions(user_id);

-- ── LEADERBOARD GROUPS ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leaderboard_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  invite_code TEXT        NOT NULL,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT leaderboard_groups_invite_code_uq UNIQUE (invite_code)
);

-- ── LEADERBOARD GROUP MEMBERS ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leaderboard_group_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID        NOT NULL REFERENCES leaderboard_groups(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL,
  role       TEXT        NOT NULL DEFAULT 'member'
             CHECK (role IN ('admin', 'member')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT leaderboard_group_members_uq UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS lgm_user_id_idx ON leaderboard_group_members(user_id);

-- ── COACHING SQUADS ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coaching_squads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  tag             TEXT,                                     -- 2–5 uppercase alphanumeric; NULL if none
  description     TEXT        NOT NULL DEFAULT '',
  leader_user_id  TEXT        NOT NULL,
  privacy         TEXT        NOT NULL DEFAULT 'open'
                  CHECK (privacy IN ('open', 'request', 'closed')),
  total_points    INTEGER     NOT NULL DEFAULT 0,
  unspent_points  INTEGER     NOT NULL DEFAULT 0,
  level           INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT coaching_squads_tag_uq UNIQUE (tag),
  CONSTRAINT coaching_squads_points_check CHECK (unspent_points >= 0 AND total_points >= 0)
);

CREATE INDEX IF NOT EXISTS coaching_squads_leaderboard_idx
  ON coaching_squads(total_points DESC, level DESC, updated_at ASC);

-- ── COACHING SQUAD MEMBERS ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coaching_squad_members (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id            UUID        NOT NULL REFERENCES coaching_squads(id) ON DELETE CASCADE,
  user_id             TEXT        NOT NULL,
  role                TEXT        NOT NULL DEFAULT 'member'
                      CHECK (role IN ('leader', 'co_leader', 'member')),
  points_contributed  INTEGER     NOT NULL DEFAULT 0,
  status              TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive')),
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT coaching_squad_members_uq UNIQUE (squad_id, user_id)
);

CREATE INDEX IF NOT EXISTS csm_user_id_status_idx ON coaching_squad_members(user_id, status);
CREATE INDEX IF NOT EXISTS csm_squad_id_status_idx ON coaching_squad_members(squad_id, status);

-- ── COACHING SQUAD JOIN REQUESTS ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS coaching_squad_join_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id     UUID        NOT NULL REFERENCES coaching_squads(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);

CREATE INDEX IF NOT EXISTS csjr_squad_status_idx ON coaching_squad_join_requests(squad_id, status);
CREATE INDEX IF NOT EXISTS csjr_squad_user_idx   ON coaching_squad_join_requests(squad_id, user_id);

-- ── SQUAD FACILITIES ───────────────────────────────────────────────────
-- One row per (squad, facility_type). Initialised at level 0 on squad creation.

CREATE TABLE IF NOT EXISTS squad_facilities (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id       UUID        NOT NULL REFERENCES coaching_squads(id) ON DELETE CASCADE,
  facility_type  TEXT        NOT NULL
                 CHECK (facility_type IN ('training_equipment', 'spa', 'analysis_room', 'medical_center')),
  level          INTEGER     NOT NULL DEFAULT 0 CHECK (level >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT squad_facilities_uq UNIQUE (squad_id, facility_type)
);

CREATE INDEX IF NOT EXISTS sf_squad_id_idx ON squad_facilities(squad_id);

-- ── SQUAD SPEND TRANSACTIONS ───────────────────────────────────────────
-- Audit log: every time unspent_points are spent on a facility upgrade.

CREATE TABLE IF NOT EXISTS squad_spend_transactions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id       UUID        NOT NULL REFERENCES coaching_squads(id) ON DELETE CASCADE,
  user_id        TEXT        NOT NULL,
  points_spent   INTEGER     NOT NULL CHECK (points_spent > 0),
  facility_type  TEXT        NOT NULL,
  from_level     INTEGER     NOT NULL,
  to_level       INTEGER     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sst_squad_id_idx ON squad_spend_transactions(squad_id);

-- ── SQUAD POINT EVENTS ─────────────────────────────────────────────────
-- Audit log: every time a coach earns points for their squad.

CREATE TABLE IF NOT EXISTS squad_point_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id      UUID        NOT NULL REFERENCES coaching_squads(id) ON DELETE CASCADE,
  user_id       TEXT        NOT NULL,
  delta_points  INTEGER     NOT NULL,
  reason        TEXT        NOT NULL DEFAULT 'premier_completion',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS spe_squad_id_idx ON squad_point_events(squad_id);
CREATE INDEX IF NOT EXISTS spe_user_id_idx  ON squad_point_events(user_id);

-- ══════════════════════════════════════════════════════════════════════
-- END OF SCHEMA
-- ══════════════════════════════════════════════════════════════════════
