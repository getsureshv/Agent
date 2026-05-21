import { pool } from '../db.js';
import { COOKIE_NAME, getSessionUser } from './sessions.js';

export async function attachUser(req, _res, next) {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (sid) {
      const user = await getSessionUser(sid);
      if (user) req.user = user;
    }
  } catch (err) {
    console.error('[auth] attachUser error', err.message);
  }
  next();
}

export async function requireUser(req, res, next) {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    const user = await getSessionUser(sid);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth] requireUser error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

// Global admin OR owner of the tournament referenced by req.params.tournamentId / :id.
// Used to gate tournament-scoped admin actions. For non-tournament routes that just
// need a global admin, check req.user.is_global_admin directly inside the handler.
export async function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.user.is_global_admin) return next();

  const tournamentId = req.params.tournamentId || req.params.id;
  if (!tournamentId) {
    return res.status(403).json({ error: 'Admin privileges required', code: 'FORBIDDEN' });
  }
  try {
    const result = await pool.query(
      'SELECT owner_user_id FROM v3_tournaments WHERE id = $1',
      [tournamentId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tournament not found', code: 'NOT_FOUND' });
    }
    if (result.rows[0].owner_user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not tournament owner', code: 'FORBIDDEN' });
    }
    next();
  } catch (err) {
    console.error('[auth] requireAdmin error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
