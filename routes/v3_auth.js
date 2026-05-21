import { Router } from 'express';
import { pool } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  COOKIE_NAME,
  createSession,
  destroySession,
  sessionCookieOptions,
} from '../auth/sessions.js';
import { requireUser } from '../auth/middleware.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture_url: u.picture_url,
    is_global_admin: u.is_global_admin,
  };
}

// POST /api/v3/auth/signup { email, password, name }
router.post('/signup', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const name = (req.body?.name || '').toString().trim() || null;

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email', code: 'INVALID_EMAIL' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      code: 'WEAK_PASSWORD',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_TAKEN' });
    }

    // First user becomes global admin
    const countResult = await client.query('SELECT COUNT(*)::int AS n FROM users');
    const isFirstUser = countResult.rows[0].n === 0;

    const passwordHash = await hashPassword(password);
    const insert = await client.query(
      `INSERT INTO users (email, password_hash, name, is_global_admin)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, picture_url, is_global_admin`,
      [email, passwordHash, name, isFirstUser]
    );

    await client.query('COMMIT');

    const user = insert.rows[0];
    const sessionId = await createSession(user.id, req.headers['user-agent']);
    res.cookie(COOKIE_NAME, sessionId, sessionCookieOptions());
    return res.status(200).json({ user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[auth] signup error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

// POST /api/v3/auth/login { email, password }
router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!EMAIL_RE.test(email) || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password required', code: 'INVALID_INPUT' });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, name, picture_url, is_global_admin, password_hash
         FROM users
        WHERE lower(email) = $1
        LIMIT 1`,
      [email]
    );
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    }
    const user = result.rows[0];
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    }

    const sessionId = await createSession(user.id, req.headers['user-agent']);
    res.cookie(COOKIE_NAME, sessionId, sessionCookieOptions());
    return res.status(200).json({ user: publicUser(user) });
  } catch (err) {
    console.error('[auth] login error', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// POST /api/v3/auth/logout
router.post('/logout', async (req, res) => {
  const sid = req.cookies?.[COOKIE_NAME];
  try {
    await destroySession(sid);
  } catch (err) {
    console.error('[auth] logout error', err.message);
  }
  res.clearCookie(COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
  return res.status(200).json({ ok: true });
});

// GET /api/v3/auth/me
router.get('/me', requireUser, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.player_code, p.team_id, p.profile_status,
              te.name AS team_name,
              te.tournament_id, t.name AS tournament_name
         FROM v3_players p
         JOIN v3_teams te ON te.id = p.team_id
         JOIN v3_tournaments t ON t.id = te.tournament_id
        WHERE p.user_id = $1
        ORDER BY p.created_at ASC`,
      [req.user.id]
    );
    return res.status(200).json({
      user: publicUser(req.user),
      players: r.rows.map((row) => ({
        id: row.id,
        player_code: row.player_code,
        team_id: row.team_id,
        team_name: row.team_name,
        tournament_id: row.tournament_id,
        tournament_name: row.tournament_name,
        profile_status: row.profile_status,
      })),
    });
  } catch (err) {
    console.error('[v3_auth] me', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
