/**
 * src/ui/screens.js — Dev 5
 * Screen management: showScreen(), initUI(), back-stack.
 * Called by src/main.js after storage + sync init.
 */

// Valid screen IDs per INTERFACES.md
const VALID_SCREENS = [
  'home-screen',
  'tournament-setup-screen',
  'team-setup-screen',
  'team-players-screen',
  'tournament-dashboard-screen',
  'setup-screen',
  'players-screen',
  'scoring-screen',
  'result-screen',
  'settings-screen',
  'signin-screen',
];

/** Back stack — allows browser-like back navigation on mobile */
const _backStack = [];

/**
 * Show a screen by id. Hides all others.
 * Pushes previous screen onto back stack (unless navigating back).
 * @param {string} id  — one of VALID_SCREENS
 * @param {object} [opts]
 * @param {boolean} [opts.clearStack]  — reset back stack (e.g. going Home)
 * @param {boolean} [opts.isBack]      — called from back(), don't push again
 */
export function showScreen(id, opts = {}) {
  const target = document.getElementById(id);
  if (!target) {
    console.warn(`[screens] showScreen: unknown id "${id}"`);
    return;
  }

  // Track current active screen for back stack
  const current = document.querySelector('.screen.active');
  const currentId = current ? current.id : null;

  if (!opts.isBack && currentId && currentId !== id) {
    if (opts.clearStack) {
      _backStack.length = 0;
    } else {
      _backStack.push(currentId);
    }
  }

  // Swap active class
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  target.classList.add('active');

  // Scroll to top on screen change (important on mobile)
  target.scrollTop = 0;
  window.scrollTo(0, 0);

  // Side-effects per screen
  _onScreenChange(id);
}

/**
 * Navigate back to the previous screen in the stack.
 * Falls back to home-screen.
 */
export function goBack() {
  const prev = _backStack.pop() || 'home-screen';
  showScreen(prev, { isBack: true });
}

/** Returns the current active screen id */
export function currentScreen() {
  const el = document.querySelector('.screen.active');
  return el ? el.id : null;
}

/**
 * Side-effects triggered on each screen transition.
 * Kept here so showScreen() remains the single source of truth.
 */
function _onScreenChange(id) {
  // Show/hide tournament back button on scoring screen
  const tournamentBackBtn = document.getElementById('scoring-back-to-tournament-btn');
  if (tournamentBackBtn) {
    // Will be controlled by scoring.js once match state is available;
    // default to hidden here.
    if (id !== 'scoring-screen') {
      tournamentBackBtn.classList.add('hidden');
    }
  }

  // Update browser history state for PWA back-gesture support
  try {
    history.replaceState({ screen: id }, '', '#' + id);
  } catch (_) { /* ignore in restricted contexts */ }
}

/**
 * initUI() — called by src/main.js.
 * Sets up global back-button / popstate handler.
 */
export function initUI() {
  // Handle Android hardware back button / browser back via popstate
  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.screen) {
      showScreen(e.state.screen, { isBack: true });
    } else {
      goBack();
    }
  });

  // Wire up any elements with data-back-btn attribute
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-back-btn]')) {
      e.preventDefault();
      goBack();
    }
  });

  // Navigate to home screen as the initial state
  showScreen('home-screen', { clearStack: true });
}
