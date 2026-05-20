/**
 * src/storage/matchRepo.js
 * All match CRUD operations using Dexie.
 * Replaces: saveMatchState(), loadMatchState(), clearMatchState(),
 *           matchStorageKey() from app.js.
 *
 * Every write is atomic: the primary-table write and outbox append
 * happen in the SAME Dexie transaction.
 *
 * Exports per INTERFACES.md §Dev 2:
 *   saveMatch, loadMatch, appendMatchEvent, getMatchEvents, deleteMatch
 */

import db from './db.js';
import { newUUID } from '../utils/uuid.js';
import { appendToOutbox as appendToOutboxStub } from '../sync/_stub.js';

// Dev 4 will supply src/sync/outbox.js with the same signature.
// We try to import it; if absent we fall back to the stub silently.
let _appendToOutbox = appendToOutboxStub;

/**
 * Allow Dev 4 (or tests) to swap in the real outbox implementation at runtime.
 * Call this once from main.js after initDB() if the real module is present.
 * @param {(entry: object) => Promise<void>} fn
 */
export function setOutboxImpl(fn) {
  _appendToOutbox = fn;
}

// Attempt to load real outbox lazily on first write (non-blocking)
let _outboxLoaded = false;
async function loadOutbox() {
  if (_outboxLoaded) return;
  _outboxLoaded = true;
  try {
    const mod = await import('../sync/outbox.js');
    if (typeof mod.appendToOutbox === 'function') {
      _appendToOutbox = mod.appendToOutbox;
    }
  } catch {
    // Not yet available; stub remains active.
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build legacy storage key for a match.
 * For tournament matches: "cricket_match_<tournamentName>_<fixtureIndex>"
 * For quick matches: "cricket_match_quick"
 * @param {object} match
 * @returns {string}
 */
function matchKey(match) {
  if (match.tournamentName && match.currentFixtureIndex >= 0) {
    return `cricket_match_${match.tournamentName}_${match.currentFixtureIndex}`;
  }
  return 'cricket_match_quick';
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * saveMatch(match)
 * Upsert the full match state document into db.matches + append outbox row,
 * both in a single atomic Dexie transaction.
 *
 * Initialises match.id (UUIDv4) if not already set.
 *
 * @param {import('./types.d.ts').MatchState} match
 * @returns {Promise<void>}
 */
export async function saveMatch(match) {
  await loadOutbox();
  if (!match.id) match.id = newUUID();
  match.updated_at = new Date().toISOString();
  if (!match.created_at) match.created_at = match.updated_at;
  if (!match.status) match.status = 'in_progress';
  match._storageKey = matchKey(match);

  await db.transaction('rw', db.matches, db.outbox, async () => {
    await db.matches.put(match);
    await _appendToOutbox({
      entity_type: 'match',
      entity_id:   match.id,
      operation:   'upsert',
      payload:     match,
      seq:         Date.now(),
    });
  });
}

/**
 * loadMatch(key)
 * Load a match by its legacy storage key or by UUID. Returns null if not found.
 *
 * @param {string} key  - "cricket_match_quick", "cricket_match_<tname>_<idx>", or UUID
 * @returns {Promise<import('./types.d.ts').MatchState | null>}
 */
export async function loadMatch(key) {
  // Try UUID first (fast)
  if (key && key.length === 36) {
    const record = await db.matches.get(key);
    if (record) return record;
  }
  // Fall back to _storageKey scan
  const record = await db.matches
    .filter(m => m._storageKey === key)
    .first();
  return record ?? null;
}

/**
 * appendMatchEvent(event)
 * Append a single ball-by-ball delivery event to db.match_events.
 * Assigns event.id (UUID) if absent and increments the match's local_seq.
 * All writes + outbox append are in a single Dexie transaction.
 *
 * @param {import('./types.d.ts').BallEvent} event
 * @returns {Promise<void>}
 */
export async function appendMatchEvent(event) {
  await loadOutbox();
  if (!event.id) event.id = newUUID();
  if (!event.created_at) event.created_at = new Date().toISOString();

  await db.transaction('rw', db.matches, db.match_events, db.outbox, async () => {
    // Increment per-match seq atomically
    const matchRecord = await db.matches.get(event.match_id);
    const seq = (matchRecord?.local_seq ?? 0) + 1;
    event.seq = seq;

    if (matchRecord) {
      matchRecord.local_seq = seq;
      matchRecord.updated_at = new Date().toISOString();
      await db.matches.put(matchRecord);
    }

    await db.match_events.put(event);
    await _appendToOutbox({
      entity_type: 'match_event',
      entity_id:   event.id,
      operation:   'upsert',
      payload:     event,
      seq,
    });
  });
}

/**
 * getMatchEvents(matchId, afterSeq?)
 * Return all events for a match, optionally filtered to seq > afterSeq,
 * ordered by seq ascending.
 *
 * @param {string} matchId
 * @param {number} [afterSeq=0]
 * @returns {Promise<import('./types.d.ts').BallEvent[]>}
 */
export async function getMatchEvents(matchId, afterSeq = 0) {
  return db.match_events
    .where('match_id')
    .equals(matchId)
    .filter(e => (e.seq ?? 0) > afterSeq)
    .sortBy('seq');
}

/**
 * deleteMatch(key)
 * Delete a match (by legacy key or UUID) and all its match_events.
 * Appends a delete outbox row.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteMatch(key) {
  await loadOutbox();
  const record = await loadMatch(key);
  if (!record) return;

  await db.transaction('rw', db.matches, db.match_events, db.outbox, async () => {
    await db.match_events.where('match_id').equals(record.id).delete();
    await db.matches.delete(record.id);
    await _appendToOutbox({
      entity_type: 'match',
      entity_id:   record.id,
      operation:   'delete',
      payload:     { id: record.id },
      seq:         Date.now(),
    });
  });
}
