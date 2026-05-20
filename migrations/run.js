/**
 * Standalone migration runner.
 * Usage: node migrations/run.js
 * Also called from server.js at boot via runMigrations() exported from db.js.
 */
import 'dotenv/config';
import { runMigrations } from '../db.js';

try {
  await runMigrations();
  console.log('[migrate] all migrations complete');
  process.exit(0);
} catch (err) {
  console.error('[migrate] unexpected error', err);
  process.exit(1);
}
