/**
 * src/sync/auth.js
 *
 * Device-token authentication for the Agent base server.
 *
 * On first run, registerDevice() is called automatically and the returned
 * UUID token is persisted in localStorage.  Subsequent loads reuse the
 * stored token with no network round-trip.
 *
 * The token is sent as  Authorization: Bearer <token>  on every API call.
 *
 * Usage:
 *   import { getDeviceToken, authHeaders, signOut } from './auth.js';
 *
 * @module auth
 */

const TOKEN_KEY = 'cricket_device_token';

// ── Device registration ───────────────────────────────────────────────────────

/**
 * Register this device with the Agent base server.
 * POSTs to /api/devices/register and stores the returned token.
 *
 * @returns {Promise<string>} the new device token UUID
 * @throws  {Error}          if the server returns a non-OK response
 */
export async function registerDevice() {
  const base = window.__APP_CONFIG__?.BASE_URL;
  if (!base) {
    throw new Error(
      '[auth] window.__APP_CONFIG__.BASE_URL is not set. ' +
      'Copy config.example.js → config.js and fill in your BASE_URL.'
    );
  }

  const res = await fetch(`${base}/api/devices/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ label: navigator.userAgent.slice(0, 80) }),
  });

  if (!res.ok) {
    throw new Error(`[auth] register failed: ${res.status}`);
  }

  const { token: newToken } = await res.json();
  localStorage.setItem(TOKEN_KEY, newToken);
  // Also expose on the global config object for convenience
  if (window.__APP_CONFIG__) {
    window.__APP_CONFIG__._deviceToken = newToken;
  }
  return newToken;
}

/**
 * Returns the stored device token, registering with the server if none exists.
 *
 * @returns {Promise<string>} device UUID token
 */
export async function getDeviceToken() {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) return stored;

  // First run — auto-register
  return registerDevice();
}

/**
 * Returns the stored token synchronously, or null if not yet registered.
 * Useful for quick guards that cannot await.
 *
 * @returns {string|null}
 */
export function getDeviceTokenSync() {
  return localStorage.getItem(TOKEN_KEY);
}

// ── Authenticated headers ─────────────────────────────────────────────────────

/**
 * Returns the headers required for authenticated API calls.
 *
 * @returns {Promise<HeadersInit>}
 */
export async function authHeaders() {
  const token = await getDeviceToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}

// ── Sign out ──────────────────────────────────────────────────────────────────

/**
 * Clear the stored device token.
 * The next API call will auto-register a fresh token.
 *
 * @returns {void}
 */
export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  if (window.__APP_CONFIG__) {
    delete window.__APP_CONFIG__._deviceToken;
  }
  console.debug('[auth] device token cleared');
}
