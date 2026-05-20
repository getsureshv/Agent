/**
 * src/sync/_stub.js
 * Fallback stub for appendToOutbox() used until Dev 4's src/sync/syncEngine.js
 * and src/sync/outbox.js land (PR 2).
 *
 * This stub writes directly to db.outbox so the outbox table is populated
 * even before the real sync engine is wired up — unblocking Dev 2's repos.
 *
 * Dev 4 will replace/override this by providing the real implementation
 * at src/sync/outbox.js which matchRepo/tournamentRepo import directly.
 */

import db from '../storage/db.js';

/**
 * appendToOutbox(entry)
 * Appends a record to db.outbox.
 *
 * @param {Object} entry
 * @param {string} entry.entity_type  - 'tournament'|'team'|'player'|'match'|'match_event'
 * @param {string} entry.entity_id    - UUIDv4
 * @param {'upsert'|'delete'} entry.operation
 * @param {object} entry.payload      - full entity JSON (idempotent upsert)
 * @param {number} [entry.seq]        - Date.now() or per-match seq for events
 * @returns {Promise<void>}
 */
export async function appendToOutbox(entry) {
  try {
    await db.outbox.add({
      entity_type:     entry.entity_type,
      entity_id:       entry.entity_id,
      operation:       entry.operation,
      payload:         entry.payload,
      seq:             entry.seq ?? Date.now(),
      status:          'pending',
      created_at:      new Date().toISOString(),
      last_attempt_at: null,
      attempt_count:   0,
    });
  } catch (err) {
    // Non-fatal: log and continue so scoring is never blocked by outbox failures.
    console.warn('[outbox stub] failed to write outbox row:', err);
  }
}

/**
 * getPendingCount()
 * Returns the number of outbox rows with status 'pending'.
 * @returns {Promise<number>}
 */
export async function getPendingCount() {
  return db.outbox.where('status').equals('pending').count();
}
