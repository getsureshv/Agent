import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();
const VERSION = process.env.npm_package_version || '2.0.0';

/**
 * GET /api/health
 * No auth required. Used by Railway health checks.
 * Must respond < 100 ms — runs a SELECT 1 to verify DB connectivity.
 */
router.get('/', async (req, res) => {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({
      ok: true,
      status: 'ok',
      version: VERSION,
      db: 'connected',
      ts: new Date().toISOString(),
      latency_ms: Date.now() - start,
    });
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
    return res.status(503).json({
      ok: false,
      status: 'degraded',
      version: VERSION,
      db: 'unreachable',
      ts: new Date().toISOString(),
      error: err.message,
    });
  }
});

export default router;
