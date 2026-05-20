/**
 * src/sync/syncStatus.js
 *
 * Sync state broadcaster.
 *
 * Exports setSyncState(state, count) which:
 *   1. Updates the DOM element #sync-status if Dev 5 has placed it.
 *   2. Dispatches a window CustomEvent 'sync:state' so Dev 5's UI can react.
 *
 * This module is intentionally thin — heavy rendering logic lives in
 * src/ui/syncIndicator.js (Dev 5 owns that file).
 *
 * States:
 *   'offline'  — no network connection
 *   'pending'  — outbox has N items, not currently draining
 *   'syncing'  — drain in flight
 *   'synced'   — outbox empty, last drain succeeded
 *   'error'    — 5+ failed attempts; manual intervention needed
 *
 * @module syncStatus
 */

/**
 * @typedef {'offline'|'pending'|'syncing'|'synced'|'error'} SyncState
 */

/**
 * Update the sync status indicator.
 *
 * @param {SyncState} state      - Current sync state
 * @param {number}    [count=0]  - Number of pending outbox items (for 'pending' state)
 */
export function setSyncState(state, count = 0) {
  // 1. Update DOM element if present (no-op if Dev 5 hasn't rendered it yet)
  const el = document.getElementById('sync-status');
  if (el) {
    el.dataset.syncState = state;
    el.dataset.syncCount = String(count);
    el.setAttribute('aria-label', _label(state, count));
    // Basic inline rendering as a fallback; Dev 5's syncIndicator.js
    // listens for the 'sync:state' event and renders richer SVG icons.
    el.textContent = _label(state, count);
  }

  // 2. Broadcast to any listener (Dev 5 UI, tests, etc.)
  window.dispatchEvent(
    new CustomEvent('sync:state', {
      detail: { state, count },
      bubbles: false,
    })
  );
}

/**
 * Human-readable label for a sync state.
 * @param {SyncState} state
 * @param {number} count
 * @returns {string}
 */
function _label(state, count) {
  switch (state) {
    case 'offline':  return 'Offline';
    case 'pending':  return `Pending ${count}`;
    case 'syncing':  return 'Syncing\u2026';
    case 'synced':   return 'Synced';
    case 'error':    return 'Sync error';
    default:         return state;
  }
}
