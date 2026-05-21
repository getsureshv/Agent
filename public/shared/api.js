// Thin fetch wrapper. Same-origin: cookies go automatically; credentials: 'include'
// just makes it robust if the SPA is ever served from a different origin.

async function request(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  let parsed = null;
  const text = await res.text();
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const err = new Error(
      (parsed && typeof parsed === 'object' && parsed.error) || `HTTP ${res.status}`
    );
    err.status = res.status;
    err.code = parsed && parsed.code;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export const api = {
  get:    (p)       => request('GET',    p),
  post:   (p, body) => request('POST',   p, body),
  patch:  (p, body) => request('PATCH',  p, body),
  delete: (p)       => request('DELETE', p),
};
