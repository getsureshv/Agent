/**
 * src/state/store.js
 * In-memory reactive store for current match and tournament state.
 *
 * Dev 5 (UI) and Dev 4 (Sync) read these values directly.
 * Dev 2's engine.js and repos call setMatch / setTournament.
 *
 * Shape mirrors the existing app.js globals so no destructuring changes
 * are needed when Dev 5 integrates.
 */

/** @type {import('../storage/types.d.ts').MatchState | null} */
export let match = null;

/** @type {import('../storage/types.d.ts').TournamentState | null} */
export let tournament = null;

/**
 * Index of the currently active fixture within tournament.fixtures.
 * -1 means no active fixture (quick match or not started).
 * @type {number}
 */
export let currentFixtureIndex = -1;

// ── Listeners ──────────────────────────────────────────────────────────────
/** @type {Array<(m: import('../storage/types.d.ts').MatchState | null) => void>} */
const matchListeners = [];

/** @type {Array<(t: import('../storage/types.d.ts').TournamentState | null) => void>} */
const tournamentListeners = [];

// ── Setters ────────────────────────────────────────────────────────────────

/**
 * Replace the current in-memory match.
 * @param {import('../storage/types.d.ts').MatchState} m
 */
export function setMatch(m) {
  match = m;
  matchListeners.forEach(fn => fn(match));
}

/**
 * Replace the current in-memory tournament.
 * @param {import('../storage/types.d.ts').TournamentState} t
 */
export function setTournament(t) {
  tournament = t;
  tournamentListeners.forEach(fn => fn(tournament));
}

/**
 * Clear the current in-memory match and reset fixture index.
 */
export function clearMatch() {
  match = null;
  currentFixtureIndex = -1;
  matchListeners.forEach(fn => fn(null));
}

/**
 * Set the current fixture index (used when starting a tournament match).
 * @param {number} idx
 */
export function setCurrentFixtureIndex(idx) {
  currentFixtureIndex = idx;
}

// ── Subscriptions ──────────────────────────────────────────────────────────

/**
 * Subscribe to match state changes.
 * Returns an unsubscribe function.
 * @param {(m: import('../storage/types.d.ts').MatchState | null) => void} fn
 * @returns {() => void}
 */
export function onMatchChange(fn) {
  matchListeners.push(fn);
  return () => {
    const i = matchListeners.indexOf(fn);
    if (i !== -1) matchListeners.splice(i, 1);
  };
}

/**
 * Subscribe to tournament state changes.
 * Returns an unsubscribe function.
 * @param {(t: import('../storage/types.d.ts').TournamentState | null) => void} fn
 * @returns {() => void}
 */
export function onTournamentChange(fn) {
  tournamentListeners.push(fn);
  return () => {
    const i = tournamentListeners.indexOf(fn);
    if (i !== -1) tournamentListeners.splice(i, 1);
  };
}
