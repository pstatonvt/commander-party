'use strict';

// Cleans the organizer state a host saves, so StateJson only ever holds a
// known, bounded shape. It mirrors normalizeState() in index.html: unknown
// keys and malformed entries are dropped, numbers are clamped, and anything
// over a hard limit is rejected so the host sees why.

const limits = require('./limits');
const { cleanText } = require('./validate');

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function cleanId(value) {
    if (value === null || value === undefined) return null;
    const id = String(value).trim();
    return id && id.length <= limits.STATE_ID_MAX ? id : null;
}

function fail(message) {
    return { ok: false, message };
}

function cleanRound(round) {
    const out = {};
    if (!isPlainObject(round)) return { ok: true, value: out };
    const entries = Object.entries(round);
    if (entries.length > limits.MAX_ROUND_ENTRIES) return fail('A round has too many seats.');
    for (const [playerId, seat] of entries) {
        const id = cleanId(playerId);
        const tableId = isPlainObject(seat) ? cleanId(seat.tableId) : null;
        if (!id || !tableId) continue;
        if (!Number.isInteger(seat.seatIndex) || seat.seatIndex < 0 || seat.seatIndex > 5) continue;
        out[id] = { tableId, seatIndex: seat.seatIndex };
    }
    return { ok: true, value: out };
}

function cleanResult(result) {
    const out = {};
    if (!isPlainObject(result)) return { ok: true, value: out };
    const entries = Object.entries(result);
    if (entries.length > limits.MAX_ROUND_ENTRIES) return fail('A round has too many results.');
    for (const [playerId, value] of entries) {
        const id = cleanId(playerId);
        const life = parseInt(value, 10);
        if (!id || !Number.isFinite(life)) continue;
        out[id] = Math.min(999, Math.max(0, life));
    }
    return { ok: true, value: out };
}

// Returns { ok: true, value } with a clean state, or { ok: false, message }.
function sanitizeState(raw) {
    if (!isPlainObject(raw)) return fail('state must be a JSON object.');

    const ev = isPlainObject(raw.event) ? raw.event : {};
    const event = {
        roundCount: clampInt(ev.roundCount, 1, limits.MAX_ROUNDS, 2),
        roundMinutes: clampInt(ev.roundMinutes, 5, 240, 60),
        tournament: ev.tournament === true
    };

    const rawTables = Array.isArray(raw.tables) ? raw.tables : [];
    if (rawTables.length > limits.MAX_TABLES) return fail(`At most ${limits.MAX_TABLES} tables.`);
    const tables = [];
    const seenTables = new Set();
    for (const t of rawTables) {
        const id = isPlainObject(t) ? cleanId(t.id) : null;
        if (!id || seenTables.has(id)) continue;
        seenTables.add(id);
        const name = typeof t.name === 'string' ? cleanText(t.name, limits.TABLE_NAME_MAX) : null;
        tables.push({ id, name: name || 'Pod', capacity: clampInt(t.capacity, 3, 6, 4) });
    }

    const rawRounds = Array.isArray(raw.rounds) ? raw.rounds : [];
    const rawResults = Array.isArray(raw.results) ? raw.results : [];
    if (rawRounds.length > limits.MAX_ROUNDS || rawResults.length > limits.MAX_ROUNDS) {
        return fail(`At most ${limits.MAX_ROUNDS} rounds.`);
    }

    const rounds = [];
    const results = [];
    for (let i = 0; i < event.roundCount; i++) {
        const round = cleanRound(rawRounds[i]);
        if (!round.ok) return round;
        rounds.push(round.value);
        const result = cleanResult(rawResults[i]);
        if (!result.ok) return result;
        results.push(result.value);
    }

    return {
        ok: true,
        value: {
            event,
            tables,
            rounds,
            results,
            currentRound: clampInt(raw.currentRound, 0, event.roundCount - 1, 0)
        }
    };
}

// Rewrites player ids in rounds and results using idMap (old id -> new id).
// Entries for players not in the map are dropped.
function remapStateIds(state, idMap) {
    const remap = obj => {
        const out = {};
        for (const [oldId, value] of Object.entries(obj)) {
            const newId = idMap.get(oldId);
            if (newId) out[newId] = value;
        }
        return out;
    };
    return { ...state, rounds: state.rounds.map(remap), results: state.results.map(remap) };
}

// Serializes a clean state, or returns null when it is over the size cap.
function serializeState(state) {
    const text = JSON.stringify(state);
    return text.length <= limits.MAX_STATE_CHARS ? text : null;
}

module.exports = { sanitizeState, remapStateIds, serializeState };
