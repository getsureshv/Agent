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

// Reads where public viewers are OK: owner, captain, scorer, OR is_public.
// Used for endpoints that intentionally expose data to anonymous viewers
// (e.g. fixtures list, score). When req.user is set, `req.tournamentRole`
// will be one of 'owner' | 'member' | 'public'.
export async function requireTournamentReader(req, res, next) {
  try {
    const t = await loadTournament(req, res);
    if (!t) return;
    if (req.user?.is_global_admin || t.owner_user_id === req.user?.id) {
      req.tournamentRole = 'owner';
      return next();
    }
    if (req.user) {
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
      if (member.rowCount > 0) {
        req.tournamentRole = 'member';
        return next();
      }
    }
    if (t.is_public) {
      req.tournamentRole = 'public';
      return next();
    }
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    return res.status(403).json({ error: 'Not a member of this tournament', code: 'FORBIDDEN' });
  } catch (err) {
    console.error('[auth] requireTournamentReader error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

// Member-only reads (no is_public bypass). Owner, captain, scorer, or admin.
export async function requireTournamentMember(req, res, next) {
  try {
    const t = await loadTournament(req, res);
    if (!t) return;
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    if (req.user.is_global_admin || t.owner_user_id === req.user.id) {
      req.tournamentRole = 'owner';
      return next();
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
    if (member.rowCount > 0) {
      req.tournamentRole = 'member';
      return next();
    }
    return res.status(403).json({ error: 'Not a member of this tournament', code: 'FORBIDDEN' });
  } catch (err) {
    console.error('[auth] requireTournamentMember error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

// Team-scoped writes: admin, tournament owner, OR captain_user_id of this team.
// Loads team and tournament; sets req.team and req.tournament.
export async function requireTeamCaptainOrAdmin(req, res, next) {
  try {
    const teamId = req.params.teamId || req.params.id;
    if (!teamId || !/^[0-9a-f-]{36}$/i.test(teamId)) {
      return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    }
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    const r = await pool.query(
      `SELECT te.id, te.tournament_id, te.captain_user_id, te.name, t.owner_user_id
         FROM v3_teams te
         JOIN v3_tournaments t ON t.id = te.tournament_id
        WHERE te.id = $1`,
      [teamId]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    }
    const row = r.rows[0];
    req.team = {
      id: row.id, tournament_id: row.tournament_id,
      captain_user_id: row.captain_user_id, name: row.name,
    };
    if (req.user.is_global_admin
        || row.owner_user_id === req.user.id
        || row.captain_user_id === req.user.id) {
      return next();
    }
    return res.status(403).json({ error: 'Not team captain or tournament owner', code: 'FORBIDDEN' });
  } catch (err) {
    console.error('[auth] requireTeamCaptainOrAdmin error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
