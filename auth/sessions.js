import { pool } from '../db.js';

export const COOKIE_NAME = 'cs_session';
const SESSION_DAYS = 30;

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

export async function createSession(userId, userAgent) {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `INSERT INTO sessions (user_id, expires_at, user_agent)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, expiresAt, userAgent || null]
  );
  return result.rows[0].id;
}

export async function getSessionUser(sessionId) {
  if (!sessionId) return null;
  // Validate UUID shape to avoid pg type errors on malformed cookies
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture_url, u.is_global_admin, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
      LIMIT 1`,
    [sessionId]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(sessionId).catch(() => {});
    return null;
  }
  // Best-effort last-seen update; don't await failures
  pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [sessionId])
    .catch(() => {});
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture_url: row.picture_url,
    is_global_admin: row.is_global_admin,
  };
}

export async function destroySession(sessionId) {
  if (!sessionId) return;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}
