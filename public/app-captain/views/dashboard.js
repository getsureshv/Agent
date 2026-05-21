import { api } from '/shared/api.js';
import { el, fmtDate } from '/shared/ui.js';

export async function renderDashboard(view, ctx) {
  view.appendChild(el('h1', {}, `Hello, ${ctx.user.name || ctx.user.email}`));

  // ── My Teams (where I'm captain) ─────────────────────────────────
  view.appendChild(el('h2', {}, 'My teams'));
  const teamsBox = el('div', {});
  view.appendChild(teamsBox);

  // ── My Fixtures (where I'm scorer) ───────────────────────────────
  view.appendChild(el('h2', { style: 'margin-top: 24px;' }, 'My fixtures (as scorer)'));
  const fixBox = el('div', {});
  view.appendChild(fixBox);

  try {
    const tList = await api.get('/api/v3/tournaments');
    const tournaments = tList.tournaments || [];

    // For each tournament I have a role in, pull teams + fixtures, then filter.
    const myTeams = [];
    const myFixtures = [];
    for (const t of tournaments) {
      try {
        const tRes = await api.get(`/api/v3/tournaments/${t.id}/teams`);
        for (const team of tRes.teams || []) {
          if (team.captain_user_id === ctx.user.id) {
            myTeams.push({ team, tournament: t });
          }
        }
      } catch { /* membership may not extend to teams list — skip */ }
      try {
        const fRes = await api.get(`/api/v3/tournaments/${t.id}/fixtures`);
        for (const f of fRes.fixtures || []) {
          if (f.scorer_user_id === ctx.user.id) {
            myFixtures.push({ fixture: f, tournament: t });
          }
        }
      } catch { /* same — fixtures may also be member-gated */ }
    }

    if (myTeams.length === 0) {
      teamsBox.appendChild(el('p', { class: 'muted' },
        'You are not the captain of any team yet. Ask the tournament organiser to send you a captain invite.'));
    } else {
      const card = el('div', { class: 'card' });
      for (const { team, tournament } of myTeams) {
        card.appendChild(el('div', { class: 'list-row' }, [
          el('div', { class: 'body' }, [
            el('strong', {}, team.name),
            el('div', { class: 'sub' }, `${tournament.name} · ${tournament.format} · ${tournament.overs_per_innings} overs`),
          ]),
          el('a', { href: `#/teams/${team.id}`, class: 'btn btn-sm' }, 'Open roster'),
        ]));
      }
      teamsBox.appendChild(card);
    }

    if (myFixtures.length === 0) {
      fixBox.appendChild(el('p', { class: 'muted' },
        'No fixtures assigned to you as scorer.'));
    } else {
      const card = el('div', { class: 'card' });
      for (const { fixture, tournament } of myFixtures) {
        const sub = [
          fixture.scheduled_at ? fmtDate(fixture.scheduled_at) : 'Time TBD',
          fixture.venue || 'Venue TBD',
          tournament.name,
        ].join(' · ');
        card.appendChild(el('div', { class: 'list-row' }, [
          el('div', { class: 'body' }, [
            el('strong', {}, `${fixture.team_a_name} vs ${fixture.team_b_name}`),
            el('div', { class: 'sub' }, sub),
          ]),
          el('span', { class: `badge status-${fixture.status}` }, fixture.status),
          el('a', { href: `#/fixtures/${fixture.id}`, class: 'btn btn-sm' }, 'Open'),
        ]));
      }
      fixBox.appendChild(card);
    }
  } catch (err) {
    view.appendChild(el('p', { class: 'err' }, err.message));
  }
}
