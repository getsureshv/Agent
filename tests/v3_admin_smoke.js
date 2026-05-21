// End-to-end smoke test for the v3 admin API.
// Run a fresh server with an empty (or admin-only) DB and:
//   node tests/v3_admin_smoke.js
// Optional env: BASE_URL (default http://localhost:3000)
//
// Uses per-user cookie jars (a Map keyed by email).

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); fail++; }
}

const jars = new Map(); // email -> session cookie value
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
  const res = await fetch(BASE_URL + path, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (asEmail) saveCookie(asEmail, res.headers.get('set-cookie'));
  return { status: res.status, body };
}

async function main() {
  const stamp = Date.now();
  const adminE   = `admin+${stamp}@test.example`;
  const captainE = `captain+${stamp}@test.example`;
  const scorerE  = `scorer+${stamp}@test.example`;
  const pw = 'password123';

  console.log(`Smoke testing ${BASE_URL}\n`);

  // 1) Sign up three users
  const s1 = await call(adminE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: adminE, password: pw, name: 'Admin User' }),
  });
  check('signup admin', s1.status === 200, `status ${s1.status} ${JSON.stringify(s1.body)}`);

  const s2 = await call(captainE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: captainE, password: pw, name: 'Captain User' }),
  });
  check('signup captain', s2.status === 200);

  const s3 = await call(scorerE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: scorerE, password: pw, name: 'Scorer User' }),
  });
  check('signup scorer', s3.status === 200);

  // 2) admin creates tournament T1
  const ct = await call(adminE, '/api/v3/tournaments', {
    method: 'POST',
    body: JSON.stringify({ name: `Smoke T1 ${stamp}`, format: 'league', overs_per_innings: 10 }),
  });
  check('create tournament', ct.status === 200 && !!ct.body?.tournament?.id, `status ${ct.status}`);
  const tournamentId = ct.body?.tournament?.id;

  // 3) add two teams
  const tA = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Team Alpha' }),
  });
  check('add Team Alpha', tA.status === 200);
  const teamAId = tA.body?.team?.id;

  const tB = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Team Bravo' }),
  });
  check('add Team Bravo', tB.status === 200);

  // 4) invite captain to Team Alpha
  const inv = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ email: captainE, role: 'captain', team_id: teamAId }),
  });
  check('create captain invite', inv.status === 200 && !!inv.body?.share_url, `status ${inv.status} ${JSON.stringify(inv.body)}`);
  const inviteToken = inv.body?.token;

  // 5) captain views the invite (public endpoint, no auth needed)
  const view = await call(null, `/api/v3/invites/${inviteToken}`);
  check('GET invite by token (public)', view.status === 200);
  check('invite info has tournament name', view.body?.tournament_name?.startsWith('Smoke T1 '));

  // 6) captain accepts
  const acc = await call(captainE, `/api/v3/invites/${inviteToken}/accept`, { method: 'POST' });
  check('captain accepts invite', acc.status === 200 && acc.body?.team_id === teamAId, `status ${acc.status} ${JSON.stringify(acc.body)}`);

  // 7) admin re-fetches teams → Team Alpha now has captain_user_id
  const tlist = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`);
  const teamAfter = tlist.body?.teams?.find((t) => t.id === teamAId);
  check('Team Alpha captain now set', teamAfter?.captain_email === captainE,
    `captain_email=${teamAfter?.captain_email}`);

  // 8) double-accept rejected
  const double = await call(captainE, `/api/v3/invites/${inviteToken}/accept`, { method: 'POST' });
  check('double-accept rejected with 409', double.status === 409, `status ${double.status}`);

  // 9) add one manual fixture, then generate round-robin
  const fix1 = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures`, {
    method: 'POST', body: JSON.stringify({ team_a_id: teamAId, team_b_id: tB.body.team.id }),
  });
  check('add manual fixture', fix1.status === 200);

  const gen = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures/generate`, {
    method: 'POST', body: JSON.stringify({ format: 'round-robin' }),
  });
  // Two teams → exactly 1 generated fixture (in addition to manual one)
  check('generate round-robin creates 1 fixture for 2 teams', gen.body?.created === 1,
    `created=${gen.body?.created}`);

  const flist = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures`);
  check('fixtures list now has 2 fixtures', flist.body?.fixtures?.length === 2,
    `len=${flist.body?.fixtures?.length}`);

  // 10) invite scorer
  const sinv = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: scorerE, role: 'scorer' }),
  });
  check('create scorer invite', sinv.status === 200);

  // 11) accept scorer invite
  const sacc = await call(scorerE, `/api/v3/invites/${sinv.body.token}/accept`, { method: 'POST' });
  check('scorer accepts invite', sacc.status === 200 && sacc.body?.role === 'scorer');

  // 12) admin assigns scorer to fixture
  const firstFixture = flist.body.fixtures[0];
  const assign = await call(adminE, `/api/v3/tournaments/${tournamentId}/fixtures/${firstFixture.id}`, {
    method: 'PATCH', body: JSON.stringify({ scorer_user_id: s3.body.user.id }),
  });
  check('assign scorer to fixture',
    assign.status === 200 && assign.body?.fixture?.scorer_email === scorerE,
    `body=${JSON.stringify(assign.body)}`);

  // 13) /api/v3/users/search finds our users
  const search = await call(adminE, `/api/v3/users/search?q=admin%2B${stamp}`);
  check('user search finds admin', (search.body?.users || []).some((u) => u.email === adminE),
    `users=${JSON.stringify(search.body?.users)}`);

  // 14) member tournaments list reflects membership
  const myCaptainList = await call(captainE, '/api/v3/tournaments');
  check('captain sees tournament in their list',
    (myCaptainList.body?.tournaments || []).some((t) => t.id === tournamentId));

  const myScorerList = await call(scorerE, '/api/v3/tournaments');
  check('scorer sees tournament in their list',
    (myScorerList.body?.tournaments || []).some((t) => t.id === tournamentId));

  // 15) cross-tournament authz: scorer cannot POST a team
  const forbid = await call(scorerE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Hijack FC' }),
  });
  check('non-owner cannot add team (403)', forbid.status === 403, `status ${forbid.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
