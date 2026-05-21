import { auth } from '/shared/auth.js';
import { api } from '/shared/api.js';
import { el, clear, toast } from '/shared/ui.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTournament } from './views/tournament-detail.js';
import { renderAcceptInvite } from './views/accept-invite.js';

const state = { user: null, appConfig: { emailConfigured: false, publicBaseUrl: null } };

async function loadConfig() {
  try {
    state.appConfig = await api.get('/api/v3/config');
  } catch {
    state.appConfig = { emailConfigured: false, publicBaseUrl: null };
  }
  // Expose for ad-hoc debugging; ctx.appConfig is the supported accessor.
  window.appConfig = state.appConfig;
}

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
  nav.appendChild(el('span', { class: 'who' }, `${state.user.name || state.user.email}${state.user.is_global_admin ? ' (admin)' : ''}`));
  nav.appendChild(el('button', {
    onClick: async () => {
      try { await auth.logout(); } catch {}
      state.user = null;
      location.hash = '#/login';
      renderTopbar();
    },
  }, 'Sign out'));
}

const ctx = {
  get user() { return state.user; },
  get appConfig() { return state.appConfig; },
  refreshMe: async () => { await refreshMe(); renderTopbar(); },
  navigate: (hash) => { location.hash = hash; },
  toast,
};

async function route() {
  const view = document.getElementById('view');
  clear(view);

  // Deep link: /invite/<token> → redirect to hash route
  const pathname = location.pathname;
  if (pathname.startsWith('/invite/')) {
    const token = pathname.slice('/invite/'.length).replace(/\/+$/, '');
    history.replaceState(null, '', '/app/' + (location.search || ''));
    location.hash = `#/invite/${encodeURIComponent(token)}`;
    return; // hashchange handler will re-run
  }

  const hash = location.hash || '#/dashboard';
  const m = hash.match(/^#\/([^/]+)(?:\/(.+))?$/);
  const route = m ? m[1] : 'dashboard';
  const rest = m ? (m[2] || '') : '';

  // Routes that don't require auth
  if (route === 'invite') {
    return renderAcceptInvite(view, ctx, decodeURIComponent(rest));
  }
  if (route === 'login') {
    return renderLogin(view, ctx);
  }

  if (!state.user) {
    location.hash = '#/login';
    return;
  }

  if (route === 'dashboard') return renderDashboard(view, ctx);
  if (route === 'tournaments' && rest) return renderTournament(view, ctx, rest);

  // Unknown route → dashboard
  location.hash = '#/dashboard';
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([refreshMe(), loadConfig()]);
  renderTopbar();
  // Initial route — preserve hash if present, else /invite path was just rewritten,
  // else default to dashboard (which redirects to login if logged out).
  if (!location.hash) location.hash = '#/dashboard';
  else route();
});
