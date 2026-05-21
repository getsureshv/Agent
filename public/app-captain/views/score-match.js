// Live scoring view. Renders setup screen (status=not_started) or the
// scoring grid (status=in_progress). Opens a WebSocket to /ws/match/:id
// and re-renders on every broadcast.

import { api } from '/shared/api.js';
import { el, clear, modal, toast } from '/shared/ui.js';

const CLIENT_ID_KEY = 'cs_scoring_client_id';
function clientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 't' + Date.now() + Math.random());
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export async function renderScoreMatch(view, ctx, matchId) {
  if (!matchId) {
    view.appendChild(el('p', { class: 'err' }, 'Missing match id'));
    return;
  }

  const local = {
    match: null,
    state: null,
    rosters: {},
    lock: null,  // { holder_user_id, client_id, expires_at } when known
    iHoldLock: false,
    ws: null,
    heartbeatTimer: null,
  };

  // Top-level layout
  view.appendChild(el('div', { class: 'row' }, [
    el('a', { href: '#/dashboard', class: 'muted' }, '← Back'),
  ]));
  const titleEl = el('h1', {}, 'Loading…');
  view.appendChild(titleEl);
  const lockBar = el('div', { class: 'lock-bar muted' }, 'Loading lock state…');
  view.appendChild(lockBar);
  const body = el('div', {});
  view.appendChild(body);

  // ── helpers ─────────────────────────────────────────────────────
  async function loadMatch() {
    const r = await api.get(`/api/v3/matches/${matchId}`);
    local.match = r;
    local.state = r.state;
    local.rosters = r.rosters || {};
    titleEl.textContent = `${r.team_a_name} vs ${r.team_b_name}`;
  }

  async function acquireLock() {
    try {
      const r = await api.post(`/api/v3/matches/${matchId}/lock`, { clientId: clientId() });
      local.lock = r;
      local.iHoldLock = true;
      startHeartbeat();
      updateLockBar();
    } catch (err) {
      local.iHoldLock = false;
      updateLockBar(err.message);
      throw err;
    }
  }

  async function releaseLock() {
    stopHeartbeat();
    try { await api.delete(`/api/v3/matches/${matchId}/lock`); } catch {}
    local.iHoldLock = false;
    local.lock = null;
    updateLockBar();
  }

  function startHeartbeat() {
    stopHeartbeat();
    local.heartbeatTimer = setInterval(async () => {
      try {
        await api.post(`/api/v3/matches/${matchId}/lock/heartbeat`, { clientId: clientId() });
      } catch (err) {
        toast('Lost write lock — refresh to retry', 'error');
        local.iHoldLock = false;
        updateLockBar(err.message);
        stopHeartbeat();
      }
    }, 30_000);
  }
  function stopHeartbeat() {
    if (local.heartbeatTimer) clearInterval(local.heartbeatTimer);
    local.heartbeatTimer = null;
  }

  function updateLockBar(extra) {
    clear(lockBar);
    if (local.iHoldLock) {
      lockBar.className = 'lock-bar lock-mine';
      lockBar.appendChild(el('span', {}, '● You have control'));
      lockBar.appendChild(el('button', {
        class: 'btn btn-sm btn-secondary',
        style: 'margin-left: 12px;',
        onClick: async () => { await releaseLock(); },
      }, 'Release control'));
    } else if (local.lock && local.lock.holder_user_id) {
      lockBar.className = 'lock-bar lock-other';
      lockBar.appendChild(el('span', {}, `● Locked by another user`));
      lockBar.appendChild(el('button', {
        class: 'btn btn-sm',
        style: 'margin-left: 12px;',
        onClick: async () => {
          try { await acquireLock(); await render(); }
          catch (err) { toast(err.message, 'error'); }
        },
      }, 'Take control'));
    } else {
      lockBar.className = 'lock-bar';
      lockBar.appendChild(el('span', {}, 'No active lock'));
      lockBar.appendChild(el('button', {
        class: 'btn btn-sm',
        style: 'margin-left: 12px;',
        onClick: async () => {
          try { await acquireLock(); await render(); }
          catch (err) { toast(err.message, 'error'); }
        },
      }, 'Take control'));
    }
    if (extra) lockBar.appendChild(el('span', { class: 'muted', style: 'margin-left: 12px;' }, extra));
  }

  function openSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/match/${matchId}`;
    try {
      local.ws = new WebSocket(url);
    } catch { return; }
    local.ws.addEventListener('message', async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.state) {
        // Refresh local state from server-pushed snapshot
        await loadMatch();
        render();
      } else if (msg.type === 'lock_changed') {
        // Could be us or someone else; just re-render to refresh the bar
        render();
      }
    });
    local.ws.addEventListener('close', () => {
      // Reconnect once after 2s
      setTimeout(() => { if (document.contains(view)) openSocket(); }, 2000);
    });
  }

  // ── render dispatch ─────────────────────────────────────────────
  async function render() {
    clear(body);
    const m = local.match;
    if (!m) {
      body.appendChild(el('p', {}, 'Loading…'));
      return;
    }
    renderHeader(body, m, local.state);
    if (m.status === 'not_started') return renderSetup(body, m);
    if (m.status === 'in_progress' || m.status === 'completed') return renderGrid(body, m);
    body.appendChild(el('p', {}, `Unknown status: ${m.status}`));
  }

  function renderHeader(parent, m, state) {
    const innings = state?.innings || [];
    const current = innings[innings.length - 1];
    const lines = [];
    if (current) {
      const teamName = current.batting_team_id === m.team_a_id ? m.team_a_name : m.team_b_name;
      lines.push(`${teamName}: ${current.runs}/${current.wickets} (${current.over} ov)`);
      if (state.runRate !== null && state.runRate !== undefined) {
        lines.push(`RR ${state.runRate.toFixed(2)}`);
      }
      if (state.requiredRunRate !== null && state.requiredRunRate !== undefined) {
        lines.push(`RRR ${state.requiredRunRate.toFixed(2)}`);
      }
      if (state.target) lines.push(`Target ${state.target}`);
    } else {
      lines.push('Not started');
    }
    parent.appendChild(el('div', { class: 'score-header card' }, [
      el('strong', {}, lines[0] || ''),
      el('div', { class: 'sub muted' }, lines.slice(1).join(' · ')),
      state?.result ? el('div', { class: 'badge status-completed', style: 'margin-top: 8px;' },
        state.result.summary || 'Completed') : null,
    ]));
  }

  // ── setup ────────────────────────────────────────────────────────
  function renderSetup(parent, m) {
    const teamARoster = (local.rosters[m.team_a_id] || []);
    const teamBRoster = (local.rosters[m.team_b_id] || []);
    // If rosters are empty (no lineup yet), let user pick from all team players.
    // We don't have that data fetched here — kicking it back to roster setup is fine.
    const oversInput = el('input', { type: 'number', min: '1', max: '50', value: '20' });
    const playersInput = el('input', { type: 'number', min: '2', max: '15', value: '11' });

    let tossWinner = m.team_a_id;
    let decision = 'bat';
    const tossRadios = el('div', { class: 'row' }, [
      el('label', { class: 'inline-check' }, [
        el('input', { type: 'radio', name: 'toss', value: m.team_a_id, checked: true,
          onChange: (e) => { tossWinner = e.target.value; } }),
        ` ${m.team_a_name}`,
      ]),
      el('label', { class: 'inline-check' }, [
        el('input', { type: 'radio', name: 'toss', value: m.team_b_id,
          onChange: (e) => { tossWinner = e.target.value; } }),
        ` ${m.team_b_name}`,
      ]),
    ]);
    const decRadios = el('div', { class: 'row' }, [
      el('label', { class: 'inline-check' }, [
        el('input', { type: 'radio', name: 'dec', value: 'bat', checked: true,
          onChange: (e) => { decision = e.target.value; } }),
        ' Bat',
      ]),
      el('label', { class: 'inline-check' }, [
        el('input', { type: 'radio', name: 'dec', value: 'bowl',
          onChange: (e) => { decision = e.target.value; } }),
        ' Bowl',
      ]),
    ]);

    // We need both rosters to pick lineups. If we don't have them via /matches,
    // fetch /teams/:id/players for both teams.
    const lineupBox = el('div', {});
    fetchTeamRosters(m).then((rosters) => {
      lineupBox.appendChild(buildLineupPicker(m.team_a_name, rosters[m.team_a_id] || [], playersInput, 'a'));
      lineupBox.appendChild(buildLineupPicker(m.team_b_name, rosters[m.team_b_id] || [], playersInput, 'b'));
      local._setupRosters = rosters;
    }).catch((err) => {
      lineupBox.appendChild(el('p', { class: 'err' }, 'Could not load team rosters: ' + err.message));
    });

    const errBox = el('div', { class: 'err' });

    parent.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, 'Match setup'),
      el('label', {}, 'Toss winner'), tossRadios,
      el('label', {}, 'Chose to'), decRadios,
      el('label', {}, 'Overs per innings'), oversInput,
      el('label', {}, 'Players per side'), playersInput,
      el('h3', { style: 'margin-top: 16px;' }, 'Lineups'),
      lineupBox,
      errBox,
      el('div', { class: 'row', style: 'margin-top: 16px;' }, [
        el('button', {
          class: 'btn',
          onClick: async () => {
            errBox.textContent = '';
            try {
              if (!local.iHoldLock) await acquireLock();
              const aIds = collectChecked(lineupBox, 'a');
              const bIds = collectChecked(lineupBox, 'b');
              const ppt = parseInt(playersInput.value, 10);
              if (aIds.length !== ppt || bIds.length !== ppt) {
                errBox.textContent = `Pick exactly ${ppt} players for each team`;
                return;
              }
              const battingTeam = decision === 'bat' ? tossWinner
                : (tossWinner === m.team_a_id ? m.team_b_id : m.team_a_id);
              const battingLineup = battingTeam === m.team_a_id ? aIds : bIds;
              const bowlingLineup = battingTeam === m.team_a_id ? bIds : aIds;
              await api.post(`/api/v3/matches/${matchId}/setup`, {
                toss_winner_team_id: tossWinner,
                toss_decision: decision,
                overs_per_innings: parseInt(oversInput.value, 10),
                players_per_side: ppt,
                batting_lineup_player_ids: battingLineup,
                bowling_lineup_player_ids: bowlingLineup,
              });
              await loadMatch();
              render();
            } catch (err) { errBox.textContent = err.message; }
          },
        }, 'Start match'),
      ]),
    ]));
  }

  function buildLineupPicker(teamName, players, playersInput, side) {
    const box = el('div', { class: 'card' }, [
      el('h3', {}, teamName + ' XI'),
    ]);
    if (players.length === 0) {
      box.appendChild(el('p', { class: 'muted' },
        'No players on this team yet. Add players via the team detail page first.'));
      return box;
    }
    const list = el('div', { class: 'lineup-list' });
    for (const p of players) {
      const cb = el('input', { type: 'checkbox', value: p.id });
      cb.dataset.side = side;
      list.appendChild(el('label', { class: 'lineup-row' }, [
        cb,
        ` ${p.batting_order ? '#' + p.batting_order + ' ' : ''}${p.name}${p.role ? ' (' + p.role + ')' : ''}`,
      ]));
    }
    box.appendChild(list);
    return box;
  }
  function collectChecked(root, side) {
    return Array.from(root.querySelectorAll(`input[type=checkbox][data-side="${side}"]:checked`))
      .map((el) => el.value);
  }

  async function fetchTeamRosters(m) {
    const [a, b] = await Promise.all([
      api.get(`/api/v3/teams/${m.team_a_id}/players`),
      api.get(`/api/v3/teams/${m.team_b_id}/players`),
    ]);
    return { [m.team_a_id]: a.players || [], [m.team_b_id]: b.players || [] };
  }

  // ── grid ─────────────────────────────────────────────────────────
  function renderGrid(parent, m) {
    const state = local.state;
    const innings = state?.innings || [];
    const current = innings[innings.length - 1];
    const battingTeamId = current?.batting_team_id || m.current_batting_team_id;
    const bowlingTeamId = current?.bowling_team_id || m.current_bowling_team_id;
    const battingRoster = local.rosters[battingTeamId] || [];
    const bowlingRoster = local.rosters[bowlingTeamId] || [];

    // Pick three players to act upon — striker, non-striker, bowler.
    // Use server-derived ids if available, else default to first two batsmen
    // and first bowler in lineup order so the very first ball is enterable.
    const stateBatting = state?.batting || {};
    const stateBowling = state?.bowling || {};
    let strikerId = stateBatting.striker_player_id || battingRoster[0]?.id || null;
    let nonStrikerId = stateBatting.non_striker_player_id || battingRoster[1]?.id || null;
    let bowlerId = stateBowling.current_bowler_player_id || bowlingRoster[0]?.id || null;

    const facingBox = el('div', { class: 'card facing-box' });
    function rebuildFacing() {
      clear(facingBox);
      facingBox.appendChild(buildPlayerPicker('On strike', battingRoster, strikerId, (id) => { strikerId = id; }));
      facingBox.appendChild(buildPlayerPicker('Non-striker', battingRoster, nonStrikerId, (id) => { nonStrikerId = id; }));
      facingBox.appendChild(buildPlayerPicker('Bowler', bowlingRoster, bowlerId, (id) => { bowlerId = id; }));
    }
    rebuildFacing();
    parent.appendChild(facingBox);

    if (m.status === 'completed') {
      parent.appendChild(el('p', { class: 'muted' }, 'Match completed.'));
      renderEventLog(parent, state);
      return;
    }

    const padRow = el('div', { class: 'pad-row' });
    for (const n of [0, 1, 2, 3, 4, 5, 6]) {
      padRow.appendChild(el('button', {
        class: 'btn btn-num',
        disabled: !local.iHoldLock,
        onClick: async () => {
          await postEvent({ runs_off_bat: n });
        },
      }, String(n)));
    }
    parent.appendChild(padRow);

    const extrasRow = el('div', { class: 'pad-row extras-row' });
    for (const [label, kind] of [['Wide', 'wide'], ['No-ball', 'no_ball'], ['Bye', 'bye'], ['Leg-bye', 'leg_bye']]) {
      extrasRow.appendChild(el('button', {
        class: 'btn btn-secondary',
        disabled: !local.iHoldLock,
        onClick: async () => {
          const runs = parseInt(prompt(`Runs on this ${label}? (default 1)`, '1') || '1', 10);
          if (Number.isNaN(runs) || runs < 0 || runs > 6) return;
          await postEvent({
            runs_off_bat: 0,
            extras_runs: runs,
            extras_type: kind,
            legal_ball: kind === 'bye' || kind === 'leg_bye',
          });
        },
      }, label));
    }
    parent.appendChild(extrasRow);

    const ctrlRow = el('div', { class: 'pad-row' });
    ctrlRow.appendChild(el('button', {
      class: 'btn btn-danger',
      disabled: !local.iHoldLock,
      onClick: () => showWicketModal(),
    }, 'Wicket'));
    ctrlRow.appendChild(el('button', {
      class: 'btn btn-secondary',
      disabled: !local.iHoldLock,
      onClick: async () => {
        try {
          await api.delete(`/api/v3/matches/${matchId}/events/last`);
          await loadMatch();
          render();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Undo'));
    ctrlRow.appendChild(el('button', {
      class: 'btn btn-secondary',
      disabled: !local.iHoldLock,
      onClick: async () => {
        if (!confirm('End the current innings?')) return;
        try {
          await api.post(`/api/v3/matches/${matchId}/innings/end`);
          await loadMatch();
          render();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'End innings'));
    ctrlRow.appendChild(el('button', {
      class: 'btn',
      disabled: !local.iHoldLock,
      onClick: () => showCompleteModal(),
    }, 'Complete match'));
    parent.appendChild(ctrlRow);

    renderEventLog(parent, state);

    async function postEvent(partial) {
      if (!local.iHoldLock) { toast('You do not have control', 'error'); return; }
      if (!strikerId || !nonStrikerId || !bowlerId) {
        toast('Pick striker, non-striker and bowler first', 'error');
        return;
      }
      try {
        await api.post(`/api/v3/matches/${matchId}/events`, {
          batter_on_strike_player_id: strikerId,
          batter_non_strike_player_id: nonStrikerId,
          bowler_player_id: bowlerId,
          runs_off_bat: partial.runs_off_bat || 0,
          extras_runs: partial.extras_runs || 0,
          extras_type: partial.extras_type || null,
          legal_ball: partial.legal_ball === undefined ? true : partial.legal_ball,
          is_wicket: !!partial.is_wicket,
          wicket_type: partial.wicket_type || null,
          out_batter_player_id: partial.out_batter_player_id || null,
          new_batter_player_id: partial.new_batter_player_id || null,
          notes: partial.notes || null,
        });
        await loadMatch();
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function showWicketModal() {
      const errBox = el('div', { class: 'err' });
      const typeSel = el('select', {}, ['bowled','caught','lbw','run_out','stumped','hit_wicket','retired'].map(
        (t) => el('option', { value: t }, t)));
      const outSel = el('select', {}, [
        el('option', { value: strikerId, selected: true }, `striker: ${nameOf(battingRoster, strikerId)}`),
        el('option', { value: nonStrikerId }, `non-striker: ${nameOf(battingRoster, nonStrikerId)}`),
      ]);
      const availableNew = battingRoster.filter((p) => p.id !== strikerId && p.id !== nonStrikerId);
      const newSel = el('select', {}, [
        el('option', { value: '' }, '— select new batter —'),
        ...availableNew.map((p) => el('option', { value: p.id }, p.name)),
      ]);
      const body = el('div', {}, [
        el('label', {}, 'Wicket type'), typeSel,
        el('label', {}, 'Out batter'), outSel,
        el('label', {}, 'New batter'), newSel,
        errBox,
      ]);
      modal('Record wicket', body, [
        { label: 'Cancel', class: 'btn btn-secondary', onClick: (close) => close() },
        {
          label: 'Confirm',
          class: 'btn btn-danger',
          onClick: async (close) => {
            errBox.textContent = '';
            if (!newSel.value) { errBox.textContent = 'Pick a new batter'; return; }
            close();
            await postEvent({
              is_wicket: true,
              wicket_type: typeSel.value,
              out_batter_player_id: outSel.value,
              new_batter_player_id: newSel.value,
            });
          },
        },
      ]);
    }

    function showCompleteModal() {
      const errBox = el('div', { class: 'err' });
      const winnerSel = el('select', {}, [
        el('option', { value: '' }, '— no winner / tied —'),
        el('option', { value: m.team_a_id }, m.team_a_name),
        el('option', { value: m.team_b_id }, m.team_b_name),
      ]);
      const summary = el('input', { type: 'text', placeholder: 'e.g. "Alpha won by 12 runs"' });
      const body = el('div', {}, [
        el('label', {}, 'Winner'), winnerSel,
        el('label', {}, 'Result summary (optional)'), summary,
        errBox,
      ]);
      modal('Complete match', body, [
        { label: 'Cancel', class: 'btn btn-secondary', onClick: (close) => close() },
        {
          label: 'Complete',
          class: 'btn',
          onClick: async (close) => {
            errBox.textContent = '';
            try {
              await api.post(`/api/v3/matches/${matchId}/complete`, {
                winner_team_id: winnerSel.value || null,
                result_summary: summary.value.trim() || null,
              });
              close();
              await loadMatch();
              render();
            } catch (err) { errBox.textContent = err.message; }
          },
        },
      ]);
    }
  }

  function buildPlayerPicker(label, roster, selectedId, onChange) {
    const box = el('div', { class: 'player-picker' });
    box.appendChild(el('div', { class: 'muted', style: 'font-size: 0.78rem;' }, label));
    const sel = el('select', {}, roster.map((p) =>
      el('option', { value: p.id, selected: p.id === selectedId }, p.name)));
    sel.addEventListener('change', () => onChange(sel.value));
    box.appendChild(sel);
    return box;
  }
  function nameOf(roster, id) {
    return (roster.find((p) => p.id === id)?.name) || '—';
  }

  function renderEventLog(parent, state) {
    const log = (state?.innings || []).flatMap((i) => i.log.map((e) => ({ ...e, innings_num: i.innings_num })));
    if (log.length === 0) return;
    const recent = log.slice(-20).reverse();
    const card = el('div', { class: 'card', style: 'margin-top: 16px;' }, [
      el('h3', {}, 'Recent balls'),
    ]);
    for (const e of recent) {
      const parts = [
        `${e.over_num ?? '-'}.${e.ball_num ?? '-'}`,
        e.kind === 'innings_end' ? 'INNINGS END' :
          (e.is_wicket ? `WICKET (${e.wicket_type})` :
           e.extras_type ? `${e.extras_type} +${e.extras_runs}${e.runs_off_bat ? ' & ' + e.runs_off_bat + ' off bat' : ''}` :
           `${e.runs_off_bat} run${e.runs_off_bat === 1 ? '' : 's'}`),
      ];
      card.appendChild(el('div', { class: 'list-row', style: 'padding: 4px 0; border: none;' }, [
        el('span', { class: 'muted', style: 'min-width: 50px;' }, parts[0]),
        el('span', {}, parts[1]),
      ]));
    }
    parent.appendChild(card);
  }

  // ── boot ────────────────────────────────────────────────────────
  try {
    await loadMatch();
    // Try to acquire the lock optimistically; if it 409s, show "Take control".
    try {
      const r = await api.post(`/api/v3/matches/${matchId}/lock`, { clientId: clientId() });
      local.lock = r;
      local.iHoldLock = true;
      startHeartbeat();
    } catch (err) {
      local.iHoldLock = false;
      if (err.body?.holder_user_id) local.lock = err.body;
    }
    updateLockBar();
    openSocket();
    render();
  } catch (err) {
    body.appendChild(el('p', { class: 'err' }, err.message));
  }
}
