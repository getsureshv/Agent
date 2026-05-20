/**
 * src/storage/tournamentRepo.js
 * All tournament CRUD using Dexie.
 * Replaces: saveTournament(), loadSavedTournaments() from app.js.
 *
 * Every write is atomic: primary-table write + outbox append in same transaction.
 *
 * Exports per INTERFACES.md §Dev 2:
 *   saveTournament, loadTournaments, getTournament, deleteTournament
 */

import db from './db.js';
import { newUUID } from '../utils/uuid.js';
import { appendToOutbox as appendToOutboxStub } from '../sync/_stub.js';

let _appendToOutbox = appendToOutboxStub;

/** Allow Dev 4 to inject the real outbox implementation. */
export function setOutboxImpl(fn) {
  _appendToOutbox = fn;
}

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
    // Not yet available — stub remains active.
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * saveTournament(t)
 * Upsert a tournament document (including nested teams, fixtures, players)
 * into db.tournaments and append an outbox row.
 *
 * Initialises t.id (UUIDv4) if absent.
 *
 * @param {import('./types.d.ts').TournamentState} t
 * @returns {Promise<void>}
 */
export async function saveTournament(t) {
  await loadOutbox();
  if (!t.id) t.id = newUUID();
  t.updated_at = new Date().toISOString();
  if (!t.created_at) t.created_at = t.updated_at;
  if (!t.status) t.status = 'active';

  await db.transaction('rw', db.tournaments, db.outbox, async () => {
    await db.tournaments.put(t);
    await _appendToOutbox({
      entity_type: 'tournament',
      entity_id:   t.id,
      operation:   'upsert',
      payload:     t,
      seq:         Date.now(),
    });
  });
}

/**
 * loadTournaments()
 * Return all tournaments ordered by created_at descending (newest first).
 *
 * @returns {Promise<import('./types.d.ts').TournamentState[]>}
 */
export async function loadTournaments() {
  const all = await db.tournaments.toArray();
  all.sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    return tb.localeCompare(ta);
  });
  return all;
}

/**
 * getTournament(id)
 * Fetch a single tournament by UUID. Returns null if not found.
 *
 * @param {string} id
 * @returns {Promise<import('./types.d.ts').TournamentState | null>}
 */
export async function getTournament(id) {
  const record = await db.tournaments.get(id);
  return record ?? null;
}

/**
 * deleteTournament(id)
 * Delete a tournament by UUID. Appends a delete outbox row.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteTournament(id) {
  await loadOutbox();
  const record = await db.tournaments.get(id);
  if (!record) return;

  await db.transaction('rw', db.tournaments, db.outbox, async () => {
    await db.tournaments.delete(id);
    await _appendToOutbox({
      entity_type: 'tournament',
      entity_id:   id,
      operation:   'delete',
      payload:     { id },
      seq:         Date.now(),
    });
  });
}
