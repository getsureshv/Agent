import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/tournaments
 * Auth: Bearer required
 * Returns all tournaments owned by the calling device.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tournaments WHERE owner_token = $1 ORDER BY updated_at DESC`,
      [req.deviceToken]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[tournaments] GET error', err.message);
    return res.status(500).json({ error: 'Failed to fetch tournaments', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/tournaments
 * Auth: Bearer required
 * Body: Tournament (full payload, UUIDv4 id from client)
 * Upserts on id. Idempotent.
 * Returns the stored tournament.
 */
router.post('/', requireAuth, async (req, res) => {
  const t = req.body;
  if (!t || !t.id) {
    return res.status(400).json({ error: 'Missing tournament id', code: 'MISSING_ID' });
  }
  if (!t.name) {
    return res.status(400).json({ error: 'Missing tournament name', code: 'MISSING_NAME' });
  }
  if (!t.format || !['league', 'knockout'].includes(t.format)) {
    return res.status(400).json({ error: 'Invalid format, must be league or knockout', code: 'INVALID_FORMAT' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tournaments (
        id, owner_token, name, format, overs_per_innings,
        players_per_team, squad_size, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        name              = EXCLUDED.name,
        format            = EXCLUDED.format,
        overs_per_innings = EXCLUDED.overs_per_innings,
        players_per_team  = EXCLUDED.players_per_team,
        squad_size        = EXCLUDED.squad_size,
        status            = EXCLUDED.status,
        updated_at        = NOW()
      RETURNING *`,
      [
        t.id,
        req.deviceToken,
        t.name,
        t.format,
        t.overs_per_innings ?? 10,
        t.players_per_team ?? 11,
        t.squad_size ?? 15,
        t.status ?? 'setup',
      ]
    );
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[tournaments] POST error', err.message);
    if (err.code === '23514') {
      return res.status(400).json({ error: err.message, code: 'CONSTRAINT_VIOLATION' });
    }
    return res.status(500).json({ error: 'Failed to upsert tournament', code: 'INTERNAL_ERROR' });
  }
});

export default router;
