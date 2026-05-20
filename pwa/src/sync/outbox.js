/**
 * src/sync/outbox.js
 *
 * Client-side outbox: append and query pending sync entries.
 *
 * The outbox is stored in Dexie (IndexedDB, table: 'outbox').
 * Dev 2 (storage/db.js) owns the Dexie schema; this module depends on it.
 *
 * INTERFACE CONTRACT (for Dev 2's commands.js / matchRepo.js):
 * ─────────────────────────────────────────────────────────────
 *   appendToOutbox(row, dbOrTx?)
 *
 *   @param {OutboxRow}       row      - The outbox entry to append (see type below)
 *   @param {Dexie|DexieTx?} dbOrTx   - Optional: a Dexie instance or an
 *                                       active Dexie transaction object.
 *                                       • Pass the Dexie `db` instance (from db.js)
 *                                         when calling outside a transaction.
 *                                       • Pass the Dexie transaction handle (the
 *                                         `tx` object inside a db.transaction()
 *                                         callback) to make the outbox append
 *                                         part of the same atomic transaction as
 *                                         the entity write — strongly recommended
 *                                         to avoid "entity saved but not in outbox"
 *                                         inconsistencies.
 *                                       • If undefined, the module lazy-imports
 *                                         db.js and opens its own transaction.
 *                                         Use this only for standalone callers that
 *                                         don't have a Dexie transaction in scope.
 *
 * USAGE EXAMPLE (inside Dev 2's appendMatchEvent):
 * ─────────────────────────────────────────────────
 *   import { db } from '../storage/db.js';
 *   import { appendToOutbox } from '../sync/outbox.js';
 *
 *   export async function appendMatchEvent(event) {
 *     await db.transaction('rw', [db.match_events, db.outbox], async (tx) => {
 *       await tx.match_events.add(event);
 *       await appendToOutbox({
 *         entity_type: 'match_event',
 *         entity_id:   event.id,
 *         operation:   'upsert',
 *         payload:     event,
 *         seq:         event.seq,          // per-match monotone seq
 *       }, tx);
 *     });
 *   }
 *
 * @module outbox
 */

// ── Types ─────────────────────────────────────────────────────────────────────
/**
 * @typedef {'tournament'|'team'|'player'|'match'|'match_event'} EntityType
 * @typedef {'upsert'|'delete'} Operation
 * @typedef {'pending'|'in_flight'|'acked'|'error'} OutboxStatus
 *
 * @typedef {object} OutboxRow
 * @property {EntityType} entity_type
 * @property {string}     entity_id       - UUIDv4 of the entity
 * @property {Operation}  operation
 * @property {object}     payload         - Full entity JSON (idempotent upserts)
 * @property {number}     seq             - Date.now() ms for non-events; per-match seq for match_events
 * @property {OutboxStatus} [status]      - Defaults to 'pending'; set by sync engine
 * @property {number}     [attempt_count] - Managed by sync engine
 * @property {string|null} [last_attempt_at] - ISO-8601; managed by sync engine
 */

// ── Lazy DB import ────────────────────────────────────────────────────────────
// We lazy-import db.js so that outbox.js can be imported by other modules
// without triggering Dexie initialisation at module parse time.
let _db = null;
async function _getDb() {
  if (!_db) {
    const mod = await import('../storage/db.js');
    _db = mod.db;
  }
  return _db;
}

// ── appendToOutbox ────────────────────────────────────────────────────────────

/**
 * Append a row to the local outbox.
 *
 * @param {OutboxRow}       row
 * @param {object|undefined} dbOrTx  - Dexie db instance OR active transaction
 * @returns {Promise<number>}  local_id assigned by Dexie auto-increment
 */
export async function appendToOutbox(row, dbOrTx) {
  const entry = {
    entity_type:     row.entity_type,
    entity_id:       row.entity_id,
    operation:       row.operation,
    payload:         row.payload,
    seq:             row.seq ?? Date.now(),
    status:          'pending',
    created_at:      new Date().toISOString(),
    last_attempt_at: null,
    attempt_count:   0,
  };

  if (dbOrTx) {
    // Caller provided a Dexie db or transaction object.
    // Use .outbox table on it directly.
    const table = dbOrTx.outbox ?? dbOrTx.table?.('outbox');
    if (!table) {
      throw new Error('[outbox] dbOrTx has no .outbox table. Pass the Dexie db or a transaction opened on [outbox].');
    }
    return table.add(entry);
  }

  // No transaction provided — open our own.
  const db = await _getDb();
  return db.outbox.add(entry);
}

// ── getPendingCount ───────────────────────────────────────────────────────────

/**
 * Count outbox rows with status 'pending' or 'in_flight'.
 * Used by syncStatus to display the pending badge count.
 *
 * @returns {Promise<number>}
 */
export async function getPendingCount() {
  const db = await _getDb();
  return db.outbox
    .where('status')
    .anyOf(['pending', 'in_flight'])
    .count();
}

// ── getPendingRows ────────────────────────────────────────────────────────────

/**
 * Fetch up to `limit` pending outbox rows ordered by seq ASC.
 * Used by syncEngine to build drain batches.
 *
 * @param {number} [limit=50]
 * @returns {Promise<Array<OutboxRow & { local_id: number }>>}
 */
export async function getPendingRows(limit = 50) {
  const db = await _getDb();
  return db.outbox
    .where('status')
    .equals('pending')
    .sortBy('seq')
    .then((rows) => rows.slice(0, limit));
}

// ── markRows ──────────────────────────────────────────────────────────────────

/**
 * Update the status of a set of outbox rows by their local_id.
 *
 * @param {number[]}     localIds
 * @param {OutboxStatus} status
 * @param {object}       [extra]   - Additional fields to merge (e.g. { attempt_count, last_attempt_at })
 * @returns {Promise<void>}
 */
export async function markRows(localIds, status, extra = {}) {
  if (!localIds.length) return;
  const db = await _getDb();
  await db.outbox
    .where('local_id')
    .anyOf(localIds)
    .modify({ status, ...extra });
}

// ── pruneAcked ────────────────────────────────────────────────────────────────

/**
 * Delete outbox rows that have been acknowledged and are older than 7 days.
 * Call this after a successful drain to keep IndexedDB tidy.
 *
 * @returns {Promise<number>} count of deleted rows
 */
export async function pruneAcked() {
  const db = await _getDb();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return db.outbox
    .where('status')
    .equals('acked')
    .and((row) => row.created_at < cutoff)
    .delete();
}
