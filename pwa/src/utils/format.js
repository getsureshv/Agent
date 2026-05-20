/**
 * src/utils/format.js
 * Shared formatting utilities.
 */

/**
 * formatOvers(balls)
 * Convert total balls bowled to "overs.balls" display string.
 * e.g. 13 balls → "2.1", 18 balls → "3.0"
 *
 * @param {number} balls
 * @returns {string}
 */
export function formatOvers(balls) {
  const overs = Math.floor(balls / 6);
  const rem   = balls % 6;
  return `${overs}.${rem}`;
}

/**
 * formatDate(iso)
 * Format an ISO-8601 date string to a human-readable short date.
 * e.g. "2024-05-20T12:34:56.000Z" → "20 May 2024"
 *
 * @param {string} iso
 * @returns {string}
 */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day:   'numeric',
    month: 'short',
    year:  'numeric',
  });
}
