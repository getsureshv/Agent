import { api } from '/shared/api.js';
import { el, clear, modal, toast } from '/shared/ui.js';

const ROLE_OPTIONS = ['', 'batsman', 'bowler', 'all-rounder', 'wicket-keeper'];

export async function renderTeam(view, ctx, teamId) {
  let team;
  try {
    team = (await api.get(`/api/v3/teams/${teamId}`)).team;
  } catch (err) {
    view.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  view.appendChild(el('div', { class: 'row' }, [
    el('a', { href: '#/dashboard', class: 'muted' }, '← Back'),
  ]));
  view.appendChild(el('h1', {}, team.name));
  view.appendChild(el('p', { class: 'muted' }, `Tournament: ${team.tournament_name}`));

  const roster = el('div', {});
  view.appendChild(roster);

  async function load() {
    clear(roster);
    let players = [];
    try {
      players = (await api.get(`/api/v3/teams/${teamId}/players`)).players;
    } catch (err) {
      roster.appendChild(el('p', { class: 'err' }, err.message));
      return;
    }

    roster.appendChild(addForm(teamId, load));

    if (players.length === 0) {
      roster.appendChild(el('p', { class: 'muted' }, 'No players yet. Add some above.'));
      return;
    }

    const tbl = el('table', { class: 'roster-table' });
    const head = el('thead', {}, el('tr', {}, [
      el('th', {}, '#'),
      el('th', {}, 'Name'),
      el('th', {}, 'Role'),
      el('th', {}, 'WK'),
      el('th', {}, 'C'),
      el('th', {}, ''),
    ]));
    tbl.appendChild(head);
    const tbody = el('tbody');
    for (const p of players) {
      tbody.appendChild(playerRow(p, load));
    }
    tbl.appendChild(tbody);
    roster.appendChild(tbl);
  }

  load();
}

function addForm(teamId, refresh) {
  const errBox = el('div', { class: 'err' });
  const name = el('input', { type: 'text', placeholder: 'Player name' });
  const order = el('input', { type: 'number', min: '1', max: '15', placeholder: '#' });
  const role = el('select', {},
    ROLE_OPTIONS.map((r) => el('option', { value: r }, r || '— role —')));
  const wk = el('input', { type: 'checkbox' });
  const cap = el('input', { type: 'checkbox' });

  const card = el('div', { class: 'card' }, [
    el('h3', {}, 'Add player'),
    el('div', { class: 'row' }, [
      name, order, role,
      el('label', { class: 'inline-check' }, [wk, ' WK']),
      el('label', { class: 'inline-check' }, [cap, ' C']),
      el('button', {
        class: 'btn',
        onClick: async () => {
          errBox.textContent = '';
          if (!name.value.trim()) { errBox.textContent = 'Name required'; return; }
          try {
            await api.post(`/api/v3/teams/${teamId}/players`, {
              name: name.value.trim(),
              batting_order: order.value ? parseInt(order.value, 10) : null,
              role: role.value || null,
              is_wicket_keeper: wk.checked,
              is_captain: cap.checked,
            });
            name.value = ''; order.value = ''; role.value = '';
            wk.checked = false; cap.checked = false;
            refresh();
          } catch (err) { errBox.textContent = err.message; }
        },
      }, 'Add'),
    ]),
    errBox,
  ]);
  return card;
}

function playerRow(p, refresh) {
  const tr = el('tr', {});
  tr.appendChild(el('td', {}, p.batting_order == null ? '' : String(p.batting_order)));
  tr.appendChild(el('td', {}, p.name));
  tr.appendChild(el('td', {}, p.role || ''));
  tr.appendChild(el('td', {}, p.is_wicket_keeper ? '✓' : ''));
  tr.appendChild(el('td', {}, p.is_captain ? 'C' : ''));
  tr.appendChild(el('td', { class: 'actions-cell' }, [
    el('button', {
      class: 'btn btn-sm btn-secondary',
      onClick: () => showEditModal(p, refresh),
    }, 'Edit'),
    el('button', {
      class: 'btn btn-sm btn-danger',
      onClick: async () => {
        if (!confirm(`Delete player "${p.name}"?`)) return;
        try {
          await api.delete(`/api/v3/players/${p.id}`);
          refresh();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Delete'),
  ]));
  return tr;
}

function showEditModal(p, refresh) {
  const errBox = el('div', { class: 'err' });
  const name = el('input', { type: 'text', value: p.name });
  const order = el('input', { type: 'number', min: '1', max: '15',
    value: p.batting_order == null ? '' : String(p.batting_order) });
  const role = el('select', {},
    ROLE_OPTIONS.map((r) => el('option', { value: r, selected: (r || null) === (p.role || null) }, r || '— role —')));
  const wk = el('input', { type: 'checkbox', checked: !!p.is_wicket_keeper });
  const cap = el('input', { type: 'checkbox', checked: !!p.is_captain });
  const notes = el('textarea', { rows: '2' });
  notes.value = p.notes || '';

  const body = el('div', {}, [
    el('label', {}, 'Name'), name,
    el('label', {}, 'Batting order (1..15)'), order,
    el('label', {}, 'Role'), role,
    el('div', { class: 'checkbox-row' }, [wk, el('label', { style: 'margin: 0;' }, 'Wicket keeper')]),
    el('div', { class: 'checkbox-row' }, [cap, el('label', { style: 'margin: 0;' }, 'Captain badge')]),
    el('label', {}, 'Notes'), notes,
    errBox,
  ]);
  modal(`Edit ${p.name}`, body, [
    { label: 'Cancel', class: 'btn btn-secondary', onClick: (close) => close() },
    {
      label: 'Save',
      class: 'btn',
      onClick: async (close) => {
        errBox.textContent = '';
        if (!name.value.trim()) { errBox.textContent = 'Name required'; return; }
        try {
          await api.patch(`/api/v3/players/${p.id}`, {
            name: name.value.trim(),
            batting_order: order.value ? parseInt(order.value, 10) : null,
            role: role.value || null,
            is_wicket_keeper: wk.checked,
            is_captain: cap.checked,
            notes: notes.value.trim() || null,
          });
          close();
          refresh();
        } catch (err) { errBox.textContent = err.message; }
      },
    },
  ]);
}
