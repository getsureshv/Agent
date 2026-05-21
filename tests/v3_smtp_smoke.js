// Smoke for the PR 3.5 SMTP wiring. Runs against BASE_URL (default
// http://localhost:3000). Does NOT attempt a real send — verifies the
// unconfigured path behaves correctly and the new endpoints exist.
//
//   node tests/v3_smtp_smoke.js
//
// Re-run with SMTP_USER/SMTP_PASS in the *server's* env (not this script's)
// to exercise the configured branch — those checks are skipped here so the
// test stays green in CI.

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
  console.log(`Smoke testing ${BASE_URL}\n`);
  const stamp = Date.now();
  const adminE = `smtp-admin+${stamp}@test.example`;
  const otherE = `smtp-other+${stamp}@test.example`;
  const pw = 'password123';

  // ── /api/v3/config (public) ─────────────────────────────────────
  const cfg = await call(null, '/api/v3/config');
  check('GET /api/v3/config returns 200', cfg.status === 200);
  check('GET /api/v3/config has emailConfigured boolean',
    typeof cfg.body?.emailConfigured === 'boolean',
    `body=${JSON.stringify(cfg.body)}`);
  check('GET /api/v3/config has publicBaseUrl key (string|null)',
    'publicBaseUrl' in (cfg.body || {}));

  // Whether the rest of the test exercises the configured or unconfigured
  // branch depends on the SERVER's env. In CI we expect unconfigured.
  const configured = cfg.body?.emailConfigured === true;
  console.log(configured
    ? '  (note) Server reports emailConfigured=true — testing the configured branch.'
    : '  (note) Server reports emailConfigured=false — testing the unconfigured branch.');

  // ── Set up an admin + tournament + captain invite ───────────────
  const s = await call(adminE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: adminE, password: pw, name: 'SMTP Admin' }),
  });
  check('signup admin', s.status === 200);

  const tRes = await call(adminE, '/api/v3/tournaments', {
    method: 'POST', body: JSON.stringify({ name: `SMTP T ${stamp}`, format: 'league' }),
  });
  check('create tournament', tRes.status === 200);
  const tournamentId = tRes.body.tournament.id;

  const tA = await call(adminE, `/api/v3/tournaments/${tournamentId}/teams`, {
    method: 'POST', body: JSON.stringify({ name: 'Smoke Team' }),
  });
  check('add team', tA.status === 200);

  const inv = await call(adminE, `/api/v3/tournaments/${tournamentId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ email: `captain+${stamp}@test.example`, role: 'captain', team_id: tA.body.team.id }),
  });
  check('create captain invite', inv.status === 200);
  const token = inv.body.token;

  // ── POST /email when mailer NOT configured → 503 ────────────────
  if (!configured) {
    const r = await call(adminE, `/api/v3/invites/${token}/email`, { method: 'POST' });
    check('POST /email → 503 when mailer not configured', r.status === 503,
      `status ${r.status} ${JSON.stringify(r.body)}`);
    check('503 body has helpful message',
      typeof r.body?.error === 'string' && /Email not configured/i.test(r.body.error),
      `error=${r.body?.error}`);
    check('503 body code=EMAIL_NOT_CONFIGURED',
      r.body?.code === 'EMAIL_NOT_CONFIGURED');
  } else {
    console.log('  (skip) Configured-server send checks not run from CI — verify by clicking Send in the SPA.');
  }

  // ── 404 path: bogus token ───────────────────────────────────────
  // Mailer is checked AFTER the row lookup in our handler, so this is 404
  // even when SMTP is unset.
  const bogus = await call(adminE, '/api/v3/invites/zzznotreal/email', { method: 'POST' });
  check('POST /email on bogus token → 404', bogus.status === 404, `status ${bogus.status}`);

  // ── Auth path: non-owner gets 403 ───────────────────────────────
  await call(otherE, '/api/v3/auth/signup', {
    method: 'POST', body: JSON.stringify({ email: otherE, password: pw, name: 'Other' }),
  });
  const forbid = await call(otherE, `/api/v3/invites/${token}/email`, { method: 'POST' });
  check('non-owner POST /email → 403', forbid.status === 403, `status ${forbid.status}`);

  // ── 401 path: no session ────────────────────────────────────────
  const noauth = await call(null, `/api/v3/invites/${token}/email`, { method: 'POST' });
  check('unauthenticated POST /email → 401', noauth.status === 401, `status ${noauth.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  process.exit(1);
});
