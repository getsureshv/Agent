// End-to-end smoke for the PR 4 scoring engine + WS broadcast.
//   node tests/v3_scoring_smoke.js
//   BASE_URL=http://localhost:3000 node tests/v3_scoring_smoke.js

import { WebSocket } from 'ws';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); fail++; }
}

const jars = new Map();
function cookieFor(email) {
  const v = jars.get(email);
  return v ? `cs_session=${v}` : '';
}
function saveCookie(email, setCookie) {
  if (!setCookie) return;
  const m = String(setCookie).match(/cs_session=([^;]+)/);
  if (m) jars.set(email, m[1]);
}
async function call(asEmail, path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (asEmail) {
    const c = cookieFor(asEmail);
    if (c) headers.cookie = c;
  }
  const res = await fetch(BASE_URL + path, { ...opts, headers, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (asEmail) saveCookie(asEmail, res.headers.get('set-cookie'));
  return { status: res.status, body };
}

async function main() {
  const stamp = Date.now();
  const adminE = `score-admin+${stamp}@test.example`;
  const capE   = `score-cap+${stamp}@test.example`;
  const otherE = `score-other+${stamp}@test.example`;
  const pw = 'password123';

  console.log(`Smoke testing ${BASE_URL}\n`);

  // ── Setup users + tournament + teams + players + fixture ────────
  const su = await call(adminE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: adminE, password: pw, name: 'Admin' }),
  });
  check('signup admin', su.status === 200);

  const t = await call(adminE, '/api/v3/tournaments', {
    method: 'POST', body: JSON.stringify({ name: `Scoring ${stamp}`, format: 'league', is_public: true }),
  });
  check('create tournament', t.status === 200);
  const tournamentId = t.body.tournament.id;

  const tA = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Alpha' }),
  });
  const tB = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Bravo' }),
  });
  check('add teams', tA.status === 200 && tB.status === 200);
  const teamAId = tA.body.team.id, teamBId = tB.body.team.id;

  // Six players each, with batting_order set.
  const teamAPlayers = [];
  const teamBPlayers = [];
  for (let i = 1; i <= 6; i++) {
    const a = await call(adminE, `/api/v3/teams/${teamAId}/players`, {
      method: 'POST',
      body: JSON.stringify({ name: `A${i}`, batting_order: i, role: i === 6 ? 'wicket-keeper' : 'batsman' }),
    });
    const b = await call(adminE, `/api/v3/teams/${teamBId}/players`, {
      method: 'POST',
      body: JSON.stringify({ name: `B${i}`, batting_order: i, role: i === 1 ? 'bowler' : 'batsman' }),
    });
    if (a.status !== 200 || b.status !== 200) { check(`add player ${i}`, false, JSON.stringify(a.body)+JSON.stringify(b.body)); return; }
    teamAPlayers.push(a.body.player);
    teamBPlayers.push(b.body.player);
  }
  check('added 6 players per team', teamAPlayers.length === 6 && teamBPlayers.length === 6);

  // captain invite + accept
  const inv = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: capE, role: 'captain', team_id: teamAId }),
  });
  check('issue captain invite', inv.status === 200);
  await call(capE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: capE, password: pw, name: 'Captain' }),
  });
  const acc = await call(capE, `/api/v3/invites/${inv.body.token}/accept`, { method: 'POST' });
  check('captain accepts invite', acc.status === 200);

  // create fixture A vs B
  const fx = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures`, {
    method: 'POST', body: JSON.stringify({ team_a_id: teamAId, team_b_id: teamBId }),
  });
  check('create fixture', fx.status === 200);
  const fixtureId = fx.body.fixture.id;

  // Admin assigns captain as scorer (proves auth path works for both)
  const assign = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures/${fixtureId}`, {
    method: 'PATCH', body: JSON.stringify({ scorer_user_id: acc.body.team_id ? null : null }),
  });
  // Get user id of captain by lookup
  const search = await call(adminE, `/api/v3/users/search?q=${encodeURIComponent('score-cap+'+stamp)}`);
  const capUser = (search.body?.users || []).find((u) => u.email === capE);
  check('lookup captain user id', !!capUser);
  const assign2 = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures/${fixtureId}`, {
    method: 'PATCH', body: JSON.stringify({ scorer_user_id: capUser.id }),
  });
  check('assign captain as scorer', assign2.status === 200 && assign2.body?.fixture?.scorer_user_id === capUser.id);

  // ── Create match row ────────────────────────────────────────────
  const cm = await call(capE, `/api/v3/fixtures/${fixtureId}/match`, { method: 'POST' });
  check('POST /fixtures/:id/match creates match row',
    cm.status === 200 && cm.body?.match_id && cm.body?.created === true,
    `status ${cm.status} ${JSON.stringify(cm.body)}`);
  const matchId = cm.body.match_id;

  // Re-call should be idempotent
  const cm2 = await call(capE, `/api/v3/fixtures/${fixtureId}/match`, { method: 'POST' });
  check('POST /fixtures/:id/match idempotent', cm2.body?.match_id === matchId && cm2.body?.created === false);

  // ── Locking ─────────────────────────────────────────────────────
  const lock = await call(capE, `/api/v3/matches/${matchId}/lock`, {
    method: 'POST', body: JSON.stringify({ clientId: 'tab-1' }),
  });
  check('captain acquires lock', lock.status === 200 && lock.body?.holder_user_id === capUser.id);

  // Different user → must be a member (admin works). Admin is owner so has access; sign up `otherE` as a non-member.
  await call(otherE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: otherE, password: pw, name: 'Other' }),
  });
  const lockOther = await call(otherE, `/api/v3/matches/${matchId}/lock`, {
    method: 'POST', body: JSON.stringify({ clientId: 'tab-other' }),
  });
  check('non-member cannot even attempt lock (403)', lockOther.status === 403);

  // Admin (tournament owner) tries to take the lock — should 409 LOCKED_OTHER.
  const lockAdmin = await call(adminE, `/api/v3/matches/${matchId}/lock`, {
    method: 'POST', body: JSON.stringify({ clientId: 'tab-admin' }),
  });
  check('second authorized user gets 409 LOCKED_OTHER',
    lockAdmin.status === 409 && lockAdmin.body?.code === 'LOCKED_OTHER');

  // ── Setup ───────────────────────────────────────────────────────
  const setup = await call(capE, `/api/v3/matches/${matchId}/setup`, {
    method: 'POST', body: JSON.stringify({
      toss_winner_team_id: teamAId,
      toss_decision: 'bat',
      overs_per_innings: 2,
      players_per_side: 6,
      batting_lineup_player_ids: teamAPlayers.map((p) => p.id),
      bowling_lineup_player_ids: teamBPlayers.map((p) => p.id),
    }),
  });
  check('setup match: 200 in_progress',
    setup.status === 200 && setup.body?.status === 'in_progress',
    `status ${setup.status} ${JSON.stringify(setup.body)}`);

  // Reload match — confirm overs + status persisted
  const matchAfterSetup = await call(capE, `/api/v3/matches/${matchId}`);
  check('match status=in_progress after setup', matchAfterSetup.body?.status === 'in_progress');
  check('overs_per_innings persisted', matchAfterSetup.body?.overs_per_innings === 2);
  check('current batting team = Alpha', matchAfterSetup.body?.current_batting_team_id === teamAId);

  // ── Append 12 events ────────────────────────────────────────────
  const striker = teamAPlayers[0].id;       // A1 — batting_order 1
  const nonStriker = teamAPlayers[1].id;    // A2 — batting_order 2
  const bowler = teamBPlayers[0].id;        // B1
  const newBatter = teamAPlayers[2].id;     // A3 — comes in on wicket

  async function append(partial, label) {
    const body = {
      batter_on_strike_player_id: striker,
      batter_non_strike_player_id: nonStriker,
      bowler_player_id: bowler,
      ...partial,
    };
    const r = await call(capE, `/api/v3/matches/${matchId}/events`, {
      method: 'POST', body: JSON.stringify(body),
    });
    return r;
  }

  let r;
  // Ball 1: 1 run (legal)
  r = await append({ runs_off_bat: 1 }, 'b1');
  check('ev1 (1 run): 200', r.status === 200);

  // Ball 2: 4 (boundary). The post-rotation striker is now whoever the engine
  // says, but we still send the same striker/non-striker for the *current*
  // ball — the engine tracks rotation internally on its own model. The new
  // strike is computed for the NEXT ball; clients normally call GET state to
  // see who's on strike. For the smoke we keep sending the same IDs; rotation
  // happens server-side and shows up in the returned state.
  r = await append({ runs_off_bat: 4 }, 'b2');
  check('ev2 (4): 200', r.status === 200);

  // Ball 3: wide +1 (illegal)
  r = await append({ runs_off_bat: 0, extras_runs: 1, extras_type: 'wide', legal_ball: false }, 'b3');
  check('ev3 (wide): 200', r.status === 200);

  // Ball 4: no-ball +1 (illegal)
  r = await append({ runs_off_bat: 0, extras_runs: 1, extras_type: 'no_ball', legal_ball: false }, 'b4');
  check('ev4 (no-ball): 200', r.status === 200);

  // Ball 5: bye 1 (legal — counts towards over)
  r = await append({ runs_off_bat: 0, extras_runs: 1, extras_type: 'bye', legal_ball: true }, 'b5');
  check('ev5 (bye): 200', r.status === 200);

  // Ball 6: leg-bye 2 (legal)
  r = await append({ runs_off_bat: 0, extras_runs: 2, extras_type: 'leg_bye', legal_ball: true }, 'b6');
  check('ev6 (leg-bye): 200', r.status === 200);

  // Ball 7: wicket (caught) — A1 out, A3 comes in
  r = await append({
    runs_off_bat: 0, is_wicket: true, wicket_type: 'caught',
    out_batter_player_id: striker, new_batter_player_id: newBatter,
  }, 'b7');
  check('ev7 (wicket caught): 200', r.status === 200);

  // Ball 8: 6
  r = await append({ runs_off_bat: 6 }, 'b8');
  check('ev8 (6): 200', r.status === 200);

  // Ball 9-11: three dots
  r = await append({ runs_off_bat: 0 }, 'b9');
  r = await append({ runs_off_bat: 0 }, 'b10');
  r = await append({ runs_off_bat: 0 }, 'b11');
  check('ev9-11 (dots): 200', r.status === 200);

  // Ball 12: end of over should be triggered after 6 legal balls.
  r = await append({ runs_off_bat: 0 }, 'b12');
  check('ev12: 200', r.status === 200);

  // Validate aggregate score so far via GET state.
  const state = await call(capE, `/api/v3/matches/${matchId}`);
  const innings1 = state.body?.state?.innings?.[0];
  // Off the bat: 1 + 4 + 6 = 11. Extras: wide 1 + no-ball 1 + bye 1 + leg-bye 2 = 5. Total = 16.
  // Wickets: 1.
  // Legal balls: b1, b2, b5, b6, b7, b8, b9, b10, b11, b12 = 10 legal balls.
  check('innings1 total runs == 16', innings1?.runs === 16, `got ${innings1?.runs}`);
  check('innings1 wickets == 1', innings1?.wickets === 1, `got ${innings1?.wickets}`);
  check('innings1 legal_balls == 10', innings1?.legal_balls === 10, `got ${innings1?.legal_balls}`);
  check('innings1 over string == "1.4"', innings1?.over === '1.4', `got ${innings1?.over}`);
  check('innings1 extras_total == 5', innings1?.extras_total === 5, `got ${innings1?.extras_total}`);

  // Undo last event
  const undo = await call(capE, `/api/v3/matches/${matchId}/events/last`, { method: 'DELETE' });
  check('undo last event: 200', undo.status === 200 && undo.body?.removed?.seq);
  const stateAfterUndo = await call(capE, `/api/v3/matches/${matchId}`);
  const innings1u = stateAfterUndo.body?.state?.innings?.[0];
  check('after undo: legal_balls == 9', innings1u?.legal_balls === 9, `got ${innings1u?.legal_balls}`);

  // ── Public score view: no scorer, no rosters ────────────────────
  const pub = await call(null, `/api/v3/matches/${matchId}/score`);
  check('public score 200', pub.status === 200);
  check('public score has innings totals',
    Array.isArray(pub.body?.innings) && pub.body.innings[0]?.runs >= 0);
  check('public score excludes scorer / rosters',
    !('scorer_user_id' in (pub.body || {})) && !('rosters' in (pub.body || {})));

  // ── Heartbeat ───────────────────────────────────────────────────
  const hb = await call(capE, `/api/v3/matches/${matchId}/lock/heartbeat`, {
    method: 'POST', body: JSON.stringify({ clientId: 'tab-1' }),
  });
  check('heartbeat 200', hb.status === 200 && hb.body?.expires_at);

  // ── WS smoke: connect, expect snapshot, expect broadcast on next event ─
  const wsUrl = BASE_URL.replace(/^http/, 'ws') + `/ws/match/${matchId}`;
  await new Promise((resolve) => {
    const messages = [];
    const ws = new WebSocket(wsUrl);
    let snapshotReceived = false;
    let broadcastReceived = false;
    ws.on('open', async () => {
      // Wait a tick for the snapshot to arrive, then post another event.
      await new Promise((r) => setTimeout(r, 200));
      await append({ runs_off_bat: 2 }, 'ws-trigger');
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      messages.push(msg);
      if (msg.type === 'snapshot') snapshotReceived = true;
      if (msg.type === 'event_appended') broadcastReceived = true;
      if (snapshotReceived && broadcastReceived) {
        check('WS received snapshot on connect', snapshotReceived);
        check('WS received event_appended broadcast', broadcastReceived);
        try { ws.close(); } catch {}
        resolve();
      }
    });
    ws.on('error', (err) => {
      check('WS connection error', false, err.message);
      resolve();
    });
    setTimeout(() => {
      if (!snapshotReceived || !broadcastReceived) {
        check('WS snapshot+broadcast in 5s', false,
          `received: ${messages.map((m) => m.type).join(',')}`);
        try { ws.close(); } catch {}
        resolve();
      }
    }, 5000);
  });

  // Release lock
  const rel = await call(capE, `/api/v3/matches/${matchId}/lock`, { method: 'DELETE' });
  check('release lock 200', rel.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  process.exit(1);
});
