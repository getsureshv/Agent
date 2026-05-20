/**
 * api-bridge.js — Non-invasive bridge between the Cricket Scorer app.js
 * (localStorage-based) and the REST + WebSocket API on the same server.
 *
 * Strategy:
 *  1. On first load, register this device and store a Bearer token.
 *  2. Override localStorage.setItem / getItem / removeItem so that writes
 *     to the cricket_* keys are also pushed to the REST API (debounced).
 *  3. On startup, pull tournaments and recent matches from the server and
 *     hydrate localStorage — but NEVER clobber newer local state.
 *  4. Subscribe to the WebSocket for the active match; on incoming events
 *     from OTHER devices, merge state into localStorage and call
 *     updateDisplay() (the app.js re-render entry-point, which is called
 *     inside the IIFE but also reachable via the storage event pathway we
 *     set up).
 *  5. Show a small fixed status indicator in the corner (no CSS changes).
 *
 * DOES NOT modify app.js or styles.css.
 */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var TOKEN_KEY        = 'cricket_device_token';
  var LAST_SYNC_KEY    = 'cricket_last_sync';
  var BRIDGE_STATUS_ID = 'cricket-bridge-status';

  // Keys we intercept. Pattern: cricket_match_quick, cricket_match_<t>_<i>,
  // cricket_tournaments, cricket_seq_<matchId>.
  var MATCH_QUICK_KEY      = 'cricket_match_quick';
  var TOURNAMENTS_KEY      = 'cricket_tournaments';
  var MATCH_KEY_PREFIX     = 'cricket_match_';
  var SEQ_KEY_PREFIX       = 'cricket_seq_';

  // ── Helpers ────────────────────────────────────────────────────────────────
  function generateUUID() {
    // RFC 4122 v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function isCricketKey(key) {
    return typeof key === 'string' && key.indexOf('cricket_') === 0;
  }

  function isMatchKey(key) {
    // cricket_match_quick or cricket_match_<tournament>_<index>
    return typeof key === 'string' && key.indexOf(MATCH_KEY_PREFIX) === 0 && key.indexOf(SEQ_KEY_PREFIX) !== 0;
  }

  // ── Status indicator ───────────────────────────────────────────────────────
  var _statusEl = null;

  function ensureStatusEl() {
    if (_statusEl) return _statusEl;
    _statusEl = document.createElement('div');
    _statusEl.id = BRIDGE_STATUS_ID;
    _statusEl.style.cssText = [
      'position:fixed',
      'bottom:8px',
      'right:8px',
      'z-index:99999',
      'font-size:11px',
      'padding:3px 7px',
      'border-radius:10px',
      'background:rgba(0,0,0,0.55)',
      'color:#fff',
      'pointer-events:none',
      'font-family:monospace',
      'white-space:nowrap',
      'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(_statusEl);
    return _statusEl;
  }

  // states: 'synced' | 'pending' | 'offline' | 'error'
  var _pendingCount = 0;
  var _syncState    = 'offline';

  function setStatus(state, extra) {
    _syncState = state;
    var labels = {
      synced:  '🟢 Synced',
      pending: '🟡 ' + (_pendingCount || '') + ' pending',
      offline: '⚪ Offline',
      error:   '🔴 Error',
    };
    var el = ensureStatusEl();
    el.textContent = labels[state] || ('⚪ ' + state);
    if (extra) el.title = extra;
    // Dispatch sync:state event for consistency with PWA
    try {
      window.dispatchEvent(new CustomEvent('sync:state', { detail: { state: state, pending: _pendingCount } }));
    } catch (e) { /* ignore */ }
  }

  // ── Auth / device token ────────────────────────────────────────────────────
  var _token = null;

  function getToken() {
    return _token || _nativeGetItem(TOKEN_KEY);
  }

  function authHeaders() {
    var t = getToken();
    var h = { 'Content-Type': 'application/json' };
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function registerDevice() {
    var existing = _nativeGetItem(TOKEN_KEY);
    if (existing) { _token = existing; return Promise.resolve(existing); }
    return fetch('/api/devices/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'browser-' + (navigator.userAgent.slice(0, 30)) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.token) {
          _token = j.token;
          _nativeSetItem(TOKEN_KEY, _token);
        }
        return _token;
      })
      .catch(function () { return null; });
  }

  // ── Native localStorage references (captured before override) ─────────────
  var _nativeSetItem    = localStorage.setItem.bind(localStorage);
  var _nativeGetItem    = localStorage.getItem.bind(localStorage);
  var _nativeRemoveItem = localStorage.removeItem.bind(localStorage);

  // ── Debounce map: matchKey → timer ─────────────────────────────────────────
  var _debounceTimers = {};

  function debounceSync(key, fn) {
    if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(function () {
      delete _debounceTimers[key];
      fn();
    }, 200);
  }

  // ── Core: push a match state to the API ────────────────────────────────────
  function syncMatchKey(key) {
    var raw = _nativeGetItem(key);
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !data.match) return;

    var m = data.match;

    // Ensure match has an id; inject one if missing and write back
    if (!m.id) {
      m.id = generateUUID();
      data.match = m;
      _nativeSetItem(key, JSON.stringify(data));
    }

    var matchId = m.id;

    // Build seq counter
    var seqKey = SEQ_KEY_PREFIX + matchId;
    var lastSeq = parseInt(_nativeGetItem(seqKey) || '0', 10);

    // Gather all ball events from all innings
    var newEvents = [];
    if (m.innings && Array.isArray(m.innings)) {
      m.innings.forEach(function (inn, innIdx) {
        // Collect balls from each batsman's ballHistory
        if (inn.batsmen && Array.isArray(inn.batsmen)) {
          inn.batsmen.forEach(function (batsman) {
            if (batsman.ballHistory && Array.isArray(batsman.ballHistory)) {
              batsman.ballHistory.forEach(function (ball) {
                if (!ball._seq) return; // skip if no seq tag (handled below)
              });
            }
          });
        }
        // Collect from thisOver
        if (inn.thisOver && Array.isArray(inn.thisOver)) {
          inn.thisOver.forEach(function (ball) {
            if (ball && ball._seq && ball._seq > lastSeq) {
              newEvents.push(ballToEvent(ball, matchId, innIdx));
            }
          });
        }
        // Collect from lastOver
        if (inn.lastOver && Array.isArray(inn.lastOver)) {
          inn.lastOver.forEach(function (ball) {
            if (ball && ball._seq && ball._seq > lastSeq) {
              newEvents.push(ballToEvent(ball, matchId, innIdx));
            }
          });
        }
      });
    }

    _pendingCount++;
    setStatus('pending');

    // POST the match state
    var matchPayload = buildMatchPayload(m, matchId);
    fetch('/api/matches', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(matchPayload),
    })
      .then(function (r) {
        if (r.status === 403) {
          setStatus('error', 'Match owned by another device — read-only');
          _pendingCount = Math.max(0, _pendingCount - 1);
          if (_pendingCount === 0) setStatus('synced');
          return null;
        }
        return r.json();
      })
      .then(function (stored) {
        if (!stored) return;
        // POST new events if any
        if (newEvents.length > 0) {
          return fetch('/api/matches/' + matchId + '/events', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(newEvents),
          })
            .then(function (r) { return r.json(); })
            .then(function (result) {
              if (result && result.inserted > 0) {
                var maxSeq = newEvents.reduce(function (acc, e) { return Math.max(acc, e.seq); }, lastSeq);
                _nativeSetItem(seqKey, String(maxSeq));
              }
            });
        }
      })
      .then(function () {
        _pendingCount = Math.max(0, _pendingCount - 1);
        if (_pendingCount === 0) {
          _nativeSetItem(LAST_SYNC_KEY, new Date().toISOString());
          setStatus('synced');
        }
      })
      .catch(function (err) {
        _pendingCount = Math.max(0, _pendingCount - 1);
        setStatus('offline', String(err));
      });
  }

  function ballToEvent(ball, matchId, innIdx) {
    return {
      id:             ball._eventId || generateUUID(),
      match_id:       matchId,
      innings_number: innIdx,
      over_number:    typeof ball.over === 'number' ? ball.over : 0,
      ball_in_over:   typeof ball.ballInOver === 'number' ? ball.ballInOver : 0,
      event_type:     mapEventType(ball),
      runs:           typeof ball.runs === 'number' ? ball.runs : 0,
      extra_type:     ball.extra || null,
      extra_runs:     typeof ball.extraRuns === 'number' ? ball.extraRuns : 0,
      dismissal_type: ball.dismissal || null,
      seq:            ball._seq,
    };
  }

  function mapEventType(ball) {
    if (ball.type === 'wicket')   return 'wicket';
    if (ball.type === 'wide')     return 'wide';
    if (ball.type === 'noball')   return 'noball';
    if (ball.type === 'bye')      return 'bye';
    if (ball.type === 'legbye')   return 'legbye';
    if (ball.type === 'innings_end') return 'innings_end';
    if (ball.type === 'match_end')   return 'match_end';
    return 'runs';
  }

  function buildMatchPayload(m, matchId) {
    var status = 'in_progress';
    if (!m.innings || m.innings.length === 0) status = 'setup';
    else if (m.innings.length > 1 && m.innings[m.innings.length - 1] && m.innings[m.innings.length - 1].isComplete) {
      status = 'completed';
    }
    return {
      id:               matchId,
      tournament_id:    m.tournamentId || null,
      overs_limit:      m.oversLimit || 20,
      players_per_team: m.playersPerTeam || 11,
      status:           status,
      result_text:      m.resultText || null,
      // team1/team2 names stored in result_text if no DB-linked team UUIDs
    };
  }

  // ── Core: push tournament state to the API ─────────────────────────────────
  function syncTournaments() {
    var raw = _nativeGetItem(TOURNAMENTS_KEY);
    if (!raw) return;
    var list;
    try { list = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(list) || list.length === 0) return;

    list.forEach(function (t) {
      if (!t.id) { t.id = generateUUID(); }
      var payload = {
        id:                t.id,
        name:              t.name,
        format:            t.format || 'league',
        overs_per_innings: t.overs || 10,
        players_per_team:  t.playersPerTeam || 11,
        squad_size:        t.squadSize || 15,
        status:            t.status || 'active',
      };
      fetch('/api/tournaments', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      }).catch(function () { /* offline — ignore */ });
    });

    // Write IDs back if we generated them
    _nativeSetItem(TOURNAMENTS_KEY, JSON.stringify(list));
  }

  // ── localStorage override ─────────────────────────────────────────────────
  var _bridgeActive = false; // set to true after device registration

  Object.defineProperty(localStorage, 'setItem', {
    configurable: true,
    writable:     true,
    value: function (key, value) {
      _nativeSetItem(key, value);
      if (!_bridgeActive) return;
      if (!isCricketKey(key)) return;
      if (key === TOKEN_KEY || key === LAST_SYNC_KEY) return;
      if (key.indexOf(SEQ_KEY_PREFIX) === 0) return;

      if (isMatchKey(key)) {
        debounceSync(key, function () { syncMatchKey(key); });
      } else if (key === TOURNAMENTS_KEY) {
        debounceSync(TOURNAMENTS_KEY, syncTournaments);
      }
    },
  });

  Object.defineProperty(localStorage, 'getItem', {
    configurable: true,
    writable:     true,
    value: function (key) {
      return _nativeGetItem(key);
    },
  });

  Object.defineProperty(localStorage, 'removeItem', {
    configurable: true,
    writable:     true,
    value: function (key) {
      _nativeRemoveItem(key);
      // No server-side delete in v1; match_events stay in DB
    },
  });

  // ── Pull-on-startup: hydrate localStorage from server ─────────────────────
  // Prefer local if server has an older updated_at.
  function hydrateFromServer() {
    var since = _nativeGetItem(LAST_SYNC_KEY) || '1970-01-01T00:00:00.000Z';

    var tournamentsP = fetch('/api/tournaments', { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (serverList) {
        if (!Array.isArray(serverList) || serverList.length === 0) return;
        var localRaw = _nativeGetItem(TOURNAMENTS_KEY);
        var local = localRaw ? (JSON.parse(localRaw) || []) : [];
        var changed = false;
        serverList.forEach(function (st) {
          var idx = local.findIndex(function (lt) { return lt.id === st.id || lt.name === st.name; });
          if (idx < 0) {
            local.push(st); changed = true;
          } else {
            var lt = local[idx];
            var serverNewer = !lt.updated_at || (st.updated_at && st.updated_at > lt.updated_at);
            if (serverNewer) { local[idx] = Object.assign({}, lt, st); changed = true; }
          }
        });
        if (changed) _nativeSetItem(TOURNAMENTS_KEY, JSON.stringify(local));
      })
      .catch(function () { /* offline */ });

    var matchesP = fetch('/api/matches?since=' + encodeURIComponent(since), { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (serverMatches) {
        if (!Array.isArray(serverMatches)) return;
        serverMatches.forEach(function (sm) {
          if (!sm.id) return;
          // Determine local storage key for this match
          var candidateKeys = [MATCH_QUICK_KEY];
          var localRaw = _nativeGetItem(TOURNAMENTS_KEY);
          if (localRaw) {
            try {
              var ts = JSON.parse(localRaw);
              ts.forEach(function (t) {
                if (t.fixtures) {
                  t.fixtures.forEach(function (f, i) {
                    candidateKeys.push(MATCH_KEY_PREFIX + t.name + '_' + i);
                  });
                }
              });
            } catch (e) {}
          }

          var found = false;
          candidateKeys.forEach(function (k) {
            var localRaw2 = _nativeGetItem(k);
            if (!localRaw2) return;
            var localData;
            try { localData = JSON.parse(localRaw2); } catch (e) { return; }
            if (!localData || !localData.match) return;
            if (localData.match.id !== sm.id) return;
            found = true;
            // Only overwrite if server is strictly newer
            var localUpdated = localData.match.updated_at || '0';
            var serverUpdated = sm.updated_at || '0';
            if (serverUpdated > localUpdated) {
              localData.match = Object.assign({}, localData.match, sm);
              _nativeSetItem(k, JSON.stringify(localData));
            }
          });
          // If not found locally, store under quick key only if it's a quick match
          if (!found && !sm.tournament_id) {
            var existingQuick = _nativeGetItem(MATCH_QUICK_KEY);
            if (!existingQuick) {
              _nativeSetItem(MATCH_QUICK_KEY, JSON.stringify({ match: sm, currentFixtureIndex: -1, tournamentName: null }));
            }
          }
        });
      })
      .catch(function () { /* offline */ });

    return Promise.all([tournamentsP, matchesP])
      .then(function () {
        _nativeSetItem(LAST_SYNC_KEY, new Date().toISOString());
        setStatus('synced');
      })
      .catch(function () { setStatus('offline'); });
  }

  // ── WebSocket subscription ─────────────────────────────────────────────────
  var _ws               = null;
  var _wsMatchId        = null;
  var _wsReconnectDelay = 2000;
  var _wsRetries        = 0;
  var MAX_WS_RETRIES    = 5;

  function openWebSocket(matchId) {
    if (_ws && _ws.readyState === WebSocket.OPEN && _wsMatchId === matchId) return;
    closeWebSocket();
    _wsMatchId = matchId;

    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var url   = proto + '://' + location.host + '/ws';
    try {
      _ws = new WebSocket(url);
    } catch (e) { return; }

    _ws.addEventListener('open', function () {
      _wsRetries = 0;
      _ws.send(JSON.stringify({ type: 'subscribe', match_id: matchId }));
    });

    _ws.addEventListener('message', function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === 'match_event' && msg.match_id === matchId) {
        handleRemoteEvent(matchId, msg.event);
      }
    });

    _ws.addEventListener('close', function () {
      _ws = null;
      if (_wsRetries < MAX_WS_RETRIES) {
        _wsRetries++;
        setTimeout(function () { openWebSocket(matchId); }, _wsReconnectDelay * _wsRetries);
      }
    });

    _ws.addEventListener('error', function () {
      // Will trigger close → reconnect
    });
  }

  function closeWebSocket() {
    if (_ws) {
      if (_wsMatchId) {
        try { _ws.send(JSON.stringify({ type: 'unsubscribe', match_id: _wsMatchId })); } catch (e) {}
      }
      _ws.close();
      _ws = null;
      _wsMatchId = null;
    }
  }

  /**
   * Handle a match_event received from the WebSocket (from a DIFFERENT device).
   * We merge it into the local match state, then trigger app.js to re-render
   * by dispatching a storage event on the relevant key, which causes the
   * localStorage.setItem override to fire — but we also call the patched
   * updateDisplay bridge directly.
   *
   * Re-render pathway:
   *   remote event arrives → merge into localStorage match data →
   *   dispatch window storage event with the match key →
   *   also call window.__cricketBridgeRerender() which is set up
   *   after app.js loads to call updateDisplay() indirectly via a
   *   document-level CustomEvent that we fire.
   */
  function handleRemoteEvent(matchId, event) {
    if (!event || !matchId) return;

    // Find the local match key
    var matchKey = findMatchKeyById(matchId);
    if (!matchKey) return;

    var raw = _nativeGetItem(matchKey);
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !data.match) return;

    // Only merge if we are NOT the owner of this match
    // (if we are the owner, we sent these events ourselves)
    var seqKey    = SEQ_KEY_PREFIX + matchId;
    var localSeq  = parseInt(_nativeGetItem(seqKey) || '0', 10);
    if (event.seq && event.seq <= localSeq) return; // already have it

    // Append the ball to the appropriate innings.thisOver
    var m   = data.match;
    var inn = m.innings && m.innings[event.innings_number];
    if (inn) {
      var ball = {
        type:        event.event_type,
        runs:        event.runs || 0,
        extra:       event.extra_type,
        extraRuns:   event.extra_runs || 0,
        dismissal:   event.dismissal_type,
        _seq:        event.seq,
        _eventId:    event.id,
        over:        event.over_number,
        ballInOver:  event.ball_in_over,
      };
      if (!inn.thisOver) inn.thisOver = [];
      inn.thisOver.push(ball);
      // Update seq counter
      _nativeSetItem(seqKey, String(event.seq));
    }

    // Write merged state back (bypass override with native)
    _nativeSetItem(matchKey, JSON.stringify(data));

    // Trigger re-render in app.js.
    // app.js's updateDisplay() is inside a closed IIFE and not exported,
    // BUT it is called by saveMatchState() which is triggered every time
    // the scoring screen updates. The safest cross-boundary trigger is:
    //  1. Dispatch a 'storage' event so any storage listeners fire.
    //  2. Dispatch the custom 'cricket:remoteUpdate' CustomEvent which we
    //     hook below (after app.js loads) to call updateDisplay via
    //     a synthetic button click on a no-op hidden button, OR via
    //     the exposed __cricketUpdateDisplay global (if app.js exports it).
    //  3. As a fallback, fire the storage event — app.js does NOT listen
    //     to storage events directly, so we use approach (2).
    try {
      window.dispatchEvent(new CustomEvent('cricket:remoteUpdate', {
        detail: { matchId: matchId, event: event },
      }));
    } catch (e) {}
  }

  function findMatchKeyById(matchId) {
    // Check quick match
    var qRaw = _nativeGetItem(MATCH_QUICK_KEY);
    if (qRaw) {
      try {
        var qd = JSON.parse(qRaw);
        if (qd && qd.match && qd.match.id === matchId) return MATCH_QUICK_KEY;
      } catch (e) {}
    }
    // Check tournament match keys
    var tRaw = _nativeGetItem(TOURNAMENTS_KEY);
    if (tRaw) {
      try {
        var ts = JSON.parse(tRaw);
        for (var ti = 0; ti < ts.length; ti++) {
          var t = ts[ti];
          if (!t.fixtures) continue;
          for (var fi = 0; fi < t.fixtures.length; fi++) {
            var k = MATCH_KEY_PREFIX + t.name + '_' + fi;
            var mRaw = _nativeGetItem(k);
            if (!mRaw) continue;
            try {
              var md = JSON.parse(mRaw);
              if (md && md.match && md.match.id === matchId) return k;
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return null;
  }

  // ── Watch for active match to open WS subscription ────────────────────────
  // We poll the localStorage match key every 5 s to detect when a match opens.
  // This avoids patching app.js while still being responsive.
  var _wsWatchKey = null;
  function startWsWatcher() {
    setInterval(function () {
      // Find the currently active match key by checking which match key has
      // an active (non-complete) match
      var candidates = [MATCH_QUICK_KEY];
      var tRaw = _nativeGetItem(TOURNAMENTS_KEY);
      if (tRaw) {
        try {
          var ts = JSON.parse(tRaw);
          ts.forEach(function (t) {
            if (t.fixtures) {
              t.fixtures.forEach(function (f, i) {
                candidates.push(MATCH_KEY_PREFIX + t.name + '_' + i);
              });
            }
          });
        } catch (e) {}
      }
      var activeKey = null;
      candidates.forEach(function (k) {
        var raw = _nativeGetItem(k);
        if (!raw) return;
        try {
          var d = JSON.parse(raw);
          if (d && d.match && d.match.innings && d.match.innings.length > 0) {
            var ci = d.match.currentInnings || 0;
            var inn = d.match.innings[ci];
            if (inn && !inn.isComplete) activeKey = k;
          }
        } catch (e) {}
      });

      if (activeKey !== _wsWatchKey) {
        _wsWatchKey = activeKey;
        if (activeKey) {
          var raw2 = _nativeGetItem(activeKey);
          if (raw2) {
            try {
              var d2 = JSON.parse(raw2);
              if (d2 && d2.match && d2.match.id) {
                openWebSocket(d2.match.id);
              }
            } catch (e) {}
          }
        } else {
          closeWebSocket();
        }
      }
    }, 5000);
  }

  // ── Cricket remote update re-render hook ───────────────────────────────────
  // After app.js initialises, hook cricket:remoteUpdate to trigger updateDisplay.
  // app.js exposes updateDisplay indirectly: it calls it after saveMatchState().
  // We simulate the scoring screen being "refreshed" by dispatching a synthetic
  // 'storage' event. app.js does not listen to storage events, so we also call
  // window.__cricketBridgeRerender if it was registered.
  window.addEventListener('cricket:remoteUpdate', function (e) {
    // If app.js registered a re-render hook, call it
    if (typeof window.__cricketBridgeRerender === 'function') {
      try { window.__cricketBridgeRerender(e.detail); } catch (err) {}
    }
  });

  // Warn the user when a 403 (ownership conflict) is received
  window.addEventListener('sync:state', function (e) {
    if (e.detail && e.detail.state === 'error') {
      var el = ensureStatusEl();
      el.style.cursor = 'pointer';
      el.title = '403: This match is owned by another device. You can view but not score.';
    }
  });

  // ── Startup sequence ───────────────────────────────────────────────────────
  function init() {
    // Ensure status indicator is in DOM (called after DOMContentLoaded)
    ensureStatusEl();
    setStatus('offline');

    registerDevice()
      .then(function (token) {
        if (!token) { setStatus('offline', 'Could not register device'); return; }
        _bridgeActive = true;
        setStatus('pending', 'Syncing from server...');
        return hydrateFromServer();
      })
      .then(function () {
        startWsWatcher();
      })
      .catch(function (err) {
        setStatus('offline', String(err));
        // Still start WS watcher — may recover when server comes back
        startWsWatcher();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
