import { pool } from '../db.js';

// Loads the tournament row and 404s if missing; attaches to req.tournament.
async function loadTournament(req, res) {
  const id = req.params.tid || req.params.id;
  if (!id) {
    res.status(400).json({ error: 'Tournament id required', code: 'BAD_REQUEST' });
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(404).json({ error: 'Tournament not found', code: 'NOT_FOUND' });
    return null;
  }
  const r = await pool.query(
    'SELECT id, owner_user_id, name, slug, is_public, status FROM v3_tournaments WHERE id = $1',
    [id]
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: 'Tournament not found', code: 'NOT_FOUND' });
    return null;
  }
  req.tournament = r.rows[0];
  return req.tournament;
}

// Mutations: require global admin OR tournament owner.
export async function requireTournamentOwner(req, res, next) {
  try {
    const t = await loadTournament(req, res);
    if (!t) return;
    if (req.user?.is_global_admin || t.owner_user_id === req.user?.id) {
      return next();
    }
    return res.status(403).json({ error: 'Not tournament owner', code: 'FORBIDDEN' });
  } catch (err) {
    console.error('[auth] requireTournamentOwner error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

// Reads: owner, captain of any team, scorer of any fixture, OR is_public.
export async function requireTournamentReader(req, res, next) {
  try {
    const t = await loadTournament(req, res);
    if (!t) return;
    if (t.is_public) return next();
    if (req.user?.is_global_admin || t.owner_user_id === req.user?.id) return next();
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const member = await pool.query(
      `SELECT 1
         FROM v3_teams
        WHERE tournament_id = $1 AND captain_user_id = $2
       UNION ALL
       SELECT 1
         FROM v3_fixtures
        WHERE tournament_id = $1 AND scorer_user_id = $2
        LIMIT 1`,
      [t.id, req.user.id]
    );
    if (member.rowCount > 0) return next();
    return res.status(403).json({ error: 'Not a member of this tournament', code: 'FORBIDDEN' });
  } catch (err) {
    console.error('[auth] requireTournamentReader error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
