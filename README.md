# Cricket Scorer — Agent Server

Always-on Node.js server hosted on Render. Serves the scoring UI (static files) and provides a REST + WebSocket API backed by Postgres.

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

## How to Deploy to Render

This repo includes a `render.yaml` Blueprint that provisions both the web service and a managed Postgres database in one step.

SSL/HTTPS is automatic on Render — your service gets a free `.onrender.com` TLS certificate. Custom domains are optional.

### Option A — One-Click via Blueprint (Recommended)

1. Push `render.yaml` to your GitHub repo (already done by this PR).
2. Go to [https://dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
3. Connect the `getsureshv/Agent` GitHub repo.
4. Render auto-detects `render.yaml` and shows a preview: `cricket-scorer` web service + `cricket-db` Postgres.
5. Click **Apply** — both services are created automatically.
6. After creation, go to **cricket-scorer → Environment** and set `ADMIN_PASSWORD` to a strong secret (it is intentionally not committed to the repo).
7. Wait ~5 minutes for the first build. Migrations run automatically at boot — no separate migrate step needed.
8. Visit your `.onrender.com` URL — you should see the Cricket Scoring UI.
9. Verify: `curl https://<your-service>.onrender.com/api/health` → `{ "ok": true, "db": "connected", ... }`

### Option B — Manual Setup

1. Dashboard → **New +** → **PostgreSQL** — name it `cricket-db`, plan: Starter, region: Oregon.
2. Dashboard → **New +** → **Web Service** — connect this repo, then set:
   - **Build Command:** `npm ci`
   - **Start Command:** `node server.js`
   - **Health Check Path:** `/api/health`
   - **Plan:** Starter
3. Add environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `ADMIN_PASSWORD` | a strong secret string |
| `DATABASE_URL` | Internal Database URL from the Postgres service |

`PORT` is injected automatically by Render.

See [`docs/RENDER_DEPLOY.md`](docs/RENDER_DEPLOY.md) for the full step-by-step guide including notes on WebSocket support, cold-start behaviour, and Postgres plan recommendations.

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

### v3 API (under `/api/v3`)

The v3 stack uses session-cookie auth (`cs_session`) instead of device tokens.
Mounted alongside the legacy `/api/*` routes; both will coexist until PR 5.

**Auth** (`routes/v3_auth.js`)
- `POST /api/v3/auth/signup` body `{email, password, name?}` — first signup becomes global admin.
- `POST /api/v3/auth/login` body `{email, password}`.
- `POST /api/v3/auth/logout`.
- `GET  /api/v3/auth/me`.

**Tournaments** (`routes/v3_tournaments.js`)
- `POST   /api/v3/tournaments` (owner action; the caller becomes owner)
- `GET    /api/v3/tournaments` — tournaments I own / captain in / am scorer for
- `GET    /api/v3/tournaments/:id` — public callers see metadata only; members/owners get full row + counts
- `PATCH  /api/v3/tournaments/:id` — owner only
- `DELETE /api/v3/tournaments/:id` — owner only

**Teams** (`routes/v3_teams.js`, `routes/v3_players.js`)
- `POST   /api/v3/tournaments/:tid/teams` — owner only
- `GET    /api/v3/tournaments/:tid/teams` — **member only** (rosters are not public)
- `PATCH  /api/v3/tournaments/:tid/teams/:teamId`, `DELETE …` — owner only
- `GET    /api/v3/teams/:teamId` — member only; team detail with captain
- `GET    /api/v3/teams/:teamId/players` — member only
- `POST   /api/v3/teams/:teamId/players` — team captain OR tournament owner
- `PATCH  /api/v3/players/:id`, `DELETE /api/v3/players/:id` — team captain OR tournament owner

**Fixtures** (`routes/v3_fixtures.js`, `routes/v3_top.js`)
- `POST   /api/v3/tournaments/:tid/fixtures` — owner only
- `POST   /api/v3/tournaments/:tid/fixtures/generate?mode=add|replace` — owner only.
  In `replace` mode, fixtures with no scoring events are deleted before generating;
  played fixtures are preserved and returned in `preserved_fixtures`.
- `GET    /api/v3/tournaments/:tid/fixtures` — public if tournament is public, but
  scorer fields are stripped from anonymous responses.
- `PATCH  /api/v3/tournaments/:tid/fixtures/:fixtureId`, `DELETE …` — owner only
- `GET    /api/v3/fixtures/:id` — **member only** (full detail incl. scorer)

**Matches** (`routes/v3_top.js`)
- `GET /api/v3/matches/:id/score` — public when the tournament `is_public`,
  member-only otherwise. Returns a stub today; PR 4 fills in the projection.

**Invites** (`routes/v3_invites.js`)
- `POST   /api/v3/tournaments/:tid/invites` — owner only. Captain re-invites for a
  team auto-revoke any prior pending captain invite for that team
  (`revoked_previous` counter in the response).
- `GET    /api/v3/tournaments/:tid/invites`, `DELETE …/:inviteId` — owner only.
- `GET    /api/v3/invites/:token` — public preview. 410 if expired or revoked.
- `POST   /api/v3/invites/:token/accept` — requires auth, enforces email match,
  refuses to clobber an existing captain (409 `TEAM_HAS_CAPTAIN`). Response includes
  `redirect_to`: `/app/captain/#/dashboard` for captain invites, `/app/#/dashboard` otherwise.

**Users** (`routes/v3_users.js`)
- `GET /api/v3/users/search?q=` — prefix email match, auth required.

### Admin / Captain UIs

- **Admin SPA** at `/app/` (`public/app/`) — tournament owner / global admin.
- **Captain SPA** at `/app/captain/` (`public/app-captain/`) — team captains
  manage their roster; fixture detail shows scorer info and a Score-this-match
  button (disabled / placeholder until PR 4).
- **Invite landing** at `/invite/:token` — the admin SPA renders the accept page;
  on success, captain invites bounce the browser to `/app/captain/`.

### Email (optional)

To enable the "Send invite" button:

1. Enable 2-Step Verification on your Google account.
2. Create a Gmail App Password at https://myaccount.google.com/apppasswords (16-char).
3. In Render dashboard for the cricket-scorer service, set env vars:
   - `SMTP_USER` = your gmail address
   - `SMTP_PASS` = the 16-char app password (no spaces)
   - `SMTP_FROM_NAME` = Cricket Scorer (optional, default)
4. Trigger Manual Deploy.

If SMTP is not configured, the Send button is disabled and admins can use Copy to share the invite link manually. The admin SPA polls `GET /api/v3/config` on load to decide which UI to render.

Endpoints:

- `GET  /api/v3/config` (public) — `{ emailConfigured, publicBaseUrl }`.
- `POST /api/v3/invites/:token/email` (owner) — re-sends the invite link by email. Body `{ recipientEmail }` optionally overrides the address for this send only (does not mutate the invite row). Stamps `v3_invites.last_emailed_at`. Returns 503 if SMTP is not configured, 410 if the invite is revoked/consumed/expired.

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
├── render.yaml            # Render Blueprint (web service + Postgres)
├── .env.example           # Environment variable template
└── docs/
    └── ARCHITECTURE_V2.md # Full server architecture spec
```

---

## Dual-Mount: PWA at `/pwa` + Legacy App at `/`

This repo serves **two front-ends from one Render service**:

| Path | App | Repo |
|------|-----|------|
| `/` | Desktop cricket scoring app | this repo (legacy) |
| `/pwa` | Agent-Mobile PWA | [getsureshv/Agent-Mobile](https://github.com/getsureshv/Agent-Mobile) (git submodule at `./pwa`) |

### How it works

The Agent-Mobile repository is embedded as a **git submodule** at `./pwa`:

```
.gitmodules  ← declares the submodule
pwa/         ← checked-out Agent-Mobile source
```

`server.js` mounts the PWA in this order (Express matches top-to-bottom):

1. **API routes** (`/api/*`) — handled first, always
2. **`GET /pwa/manifest.json`** — route handler that rewrites `start_url` and `scope` to `/pwa/` and fixes root-relative icon paths before responding; must be registered _before_ the static mount so it takes precedence over the file on disk
3. **`/pwa` static mount** — `express.static('./pwa')` serves all PWA assets
4. **`GET /pwa/*` SPA fallback** — unmatched deep routes get `pwa/index.html` for client-side routing
5. **Root static mount** — serves the legacy app (`index.html`, `app.js`, `styles.css`, …)

### Service Worker scope

The PWA's `index.html` registers `/sw.js` with no explicit scope argument.  
When served at `/pwa/sw.js`, the browser auto-assigns scope `/pwa/`. No source modification is required.

### Manifest rewrite (why it's needed)

`pwa/manifest.json` ships with `"start_url": "/"` and `"scope": "/"`.  
When the PWA is installed from `/pwa`, those root-relative values would point outside the PWA's path. The server intercepts `GET /pwa/manifest.json` and rewrites on the fly:

```json
{ "start_url": "/pwa/", "scope": "/pwa/", "icons": [{ "src": "/pwa/icons/…" }] }
```

The source `Agent-Mobile` repo is **not modified**.

### Cloning with submodules

```bash
git clone --recurse-submodules https://github.com/getsureshv/Agent.git
# or, if already cloned:
git submodule update --init --recursive
```

Render Free tier supports submodules natively — no extra build steps needed.

### Future optimisation

`pwa/config.js` currently hardcodes `BASE_URL: 'https://cricket-scorer-asmc.onrender.com'`.  
When both apps share the same origin, `BASE_URL` could be set to `''` (empty string) to use same-origin requests and eliminate any CORS overhead. Left as-is for v1.
