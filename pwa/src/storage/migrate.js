/**
 * src/storage/migrate.js
 * One-time migration from localStorage to Dexie.
 *
 * Reads all cricket_* keys from localStorage and imports them into Dexie:
 *   - 'cricket_match_quick'          → db.matches
 *   - 'cricket_match_<tname>_<idx>'  → db.matches
 *   - 'cricket_tournaments'          → db.tournaments (array)
 *
 * After a successful migration, sets db.meta key
 * 'migrated_from_localstorage_v1' = true so this never runs again.
 *
 * Called from src/main.js immediately after initDB():
 *   await runMigration();
 */

import db from './db.js';
import { newUUID } from '../utils/uuid.js';

const MIGRATION_FLAG = 'migrated_from_localstorage_v1';

/**
 * runMigration()
 * Checks the migration flag, then imports all cricket_* localStorage
 * data into Dexie. Idempotent — safe to call on every app start.
 *
 * @returns {Promise<{ skipped: boolean, matchesImported: number, tournamentsImported: number }>}
 */
export async function runMigration() {
  // Check if migration already ran
  const flag = await db.meta.get(MIGRATION_FLAG);
  if (flag?.value === true) {
    return { skipped: true, matchesImported: 0, tournamentsImported: 0 };
  }

  let matchesImported      = 0;
  let tournamentsImported  = 0;

  // ── Migrate quick match ──────────────────────────────────────────────────
  try {
    const quickRaw = localStorage.getItem('cricket_match_quick');
    if (quickRaw) {
      const data = JSON.parse(quickRaw);
      const record = _buildMatchRecord(data, 'cricket_match_quick');
      await db.matches.put(record);
      matchesImported++;
    }
  } catch (err) {
    console.warn('[migrate] failed to import cricket_match_quick:', err);
  }

  // ── Migrate tournament-linked matches ────────────────────────────────────
  try {
    const allKeys = Object.keys(localStorage);
    for (const key of allKeys) {
      // pattern: cricket_match_<tname>_<idx>
      if (key.startsWith('cricket_match_') && key !== 'cricket_match_quick') {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const data = JSON.parse(raw);
          const record = _buildMatchRecord(data, key);
          await db.matches.put(record);
          matchesImported++;
        } catch (err) {
          console.warn(`[migrate] failed to import match key "${key}":`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[migrate] failed to scan match keys:', err);
  }

  // ── Migrate tournaments array ────────────────────────────────────────────
  try {
    const tournamentsRaw = localStorage.getItem('cricket_tournaments');
    if (tournamentsRaw) {
      const tournaments = JSON.parse(tournamentsRaw);
      if (Array.isArray(tournaments)) {
        for (const t of tournaments) {
          try {
            const record = _buildTournamentRecord(t);
            await db.tournaments.put(record);
            tournamentsImported++;
          } catch (err) {
            console.warn('[migrate] failed to import tournament:', t?.name, err);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[migrate] failed to import cricket_tournaments:', err);
  }

  // ── Mark migration complete ──────────────────────────────────────────────
  await db.meta.put({
    key:        MIGRATION_FLAG,
    value:      true,
    updated_at: new Date().toISOString(),
  });

  console.log(`[migrate] done — matches: ${matchesImported}, tournaments: ${tournamentsImported}`);
  return { skipped: false, matchesImported, tournamentsImported };
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Build a db.matches-compatible record from legacy localStorage data.
 * @param {object} data   - parsed JSON from localStorage (may have .match sub-key)
 * @param {string} key    - original localStorage key
 * @returns {object}
 */
function _buildMatchRecord(data, key) {
  // Old format: { match: {...}, currentFixtureIndex, tournamentName }
  const m = data.match ?? data;
  return {
    id:                  m.id ?? newUUID(),
    _storageKey:         key,
    tournament_id:       null,
    team1_id:            null,
    team2_id:            null,
    toss_winner_id:      null,
    toss_decision:       null,
    overs_limit:         m.oversLimit ?? 20,
    players_per_team:    m.playersPerTeam ?? 11,
    status:              'in_progress',
    result_text:         m.resultText ?? null,
    winner_id:           null,
    created_at:          new Date().toISOString(),
    updated_at:          new Date().toISOString(),
    synced_at:           null,
    // Preserve full legacy match shape for app.js compatibility during transition
    ...m,
    // Legacy meta
    tournamentName:      data.tournamentName ?? null,
    currentFixtureIndex: data.currentFixtureIndex ?? -1,
  };
}

/**
 * Build a db.tournaments-compatible record from legacy localStorage data.
 * @param {object} t  - tournament object from old cricket_tournaments array
 * @returns {object}
 */
function _buildTournamentRecord(t) {
  return {
    id:                newUUID(),
    owner_id:          null,
    name:              t.name ?? 'Unknown Tournament',
    format:            t.format ?? 'league',
    overs_per_innings: t.overs ?? 10,
    players_per_team:  t.playersPerTeam ?? 11,
    squad_size:        t.squadSize ?? 15,
    status:            'active',
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
    synced_at:         null,
    // Preserve legacy structure for transition period
    teams:             t.teams ?? [],
    fixtures:          t.fixtures ?? [],
  };
}
