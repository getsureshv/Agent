/**
 * src/ui/teams.js — Dev 5
 * Team & player management screens:
 *   - team-setup-screen (add teams to tournament)
 *   - team-players-screen (add players to a specific team)
 *   - tournament-dashboard-screen team tab
 */

import { showScreen } from './screens.js';
import { showModal, hideModal } from './modal.js';

async function getStore() {
  try { return await import('../state/store.js'); }
  catch (_) { return { tournament: null, setTournament() {} }; }
}
async function getTournamentRepo() {
  try { return await import('../storage/tournamentRepo.js'); }
  catch (_) { return { saveTournament: async () => {} }; }
}
async function getUUID() {
  try { const m = await import('../utils/uuid.js'); return m.newUUID; }
  catch (_) { return () => crypto.randomUUID?.() || Math.random().toString(36).slice(2); }
}

/** Current team being edited in team-players-screen */
let _editingTeamIndex = -1;

export function initTeams() {
  _initTeamSetupScreen();
  _initTeamPlayersScreen();
  _initRosterEditor();
}

// ── Team Setup Screen ────────────────────────────────────────────────────────

function _initTeamSetupScreen() {
  document.getElementById('back-to-tournament-setup-btn')?.addEventListener('click', () =>
    showScreen('tournament-setup-screen')
  );
  document.getElementById('add-team-btn')?.addEventListener('click', _addTeam);
  document.getElementById('new-team-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _addTeam();
  });
  document.getElementById('generate-fixtures-btn')?.addEventListener('click', _generateFixtures);

  // Refresh teams list when screen shown
  window.addEventListener('tournament:created', () => _renderTeamsList());
  window.addEventListener('tournament:open', () => _renderTeamsList());
}

async function _addTeam() {
  const input = document.getElementById('new-team-name-input');
  const name = input?.value.trim();
  if (!name) { alert('Please enter a team name.'); return; }

  const store = await getStore();
  const t = store.tournament;
  if (!t) return;

  const newUUID = await getUUID();
  const team = {
    id: newUUID(),
    tournament_id: t.id,
    name,
    players: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  t.teams = t.teams || [];
  t.teams.push(team);
  store.setTournament(t);

  const repo = await getTournamentRepo();
  try { await repo.saveTournament(t); } catch (_) {}

  if (input) input.value = '';
  _renderTeamsList();
}

async function _renderTeamsList() {
  const store = await getStore();
  const t = store.tournament;
  const list = document.getElementById('teams-list');
  if (!list) return;
  list.innerHTML = '';
  if (!t?.teams?.length) {
    list.innerHTML = '<p class="empty-state">No teams yet. Add a team above.</p>';
    return;
  }
  t.teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `
      <span class="team-row-name">${_esc(team.name)}</span>
      <span class="team-row-count">${(team.players || []).length} players</span>
      <div class="team-row-actions">
        <button class="btn btn-secondary btn-small" data-team-idx="${idx}">Add Players</button>
        <button class="btn btn-danger btn-small delete-team-btn" data-team-idx="${idx}" aria-label="Remove team">&#10005;</button>
      </div>`;
    list.appendChild(row);
  });

  list.addEventListener('click', async (e) => {
    const addBtn = e.target.closest('[data-team-idx]:not(.delete-team-btn)');
    const delBtn = e.target.closest('.delete-team-btn');
    if (addBtn) {
      _editingTeamIndex = parseInt(addBtn.dataset.teamIdx);
      _openTeamPlayersScreen(t.teams[_editingTeamIndex]);
    }
    if (delBtn) {
      const idx = parseInt(delBtn.dataset.teamIdx);
      if (confirm(`Remove "${t.teams[idx].name}"?`)) {
        t.teams.splice(idx, 1);
        store.setTournament(t);
        const repo = await getTournamentRepo();
        try { await repo.saveTournament(t); } catch (_) {}
        _renderTeamsList();
      }
    }
  }, { once: false });
}

async function _generateFixtures() {
  const store = await getStore();
  const t = store.tournament;
  if (!t?.teams?.length || t.teams.length < 2) {
    alert('Add at least 2 teams before generating fixtures.');
    return;
  }

  t.fixtures = _buildFixtures(t);
  t.status = 'active';
  t.updated_at = new Date().toISOString();
  store.setTournament(t);

  const repo = await getTournamentRepo();
  try { await repo.saveTournament(t); } catch (_) {}

  window.dispatchEvent(new CustomEvent('tournament:fixtures', { detail: t }));
  showScreen('tournament-dashboard-screen');
}

function _buildFixtures(t) {
  const teams = t.teams;
  const fixtures = [];
  if (t.format === 'knockout') {
    for (let i = 0; i < teams.length - 1; i += 2) {
      fixtures.push({ team1: teams[i].name, team2: teams[i + 1].name, played: false });
    }
  } else {
    // Round robin
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        fixtures.push({ team1: teams[i].name, team2: teams[j].name, played: false });
      }
    }
  }
  return fixtures;
}

// ── Team Players Screen ──────────────────────────────────────────────────────

function _openTeamPlayersScreen(team) {
  const heading = document.getElementById('team-players-heading');
  if (heading) heading.textContent = `${team.name} — Players`;

  const container = document.getElementById('team-players-inputs');
  if (container) {
    container.innerHTML = '';
    const maxPlayers = 15; // squad_size default
    for (let i = 0; i < maxPlayers; i++) {
      const row = document.createElement('div');
      row.className = 'player-input-row';
      row.innerHTML = `<span>${i + 1}.</span>
        <input type="text" placeholder="Player ${i + 1}" value="${_esc((team.players || [])[i] || '')}">`;
      container.appendChild(row);
    }
  }
  showScreen('team-players-screen');
}

function _initTeamPlayersScreen() {
  document.getElementById('back-to-teams-btn')?.addEventListener('click', () =>
    showScreen('team-setup-screen')
  );
  document.getElementById('save-team-players-btn')?.addEventListener('click', _saveTeamPlayers);
}

async function _saveTeamPlayers() {
  if (_editingTeamIndex < 0) return;
  const store = await getStore();
  const t = store.tournament;
  if (!t) return;

  const inputs = document.getElementById('team-players-inputs')?.querySelectorAll('input') ?? [];
  const players = Array.from(inputs)
    .map((inp) => inp.value.trim())
    .filter(Boolean);

  t.teams[_editingTeamIndex].players = players;
  t.updated_at = new Date().toISOString();
  store.setTournament(t);

  const repo = await getTournamentRepo();
  try { await repo.saveTournament(t); } catch (_) {}

  showScreen('team-setup-screen');
  _renderTeamsList();
}

// ── Roster Editor Modal ──────────────────────────────────────────────────────

let _rosterEditingTeamId = null;

function _initRosterEditor() {
  document.getElementById('close-roster-editor')?.addEventListener('click', () =>
    hideModal('roster-editor-modal')
  );
  document.getElementById('roster-add-btn')?.addEventListener('click', _rosterAddPlayer);
  document.getElementById('roster-add-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _rosterAddPlayer();
  });
  document.getElementById('save-roster-btn')?.addEventListener('click', _saveRoster);
}

export async function openRosterEditor(teamId) {
  _rosterEditingTeamId = teamId;
  const store = await getStore();
  const t = store.tournament;
  const team = t?.teams?.find((x) => x.id === teamId);
  if (!team) return;

  const title = document.getElementById('roster-editor-title');
  if (title) title.textContent = `Edit Squad — ${team.name}`;
  _renderRosterList(team.players || []);
  showModal('roster-editor-modal');
}

function _renderRosterList(players) {
  const list = document.getElementById('roster-editor-players');
  if (!list) return;
  list.innerHTML = '';
  players.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'roster-player-row';
    row.innerHTML = `
      <span class="roster-player-number">${i + 1}</span>
      <input type="text" value="${_esc(name)}" class="roster-player-input" data-idx="${i}">
      <button class="btn btn-danger btn-small roster-remove-btn" data-idx="${i}" aria-label="Remove">&times;</button>`;
    list.appendChild(row);
  });

  list.querySelectorAll('.roster-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      players.splice(idx, 1);
      _renderRosterList(players);
    });
  });
}

async function _rosterAddPlayer() {
  const input = document.getElementById('roster-add-input');
  const name = input?.value.trim();
  if (!name) return;

  const store = await getStore();
  const t = store.tournament;
  const team = t?.teams?.find((x) => x.id === _rosterEditingTeamId);
  if (!team) return;

  team.players = team.players || [];
  team.players.push(name);
  _renderRosterList(team.players);
  if (input) input.value = '';
}

async function _saveRoster() {
  const store = await getStore();
  const t = store.tournament;
  const team = t?.teams?.find((x) => x.id === _rosterEditingTeamId);
  if (!team) return;

  // Read current inputs
  const inputs = document.querySelectorAll('#roster-editor-players .roster-player-input');
  team.players = Array.from(inputs).map((inp) => inp.value.trim()).filter(Boolean);
  t.updated_at = new Date().toISOString();
  store.setTournament(t);

  const repo = await getTournamentRepo();
  try { await repo.saveTournament(t); } catch (_) {}

  hideModal('roster-editor-modal');
  window.dispatchEvent(new CustomEvent('tournament:updated', { detail: t }));
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
