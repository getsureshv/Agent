// Top-level v3 read endpoints that aren't naturally nested under a tournament:
//   GET /api/v3/config                 — runtime config for the SPAs (public)
//   GET /api/v3/fixtures/:id           — fixture detail (auth required: tournament member)
//
// GET /api/v3/matches/:id/score is now served by routes/v3_scoring.js
// (the real implementation, fed by the scoring engine).

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

export default router;
