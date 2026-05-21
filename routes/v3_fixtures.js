import { Router } from 'express';
import { pool } from '../db.js';
import { requireUser, attachUser } from '../auth/middleware.js';
import {
  requireTournamentOwner,
  requireTournamentReader,
} from '../auth/tournament_access.js';

const router = Router({ mergeParams: true });

const ALLOWED_STATUS = new Set(['scheduled', 'live', 'completed']);

function rowToFixture(r, { includeScorer = true } = {}) {
  const base = {
    id: r.id,
    tournament_id: r.tournament_id,
    team_a_id: r.team_a_id,
    team_b_id: r.team_b_id,
    team_a_name: r.team_a_name,
    team_b_name: r.team_b_name,
    scheduled_at: r.scheduled_at,
    venue: r.venue,
    status: r.status,
    match_id: r.match_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (includeScorer) {
    base.scorer_user_id = r.scorer_user_id;
    base.scorer_name   = r.scorer_name;
    base.scorer_email  = r.scorer_email;
  }
  return base;
}

async function fetchFixture(id) {
  const r = await pool.query(
    `SELECT f.*,
            ta.name AS team_a_name, tb.name AS team_b_name,
            u.name  AS scorer_name, u.email AS scorer_email
       FROM v3_fixtures f
       JOIN v3_teams ta ON ta.id = f.team_a_id
       JOIN v3_teams tb ON tb.id = f.team_b_id
       LEFT JOIN users u ON u.id = f.scorer_user_id
      WHERE f.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

async function teamsBelongTo(tournamentId, ids) {
  const r = await pool.query(
    'SELECT id FROM v3_teams WHERE tournament_id = $1 AND id = ANY($2::uuid[])',
    [tournamentId, ids]
  );
  return r.rowCount === ids.length;
}

// POST /api/v3/tournaments/:tid/fixtures
router.post('/', requireUser, requireTournamentOwner, async (req, res) => {
  const b = req.body || {};
  const a = b.team_a_id;
  const cTeam = b.team_b_id;
  if (!isUuid(a) || !isUuid(cTeam)) {
    return res.status(400).json({ error: 'team_a_id and team_b_id required', code: 'INVALID_INPUT' });
  }
  if (a === cTeam) {
    return res.status(400).json({ error: 'team_a and team_b must differ', code: 'INVALID_INPUT' });
  }
  const scorer = b.scorer_user_id || null;
  if (scorer !== null && !isUuid(scorer)) {
    return res.status(400).json({ error: 'invalid scorer_user_id', code: 'INVALID_INPUT' });
  }
  const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
  if (scheduledAt && isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ error: 'invalid scheduled_at', code: 'INVALID_INPUT' });
  }
  const venue = b.venue ? String(b.venue).trim() : null;

  try {
    if (!(await teamsBelongTo(req.tournament.id, [a, cTeam]))) {
      return res.status(400).json({ error: 'team(s) not in this tournament', code: 'INVALID_INPUT' });
    }
    const ins = await pool.query(
      `INSERT INTO v3_fixtures (tournament_id, team_a_id, team_b_id, scheduled_at, venue, scorer_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [req.tournament.id, a, cTeam, scheduledAt, venue, scorer]
    );
    const fixture = await fetchFixture(ins.rows[0].id);
    return res.json({ fixture: rowToFixture(fixture) });
  } catch (err) {
    console.error('[v3_fixtures] create', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// POST /api/v3/tournaments/:tid/fixtures/generate
// Query/body: mode = 'add' (default) | 'replace'
// In 'replace' mode, fixtures that have no associated match events are
// deleted before generation; played fixtures are preserved and returned.
router.post('/generate', requireUser, requireTournamentOwner, async (req, res) => {
  const format = req.body?.format;
  const mode = (req.query.mode || req.body?.mode || 'add').toString();
  if (!['round-robin', 'knockout'].includes(format)) {
    return res.status(400).json({ error: 'format must be round-robin or knockout', code: 'INVALID_INPUT' });
  }
  if (!['add', 'replace'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'add' or 'replace'", code: 'INVALID_INPUT' });
  }
  try {
    const teams = await pool.query(
      'SELECT id FROM v3_teams WHERE tournament_id = $1 ORDER BY created_at ASC',
      [req.tournament.id]
    );
    const ids = teams.rows.map((r) => r.id);
    if (ids.length < 2) {
      return res.status(400).json({ error: 'need at least 2 teams', code: 'INVALID_INPUT' });
    }

    const pairs = [];
    if (format === 'round-robin') {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
      }
    } else {
      // knockout: pair in declared order; if odd, last team byes round 1
      const usable = ids.length % 2 === 0 ? ids : ids.slice(0, -1);
      for (let i = 0; i < usable.length; i += 2) pairs.push([usable[i], usable[i + 1]]);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let deleted = 0;
      let preserved = [];
      if (mode === 'replace') {
        const played = await client.query(
          `SELECT f.id, ta.name AS team_a_name, tb.name AS team_b_name, f.status
             FROM v3_fixtures f
             JOIN v3_teams ta ON ta.id = f.team_a_id
             JOIN v3_teams tb ON tb.id = f.team_b_id
            WHERE f.tournament_id = $1
              AND EXISTS (
                SELECT 1
                  FROM v3_matches m
                  JOIN v3_match_events e ON e.match_id = m.id
                 WHERE m.fixture_id = f.id
              )`,
          [req.tournament.id]
        );
        preserved = played.rows.map((r) => ({
          id: r.id, team_a_name: r.team_a_name, team_b_name: r.team_b_name, status: r.status,
        }));
        const playedIds = played.rows.map((r) => r.id);
        const del = await client.query(
          `DELETE FROM v3_fixtures
            WHERE tournament_id = $1
              AND NOT (id = ANY($2::uuid[]))`,
          [req.tournament.id, playedIds]
        );
        deleted = del.rowCount;
      }

      const inserted = [];
      for (const [a, b] of pairs) {
        const r = await client.query(
          `INSERT INTO v3_fixtures (tournament_id, team_a_id, team_b_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [req.tournament.id, a, b]
        );
        inserted.push(r.rows[0].id);
      }
      await client.query('COMMIT');
      return res.json({
        ok: true,
        mode,
        created: inserted.length,
        fixture_ids: inserted,
        deleted,
        preserved_fixtures: preserved,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[v3_fixtures] generate', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /api/v3/tournaments/:tid/fixtures
// Public viewers see fixtures but never scorer assignment.
router.get('/', attachUser, requireTournamentReader, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT f.*,
              ta.name AS team_a_name, tb.name AS team_b_name,
              u.name  AS scorer_name, u.email AS scorer_email
         FROM v3_fixtures f
         JOIN v3_teams ta ON ta.id = f.team_a_id
         JOIN v3_teams tb ON tb.id = f.team_b_id
         LEFT JOIN users u ON u.id = f.scorer_user_id
        WHERE f.tournament_id = $1
        ORDER BY f.scheduled_at NULLS LAST, f.created_at ASC`,
      [req.tournament.id]
    );
    const includeScorer = req.tournamentRole !== 'public';
    return res.json({ fixtures: r.rows.map((row) => rowToFixture(row, { includeScorer })) });
  } catch (err) {
    console.error('[v3_fixtures] list', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// PATCH /api/v3/tournaments/:tid/fixtures/:fixtureId
router.patch('/:fixtureId', requireUser, requireTournamentOwner, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  function set(c, v) { fields.push(`${c} = $${i++}`); values.push(v); }

  if ('scheduled_at' in b) {
    if (b.scheduled_at === null || b.scheduled_at === '') {
      set('scheduled_at', null);
    } else {
      const d = new Date(b.scheduled_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid scheduled_at', code: 'INVALID_INPUT' });
      set('scheduled_at', d);
    }
  }
  if ('venue' in b) set('venue', b.venue ? String(b.venue).trim() : null);
  if ('scorer_user_id' in b) {
    if (b.scorer_user_id !== null && !isUuid(b.scorer_user_id)) {
      return res.status(400).json({ error: 'invalid scorer_user_id', code: 'INVALID_INPUT' });
    }
    set('scorer_user_id', b.scorer_user_id);
  }
  if ('status' in b) {
    if (!ALLOWED_STATUS.has(b.status)) return res.status(400).json({ error: 'invalid status', code: 'INVALID_INPUT' });
    set('status', b.status);
  }
  if (fields.length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied', code: 'INVALID_INPUT' });
  }
  fields.push('updated_at = NOW()');
  values.push(req.params.fixtureId, req.tournament.id);

  try {
    const r = await pool.query(
      `UPDATE v3_fixtures SET ${fields.join(', ')}
        WHERE id = $${i} AND tournament_id = $${i + 1}
       RETURNING id`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Fixture not found', code: 'NOT_FOUND' });
    const fixture = await fetchFixture(r.rows[0].id);
    return res.json({ fixture: rowToFixture(fixture) });
  } catch (err) {
    console.error('[v3_fixtures] update', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// DELETE /api/v3/tournaments/:tid/fixtures/:fixtureId
router.delete('/:fixtureId', requireUser, requireTournamentOwner, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM v3_fixtures WHERE id = $1 AND tournament_id = $2',
      [req.params.fixtureId, req.tournament.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Fixture not found', code: 'NOT_FOUND' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[v3_fixtures] delete', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
