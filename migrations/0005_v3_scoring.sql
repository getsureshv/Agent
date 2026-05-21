-- Cricket Scorer v3 PR 4 — scoring engine schema.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
--
-- Extends v3_matches with status + lineup metadata, and v3_match_events with
-- structured ball-by-ball columns. The legacy `payload` JSONB on
-- v3_match_events is retained for backward compatibility but new code reads
-- and writes the typed columns instead.
--
-- v3_match_events.seq stays as the canonical monotonic ordering column
-- (UNIQUE per match from migration 0002). The API surfaces it as
-- `sequence_num`; the column name is unchanged on disk.

-- ── v3_matches: scoring state ──────────────────────────────────────
ALTER TABLE v3_matches
  ADD COLUMN IF NOT EXISTS status                  TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS overs_per_innings       INT,
  ADD COLUMN IF NOT EXISTS players_per_side        INT,
  ADD COLUMN IF NOT EXISTS current_innings_num     INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS current_batting_team_id UUID REFERENCES v3_teams(id),
  ADD COLUMN IF NOT EXISTS current_bowling_team_id UUID REFERENCES v3_teams(id),
  ADD COLUMN IF NOT EXISTS started_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS result_summary          TEXT,
  ADD COLUMN IF NOT EXISTS winner_team_id          UUID REFERENCES v3_teams(id);

-- ── v3_match_events: typed ball-by-ball columns ────────────────────
ALTER TABLE v3_match_events
  ADD COLUMN IF NOT EXISTS innings_num               INT,
  ADD COLUMN IF NOT EXISTS over_num                  INT,
  ADD COLUMN IF NOT EXISTS ball_num                  INT,
  ADD COLUMN IF NOT EXISTS legal_ball                BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS runs_off_bat              INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extras_runs               INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extras_type               TEXT,
  ADD COLUMN IF NOT EXISTS is_wicket                 BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wicket_type               TEXT,
  ADD COLUMN IF NOT EXISTS out_batter_player_id      UUID REFERENCES v3_players(id),
  ADD COLUMN IF NOT EXISTS batter_on_strike_player_id     UUID REFERENCES v3_players(id),
  ADD COLUMN IF NOT EXISTS batter_non_strike_player_id    UUID REFERENCES v3_players(id),
  ADD COLUMN IF NOT EXISTS bowler_player_id          UUID REFERENCES v3_players(id),
  ADD COLUMN IF NOT EXISTS new_batter_player_id      UUID REFERENCES v3_players(id),
  ADD COLUMN IF NOT EXISTS notes                     TEXT,
  ADD COLUMN IF NOT EXISTS event_kind                TEXT NOT NULL DEFAULT 'ball';
-- event_kind = 'ball' | 'innings_end' | 'match_end' | 'setup' (informational)

-- The legacy schema put NOT NULL on payload. New writes still set a small
-- payload blob for forward-compat, but make sure rows already in the DB stay
-- valid: nothing else to do.

CREATE INDEX IF NOT EXISTS idx_v3_match_events_match_seq
  ON v3_match_events(match_id, seq);

-- ── Lineups (who's playing) — one row per team per match ──────────
CREATE TABLE IF NOT EXISTS v3_match_lineups (
  match_id     UUID NOT NULL REFERENCES v3_matches(id) ON DELETE CASCADE,
  team_id      UUID NOT NULL REFERENCES v3_teams(id) ON DELETE CASCADE,
  player_id    UUID NOT NULL REFERENCES v3_players(id) ON DELETE CASCADE,
  batting_pos  INT,
  PRIMARY KEY (match_id, team_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_v3_match_lineups_match ON v3_match_lineups(match_id);

-- ── Per-match write lock ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_match_locks (
  match_id        UUID PRIMARY KEY REFERENCES v3_matches(id) ON DELETE CASCADE,
  holder_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v3_match_locks_expires ON v3_match_locks(expires_at);
