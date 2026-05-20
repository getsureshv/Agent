/**
 * src/ui/tournament-ui.js — Dev 5
 * Tournament dashboard: fixtures list, points table, roster editor.
 * Rendered inside #tournament-dashboard-screen tabs.
 */

import { showScreen } from './screens.js';
import { openRosterEditor } from './teams.js';
import { showModal, hideModal } from './modal.js';

async function getStore() {
  try { return await import('../state/store.js'); }
  catch (_) { return { tournament: null, currentFixtureIndex: -1 }; }
}
async function getTournamentRepo() {
  try { return await import('../storage/tournamentRepo.js'); }
  catch (_) { return { saveTournament: async () => {} }; }
}

export function initTournamentUI() {
  _initTabs();
  _initNavButtons();
  _initSquadSelectModal();

  // Re-render when tournament opens
  window.addEventListener('tournament:open',     (e) => _renderDashboard(e.detail));
  window.addEventListener('tournament:fixtures', (e) => _renderDashboard(e.detail));
  window.addEventListener('tournament:created',  (e) => _renderDashboard(e.detail));
  window.addEventListener('tournament:updated',  (e) => _renderDashboard(e.detail));
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function _initTabs() {
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.tab-btn');
    if (!tabBtn) return;
    const tab = tabBtn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tabBtn.classList.add('active');
    document.getElementById(`tab-${tab}`)?.classList.add('active');
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────

function _initNavButtons() {
  document.getElementById('back-to-home-from-dashboard-btn')?.addEventListener('click', () =>
    showScreen('home-screen', { clearStack: true })
  );
}

// ── Dashboard render ──────────────────────────────────────────────────────────

async function _renderDashboard(tournament) {
  if (!tournament) {
    const store = await getStore();
    tournament = store.tournament;
  }
  if (!tournament) return;

  const title = document.getElementById('tournament-dashboard-title');
  if (title) title.textContent = tournament.name;

  _renderFixtures(tournament);
  _renderPointsTable(tournament);
  _renderTeamsTab(tournament);
}

function _renderFixtures(t) {
  const container = document.getElementById('fixtures-list');
  if (!container) return;
  container.innerHTML = '';

  if (!t.fixtures?.length) {
    container.innerHTML = '<p class="empty-state">No fixtures yet.</p>';
    return;
  }

  t.fixtures.forEach((fixture, idx) => {
    const card = document.createElement('div');
    card.className = 'fixture-card' + (fixture.played ? ' fixture-played' : '') + (fixture.inProgress ? ' fixture-in-progress' : '');
    card.innerHTML = `
      <div class="fixture-teams">
        <span class="fixture-team">${_esc(fixture.team1)}</span>
        <span class="fixture-vs">vs</span>
        <span class="fixture-team">${_esc(fixture.team2)}</span>
      </div>
      ${fixture.played
        ? `<div class="fixture-result">${_esc(fixture.result || 'Played')}</div>`
        : fixture.inProgress
          ? `<div class="fixture-live">LIVE: ${_esc(fixture.liveScore || '')}</div>`
          : ''}
      <div class="fixture-actions">
        ${!fixture.played
          ? `<button class="btn btn-primary btn-small start-fixture-btn" data-idx="${idx}">Start Match</button>`
          : `<button class="btn btn-secondary btn-small view-fixture-btn" data-idx="${idx}">View</button>`}
      </div>`;
    container.appendChild(card);
  });

  container.addEventListener('click', async (e) => {
    const startBtn = e.target.closest('.start-fixture-btn');
    if (startBtn) {
      const idx = parseInt(startBtn.dataset.idx);
      await _startFixtureMatch(t, idx);
    }
  });
}

async function _startFixtureMatch(t, fixtureIdx) {
  const fixture = t.fixtures[fixtureIdx];
  if (!fixture) return;

  // Check if both teams have players — if squad_size set, show squad-select modal
  const team1Obj = t.teams?.find((x) => x.name === fixture.team1);
  const team2Obj = t.teams?.find((x) => x.name === fixture.team2);

  if (team1Obj?.players?.length && team2Obj?.players?.length) {
    _openSquadSelect(t, fixture, fixtureIdx, team1Obj, team2Obj);
  } else {
    // Use default setup screen for quick player entry
    const store = await getStore();
    store.setTournament?.(t);
    _prefillSetupForFixture(t, fixture);

    const { prefillPlayerInputs } = await import('./setup.js').catch(() => ({ prefillPlayerInputs: () => {} }));
    prefillPlayerInputs(team1Obj?.players, team2Obj?.players);

    // Store pending fixture index
    if (typeof store.setCurrentFixtureIndex === 'function') {
      store.setCurrentFixtureIndex(fixtureIdx);
    } else {
      store.currentFixtureIndex = fixtureIdx;
    }
    showScreen('setup-screen');
  }
}

function _prefillSetupForFixture(t, fixture) {
  const t1 = document.getElementById('team1-name');
  const t2 = document.getElementById('team2-name');
  const overs = document.getElementById('overs-limit');
  const players = document.getElementById('players-per-team');
  if (t1) { t1.value = fixture.team1; t1.readOnly = true; }
  if (t2) { t2.value = fixture.team2; t2.readOnly = true; }
  if (overs) { overs.value = t.overs_per_innings || 10; overs.readOnly = true; }
  if (players) { players.value = t.players_per_team || 11; players.readOnly = true; }
}

// ── Points Table ──────────────────────────────────────────────────────────────

function _renderPointsTable(t) {
  const container = document.getElementById('points-table-container');
  if (!container) return;

  if (!t.teams?.length) {
    container.innerHTML = '<p class="empty-state">No teams added yet.</p>';
    return;
  }

  // Compute standings
  const standings = _computeStandings(t);

  let html = `<table class="points-table">
    <thead><tr>
      <th>Team</th><th>P</th><th>W</th><th>L</th><th>Pts</th><th>NRR</th>
    </tr></thead><tbody>`;

  standings.forEach((row) => {
    html += `<tr>
      <td class="team-name-cell">${_esc(row.name)}</td>
      <td>${row.played}</td><td>${row.won}</td><td>${row.lost}</td>
      <td><strong>${row.points}</strong></td>
      <td>${row.nrr >= 0 ? '+' : ''}${row.nrr.toFixed(3)}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  container.innerHTML = html;
}

function _computeStandings(t) {
  const map = {};
  (t.teams || []).forEach((team) => {
    map[team.name] = { name: team.name, played: 0, won: 0, lost: 0, points: 0, runsFor: 0, runsAgainst: 0, oversFor: 0, oversAgainst: 0 };
  });

  (t.fixtures || []).filter((f) => f.played && f.winner).forEach((f) => {
    const t1 = map[f.team1]; const t2 = map[f.team2];
    if (!t1 || !t2) return;
    t1.played++; t2.played++;
    if (f.winner === f.team1) { t1.won++; t1.points += 2; t2.lost++; }
    else { t2.won++; t2.points += 2; t1.lost++; }
    // NRR approximation from stored run data
    if (f.team1Runs && f.team2Runs) {
      t1.runsFor += f.team1Runs; t1.runsAgainst += f.team2Runs;
      t1.oversFor += f.team1Overs || 1; t1.oversAgainst += f.team2Overs || 1;
      t2.runsFor += f.team2Runs; t2.runsAgainst += f.team1Runs;
      t2.oversFor += f.team2Overs || 1; t2.oversAgainst += f.team1Overs || 1;
    }
  });

  return Object.values(map)
    .map((row) => ({
      ...row,
      nrr: row.oversFor > 0 && row.oversAgainst > 0
        ? (row.runsFor / row.oversFor) - (row.runsAgainst / row.oversAgainst)
        : 0,
    }))
    .sort((a, b) => b.points - a.points || b.nrr - a.nrr);
}

// ── Teams Tab ─────────────────────────────────────────────────────────────────

function _renderTeamsTab(t) {
  const container = document.getElementById('dashboard-teams-list');
  if (!container) return;
  container.innerHTML = '';

  if (!t.teams?.length) {
    container.innerHTML = '<p class="empty-state">No teams.</p>';
    return;
  }

  t.teams.forEach((team) => {
    const card = document.createElement('div');
    card.className = 'team-card';
    card.innerHTML = `
      <div class="team-card-info">
        <span class="team-card-name">${_esc(team.name)}</span>
        <span class="team-card-count">${(team.players || []).length} players</span>
      </div>
      <button class="btn btn-secondary btn-small edit-roster-btn" data-team-id="${_esc(team.id)}">Edit Roster</button>`;
    container.appendChild(card);
  });

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.edit-roster-btn');
    if (btn) openRosterEditor(btn.dataset.teamId);
  });
}

// ── Squad Select Modal ────────────────────────────────────────────────────────

let _pendingFixtureData = null;

function _openSquadSelect(t, fixture, fixtureIdx, team1Obj, team2Obj) {
  _pendingFixtureData = { t, fixture, fixtureIdx, team1Obj, team2Obj };

  const subtitle = document.getElementById('squad-select-subtitle');
  if (subtitle) subtitle.textContent = `Pick ${t.players_per_team || 11} players from each squad`;

  const h1 = document.getElementById('squad-select-team1-heading');
  const h2 = document.getElementById('squad-select-team2-heading');
  if (h1) h1.textContent = team1Obj.name;
  if (h2) h2.textContent = team2Obj.name;

  _renderSquadList('squad-select-team1', team1Obj.players || [], t.players_per_team || 11);
  _renderSquadList('squad-select-team2', team2Obj.players || [], t.players_per_team || 11);

  showModal('squad-select-modal');
}

function _renderSquadList(containerId, players, maxSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  players.forEach((name) => {
    const row = document.createElement('label');
    row.className = 'squad-player-row';
    row.innerHTML = `<input type="checkbox" value="${_esc(name)}"> ${_esc(name)}`;
    container.appendChild(row);
  });
  // Enforce max selection
  container.addEventListener('change', () => {
    const checked = container.querySelectorAll('input:checked');
    if (checked.length >= maxSelect) {
      container.querySelectorAll('input:not(:checked)').forEach((cb) => cb.disabled = true);
    } else {
      container.querySelectorAll('input').forEach((cb) => cb.disabled = false);
    }
  });
}

function _initSquadSelectModal() {
  document.getElementById('confirm-squad-btn')?.addEventListener('click', async () => {
    if (!_pendingFixtureData) return;
    const { t, fixture, fixtureIdx, team1Obj, team2Obj } = _pendingFixtureData;

    const t1Selected = Array.from(
      document.querySelectorAll('#squad-select-team1 input:checked')
    ).map((cb) => cb.value);
    const t2Selected = Array.from(
      document.querySelectorAll('#squad-select-team2 input:checked')
    ).map((cb) => cb.value);

    const playersNeeded = t.players_per_team || 11;
    if (t1Selected.length < playersNeeded || t2Selected.length < playersNeeded) {
      alert(`Please select exactly ${playersNeeded} players from each team.`);
      return;
    }

    hideModal('squad-select-modal');

    // Prefill setup screen with selected players
    _prefillSetupForFixture(t, fixture);
    const { prefillPlayerInputs } = await import('./setup.js').catch(() => ({ prefillPlayerInputs: () => {} }));
    const store = await getStore();
    store.setTournament?.(t);
    if (typeof store.setCurrentFixtureIndex === 'function') {
      store.setCurrentFixtureIndex(fixtureIdx);
    }

    const { readPlayerNames, buildPlayerInputs } = await import('./setup.js').catch(() => ({}));
    // Build player inputs first
    const t1Heading = document.getElementById('team1-players-heading');
    const t2Heading = document.getElementById('team2-players-heading');
    if (t1Heading) t1Heading.textContent = fixture.team1;
    if (t2Heading) t2Heading.textContent = fixture.team2;
    prefillPlayerInputs(t1Selected, t2Selected);

    showScreen('players-screen');
    _pendingFixtureData = null;
  });

  document.getElementById('cancel-squad-btn')?.addEventListener('click', () =>
    hideModal('squad-select-modal')
  );
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
