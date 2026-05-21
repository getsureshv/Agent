// Small helpers shared across routes.

// Build a fully-qualified URL for an in-app path. Order of preference:
//   1. PUBLIC_BASE_URL env var (override for prod or tests)
//   2. X-Forwarded-Proto + X-Forwarded-Host (set by Render's proxy)
//   3. req.protocol + req.get('host') (local dev)
// app.set('trust proxy', 1) in server.js makes req.protocol honor
// X-Forwarded-Proto; req.get('host') always returns the raw Host header
// so we read X-Forwarded-Host explicitly.
export function buildShareUrl(req, path = '/') {
  let base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    const proto = req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    base = `${proto}://${host}`;
  }
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return cleanBase + cleanPath;
}
