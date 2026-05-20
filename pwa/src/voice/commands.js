/**
 * src/voice/commands.js
 *
 * Voice command text → VoiceCommand parser.
 * Single source of truth for all alias normalization and command parsing.
 * Ported from app.js (lines 2487-2600).
 *
 * Exports:
 *   parseVoiceCommand(transcript: string): VoiceCommand | null
 *   normalizeTranscript(raw: string): string
 *   extractExtraRuns(normalizedText: string): number
 *
 * VoiceCommand shape:
 *   { action: 'runs',              runs: number }
 *   { action: 'extra',             type: string, additionalRuns: number }
 *   { action: 'wicket',            type: string }
 *   { action: 'undo' }
 *   { action: 'swap' }
 *   { action: 'scorecard' }
 *   { action: 'change_bowler' }
 *   { action: 'change_striker' }
 *   { action: 'change_non_striker' }
 */

// ── Word-to-number map ─────────────────────────────────────────────────────
const wordToNumber = {
    zero: 0, oh: 0, dot: 0, 'no run': 0, 'no runs': 0, 'dot ball': 0, nought: 0, nothing: 0,
    one: 1, single: 1, 'a run': 1, 'one run': 1,
    two: 2, double: 2, couple: 2, 'two runs': 2,
    three: 3, triple: 3, 'three runs': 3,
    four: 4, boundary: 4, 'four runs': 4,
    five: 5, 'five runs': 5,
    six: 6, sixer: 6, maximum: 6, 'six runs': 6, 'over the fence': 6, 'out of the park': 6,
};

// ── Alias normalization (spoken → canonical cricket term) ──────────────────
/**
 * normalizeTranscript(raw: string): string
 *
 * Fixes common speech-to-text mishearings of cricket vocabulary.
 * Input is raw transcript text (any case). Output is lower-case normalized text.
 */
export function normalizeTranscript(raw) {
    return raw.toLowerCase()
        // Wicket / dismissal mishearings
        .replace(/\bwicked\b/g,      'wicket')
        .replace(/\bcourt\b/g,       'caught')
        .replace(/\bcot\b/g,         'caught')
        .replace(/\bcut\b/g,         'caught')
        .replace(/\bcaught it\b/g,   'caught')
        .replace(/\bbold\b/g,        'bowled')
        .replace(/\bbolt\b/g,        'bowled')
        .replace(/\bbow?led?\b/g,    'bowled')
        .replace(/\bstomped\b/g,     'stumped')
        .replace(/\bstumps\b/g,      'stumped')
        .replace(/\brun now\b/g,     'run out')
        .replace(/\bran out\b/g,     'run out')
        // Extras mishearings
        .replace(/\bwild\b/g,        'wide')
        .replace(/\bwhy\b/g,         'wide')
        .replace(/\bnoble\b/g,       'no ball')
        .replace(/\bno bull\b/g,     'no ball')
        .replace(/\bleg buy\b/g,     'leg bye')
        // Runs — standalone homophones only
        .replace(/\bwon\b/g,         'one')
        .replace(/\btoo\b/g,         'two')
        .replace(/\btree\b/g,        'three')
        .replace(/\bfor\b/g,         'four')
        .replace(/\bsex\b/g,         'six')
        .replace(/\bsick\b/g,        'six')
        // Misc
        .replace(/\band do\b/g,      'undo')
        .replace(/\bswat\b/g,        'swap');
}

// ── Extra-run count extractor ───────────────────────────────────────────────
/**
 * extractExtraRuns(normalizedText: string): number
 *
 * Scans a normalized transcript for a run count associated with an extra delivery.
 * Returns 0 if none found (e.g. plain "wide" → 0 additional runs).
 */
export function extractExtraRuns(t) {
    for (const [word, num] of Object.entries(wordToNumber)) {
        if (word !== 'dot' && word !== 'dot ball' && t.includes(word)) return num;
    }
    const m = t.match(/\b([0-4])\b/);
    return m ? parseInt(m[1], 10) : 0;
}

// ── Main command parser ────────────────────────────────────────────────────
/**
 * parseVoiceCommand(transcript: string): VoiceCommand | null
 *
 * Accepts raw transcript text, normalizes it, then pattern-matches against
 * all supported cricket scoring commands.
 *
 * Returns a VoiceCommand object or null if no command is recognized.
 */
export function parseVoiceCommand(transcript) {
    if (!transcript) return null;

    const t = normalizeTranscript(transcript)
        .replace(/[.,!?;:'"]+/g, '')    // strip punctuation
        .replace(/\s+/g, ' ')            // normalize whitespace
        .trim();

    // ── Personnel changes ────────────────────────────────────────────────
    if (/\b(change|switch|new)\s*(the\s+|to\s+|a\s+)?bowler\b/.test(t)) {
        return { action: 'change_bowler' };
    }
    if (/\b(change|switch|new|replace)\s*(the\s+|to\s+|a\s+)?(striker|batsman|batter|batman)\b/.test(t)) {
        return { action: 'change_striker' };
    }
    if (/\b(change|switch|new|replace)\s*(the\s+|to\s+|a\s+)?non[- ]?striker\b/.test(t)) {
        return { action: 'change_non_striker' };
    }

    // ── Scorecard ────────────────────────────────────────────────────────
    if (/\b(scorecard|score\s*card|score\s*board|scoreboard|show\s*score|view\s*score)\b/.test(t)) {
        return { action: 'scorecard' };
    }

    // ── Wicket / dismissal ───────────────────────────────────────────────
    if (/\b(wicket|out|bowled|dismiss(ed)?|gone|got\s*him)\b/.test(t)) {
        if (/\bcaught\b/.test(t) || /\bcatch\b/.test(t))   return { action: 'wicket', type: 'caught' };
        if (/\blbw\b/.test(t)    || /\bleg\s*before\b/.test(t)) return { action: 'wicket', type: 'lbw' };
        if (/\brun\s*out\b/.test(t))                         return { action: 'wicket', type: 'runout' };
        if (/\bstump(ed|ing)?\b/.test(t))                   return { action: 'wicket', type: 'stumped' };
        if (/\bhit\s*wicket\b/.test(t))                     return { action: 'wicket', type: 'hitwicket' };
        if (/\bretire[d]?\b/.test(t))                       return { action: 'wicket', type: 'retired' };
        if (/\bbowled\b/.test(t) || /\bclean\s*bowled\b/.test(t)) return { action: 'wicket', type: 'bowled' };
        return { action: 'wicket', type: 'bowled' };
    }

    // ── Extras ──────────────────────────────────────────────────────────
    if (/\bwide\b/.test(t)) {
        return { action: 'extra', type: 'wide', additionalRuns: extractExtraRuns(t) };
    }
    if (/\bno\s*ball\b/.test(t) || /\bfree\s*hit\b/.test(t)) {
        return { action: 'extra', type: 'noball', additionalRuns: extractExtraRuns(t) };
    }
    if (/\bleg\s*bye\b/.test(t) || /\bleg\s*by\b/.test(t)) {
        return { action: 'extra', type: 'legbye', additionalRuns: extractExtraRuns(t) };
    }
    if (/\bbye\b/.test(t) && !/\bgood\s*bye\b/.test(t) && !/\bbye\s*bye\b/.test(t)) {
        return { action: 'extra', type: 'bye', additionalRuns: extractExtraRuns(t) };
    }

    // ── Undo ────────────────────────────────────────────────────────────
    if (/\bundo\b/.test(t) || /\bgo\s*back\b/.test(t) || /\brevert\b/.test(t) || /\bcancel\s*last\b/.test(t)) {
        return { action: 'undo' };
    }

    // ── Swap strike ─────────────────────────────────────────────────────
    if (/\bswap\b/.test(t) ||
        /\bswitch\s*(the\s+)?(ends|strike|batsmen|batsman|strikers)\b/.test(t) ||
        /\brotate\s*strike\b/.test(t)) {
        return { action: 'swap' };
    }

    // ── Runs — word names first ──────────────────────────────────────────
    for (const [word, num] of Object.entries(wordToNumber)) {
        if (t === word || new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`).test(t)) {
            return { action: 'runs', runs: num };
        }
    }

    // ── Runs — digit ────────────────────────────────────────────────────
    const digitMatch = t.match(/\b([0-6])\b/);
    if (digitMatch) return { action: 'runs', runs: parseInt(digitMatch[1], 10) };

    return null;
}
