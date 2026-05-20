/**
 * src/utils/uuid.js
 * crypto.randomUUID() wrapper.
 * All primary keys in the app use client-generated UUIDv4.
 */

/**
 * newUUID()
 * Generate a new UUIDv4 string using the Web Crypto API.
 * @returns {string}
 */
export function newUUID() {
  return crypto.randomUUID();
}
