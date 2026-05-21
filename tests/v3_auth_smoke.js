// Plain Node smoke test for /api/v3/auth — no test runner.
// Run a fresh server (empty users table) and execute:
//   node tests/v3_auth_smoke.js
// Optional env: BASE_URL (default http://localhost:3000)
//
// NOTE: This script assumes the users table is empty (so user1 becomes the
// first/global-admin user). If you've already created accounts, wipe the
// users table before running, or skip the is_global_admin assertion.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
    fail++;
  }
}

function extractSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // node fetch returns a single string; cookie-parser-compatible parse
  const m = String(setCookieHeader).match(/cs_session=([^;]+)/);
  return m ? m[1] : null;
}

async function call(path, opts = {}) {
  const res = await fetch(BASE_URL + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') };
}

async function main() {
  const stamp = Date.now();
  const user1 = { email: `smoke1+${stamp}@example.test`, password: 'password123', name: 'Smoke One' };
  const user2 = { email: `smoke2+${stamp}@example.test`, password: 'password123', name: 'Smoke Two' };

  console.log(`Smoke testing ${BASE_URL}`);

  // 1) signup user1
  const s1 = await call('/api/v3/auth/signup', { method: 'POST', body: JSON.stringify(user1) });
  check('signup user1 returns 200', s1.status === 200, `got ${s1.status} ${JSON.stringify(s1.body)}`);
  check('signup user1 is_global_admin=true (first user)',
    !!(s1.body && s1.body.user && s1.body.user.is_global_admin === true),
    'expected first user to be admin — was the users table empty before this run?');
  const cookie1 = extractSessionCookie(s1.setCookie);
  check('signup user1 sets cs_session cookie', !!cookie1);

  // 2) signup user2
  const s2 = await call('/api/v3/auth/signup', { method: 'POST', body: JSON.stringify(user2) });
  check('signup user2 returns 200', s2.status === 200, `got ${s2.status}`);
  check('signup user2 is_global_admin=false',
    !!(s2.body && s2.body.user && s2.body.user.is_global_admin === false));

  // 3) login user1 with correct password
  const l1 = await call('/api/v3/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: user1.email, password: user1.password }),
  });
  check('login user1 correct pw returns 200', l1.status === 200, `got ${l1.status}`);
  const loginCookie = extractSessionCookie(l1.setCookie);
  check('login user1 sets cs_session cookie', !!loginCookie);

  // 4) login user1 with wrong password
  const lBad = await call('/api/v3/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: user1.email, password: 'wrongpassword' }),
  });
  check('login user1 wrong pw returns 401', lBad.status === 401, `got ${lBad.status}`);

  // 5) GET /me with cookie
  const me = await call('/api/v3/auth/me', { headers: { cookie: `cs_session=${loginCookie}` } });
  check('GET /me with cookie returns 200', me.status === 200, `got ${me.status}`);
  check('GET /me returns correct email',
    !!(me.body && me.body.user && me.body.user.email === user1.email),
    `got ${JSON.stringify(me.body)}`);

  // 6) logout
  const lo = await call('/api/v3/auth/logout', {
    method: 'POST',
    headers: { cookie: `cs_session=${loginCookie}` },
  });
  check('POST /logout returns 200', lo.status === 200, `got ${lo.status}`);

  // 7) GET /me after logout — session row should be gone
  const meAfter = await call('/api/v3/auth/me', { headers: { cookie: `cs_session=${loginCookie}` } });
  check('GET /me after logout returns 401', meAfter.status === 401, `got ${meAfter.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
