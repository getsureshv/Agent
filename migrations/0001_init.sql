-- Cricket Scorer — initial schema
-- Idempotent: all statements use CREATE ... IF NOT EXISTS / CREATE OR REPLACE.

-- ── Extensions ──────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Device tokens (auth) ────────────────────────────────────────────
-- No user accounts for v1. Each device self-registers and gets a UUID token.
CREATE TABLE IF NOT EXISTS device_tokens (
  token       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tournaments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
  id                UUID        PRIMARY KEY,
  owner_token       UUID        NOT NULL REFERENCES device_tokens(token),
  name              TEXT        NOT NULL,
  format            TEXT        NOT NULL CHECK (format IN ('league','knockout')),
  overs_per_innings INT         NOT NULL DEFAULT 10,
  players_per_team  INT         NOT NULL DEFAULT 11,
  squad_size        INT         NOT NULL DEFAULT 15,
  status            TEXT        NOT NULL DEFAULT 'setup'
                                CHECK (status IN ('setup','active','completed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tournaments_owner_token_idx ON tournaments(owner_token);
CREATE INDEX IF NOT EXISTS tournaments_updated_at_idx  ON tournaments(updated_at);

-- ── Teams ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id            UUID        PRIMARY KEY,
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS teams_tournament_id_idx ON teams(tournament_id);

-- ── Players ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id            UUID        PRIMARY KEY,
  team_id       UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  jersey_number INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS players_team_id_idx        ON players(team_id);
CREATE INDEX IF NOT EXISTS players_tournament_id_idx  ON players(tournament_id);

-- ── Matches ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id               UUID        PRIMARY KEY,
  tournament_id    UUID        REFERENCES tournaments(id) ON DELETE CASCADE,
  team1_id         UUID        REFERENCES teams(id),
  team2_id         UUID        REFERENCES teams(id),
  toss_winner_id   UUID        REFERENCES teams(id),
  toss_decision    TEXT        CHECK (toss_decision IN ('bat','bowl')),
  overs_limit      INT         NOT NULL DEFAULT 20,
  players_per_team INT         NOT NULL DEFAULT 11,
  status           TEXT        NOT NULL DEFAULT 'setup'
                               CHECK (status IN ('setup','in_progress','completed')),
  result_text      TEXT,
  winner_id        UUID        REFERENCES teams(id),
  owner_token      UUID        NOT NULL REFERENCES device_tokens(token),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS matches_owner_token_idx      ON matches(owner_token);
CREATE INDEX IF NOT EXISTS matches_tournament_id_idx    ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS matches_updated_at_idx       ON matches(updated_at);

-- ── Match Events (ball-by-ball) ──────────────────────────────────────
-- UNIQUE(match_id, seq) makes POST /api/matches/:id/events idempotent.
CREATE TABLE IF NOT EXISTS match_events (
  id             UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id       UUID     NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_number SMALLINT NOT NULL CHECK (innings_number IN (0,1)),
  over_number    SMALLINT NOT NULL,
  ball_in_over   SMALLINT NOT NULL,
  event_type     TEXT     NOT NULL CHECK (event_type IN (
                   'runs','wide','noball','bye','legbye',
                   'wicket','innings_end','match_end'
                 )),
  runs           SMALLINT NOT NULL DEFAULT 0,
  extra_type     TEXT,
  extra_runs     SMALLINT DEFAULT 0,
  dismissal_type TEXT,
  batsman_id     UUID     REFERENCES players(id),
  bowler_id      UUID     REFERENCES players(id),
  fielder_id     UUID     REFERENCES players(id),
  seq            INT      NOT NULL,
  payload        JSONB,
  ts             TIMESTAMPTZ,
  type           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT match_events_match_id_seq_unique UNIQUE (match_id, seq)
);

CREATE INDEX IF NOT EXISTS match_events_match_id_seq_idx ON match_events(match_id, seq);

-- ── updated_at trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Tournaments trigger
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'tournaments_set_updated_at'
  ) THEN
    CREATE TRIGGER tournaments_set_updated_at
      BEFORE UPDATE ON tournaments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Teams trigger
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'teams_set_updated_at'
  ) THEN
    CREATE TRIGGER teams_set_updated_at
      BEFORE UPDATE ON teams
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Players trigger
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'players_set_updated_at'
  ) THEN
    CREATE TRIGGER players_set_updated_at
      BEFORE UPDATE ON players
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Matches trigger
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'matches_set_updated_at'
  ) THEN
    CREATE TRIGGER matches_set_updated_at
      BEFORE UPDATE ON matches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
