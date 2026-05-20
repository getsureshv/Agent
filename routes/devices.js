import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

/**
 * POST /api/devices/register
 * Body: { label?: string }
 * Returns: { token: "<UUID>" }
 * No auth required. Creates a device_tokens row and returns the UUID.
 * Call once per new device install; store token in localStorage.
 */
router.post('/register', async (req, res) => {
  const label = req.body?.label || null;
  try {
    const result = await pool.query(
      'INSERT INTO device_tokens (label) VALUES ($1) RETURNING token, label, created_at',
      [label]
    );
    const row = result.rows[0];
    return res.status(201).json({
      token: row.token,
      label: row.label,
      created_at: row.created_at,
    });
  } catch (err) {
    console.error('[devices] register error', err.message);
    return res.status(500).json({ error: 'Failed to register device', code: 'INTERNAL_ERROR' });
  }
});

export default router;
