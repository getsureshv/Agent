/**
 * src/sync/syncEngine.js
 *
 * Main sync engine — drains the local Dexie outbox to the Agent base server
 * via REST, and pulls remote changes on startup / focus / reconnect.
 *
 * EXPORTS:
 *   appendToOutbox(row, dbOrTx)  — re-exported from outbox.js for convenience
 *   startSyncEngine()            — call once in main.js after initDB()
 *   forceDrain()                 — immediately attempt a drain
 *   setSyncState(state, count)   — re-exported from syncStatus.js
 *   pullChanges()                — pull latest matches + events from server
 *
 * RETRY / BACKOFF SCHEDULE (per ARCHITECTURE_V2.md):
 *   Attempt 1 : immediate
 *   Attempt 2 : 5 s
 *   Attempt 3 : 30 s
 *   Attempt 4 : 5 min  (300 s)
 *   Attempt 5+: 30 min (1800 s) — capped
 *
 * ONLINE TRIGGERS:
 *   • window event 'app:online'   — dispatched by SW
 *   • window event 'online'       — native browser network event
 *   • window event 'app:offline'  — dispatched by SW (pause draining)
 *   • document visibilitychange   — pull on tab focus
 *
 * BATCH SIZE: up to 50 outbox rows per POST /api/matches/:id/events.
 *
 * CONFLICT HANDLING:
 *   HTTP 409 → mark row 'acked' (already on server — idempotent dup).
 *   HTTP 403 → mark row 'permanent_error' (not owner).
 *   Other 4xx → mark row 'error'; do not retry.
 *   5xx / network errors → exponential backoff.
 *
 * @module syncEngine
 */

import { authHeaders }                              from './auth.js';
import { setSyncState }                             from './syncStatus.js';
import {
  appendToOutbox,
  getPendingCount,
  getPendingRows,
  markRows,
  pruneAcked,
}                                                   from './outbox.js';

export { appendToOutbox };   // re-export so callers only need this module
export { setSyncState };     // re-export for convenience
export { pullChanges };      // pull-on-focus / pull-on-online

// ── Constants ─────────────────────────────────────────────────────────────────
const BATCH_SIZE = 50;

/**
 * Backoff delays in milliseconds indexed by attempt_count (0-based).
 * Index 0 = first attempt = immediate (0 ms).
 * Index 4 and above = 30 min cap.
 */
const BACKOFF_MS = [
  0,            // attempt 1: immediate
  5_000,        // attempt 2: 5 s
  30_000,       // attempt 3: 30 s
  300_000,      // attempt 4: 5 min
  1_800_000,    // attempt 5+: 30 min (capped)
];

/** After this many failures, mark the row 'error' and stop retrying. */
const MAX_ATTEMPTS = 5;

// ── Engine state ──────────────────────────────────────────────────────────────
let _draining   = false;
let _retryTimer = null;
let _started    = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the sync engine.
 * Registers online/offline/visibility event listeners and performs an initial
 * drain + pull.  Safe to call multiple times — subsequent calls are no-ops.
 */
export function startSyncEngine() {
  if (_started) return;
  _started = true;

  window.addEventListener('online',     _handleOnline,  { passive: true });
  window.addEventListener('app:online', _handleOnline,  { passive: true });
  window.addEventListener('offline',    _handleOffline, { passive: true });
  window.addEventListener('app:offline',_handleOffline, { passive: true });

  // Pull on tab focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      pullChanges().catch(console.error);
    }
  });

  // Pull on reconnect
  window.addEventListener('app:online', () => pullChanges().catch(console.error));

  console.debug('[syncEngine] started');

  if (navigator.onLine) {
    pullChanges().catch(console.error);
    _scheduleDrain(0);
  } else {
    setSyncState('offline');
  }
}

/**
 * Force an immediate drain attempt regardless of current state.
 * @returns {Promise<void>}
 */
export async function forceDrain() {
  _clearRetryTimer();
  await _drain();
}

/**
 * Pull the latest match list and events from the server.
 * Called on app start, tab focus, and reconnect.
 *
 * @returns {Promise<void>}
 */
export async function pullChanges() {
  if (!navigator.onLine) return;

  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    console.warn('[syncEngine] pullChanges: could not get auth headers', err);
    return;
  }

  const base = window.__APP_CONFIG__?.BASE_URL;
  if (!base) return;

  try {
    // 1. Pull updated matches
    const lastSync = localStorage.getItem('last_sync_ts') ?? '1970-01-01T00:00:00Z';
    const matchRes = await fetch(
      `${base}/api/matches?since=${encodeURIComponent(lastSync)}`,
      { headers }
    );
    if (!matchRes.ok) {
      console.warn('[syncEngine] pullChanges: matches fetch failed', matchRes.status);
      return;
    }
    const matches = await matchRes.json();

    const { db } = await import('../storage/db.js');

    for (const match of matches) {
      // Upsert match without touching the outbox (server is source of truth here)
      await db.matches.put(match);

      // 2. Pull events for each returned match
      const lastSeq = await _getLastKnownSeq(match.id, db);
      const evtRes  = await fetch(
        `${base}/api/matches/${match.id}/events?since_seq=${lastSeq}`,
        { headers }
      );
      if (!evtRes.ok) continue;
      const events = await evtRes.json();
      for (const evt of events) {
        await db.match_events.put(evt);
      }
    }

    localStorage.setItem('last_sync_ts', new Date().toISOString());
    console.debug('[syncEngine] pullChanges: complete, pulled', matches.length, 'matches');
  } catch (err) {
    console.warn('[syncEngine] pullChanges error:', err);
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _handleOnline() {
  console.debug('[syncEngine] network online');
  _clearRetryTimer();
  _scheduleDrain(0);
}

function _handleOffline() {
  console.debug('[syncEngine] network offline');
  _clearRetryTimer();
  setSyncState('offline');
}

function _scheduleDrain(delayMs) {
  _clearRetryTimer();
  if (delayMs === 0) {
    _drain().catch((err) => console.error('[syncEngine] drain error:', err));
  } else {
    _retryTimer = setTimeout(
      () => _drain().catch((err) => console.error('[syncEngine] drain error:', err)),
      delayMs
    );
  }
}

function _clearRetryTimer() {
  if (_retryTimer !== null) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

/**
 * Core drain loop.
 * @returns {Promise<void>}
 */
async function _drain() {
  if (_draining) return;
  if (!navigator.onLine) {
    setSyncState('offline');
    return;
  }

  const pending = await getPendingCount();
  if (pending === 0) {
    setSyncState('synced');
    return;
  }

  _draining = true;
  setSyncState('syncing');

  try {
    await _drainBatches();
  } finally {
    _draining = false;
  }

  await _updateStatusAndScheduleRetry();
  pruneAcked().catch(() => {});
}

/**
 * Send all pending outbox rows to the Agent base in batches.
 */
async function _drainBatches() {
  let rows;
  while ((rows = await getPendingRows(BATCH_SIZE)).length > 0) {
    const groups = _groupByEntityType(rows);

    for (const [entityType, groupRows] of Object.entries(groups)) {
      if (entityType === 'match_event') {
        // Group match events by match_id and send in sub-batches
        const byMatch = _groupByMatchId(groupRows);
        for (const [, matchRows] of Object.entries(byMatch)) {
          await _sendMatchEventBatch(matchRows);
        }
      } else {
        // Other entity types: individual upserts
        for (const row of groupRows) {
          await _sendEntityUpsert(entityType, row);
        }
      }
    }

    if (!navigator.onLine) break;
  }
}

/**
 * POST a batch of match_event rows to /api/matches/:id/events.
 * @param {Array} rows
 */
async function _sendMatchEventBatch(rows) {
  const matchId  = rows[0].payload.match_id;
  const payloads = rows.map((r) => r.payload);
  const localIds = rows.map((r) => r.local_id);
  const base     = window.__APP_CONFIG__?.BASE_URL;

  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    await _handleTransientError(rows, `auth error: ${err.message}`);
    return;
  }

  await markRows(localIds, 'in_flight', { last_attempt_at: new Date().toISOString() });

  try {
    const res = await fetch(`${base}/api/matches/${matchId}/events`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(payloads),
    });

    if (res.ok) {
      // Server may return { inserted, skipped } — either way all rows are acked
      await markRows(localIds, 'acked');

    } else if (res.status === 409) {
      // Entire batch already on server — idempotent dup
      console.debug('[syncEngine] 409 — marking acked:', localIds);
      await markRows(localIds, 'acked');

    } else if (res.status === 403) {
      // Not the owner of this match
      console.warn('[syncEngine] 403 — permanent_error (not owner):', matchId);
      await markRows(localIds, 'permanent_error', { last_attempt_at: new Date().toISOString() });

    } else if (res.status >= 400 && res.status < 500) {
      // Other 4xx — permanent failure
      console.warn(`[syncEngine] ${res.status} — marking error:`, localIds);
      await markRows(localIds, 'error', { last_attempt_at: new Date().toISOString() });

    } else {
      // 5xx / unexpected
      await _handleTransientError(rows, `HTTP ${res.status}`);
    }

  } catch (err) {
    // Network error — transient
    await _handleTransientError(rows, err.message);
  }
}

/**
 * POST a single non-event entity upsert.
 * @param {string} entityType
 * @param {object} row
 */
async function _sendEntityUpsert(entityType, row) {
  const tableMap = {
    tournament: 'tournaments',
    match:      'matches',
    team:       'teams',
    player:     'players',
  };
  const tablePath = tableMap[entityType];
  if (!tablePath) {
    console.warn('[syncEngine] unknown entity type:', entityType);
    await markRows([row.local_id], 'error', { last_attempt_at: new Date().toISOString() });
    return;
  }

  const base = window.__APP_CONFIG__?.BASE_URL;
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    await _handleTransientError([row], `auth error: ${err.message}`);
    return;
  }

  await markRows([row.local_id], 'in_flight', { last_attempt_at: new Date().toISOString() });

  try {
    const res = await fetch(`${base}/api/${tablePath}`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(row.payload),
    });

    if (res.ok) {
      await markRows([row.local_id], 'acked');
    } else if (res.status === 409) {
      await markRows([row.local_id], 'acked');
    } else if (res.status === 403) {
      await markRows([row.local_id], 'permanent_error', { last_attempt_at: new Date().toISOString() });
    } else if (res.status >= 400 && res.status < 500) {
      await markRows([row.local_id], 'error', { last_attempt_at: new Date().toISOString() });
    } else {
      await _handleTransientError([row], `HTTP ${res.status}`);
    }
  } catch (err) {
    await _handleTransientError([row], err.message);
  }
}

/**
 * Handle a transient (retryable) failure on a set of rows.
 * Increments attempt_count; marks 'error' after MAX_ATTEMPTS.
 * @param {Array}  rows
 * @param {string} message
 */
async function _handleTransientError(rows, message) {
  console.warn('[syncEngine] transient error:', message);
  for (const row of rows) {
    const newCount = (row.attempt_count ?? 0) + 1;
    if (newCount >= MAX_ATTEMPTS) {
      console.error(`[syncEngine] row ${row.local_id} exceeded max attempts — marking error`);
      await markRows([row.local_id], 'error', {
        attempt_count:   newCount,
        last_attempt_at: new Date().toISOString(),
      });
    } else {
      await markRows([row.local_id], 'pending', {
        attempt_count:   newCount,
        last_attempt_at: new Date().toISOString(),
      });
    }
  }
}

/**
 * After a drain, update the status indicator and schedule retries if needed.
 */
async function _updateStatusAndScheduleRetry() {
  const pendingCount = await getPendingCount();

  if (pendingCount === 0) {
    setSyncState('synced');
    return;
  }

  let hasError = false;
  try {
    const { db } = await import('../storage/db.js');
    const errorCount = await db.outbox
      .where('status').anyOf(['error', 'permanent_error'])
      .count();
    hasError = errorCount > 0;
  } catch { /* db may not be ready yet */ }

  if (hasError) {
    setSyncState('error', pendingCount);
  } else {
    setSyncState('pending', pendingCount);
    _scheduleDrain(await _nextBackoffMs());
  }
}

/**
 * Determine the next backoff delay from the highest attempt_count in pending rows.
 * @returns {Promise<number>} milliseconds
 */
async function _nextBackoffMs() {
  try {
    const { db } = await import('../storage/db.js');
    const rows = await db.outbox.where('status').equals('pending').toArray();
    const maxAttempts = rows.reduce((m, r) => Math.max(m, r.attempt_count ?? 0), 0);
    const idx = Math.min(maxAttempts, BACKOFF_MS.length - 1);
    return BACKOFF_MS[idx];
  } catch {
    return BACKOFF_MS[1]; // fallback 5 s
  }
}

/**
 * Get the highest known event sequence number for a match from local Dexie.
 * @param {string} matchId
 * @param {object} db  Dexie instance
 * @returns {Promise<number>}
 */
async function _getLastKnownSeq(matchId, db) {
  try {
    const last = await db.match_events
      .where('match_id').equals(matchId)
      .reverse().first();
    return last?.seq ?? 0;
  } catch {
    return 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _groupByEntityType(rows) {
  return rows.reduce((acc, row) => {
    (acc[row.entity_type] ??= []).push(row);
    return acc;
  }, {});
}

function _groupByMatchId(rows) {
  return rows.reduce((acc, row) => {
    const mid = row.payload?.match_id ?? 'unknown';
    (acc[mid] ??= []).push(row);
    return acc;
  }, {});
}
