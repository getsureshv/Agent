# Backend Setup — Wiring the PWA to Your Agent Base Server

This guide explains how to connect the Cricket Scorer PWA to your self-hosted
Agent base server (Node.js + Postgres, deployed on Railway or any other host).

---

## Prerequisites

- The Agent base server is deployed and running.
  - Railway: your app URL looks like `https://cricket-scorer.up.railway.app`
  - Local dev: typically `http://localhost:8080`
- You have cloned this repository locally.

---

## One-Time Setup

### 1. Copy the config template

```bash
cp config.example.js config.js
```

`config.js` is listed in `.gitignore` — it will never be committed.

### 2. Set your BASE_URL

Open `config.js` and paste in your Railway (or local) URL:

```js
window.__APP_CONFIG__ = {
  BASE_URL: 'https://cricket-scorer.up.railway.app',  // ← your real URL
};
```

No trailing slash.

### 3. That's it

The PWA reads `window.__APP_CONFIG__.BASE_URL` at runtime.  
On the **first API call from any device**, `src/sync/auth.js` will:

1. POST `/api/devices/register` with the device's User-Agent label.
2. Receive a UUID device token from the server.
3. Persist it in `localStorage` as `cricket_device_token`.

All subsequent API calls include `Authorization: Bearer <token>` automatically.
No manual registration, no email magic links, no passwords.

---

## How Sync Works

| Step | What happens |
|------|--------------|
| **App start** | `startSyncEngine()` calls `pullChanges()` — fetches match list since last sync and any new events for each match |
| **Scoring** | Each ball is appended to Dexie's `outbox` table via `appendToOutbox()` |
| **Drain** | `drainOutbox()` batches up to 50 events and POSTs to `/api/matches/:id/events` with the device token |
| **Conflict** | HTTP 409 → row marked `acked` (server already has it — safe to ignore) |
| **Not owner** | HTTP 403 → row marked `permanent_error` (only the match owner may write events) |
| **Tab focus / reconnect** | `pullChanges()` fires again to catch up on any remote changes |
| **Live spectator** | `connectMatchSocket(matchId)` opens a WebSocket to `/ws` and receives server-pushed events in real time |

---

## Retry / Backoff Schedule

If the network is unavailable or the server returns a 5xx error, the sync
engine retries with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | immediate |
| 2 | 5 s |
| 3 | 30 s |
| 4 | 5 min |
| 5+ | 30 min (capped) |

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Sync icon stuck on "Pending" | Is `config.js` present and `BASE_URL` correct? Open DevTools → Network and look for failed `/api/` requests. |
| 401 Unauthorized | The device token may be missing. Clear `localStorage` and reload — auto-registration will run again. |
| 403 on event POST | You are trying to write to a match you do not own. Only the device that created the match can score it. |
| WebSocket never connects | Check that your server supports WebSocket upgrades. On Railway, ensure the deployment is not behind a proxy that strips `Upgrade` headers. |
| Events visible on device A but not B | Device B may not have pulled yet. Go to background and return to trigger `pullChanges()`, or call `forceDrain()` from the console. |

---

## Server API Reference (brief)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/devices/register` | POST | Auto-register device, returns `{ token }` |
| `/api/matches` | GET | List matches updated since `?since=<ISO>` |
| `/api/matches` | POST | Create / upsert a match |
| `/api/matches/:id/events` | GET | Fetch events for a match since `?since_seq=<N>` |
| `/api/matches/:id/events` | POST | Bulk-append events (array payload, up to 50) |
| `/api/tournaments` | POST | Create / upsert a tournament |
| `/ws` | WebSocket | Real-time event stream; send `{ type: "subscribe", match_id }` after open |

Full API spec lives in the Agent server repo (`docs/API.md`).
