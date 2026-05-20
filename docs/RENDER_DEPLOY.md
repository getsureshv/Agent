# Deploying Cricket Scorer to Render

This guide walks through deploying the Cricket Scorer server to Render using the included `render.yaml` Blueprint. It provisions a Node.js web service (`cricket-scorer`) and a managed Postgres database (`cricket-db`) in one click.

---

## Prerequisites

- A [Render account](https://render.com) (free to sign up)
- The `getsureshv/Agent` GitHub repo connected to your Render account (done during the Blueprint step below)

---

## Option A — One-Click Blueprint (Recommended)

### Step 1 — Push the branch to GitHub

This PR already includes `render.yaml` at the repo root. Once merged to the default branch, Render will detect it automatically. You can also deploy directly from this branch during review.

### Step 2 — Open Render Dashboard

Go to [https://dashboard.render.com](https://dashboard.render.com).

### Step 3 — Create a new Blueprint instance

Click **New +** → **Blueprint**.

### Step 4 — Connect the GitHub repo

Select your GitHub account and choose **getsureshv/Agent**. If the repo is not listed, click **Configure GitHub access** and grant permissions.

### Step 5 — Render reads render.yaml

Render automatically detects `render.yaml` and displays a preview showing:
- `cricket-scorer` — Node.js Web Service (Starter, Oregon)
- `cricket-db` — Postgres database (Starter, Oregon)

Review the preview, then click **Apply**.

### Step 6 — Set ADMIN_PASSWORD manually

`ADMIN_PASSWORD` is marked `sync: false` in the Blueprint (it is a sensitive secret and intentionally not stored in the repo). After the services are created:

1. Go to **Dashboard → cricket-scorer → Environment**.
2. Find `ADMIN_PASSWORD` — it will have a generated placeholder value.
3. Replace it with a strong secret of your choice.
4. Click **Save Changes** → Render triggers a redeploy automatically.

### Step 7 — Wait for first build (~5 minutes)

Render will:
1. Pull the repo and run `npm ci`.
2. Start the server with `node server.js`.
3. The server runs database migrations automatically at boot (no separate migrate step needed — `runMigrations()` is called inside `server.js` before the HTTP server starts).

Watch progress under **Dashboard → cricket-scorer → Events** and **Logs**.

### Step 8 — Visit your app

Once the deploy shows **Live**, open the `.onrender.com` URL shown in the dashboard. You should see the Cricket Scoring UI.

### Step 9 — Verify the health endpoint

```bash
curl https://<your-service>.onrender.com/api/health
# → { "ok": true, "db": "connected", ... }
```

---

## Option B — Manual Setup

If you prefer to configure services by hand rather than using the Blueprint:

### 1. Create the Postgres database

- Dashboard → **New +** → **PostgreSQL**
- Name: `cricket-db`
- Plan: **Starter** ($7/mo — persistent, never expires)
- Region: **Oregon (US West)**
- Click **Create Database**
- Note the **Internal Database URL** from the Info tab

### 2. Create the Web Service

- Dashboard → **New +** → **Web Service**
- Connect **getsureshv/Agent** repo
- Settings:
  - **Name:** `cricket-scorer`
  - **Region:** Oregon (US West)
  - **Branch:** `claude/cricket-scoring-app-FjJPG` (or your default branch)
  - **Runtime:** Node
  - **Build Command:** `npm ci`
  - **Start Command:** `node server.js`
  - **Plan:** Starter ($7/mo)
- Click **Advanced** → **Add Environment Variable**:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | paste the Internal Database URL from Step 1 |
| `ADMIN_PASSWORD` | a strong secret string |

- **Health Check Path:** `/api/health`
- Click **Create Web Service**

---

## Important Notes

### WebSocket Support

Render supports WebSockets natively on **all plans** — no extra configuration, proxy headers, or plugin needed. The `/ws` endpoint works out of the box.

### Always-On (No Cold Starts)

This deployment uses the **Starter plan ($7/mo)** for the web service. Starter instances run continuously and **never sleep**. The free plan sleeps after 15 minutes of inactivity and has a slow cold-start — avoid it for a real-time scoring app.

### Postgres Plan

Render's **free Postgres tier expires after 90 days** and the data is deleted. The Starter Postgres ($7/mo) is persistent with no expiry. This Blueprint uses Starter for both services.

### SSL / HTTPS

Render provisions a TLS certificate automatically for every web service. Your app is served over HTTPS at `https://<service-name>.onrender.com` with no extra configuration. Custom domains are optional (Dashboard → cricket-scorer → Custom Domains).

### Migrations

`server.js` calls `runMigrations()` at boot before the HTTP server starts. All SQL files in `migrations/` are applied in sorted order, wrapped in transactions, and are idempotent (`IF NOT EXISTS` everywhere). There is **no separate migration step** — Render's first deploy handles it automatically.

### DATABASE_URL and SSL

The `db.js` pool config detects `NODE_ENV=production` and applies `ssl: { rejectUnauthorized: false }`, which is required for Render Postgres connections. This is already set correctly in the codebase — no changes needed.

---

## Costs Summary

| Service | Plan | Monthly Cost |
|---------|------|-------------|
| cricket-scorer (web) | Starter | $7 |
| cricket-db (Postgres) | Starter | $7 |
| **Total** | | **$14/mo** |

Render's free tier is available but not recommended for production (web service sleeps, Postgres expires after 90 days).
