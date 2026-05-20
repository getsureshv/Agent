/**
 * config.example.js — Runtime configuration template
 *
 * SETUP:
 *   1. Copy this file to config.js in the repo root.
 *   2. Set BASE_URL to the URL of your Agent base server
 *      (e.g. https://cricket-scorer-asmc.onrender.com for production,
 *       or http://localhost:8080 for local dev).
 *   3. config.js is .gitignored — never commit real values.
 *   4. Add <script src="config.js"></script> to index.html BEFORE
 *      any src/sync/ module scripts.
 *
 * All sync modules read window.__APP_CONFIG__.BASE_URL.
 * On first load, src/sync/auth.js will auto-register this device and
 * persist the device token in localStorage — no manual steps required.
 */
window.__APP_CONFIG__ = {
  /** Base URL of the Agent server (no trailing slash) */
  BASE_URL: 'https://cricket-scorer-asmc.onrender.com',
};
