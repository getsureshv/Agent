import { api } from '/shared/api.js';
import { el, fmtDate, toast } from '/shared/ui.js';

export async function renderFixture(view, ctx, fixtureId) {
  let fixture;
  try {
    fixture = (await api.get(`/api/v3/fixtures/${fixtureId}`)).fixture;
  } catch (err) {
    view.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  view.appendChild(el('div', { class: 'row' }, [
    el('a', { href: '#/dashboard', class: 'muted' }, '← Back'),
  ]));
  view.appendChild(el('h1', {}, `${fixture.team_a_name} vs ${fixture.team_b_name}`));
  view.appendChild(el('p', { class: 'muted' }, `${fixture.tournament_name} · status: ${fixture.status}`));

  const meta = el('div', { class: 'card' }, [
    el('div', { class: 'list-row' }, [
      el('div', { class: 'body' }, [
        el('strong', {}, 'When'),
        el('div', { class: 'sub' }, fixture.scheduled_at ? fmtDate(fixture.scheduled_at) : 'Time TBD'),
      ]),
    ]),
    el('div', { class: 'list-row' }, [
      el('div', { class: 'body' }, [
        el('strong', {}, 'Venue'),
        el('div', { class: 'sub' }, fixture.venue || 'TBD'),
      ]),
    ]),
    el('div', { class: 'list-row' }, [
      el('div', { class: 'body' }, [
        el('strong', {}, 'Scorer'),
        el('div', { class: 'sub' },
          fixture.scorer_name
            ? `${fixture.scorer_name} (${fixture.scorer_email})`
            : 'Unassigned'),
      ]),
    ]),
  ]);
  view.appendChild(meta);

  const scoreBtn = el('button', {
    class: 'btn',
    onClick: async () => {
      try {
        let matchId = fixture.match_id;
        if (!matchId) {
          const r = await (await fetch(`/api/v3/fixtures/${fixture.id}/match`,
            { method: 'POST', credentials: 'include' })).json();
          if (!r.match_id) {
            toast(r.error || 'Could not start scoring', 'error');
            return;
          }
          matchId = r.match_id;
        }
        location.hash = `#/matches/${matchId}/score`;
      } catch (err) {
        toast(err.message || 'Could not start scoring', 'error');
      }
    },
  }, fixture.match_id ? 'Open scoring' : 'Score this match');
  view.appendChild(el('div', { class: 'row', style: 'margin-top: 16px;' }, [scoreBtn]));
}
