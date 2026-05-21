// End-to-end smoke test for PR 3 — captain flow, ACL changes, auto-revoke,
// fixture replace-mode, and player CRUD.
//
//   node tests/v3_captain_smoke.js
//   BASE_URL=http://localhost:3000 node tests/v3_captain_smoke.js
//
// Uses per-user cookie jars (a Map keyed by email).

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0;
let fail = 0;
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
  const cookie = asEmail ? cookieFor(asEmail) : '';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE_URL + path, { ...opts, headers, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (asEmail) saveCookie(asEmail, res.headers.get('set-cookie'));
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  const stamp = Date.now();
  const adminE   = `admin+${stamp}@test.example`;
  const capE     = `captain+${stamp}@test.example`;
  const otherCapE = `othercap+${stamp}@test.example`;
  const pw = 'password123';

  console.log(`Smoke testing ${BASE_URL}\n`);

  // ── Setup: admin, tournament, 2 teams, 1 fixture ────────────────
  const s1 = await call(adminE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: adminE, password: pw, name: 'Admin' }),
  });
  check('signup admin', s1.status === 200, `status ${s1.status} ${JSON.stringify(s1.body)}`);

  const tRes = await call(adminE, '/api/v3/tournaments', {
    method: 'POST', body: JSON.stringify({ name: `Captain Smoke ${stamp}`, format: 'league', is_public: true }),
  });
  check('create public tournament', tRes.status === 200);
  const tournamentId = tRes.body.tournament.id;

  const tA = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Alpha' }),
  });
  check('create team A', tA.status === 200);
  const teamAId = tA.body.team.id;

  const tB = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Bravo' }),
  });
  check('create team B', tB.status === 200);
  const teamBId = tB.body.team.id;

  const fx1 = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures`, {
    method: 'POST', body: JSON.stringify({ team_a_id: teamAId, team_b_id: teamBId }),
  });
  check('create manual fixture', fx1.status === 200);

  // ── Captain invite + accept flow ─────────────────────────────────
  const inv1 = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: capE, role: 'captain', team_id: teamAId }),
  });
  check('create captain invite', inv1.status === 200);
  const token1 = inv1.body.token;

  // /invite/:token public landing page must return SPA HTML (the admin shell)
  const land = await call(null, `/invite/${token1}`);
  check('GET /invite/:token returns HTML (SPA shell)',
    land.status === 200 && typeof land.body === 'string' && land.body.includes('<!doctype html>'),
    `status ${land.status}`);

  // GET invite info (public) should advertise the captain redirect target
  const info1 = await call(null, `/api/v3/invites/${token1}`);
  check('GET invite info: role=captain', info1.body?.role === 'captain');
  check('GET invite info: redirect_to points at /app/captain/',
    info1.body?.redirect_to === '/app/captain/',
    `got ${info1.body?.redirect_to}`);

  // Captain signs up, then accepts the invite.
  const capSignup = await call(capE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: capE, password: pw, name: 'Captain' }),
  });
  check('signup captain', capSignup.status === 200);

  const acc = await call(capE, `/api/v3/invites/${token1}/accept`, { method: 'POST' });
  check('accept captain invite', acc.status === 200 && acc.body?.team_id === teamAId);
  check('accept response redirect_to=/app/captain/#/dashboard',
    acc.body?.redirect_to === '/app/captain/#/dashboard',
    `got ${acc.body?.redirect_to}`);

  // ── Captain creates 3 players on team A ──────────────────────────
  const p1 = await call(capE, `/api/v3/teams/${teamAId}/players`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Player One', batting_order: 1, role: 'batsman', is_captain: true }),
  });
  check('captain creates player 1', p1.status === 200 && p1.body?.player?.batting_order === 1);
  const p2 = await call(capE, `/api/v3/teams/${teamAId}/players`, {
    method: 'POST', body: JSON.stringify({ name: 'Player Two', role: 'bowler' }),
  });
  check('captain creates player 2', p2.status === 200);
  const p3 = await call(capE, `/api/v3/teams/${teamAId}/players`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Player Three', role: 'wicket-keeper', is_wicket_keeper: true }),
  });
  check('captain creates player 3', p3.status === 200);

  // List should return 3, ordered with NULL batting_order last
  const list = await call(capE, `/api/v3/teams/${teamAId}/players`);
  check('list players returns 3', (list.body?.players || []).length === 3,
    `got ${(list.body?.players || []).length}`);
  check('player list sorted (1 first)', list.body?.players?.[0]?.batting_order === 1);

  // ── PATCH + DELETE ──────────────────────────────────────────────
  const patch = await call(capE, `/api/v3/players/${p2.body.player.id}`, {
    method: 'PATCH', body: JSON.stringify({ batting_order: 4, notes: 'opening bowler' }),
  });
  check('captain patches player 2', patch.status === 200 && patch.body?.player?.batting_order === 4);

  // batting_order out of range → 400
  const bad = await call(capE, `/api/v3/players/${p2.body.player.id}`, {
    method: 'PATCH', body: JSON.stringify({ batting_order: 99 }),
  });
  check('PATCH rejects batting_order > 15', bad.status === 400, `got ${bad.status}`);

  // Other captain (no relationship to team) → 403
  await call(otherCapE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: otherCapE, password: pw, name: 'Other' }),
  });
  const forbid = await call(otherCapE, `/api/v3/players/${p2.body.player.id}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'Hijack' }),
  });
  check('non-captain PATCH player → 403', forbid.status === 403, `got ${forbid.status}`);

  const del = await call(capE, `/api/v3/players/${p3.body.player.id}`, { method: 'DELETE' });
  check('captain deletes player 3', del.status === 200);

  // ── Captain dashboard: tournament + fixture should be visible ────
  const myT = await call(capE, '/api/v3/tournaments');
  check('captain sees tournament in their list',
    (myT.body?.tournaments || []).some((t) => t.id === tournamentId));

  // ── Scores-only public ACL ──────────────────────────────────────
  // Tournament metadata: public
  const pubT = await call(null, `/api/v3/tournaments/${tournamentId}`);
  check('public can GET tournament metadata', pubT.status === 200 && pubT.body?.role === 'public');
  check('public response excludes owner_user_id',
    pubT.body?.tournament && !('owner_user_id' in pubT.body.tournament),
    `keys=${Object.keys(pubT.body?.tournament || {})}`);

  // Fixtures list: public, but scorer fields stripped
  const pubF = await call(null, `/api/v3/tournaments/${tournamentId}/fixtures`);
  check('public can GET fixtures list', pubF.status === 200);
  check('public fixtures list omits scorer_email',
    (pubF.body?.fixtures || []).every((f) => !('scorer_email' in f)));

  // Teams list: NOT public anymore
  const pubTeams = await call(null, `/api/v3/tournaments/${tournamentId}/teams`);
  check('public CANNOT GET teams list (was public in PR 2)', pubTeams.status === 401,
    `got ${pubTeams.status}`);

  // Team detail: requires auth
  const pubTeam = await call(null, `/api/v3/teams/${teamAId}`);
  check('public CANNOT GET team detail', pubTeam.status === 401, `got ${pubTeam.status}`);

  // Players: requires auth
  const pubPlayers = await call(null, `/api/v3/teams/${teamAId}/players`);
  check('public CANNOT GET roster', pubPlayers.status === 401, `got ${pubPlayers.status}`);

  // Fixture detail: requires auth even for is_public tournament
  const pubFix = await call(null, `/api/v3/fixtures/${fx1.body.fixture.id}`);
  check('public CANNOT GET fixture detail', pubFix.status === 401, `got ${pubFix.status}`);

  // ── Auto-revoke on re-invite ────────────────────────────────────
  const cap2E = `cap2+${stamp}@test.example`;
  const inv2 = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: cap2E, role: 'captain', team_id: teamBId }),
  });
  check('issue captain invite for team B', inv2.status === 200);

  const inv3 = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: cap2E, role: 'captain', team_id: teamBId }),
  });
  check('re-issue captain invite for team B', inv3.status === 200);
  check('re-issue reports revoked_previous=1', inv3.body?.revoked_previous === 1,
    `revoked_previous=${inv3.body?.revoked_previous}`);

  // First token is now revoked → 410 with REVOKED code
  const stale = await call(null, `/api/v3/invites/${inv2.body.token}`);
  check('GET on superseded invite → 410', stale.status === 410, `got ${stale.status}`);
  check('GET on superseded invite → code REVOKED', stale.body?.code === 'REVOKED');

  // Accept on stale token also rejected
  await call(cap2E, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: cap2E, password: pw, name: 'Cap2' }),
  });
  const accStale = await call(cap2E, `/api/v3/invites/${inv2.body.token}/accept`, { method: 'POST' });
  check('POST accept on superseded invite → 410', accStale.status === 410);

  // New token works
  const accNew = await call(cap2E, `/api/v3/invites/${inv3.body.token}/accept`, { method: 'POST' });
  check('POST accept on new invite → 200', accNew.status === 200);

  // ── Don't clobber existing captain ──────────────────────────────
  const dupInv = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: otherCapE, role: 'captain', team_id: teamAId }),
  });
  check('admin can create captain invite for already-claimed team A', dupInv.status === 200);
  const dupAcc = await call(otherCapE, `/api/v3/invites/${dupInv.body.token}/accept`, { method: 'POST' });
  check('accept invite for team that already has a captain → 409',
    dupAcc.status === 409 && dupAcc.body?.code === 'TEAM_HAS_CAPTAIN',
    `status ${dupAcc.status} ${JSON.stringify(dupAcc.body)}`);

  // ── Fixture replace mode ────────────────────────────────────────
  // Initial fixture count = 1 (the manual one).
  // Generate add: round-robin on 2 teams → +1 fixture (total 2).
  const gAdd = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures/generate`, {
    method: 'POST', body: JSON.stringify({ format: 'round-robin' }),
  });
  check('generate (add) creates 1 fixture for 2 teams', gAdd.body?.created === 1);

  const flist1 = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures`);
  check('fixtures list now has 2', (flist1.body?.fixtures || []).length === 2);

  // Replace mode: no fixtures have events, so all 2 should be deleted then 1 generated.
  const gRep = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures/generate?mode=replace`, {
    method: 'POST', body: JSON.stringify({ format: 'round-robin' }),
  });
  check('replace mode response: created=1', gRep.body?.created === 1, `body=${JSON.stringify(gRep.body)}`);
  check('replace mode response: deleted=2', gRep.body?.deleted === 2);
  check('replace mode response: preserved_fixtures=[]',
    Array.isArray(gRep.body?.preserved_fixtures) && gRep.body.preserved_fixtures.length === 0);

  const flist2 = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures`);
  check('fixtures list after replace has 1', (flist2.body?.fixtures || []).length === 1);

  // ── /api/v3/matches/:id/score smoke (no match exists yet → 404) ──
  const noMatch = await call(null, `/api/v3/matches/00000000-0000-0000-0000-000000000000/score`);
  check('GET /matches/:id/score on missing match → 404', noMatch.status === 404);

  // ── /app/captain SPA shell ──────────────────────────────────────
  const shell = await call(null, '/app/captain/');
  check('GET /app/captain/ returns HTML',
    shell.status === 200 && typeof shell.body === 'string' && shell.body.includes('Captain'),
    `status ${shell.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
