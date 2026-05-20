/**
 * src/ui/home.js — Dev 5
 * Home screen wiring: quick match button, new tournament, saved tournaments list.
 */

import { showScreen } from './screens.js';
import { showModal } from './modal.js';

// Lazy imports from Dev 2 — will be undefined until PR 2 lands (stub mode)
let _tournamentRepo = null;
async function getTournamentRepo() {
  if (_tournamentRepo) return _tournamentRepo;
  try {
    _tournamentRepo = await import('../storage/tournamentRepo.js');
  } catch (_) {
    _tournamentRepo = {
      loadTournaments: async () => [],
      deleteTournament: async () => {},
    };
  }
  return _tournamentRepo;
}

/** Wire up home screen event handlers. Called by initUI(). */
export function initHome() {
  const quickMatchBtn      = document.getElementById('quick-match-btn');
  const newTournamentBtn   = document.getElementById('new-tournament-btn');
  const settingsBtn        = document.getElementById('home-settings-btn');

  quickMatchBtn?.addEventListener('click', () => {
    // Clear any tournament context
    _clearTournamentContext();
    showScreen('setup-screen');
  });

  newTournamentBtn?.addEventListener('click', () => {
    showScreen('tournament-setup-screen');
  });

  settingsBtn?.addEventListener('click', () => {
    showScreen('settings-screen');
  });

  // Load & render saved tournaments on home screen show
  window.addEventListener('popstate', _maybeRefreshHome);
  document.addEventListener('home:refresh', _renderSavedTournaments);

  // Initial load
  _renderSavedTournaments();
}

/** Re-render saved tournaments list */
async function _renderSavedTournaments() {
  const section = document.getElementById('saved-tournaments-section');
  const list    = document.getElementById('saved-tournaments-list');
  if (!list || !section) return;

  const repo = await getTournamentRepo();
  let tournaments = [];
  try {
    tournaments = await repo.loadTournaments();
  } catch (e) {
    console.warn('[home] loadTournaments error:', e);
  }

  // IMPORTANT: do NOT touch section.style.display when our list is empty.
  // The legacy app.js renders its own tournaments into the same #saved-tournaments-list
  // div by reading localStorage['cricket_tournaments']. Hiding the section here would
  // wipe whatever app.js just drew. Only render when we have data of our own (Dexie).
  if (!tournaments.length) {
    return;
  }

  section.style.display = '';
  list.innerHTML = '';

  tournaments.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'tournament-card';
    card.innerHTML = `
      <div class="tournament-card-info">
        <span class="tournament-card-name">${_esc(t.name)}</span>
        <span class="tournament-card-meta">${_esc(t.format || '')} · ${t.overs_per_innings || t.oversPerInnings || '?'} ov</span>
      </div>
      <div class="tournament-card-actions">
        <button class="btn btn-primary btn-small tournament-open-btn" data-id="${_esc(t.id)}">Open</button>
        <button class="btn btn-danger btn-small tournament-delete-btn" data-id="${_esc(t.id)}" aria-label="Delete tournament">&#128465;</button>
      </div>`;
    list.appendChild(card);
  });

  // Event delegation for open/delete
  list.addEventListener('click', async (e) => {
    const openBtn   = e.target.closest('.tournament-open-btn');
    const deleteBtn = e.target.closest('.tournament-delete-btn');

    if (openBtn) {
      const id = openBtn.dataset.id;
      _openTournament(id, tournaments);
    }
    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      if (confirm('Delete this tournament? This cannot be undone.')) {
        await _deleteTournament(id);
        await _renderSavedTournaments();
      }
    }
  });
}

function _openTournament(id, tournaments) {
  const t = tournaments.find((x) => x.id === id);
  if (!t) return;
  // Store tournament in state (Dev 2 store) then navigate
  _setTournamentContext(t);
  showScreen('tournament-dashboard-screen');
  // Dispatch so tournament-ui.js can render
  window.dispatchEvent(new CustomEvent('tournament:open', { detail: t }));
}

async function _deleteTournament(id) {
  const repo = await getTournamentRepo();
  try {
    await repo.deleteTournament(id);
  } catch (e) {
    console.warn('[home] deleteTournament error:', e);
  }
}

function _clearTournamentContext() {
  try {
    // Dev 2 store
    import('../state/store.js').then(({ setTournament }) => {
      setTournament(null);
    }).catch(() => {});
  } catch (_) {}
}

function _setTournamentContext(t) {
  try {
    import('../state/store.js').then(({ setTournament }) => {
      setTournament(t);
    }).catch(() => {});
  } catch (_) {}
}

function _maybeRefreshHome(e) {
  if (e.state?.screen === 'home-screen') _renderSavedTournaments();
}

/** Escape HTML for safe insertion */
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
