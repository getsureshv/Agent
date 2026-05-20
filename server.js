/**
 * Cricket Scorer — main server entry point.
 * Express app + WebSocket server + static file serving.
 *
 * Start: node server.js
 * Env:   DATABASE_URL, PORT (default 3000), ADMIN_PASSWORD, NODE_ENV
 */

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';

import { pool, runMigrations } from './db.js';
import { createWss } from './ws.js';

import healthRouter from './routes/health.js';
import devicesRouter from './routes/devices.js';
import tournamentsRouter from './routes/tournaments.js';
import matchesRouter from './routes/matches.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

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

// Static file serving — serves index.html, app.js, styles.css, exam.pdf, etc.
// Must come BEFORE API routes so static files don't get intercepted.
app.use(express.static(__dirname, {
  index: 'index.html',
  // Do not serve node_modules or hidden files
  dotfiles: 'ignore',
}));

// ── API Routes ───────────────────────────────────────────────────────
app.use('/api/health',      healthRouter);
app.use('/api/devices',     devicesRouter);
app.use('/api/tournaments', tournamentsRouter);
app.use('/api/matches',     matchesRouter);

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
