import { pool } from '../db.js';

/**
 * Bearer token middleware.
 * Extracts the Authorization: Bearer <uuid> header,
 * looks it up in the device_tokens table,
 * and sets req.deviceToken on success.
 * Returns 401 if missing or invalid.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+([0-9a-f-]+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header', code: 'AUTH_REQUIRED' });
  }

  const token = match[1].toLowerCase();

  try {
    const result = await pool.query(
      'SELECT token FROM device_tokens WHERE token = $1',
      [token]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Unknown device token', code: 'INVALID_TOKEN' });
    }
    req.deviceToken = result.rows[0].token;
    next();
  } catch (err) {
    console.error('[auth] DB error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
