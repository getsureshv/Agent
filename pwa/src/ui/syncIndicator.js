/**
 * src/ui/syncIndicator.js — Dev 5 (implements DOM; Dev 4 calls setSyncState)
 *
 * Small cloud SVG icon placed in .match-header and .home-header.
 * Listens to window event 'sync:state' (detail: { state, count }).
 *
 * States:
 *   offline  — grey cloud + slash
 *   pending  — orange cloud + badge N
 *   syncing  — blue cloud + spinning arrow
 *   synced   — green cloud + checkmark
 *   error    — red cloud + exclamation
 *
 * On click → opens #sync-modal with last sync time + "Sync now" button.
 * "Sync now" calls Dev 4's forceDrain() if available.
 */

/** @type {SyncState} */
let _currentState = 'synced';
let _pendingCount = 0;
let _lastSyncTime = null;

/**
 * Update the sync indicator UI.
 * Called by Dev 4's SyncEngine on every state transition.
 * Also called by this module when handling the 'sync:state' window event.
 *
 * @param {'offline'|'pending'|'syncing'|'synced'|'error'} state
 * @param {number} [pendingCount=0]
 */
export function setSyncState(state, pendingCount = 0) {
  _currentState = state;
  _pendingCount = pendingCount;
  if (state === 'synced') _lastSyncTime = new Date();
  _renderAll();
}

/** Initialise: wire event listener + render initial state */
export function initSyncIndicator() {
  // Listen for events dispatched by Dev 4's SyncEngine
  window.addEventListener('sync:state', (e) => {
    const { state, count = 0 } = e.detail || {};
    setSyncState(state, count);
  });

  // Initial render
  _renderAll();

  // Wire up modal trigger on all .sync-status elements (event delegation)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.sync-status')) {
      _openSyncModal();
    }
    if (e.target.id === 'sync-now-btn') {
      _triggerForceDrain();
    }
    if (e.target.id === 'close-sync-modal') {
      const modal = document.getElementById('sync-modal');
      if (modal) modal.classList.add('hidden');
    }
  });
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _renderAll() {
  document.querySelectorAll('.sync-status').forEach((el) => _renderIcon(el));
}

function _renderIcon(el) {
  el.innerHTML = _buildSVG(_currentState, _pendingCount);
  el.setAttribute('aria-label', _ariaLabel(_currentState, _pendingCount));
  el.setAttribute('title', _ariaLabel(_currentState, _pendingCount));
  el.dataset.syncState = _currentState;
}

function _ariaLabel(state, count) {
  switch (state) {
    case 'offline':  return 'Offline';
    case 'pending':  return `Pending ${count}`;
    case 'syncing':  return 'Syncing…';
    case 'synced':   return 'Synced';
    case 'error':    return 'Sync error';
    default:         return 'Sync status';
  }
}

/** Returns an inline SVG string for the given state */
function _buildSVG(state, count) {
  const colors = {
    offline: '#9e9e9e',
    pending: '#ff9800',
    syncing: '#42a5f5',
    synced:  '#66bb6a',
    error:   '#ef5350',
  };
  const color = colors[state] || '#9e9e9e';

  // Base cloud path (simplified)
  const cloudPath = `M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z`;

  let overlay = '';

  if (state === 'offline') {
    // Diagonal slash
    overlay = `<line x1="4" y1="4" x2="20" y2="20" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
  } else if (state === 'pending') {
    // No overlay — badge added outside SVG
    overlay = `<text x="12" y="16" text-anchor="middle" font-size="8" fill="${color}" font-weight="bold">${count > 99 ? '99+' : count}</text>`;
  } else if (state === 'syncing') {
    // Spinning arrow (CSS animation applied via class)
    overlay = `<polyline points="1 4 1 10 7 10" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>
               <path d="M3.51 15a9 9 0 1 0 .49-3.5" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  } else if (state === 'synced') {
    // Checkmark
    overlay = `<polyline points="9 11 12 14 22 4" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (state === 'error') {
    // Exclamation mark
    overlay = `<line x1="12" y1="8" x2="12" y2="13" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
               <circle cx="12" cy="16" r="1" fill="${color}"/>`;
  }

  const spinClass = state === 'syncing' ? ' class="sync-spin"' : '';

  return `<svg${spinClass} width="22" height="22" viewBox="0 0 24 24" fill="none"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="${cloudPath}" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    ${overlay}
  </svg>`;
}

function _openSyncModal() {
  let modal = document.getElementById('sync-modal');
  if (!modal) {
    modal = _createSyncModal();
    document.body.appendChild(modal);
  }
  // Update content
  const timeEl = modal.querySelector('#sync-modal-time');
  if (timeEl) {
    timeEl.textContent = _lastSyncTime
      ? `Last synced: ${_lastSyncTime.toLocaleTimeString()}`
      : 'Not yet synced this session';
  }
  const stateEl = modal.querySelector('#sync-modal-state');
  if (stateEl) {
    stateEl.textContent = _ariaLabel(_currentState, _pendingCount);
    stateEl.dataset.syncState = _currentState;
  }
  modal.classList.remove('hidden');
}

function _createSyncModal() {
  const modal = document.createElement('div');
  modal.id = 'sync-modal';
  modal.className = 'modal sync-modal';
  modal.innerHTML = `
    <div class="modal-content sync-modal-content">
      <button class="modal-close" id="close-sync-modal" aria-label="Close">&times;</button>
      <h2 class="sync-modal-title">Sync Status</h2>
      <p id="sync-modal-state" class="sync-modal-state" data-sync-state="synced">Synced</p>
      <p id="sync-modal-time" class="sync-modal-time">Not yet synced this session</p>
      <button class="btn btn-primary btn-large" id="sync-now-btn">Sync Now</button>
    </div>`;
  return modal;
}

async function _triggerForceDrain() {
  try {
    // Dev 4 exports forceDrain from src/sync/syncEngine.js
    const { forceDrain } = await import('../sync/syncEngine.js');
    await forceDrain();
  } catch (e) {
    console.warn('[syncIndicator] forceDrain not available:', e.message);
  }
}
