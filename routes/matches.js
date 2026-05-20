import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcast } from '../ws.js';

const router = Router();

/**
 * GET /api/matches?since=<ISO-timestamp>
 * Auth: Bearer required
 * Returns matches updated after `since`.
 * If `since` omitted, returns all matches for the device.
 */
router.get('/', requireAuth, async (req, res) => {
  const since = req.query.since;
  try {
    let result;
    if (since) {
      result = await pool.query(
        `SELECT * FROM matches WHERE owner_token = $1 AND updated_at > $2 ORDER BY updated_at DESC`,
        [req.deviceToken, since]
      );
    } else {
      result = await pool.query(
        `SELECT * FROM matches WHERE owner_token = $1 ORDER BY updated_at DESC`,
        [req.deviceToken]
      );
    }
    return res.json(result.rows);
  } catch (err) {
    console.error('[matches] GET error', err.message);
    return res.status(500).json({ error: 'Failed to fetch matches', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/matches
 * Auth: Bearer required
 * Body: Match (full payload, UUIDv4 id from client)
 * Upserts on id. Sets owner_token from the authenticated device token.
 * Returns HTTP 403 if the match already exists and belongs to a different token.
 */
router.post('/', requireAuth, async (req, res) => {
  const m = req.body;
  if (!m || !m.id) {
    return res.status(400).json({ error: 'Missing match id', code: 'MISSING_ID' });
  }

  try {
    // Check if match exists and is owned by someone else
    const existing = await pool.query(
      'SELECT owner_token FROM matches WHERE id = $1',
      [m.id]
    );
    if (existing.rowCount > 0 && existing.rows[0].owner_token !== req.deviceToken) {
      return res.status(403).json({ error: 'Match owned by another device', code: 'FORBIDDEN' });
    }

    const result = await pool.query(
      `INSERT INTO matches (
        id, tournament_id, team1_id, team2_id, toss_winner_id, toss_decision,
        overs_limit, players_per_team, status, result_text, winner_id, owner_token
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        tournament_id    = EXCLUDED.tournament_id,
        team1_id         = EXCLUDED.team1_id,
        team2_id         = EXCLUDED.team2_id,
        toss_winner_id   = EXCLUDED.toss_winner_id,
        toss_decision    = EXCLUDED.toss_decision,
        overs_limit      = EXCLUDED.overs_limit,
        players_per_team = EXCLUDED.players_per_team,
        status           = EXCLUDED.status,
        result_text      = EXCLUDED.result_text,
        winner_id        = EXCLUDED.winner_id,
        updated_at       = NOW()
      RETURNING *`,
      [
        m.id,
        m.tournament_id ?? null,
        m.team1_id ?? null,
        m.team2_id ?? null,
        m.toss_winner_id ?? null,
        m.toss_decision ?? null,
        m.overs_limit ?? 20,
        m.players_per_team ?? 11,
        m.status ?? 'setup',
        m.result_text ?? null,
        m.winner_id ?? null,
        req.deviceToken,
      ]
    );
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('[matches] POST error', err.message);
    if (err.code === '23514') {
      return res.status(400).json({ error: err.message, code: 'CONSTRAINT_VIOLATION' });
    }
    return res.status(500).json({ error: 'Failed to upsert match', code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/matches/:id/events?since_seq=N
 * Auth: Bearer required
 * Returns match events ordered by seq ASC where seq > N (default 0).
 */
router.get('/:id/events', requireAuth, async (req, res) => {
  const matchId = req.params.id;
  const sinceSeq = parseInt(req.query.since_seq ?? '0', 10);

  try {
    // Verify match exists
    const matchCheck = await pool.query('SELECT id FROM matches WHERE id = $1', [matchId]);
    if (matchCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
    }

    const result = await pool.query(
      `SELECT * FROM match_events WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [matchId, sinceSeq]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[matches] GET events error', err.message);
    return res.status(500).json({ error: 'Failed to fetch events', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/matches/:id/events
 * Auth: Bearer required
 * Body: Array<MatchEvent> — up to 50 items per batch.
 * Idempotent: INSERT ... ON CONFLICT (match_id, seq) DO NOTHING.
 * Returns { inserted: N, skipped: M }.
 * Returns 403 if the calling device is not the match owner.
 * Returns 409 if the entire batch was already present (all duplicates).
 * Broadcasts each inserted event over WebSocket to match:<id> subscribers.
 */
router.post('/:id/events', requireAuth, async (req, res) => {
  const matchId = req.params.id;
  const events = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'Body must be a non-empty array of events', code: 'INVALID_BODY' });
  }
  if (events.length > 50) {
    return res.status(400).json({ error: 'Batch size exceeds limit of 50', code: 'BATCH_TOO_LARGE' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check match ownership
    const matchResult = await client.query(
      'SELECT id, owner_token FROM matches WHERE id = $1',
      [matchId]
    );
    if (matchResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found', code: 'NOT_FOUND' });
    }
    if (matchResult.rows[0].owner_token !== req.deviceToken) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the match owner can post events', code: 'FORBIDDEN' });
    }

    let inserted = 0;
    let skipped = 0;
    const insertedEvents = [];

    for (const ev of events) {
      if (ev.seq == null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each event must have a seq field', code: 'MISSING_SEQ' });
      }

      const r = await client.query(
        `INSERT INTO match_events (
          id, match_id, innings_number, over_number, ball_in_over,
          event_type, runs, extra_type, extra_runs, dismissal_type,
          batsman_id, bowler_id, fielder_id, seq, payload, ts, type
        ) VALUES (
          COALESCE($1, gen_random_uuid()), $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17
        )
        ON CONFLICT (match_id, seq) DO NOTHING
        RETURNING *`,
        [
          ev.id ?? null,
          matchId,
          ev.innings_number ?? 0,
          ev.over_number ?? 0,
          ev.ball_in_over ?? 0,
          ev.event_type ?? ev.type ?? 'runs',
          ev.runs ?? 0,
          ev.extra_type ?? null,
          ev.extra_runs ?? 0,
          ev.dismissal_type ?? null,
          ev.batsman_id ?? null,
          ev.bowler_id ?? null,
          ev.fielder_id ?? null,
          ev.seq,
          ev.payload ? JSON.stringify(ev.payload) : null,
          ev.ts ?? null,
          ev.type ?? null,
        ]
      );

      if (r.rowCount > 0) {
        inserted++;
        insertedEvents.push(r.rows[0]);
      } else {
        skipped++;
      }
    }

    await client.query('COMMIT');

    // Return 409 if entire batch was duplicate
    if (inserted === 0 && skipped > 0) {
      return res.status(409).json({ inserted: 0, skipped, message: 'All events already exist' });
    }

    // Broadcast newly inserted events to WebSocket subscribers
    for (const ev of insertedEvents) {
      broadcast(matchId, ev);
    }

    return res.json({ inserted, skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[matches] POST events error', err.message);
    return res.status(500).json({ error: 'Failed to insert events', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

export default router;
