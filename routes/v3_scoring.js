// v3 scoring API. All write endpoints require auth + the per-match lock.
// Reads are auth-gated for full state; the public score endpoint lives here.

import { Router } from 'express';
import { pool } from '../db.js';
import { requireUser, attachUser } from '../auth/middleware.js';
import { computeMatchState, scoreOnlyView, validateEvent } from '../lib/scoring.js';
import { broadcastMatchUpdate } from '../lib/ws.js';

const router = Router();

const LOCK_TTL_SECONDS = 60;

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

async function loadMatchAndFixture(id) {
  const r = await pool.query(
    `SELECT m.*,
            f.tournament_id, f.team_a_id, f.team_b_id, f.scorer_user_id,
            f.status AS fixture_status,
            t.owner_user_id, t.is_public,
            ta.name AS team_a_name, tb.name AS team_b_name
       FROM v3_matches m
       JOIN v3_fixtures f   ON f.id = m.fixture_id
       JOIN v3_tournaments t ON t.id = f.tournament_id
       JOIN v3_teams ta ON ta.id = f.team_a_id
       JOIN v3_teams tb ON tb.id = f.team_b_id
      WHERE m.id = $1
      LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

async function loadFixtureForMatchCreate(fixtureId) {
  const r = await pool.query(
    `SELECT f.*, t.owner_user_id
       FROM v3_fixtures f
       JOIN v3_tournaments t ON t.id = f.tournament_id
      WHERE f.id = $1
      LIMIT 1`,
    [fixtureId]
  );
  return r.rows[0] || null;
}

async function isCaptainOfEitherTeam(userId, teamAId, teamBId) {
  const r = await pool.query(
    'SELECT 1 FROM v3_teams WHERE id IN ($1,$2) AND captain_user_id = $3',
    [teamAId, teamBId, userId]
  );
  return r.rowCount > 0;
}

// requireMatchScorer — loads match, checks user is scorer/captain/owner/admin.
async function requireMatchScorer(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (!isUuid(req.params.id)) {
    return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
  }
  const m = await loadMatchAndFixture(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
  req._match = m;

  if (req.user.is_global_admin || m.owner_user_id === req.user.id
      || m.scorer_user_id === req.user.id) {
    return next();
  }
  if (await isCaptainOfEitherTeam(req.user.id, m.team_a_id, m.team_b_id)) {
    return next();
  }
  return res.status(403).json({
    error: 'Only the assigned scorer, a team captain, or the tournament owner can do this',
    code: 'FORBIDDEN',
  });
}

// Same membership check but also asserts the caller holds the active lock.
async function requireLock(req, res, next) {
  try {
    const r = await pool.query(
      'SELECT holder_user_id, client_id, expires_at FROM v3_match_locks WHERE match_id = $1',
      [req.params.id]
    );
    if (r.rowCount === 0 || new Date(r.rows[0].expires_at).getTime() < Date.now()) {
      return res.status(409).json({ error: 'No active lock. Acquire one first.', code: 'NO_LOCK' });
    }
    const row = r.rows[0];
    if (row.holder_user_id !== req.user.id) {
      return res.status(409).json({
        error: 'Match is locked by another user',
        code: 'LOCKED_OTHER',
        holder_user_id: row.holder_user_id,
      });
    }
    next();
  } catch (err) {
    console.error('[v3_scoring] requireLock', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

async function loadRosters(matchId, teamAId, teamBId) {
  const r = await pool.query(
    `SELECT l.team_id, p.id, p.name, p.batting_order, p.is_wicket_keeper, p.is_captain, p.role
       FROM v3_match_lineups l
       JOIN v3_players p ON p.id = l.player_id
      WHERE l.match_id = $1
      ORDER BY l.team_id, COALESCE(p.batting_order, 9999), p.name`,
    [matchId]
  );
  const out = { [teamAId]: [], [teamBId]: [] };
  for (const row of r.rows) {
    if (!out[row.team_id]) out[row.team_id] = [];
    out[row.team_id].push({
      id: row.id, name: row.name, batting_order: row.batting_order,
      is_wicket_keeper: row.is_wicket_keeper, is_captain: row.is_captain, role: row.role,
    });
  }
  return out;
}

async function loadEvents(matchId) {
  const r = await pool.query(
    'SELECT * FROM v3_match_events WHERE match_id = $1 ORDER BY seq ASC',
    [matchId]
  );
  return r.rows;
}

function buildPublicTeamLookup(m) {
  return { [m.team_a_id]: m.team_a_name, [m.team_b_id]: m.team_b_name };
}

async function buildFullState(m) {
  const rosters = await loadRosters(m.id, m.team_a_id, m.team_b_id);
  const events = await loadEvents(m.id);
  const state = computeMatchState(m, events, rosters);
  return { state, events, rosters };
}

// ── Create the match row for a fixture ─────────────────────────────
// POST /api/v3/fixtures/:id/match  (mounted by the v3 fixtures router below)
// Implemented here on a separate sub-router so server.js can mount it cleanly.
const fixtureMatchRouter = Router();
fixtureMatchRouter.post('/:id/match', requireUser, async (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(404).json({ error: 'Fixture not found', code: 'NOT_FOUND' });
  }
  const f = await loadFixtureForMatchCreate(req.params.id);
  if (!f) return res.status(404).json({ error: 'Fixture not found', code: 'NOT_FOUND' });

  // Authz: tournament owner, scorer of the fixture, captain of either team, or admin.
  const allowed = req.user.is_global_admin
    || f.owner_user_id === req.user.id
    || f.scorer_user_id === req.user.id
    || await isCaptainOfEitherTeam(req.user.id, f.team_a_id, f.team_b_id);
  if (!allowed) {
    return res.status(403).json({ error: 'Not authorized to start this match', code: 'FORBIDDEN' });
  }

  try {
    // Idempotent: re-use existing match row if present.
    const existing = await pool.query('SELECT id FROM v3_matches WHERE fixture_id = $1', [f.id]);
    if (existing.rowCount > 0) {
      const m = await loadMatchAndFixture(existing.rows[0].id);
      return res.json({ match_id: m.id, created: false, status: m.status });
    }
    const ins = await pool.query(
      `INSERT INTO v3_matches (fixture_id, status, current_innings_num)
       VALUES ($1, 'not_started', 1)
       RETURNING id`,
      [f.id]
    );
    // Stamp fixture.match_id so the admin/captain UI can navigate to it.
    await pool.query(
      'UPDATE v3_fixtures SET match_id = $1, updated_at = NOW() WHERE id = $2',
      [ins.rows[0].id, f.id]
    );
    return res.json({ match_id: ins.rows[0].id, created: true, status: 'not_started' });
  } catch (err) {
    console.error('[v3_scoring] create match', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── Match-scoped endpoints under /api/v3/matches/:id ───────────────
router.get('/:id', requireUser, requireMatchScorer, async (req, res) => {
  try {
    const { state, events, rosters } = await buildFullState(req._match);
    const teamLookup = buildPublicTeamLookup(req._match);
    return res.json({
      match_id: req._match.id,
      fixture_id: req._match.fixture_id,
      tournament_id: req._match.tournament_id,
      team_a_id: req._match.team_a_id, team_a_name: req._match.team_a_name,
      team_b_id: req._match.team_b_id, team_b_name: req._match.team_b_name,
      status: req._match.status,
      overs_per_innings: req._match.overs_per_innings,
      players_per_side: req._match.players_per_side,
      current_innings_num: req._match.current_innings_num,
      current_batting_team_id: req._match.current_batting_team_id,
      current_bowling_team_id: req._match.current_bowling_team_id,
      toss_winner_team_id: req._match.toss_winner_team_id,
      toss_decision: req._match.toss_decision,
      scorer_user_id: req._match.scorer_user_id,
      rosters,
      state,
      scoreOnly: scoreOnlyView(state, teamLookup),
      events_count: events.length,
    });
  } catch (err) {
    console.error('[v3_scoring] GET match', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

router.get('/:id/score', attachUser, async (req, res) => {
  if (!isUuid(req.params.id)) {
    return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
  }
  const m = await loadMatchAndFixture(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });

  // Private tournament: require member or owner or admin.
  if (!m.is_public) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    if (!req.user.is_global_admin && m.owner_user_id !== req.user.id
        && m.scorer_user_id !== req.user.id) {
      const cap = await isCaptainOfEitherTeam(req.user.id, m.team_a_id, m.team_b_id);
      if (!cap) {
        return res.status(403).json({ error: 'Not a member of this tournament', code: 'FORBIDDEN' });
      }
    }
  }

  try {
    const { state } = await buildFullState(m);
    return res.json(scoreOnlyView(state, buildPublicTeamLookup(m)));
  } catch (err) {
    console.error('[v3_scoring] GET score', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

router.get('/:id/events', requireUser, requireMatchScorer, async (req, res) => {
  try {
    const events = await loadEvents(req._match.id);
    return res.json({ events });
  } catch (err) {
    console.error('[v3_scoring] GET events', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── Lock ───────────────────────────────────────────────────────────
router.post('/:id/lock', requireUser, requireMatchScorer, async (req, res) => {
  const clientId = (req.body?.clientId || '').toString();
  if (!clientId) return res.status(400).json({ error: 'clientId required', code: 'INVALID_INPUT' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT holder_user_id, client_id, expires_at FROM v3_match_locks WHERE match_id = $1 FOR UPDATE',
      [req._match.id]
    );
    const now = Date.now();
    const expiresAt = new Date(now + LOCK_TTL_SECONDS * 1000);
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const stillHeld = new Date(row.expires_at).getTime() > now;
      const sameClient = row.holder_user_id === req.user.id && row.client_id === clientId;
      if (stillHeld && !sameClient) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Match is locked by another user',
          code: 'LOCKED_OTHER',
          holder_user_id: row.holder_user_id,
          expires_at: row.expires_at,
        });
      }
      // Replace or refresh
      await client.query(
        `UPDATE v3_match_locks
            SET holder_user_id = $1, client_id = $2,
                acquired_at = NOW(), expires_at = $3
          WHERE match_id = $4`,
        [req.user.id, clientId, expiresAt, req._match.id]
      );
    } else {
      await client.query(
        `INSERT INTO v3_match_locks (match_id, holder_user_id, client_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [req._match.id, req.user.id, clientId, expiresAt]
      );
    }
    await client.query('COMMIT');
    broadcastMatchUpdate(req._match.id, 'lock_changed').catch(() => {});
    return res.json({
      ok: true,
      holder_user_id: req.user.id,
      client_id: clientId,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_scoring] lock', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

router.post('/:id/lock/heartbeat', requireUser, requireMatchScorer, async (req, res) => {
  const clientId = (req.body?.clientId || '').toString();
  if (!clientId) return res.status(400).json({ error: 'clientId required', code: 'INVALID_INPUT' });
  try {
    const expiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000);
    const r = await pool.query(
      `UPDATE v3_match_locks
          SET expires_at = $1
        WHERE match_id = $2 AND holder_user_id = $3 AND client_id = $4
        RETURNING expires_at`,
      [expiresAt, req._match.id, req.user.id, clientId]
    );
    if (r.rowCount === 0) {
      return res.status(409).json({ error: 'You no longer hold the lock', code: 'NO_LOCK' });
    }
    return res.json({ ok: true, expires_at: r.rows[0].expires_at });
  } catch (err) {
    console.error('[v3_scoring] heartbeat', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

router.delete('/:id/lock', requireUser, requireMatchScorer, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM v3_match_locks WHERE match_id = $1 AND holder_user_id = $2',
      [req._match.id, req.user.id]
    );
    broadcastMatchUpdate(req._match.id, 'lock_changed').catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    console.error('[v3_scoring] release lock', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── Setup ──────────────────────────────────────────────────────────
router.post('/:id/setup', requireUser, requireMatchScorer, requireLock, async (req, res) => {
  const b = req.body || {};
  const tossWinner = b.toss_winner_team_id;
  const tossDecision = b.toss_decision;
  const overs = Number(b.overs_per_innings);
  const playersPerSide = Number(b.players_per_side || 11);
  const battingLineup = Array.isArray(b.batting_lineup_player_ids) ? b.batting_lineup_player_ids : null;
  const bowlingLineup = Array.isArray(b.bowling_lineup_player_ids) ? b.bowling_lineup_player_ids : null;

  if (!isUuid(tossWinner) || ![req._match.team_a_id, req._match.team_b_id].includes(tossWinner)) {
    return res.status(400).json({ error: 'toss_winner_team_id must be one of the playing teams', code: 'INVALID_INPUT' });
  }
  if (!['bat', 'bowl'].includes(tossDecision)) {
    return res.status(400).json({ error: "toss_decision must be 'bat' or 'bowl'", code: 'INVALID_INPUT' });
  }
  if (!Number.isInteger(overs) || overs < 1 || overs > 50) {
    return res.status(400).json({ error: 'overs_per_innings must be an int in [1,50]', code: 'INVALID_INPUT' });
  }
  if (!Number.isInteger(playersPerSide) || playersPerSide < 2 || playersPerSide > 15) {
    return res.status(400).json({ error: 'players_per_side must be an int in [2,15]', code: 'INVALID_INPUT' });
  }
  if (!battingLineup || !bowlingLineup
      || battingLineup.length !== playersPerSide || bowlingLineup.length !== playersPerSide
      || !battingLineup.every(isUuid) || !bowlingLineup.every(isUuid)) {
    return res.status(400).json({
      error: `batting_lineup_player_ids and bowling_lineup_player_ids must each be exactly ${playersPerSide} player uuids`,
      code: 'INVALID_INPUT',
    });
  }

  const battingTeam = tossDecision === 'bat' ? tossWinner
    : (tossWinner === req._match.team_a_id ? req._match.team_b_id : req._match.team_a_id);
  const bowlingTeam = battingTeam === req._match.team_a_id ? req._match.team_b_id : req._match.team_a_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Validate lineups belong to the right teams
    const battingCheck = await client.query(
      'SELECT id FROM v3_players WHERE team_id = $1 AND id = ANY($2::uuid[])',
      [battingTeam, battingLineup]
    );
    const bowlingCheck = await client.query(
      'SELECT id FROM v3_players WHERE team_id = $1 AND id = ANY($2::uuid[])',
      [bowlingTeam, bowlingLineup]
    );
    if (battingCheck.rowCount !== playersPerSide || bowlingCheck.rowCount !== playersPerSide) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Lineups must reference players in the correct team', code: 'INVALID_INPUT' });
    }

    await client.query(
      `UPDATE v3_matches
          SET toss_winner_team_id = $1, toss_decision = $2,
              overs_per_innings = $3, players_per_side = $4,
              current_batting_team_id = $5, current_bowling_team_id = $6,
              status = 'in_progress', started_at = COALESCE(started_at, NOW()),
              updated_at = NOW()
        WHERE id = $7`,
      [tossWinner, tossDecision, overs, playersPerSide,
       battingTeam, bowlingTeam, req._match.id]
    );

    // Replace lineups
    await client.query('DELETE FROM v3_match_lineups WHERE match_id = $1', [req._match.id]);
    for (let i = 0; i < battingLineup.length; i++) {
      await client.query(
        `INSERT INTO v3_match_lineups (match_id, team_id, player_id, batting_pos)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req._match.id, battingTeam, battingLineup[i], i + 1]
      );
    }
    for (let i = 0; i < bowlingLineup.length; i++) {
      await client.query(
        `INSERT INTO v3_match_lineups (match_id, team_id, player_id, batting_pos)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req._match.id, bowlingTeam, bowlingLineup[i], i + 1]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_scoring] setup', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }

  broadcastMatchUpdate(req._match.id, 'setup').catch(() => {});
  return res.json({ ok: true, status: 'in_progress' });
});

// ── Append a ball event ────────────────────────────────────────────
router.post('/:id/events', requireUser, requireMatchScorer, requireLock, async (req, res) => {
  if (req._match.status !== 'in_progress') {
    return res.status(409).json({ error: 'Match is not in progress', code: 'NOT_IN_PROGRESS' });
  }
  const b = req.body || {};
  const verr = validateEvent(b);
  if (verr) return res.status(400).json({ error: verr, code: 'INVALID_EVENT' });

  // Required fielding/identity fields
  if (!isUuid(b.batter_on_strike_player_id)) {
    return res.status(400).json({ error: 'batter_on_strike_player_id required', code: 'INVALID_INPUT' });
  }
  if (!isUuid(b.batter_non_strike_player_id)) {
    return res.status(400).json({ error: 'batter_non_strike_player_id required', code: 'INVALID_INPUT' });
  }
  if (!isUuid(b.bowler_player_id)) {
    return res.status(400).json({ error: 'bowler_player_id required', code: 'INVALID_INPUT' });
  }
  if (b.is_wicket && b.new_batter_player_id !== null && b.new_batter_player_id !== undefined && !isUuid(b.new_batter_player_id)) {
    return res.status(400).json({ error: 'new_batter_player_id must be a uuid or null', code: 'INVALID_INPUT' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent appends on this match without conflicting with
    // aggregate selects (Postgres forbids FOR UPDATE + aggregate).
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [req._match.id]);

    const seqRes = await client.query(
      'SELECT COALESCE(MAX(seq), 0) AS max FROM v3_match_events WHERE match_id = $1',
      [req._match.id]
    );
    const seq = Number(seqRes.rows[0].max) + 1;

    // Server-computed ball position within the over (only for legal balls).
    const inningsNum = req._match.current_innings_num || 1;
    const legalRes = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM v3_match_events
        WHERE match_id = $1 AND innings_num = $2 AND legal_ball = TRUE`,
      [req._match.id, inningsNum]
    );
    const legalBefore = legalRes.rows[0].n;
    const extras = b.extras_type || null;
    const legal = (extras !== 'wide' && extras !== 'no_ball');
    const legalAfter = legal ? legalBefore + 1 : legalBefore;
    const overNum = legal ? Math.floor((legalAfter - 1) / 6) + 1 : Math.floor(legalBefore / 6) + 1;
    const ballNum = legal ? ((legalAfter - 1) % 6) + 1 : null;

    const payload = {
      runs_off_bat: Number(b.runs_off_bat || 0),
      extras_runs: Number(b.extras_runs || 0),
      extras_type: extras,
      is_wicket: !!b.is_wicket,
      wicket_type: b.wicket_type || null,
      notes: b.notes || null,
    };

    await client.query(
      `INSERT INTO v3_match_events
         (match_id, seq, user_id, payload,
          innings_num, over_num, ball_num, legal_ball,
          runs_off_bat, extras_runs, extras_type,
          is_wicket, wicket_type, out_batter_player_id,
          batter_on_strike_player_id, batter_non_strike_player_id,
          bowler_player_id, new_batter_player_id, notes, event_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'ball')`,
      [
        req._match.id, seq, req.user.id, payload,
        inningsNum, overNum, ballNum, legal,
        Number(b.runs_off_bat || 0), Number(b.extras_runs || 0), extras,
        !!b.is_wicket, b.wicket_type || null, b.out_batter_player_id || null,
        b.batter_on_strike_player_id, b.batter_non_strike_player_id,
        b.bowler_player_id, b.new_batter_player_id || null, b.notes || null,
      ]
    );

    await client.query('UPDATE v3_matches SET updated_at = NOW() WHERE id = $1', [req._match.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_scoring] append event', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }

  // Re-load and return fresh state
  try {
    const m = await loadMatchAndFixture(req._match.id);
    const { state } = await buildFullState(m);
    broadcastMatchUpdate(m.id, 'event_appended').catch(() => {});
    return res.json({ ok: true, state });
  } catch (err) {
    console.error('[v3_scoring] post-append state', err.message);
    return res.json({ ok: true });
  }
});

// Undo last event (idempotent if none).
router.delete('/:id/events/last', requireUser, requireMatchScorer, requireLock, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM v3_match_events
         WHERE id = (
           SELECT id FROM v3_match_events WHERE match_id = $1
             ORDER BY seq DESC LIMIT 1
         )
       RETURNING id, seq, event_kind`,
      [req._match.id]
    );
    if (r.rowCount === 0) {
      return res.json({ ok: true, removed: null });
    }
    // If we removed an innings_end marker, status stays the same (the marker
    // is informational; current_innings_num is tracked on the match row).
    broadcastMatchUpdate(req._match.id, 'event_undone').catch(() => {});
    return res.json({ ok: true, removed: r.rows[0] });
  } catch (err) {
    console.error('[v3_scoring] undo', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// End current innings — appends an innings_end marker AND swaps the active
// teams. If this was the 2nd innings, the caller should follow up with
// /complete.
router.post('/:id/innings/end', requireUser, requireMatchScorer, requireLock, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [req._match.id]);
    const seqRes = await client.query(
      'SELECT COALESCE(MAX(seq), 0) AS max FROM v3_match_events WHERE match_id = $1',
      [req._match.id]
    );
    const seq = Number(seqRes.rows[0].max) + 1;
    const inningsNum = req._match.current_innings_num || 1;

    await client.query(
      `INSERT INTO v3_match_events
         (match_id, seq, user_id, payload, innings_num, event_kind, legal_ball)
       VALUES ($1, $2, $3, $4, $5, 'innings_end', FALSE)`,
      [req._match.id, seq, req.user.id, { innings_num: inningsNum }, inningsNum]
    );

    let updatedStatus = req._match.status;
    if (inningsNum === 1) {
      // Swap batting/bowling teams; bump innings.
      const newBatting = req._match.current_bowling_team_id;
      const newBowling = req._match.current_batting_team_id;
      await client.query(
        `UPDATE v3_matches
            SET current_innings_num = 2,
                current_batting_team_id = $1,
                current_bowling_team_id = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [newBatting, newBowling, req._match.id]
      );
    } else {
      // After 2nd innings end, leave the match in_progress until /complete.
      await client.query('UPDATE v3_matches SET updated_at = NOW() WHERE id = $1', [req._match.id]);
    }
    await client.query('COMMIT');
    broadcastMatchUpdate(req._match.id, 'innings_end').catch(() => {});
    return res.json({ ok: true, current_innings_num: inningsNum === 1 ? 2 : 2, status: updatedStatus });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_scoring] end innings', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

// Finalize.
router.post('/:id/complete', requireUser, requireMatchScorer, requireLock, async (req, res) => {
  const winnerTeamId = req.body?.winner_team_id || null;
  const resultSummary = (req.body?.result_summary || '').toString().slice(0, 500) || null;
  if (winnerTeamId !== null && !isUuid(winnerTeamId)) {
    return res.status(400).json({ error: 'winner_team_id must be a uuid or null', code: 'INVALID_INPUT' });
  }
  if (winnerTeamId && ![req._match.team_a_id, req._match.team_b_id].includes(winnerTeamId)) {
    return res.status(400).json({ error: 'winner_team_id must be one of the playing teams', code: 'INVALID_INPUT' });
  }
  try {
    await pool.query(
      `UPDATE v3_matches
          SET status = 'completed', completed_at = NOW(),
              winner_team_id = $1, result_summary = $2, updated_at = NOW()
        WHERE id = $3`,
      [winnerTeamId, resultSummary, req._match.id]
    );
    await pool.query(
      `UPDATE v3_fixtures SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [req._match.fixture_id]
    );
    broadcastMatchUpdate(req._match.id, 'match_complete').catch(() => {});
    return res.json({ ok: true, status: 'completed', winner_team_id: winnerTeamId });
  } catch (err) {
    console.error('[v3_scoring] complete', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export { fixtureMatchRouter };
export default router;
