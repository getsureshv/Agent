import { Router } from 'express';
import { pool } from '../db.js';
import { requireUser } from '../auth/middleware.js';
import {
  requireTournamentMember,
  requireTeamCaptainOrAdmin,
} from '../auth/tournament_access.js';

const ROLES = new Set(['batsman', 'bowler', 'all-rounder', 'wicket-keeper', null, undefined, '']);

function rowToPlayer(r) {
  return {
    id: r.id,
    team_id: r.team_id,
    name: r.name,
    jersey_number: r.jersey_number,
    batting_order: r.batting_order,
    is_wicket_keeper: r.is_wicket_keeper,
    is_captain: r.is_captain,
    role: r.role,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function readBattingOrder(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 15) return Symbol.for('invalid');
  return n;
}

// ── Team-scoped roster read + write (mounted under /api/v3/teams) ───
const teamRouter = Router();

// GET /api/v3/teams/:teamId — single team detail (auth required).
teamRouter.get('/:teamId',
  requireUser,
  async (req, res, next) => {
    // Need to load team to find its tournament so requireTournamentMember
    // can check membership. Pre-load and stash params.
    const teamId = req.params.teamId;
    if (!/^[0-9a-f-]{36}$/i.test(teamId || '')) {
      return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    }
    const r = await pool.query(
      `SELECT te.*, t.name AS tournament_name,
              u.name AS captain_name, u.email AS captain_email
         FROM v3_teams te
         JOIN v3_tournaments t ON t.id = te.tournament_id
         LEFT JOIN users u ON u.id = te.captain_user_id
        WHERE te.id = $1`,
      [teamId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    req._team = r.rows[0];
    req.params.tid = req._team.tournament_id;
    next();
  },
  requireTournamentMember,
  (req, res) => {
    const t = req._team;
    return res.json({
      team: {
        id: t.id,
        tournament_id: t.tournament_id,
        tournament_name: t.tournament_name,
        name: t.name,
        short_name: t.short_name,
        captain_user_id: t.captain_user_id,
        captain_name: t.captain_name || null,
        captain_email: t.captain_email || null,
        created_at: t.created_at,
        updated_at: t.updated_at,
      },
    });
  }
);

// GET /api/v3/teams/:teamId/players — list roster (auth: tournament member).
teamRouter.get('/:teamId/players',
  requireUser,
  async (req, res, next) => {
    const r = await pool.query(
      'SELECT tournament_id FROM v3_teams WHERE id = $1',
      [req.params.teamId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Team not found', code: 'NOT_FOUND' });
    req.params.tid = r.rows[0].tournament_id;
    next();
  },
  requireTournamentMember,
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT * FROM v3_players
          WHERE team_id = $1
          ORDER BY (batting_order IS NULL), batting_order ASC, created_at ASC`,
        [req.params.teamId]
      );
      return res.json({ players: r.rows.map(rowToPlayer) });
    } catch (err) {
      console.error('[v3_players] list', err.message);
      return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  }
);

// POST /api/v3/teams/:teamId/players — captain or owner adds player.
teamRouter.post('/:teamId/players', requireUser, requireTeamCaptainOrAdmin, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required', code: 'INVALID_INPUT' });

  const battingOrder = readBattingOrder(b.batting_order);
  if (battingOrder === Symbol.for('invalid')) {
    return res.status(400).json({ error: 'batting_order must be 1..15', code: 'INVALID_INPUT' });
  }
  const role = b.role ?? null;
  if (role !== null && !ROLES.has(role)) {
    return res.status(400).json({ error: 'invalid role', code: 'INVALID_INPUT' });
  }

  try {
    const r = await pool.query(
      `INSERT INTO v3_players
         (team_id, name, jersey_number, batting_order, is_wicket_keeper, is_captain, role, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.team.id,
        name,
        Number.isInteger(b.jersey_number) ? b.jersey_number : null,
        battingOrder,
        !!b.is_wicket_keeper,
        !!b.is_captain,
        role || null,
        b.notes ? String(b.notes) : null,
      ]
    );
    return res.json({ player: rowToPlayer(r.rows[0]) });
  } catch (err) {
    console.error('[v3_players] create', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── Player-scoped routes (mounted under /api/v3/players) ───────────
const playerRouter = Router();

// Resolve player → team_id, then run requireTeamCaptainOrAdmin.
async function loadPlayerTeam(req, res, next) {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
    return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
  }
  const r = await pool.query('SELECT id, team_id FROM v3_players WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
  req._player = r.rows[0];
  req.params.teamId = r.rows[0].team_id;
  next();
}

// PATCH /api/v3/players/:id
playerRouter.patch('/:id', requireUser, loadPlayerTeam, requireTeamCaptainOrAdmin, async (req, res) => {
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
  if ('jersey_number' in b) {
    set('jersey_number', Number.isInteger(b.jersey_number) ? b.jersey_number : null);
  }
  if ('batting_order' in b) {
    const v = readBattingOrder(b.batting_order);
    if (v === Symbol.for('invalid')) {
      return res.status(400).json({ error: 'batting_order must be 1..15', code: 'INVALID_INPUT' });
    }
    set('batting_order', v);
  }
  if ('is_wicket_keeper' in b) set('is_wicket_keeper', !!b.is_wicket_keeper);
  if ('is_captain' in b)       set('is_captain', !!b.is_captain);
  if ('role' in b) {
    if (b.role !== null && b.role !== '' && !ROLES.has(b.role)) {
      return res.status(400).json({ error: 'invalid role', code: 'INVALID_INPUT' });
    }
    set('role', b.role || null);
  }
  if ('notes' in b) set('notes', b.notes ? String(b.notes) : null);

  if (fields.length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied', code: 'INVALID_INPUT' });
  }
  fields.push('updated_at = NOW()');
  values.push(req._player.id);

  try {
    const r = await pool.query(
      `UPDATE v3_players SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return res.json({ player: rowToPlayer(r.rows[0]) });
  } catch (err) {
    console.error('[v3_players] update', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// DELETE /api/v3/players/:id
playerRouter.delete('/:id', requireUser, loadPlayerTeam, requireTeamCaptainOrAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM v3_players WHERE id = $1', [req._player.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[v3_players] delete', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export { teamRouter, playerRouter };
