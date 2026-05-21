import { api } from '/shared/api.js';
import { el, clear, modal, toast, copy, fmtDate } from '/shared/ui.js';

export async function renderTournament(view, ctx, tournamentId) {
  let tournament, role;
  try {
    const r = await api.get(`/api/v3/tournaments/${tournamentId}`);
    tournament = r.tournament;
    role = r.role;
  } catch (err) {
    view.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  const isOwner = role === 'owner';

  view.appendChild(el('div', { class: 'row' }, [
    el('a', { href: '#/dashboard', class: 'muted' }, '← Back'),
  ]));
  view.appendChild(el('h1', {}, tournament.name));
  view.appendChild(el('p', { class: 'muted' },
    `${tournament.format} · ${tournament.overs_per_innings} overs · ${tournament.players_per_team} per side · status: ${tournament.status}`));

  let tab = 'teams';
  const tabsRow = el('div', { class: 'tabs' });
  const body = el('div', {});

  function rerender() {
    clear(tabsRow);
    for (const t of ['teams', 'fixtures', 'invites']) {
      tabsRow.appendChild(el('button', {
        class: 'tab' + (tab === t ? ' active' : ''),
        onClick: () => { tab = t; rerender(); },
      }, t.charAt(0).toUpperCase() + t.slice(1)));
    }
    clear(body);
    if (tab === 'teams')    renderTeams(body, ctx, tournament, isOwner, rerender);
    if (tab === 'fixtures') renderFixtures(body, ctx, tournament, isOwner, rerender);
    if (tab === 'invites') {
      if (!isOwner) body.appendChild(el('p', { class: 'muted' }, 'Owner only.'));
      else renderInvites(body, ctx, tournament, rerender);
    }
  }

  view.appendChild(tabsRow);
  view.appendChild(body);
  rerender();
}

// ── Teams tab ──────────────────────────────────────────────────────
async function renderTeams(container, ctx, tournament, isOwner, refresh) {
  let teams = [];
  try {
    teams = (await api.get(`/api/v3/tournaments/${tournament.id}/teams`)).teams;
  } catch (err) {
    container.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  if (isOwner) {
    const errBox = el('div', { class: 'err' });
    const nameInput = el('input', { type: 'text', placeholder: 'Team name' });
    const shortInput = el('input', { type: 'text', placeholder: 'Short name (optional)' });
    const addCard = el('div', { class: 'card' }, [
      el('h3', {}, 'Add team'),
      el('div', { class: 'row' }, [nameInput, shortInput,
        el('button', {
          class: 'btn',
          onClick: async () => {
            errBox.textContent = '';
            if (!nameInput.value.trim()) { errBox.textContent = 'Name required'; return; }
            try {
              await api.post(`/api/v3/tournaments/${tournament.id}/teams`, {
                name: nameInput.value.trim(),
                short_name: shortInput.value.trim() || undefined,
              });
              refresh();
            } catch (err) { errBox.textContent = err.message; }
          },
        }, 'Add'),
      ]),
      errBox,
    ]);
    container.appendChild(addCard);
  }

  if (teams.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, 'No teams yet.'));
    return;
  }

  const listCard = el('div', { class: 'card' });
  for (const t of teams) {
    const captainLabel = t.captain_name
      ? `Captain: ${t.captain_name} (${t.captain_email})`
      : 'No captain assigned';
    const actions = [];
    if (isOwner) {
      if (!t.captain_user_id) {
        actions.push(el('button', {
          class: 'btn btn-sm',
          onClick: () => showInviteCaptainModal(ctx, tournament, t, refresh),
        }, 'Invite captain'));
      }
      actions.push(el('button', {
        class: 'btn btn-sm btn-danger',
        onClick: async () => {
          if (!confirm(`Delete team "${t.name}"?`)) return;
          try {
            await api.delete(`/api/v3/tournaments/${tournament.id}/teams/${t.id}`);
            refresh();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Delete'));
    }
    listCard.appendChild(el('div', { class: 'list-row' }, [
      el('div', { class: 'body' }, [
        el('strong', {}, t.name + (t.short_name ? ` (${t.short_name})` : '')),
        el('div', { class: 'sub' }, captainLabel),
      ]),
      el('div', { class: 'actions' }, actions),
    ]));
  }
  container.appendChild(listCard);
}

function showInviteCaptainModal(ctx, tournament, team, refresh) {
  const errBox = el('div', { class: 'err' });
  const emailInput = el('input', { type: 'email', required: true });
  const resultBox = el('div', {});

  const body = el('div', {}, [
    el('p', {}, `Invite a captain for `, el('strong', {}, team.name), ':'),
    el('label', {}, 'Email'),
    emailInput,
    errBox,
    resultBox,
  ]);

  modal(`Invite captain — ${team.name}`, body, [
    { label: 'Close', class: 'btn btn-secondary', onClick: (close) => { refresh(); close(); } },
    {
      label: 'Send invite',
      class: 'btn',
      onClick: async () => {
        errBox.textContent = '';
        if (!emailInput.value.trim()) { errBox.textContent = 'Email required'; return; }
        try {
          const r = await api.post(`/api/v3/tournaments/${tournament.id}/invites`, {
            email: emailInput.value.trim(),
            role: 'captain',
            team_id: team.id,
          });
          clear(resultBox);
          resultBox.appendChild(el('p', { class: 'muted', style: 'margin-top: 12px;' },
            'Share this link with the invitee:'));
          const linkRow = el('div', { class: 'share-link' }, [
            el('span', {}, r.share_url),
            el('button', { class: 'btn btn-sm', onClick: () => copy(r.share_url) }, 'Copy'),
          ]);
          resultBox.appendChild(linkRow);
        } catch (err) { errBox.textContent = err.message; }
      },
    },
  ]);
}

// ── Fixtures tab ───────────────────────────────────────────────────
async function renderFixtures(container, ctx, tournament, isOwner, refresh) {
  let fixtures = [], teams = [];
  try {
    fixtures = (await api.get(`/api/v3/tournaments/${tournament.id}/fixtures`)).fixtures;
    teams    = (await api.get(`/api/v3/tournaments/${tournament.id}/teams`)).teams;
  } catch (err) {
    container.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  if (isOwner) {
    const card = el('div', { class: 'card' }, [
      el('h3', {}, 'Add fixture'),
    ]);
    const errBox = el('div', { class: 'err' });
    const aSel = el('select', {}, [
      el('option', { value: '' }, '— team A —'),
      ...teams.map((t) => el('option', { value: t.id }, t.name)),
    ]);
    const bSel = el('select', {}, [
      el('option', { value: '' }, '— team B —'),
      ...teams.map((t) => el('option', { value: t.id }, t.name)),
    ]);
    const when = el('input', { type: 'datetime-local' });
    const venue = el('input', { type: 'text', placeholder: 'Venue (optional)' });
    card.appendChild(el('div', { class: 'row' }, [aSel, el('span', {}, 'vs'), bSel, when, venue,
      el('button', {
        class: 'btn',
        onClick: async () => {
          errBox.textContent = '';
          if (!aSel.value || !bSel.value) { errBox.textContent = 'Select both teams'; return; }
          if (aSel.value === bSel.value) { errBox.textContent = 'Teams must differ'; return; }
          try {
            await api.post(`/api/v3/tournaments/${tournament.id}/fixtures`, {
              team_a_id: aSel.value,
              team_b_id: bSel.value,
              scheduled_at: when.value || undefined,
              venue: venue.value.trim() || undefined,
            });
            refresh();
          } catch (err) { errBox.textContent = err.message; }
        },
      }, 'Add'),
    ]));
    card.appendChild(errBox);

    if (teams.length >= 2) {
      card.appendChild(el('div', { class: 'row', style: 'margin-top: 12px;' }, [
        el('button', {
          class: 'btn btn-secondary',
          onClick: () => showGenerateModal(tournament, refresh),
        }, 'Generate fixtures from teams'),
        el('button', {
          class: 'btn btn-secondary',
          onClick: () => showGenerateModal(tournament, refresh, { replaceMode: true }),
        }, 'Regenerate (replace unplayed)'),
      ]));
    }
    container.appendChild(card);
  }

  if (fixtures.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, 'No fixtures yet.'));
    return;
  }

  const listCard = el('div', { class: 'card' });
  for (const f of fixtures) {
    const sub = [
      f.scheduled_at ? fmtDate(f.scheduled_at) : 'Time TBD',
      f.venue || 'Venue TBD',
      f.scorer_name ? `Scorer: ${f.scorer_name}` : 'Scorer: unassigned',
    ].join(' · ');
    const actions = [];
    if (isOwner) {
      actions.push(el('button', {
        class: 'btn btn-sm',
        onClick: () => showAssignScorerModal(tournament, f, refresh),
      }, 'Assign scorer'));
      actions.push(el('button', {
        class: 'btn btn-sm btn-danger',
        onClick: async () => {
          if (!confirm('Delete this fixture?')) return;
          try {
            await api.delete(`/api/v3/tournaments/${tournament.id}/fixtures/${f.id}`);
            refresh();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Delete'));
    }
    listCard.appendChild(el('div', { class: 'list-row' }, [
      el('div', { class: 'body' }, [
        el('strong', {}, `${f.team_a_name} vs ${f.team_b_name}`),
        el('div', { class: 'sub' }, sub),
      ]),
      el('span', { class: `badge status-${f.status}` }, f.status),
      el('div', { class: 'actions' }, actions),
    ]));
  }
  container.appendChild(listCard);
}

function showGenerateModal(tournament, refresh, { replaceMode = false } = {}) {
  let format = 'round-robin';
  const errBox = el('div', { class: 'err' });
  const formatSel = el('select', {
    onChange: (e) => { format = e.target.value; },
  }, [
    el('option', { value: 'round-robin' }, 'Round-robin (every pair plays once)'),
    el('option', { value: 'knockout' }, 'Knockout (paired in declared order)'),
  ]);
  const body = el('div', {}, [
    el('p', {}, replaceMode
      ? 'This will delete every unplayed fixture in this tournament and replace them with the freshly generated set. Played fixtures (any with scoring events) are preserved.'
      : 'Generate fixtures for every existing team. New fixtures are added on top of any existing ones.'),
    el('label', {}, 'Format'),
    formatSel,
    errBox,
  ]);
  modal(replaceMode ? 'Regenerate fixtures (replace unplayed)' : 'Generate fixtures', body, [
    { label: 'Cancel', class: 'btn btn-secondary', onClick: (close) => close() },
    {
      label: replaceMode ? 'Regenerate' : 'Generate',
      class: replaceMode ? 'btn btn-danger' : 'btn',
      onClick: async (close) => {
        errBox.textContent = '';
        try {
          const path = `/api/v3/tournaments/${tournament.id}/fixtures/generate${replaceMode ? '?mode=replace' : ''}`;
          const r = await api.post(path, { format });
          close();
          if (replaceMode) {
            const preservedN = (r.preserved_fixtures || []).length;
            toast(`Regenerated. Created ${r.created}, deleted ${r.deleted}, preserved ${preservedN}.`);
          } else {
            toast(`Generated ${r.created} fixture${r.created === 1 ? '' : 's'}`);
          }
          refresh();
        } catch (err) { errBox.textContent = err.message; }
      },
    },
  ]);
}

function showAssignScorerModal(tournament, fixture, refresh) {
  const errBox = el('div', { class: 'err' });
  const searchInput = el('input', { type: 'text', placeholder: 'Search by email…' });
  const resultsBox = el('div', { class: 'list-row-wrap' });
  let selected = fixture.scorer_user_id || null;

  function renderResults(users) {
    clear(resultsBox);
    for (const u of users) {
      const row = el('div', {
        class: 'list-row',
        style: 'cursor: pointer; padding: 6px 0;',
        onClick: () => {
          selected = u.id;
          renderResults(users);
        },
      }, [
        el('div', { class: 'body' }, [
          el('strong', {}, u.name || u.email),
          el('div', { class: 'sub' }, u.email),
        ]),
        selected === u.id
          ? el('span', { class: 'badge', style: 'background: var(--brand); color: #062b3f;' }, '✓ Selected')
          : el('span', { class: 'muted', style: 'font-size: 0.8rem;' }, 'Pick'),
      ]);
      resultsBox.appendChild(row);
    }
  }

  let timer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (!q) { clear(resultsBox); return; }
      try {
        const r = await api.get(`/api/v3/users/search?q=${encodeURIComponent(q)}`);
        if (r.users.length === 0) {
          clear(resultsBox);
          resultsBox.appendChild(el('p', { class: 'muted' }, 'No matches. Invite them as a scorer first.'));
        } else renderResults(r.users);
      } catch (err) { errBox.textContent = err.message; }
    }, 250);
  });

  const body = el('div', {}, [
    el('p', { class: 'muted' }, 'Search for the user, then click to select.'),
    searchInput,
    resultsBox,
    errBox,
  ]);

  modal('Assign scorer', body, [
    { label: 'Cancel', class: 'btn btn-secondary', onClick: (close) => close() },
    selected
      ? { label: 'Unassign', class: 'btn btn-secondary', onClick: async (close) => {
          try {
            await api.patch(`/api/v3/tournaments/${tournament.id}/fixtures/${fixture.id}`, {
              scorer_user_id: null,
            });
            close();
            refresh();
          } catch (err) { errBox.textContent = err.message; }
        } }
      : null,
    {
      label: 'Assign',
      class: 'btn',
      onClick: async (close) => {
        errBox.textContent = '';
        if (!selected) { errBox.textContent = 'Pick a user first'; return; }
        try {
          await api.patch(`/api/v3/tournaments/${tournament.id}/fixtures/${fixture.id}`, {
            scorer_user_id: selected,
          });
          close();
          refresh();
        } catch (err) { errBox.textContent = err.message; }
      },
    },
  ].filter(Boolean));
}

// ── Invites tab ────────────────────────────────────────────────────
async function renderInvites(container, ctx, tournament, refresh) {
  let invites = [], teams = [];
  try {
    invites = (await api.get(`/api/v3/tournaments/${tournament.id}/invites`)).invites;
    teams   = (await api.get(`/api/v3/tournaments/${tournament.id}/teams`)).teams;
  } catch (err) {
    container.appendChild(el('p', { class: 'err' }, err.message));
    return;
  }

  // Send-scorer-invite card (captain invites flow from Teams tab)
  const errBox = el('div', { class: 'err' });
  const emailInput = el('input', { type: 'email', placeholder: 'scorer@example.com' });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Invite a scorer'),
    el('div', { class: 'row' }, [emailInput,
      el('button', {
        class: 'btn',
        onClick: async () => {
          errBox.textContent = '';
          if (!emailInput.value.trim()) { errBox.textContent = 'Email required'; return; }
          try {
            const r = await api.post(`/api/v3/tournaments/${tournament.id}/invites`, {
              email: emailInput.value.trim(),
              role: 'scorer',
            });
            toast('Invite created');
            await copy(r.share_url);
            refresh();
          } catch (err) { errBox.textContent = err.message; }
        },
      }, 'Send invite (copies link)'),
    ]),
    errBox,
    el('p', { class: 'muted', style: 'font-size: 0.82rem; margin-top: 8px;' },
      'Captain invites are sent from the Teams tab — they require a team to attach to.'),
  ]));

  if (invites.length === 0) {
    container.appendChild(el('p', { class: 'muted' }, 'No invites yet.'));
    return;
  }

  const listCard = el('div', { class: 'card' });
  for (const inv of invites) {
    const teamLabel = inv.team_name ? ` · team: ${inv.team_name}` : '';
    listCard.appendChild(el('div', { class: 'list-row' }, [
      el('div', { class: 'body' }, [
        el('strong', {}, inv.email),
        el('div', { class: 'sub' }, `${inv.role}${teamLabel} · sent ${fmtDate(inv.created_at)}${inv.consumed_at ? ` · accepted ${fmtDate(inv.consumed_at)}` : ''}`),
        el('div', { class: 'share-link', style: 'margin-top: 6px;' }, [
          el('span', {}, inv.share_url),
          el('button', { class: 'btn btn-sm', onClick: () => copy(inv.share_url) }, 'Copy'),
        ]),
      ]),
      el('span', { class: `badge status-${inv.status}` }, inv.status),
      el('button', {
        class: 'btn btn-sm btn-danger',
        onClick: async () => {
          if (!confirm(`Revoke invite to ${inv.email}?`)) return;
          try {
            await api.delete(`/api/v3/tournaments/${tournament.id}/invites/${inv.id}`);
            refresh();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Revoke'),
    ]));
  }
  container.appendChild(listCard);
}
