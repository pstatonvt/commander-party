'use strict';

const { PLAYER_NAME_MAX, PLAYER_DISH_MAX, EXPERIENCE_LEVELS } = require('./limits');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Control characters, zero-width characters and bidi overrides. These are
// stripped so names can't be invisible or render text backwards.
const UNSAFE_CHARS_RE = new RegExp(
    '[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]', 'g');

function isGuid(value) {
    return typeof value === 'string' && GUID_RE.test(value);
}

function normalizeGuid(value) {
    return isGuid(value) ? value.toLowerCase() : null;
}

// Returns the cleaned string, '' for a missing value, or null when the value
// is the wrong type or too long after cleaning. Over-long text is rejected,
// not silently cut, so the guest sees why.
function cleanText(value, max) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    const cleaned = value
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .replace(UNSAFE_CHARS_RE, '')
        .trim();
    return cleaned.length > max ? null : cleaned;
}

function fail(message) {
    return { ok: false, message };
}

// Validates the body a guest sends to join or to edit their own entry.
// `extraKeys` lists any additional fields the route accepts (e.g. editToken).
function validatePlayerInput(body, extraKeys = []) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return fail('Request body must be a JSON object.');
    }

    const allowed = new Set(['name', 'experience', 'dish', ...extraKeys]);
    const unknown = Object.keys(body).filter(key => !allowed.has(key));
    if (unknown.length) return fail(`Unknown field: ${unknown[0].slice(0, 40)}.`);

    const name = cleanText(body.name, PLAYER_NAME_MAX);
    if (name === null) return fail(`Name must be text of at most ${PLAYER_NAME_MAX} characters.`);
    if (!name) return fail('Name is required.');

    if (!EXPERIENCE_LEVELS.includes(body.experience)) {
        return fail(`Experience must be one of: ${EXPERIENCE_LEVELS.join(', ')}.`);
    }

    const dish = cleanText(body.dish, PLAYER_DISH_MAX);
    if (dish === null) return fail(`Dish must be text of at most ${PLAYER_DISH_MAX} characters.`);

    return { ok: true, value: { name, experience: body.experience, dish } };
}

module.exports = { isGuid, normalizeGuid, cleanText, validatePlayerInput };
