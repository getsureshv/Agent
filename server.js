/**
 * Cricket Scorer — main server entry point.
 * Express app + WebSocket server + static file serving.
 *
 * Start: node server.js
 * Env:   DATABASE_URL, PORT (default 3000), ADMIN_PASSWORD, NODE_ENV
 *
 * Route order (important — Express matches top-to-bottom):
 *   1. CORS middleware for /api
 *   2. JSON body parser
 *   3. API routes  (/api/*)
 *   4. Admin wipe  (/admin/wipe)
 *   5. PWA manifest rewrite  GET /pwa/manifest.json  ← must precede static
 *   6. PWA static mount      /pwa  → ./pwa/
 *   7. PWA SPA fallback       GET /pwa/*  → ./pwa/index.html
 *   8. Legacy root static    /  → __dirname
 */

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import basicAuth from 'express-basic-auth';

import { pool, runMigrations } from './db.js';
import { createWss } from './ws.js';

import healthRouter from './routes/health.js';
import devicesRouter from './routes/devices.js';
import tournamentsRouter from './routes/tournaments.js';
import matchesRouter from './routes/matches.js';
import v3AuthRouter from './routes/v3_auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

// require() helper for loading JSON in ESM
const require = createRequire(import.meta.url);

// ── Express app ──────────────────────────────────────────────────────
const app = express();

// CORS: allow all origins for /api/* (PWA may be hosted on a different origin)
app.use('/api', cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON bodies
app.use(express.json({ limit: '1mb' }));

// Parse cookies (needed by v3 session auth)
app.use(cookieParser());

// ── API Routes ───────────────────────────────────────────────────────
app.use('/api/health',      healthRouter);
app.use('/api/devices',     devicesRouter);
app.use('/api/tournaments', tournamentsRouter);
app.use('/api/matches',     matchesRouter);

// v3 routes — mounted alongside legacy paths; PR 5 will retire the legacy ones.
app.use('/api/v3/auth',     v3AuthRouter);

// ── Admin wipe (basic-auth protected) ───────────────────────────────
const adminPassword = process.env.ADMIN_PASSWORD;
if (adminPassword) {
  app.delete(
    '/admin/wipe',
    basicAuth({
      users: { admin: adminPassword },
      challenge: true,
      realm: 'cricket-scorer-admin',
    }),
    async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Truncate in dependency order (child tables first)
        await client.query('TRUNCATE match_events, matches, players, teams, tournaments RESTART IDENTITY CASCADE');
        await client.query('COMMIT');
        console.log('[admin] database wiped');
        return res.json({ ok: true, message: 'All data wiped (device_tokens preserved)' });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[admin] wipe error', err.message);
        return res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' });
      } finally {
        client.release();
      }
    }
  );
} else {
  app.delete('/admin/wipe', (req, res) => {
    res.status(503).json({ error: 'Admin wipe not configured (ADMIN_PASSWORD not set)', code: 'NOT_CONFIGURED' });
  });
}

// ── 404 for unmatched /api/* paths ──────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found', code: 'NOT_FOUND' });
});

// ── PWA — Agent-Mobile served at /pwa ───────────────────────────────
//
// The Agent-Mobile repo lives as a git submodule at ./pwa (see .gitmodules).
// We mount it at /pwa so that phones visit /pwa while the desktop scoring
// app continues to be served at /.
//
// IMPORTANT — manifest rewrite must be registered BEFORE express.static
// so that this handler takes precedence over the file on disk.
app.get('/pwa/manifest.json', (req, res) => {
  // Load fresh on each request (no module cache concerns — it's JSON)
  // eslint-disable-next-line import/no-dynamic-require
  const manifest = require('./pwa/manifest.json');
  const rewritten = {
    ...manifest,
    start_url: '/pwa/',
    scope: '/pwa/',
  };
  // Rewrite root-relative icon paths to be /pwa-relative
  if (Array.isArray(rewritten.icons)) {
    rewritten.icons = rewritten.icons.map((icon) => ({
      ...icon,
      src: icon.src.startsWith('/') ? '/pwa' + icon.src : icon.src,
    }));
  }
  res.json(rewritten);
});

// Serve PWA static assets (CSS, JS, icons, sw.js, …)
// IMPORTANT: sw.js and index.html must NEVER be cached by intermediaries or the browser,
// otherwise PWA updates can take hours/days to reach installed clients.
app.use('/pwa', express.static(path.join(__dirname, 'pwa'), {
  dotfiles: 'ignore',
  setHeaders: (res, filePath) => {
    const base = path.basename(filePath);
    if (base === 'sw.js' || base === 'index.html') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// SPA fallback — any unmatched /pwa/* route gets the PWA shell
app.get('/pwa/*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'pwa', 'index.html'));
});

// ── Legacy root static ──────────────────────────────────────────────────
// Serves the desktop cricket scoring app: index.html, app.js, styles.css, etc.
// Must come AFTER all /api, /admin, and /pwa routes.
app.use(express.static(__dirname, {
  index: 'index.html',
  dotfiles: 'ignore',
}));

// ── HTTP server + WebSocket ──────────────────────────────────────────
const httpServer = http.createServer(app);
createWss(httpServer);

// ── Boot sequence ────────────────────────────────────────────────────
async function start() {
  // Run migrations at boot — never fails the server
  try {
    await runMigrations();
  } catch (err) {
    console.error('[boot] migration error (non-fatal):', err.message);
  }

  httpServer.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log(`[server] static files served from ${__dirname}`);
    console.log(`[server] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch((err) => {
  console.error('[boot] fatal error:', err);
  process.exit(1);
});
