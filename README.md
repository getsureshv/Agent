# Cricket Scorer — Agent Server

Always-on Node.js server hosted on Railway. Serves the scoring UI (static files) and provides a REST + WebSocket API backed by Postgres.

See [`docs/ARCHITECTURE_V2.md`](docs/ARCHITECTURE_V2.md) for full design rationale.

---

## How to Run Locally

### Option A — Docker Compose (recommended)

```bash
# 1. Start Postgres in Docker
docker run -d --name pg-cric \
  -e POSTGRES_PASSWORD=dev \
  -p 5432:5432 \
  postgres:16

# 2. Install dependencies
npm install

# 3. Copy env and set DATABASE_URL
cp .env.example .env
# Edit .env: DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres

# 4. Start the server (migrations run automatically at boot)
npm start
```

### Option B — Direct npm install + DATABASE_URL

```bash
npm install
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres npm start
```

Server starts on <http://localhost:3000>.

### Verify

```bash
# Health check
curl localhost:3000/api/health
# → { "ok": true, "db": "connected", ... }

# Static frontend
curl localhost:3000/
# → returns index.html

# Register a device
curl -s -X POST localhost:3000/api/devices/register \
  -H "Content-Type: application/json" \
  -d '{"label":"My Device"}' | jq .
# → { "token": "<UUID>", ... }

# Create a tournament (replace TOKEN with the UUID above)
curl -s -X POST localhost:3000/api/tournaments \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"<UUIDv4>","name":"Test Cup","format":"league"}' | jq .
```

---

## How to Deploy to Railway

### Prerequisites
- [Railway CLI](https://docs.railway.app/develop/cli): `npm i -g @railway/cli`
- A Railway account at https://railway.app

### Steps

```bash
# 1. Authenticate
railway login

# 2. Initialize a new Railway project (run once, from repo root)
railway init

# 3. Add a managed Postgres database
railway add --plugin postgresql

# 4. Deploy (builds via Dockerfile, streams logs)
railway up

# 5. (Optional) Open the deployed service in browser
railway open
```

Railway automatically:
- Injects `DATABASE_URL` from the Postgres plugin
- Sets `PORT` (your server reads `process.env.PORT`)
- Runs the health check at `/api/health`

### Environment Variables to set in Railway dashboard

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `ADMIN_PASSWORD` | a strong secret string |

`DATABASE_URL` and `PORT` are injected automatically.

---

## API Reference

All `/api/*` routes return `application/json`.  
Authentication: `Authorization: Bearer <device-token-UUID>` (except health and device register).

Error shape: `{ "error": "message", "code": "SNAKE_CASE" }`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | None | Health check with DB ping. Returns `{ ok, db, version, ts }` |
| `POST` | `/api/devices/register` | None | Register device, get UUID token. Body: `{ label? }` → `{ token }` |
| `GET` | `/api/tournaments` | Bearer | List tournaments owned by calling device |
| `POST` | `/api/tournaments` | Bearer | Upsert tournament (client-generated UUID id). Body: `Tournament` |
| `GET` | `/api/matches?since=<ISO>` | Bearer | Matches updated after `since` (all if omitted) |
| `POST` | `/api/matches` | Bearer | Upsert match. Sets `owner_token`. Body: `Match` |
| `GET` | `/api/matches/:id/events?since_seq=N` | Bearer | Events for match with `seq > N` (default 0) |
| `POST` | `/api/matches/:id/events` | Bearer (owner only) | Insert batch of events. Body: `MatchEvent[]` → `{ inserted, skipped }` |
| `DELETE` | `/admin/wipe` | Basic-auth | Truncate all data tables (dev reset). Requires `ADMIN_PASSWORD`. |

### WebSocket

Connect to `ws://<host>/ws` (no auth on upgrade — read-only spectator).

**Subscribe to a match:**
```json
{ "type": "subscribe", "match_id": "<UUID>" }
```

**Server pushes on each new event:**
```json
{ "type": "match_event", "match_id": "<UUID>", "event": { ... } }
```

**Unsubscribe:**
```json
{ "type": "unsubscribe", "match_id": "<UUID>" }
```

---

## Project Structure

```
Agent/
├── server.js              # Main entry: Express + WebSocket + static serving
├── db.js                  # pg.Pool singleton + runMigrations()
├── ws.js                  # WebSocket server + broadcast() helper
├── routes/
│   ├── health.js          # GET /api/health
│   ├── devices.js         # POST /api/devices/register
│   ├── tournaments.js     # GET/POST /api/tournaments
│   └── matches.js         # GET/POST /api/matches + events sub-routes
├── middleware/
│   └── auth.js            # Bearer token validation
├── migrations/
│   ├── run.js             # Standalone migration runner
│   └── 0001_init.sql      # Full Postgres schema
├── tests/
│   └── api.test.js        # Documented curl smoke tests
├── Dockerfile             # node:20-alpine production image
├── railway.json           # Railway deployment config
├── .env.example           # Environment variable template
└── docs/
    └── ARCHITECTURE_V2.md # Full server architecture spec
```
