// Top-level v3 read endpoints that aren't naturally nested under a tournament:
//   GET /api/v3/config                 — runtime config for the SPAs (public)
//   GET /api/v3/fixtures/:id           — fixture detail (auth required: tournament member)
//   GET /api/v3/matches/:id/score      — public live-score stub (filled in by PR 4)

import { Router } from 'express';
import { pool } from '../db.js';
import { requireUser, attachUser } from '../auth/middleware.js';
import { requireTournamentMember } from '../auth/tournament_access.js';
import { isConfigured as mailIsConfigured } from '../lib/mailer.js';

const router = Router();

// GET /api/v3/config — public runtime config for SPAs.
router.get('/config', (req, res) => {
  res.json({
    emailConfigured: mailIsConfigured(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  });
});

router.get('/fixtures/:id',
  requireUser,
  async (req, res, next) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
      return res.status(404).json({ error: 'Fixture not found', code: 'NOT_FOUND' });
    }
    const r = await pool.query(
      `SELECT f.*,
              ta.name AS team_a_name, tb.name AS team_b_name,
              u.name  AS scorer_name, u.email AS scorer_email,
              t.name  AS tournament_name
         FROM v3_fixtures f
         JOIN v3_teams ta ON ta.id = f.team_a_id
         JOIN v3_teams tb ON tb.id = f.team_b_id
         JOIN v3_tournaments t ON t.id = f.tournament_id
         LEFT JOIN users u ON u.id = f.scorer_user_id
        WHERE f.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Fixture not found', code: 'NOT_FOUND' });
    req._fixture = r.rows[0];
    req.params.tid = r.rows[0].tournament_id;
    next();
  },
  requireTournamentMember,
  (req, res) => {
    const f = req._fixture;
    return res.json({
      fixture: {
        id: f.id,
        tournament_id: f.tournament_id,
        tournament_name: f.tournament_name,
        team_a_id: f.team_a_id, team_a_name: f.team_a_name,
        team_b_id: f.team_b_id, team_b_name: f.team_b_name,
        scheduled_at: f.scheduled_at,
        venue: f.venue,
        scorer_user_id: f.scorer_user_id,
        scorer_name: f.scorer_name,
        scorer_email: f.scorer_email,
        status: f.status,
        match_id: f.match_id,
        created_at: f.created_at,
        updated_at: f.updated_at,
      },
    });
  }
);

// Public score endpoint. PR 4 will fill in the real scorecard projection.
// For now: returns the match row's stored `state` JSON if a match exists,
// or { match_id: null, ready: false } if scoring has not started.
router.get('/matches/:id/score', attachUser, async (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
    return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
  }
  try {
    const r = await pool.query(
      `SELECT m.id AS match_id, m.fixture_id, m.state, m.toss_winner_team_id, m.toss_decision,
              f.tournament_id, f.status AS fixture_status,
              t.is_public,
              ta.name AS team_a_name, tb.name AS team_b_name
         FROM v3_matches m
         JOIN v3_fixtures f ON f.id = m.fixture_id
         JOIN v3_tournaments t ON t.id = f.tournament_id
         JOIN v3_teams ta ON ta.id = f.team_a_id
         JOIN v3_teams tb ON tb.id = f.team_b_id
        WHERE m.id = $1
        LIMIT 1`,
      [id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
    }
    const row = r.rows[0];

    // Honor tournament visibility: private tournaments require a member.
    if (!row.is_public) {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      const member = await pool.query(
        `SELECT 1
           FROM v3_tournaments t
          WHERE t.id = $1 AND t.owner_user_id = $2
         UNION ALL
         SELECT 1
           FROM v3_teams
          WHERE tournament_id = $1 AND captain_user_id = $2
         UNION ALL
         SELECT 1
           FROM v3_fixtures
          WHERE tournament_id = $1 AND scorer_user_id = $2
          LIMIT 1`,
        [row.tournament_id, req.user.id]
      );
      if (member.rowCount === 0 && !req.user.is_global_admin) {
        return res.status(403).json({ error: 'Not a member of this tournament', code: 'FORBIDDEN' });
      }
    }

    const events = await pool.query(
      'SELECT COUNT(*)::int AS n FROM v3_match_events WHERE match_id = $1',
      [id]
    );

    return res.json({
      match_id: row.match_id,
      fixture_id: row.fixture_id,
      team_a_name: row.team_a_name,
      team_b_name: row.team_b_name,
      fixture_status: row.fixture_status,
      toss_winner_team_id: row.toss_winner_team_id,
      toss_decision: row.toss_decision,
      events_count: events.rows[0].n,
      state: row.state || {},
      // PR 4 will replace this stub with a real innings/over/score projection.
      stub: true,
    });
  } catch (err) {
    console.error('[v3_top] score', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
