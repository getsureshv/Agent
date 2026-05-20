import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build SSL config for Railway (or any postgres with ssl)
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require'))
    ? { rejectUnauthorized: false }
    : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig || undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error', err.message);
});

/**
 * Run all migrations/*.sql files in sorted order.
 * Each file is wrapped in a transaction. Idempotent — uses IF NOT EXISTS everywhere.
 * Called at boot; never throws (logs errors and continues).
 */
export async function runMigrations() {
  const dir = path.join(__dirname, 'migrations');
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  } catch (e) {
    console.warn('[migrate] migrations directory not found, skipping:', e.message);
    return;
  }

  for (const file of files) {
    const sqlPath = path.join(dir, file);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('[migrate] applied', file);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[migrate] FAILED on', file, '—', err.message);
      // Do not re-throw — never fail boot
    } finally {
      client.release();
    }
  }
}
