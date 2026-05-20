/**
 * src/storage/db.js
 * Dexie database init + schema for CricketScorer.
 * Schema version: 1
 *
 * Tables exactly as per ARCHITECTURE.md §2a.
 * Primary keys are UUIDv4 strings (client-generated via crypto.randomUUID).
 * Vendored dexie.mjs (ESM build) used for offline-first PWA.
 */

// Import from vendored ESM copy — preferred for offline-first PWA.
// CDN fallback: https://cdn.jsdelivr.net/npm/dexie@4.0.8/+esm
import Dexie from '/pwa/vendor/dexie/dexie.mjs';

export const db = new Dexie('CricketScorer');

/**
 * Schema version: "1"
 * Composite unique index on match_events[match_id+seq] ensures
 * per-match monotone sequence and prevents duplicate delivery inserts.
 */
db.version(1).stores({
  // ── Master data (replicated from server) ──────────────────────────
  users:
    '&id, email, display_name, created_at',

  tournaments:
    '&id, owner_id, name, format, overs_per_innings, players_per_team, squad_size, status, created_at, updated_at, synced_at',

  teams:
    '&id, tournament_id, name, created_at, updated_at',

  players:
    '&id, team_id, tournament_id, name, jersey_number, created_at, updated_at',

  // ── Live match data ────────────────────────────────────────────────
  matches:
    '&id, tournament_id, team1_id, team2_id, toss_winner_id, toss_decision, overs_limit, players_per_team, status, result_text, winner_id, created_at, updated_at, synced_at',

  // Ball-by-ball: one row per delivery.
  // &id = primary key (UUID). [match_id+seq] = unique composite. seq = monotone per match.
  match_events:
    '&id, [match_id+seq], match_id, innings_number, over_number, ball_in_over, event_type, runs, extra_type, extra_runs, dismissal_type, batsman_id, bowler_id, fielder_id, created_at, seq',

  // ── Sync infrastructure ────────────────────────────────────────────
  // ++local_id = auto-increment integer PK (outbox-only, never sent to server)
  outbox:
    '++local_id, entity_type, entity_id, operation, payload, seq, status, created_at, last_attempt_at, attempt_count',

  // ── App metadata (flags, migration state, etc.) ───────────────────
  meta:
    '&key, value, updated_at',
});

/** Schema version string — bump when db.version() changes. */
export const SCHEMA_VERSION = '1';

/**
 * initDB()
 * Opens the Dexie database. Must be awaited once before any repo calls.
 * Called from src/main.js before startSyncEngine() and initUI().
 *
 * @returns {Promise<Dexie>}
 */
export async function initDB() {
  if (!db.isOpen()) {
    await db.open();
  }
  return db;
}

export default db;
