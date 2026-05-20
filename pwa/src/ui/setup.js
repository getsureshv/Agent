/**
 * src/ui/setup.js — Dev 5
 * Match setup + tournament setup screens.
 * Replaces inline setup/toss/player-entry logic from app.js.
 */

import { showScreen } from './screens.js';
import { showModal, hideModal } from './modal.js';

// Lazy Dev 2 imports
async function getStore() {
  try { return await import('../state/store.js'); }
  catch (_) { return { match: null, tournament: null, setMatch() {}, setTournament() {} }; }
}
async function getMatchRepo() {
  try { return await import('../storage/matchRepo.js'); }
  catch (_) { return { saveMatch: async () => {} }; }
}
async function getTournamentRepo() {
  try { return await import('../storage/tournamentRepo.js'); }
  catch (_) { return { saveTournament: async () => {} }; }
}
async function getUUID() {
  try { const m = await import('../utils/uuid.js'); return m.newUUID; }
  catch (_) { return () => crypto.randomUUID?.() || Math.random().toString(36).slice(2); }
}

/** Wire all setup-screen and tournament-setup-screen events. */
export function initSetup() {
  _initMatchSetup();
  _initTournamentSetup();
  _initPlayersScreen();
}

// ── Match Setup ──────────────────────────────────────────────────────────────

function _initMatchSetup() {
  const team1Input = document.getElementById('team1-name');
  const team2Input = document.getElementById('team2-name');

  team1Input?.addEventListener('input', _updateTossLabels);
  team2Input?.addEventListener('input', _updateTossLabels);

  document.getElementById('next-to-players-btn')?.addEventListener('click', _goToPlayerEntry);
  document.getElementById('back-to-setup-btn')?.addEventListener('click', () => showScreen('setup-screen'));
}

function _updateTossLabels() {
  const t1 = document.getElementById('team1-name')?.value.trim() || 'Team A';
  const t2 = document.getElementById('team2-name')?.value.trim() || 'Team B';
  const label1 = document.getElementById('toss-team1-label');
  const label2 = document.getElementById('toss-team2-label');
  if (!label1 || !label2) return;
  const radio1 = label1.querySelector('input');
  const radio2 = label2.querySelector('input');
  label1.innerHTML = '';
  if (radio1) label1.appendChild(radio1);
  label1.append(' ' + t1);
  label2.innerHTML = '';
  if (radio2) label2.appendChild(radio2);
  label2.append(' ' + t2);
}

function _goToPlayerEntry() {
  const team1 = document.getElementById('team1-name')?.value.trim() || 'Team A';
  const team2 = document.getElementById('team2-name')?.value.trim() || 'Team B';
  const playersPerTeam = parseInt(document.getElementById('players-per-team')?.value) || 11;

  const h1 = document.getElementById('team1-players-heading');
  const h2 = document.getElementById('team2-players-heading');
  if (h1) h1.textContent = team1;
  if (h2) h2.textContent = team2;

  _buildPlayerInputs('team1-player-inputs', team1, playersPerTeam);
  _buildPlayerInputs('team2-player-inputs', team2, playersPerTeam);

  showScreen('players-screen');
}

function _buildPlayerInputs(containerId, teamName, count) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'player-input-row';
    row.innerHTML = `<span>${i + 1}.</span>
      <input type="text" placeholder="${teamName} Player ${i + 1}" value="">`;
    container.appendChild(row);
  }
}

/** Read player names from a container of input rows */
export function readPlayerNames(containerId, teamName, count) {
  const container = document.getElementById(containerId);
  if (!container) return Array.from({ length: count }, (_, i) => `${teamName} Player ${i + 1}`);
  const inputs = container.querySelectorAll('input');
  return Array.from(inputs).map((inp, i) => inp.value.trim() || `${teamName} Player ${i + 1}`);
}

/** Pre-fill player inputs (used by tournament flow) */
export function prefillPlayerInputs(team1Players, team2Players) {
  setTimeout(() => {
    const t1Inputs = document.getElementById('team1-player-inputs')?.querySelectorAll('input') ?? [];
    const t2Inputs = document.getElementById('team2-player-inputs')?.querySelectorAll('input') ?? [];
    team1Players?.forEach((name, i) => { if (t1Inputs[i]) t1Inputs[i].value = name; });
    team2Players?.forEach((name, i) => { if (t2Inputs[i]) t2Inputs[i].value = name; });
  }, 0);
}

// ── Players Screen ───────────────────────────────────────────────────────────

function _initPlayersScreen() {
  document.getElementById('start-match-btn')?.addEventListener('click', _startMatch);
  document.getElementById('back-to-setup-btn')?.addEventListener('click', () => showScreen('setup-screen'));
}

async function _startMatch() {
  const team1 = document.getElementById('team1-name')?.value.trim() || 'Team A';
  const team2 = document.getElementById('team2-name')?.value.trim() || 'Team B';
  const oversLimit = parseInt(document.getElementById('overs-limit')?.value) || 20;
  const playersPerTeam = parseInt(document.getElementById('players-per-team')?.value) || 11;
  const tossWinner = document.querySelector('input[name="toss-winner"]:checked')?.value || 'team1';
  const tossDecision = document.querySelector('input[name="toss-decision"]:checked')?.value || 'bat';

  const team1Players = readPlayerNames('team1-player-inputs', team1, playersPerTeam);
  const team2Players = readPlayerNames('team2-player-inputs', team2, playersPerTeam);

  let battingFirst, bowlingFirst, battingPlayers, bowlingPlayers;
  if (tossWinner === 'team1') {
    if (tossDecision === 'bat') {
      battingFirst = team1; bowlingFirst = team2;
      battingPlayers = team1Players; bowlingPlayers = team2Players;
    } else {
      battingFirst = team2; bowlingFirst = team1;
      battingPlayers = team2Players; bowlingPlayers = team1Players;
    }
  } else {
    if (tossDecision === 'bat') {
      battingFirst = team2; bowlingFirst = team1;
      battingPlayers = team2Players; bowlingPlayers = team1Players;
    } else {
      battingFirst = team1; bowlingFirst = team2;
      battingPlayers = team1Players; bowlingPlayers = team2Players;
    }
  }

  const newUUID = await getUUID();
  const matchData = {
    id: newUUID(),
    team1, team2, oversLimit, playersPerTeam,
    innings: [],
    currentInnings: 0,
    battingFirstTeam: battingFirst,
    bowlingFirstTeam: bowlingFirst,
    team1Players, team2Players,
  };

  const store = await getStore();
  store.setMatch(matchData);

  const repo = await getMatchRepo();
  try { await repo.saveMatch(matchData); } catch (_) {}

  // Dispatch event for scoring screen to pick up
  window.dispatchEvent(new CustomEvent('match:start', { detail: matchData }));

  showScreen('scoring-screen');
}

// ── Tournament Setup ─────────────────────────────────────────────────────────

function _initTournamentSetup() {
  document.getElementById('back-to-home-btn')?.addEventListener('click', () =>
    showScreen('home-screen', { clearStack: true })
  );
  document.getElementById('next-to-teams-btn')?.addEventListener('click', _saveTournamentSetupAndContinue);
}

async function _saveTournamentSetupAndContinue() {
  const name     = document.getElementById('tournament-name')?.value.trim();
  const format   = document.getElementById('tournament-format')?.value || 'league';
  const overs    = parseInt(document.getElementById('tournament-overs')?.value) || 10;
  const players  = parseInt(document.getElementById('tournament-players')?.value) || 11;
  const squad    = parseInt(document.getElementById('tournament-squad-size')?.value) || 15;

  if (!name) {
    alert('Please enter a tournament name.');
    return;
  }

  const newUUID = await getUUID();
  const tournamentData = {
    id: newUUID(),
    name,
    format,
    overs_per_innings: overs,
    players_per_team: players,
    squad_size: squad,
    status: 'setup',
    teams: [],
    fixtures: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const store = await getStore();
  store.setTournament(tournamentData);

  const repo = await getTournamentRepo();
  try { await repo.saveTournament(tournamentData); } catch (_) {}

  window.dispatchEvent(new CustomEvent('tournament:created', { detail: tournamentData }));
  showScreen('team-setup-screen');
}
