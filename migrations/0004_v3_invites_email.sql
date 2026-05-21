-- Cricket Scorer v3 PR 3.5 — invite email send timestamp.
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE v3_invites
  ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ;
