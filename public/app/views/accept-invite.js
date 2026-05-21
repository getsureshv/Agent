import { api } from '/shared/api.js';
import { auth } from '/shared/auth.js';
import { el, clear, toast } from '/shared/ui.js';
import { renderLogin } from './login.js';

export async function renderAcceptInvite(view, ctx, token) {
  if (!token) {
    view.appendChild(el('p', { class: 'err' }, 'Invalid invite link.'));
    return;
  }

  let info;
  try {
    info = await api.get(`/api/v3/invites/${encodeURIComponent(token)}`);
  } catch (err) {
    view.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, 'Invite not available'),
      el('p', { class: 'muted' }, err.message),
      el('a', { href: '#/dashboard' }, 'Go to dashboard'),
    ]));
    return;
  }

  const teamPart = info.team_name ? ` for ${info.team_name}` : '';
  const intro = el('div', { class: 'card' }, [
    el('h1', {}, info.tournament_name),
    el('p', {}, `You've been invited as `, el('strong', {}, info.role), `${teamPart}.`),
    el('p', { class: 'muted' }, `Sent to: ${info.email}`),
  ]);
  view.appendChild(intro);

  if (info.already_consumed) {
    intro.appendChild(el('p', { class: 'muted' }, 'This invite has already been accepted.'));
    const target = info.redirect_to || '/app/';
    intro.appendChild(el('a', { href: target }, 'Continue'));
    return;
  }

  if (!ctx.user) {
    view.appendChild(el('p', { class: 'muted', style: 'margin-top: 16px;' },
      'Sign in or create an account to accept this invite. Use the email it was sent to.'));
    renderLogin(view, ctx, {
      email: info.email,
      subtitle: `Use the email ${info.email} so we can match the invite.`,
      onSuccess: async () => {
        await accept(view, ctx, token);
      },
    });
    return;
  }

  if (ctx.user.email.toLowerCase() !== info.email.toLowerCase()) {
    view.appendChild(el('div', { class: 'card' }, [
      el('p', {}, `This invite is for `, el('strong', {}, info.email),
        `, but you're signed in as `, el('strong', {}, ctx.user.email), `.`),
      el('button', {
        class: 'btn',
        onClick: async () => {
          try { await auth.logout(); } catch {}
          await ctx.refreshMe();
          location.hash = `#/invite/${encodeURIComponent(token)}`;
          location.reload();
        },
      }, 'Sign out and try again'),
    ]));
    return;
  }

  // Email matches — auto-accept
  await accept(view, ctx, token);
}

async function accept(view, ctx, token) {
  try {
    const r = await api.post(`/api/v3/invites/${encodeURIComponent(token)}/accept`);
    toast('Invite accepted');
    // Captain invites go to /app/captain; scorer invites stay in the admin SPA.
    if (r.redirect_to && r.redirect_to.startsWith('/app/captain')) {
      window.location.href = r.redirect_to;
      return;
    }
    ctx.navigate(`#/tournaments/${r.tournament_id}`);
  } catch (err) {
    view.appendChild(el('p', { class: 'err', style: 'margin-top: 16px;' }, err.message));
  }
}
