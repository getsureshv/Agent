import { auth } from '/shared/auth.js';
import { el, clear, toast } from '/shared/ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTeam } from './views/team-detail.js';
import { renderFixture } from './views/fixture-detail.js';
import { renderScoreMatch } from './views/score-match.js';

const state = { user: null };

async function refreshMe() {
  try {
    const r = await auth.me();
    state.user = r.user;
  } catch {
    state.user = null;
  }
}

function renderTopbar() {
  const nav = document.getElementById('user-nav');
  clear(nav);
  if (!state.user) return;
  nav.appendChild(el('span', { class: 'who' }, state.user.name || state.user.email));
  nav.appendChild(el('button', {
    onClick: async () => {
      try { await auth.logout(); } catch {}
      state.user = null;
      // Captain SPA has no login view of its own; bounce to the admin login.
      window.location.href = '/app/#/login';
    },
  }, 'Sign out'));
}

const ctx = {
  get user() { return state.user; },
  refreshMe: async () => { await refreshMe(); renderTopbar(); },
  navigate: (hash) => { location.hash = hash; },
  toast,
};

async function route() {
  const view = document.getElementById('view');
  clear(view);

  // Captain SPA requires auth. If not logged in, bounce to admin login
  // — that page returns the user to wherever they were trying to go via
  // the cookie. Keep the original captain URL in hash so we can return.
  if (!state.user) {
    const back = encodeURIComponent(location.href);
    window.location.href = `/app/#/login?back=${back}`;
    return;
  }

  const hash = location.hash || '#/dashboard';
  const m = hash.match(/^#\/([^/]+)(?:\/([^?]+))?/);
  const route = m ? m[1] : 'dashboard';
  const rest = m && m[2] ? m[2] : '';

  if (route === 'dashboard') return renderDashboard(view, ctx);
  if (route === 'teams' && rest)    return renderTeam(view, ctx, rest);
  if (route === 'fixtures' && rest) return renderFixture(view, ctx, rest);
  if (route === 'matches' && rest) {
    // matches/<id>/score (or matches/<id> later, when we add a read-only view)
    const [id, sub] = rest.split('/');
    if (sub === 'score') return renderScoreMatch(view, ctx, id);
  }

  location.hash = '#/dashboard';
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  await refreshMe();
  renderTopbar();
  if (!location.hash) location.hash = '#/dashboard';
  else route();
});
