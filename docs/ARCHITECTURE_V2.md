# Cricket Scorer — Server Architecture v2

> **Repo:** https://github.com/getsureshv/Agent  
> **Role:** Always-on base server. Hosts the scoring UI, owns the Postgres
> database, and syncs with the Agent-Mobile PWA.  
> **Supabase:** Removed entirely. All backend is self-hosted on Railway.

---

## 1. Hosting Decision: Railway (chosen) vs Render

| # | Factor | Railway | Render |
|---|--------|---------|--------|
| 1 | **Cold starts** | No sleep on the $5/mo Starter plan — process stays warm 24/7. Essential for live scoring where a delayed first response would corrupt a match in progress. | Free tier sleeps after 15 min of inactivity. A scorer mid-match would hit a 30-60 s cold start on the next ball. |
| 2 | **Cost** | $5/mo credit covers ~500 compute hours/mo on a 512 MB instance — sufficient for a low-traffic scoring app. | Free tier is $0 but sleeping; paid plans start at $7/mo with no credits. |
| 3 | **Managed Postgres** | One-click Postgres plugin with automatic backups, point-in-time restore, and connection pooling. Provisioned in the same project. | Postgres add-on available but requires separate billing; slightly more setup. |
| 4 | **WebSocket support** | Full WebSocket (and HTTP/2) pass-through out of the box; no extra config. | WebSocket is supported but requires `Upgrade` header allowlist in the Render service settings. |
| 5 | **Vanilla Node deploy** | Push-to-deploy from a `railway.json` + `Dockerfile`; zero framework magic. Works perfectly with a plain `node server.js` entry point. | Equally simple, but Railway's CLI (`railway up`) gives a faster dev loop. |

**Decision: Railway.**  
The always-on guarantee and bundled Postgres credit make it the correct choice
for a live-scoring use case where downtime during a match is unacceptable.

---

## 2. Server Stack

```
Node.js 20 LTS
  └── Express 4.x            — HTTP router (no bundler, no transpiler)
  └── ws 8.x                 — WebSocket server, mounted on the same HTTP server
  └── pg 8.x                 — node-postgres (raw SQL, no ORM)
  └── express-basic-auth     — admin wipe endpoint (/admin/wipe)
Static files                 — express.static('.')  serves index.html, app.js, styles.css
Postgres                     — Railway managed, one connection pool (pg.Pool)
Migrations                   — run on boot from migrations/*.sql via node-postgres
```

**No bundler.** The existing `index.html` + `app.js` + `styles.css` are served
as-is. `server.js` just adds `app.use(express.static(__dirname))` in front of
all API routes.

---

## 3. Database Schema

Mirrors the Dexie shape in Agent-Mobile so PWA outbox payloads map 1:1 with
no field renaming.

```sql
-- ── Extensions ──────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Device tokens (auth) ────────────────────────────────────────────
-- No user accounts for v1. Each device self-registers and gets a UUID token.
CREATE TABLE IF NOT EXISTS device_tokens (
  token       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  label       TEXT,                          -- e.g. "iPhone 13 – Suresh"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tournaments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
  id                UUID        PRIMARY KEY,   -- client-generated UUIDv4
  owner_token       UUID        NOT NULL REFERENCES device_tokens(token),
  name              TEXT        NOT NULL,
  format            TEXT        NOT NULL CHECK (format IN ('league','knockout')),
  overs_per_innings INT         NOT NULL DEFAULT 10,
  players_per_team  INT         NOT NULL DEFAULT 11,
  squad_size        INT         NOT NULL DEFAULT 15,
  status            TEXT        NOT NULL DEFAULT 'setup'
                                CHECK (status IN ('setup','active','completed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tournaments_owner_token_idx ON tournaments(owner_token);
CREATE INDEX IF NOT EXISTS tournaments_updated_at_idx  ON tournaments(updated_at);

-- ── Teams ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id            UUID        PRIMARY KEY,
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS teams_tournament_id_idx ON teams(tournament_id);

-- ── Players ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id            UUID        PRIMARY KEY,
  team_id       UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  jersey_number INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS players_team_id_idx        ON players(team_id);
CREATE INDEX IF NOT EXISTS players_tournament_id_idx  ON players(tournament_id);

-- ── Matches ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id               UUID        PRIMARY KEY,
  tournament_id    UUID        REFERENCES tournaments(id) ON DELETE CASCADE,   -- NULL = quick match
  team1_id         UUID        REFERENCES teams(id),
  team2_id         UUID        REFERENCES teams(id),
  toss_winner_id   UUID        REFERENCES teams(id),
  toss_decision    TEXT        CHECK (toss_decision IN ('bat','bowl')),
  overs_limit      INT         NOT NULL DEFAULT 20,
  players_per_team INT         NOT NULL DEFAULT 11,
  status           TEXT        NOT NULL DEFAULT 'setup'
                               CHECK (status IN ('setup','in_progress','completed')),
  result_text      TEXT,
  winner_id        UUID        REFERENCES teams(id),
  owner_token      UUID        NOT NULL REFERENCES device_tokens(token),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS matches_owner_token_idx      ON matches(owner_token);
CREATE INDEX IF NOT EXISTS matches_tournament_id_idx    ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS matches_updated_at_idx       ON matches(updated_at);

-- ── Match Events (ball-by-ball) ──────────────────────────────────────
-- UNIQUE(match_id, seq) makes POST /api/matches/:id/events idempotent.
CREATE TABLE IF NOT EXISTS match_events (
  id             UUID     PRIMARY KEY,   -- client-generated UUIDv4
  match_id       UUID     NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_number SMALLINT NOT NULL CHECK (innings_number IN (0,1)),
  over_number    SMALLINT NOT NULL,
  ball_in_over   SMALLINT NOT NULL,
  event_type     TEXT     NOT NULL CHECK (event_type IN (
                   'runs','wide','noball','bye','legbye',
                   'wicket','innings_end','match_end'
                 )),
  runs           SMALLINT NOT NULL DEFAULT 0,
  extra_type     TEXT,
  extra_runs     SMALLINT DEFAULT 0,
  dismissal_type TEXT,
  batsman_id     UUID     REFERENCES players(id),
  bowler_id      UUID     REFERENCES players(id),
  fielder_id     UUID     REFERENCES players(id),
  seq            INT      NOT NULL,      -- per-match monotone; 1:1 with Dexie match_events.seq
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT match_events_match_id_seq_unique UNIQUE (match_id, seq)
);

CREATE INDEX IF NOT EXISTS match_events_match_id_seq_idx ON match_events(match_id, seq);

-- ── updated_at trigger ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tournaments_set_updated_at
  BEFORE UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER teams_set_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER players_set_updated_at
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER matches_set_updated_at
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Field alignment with Dexie (Agent-Mobile `src/storage/db.js`):**

| Dexie field | Postgres column | Notes |
|-------------|----------------|-------|
| `owner_id` (was Supabase user UUID) | `owner_token` (device UUID) | Same UUID type; auth model changed |
| `match_events.seq` | `match_events.seq` | Identical; UNIQUE constraint enforces idempotency |
| `synced_at` | — (not stored server-side) | PWA sets this locally after ACK |
| `outbox.*` | — (client-only) | Outbox lives only in Dexie |

---

## 4. REST API Contract

All routes are prefixed `/api`. The static file server catches everything else
(returns `index.html` for bare `/`, `app.js`, `styles.css`, icons, etc.).

### Authentication

Every non-health, non-static request must include:

```
Authorization: Bearer <device-token-UUID>
```

A device registers once via `POST /api/devices/register` (body: `{ label }`),
receives a UUID token, and stores it in `localStorage`. Subsequent requests
send the token as a Bearer header. The server validates the token against
`device_tokens` in Postgres.

**Admin route** (basic-auth, separate credential from device tokens):

```
DELETE /admin/wipe
  Authorization: Basic <base64(admin:ADMIN_PASSWORD)>
  — Truncates all tables. For dev/reset only.
```

### Endpoints

```
GET  /api/health
  → { status: "ok", ts: "<ISO>" }
  — No auth required. Used by Railway health checks and uptime monitors.

POST /api/devices/register
  Body:  { label?: string }
  → { token: "<UUID>" }
  — Creates a device_token row and returns the UUID. No auth required.
    Call once per new device install; store token in localStorage.

──────────────────── Tournaments ────────────────────────────────────────────

GET  /api/tournaments
  Auth: Bearer required
  → Array<Tournament>
  — Returns all tournaments owned by (or shared with) the calling device.

POST /api/tournaments
  Auth: Bearer required
  Body: Tournament (full payload, UUIDv4 id from client)
  → Tournament (as stored)
  — Upserts on id. Idempotent.

──────────────────── Matches ─────────────────────────────────────────────────

GET  /api/matches?since=<ISO-timestamp>
  Auth: Bearer required
  → Array<Match>
  — Returns matches updated after `since`. PWA uses this on startup / focus
    to pull changes. If `since` is omitted, returns all matches for the device.

POST /api/matches
  Auth: Bearer required
  Body: Match (full payload, UUIDv4 id from client)
  → Match (as stored)
  — Upserts on id. Sets owner_token from the authenticated device token.
    Returns HTTP 403 if the match id already exists and belongs to a different token.

──────────────────── Match Events ────────────────────────────────────────────

POST /api/matches/:id/events
  Auth: Bearer required
  Body: Array<MatchEvent>  (up to 50 items per batch)
  → { inserted: N, skipped: N }
  — Idempotent: uses INSERT … ON CONFLICT (match_id, seq) DO NOTHING.
    Returns HTTP 403 if the calling device is not the match owner.
    Returns HTTP 409 only if the entire batch conflicts (all duplicates).
    Broadcasts each inserted event over WebSocket to match:<id> subscribers.

GET  /api/matches/:id/events?since_seq=N
  Auth: Bearer required
  → Array<MatchEvent> ordered by seq ASC where seq > N
  — Used by PWA pull-changes on startup or reconnect.
    N defaults to 0 if omitted (returns all events for the match).
```

### Response shapes

All responses are `application/json`. Errors follow:

```json
{ "error": "human-readable message", "code": "SNAKE_CASE_CODE" }
```

HTTP status codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorized,
403 Forbidden, 404 Not Found, 409 Conflict (full duplicate batch), 500 Internal.

---

## 5. Auth Model

```
Device registration flow:
  1. On first app load, check localStorage for 'device_token'.
  2. If absent: POST /api/devices/register → receive UUID token → store in localStorage.
  3. All subsequent API calls: Authorization: Bearer <token>.

Match ownership:
  - First device to POST /api/matches for a given match id becomes the owner
    (owner_token = calling device's token).
  - POST /api/matches/:id/events: server checks matches.owner_token == calling token.
    Non-owners receive HTTP 403.
  - GET /api/matches/:id/events: any authenticated device can read.

Admin wipe:
  - Basic-auth credentials set via ADMIN_PASSWORD env var on Railway.
  - DELETE /admin/wipe truncates all tables (tournaments, teams, players, matches,
    match_events; device_tokens kept). Used for dev resets.
```

No user accounts, no JWTs, no email flows for v1.

---

## 6. WebSocket — Live Spectator

```
GET /ws  (HTTP Upgrade to WebSocket)
  — No auth on the upgrade handshake (read-only spectator; writes go through REST).
  — After connecting, client sends a subscription message:
      { "type": "subscribe", "match_id": "<UUID>" }
  — Server adds the socket to the room set for that match_id.

Server → client push (on each successful POST /api/matches/:id/events):
  { "type": "match_event", "match_id": "<UUID>", "event": <MatchEvent> }

Unsubscribe (client disconnects or sends):
  { "type": "unsubscribe", "match_id": "<UUID>" }

Ping/pong: handled by the ws library's built-in heartbeat (30 s interval).
```

**Implementation:**

```js
// server.js (excerpt)
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ server: httpServer });
const rooms = new Map(); // match_id → Set<WebSocket>

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'subscribe') {
      if (!rooms.has(msg.match_id)) rooms.set(msg.match_id, new Set());
      rooms.get(msg.match_id).add(ws);
      ws._subscribedMatch = msg.match_id;
    }
    if (msg.type === 'unsubscribe') {
      rooms.get(msg.match_id)?.delete(ws);
    }
  });
  ws.on('close', () => {
    if (ws._subscribedMatch) rooms.get(ws._subscribedMatch)?.delete(ws);
  });
});

export function broadcast(matchId, event) {
  const sockets = rooms.get(matchId);
  if (!sockets) return;
  const payload = JSON.stringify({ type: 'match_event', match_id: matchId, event });
  for (const s of sockets) {
    if (s.readyState === 1 /* OPEN */) s.send(payload);
  }
}
```

---

## 7. Conflict Resolution

**Model: per-match owner lock (v1).**

- `matches.owner_token` is set on the first POST for a given match id.
- Only that device can write `match_events` for the match (HTTP 403 otherwise).
- Any device can read events at any time.
- If a device retries a batch of events, `INSERT … ON CONFLICT (match_id, seq) DO NOTHING`
  silently deduplicates. The response includes `{ skipped: N }` so the client
  can mark those outbox rows as `acked` without re-sending.
- No vector clocks, no CRDTs. One scorer per match is the correct invariant
  for real cricket — more complex models are not needed for v1.

---

## 8. Deployment — Railway

### File: `railway.json`

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 15,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### File: `Dockerfile`

```dockerfile
FROM node:20-alpine AS base

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source (static assets + server code)
COPY . .

EXPOSE 8080

# Migrations run at boot inside server.js before the HTTP server starts.
CMD ["node", "server.js"]
```

### Environment Variables (Railway service settings)

```
DATABASE_URL        — injected automatically by Railway Postgres plugin
PORT                — defaults to 8080 (Railway sets this automatically)
ADMIN_PASSWORD      — secret for DELETE /admin/wipe basic-auth
NODE_ENV            — "production"
```

### Migrations on boot (`db.js` excerpt)

```js
import fs   from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';

export async function runMigrations() {
  const dir = path.join(import.meta.dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    console.log('[migrate] applied', file);
  }
}
```

Called as `await runMigrations()` before `httpServer.listen(port)` in `server.js`.

---

## 9. Project File Tree (additions to Agent repo)

```
Agent/
├── index.html          ← unchanged (served as static)
├── app.js              ← unchanged
├── styles.css          ← unchanged
├── exam.pdf            ← unchanged
├── exam2.pdf           ← unchanged
│
├── server.js           ← NEW — Express + WebSocket server entry point
├── db.js               ← NEW — pg.Pool singleton + runMigrations()
├── routes/
│   ├── health.js       ← NEW — GET /api/health
│   ├── devices.js      ← NEW — POST /api/devices/register
│   ├── tournaments.js  ← NEW — GET/POST /api/tournaments
│   ├── matches.js      ← NEW — GET/POST /api/matches
│   └── events.js       ← NEW — POST & GET /api/matches/:id/events
├── middleware/
│   └── auth.js         ← NEW — Bearer token validation middleware
├── ws.js               ← NEW — WebSocket server + broadcast()
├── migrations/
│   └── 0001_init.sql   ← NEW — schema from §3 above
├── package.json        ← NEW
├── package-lock.json   ← NEW (after npm install)
├── Dockerfile          ← NEW
├── railway.json        ← NEW
├── .gitignore          ← NEW (node_modules, .env)
│
└── docs/
    └── ARCHITECTURE_V2.md   ← this file
```

---

## 10. `package.json`

```json
{
  "name": "cricket-scorer-server",
  "version": "2.0.0",
  "type": "module",
  "main": "server.js",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "dev":   "node --watch server.js"
  },
  "dependencies": {
    "express":            "^4.19.2",
    "express-basic-auth": "^1.2.1",
    "pg":                 "^8.12.0",
    "ws":                 "^8.17.0"
  }
}
```

---

## 11. Smoke-Test Plan (server standalone)

| # | Test | Pass condition |
|---|------|---------------|
| 1 | `GET /api/health` | `{ status: "ok" }` within 200 ms |
| 2 | `POST /api/devices/register` | Returns `{ token: "<UUID>" }` |
| 3 | `POST /api/tournaments` with Bearer | Row appears in Postgres `tournaments` table |
| 4 | `POST /api/matches` with Bearer | Row in `matches`; `owner_token` matches registering device |
| 5 | `POST /api/matches/:id/events` (10 events) | `{ inserted: 10, skipped: 0 }` |
| 6 | Repeat step 5 | `{ inserted: 0, skipped: 10 }` (idempotency) |
| 7 | WebSocket connect + subscribe | Server logs new subscriber |
| 8 | Score a ball (step 5) while WS open | Client receives `match_event` push within 50 ms |
| 9 | Non-owner device tries `POST /api/matches/:id/events` | HTTP 403 |
| 10 | `GET /api/matches/:id/events?since_seq=5` | Returns only events with seq > 5 |
