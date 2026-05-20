/**
 * src/sync/realtime.js
 *
 * Native WebSocket connection to the Agent base server for live spectator mode.
 *
 * Live spectator mode:
 *   Call connectMatchSocket(matchId) when entering a live/spectator view.
 *   Call disconnectMatchSocket()     when leaving.
 *
 * The socket connects to BASE_URL with "http" → "ws" substitution, at path /ws.
 * On open it sends { type: 'subscribe', match_id }.
 * Incoming { type: 'match_event', event } messages are applied to local Dexie
 * and re-dispatched as window CustomEvent 'realtime:match_event'.
 *
 * Reconnection:
 *   On close/error the module reconnects with exponential backoff
 *   (1 s → 2 s → 4 s → 8 s … capped at 30 s), provided the match context
 *   is still set (i.e. the caller hasn't disconnected).
 *
 * Owner-device guard:
 *   The scoring screen should ignore 'realtime:match_event' events whose
 *   seq is already present in local Dexie (Dexie.put() is idempotent so
 *   writing them is harmless, but the UI re-render can be skipped).
 *
 * Exports:
 *   connectMatchSocket(matchId)   — subscribe to live events for a match
 *   disconnectMatchSocket()       — unsubscribe and close the socket
 *   isRealtimeActive()            — true when socket is OPEN
 *
 * @module realtime
 */

/** @type {WebSocket|null} */
let _ws             = null;
let _currentMatchId = null;
let _reconnectTimer = null;
let _reconnectDelay = 1_000;   // ms — reset on clean disconnect

const MAX_RECONNECT_DELAY = 30_000;  // 30 s cap

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open a WebSocket and subscribe to live events for matchId.
 * If already subscribed to the same match, this is a no-op.
 *
 * @param {string} matchId
 */
export function connectMatchSocket(matchId) {
  if (_currentMatchId === matchId && _ws?.readyState === WebSocket.OPEN) {
    return;  // already subscribed
  }
  disconnectMatchSocket();     // clean up any previous socket
  _currentMatchId = matchId;
  _reconnectDelay = 1_000;     // reset backoff for fresh subscription
  _openSocket();
}

/**
 * Unsubscribe from the current match and close the WebSocket.
 */
export function disconnectMatchSocket() {
  _clearReconnectTimer();
  _currentMatchId = null;      // signal: don't reconnect
  if (_ws) {
    if (_ws.readyState === WebSocket.OPEN) {
      try {
        _ws.send(JSON.stringify({ type: 'unsubscribe', match_id: _currentMatchId }));
      } catch { /* ignore send error on closing socket */ }
    }
    _ws.close();
    _ws = null;
  }
}

/**
 * Returns true when the WebSocket is currently OPEN.
 * @returns {boolean}
 */
export function isRealtimeActive() {
  return _ws !== null && _ws.readyState === WebSocket.OPEN;
}

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Open the WebSocket to the Agent base server.
 */
function _openSocket() {
  const base = (window.__APP_CONFIG__?.BASE_URL ?? '').replace(/^http/, 'ws');
  if (!base) {
    console.warn('[realtime] BASE_URL not set — cannot open WebSocket');
    return;
  }

  let ws;
  try {
    ws = new WebSocket(`${base}/ws`);
  } catch (err) {
    console.error('[realtime] WebSocket constructor threw:', err);
    _scheduleReconnect();
    return;
  }

  _ws = ws;

  ws.addEventListener('open', () => {
    _reconnectDelay = 1_000;  // reset backoff on successful connection
    console.debug('[realtime] connected for match', _currentMatchId);
    ws.send(JSON.stringify({ type: 'subscribe', match_id: _currentMatchId }));
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type !== 'match_event') return;

    const evt = msg.event;
    _applyEvent(evt);
  });

  ws.addEventListener('close', (e) => {
    console.debug('[realtime] socket closed', e.code, e.reason);
    _ws = null;
    if (_currentMatchId) {
      // Reconnect unless explicitly disconnected by the caller
      _scheduleReconnect();
    }
  });

  ws.addEventListener('error', (err) => {
    console.error('[realtime] WebSocket error', err);
    // 'error' is always followed by 'close', so reconnect is handled there
  });
}

/**
 * Apply an incoming server event to local Dexie and notify the UI.
 * @param {object} evt  match_event row from the server
 */
async function _applyEvent(evt) {
  try {
    const { db } = await import('../storage/db.js');
    await db.match_events.put(evt);
    window.dispatchEvent(
      new CustomEvent('realtime:match_event', { detail: evt, bubbles: false })
    );
  } catch (err) {
    console.error('[realtime] failed to apply event:', err);
  }
}

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function _scheduleReconnect() {
  _clearReconnectTimer();
  if (!_currentMatchId) return;  // disconnected cleanly — do not reconnect

  const delay = _reconnectDelay;
  console.debug(`[realtime] reconnecting in ${delay}ms …`);

  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_currentMatchId) {
      _openSocket();
    }
  }, delay);

  // Exponential backoff, capped at MAX_RECONNECT_DELAY
  _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function _clearReconnectTimer() {
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}
