// End-to-end smoke for PR 5 — player profiles, self-onboarding flow,
// admin verification, and the HTTPS share-URL fix.
//
//   node tests/v3_player_smoke.js
//   BASE_URL=http://localhost:3000 node tests/v3_player_smoke.js

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
  const adminE   = `pl-admin+${stamp}@test.example`;
  const capE     = `pl-cap+${stamp}@test.example`;
  const playerE  = `pl-player+${stamp}@test.example`;
  const otherE   = `pl-other+${stamp}@test.example`;
  const pw = 'password123';

  console.log(`Smoke testing ${BASE_URL}\n`);

  // ── Admin setup ─────────────────────────────────────────────────
  const su = await call(adminE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: adminE, password: pw, name: 'Admin' }),
  });
  check('signup admin', su.status === 200);

  const tRes = await call(adminE, '/api/v3/tournaments', {
    method: 'POST', body: JSON.stringify({ name: `Profiles ${stamp}`, format: 'league', is_public: true }),
  });
  check('create tournament', tRes.status === 200);
  const tournamentId = tRes.body.tournament.id;

  const tA = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Alpha' }),
  });
  const tB = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Bravo' }),
  });
  check('add teams', tA.status === 200 && tB.status === 200);
  const teamAId = tA.body.team.id;

  // Create + accept captain invite for team A
  const capInv = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST', body: JSON.stringify({ email: capE, role: 'captain', team_id: teamAId }),
  });
  check('issue captain invite', capInv.status === 200);
  await call(capE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: capE, password: pw, name: 'Captain' }),
  });
  const capAcc = await call(capE, `/api/v3/invites/${capInv.body.token}/accept`, { method: 'POST' });
  check('captain accepts invite', capAcc.status === 200);

  // ── 3. Captain creates a placeholder player ─────────────────────
  const create = await call(capE, `/api/v3/teams/${teamAId}/players`, {
    method: 'POST', body: JSON.stringify({ name: 'Phineas Placeholder', batting_order: 4, role: 'batsman' }),
  });
  check('captain creates placeholder player', create.status === 200, JSON.stringify(create.body));
  const playerId = create.body.player.id;
  check('new player profile_status=placeholder', create.body.player.profile_status === 'placeholder');
  check('new player has CSP code', /^CSP\d{5}$/.test(create.body.player.player_code || ''));

  // ── 4. Captain tries to PATCH a profile field → 403 ─────────────
  const captainProfileAttempt = await call(capE, `/api/v3/players/${playerId}/profile`, {
    method: 'PATCH', body: JSON.stringify({ first_name: 'Phineas' }),
  });
  check('captain PATCH /profile → 403',
    captainProfileAttempt.status === 403, `status ${captainProfileAttempt.status}`);

  // Captain also can't sneak profile fields into the slim PATCH
  const sneaky = await call(capE, `/api/v3/players/${playerId}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'New name', first_name: 'Phineas' }),
  });
  check('captain PATCH with profile key → 403',
    sneaky.status === 403 && sneaky.body?.code === 'FORBIDDEN_PROFILE_FIELDS');

  // Slim fields still work
  const slimOk = await call(capE, `/api/v3/players/${playerId}`, {
    method: 'PATCH', body: JSON.stringify({ batting_order: 5 }),
  });
  check('captain slim PATCH 200', slimOk.status === 200 && slimOk.body?.player?.batting_order === 5);

  // ── 5. Captain issues player invite ─────────────────────────────
  const playerInv = await call(capE, `/api/v3/players/${playerId}/invite`, {
    method: 'POST', body: JSON.stringify({ email: playerE }),
  });
  check('issue player invite', playerInv.status === 200 && !!playerInv.body?.share_url);
  const playerInvToken = playerInv.body.token;
  check('share_url present', /\/invite\//.test(playerInv.body.share_url));

  const afterInvite = await call(capE, `/api/v3/players/${playerId}`);
  check('profile_status now invited',
    afterInvite.body?.player?.profile_status === 'invited',
    `got ${afterInvite.body?.player?.profile_status}`);

  // ── 6. Player signs up and accepts invite ───────────────────────
  await call(playerE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: playerE, password: pw, name: 'Player User' }),
  });
  const playerAcc = await call(playerE, `/api/v3/invites/${playerInvToken}/accept`, { method: 'POST' });
  check('player accepts invite',
    playerAcc.status === 200 && playerAcc.body?.player_id === playerId,
    `status ${playerAcc.status} ${JSON.stringify(playerAcc.body)}`);
  check('redirect_to points to /app/player/',
    (playerAcc.body?.redirect_to || '').startsWith('/app/player/'));

  const afterAccept = await call(capE, `/api/v3/players/${playerId}`);
  check('profile_status now self_registered',
    afterAccept.body?.player?.profile_status === 'self_registered');
  check('user_id linked to player',
    !!afterAccept.body?.player?.user_id);

  // ── 7. Player updates their profile ────────────────────────────
  const profileUpd = await call(playerE, `/api/v3/players/${playerId}/profile`, {
    method: 'PATCH',
    body: JSON.stringify({
      first_name: 'Phineas',
      last_name:  'Placeholder',
      date_of_birth: '1995-06-15',
      phone_number: '+1-555-0100',
      batting_style: 'right_hand',
      bowling_style: 'right_arm',
      bowling_type:  'medium_fast',
      category: 'mens',
      is_certified_umpire: true,
    }),
  });
  check('player PATCH /profile 200', profileUpd.status === 200, JSON.stringify(profileUpd.body));
  check('profile fields persisted',
    profileUpd.body?.player?.first_name === 'Phineas'
    && profileUpd.body?.player?.batting_style === 'right_hand'
    && profileUpd.body?.player?.is_certified_umpire === true);

  // ── 8. Player tries to edit someone else's profile ─────────────
  // Create a second placeholder player by captain, then have first player attempt.
  const p2 = await call(capE, `/api/v3/teams/${teamAId}/players`, {
    method: 'POST', body: JSON.stringify({ name: 'Another Player' }),
  });
  const otherProfile = await call(playerE, `/api/v3/players/${p2.body.player.id}/profile`, {
    method: 'PATCH', body: JSON.stringify({ first_name: 'Hijack' }),
  });
  check('player PATCH another player /profile → 403', otherProfile.status === 403);

  // ── 9. Captain re-invites same player → stale invite GET → 410 ─
  const reInv = await call(capE, `/api/v3/players/${p2.body.player.id}/invite`, {
    method: 'POST', body: JSON.stringify({ email: `pl-reinv+${stamp}@test.example` }),
  });
  check('first invite for p2 issued', reInv.status === 200);
  const reInv2 = await call(capE, `/api/v3/players/${p2.body.player.id}/invite`, {
    method: 'POST', body: JSON.stringify({ email: `pl-reinv+${stamp}@test.example` }),
  });
  check('re-invite issued', reInv2.status === 200);
  check('re-invite auto-revoked the previous', reInv2.body?.revoked_previous === 1);
  const stale = await call(null, `/api/v3/invites/${reInv.body.token}`);
  check('stale invite GET → 410', stale.status === 410);

  // ── 10. Admin verifies the self-registered player ──────────────
  // /verify is global-admin-only. The first signup in any DB becomes admin;
  // if a previous smoke claimed that slot, skip the verify checks.
  const meAdmin = await call(adminE, '/api/v3/auth/me');
  const isAdmin = !!meAdmin.body?.user?.is_global_admin;
  if (!isAdmin) {
    console.log('  SKIP  admin verifies player (this run is not first-signup, no global admin)');
    console.log('  SKIP  verify placeholder → 409');
  } else {
    const verifyOk = await call(adminE, `/api/v3/players/${playerId}/verify`, { method: 'POST' });
    check('admin verifies player 200',
      verifyOk.status === 200
      && verifyOk.body?.player?.profile_status === 'verified'
      && verifyOk.body?.player?.is_verified === true);
    const verifyBad = await call(adminE, `/api/v3/players/${p2.body.player.id}/verify`, { method: 'POST' });
    check('verify placeholder → 409',
      verifyBad.status === 409 && verifyBad.body?.code === 'INVALID_STATE');
  }

  // ── 12. GET /players/:id without auth → 401 ────────────────────
  const noauth = await call(null, `/api/v3/players/${playerId}`);
  check('GET player without auth → 401', noauth.status === 401);

  // ── 13. /auth/me returns players array ─────────────────────────
  const me = await call(playerE, '/api/v3/auth/me');
  check('GET /me returns players array',
    Array.isArray(me.body?.players) && me.body.players.length === 1);
  check('/me players[0] has player_code',
    /^CSP\d{5}$/.test(me.body?.players?.[0]?.player_code || ''));

  // ── 14. HTTPS share-URL via X-Forwarded-Proto ──────────────────
  // server.js sets trust proxy:1; a Resend send isn't needed — the
  // /email endpoint computes shareUrl using buildShareUrl regardless of
  // whether mail succeeds. Force PUBLIC_BASE_URL=null in the smoke env;
  // here we just check the GET invite endpoint passes through https:
  const httpsCheck = await call(null, `/api/v3/invites/${playerInvToken}`, {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cricket-scorer-asmc.onrender.com' },
  });
  // GET invite endpoint doesn't itself build a share URL in the response,
  // so we check via the captain-side invite create response (already a
  // share_url) does the same. Issue a fresh invite with the forwarded
  // headers and confirm the URL scheme.
  const p3 = await call(capE, `/api/v3/teams/${teamAId}/players`, {
    method: 'POST', body: JSON.stringify({ name: 'Third Player' }),
  });
  const httpsInv = await call(capE, `/api/v3/players/${p3.body.player.id}/invite`, {
    method: 'POST',
    body: JSON.stringify({ email: `pl-https+${stamp}@test.example` }),
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cricket-scorer-asmc.onrender.com' },
  });
  check('issue invite via x-forwarded headers', httpsInv.status === 200);
  check('share_url respects X-Forwarded-Proto=https',
    (httpsInv.body?.share_url || '').startsWith('https://'),
    `share_url=${httpsInv.body?.share_url}`);
  check('share_url respects X-Forwarded-Host',
    (httpsInv.body?.share_url || '').includes('cricket-scorer-asmc.onrender.com'),
    `share_url=${httpsInv.body?.share_url}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  process.exit(1);
});
