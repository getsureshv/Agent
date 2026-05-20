# Cricket Scorer Mobile — Architecture v2 (Supabase → Agent Base)

> **Repo:** https://github.com/getsureshv/Agent-Mobile  
> **Change:** Supabase is removed. The sync engine now talks to the Agent
> base server (self-hosted Node.js + Postgres on Railway).  
> **Backward compatibility:** All Dexie schemas, scoring engine, UI, and voice
> code are **unchanged**. Only the sync layer is replaced.

---

## 1. What Changed

| Layer | v1 (Supabase) | v2 (Agent base) |
|-------|--------------|-----------------|
| Auth | Supabase Auth (email magic link, JWTs) | Device-token UUID in `localStorage`; sent as `Authorization: Bearer <token>` |
| Backend URL | `window.__APP_CONFIG__.SUPABASE_URL` | `window.__APP_CONFIG__.BASE_URL` |
| Outbox flush | Supabase JS `.from(table).upsert(payloads)` | `POST /api/matches/:id/events` (batches of 50) |
| Pull-changes | Supabase PostgREST query string | `GET /api/matches?since=<ISO>` + `GET /api/matches/:id/events?since_seq=N` |
| Realtime | Supabase Realtime channels | Native WebSocket `GET /ws` with subscribe message |
| Config keys | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | `BASE_URL` |

Everything else (Dexie schema, outbox queue, retry/backoff schedule, syncStatus
indicator, voice, MediaPipe, service worker caching) is **identical** to v1.

---

## 2. Configuration

### `config.example.js` (updated)

```js
/**
 * config.example.js — Runtime configuration template
 *
 * SETUP:
 *   1. Copy this file to config.js in the repo root.
 *   2. Set BASE_URL to the URL of your Agent base server
 *      (e.g. https://cricket-scorer.up.railway.app for production,
 *       or http://localhost:8080 for local dev).
 *   3. config.js is .gitignored — never commit real values.
 *   4. Add <script src="config.js"></script> to index.html BEFORE
 *      any src/sync/ module scripts.
 */
window.__APP_CONFIG__ = {
  /** Base URL of the Agent server (no trailing slash) */
  BASE_URL: 'http://localhost:8080',
};
```

All sync modules read `window.__APP_CONFIG__.BASE_URL`.

---

## 3. Auth: Device Token

On first load, `src/sync/auth.js` does:

```js
// src/sync/auth.js  (REWRITE — replaces Supabase auth)

const TOKEN_KEY = 'cricket_device_token';

/**
 * Returns the stored device token, registering with the server if needed.
 * @returns {Promise<string>} device UUID token
 */
export async function getDeviceToken() {
  let token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;

  // First run — register with the Agent base
  const base = window.__APP_CONFIG__.BASE_URL;
  const res  = await fetch(`${base}/api/devices/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ label: navigator.userAgent.slice(0, 80) }),
  });
  if (!res.ok) throw new Error(`[auth] register failed: ${res.status}`);
  const { token: newToken } = await res.json();
  localStorage.setItem(TOKEN_KEY, newToken);
  return newToken;
}

/**
 * Returns headers required for authenticated API calls.
 * @returns {Promise<HeadersInit>}
 */
export async function authHeaders() {
  const token = await getDeviceToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}
```

---

## 4. Outbox Flush — `syncEngine.js` (rewrite)

The drain logic is unchanged structurally; only the network layer changes.

### Key differences from v1

1. **No Supabase JS client.** All calls use `fetch()` directly.
2. **Match events** are flushed via `POST /api/matches/:id/events` (bulk, up to 50).
3. **Other entities** (tournaments, teams, players, matches) are flushed via
   `POST /api/tournaments` / `POST /api/matches` (individual upserts per entity).
4. **HTTP 409** (entire batch was duplicate) → mark rows `acked`.
5. **`skipped` count in response** → mark skipped rows `acked` individually.

### Batch flush (match events)

```js
// Inside _sendMatchEventBatch(rows) in syncEngine.js

const matchId = rows[0].payload.match_id;
const payloads = rows.map(r => r.payload);
const localIds = rows.map(r => r.local_id);
const headers  = await authHeaders();
const base     = window.__APP_CONFIG__.BASE_URL;

await markRows(localIds, 'in_flight', { last_attempt_at: new Date().toISOString() });

const res = await fetch(`${base}/api/matches/${matchId}/events`, {
  method:  'POST',
  headers,
  body:    JSON.stringify(payloads),
});

if (res.ok) {
  const { inserted, skipped } = await res.json();
  // Mark all as acked (server deduplicated skipped ones silently)
  await markRows(localIds, 'acked');
} else if (res.status === 409) {
  // Full batch conflict — already on server
  await markRows(localIds, 'acked');
} else if (res.status >= 400 && res.status < 500) {
  await markRows(localIds, 'error', { last_attempt_at: new Date().toISOString() });
} else {
  await _handleTransientError(rows, `HTTP ${res.status}`);
}
```

### Other entity upserts (tournaments, teams, players, matches)

```js
async function _sendEntityUpsert(entityType, row) {
  const tableMap = {
    tournament: 'tournaments',
    match:      'matches',
    team:       'teams',   // future
    player:     'players', // future
  };
  const path    = `/api/${tableMap[entityType]}`;
  const headers = await authHeaders();
  const base    = window.__APP_CONFIG__.BASE_URL;

  const res = await fetch(`${base}${path}`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(row.payload),
  });
  // Same status handling as match event batch above
}
```

---

## 5. Pull-Changes on Start and Focus

Called from `startSyncEngine()` immediately on load, and on `visibilitychange`
when the page becomes visible.

```js
// src/sync/syncEngine.js — _pullChanges()

export async function pullChanges() {
  const headers = await authHeaders();
  const base    = window.__APP_CONFIG__.BASE_URL;

  // 1. Pull updated matches
  const lastSync = localStorage.getItem('last_sync_ts') ?? '1970-01-01T00:00:00Z';
  const matchRes = await fetch(`${base}/api/matches?since=${encodeURIComponent(lastSync)}`, { headers });
  if (!matchRes.ok) return;
  const matches  = await matchRes.json();

  for (const match of matches) {
    await db.matches.put(match);       // Dexie upsert (no outbox append — server is source of truth for pulled data)

    // 2. Pull events for each active/in-progress match
    const lastSeq  = await _getLastKnownSeq(match.id);
    const evtRes   = await fetch(
      `${base}/api/matches/${match.id}/events?since_seq=${lastSeq}`, { headers }
    );
    if (!evtRes.ok) continue;
    const events   = await evtRes.json();
    for (const evt of events) {
      await db.match_events.put(evt);
    }
  }

  localStorage.setItem('last_sync_ts', new Date().toISOString());
}

async function _getLastKnownSeq(matchId) {
  const last = await db.match_events
    .where('match_id').equals(matchId)
    .reverse().first();
  return last?.seq ?? 0;
}
```

**Trigger points:**

```js
// In startSyncEngine():
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    pullChanges().catch(console.error);
  }
});
window.addEventListener('app:online', () => pullChanges().catch(console.error));
```

---

## 6. Live Mode — WebSocket

When the app is online and a match is active (spectator or active scorer),
the PWA opens a WebSocket to the Agent base and subscribes to the match room.

```js
// src/sync/realtime.js  (REWRITE — replaces Supabase Realtime)

let _ws = null;
let _currentMatchId = null;

/**
 * Subscribe to live events for a match.
 * @param {string} matchId
 */
export function subscribeToMatch(matchId) {
  if (_currentMatchId === matchId && _ws?.readyState === WebSocket.OPEN) return;
  unsubscribeFromMatch();

  const base = (window.__APP_CONFIG__.BASE_URL ?? '').replace(/^http/, 'ws');
  _ws = new WebSocket(`${base}/ws`);
  _currentMatchId = matchId;

  _ws.addEventListener('open', () => {
    _ws.send(JSON.stringify({ type: 'subscribe', match_id: matchId }));
    console.debug('[realtime] subscribed to match', matchId);
  });

  _ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'match_event') return;

    // Apply incoming event to local Dexie (read-only spectator path)
    const evt = msg.event;
    db.match_events.put(evt).then(() => {
      window.dispatchEvent(
        new CustomEvent('realtime:match_event', { detail: evt, bubbles: false })
      );
    });
  });

  _ws.addEventListener('close', () => {
    console.debug('[realtime] WebSocket closed for match', matchId);
    _ws = null;
  });

  _ws.addEventListener('error', (err) => {
    console.error('[realtime] WebSocket error', err);
  });
}

export function unsubscribeFromMatch() {
  if (_ws) {
    if (_ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: 'unsubscribe', match_id: _currentMatchId }));
    }
    _ws.close();
    _ws = null;
  }
  _currentMatchId = null;
}

export function isRealtimeActive() {
  return _ws !== null && _ws.readyState === WebSocket.OPEN;
}
```

**Important:** When the *owner* device scores a ball, it does **not** apply
the incoming WS event again (it already applied it locally). The device must
check `msg.match_id` against `store.match.id` and skip events whose `seq`
is already in local Dexie.

---

## 7. Service Worker Cache — Updated Cache Names

The `supabase-api-v1` cache bucket is replaced with `base-api-v1`.

```js
// sw.js  — updated cache strategy

const CACHES = {
  shell:      'app-shell-v2',
  mediapipe:  'vendor-mediapipe-v1',  // unchanged
  baseApi:    'base-api-v1',          // was: supabase-api-v1
  voskModel:  'vosk-model-v1',        // unchanged (user-initiated)
};

// Network-first for API calls, fallback to cache for GET requests
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const base = self.__APP_CONFIG__?.BASE_URL ?? '';

  if (url.href.startsWith(base + '/api/') && e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHES.baseApi).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // ... rest of SW strategies unchanged
});
```

---

## 8. Files to MODIFY in Agent-Mobile

| File | Action | What changes |
|------|--------|-------------|
| `config.example.js` | **REWRITE** | Replace `SUPABASE_URL` + `SUPABASE_ANON_KEY` with `BASE_URL` |
| `src/sync/auth.js` | **REWRITE** | Remove Supabase Auth; implement device-token registration (see §3) |
| `src/sync/supabaseClient.js` | **DELETE** | No longer needed |
| `src/sync/syncEngine.js` | **REWRITE** | Replace Supabase upsert calls with `fetch()` to Agent REST API (see §4) |
| `src/sync/realtime.js` | **REWRITE** | Replace Supabase Realtime with native WebSocket (see §6) |
| `sw.js` | **MODIFY** | Rename `supabase-api-v1` cache → `base-api-v1`; update URL pattern match |
| `supabase/README.md` | **RENAME → `docs/BACKEND_SETUP.md`** | Update to describe Agent base setup instead of Supabase setup |

## 9. Files to DELETE from Agent-Mobile

| File | Reason |
|------|--------|
| `src/sync/supabaseClient.js` | Replaced by plain `fetch()` calls in syncEngine.js |
| `supabase/migrations/0001_init.sql` | Schema now lives in Agent repo (`migrations/0001_init.sql`) |
| `supabase/policies.sql` | RLS policies removed; auth is device-token-based in app layer |
| `supabase/README.md` | Superseded by `docs/BACKEND_SETUP.md` |

> Note: The entire `supabase/` directory can be removed. Keep `src/sync/_stub.js`
> and `src/sync/outbox.js` unchanged — they have no Supabase dependency.

---

## 10. Files UNCHANGED

All of the following are **not touched** by this pivot:

- `src/storage/db.js` — Dexie schema is identical
- `src/storage/matchRepo.js`, `tournamentRepo.js`
- `src/sync/outbox.js` — queue mechanics unchanged
- `src/sync/syncStatus.js`
- `src/scoring/engine.js`, `commands.js`
- `src/state/store.js`
- `src/ui/**`
- `src/voice/**`
- `src/vendor/**` (MediaPipe, Vosk)
- `manifest.json`, `index.html`, `styles.css`
- `sw.js` (minor cache name rename only — not a logic change)

---

## 11. Smoke Tests for PWA ↔ Agent Base Sync

| # | Scenario | Pass condition |
|---|----------|---------------|
| 1 | Fresh install (no `device_token` in localStorage) | Token auto-registered; `localStorage.cricket_device_token` is a UUID |
| 2 | Score 6 balls offline | Dexie `outbox` has 6 `pending` rows; sync icon shows "Pending 6" |
| 3 | Come online | Outbox drains; Agent Postgres `match_events` has 6 rows; sync icon shows "Synced" |
| 4 | Retry (re-send same 6 events) | Server returns `{ inserted: 0, skipped: 6 }`; outbox rows marked `acked` (no duplicates in DB) |
| 5 | Second device opens same match URL | `GET /api/matches/:id/events?since_seq=0` returns all 6 events; scoreboard reflects them |
| 6 | WS spectator | Second device subscribes via WS; first device scores ball 7; second device's `realtime:match_event` fires < 100 ms after POST |
| 7 | Non-owner tries to POST events | HTTP 403; event not written to DB |
| 8 | App goes to background and returns | `visibilitychange` triggers `pullChanges()`; any server-side events since last visit appear in Dexie |
| 9 | Offline for 2 hours, then online | All queued events flush in order; `seq` values are contiguous; no gaps in scorebook |
| 10 | WebSocket drops mid-match | `ws.addEventListener('close')` fires; no crash; reconnect on next `subscribeToMatch()` call |
