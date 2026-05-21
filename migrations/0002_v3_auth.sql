-- Cricket Scorer v3 — Auth + multi-user tournament foundation.
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.
-- Runs alongside legacy 0001_init.sql; v3_* tables coexist with the v1 tournaments/teams/matches.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,
  google_sub      TEXT UNIQUE,
  name            TEXT,
  picture_url     TEXT,
  is_global_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));

-- ── Sessions (DB-backed; opaque id stored in HttpOnly cookie) ───────
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── Tournaments (v3) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_tournaments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  slug              TEXT UNIQUE NOT NULL,
  format            TEXT NOT NULL DEFAULT 'league',
  overs_per_innings INT  NOT NULL DEFAULT 20,
  players_per_team  INT  NOT NULL DEFAULT 11,
  squad_size        INT  NOT NULL DEFAULT 15,
  is_public         BOOLEAN NOT NULL DEFAULT TRUE,
  status            TEXT NOT NULL DEFAULT 'draft',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_tournaments_owner ON v3_tournaments(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_v3_tournaments_slug  ON v3_tournaments(slug);

-- ── Teams (v3) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   UUID NOT NULL REFERENCES v3_tournaments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  captain_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  short_name      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tournament_id, name)
);
CREATE INDEX IF NOT EXISTS idx_v3_teams_tournament ON v3_teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_v3_teams_captain    ON v3_teams(captain_user_id);

-- ── Players (v3) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES v3_teams(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  jersey_number INT,
  role          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_players_team ON v3_players(team_id);

-- ── Fixtures (scheduled matches) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_fixtures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  UUID NOT NULL REFERENCES v3_tournaments(id) ON DELETE CASCADE,
  team_a_id      UUID NOT NULL REFERENCES v3_teams(id),
  team_b_id      UUID NOT NULL REFERENCES v3_teams(id),
  scheduled_at   TIMESTAMPTZ,
  venue          TEXT,
  scorer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled',
  match_id       UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_fixtures_tournament ON v3_fixtures(tournament_id);
CREATE INDEX IF NOT EXISTS idx_v3_fixtures_scorer     ON v3_fixtures(scorer_user_id);

-- ── Matches (v3) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_matches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id          UUID NOT NULL UNIQUE REFERENCES v3_fixtures(id) ON DELETE CASCADE,
  toss_winner_team_id UUID REFERENCES v3_teams(id),
  toss_decision       TEXT,
  state               JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Match events (append-only) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_match_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   UUID NOT NULL REFERENCES v3_matches(id) ON DELETE CASCADE,
  seq        INT  NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id),
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_v3_match_events_match ON v3_match_events(match_id);

-- ── Invites ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v3_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token         TEXT UNIQUE NOT NULL,
  tournament_id UUID NOT NULL REFERENCES v3_tournaments(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,
  team_id       UUID REFERENCES v3_teams(id) ON DELETE CASCADE,
  invited_by    UUID NOT NULL REFERENCES users(id),
  consumed_at   TIMESTAMPTZ,
  consumed_by   UUID REFERENCES users(id),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_v3_invites_token ON v3_invites(token);
CREATE INDEX IF NOT EXISTS idx_v3_invites_email ON v3_invites(lower(email));
