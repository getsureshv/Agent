import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { requireUser } from '../auth/middleware.js';
import { requireTournamentOwner } from '../auth/tournament_access.js';

const router = Router({ mergeParams: true });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rowToInvite(r) {
  let status;
  if (r.consumed_at) status = 'consumed';
  else if (r.revoked_at) status = 'revoked';
  else if (new Date(r.expires_at).getTime() < Date.now()) status = 'expired';
  else status = 'pending';
  return {
    id: r.id,
    token: r.token,
    tournament_id: r.tournament_id,
    email: r.email,
    role: r.role,
    team_id: r.team_id,
    team_name: r.team_name || null,
    invited_by: r.invited_by,
    consumed_at: r.consumed_at,
    consumed_by: r.consumed_by,
    revoked_at: r.revoked_at || null,
    expires_at: r.expires_at,
    created_at: r.created_at,
    status,
  };
}

function redirectAfter(inv) {
  return inv.role === 'captain' ? '/app/captain/#/dashboard' : '/app/#/dashboard';
}

function shareUrlFor(req, token) {
  const base = process.env.PUBLIC_BASE_URL
    || (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
        ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
        : `${req.protocol}://${req.get('host')}`);
  return `${base}/invite/${token}`;
}

// POST /api/v3/tournaments/:tid/invites
router.post('/', requireUser, requireTournamentOwner, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = req.body?.role;
  const teamId = req.body?.team_id || null;

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email', code: 'INVALID_INPUT' });
  if (!['captain', 'scorer'].includes(role)) {
    return res.status(400).json({ error: "role must be 'captain' or 'scorer'", code: 'INVALID_INPUT' });
  }
  if (role === 'captain' && !teamId) {
    return res.status(400).json({ error: 'team_id required for captain invites', code: 'INVALID_INPUT' });
  }
  if (teamId && !/^[0-9a-f-]{36}$/i.test(teamId)) {
    return res.status(400).json({ error: 'invalid team_id', code: 'INVALID_INPUT' });
  }

  const client = await pool.connect();
  try {
    if (teamId) {
      const t = await client.query(
        'SELECT 1 FROM v3_teams WHERE id = $1 AND tournament_id = $2',
        [teamId, req.tournament.id]
      );
      if (t.rowCount === 0) {
        return res.status(400).json({ error: 'team is not in this tournament', code: 'INVALID_INPUT' });
      }
    }

    await client.query('BEGIN');

    // Auto-revoke any pending, unexpired captain invites already issued for
    // this team. Keeps "one live captain invite per team" as an invariant.
    let revoked = 0;
    if (role === 'captain' && teamId) {
      const rev = await client.query(
        `UPDATE v3_invites
            SET revoked_at = NOW()
          WHERE team_id = $1
            AND role = 'captain'
            AND consumed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > NOW()`,
        [teamId]
      );
      revoked = rev.rowCount;
    }

    const token = crypto.randomBytes(18).toString('base64url');
    const r = await client.query(
      `INSERT INTO v3_invites (token, tournament_id, email, role, team_id, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [token, req.tournament.id, email, role, teamId, req.user.id]
    );
    await client.query('COMMIT');
    return res.json({
      invite_id: r.rows[0].id,
      token,
      share_url: shareUrlFor(req, token),
      revoked_previous: revoked,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_invites] create', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

// GET /api/v3/tournaments/:tid/invites
router.get('/', requireUser, requireTournamentOwner, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.*, t.name AS team_name
         FROM v3_invites i
         LEFT JOIN v3_teams t ON t.id = i.team_id
        WHERE i.tournament_id = $1
        ORDER BY i.created_at DESC`,
      [req.tournament.id]
    );
    const invites = r.rows.map(rowToInvite).map((inv) => ({
      ...inv,
      share_url: shareUrlFor(req, inv.token),
    }));
    return res.json({ invites });
  } catch (err) {
    console.error('[v3_invites] list', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// DELETE /api/v3/tournaments/:tid/invites/:inviteId
router.delete('/:inviteId', requireUser, requireTournamentOwner, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM v3_invites WHERE id = $1 AND tournament_id = $2',
      [req.params.inviteId, req.tournament.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Invite not found', code: 'NOT_FOUND' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[v3_invites] delete', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ── Top-level accept flow (mounted separately at /api/v3/invites) ───
const acceptRouter = Router();

// GET /api/v3/invites/:token  — public
acceptRouter.get('/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.email, i.role, i.expires_at, i.consumed_at, i.revoked_at,
              t.id AS tournament_id, t.name AS tournament_name,
              te.name AS team_name
         FROM v3_invites i
         JOIN v3_tournaments t ON t.id = i.tournament_id
         LEFT JOIN v3_teams te ON te.id = i.team_id
        WHERE i.token = $1
        LIMIT 1`,
      [req.params.token]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Invite not found', code: 'NOT_FOUND' });
    const row = r.rows[0];
    if (row.revoked_at) {
      return res.status(410).json({
        error: 'This invite was superseded by a newer one. Ask the admin for the new link.',
        code: 'REVOKED',
      });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Invite expired', code: 'EXPIRED' });
    }
    return res.json({
      tournament_id: row.tournament_id,
      tournament_name: row.tournament_name,
      role: row.role,
      team_name: row.team_name,
      email: row.email,
      expires_at: row.expires_at,
      already_consumed: !!row.consumed_at,
      redirect_to: row.role === 'captain' ? '/app/captain/' : '/app/',
    });
  } catch (err) {
    console.error('[v3_invites] get', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// POST /api/v3/invites/:token/accept
acceptRouter.post('/:token/accept', requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT * FROM v3_invites WHERE token = $1 FOR UPDATE',
      [req.params.token]
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found', code: 'NOT_FOUND' });
    }
    const inv = r.rows[0];
    if (inv.consumed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Invite already consumed', code: 'CONSUMED' });
    }
    if (inv.revoked_at) {
      await client.query('ROLLBACK');
      return res.status(410).json({
        error: 'This invite was superseded by a newer one. Ask the admin for the new link.',
        code: 'REVOKED',
      });
    }
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Invite expired', code: 'EXPIRED' });
    }
    if (inv.email.toLowerCase() !== req.user.email.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: `This invite was sent to ${inv.email}; please log in as that user`,
        code: 'EMAIL_MISMATCH',
      });
    }

    if (inv.role === 'captain') {
      if (!inv.team_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Captain invite is missing team_id', code: 'INVALID_INVITE' });
      }
      // Only claim the captaincy if the slot is empty (or already this user).
      const claim = await client.query(
        `UPDATE v3_teams
            SET captain_user_id = $1, updated_at = NOW()
          WHERE id = $2 AND (captain_user_id IS NULL OR captain_user_id = $1)`,
        [req.user.id, inv.team_id]
      );
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This team already has a captain.',
          code: 'TEAM_HAS_CAPTAIN',
        });
      }
    }
    // scorer invites: nothing to mutate beyond stamping the invite.

    await client.query(
      'UPDATE v3_invites SET consumed_at = NOW(), consumed_by = $1 WHERE id = $2',
      [req.user.id, inv.id]
    );
    await client.query('COMMIT');
    return res.json({
      ok: true,
      tournament_id: inv.tournament_id,
      role: inv.role,
      team_id: inv.team_id,
      redirect_to: redirectAfter(inv),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_invites] accept', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

export { acceptRouter };
export default router;
