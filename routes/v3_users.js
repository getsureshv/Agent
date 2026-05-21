import { Router } from 'express';
import { pool } from '../db.js';
import { requireUser } from '../auth/middleware.js';

const router = Router();

// GET /api/v3/users/search?q=
router.get('/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  try {
    const r = await pool.query(
      `SELECT id, email, name
         FROM users
        WHERE lower(email) LIKE $1
        ORDER BY email ASC
        LIMIT 20`,
      [q + '%']
    );
    return res.json({ users: r.rows });
  } catch (err) {
    console.error('[v3_users] search', err.message);
    return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
