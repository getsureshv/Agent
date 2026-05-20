/**
 * Cricket Scorer — App Entry Point
 * Dev 1: PWA Shell
 *
 * Init order per INTERFACES.md:
 *   initDB()         → Dev 2 (src/storage/db.js)
 *   startSyncEngine() → Dev 4 (src/sync/syncEngine.js)
 *   initUI()         → Dev 5 (src/ui/screens.js)
 *
 * Each import is wrapped in try/catch so the page loads even if
 * other devs' modules have not landed yet.
 */

// ─── Module Imports ──────────────────────────────────────────────────────────

let initDB, startSyncEngine, initUI;

try {
  ({ initDB } = await import('./storage/db.js'));
} catch (e) {
  console.warn('[main] storage/db.js not yet available:', e.message);
  initDB = async () => {};
}

try {
  ({ startSyncEngine } = await import('./sync/syncEngine.js'));
} catch (e) {
  console.warn('[main] sync/syncEngine.js not yet available:', e.message);
  startSyncEngine = () => {};
}

try {
  ({ initUI } = await import('./ui/screens.js'));
} catch (e) {
  console.warn('[main] ui/screens.js not yet available:', e.message);
  initUI = async () => {};
}

// ─── Initialisation ──────────────────────────────────────────────────────────

async function init() {
  try {
    await initDB();
    console.log('[main] DB initialised');
  } catch (e) {
    console.warn('[main] initDB() failed:', e.message);
  }

  try {
    startSyncEngine();
    console.log('[main] SyncEngine started');
  } catch (e) {
    console.warn('[main] startSyncEngine() failed:', e.message);
  }

  try {
    await initUI();
    console.log('[main] UI initialised');
  } catch (e) {
    console.warn('[main] initUI() failed:', e.message);
  }
}

init();

// ─── Service Worker Registration ─────────────────────────────────────────────
// (Also inlined in index.html for browsers that don't support type=module SW,
//  but we register here too so the module pipeline can reference the SW.)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const { type } = event.data || {};
    if (type === 'app:online' || type === 'app:offline') {
      // Re-dispatch as a standard window event so Dev 4's SyncEngine can listen
      window.dispatchEvent(new Event(type));
    }
  });
}

// ─── Online / Offline Fallback ────────────────────────────────────────────────
// Also listen on window events in case the SW message doesn't arrive
// (e.g., before the SW is installed on first load).

window.addEventListener('online',  () => window.dispatchEvent(new Event('app:online')));
window.addEventListener('offline', () => window.dispatchEvent(new Event('app:offline')));
