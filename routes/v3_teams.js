import { Router } from 'express';
import { pool } from '../db.js';
import { requireUser, attachUser } from '../auth/middleware.js';
import {
  requireTournamentOwner,
  requireTournamentMember,
} from '../auth/tournament_access.js';

const router = Router({ mergeParams: true });

function rowToTeam(r) {
  return {
    id: r.id,
    tournament_id: r.tournament_id,
    name: r.name,
    short_name: r.short_name,
    captain_user_id: r.captain_user_id,
    captain_name: r.captain_name || null,
    captain_email: r.captain_email || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// POST /api/v3/tournaments/:tid/teams
router.post('/', requireUser, requireTournamentOwner, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const shortName = req.body?.short_name ? String(req.body.short_name).trim() : null;
  if (!name) return res.status(400).json({ error: 'name required', code: 'INVALID_INPUT' });

  try {
    const r = await pool.query(
      `INSERT INTO v3_teams (tournament_id, name, short_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.tournament.id, name, shortName]
    );
    return res.json({ team: rowToTeam(r.rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Team name already used in this tournament', code: 'DUPLICATE_NAME' });
    }
    console.error('[v3_teams] create', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /api/v3/tournaments/:tid/teams — member only (rosters are not public).
router.get('/', requireUser, requireTournamentMember, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*, u.name AS captain_name, u.email AS captain_email
         FROM v3_teams t
         LEFT JOIN users u ON u.id = t.captain_user_id
        WHERE t.tournament_id = $1
        ORDER BY t.created_at ASC`,
      [req.tournament.id]
    );
    return res.json({ teams: r.rows.map(rowToTeam) });
  } catch (err) {
    console.error('[v3_teams] list', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// PATCH /api/v3/tournaments/:tid/teams/:teamId
router.patch('/:teamId', requireUser, requireTournamentOwner, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  function set(c, v) { fields.push(`${c} = $${i++}`); values.push(v); }

  if (typeof b.name === 'string') {
    const n = b.name.trim();
    if (!n) return res.status(400).json({ error: 'name cannot be empty', code: 'INVALID_INPUT' });
    set('name', n);
  }
  if ('short_name' in b) set('short_name', b.short_name ? String(b.short_name).trim() : null);
  if ('captain_user_id' in b) {
    if (b.captain_user_id !== null && !/^[0-9a-f-]{36}$/i.test(String(b.captain_user_id))) {
      return res.status(400).json({ error: 'invalid captain_user_id', code: 'INVALID_INPUT' });
    }
    set('captain_user_id', b.captain_user_id);
  }
  if (fields.length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied', code: 'INVALID_INPUT' });
  }
  fields.push('updated_at = NOW()');
  values.push(req.params.teamId, req.tournament.id);

  try {
    const r = await pool.query(
      `UPDATE v3_teams SET ${fields.join(', ')}
        WHERE id = $${i} AND tournament_id = $${i + 1}
       RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    return res.json({ team: rowToTeam(r.rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Team name already used', code: 'DUPLICATE_NAME' });
    }
    console.error('[v3_teams] update', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// DELETE /api/v3/tournaments/:tid/teams/:teamId
router.delete('/:teamId', requireUser, requireTournamentOwner, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM v3_teams WHERE id = $1 AND tournament_id = $2',
      [req.params.teamId, req.tournament.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[v3_teams] delete', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
