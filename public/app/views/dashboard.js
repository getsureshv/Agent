import { api } from '/shared/api.js';
import { el, modal, clear } from '/shared/ui.js';

export async function renderDashboard(view, ctx) {
  view.appendChild(el('div', { class: 'row' }, [
    el('h1', {}, 'My Tournaments'),
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'btn',
      onClick: () => showCreateModal(ctx),
    }, '+ Create Tournament'),
  ]));

  const listEl = el('div', { class: 'tournament-grid' });
  view.appendChild(listEl);

  try {
    const r = await api.get('/api/v3/tournaments');
    if (r.tournaments.length === 0) {
      view.appendChild(el('p', { class: 'muted' },
        'No tournaments yet. Create one to get started.'));
      return;
    }
    for (const t of r.tournaments) {
      const isOwner = t.owner_user_id === ctx.user.id;
      listEl.appendChild(el('div', {
        class: 'card tournament-card',
        onClick: () => ctx.navigate(`#/tournaments/${t.id}`),
      }, [
        el('div', { class: 'row' }, [
          el('strong', {}, t.name),
          el('div', { class: 'spacer' }),
          el('span', { class: `badge status-${t.status}` }, t.status),
        ]),
        el('div', { class: 'sub muted', style: 'margin-top: 8px; font-size: 0.82rem;' },
          `${t.format} · ${t.overs_per_innings} overs · ${t.players_per_team} per side`),
        el('div', { style: 'margin-top: 8px;' }, [
          el('span', { class: `badge role-${isOwner ? 'owner' : 'member'}` },
            isOwner ? 'Owner' : 'Member'),
        ]),
      ]));
    }
  } catch (err) {
    view.appendChild(el('p', { class: 'err' }, err.message));
  }
}

function showCreateModal(ctx) {
  const errBox = el('div', { class: 'err' });
  const name = el('input', { type: 'text', required: true });
  const format = el('select', {}, [
    el('option', { value: 'league' }, 'League (round-robin)'),
    el('option', { value: 'knockout' }, 'Knockout'),
  ]);
  const overs = el('input', { type: 'number', min: '1', max: '50', value: '20' });
  const ppt = el('input', { type: 'number', min: '2', max: '15', value: '11' });
  const squad = el('input', { type: 'number', min: '2', max: '25', value: '15' });
  const isPublicInput = el('input', { type: 'checkbox', checked: true, id: 'is-public' });

  const body = el('div', {}, [
    el('label', {}, 'Tournament name'), name,
    el('label', {}, 'Format'), format,
    el('label', {}, 'Overs per innings'), overs,
    el('label', {}, 'Players per side'), ppt,
    el('label', {}, 'Squad size'), squad,
    el('div', { class: 'checkbox-row' }, [
      isPublicInput,
      el('label', { for: 'is-public', style: 'margin: 0;' }, 'Public viewer link'),
    ]),
    errBox,
  ]);

  modal('Create Tournament', body, [
    { label: 'Cancel', class: 'btn btn-secondary', onClick: (close) => close() },
    {
      label: 'Create',
      class: 'btn',
      onClick: async (close) => {
        errBox.textContent = '';
        if (!name.value.trim()) { errBox.textContent = 'Name required'; return; }
        try {
          const r = await api.post('/api/v3/tournaments', {
            name: name.value.trim(),
            format: format.value,
            overs_per_innings: parseInt(overs.value, 10) || 20,
            players_per_team: parseInt(ppt.value, 10) || 11,
            squad_size: parseInt(squad.value, 10) || 15,
            is_public: isPublicInput.checked,
          });
          close();
          ctx.navigate(`#/tournaments/${r.tournament.id}`);
        } catch (err) {
          errBox.textContent = err.message;
        }
      },
    },
  ]);
}
