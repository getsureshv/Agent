import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { requireUser, attachUser } from '../auth/middleware.js';
import {
  requireTournamentOwner,
  requireTournamentReader,
} from '../auth/tournament_access.js';
import teamsRouter from './v3_teams.js';
import fixturesRouter from './v3_fixtures.js';
import invitesRouter from './v3_invites.js';

const router = Router();

const ALLOWED_FORMATS = new Set(['league', 'knockout']);
const ALLOWED_STATUS = new Set(['draft', 'active', 'completed']);

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 60) || 'tournament';
}

function randomSuffix(n = 6) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n).toLowerCase().replace(/[^a-z0-9]/g, '0');
}

async function makeUniqueSlug(name) {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `${base}-${randomSuffix(6)}`;
    const exists = await pool.query('SELECT 1 FROM v3_tournaments WHERE slug = $1', [slug]);
    if (exists.rowCount === 0) return slug;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function rowToTournament(r) {
  return {
    id: r.id,
    owner_user_id: r.owner_user_id,
    name: r.name,
    slug: r.slug,
    format: r.format,
    overs_per_innings: r.overs_per_innings,
    players_per_team: r.players_per_team,
    squad_size: r.squad_size,
    is_public: r.is_public,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// POST /api/v3/tournaments
router.post('/', requireUser, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'name required', code: 'INVALID_INPUT' });
  }
  const format = b.format || 'league';
  if (!ALLOWED_FORMATS.has(format)) {
    return res.status(400).json({ error: 'format must be league or knockout', code: 'INVALID_INPUT' });
  }
  const overs = Number.isInteger(b.overs_per_innings) ? b.overs_per_innings : 20;
  const ppt = Number.isInteger(b.players_per_team) ? b.players_per_team : 11;
  const squad = Number.isInteger(b.squad_size) ? b.squad_size : 15;
  const isPublic = b.is_public !== false;

  try {
    const slug = await makeUniqueSlug(name);
    const r = await pool.query(
      `INSERT INTO v3_tournaments
         (owner_user_id, name, slug, format, overs_per_innings, players_per_team, squad_size, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.id, name, slug, format, overs, ppt, squad, isPublic]
    );
    return res.status(200).json({ tournament: rowToTournament(r.rows[0]) });
  } catch (err) {
    console.error('[v3_tournaments] create', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /api/v3/tournaments  — mine + ones I'm a member of
router.get('/', requireUser, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT t.*
         FROM v3_tournaments t
         LEFT JOIN v3_teams te ON te.tournament_id = t.id AND te.captain_user_id = $1
         LEFT JOIN v3_fixtures f ON f.tournament_id = t.id AND f.scorer_user_id = $1
        WHERE t.owner_user_id = $1
           OR te.id IS NOT NULL
           OR f.id IS NOT NULL
        ORDER BY t.updated_at DESC`,
      [req.user.id]
    );
    return res.json({ tournaments: r.rows.map(rowToTournament) });
  } catch (err) {
    console.error('[v3_tournaments] list', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /api/v3/tournaments/:id
router.get('/:id', attachUser, requireTournamentReader, async (req, res) => {
  try {
    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM v3_teams WHERE tournament_id = $1)    AS teams_count,
         (SELECT COUNT(*)::int FROM v3_fixtures WHERE tournament_id = $1) AS fixtures_count`,
      [req.tournament.id]
    );
    // Need full row for response (req.tournament has only some fields)
    const full = await pool.query('SELECT * FROM v3_tournaments WHERE id = $1', [req.tournament.id]);
    return res.json({
      tournament: rowToTournament(full.rows[0]),
      counts: counts.rows[0],
      role: !req.user
        ? 'public'
        : (req.user.id === req.tournament.owner_user_id || req.user.is_global_admin
            ? 'owner'
            : 'member'),
    });
  } catch (err) {
    console.error('[v3_tournaments] get', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// PATCH /api/v3/tournaments/:id
router.patch('/:id', requireUser, requireTournamentOwner, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;

  function set(col, val) { fields.push(`${col} = $${i++}`); values.push(val); }

  if (typeof b.name === 'string') {
    const n = b.name.trim();
    if (!n) return res.status(400).json({ error: 'name cannot be empty', code: 'INVALID_INPUT' });
    set('name', n);
  }
  if (typeof b.format === 'string') {
    if (!ALLOWED_FORMATS.has(b.format)) return res.status(400).json({ error: 'invalid format', code: 'INVALID_INPUT' });
    set('format', b.format);
  }
  if (Number.isInteger(b.overs_per_innings)) set('overs_per_innings', b.overs_per_innings);
  if (Number.isInteger(b.players_per_team)) set('players_per_team', b.players_per_team);
  if (Number.isInteger(b.squad_size)) set('squad_size', b.squad_size);
  if (typeof b.is_public === 'boolean') set('is_public', b.is_public);
  if (typeof b.status === 'string') {
    if (!ALLOWED_STATUS.has(b.status)) return res.status(400).json({ error: 'invalid status', code: 'INVALID_INPUT' });
    set('status', b.status);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied', code: 'INVALID_INPUT' });
  }
  fields.push('updated_at = NOW()');
  values.push(req.tournament.id);

  try {
    const r = await pool.query(
      `UPDATE v3_tournaments SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return res.json({ tournament: rowToTournament(r.rows[0]) });
  } catch (err) {
    console.error('[v3_tournaments] update', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// DELETE /api/v3/tournaments/:id
router.delete('/:id', requireUser, requireTournamentOwner, async (req, res) => {
  try {
    await pool.query('DELETE FROM v3_tournaments WHERE id = $1', [req.tournament.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[v3_tournaments] delete', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// Mount nested resources. mergeParams so :tid propagates.
router.use('/:tid/teams',    teamsRouter);
router.use('/:tid/fixtures', fixturesRouter);
router.use('/:tid/invites',  invitesRouter);

export default router;
