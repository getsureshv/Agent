-- Cricket Scorer v3 PR 3 — schema extensions.
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout.
--
-- v3_players: extra roster fields used by the captain UI.
-- v3_invites: revoked_at, used to supersede stale captain invites.

ALTER TABLE v3_players
  ADD COLUMN IF NOT EXISTS batting_order    INT,
  ADD COLUMN IF NOT EXISTS is_wicket_keeper BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_captain       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notes            TEXT;

ALTER TABLE v3_invites
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_v3_invites_team_role
  ON v3_invites(team_id, role)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
