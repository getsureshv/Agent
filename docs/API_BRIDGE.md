# API Bridge — Design Document

> **File:** `api-bridge.js`  
> **Loaded:** Before `app.js` via a single `<script>` tag in `index.html`.  
> **Goal:** Allow the existing browser scoring app (`app.js`) to silently
> share match data with the REST + WebSocket API so that browser users and
> PWA (Agent-Mobile) users see the same live data — without touching `app.js`.

---

## 1. Core Approach: Wrap localStorage

`app.js` is a ~3,000-line self-contained IIFE that never exports anything and
uses `localStorage` directly for all persistence. The bridge intercepts writes
at the `localStorage.setItem` layer.

**Before `app.js` executes**, `api-bridge.js`:

1. Captures references to the native `localStorage.setItem`,
   `localStorage.getItem`, and `localStorage.removeItem` methods.
2. Replaces them (via `Object.defineProperty`) with thin wrappers that:
   - **Always call the original method first** (so `app.js` never notices any
     change in behaviour).
   - After the native write, check whether the key matches the `cricket_*`
     pattern and, if so, schedule a debounced API push.

This is zero-risk: every write to localStorage still completes synchronously and
correctly. The API push is best-effort and async. Any network failure is silently
caught and degrades to localStorage-only mode (existing behaviour).

---

## 2. Intercepted localStorage Keys

| Key pattern | Trigger | API action |
|---|---|---|
| `cricket_match_quick` | `saveMatchState()` writes a quick match | `POST /api/matches` (upsert) + `POST /api/matches/:id/events` (new balls) |
| `cricket_match_<tournamentName>_<fixtureIndex>` | `saveMatchState()` writes a tournament match | Same as above |
| `cricket_tournaments` | `saveTournament()` or fixture delete writes the list | `POST /api/tournaments` for each tournament in the list (upsert) |
| `cricket_seq_<matchId>` | Internal bridge counter | **Not forwarded** — bridge-private key used to track which ball events have already been uploaded, preventing double-POSTs |
| `cricket_device_token` | Bridge startup | **Not forwarded** — stores the Bearer token returned by `POST /api/devices/register` |
| `cricket_last_sync` | Bridge startup / after every successful pull | **Not forwarded** — ISO timestamp used as the `since` parameter for `GET /api/matches?since=…` |

Any key **not** in this list (including future keys that don't start with
`cricket_`) passes through without any API action.

---

## 3. Debounce Strategy

`app.js` calls `saveMatchState()` on every ball — and `saveMatchState()` calls
`localStorage.setItem` once per call. However, auxiliary code paths (e.g. the
undo handler, the "change bowler" prompt) can also trigger saves in rapid
succession during the same logical user action.

The bridge uses a **200 ms debounce per key**: each `setItem` call resets the
timer for that key. Only the write that is followed by 200 ms of silence
actually fires the API POST. If `app.js` writes the same match key 50 times in
a burst, only **one** `POST /api/matches` goes out.

```
localStorage.setItem(key, value)   ← called by app.js
  → _nativeSetItem(key, value)     ← always runs synchronously
  → debounceSync(key, fn)          ← resets 200 ms timer for `key`
       200 ms later (if no new write):
         syncMatchKey(key)          ← one API POST fires
```

---

## 4. Match ID Injection

`app.js`'s match objects have no `id` field. The bridge injects a UUIDv4 into
`data.match.id` the first time it pushes a match to the server, then writes the
updated object back to localStorage via the native setter (bypassing the
override to avoid a recursive loop). All subsequent pushes for the same match
use the same UUID, making `POST /api/matches` idempotent (server upserts on
`id`).

---

## 5. Ball Event Seq Counter

`POST /api/matches/:id/events` is idempotent thanks to the server's
`UNIQUE(match_id, seq)` constraint — but the bridge avoids redundant POSTs by
tracking progress in `localStorage` key `cricket_seq_<matchId>`. Only balls
whose `_seq > lastSeq` are included in each batch POST. After a successful
POST, `lastSeq` is updated to the highest `seq` in the batch.

Ball events in `app.js` live in `inn.thisOver[]` and `inn.lastOver[]`. The
bridge tags each ball object with `_seq` (an auto-incrementing integer) and
`_eventId` (a UUID) the first time it sees a ball without those fields, then
writes the tagged state back before POSTing.

---

## 6. Pull-on-Startup: Server → localStorage Hydration

On startup, the bridge calls:

1. `GET /api/tournaments` — merges server tournaments into `cricket_tournaments`.
   Server data wins only when `tournament.updated_at` is strictly newer than
   the local object's `updated_at`. Local-only tournaments are never deleted.

2. `GET /api/matches?since=<cricket_last_sync>` — merges each returned match
   into the corresponding local key. The key-to-match mapping is discovered by
   reading all known tournament fixture indices. Again, server wins only if its
   `updated_at > localMatch.updated_at`. If no local key exists for a quick
   match, the server's copy is written to `cricket_match_quick`.

This ensures:
- Devices that go offline and score locally catch up when reconnected.
- A freshly opened browser tab sees the latest data immediately (before
  `app.js` runs its own `loadSavedTournaments()`).

---

## 7. WebSocket — Live Merge

### Subscription lifecycle

A background interval (5 s) checks which match is currently active (an
in-progress innings in localStorage). When an active match is detected, the
bridge opens a WebSocket to `/ws` and sends:

```json
{ "type": "subscribe", "match_id": "<UUID>" }
```

When the match ends (all innings complete) or no active match is found, the
bridge sends `{ "type": "unsubscribe" }` and closes the socket.

### Incoming event handling

When the server pushes:

```json
{ "type": "match_event", "match_id": "<UUID>", "event": { … } }
```

The bridge:

1. Locates the local match key for that `match_id`.
2. Checks the event's `seq` against `cricket_seq_<matchId>` — skips if
   already processed.
3. Appends the ball object to `inn.thisOver[]` in the local match data.
4. Writes the updated match data back to localStorage via the **native** setter
   (bypassing the override so no recursive push is triggered).
5. Updates `cricket_seq_<matchId>`.
6. Dispatches a `cricket:remoteUpdate` CustomEvent on `window`.

### Re-render trigger in app.js

`app.js`'s `updateDisplay()` function lives inside a closed IIFE and is **not**
exported. The re-render pathway used by the bridge is:

> `window.dispatchEvent(new CustomEvent('cricket:remoteUpdate', { detail: { matchId, event } }))`

`api-bridge.js` listens for this event and calls
`window.__cricketBridgeRerender(detail)` if that global was registered. A
companion snippet (to be added by integrators if full live-scoring is needed)
can register:

```js
window.__cricketBridgeRerender = function (detail) {
  // updateDisplay() is called automatically by saveMatchState() which is
  // triggered by any future user interaction.  For immediate re-render,
  // simulate a storage change notification or a lightweight DOM mutation.
};
```

For the v1 "viewer" use case (a spectator watching a live match on a second
device), the merged localStorage is sufficient: the next time the user
interacts with the app, `updateDisplay()` will pick up the merged state.
For live-update without user interaction, the bridge fires a storage event
which may be observed by future extensions.

---

## 8. Status Indicator

A small fixed-position `<div id="cricket-bridge-status">` is appended to
`document.body`. It uses only **inline styles** (no changes to `styles.css`)
and shows:

| State | Label | When |
|---|---|---|
| `synced` | 🟢 Synced | Last push succeeded; no queue |
| `pending` | 🟡 N pending | Active API calls in flight |
| `offline` | ⚪ Offline | Server unreachable or device not yet registered |
| `error` | 🔴 Error | 403 ownership conflict or unrecoverable failure |

The indicator also dispatches `window.dispatchEvent(new CustomEvent('sync:state', { detail: { state, pending } }))` — the same event name used by the PWA's sync engine, for consistency.

---

## 9. Offline / Fallback Behaviour

Every `fetch()` call in the bridge is wrapped in a `.catch()` that silently
discards the error. If the server is unreachable:

- `setItem` writes still go to localStorage (the native call runs first).
- The debounce timer fires, the fetch fails, and `_pendingCount` is
  decremented; the indicator shows ⚪ Offline.
- No exceptions propagate to `app.js`.
- On the next call that succeeds, normal operation resumes.

This means the bridge is **strictly additive**: losing the server is equivalent
to running the original app without the bridge.

---

## 10. Known Limitations

### Two simultaneous scorers on the same match

The server uses a **per-match owner lock** (`matches.owner_token`). The first
device to `POST /api/matches` for a given `match_id` becomes the owner. Any
subsequent device that attempts `POST /api/matches/:id/events` for that match
receives HTTP 403.

The bridge detects the 403 and:
- Sets the status indicator to 🔴 Error with tooltip "Match owned by another
  device — read-only".
- Dispatches `sync:state` with `state: 'error'`.
- Stops retrying writes for that match.

The non-owner device can still **read** events via WebSocket and GET endpoints,
but its local scoring cannot be pushed to the server. The UI shows the 🔴
indicator; there is currently no in-app warning dialog (that would require
modifying `app.js`).

### Ball event seq tags not present in existing matches

The bridge tags ball objects with `_seq` on first sync. Existing in-progress
matches that were saved before the bridge was loaded will have no `_seq` values.
On the first push, the bridge will POST zero events (no events with `_seq >
lastSeq=0` since none have `_seq` at all). A future migration pass could
retroactively tag balls by reading `inn.thisOver`, `inn.lastOver`, and batsman
`ballHistory` arrays in sequential order.

### Tournament match key discovery

Tournament match keys are derived from `cricket_tournaments` at the time of a
pull. If a tournament was created before the bridge ran, or if a tournament's
`name` changes, the bridge may not find the corresponding match key during
hydration. The data is safe (still in localStorage) but the server → local
merge for that match will not trigger.

### No hard delete

When `app.js` calls `localStorage.removeItem('cricket_match_quick')`, the
bridge intercepts but takes no server-side action (there is no DELETE endpoint
for matches in v1). The match record remains in Postgres. This is acceptable
for v1; a DELETE /api/matches/:id endpoint could be added in v2.

### WebSocket re-render is eventually consistent

Because `app.js`'s `updateDisplay()` is not directly callable from outside the
IIFE, a WebSocket-pushed event is merged into localStorage but the DOM is not
immediately updated. The next user interaction (tap, button press) will call
`updateDisplay()` via the normal code path and pick up the merged state. For
live spectator views, this is sufficient; for active co-scoring, this is
blocked by the ownership lock anyway.
