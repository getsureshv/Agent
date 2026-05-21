import { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { requireUser } from '../auth/middleware.js';
import {
  requireTournamentMember,
  requireTeamCaptainOrAdmin,
} from '../auth/tournament_access.js';
import { buildShareUrl } from '../lib/util.js';

const ROLES = new Set(['batsman', 'bowler', 'all-rounder', 'wicket-keeper', null, undefined, '']);

// Slim cricket-only fields a captain may edit. Anything else (profile
// detail, verification, link to a user) is admin-only.
const CAPTAIN_FIELDS = new Set([
  'name', 'jersey_number', 'batting_order', 'is_wicket_keeper',
  'is_captain', 'role', 'notes',
]);

const CATEGORIES = new Set(['mens', 'womens', 'youth', 'mixed', null, '']);
const BATTING_STYLES = new Set(['right_hand', 'left_hand', null, '']);
const BOWLING_STYLES = new Set(['right_arm', 'left_arm', 'none', null, '']);
const BOWLING_TYPES = new Set([
  'fast', 'fast_medium', 'medium', 'medium_fast',
  'off_spin', 'leg_spin', 'left_arm_orthodox', 'left_arm_chinaman', 'none',
  null, '',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    player_code: r.player_code,
    profile_status: r.profile_status,
    is_verified: r.is_verified,
    verified_at: r.verified_at,
    verified_by_user_id: r.verified_by_user_id,
    user_id: r.user_id,
    created_by_user_id: r.created_by_user_id,
    profile_invite_id: r.profile_invite_id,
    profile_updated_at: r.profile_updated_at,
    // DCL profile fields
    first_name: r.first_name,
    middle_name: r.middle_name,
    last_name: r.last_name,
    display_name: r.display_name,
    category: r.category,
    nationality: r.nationality,
    date_of_birth: r.date_of_birth,
    is_student: r.is_student,
    address_line1: r.address_line1,
    address_line2: r.address_line2,
    city: r.city,
    state_region: r.state_region,
    country: r.country,
    postal_code: r.postal_code,
    registered_email: r.registered_email,
    phone_number: r.phone_number,
    whatsapp_number: r.whatsapp_number,
    emergency_contact_name: r.emergency_contact_name,
    emergency_contact_number: r.emergency_contact_number,
    batting_style: r.batting_style,
    bowling_style: r.bowling_style,
    bowling_type: r.bowling_type,
    is_certified_umpire: r.is_certified_umpire,
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

// POST /api/v3/teams/:teamId/players — captain or owner adds a placeholder.
// New rows get a generated player_code and profile_status='placeholder'.
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

  const firstName = b.first_name ? String(b.first_name).trim() : null;
  const lastName  = b.last_name  ? String(b.last_name).trim()  : null;

  try {
    const r = await pool.query(
      `INSERT INTO v3_players
         (team_id, name, jersey_number, batting_order, is_wicket_keeper, is_captain,
          role, notes, first_name, last_name,
          player_code, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               gen_player_code(), $11)
       RETURNING *`,
      [
        req.team.id, name,
        Number.isInteger(b.jersey_number) ? b.jersey_number : null,
        battingOrder,
        !!b.is_wicket_keeper, !!b.is_captain,
        role || null, b.notes ? String(b.notes) : null,
        firstName, lastName,
        req.user.id,
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

// Resolve player → team_id (+ tournament_id), then run downstream auth.
async function loadPlayerTeam(req, res, next) {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
    return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
  }
  const r = await pool.query(
    `SELECT p.*, te.tournament_id, t.owner_user_id
       FROM v3_players p
       JOIN v3_teams te ON te.id = p.team_id
       JOIN v3_tournaments t ON t.id = te.tournament_id
      WHERE p.id = $1`,
    [id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Player not found', code: 'NOT_FOUND' });
  req._player = r.rows[0];
  req.params.teamId = r.rows[0].team_id;
  req.params.tid    = r.rows[0].tournament_id;
  next();
}

// GET /api/v3/players/:id — tournament member only (no public read).
playerRouter.get('/:id', requireUser, loadPlayerTeam, requireTournamentMember, (req, res) => {
  return res.json({ player: rowToPlayer(req._player) });
});

// PATCH /api/v3/players/:id — slim cricket fields only (captain or admin).
// Any profile-field key in the body triggers 403.
playerRouter.patch('/:id', requireUser, loadPlayerTeam, requireTeamCaptainOrAdmin, async (req, res) => {
  const b = req.body || {};
  // Reject any key not in the captain-editable set.
  const offending = Object.keys(b).filter((k) => !CAPTAIN_FIELDS.has(k));
  if (offending.length > 0) {
    return res.status(403).json({
      error: `Profile fields can only be updated via PATCH /players/:id/profile (rejected: ${offending.join(', ')})`,
      code: 'FORBIDDEN_PROFILE_FIELDS',
    });
  }

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

// PATCH /api/v3/players/:id/profile — player self-edit OR admin.
playerRouter.patch('/:id/profile', requireUser, loadPlayerTeam, async (req, res) => {
  if (!(req.user.is_global_admin || req._player.user_id === req.user.id)) {
    return res.status(403).json({
      error: 'You can only edit your own profile (or admin)',
      code: 'FORBIDDEN',
    });
  }

  const b = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  function set(c, v) { fields.push(`${c} = $${i++}`); values.push(v); }

  function trimOrNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }

  if ('first_name'   in b) set('first_name',   trimOrNull(b.first_name));
  if ('middle_name'  in b) set('middle_name',  trimOrNull(b.middle_name));
  if ('last_name'    in b) set('last_name',    trimOrNull(b.last_name));
  if ('display_name' in b) set('display_name', trimOrNull(b.display_name));

  if ('category' in b) {
    if (b.category !== null && !CATEGORIES.has(b.category)) {
      return res.status(400).json({ error: 'invalid category', code: 'INVALID_INPUT' });
    }
    set('category', b.category || null);
  }

  if ('nationality' in b) set('nationality', trimOrNull(b.nationality));

  if ('date_of_birth' in b) {
    if (b.date_of_birth === null || b.date_of_birth === '') set('date_of_birth', null);
    else {
      const d = new Date(b.date_of_birth);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid date_of_birth', code: 'INVALID_INPUT' });
      set('date_of_birth', b.date_of_birth);
    }
  }

  if ('is_student' in b)          set('is_student', !!b.is_student);
  if ('address_line1' in b)       set('address_line1', trimOrNull(b.address_line1));
  if ('address_line2' in b)       set('address_line2', trimOrNull(b.address_line2));
  if ('city' in b)                set('city', trimOrNull(b.city));
  if ('state_region' in b)        set('state_region', trimOrNull(b.state_region));
  if ('country' in b)             set('country', trimOrNull(b.country));
  if ('postal_code' in b)         set('postal_code', trimOrNull(b.postal_code));
  if ('registered_email' in b) {
    const v = trimOrNull(b.registered_email);
    if (v !== null && !EMAIL_RE.test(v)) {
      return res.status(400).json({ error: 'invalid registered_email', code: 'INVALID_INPUT' });
    }
    set('registered_email', v);
  }
  if ('phone_number' in b)              set('phone_number', trimOrNull(b.phone_number));
  if ('whatsapp_number' in b)           set('whatsapp_number', trimOrNull(b.whatsapp_number));
  if ('emergency_contact_name' in b)    set('emergency_contact_name', trimOrNull(b.emergency_contact_name));
  if ('emergency_contact_number' in b)  set('emergency_contact_number', trimOrNull(b.emergency_contact_number));

  if ('batting_style' in b) {
    if (b.batting_style !== null && !BATTING_STYLES.has(b.batting_style)) {
      return res.status(400).json({ error: 'invalid batting_style', code: 'INVALID_INPUT' });
    }
    set('batting_style', b.batting_style || null);
  }
  if ('bowling_style' in b) {
    if (b.bowling_style !== null && !BOWLING_STYLES.has(b.bowling_style)) {
      return res.status(400).json({ error: 'invalid bowling_style', code: 'INVALID_INPUT' });
    }
    set('bowling_style', b.bowling_style || null);
  }
  if ('bowling_type' in b) {
    if (b.bowling_type !== null && !BOWLING_TYPES.has(b.bowling_type)) {
      return res.status(400).json({ error: 'invalid bowling_type', code: 'INVALID_INPUT' });
    }
    set('bowling_type', b.bowling_type || null);
  }
  if ('is_certified_umpire' in b) set('is_certified_umpire', !!b.is_certified_umpire);

  // Cricket-role lives on the slim model; the profile editor offers it too.
  if ('role' in b) {
    if (b.role !== null && b.role !== '' && !ROLES.has(b.role)) {
      return res.status(400).json({ error: 'invalid role', code: 'INVALID_INPUT' });
    }
    set('role', b.role || null);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'no profile fields supplied', code: 'INVALID_INPUT' });
  }
  fields.push('profile_updated_at = NOW()', 'updated_at = NOW()');
  values.push(req._player.id);

  try {
    const r = await pool.query(
      `UPDATE v3_players SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return res.json({ player: rowToPlayer(r.rows[0]) });
  } catch (err) {
    console.error('[v3_players] update profile', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// POST /api/v3/players/:id/invite — captain or admin issues a player invite.
playerRouter.post('/:id/invite', requireUser, loadPlayerTeam, requireTeamCaptainOrAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid email', code: 'INVALID_INPUT' });
  }
  if (req._player.user_id) {
    return res.status(409).json({
      error: 'This player profile is already linked to a user',
      code: 'PLAYER_HAS_USER',
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Auto-revoke any prior pending player invites for this player.
    const rev = await client.query(
      `UPDATE v3_invites
          SET revoked_at = NOW()
        WHERE player_id = $1
          AND role = 'player'
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()`,
      [req._player.id]
    );

    const token = crypto.randomBytes(18).toString('base64url');
    const ins = await client.query(
      `INSERT INTO v3_invites
         (token, tournament_id, email, role, team_id, player_id, invited_by)
       VALUES ($1, $2, $3, 'player', $4, $5, $6)
       RETURNING id`,
      [token, req._player.tournament_id, email, req._player.team_id, req._player.id, req.user.id]
    );
    await client.query(
      `UPDATE v3_players
          SET profile_invite_id = $1,
              profile_status = 'invited',
              updated_at = NOW()
        WHERE id = $2`,
      [ins.rows[0].id, req._player.id]
    );
    await client.query('COMMIT');
    return res.json({
      invite_id: ins.rows[0].id,
      token,
      share_url: buildShareUrl(req, `/invite/${token}`),
      revoked_previous: rev.rowCount,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[v3_players] invite', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

// POST /api/v3/players/:id/verify — admin only.
// Allowed only from profile_status='self_registered'.
playerRouter.post('/:id/verify', requireUser, loadPlayerTeam, async (req, res) => {
  if (!req.user.is_global_admin) {
    return res.status(403).json({ error: 'Admin only', code: 'FORBIDDEN' });
  }
  if (req._player.profile_status !== 'self_registered') {
    return res.status(409).json({
      error: `Cannot verify a player in status ${req._player.profile_status}`,
      code: 'INVALID_STATE',
    });
  }
  try {
    const r = await pool.query(
      `UPDATE v3_players
          SET is_verified = TRUE,
              verified_at = NOW(),
              verified_by_user_id = $1,
              profile_status = 'verified',
              updated_at = NOW()
        WHERE id = $2
       RETURNING *`,
      [req.user.id, req._player.id]
    );
    return res.json({ player: rowToPlayer(r.rows[0]) });
  } catch (err) {
    console.error('[v3_players] verify', err.message);
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
