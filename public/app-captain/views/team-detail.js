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
      el('th', {}, 'Profile'),
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

const PROFILE_BADGES = {
  placeholder:     { label: 'Placeholder',     cls: 'badge status-draft' },
  invited:         { label: 'Invited',         cls: 'badge status-pending' },
  self_registered: { label: 'Self-registered', cls: 'badge status-active' },
  verified:        { label: 'Verified ✓',      cls: 'badge status-completed' },
};

function addForm(teamId, refresh) {
  const errBox = el('div', { class: 'err' });
  const name = el('input', { type: 'text', placeholder: 'Player name' });
  const email = el('input', { type: 'email', placeholder: 'Email (optional, used for invite)' });
  const order = el('input', { type: 'number', min: '1', max: '15', placeholder: '#' });
  const role = el('select', {},
    ROLE_OPTIONS.map((r) => el('option', { value: r }, r || '— role —')));
  const wk = el('input', { type: 'checkbox' });
  const cap = el('input', { type: 'checkbox' });

  const card = el('div', { class: 'card' }, [
    el('h3', {}, 'Add player'),
    el('div', { class: 'row' }, [
      name, email, order, role,
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
              registered_email: email.value.trim() || null,
              batting_order: order.value ? parseInt(order.value, 10) : null,
              role: role.value || null,
              is_wicket_keeper: wk.checked,
              is_captain: cap.checked,
            });
            name.value = ''; email.value = ''; order.value = ''; role.value = '';
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
  // Name + small player_code + email
  tr.appendChild(el('td', {}, [
    el('div', {}, p.name),
    p.player_code
      ? el('div', { class: 'muted', style: 'font-family: monospace; font-size: 0.72rem;' }, p.player_code)
      : null,
    p.registered_email
      ? el('div', { class: 'muted', style: 'font-size: 0.72rem;' }, p.registered_email)
      : null,
  ]));
  tr.appendChild(el('td', {}, p.role || ''));
  tr.appendChild(el('td', {}, p.is_wicket_keeper ? '✓' : ''));
  tr.appendChild(el('td', {}, p.is_captain ? 'C' : ''));
  // Profile status badge
  const badge = PROFILE_BADGES[p.profile_status] || PROFILE_BADGES.placeholder;
  tr.appendChild(el('td', {}, el('span', { class: badge.cls }, badge.label)));

  const actions = [];
  if (p.profile_status === 'placeholder') {
    actions.push(el('button', {
      class: 'btn btn-sm',
      onClick: () => showInviteModal(p, refresh),
    }, 'Invite'));
  } else if (p.profile_status === 'invited') {
    actions.push(el('button', {
      class: 'btn btn-sm',
      onClick: () => showResendModal(p, refresh),
    }, 'Re-send'));
  }
  actions.push(el('button', {
    class: 'btn btn-sm btn-secondary',
    onClick: () => showEditModal(p, refresh),
  }, 'Edit'));
  actions.push(el('button', {
    class: 'btn btn-sm btn-danger',
    onClick: async () => {
      if (!confirm(`Delete player "${p.name}"?`)) return;
      try {
        await api.delete(`/api/v3/players/${p.id}`);
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    },
  }, 'Delete'));

  tr.appendChild(el('td', { class: 'actions-cell' }, actions));
  return tr;
}

function showInviteModal(p, refresh) {
  const errBox = el('div', { class: 'err' });
  const email = el('input', {
    type: 'email',
    placeholder: 'player@example.com',
    value: p.registered_email || '',
  });
  const resultBox = el('div', {});
  const body = el('div', {}, [
    el('p', {}, `Invite `, el('strong', {}, p.name), ` to fill in their profile:`),
    el('label', {}, 'Email'),
    email,
    errBox,
    resultBox,
  ]);
  modal(`Invite ${p.name}`, body, [
    { label: 'Close', class: 'btn btn-secondary', onClick: (close) => { refresh(); close(); } },
    {
      label: 'Send invite',
      class: 'btn',
      onClick: async () => {
        errBox.textContent = '';
        if (!email.value.trim()) { errBox.textContent = 'Email required'; return; }
        try {
          const r = await api.post(`/api/v3/players/${p.id}/invite`, { email: email.value.trim() });
          renderInviteResult(resultBox, r, email.value.trim());
          // Try to auto-send email if Resend configured
          const cfg = window.appConfig || {};
          if (cfg.emailConfigured) {
            try {
              await api.post(`/api/v3/invites/${encodeURIComponent(r.token)}/email`,
                { recipientEmail: email.value.trim() });
              toast(`Email sent to ${email.value.trim()}`, 'success');
            } catch (e) {
              toast(`Invite created. Email send failed: ${e.message}`, 'error');
            }
          }
        } catch (err) { errBox.textContent = err.message; }
      },
    },
  ]);
}

function showResendModal(p, refresh) {
  // Fetch the latest pending invite for this player. We don't have a list
  // endpoint per player; use the one we just created via profile_invite_id —
  // GET /api/v3/players/:id returns it.
  const errBox = el('div', { class: 'err' });
  const resultBox = el('div', {});
  const body = el('div', {}, [
    el('p', {}, `Re-send invite for `, el('strong', {}, p.name), `?`),
    errBox,
    resultBox,
  ]);
  modal(`Re-send invite — ${p.name}`, body, [
    { label: 'Close', class: 'btn btn-secondary', onClick: (close) => { refresh(); close(); } },
    {
      label: 'Issue new invite',
      class: 'btn',
      onClick: async () => {
        errBox.textContent = '';
        const addr = prompt(`Email to send invite to?`, p.registered_email || '');
        if (!addr || !addr.trim()) return;
        try {
          const r = await api.post(`/api/v3/players/${p.id}/invite`, { email: addr.trim() });
          renderInviteResult(resultBox, r, addr.trim());
          const cfg = window.appConfig || {};
          if (cfg.emailConfigured) {
            try {
              await api.post(`/api/v3/invites/${encodeURIComponent(r.token)}/email`,
                { recipientEmail: addr.trim() });
              toast(`Email sent to ${addr.trim()}`, 'success');
            } catch (e) {
              toast(`Invite created. Email send failed: ${e.message}`, 'error');
            }
          }
        } catch (err) { errBox.textContent = err.message; }
      },
    },
  ]);
}

function renderInviteResult(box, inviteResp, recipientEmail) {
  clear(box);
  box.appendChild(el('p', { class: 'muted', style: 'margin-top: 12px;' },
    'Share this link with the invitee:'));
  box.appendChild(el('div', { class: 'share-link' }, [
    el('span', {}, inviteResp.share_url),
    el('button', {
      class: 'btn btn-sm',
      onClick: () => navigator.clipboard.writeText(inviteResp.share_url).then(() => toast('Copied!')),
    }, 'Copy'),
  ]));
}

function showEditModal(p, refresh) {
  const errBox = el('div', { class: 'err' });
  const name = el('input', { type: 'text', value: p.name });
  const email = el('input', { type: 'email', value: p.registered_email || '', placeholder: 'player@example.com' });
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
    el('label', {}, 'Email (used when sending invite)'), email,
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
            registered_email: email.value.trim() || null,
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
