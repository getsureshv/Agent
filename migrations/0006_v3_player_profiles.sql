-- Cricket Scorer v3 PR 5 — player profile schema.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
-- CREATE SEQUENCE IF NOT EXISTS.
--
-- All foreign-key types are UUID to match the existing schema (users.id,
-- v3_players.id, v3_invites.id are all UUID). The spec called for int FKs
-- but that would conflict with everything else.

-- ── Player-code sequence + generator ──────────────────────────────
CREATE SEQUENCE IF NOT EXISTS v3_player_code_seq START 1;

CREATE OR REPLACE FUNCTION gen_player_code() RETURNS text AS $$
  SELECT 'CSP' || LPAD(nextval('v3_player_code_seq')::text, 5, '0');
$$ LANGUAGE sql;

-- ── v3_players: profile columns ───────────────────────────────────
ALTER TABLE v3_players
  ADD COLUMN IF NOT EXISTS first_name              TEXT,
  ADD COLUMN IF NOT EXISTS middle_name             TEXT,
  ADD COLUMN IF NOT EXISTS last_name               TEXT,
  ADD COLUMN IF NOT EXISTS display_name            TEXT,
  ADD COLUMN IF NOT EXISTS player_code             TEXT,
  ADD COLUMN IF NOT EXISTS category                TEXT,
  ADD COLUMN IF NOT EXISTS nationality             TEXT,
  ADD COLUMN IF NOT EXISTS date_of_birth           DATE,
  ADD COLUMN IF NOT EXISTS is_student              BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS address_line1           TEXT,
  ADD COLUMN IF NOT EXISTS address_line2           TEXT,
  ADD COLUMN IF NOT EXISTS city                    TEXT,
  ADD COLUMN IF NOT EXISTS state_region            TEXT,
  ADD COLUMN IF NOT EXISTS country                 TEXT,
  ADD COLUMN IF NOT EXISTS postal_code             TEXT,
  ADD COLUMN IF NOT EXISTS registered_email        TEXT,
  ADD COLUMN IF NOT EXISTS phone_number            TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_number         TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_name  TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_number TEXT,
  ADD COLUMN IF NOT EXISTS batting_style           TEXT,
  ADD COLUMN IF NOT EXISTS bowling_style           TEXT,
  ADD COLUMN IF NOT EXISTS bowling_type            TEXT,
  ADD COLUMN IF NOT EXISTS is_certified_umpire     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS profile_status          TEXT NOT NULL DEFAULT 'placeholder',
  ADD COLUMN IF NOT EXISTS is_verified             BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by_user_id     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS user_id                 UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS created_by_user_id      UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS profile_updated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS profile_invite_id       UUID REFERENCES v3_invites(id);

-- Backfill: every existing player gets a code. Idempotent — only assigns
-- where NULL, so re-running the migration is a no-op.
UPDATE v3_players
   SET player_code = gen_player_code()
 WHERE player_code IS NULL;

-- After backfill we can enforce uniqueness (idempotent — no-op if the
-- constraint already exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'v3_players_player_code_key'
  ) THEN
    ALTER TABLE v3_players
      ADD CONSTRAINT v3_players_player_code_key UNIQUE (player_code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_v3_players_user_id
  ON v3_players(user_id);

-- ── v3_invites: support role='player' ─────────────────────────────
ALTER TABLE v3_invites
  ADD COLUMN IF NOT EXISTS player_id UUID REFERENCES v3_players(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_v3_invites_player_role
  ON v3_invites(player_id, role)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
