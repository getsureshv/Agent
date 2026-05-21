import { auth } from '/shared/auth.js';
import { api } from '/shared/api.js';
import { el, clear, toast } from '/shared/ui.js';
import { renderProfile } from './views/profile.js';

const state = { user: null, players: [] };

async function refreshMe() {
  try {
    const r = await auth.me();
    state.user = r.user;
    state.players = r.players || [];
  } catch {
    state.user = null;
    state.players = [];
  }
}

async function loadConfig() {
  try { window.appConfig = await api.get('/api/v3/config'); }
  catch { window.appConfig = { emailConfigured: false }; }
}

function renderTopbar() {
  const nav = document.getElementById('user-nav');
  clear(nav);
  if (!state.user) return;
  nav.appendChild(el('span', { class: 'who' }, state.user.name || state.user.email));
  nav.appendChild(el('button', {
    onClick: async () => {
      try { await auth.logout(); } catch {}
      state.user = null; state.players = [];
      window.location.href = '/app/#/login';
    },
  }, 'Sign out'));
}

const ctx = {
  get user() { return state.user; },
  get players() { return state.players; },
  toast,
};

async function route() {
  const view = document.getElementById('view');
  clear(view);

  // Player SPA requires auth — bounce to admin login when missing.
  if (!state.user) {
    const back = encodeURIComponent(location.href);
    window.location.href = `/app/#/login?back=${back}`;
    return;
  }

  const hash = location.hash || '#/profile';
  const m = hash.match(/^#\/([^/]+)(?:\/([^?]+))?/);
  const route = m ? m[1] : 'profile';
  const rest = m && m[2] ? m[2] : '';

  if (route === 'profile') {
    // /profile  → first linked player (or 404 message)
    // /profile/:id → specific (must belong to me)
    if (rest) return renderProfile(view, ctx, rest);
    const first = state.players[0];
    if (!first) {
      view.appendChild(el('div', { class: 'card' }, [
        el('h2', {}, 'No player profile linked'),
        el('p', { class: 'muted' },
          "You're signed in, but no player profile is associated with this account yet. " +
          'Ask a team captain to invite you, then come back here to complete your profile.'),
      ]));
      return;
    }
    return renderProfile(view, ctx, first.id);
  }
  location.hash = '#/profile';
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([refreshMe(), loadConfig()]);
  renderTopbar();
  if (!location.hash) location.hash = '#/profile';
  else route();
});
