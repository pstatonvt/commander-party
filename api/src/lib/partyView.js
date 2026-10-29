'use strict';

// Builds what anyone holding a party link may see. The host's full saved state
// (StateJson) stays private: guests get the party name, the roster, the pods,
// and the seating for the round the host is showing. Never edit tokens, host
// ids, past rounds, or results.

const MAX_TABLES = 50;

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function lowerId(value) {
    return value == null ? null : String(value).toLowerCase();
}

function toIso(value) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseState(stateJson) {
    try {
        const parsed = JSON.parse(stateJson);
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function publicPlayer(row) {
    return {
        id: lowerId(row.Id),
        name: row.Name,
        experience: row.Experience,
        dish: row.Dish,
        partnerId: lowerId(row.PartnerId)
    };
}

function buildPublicView(partyRow, playerRows) {
    const state = parseState(partyRow.StateJson);
    const players = playerRows.map(publicPlayer);
    const playerIds = new Set(players.map(p => p.id));

    const ev = isPlainObject(state.event) ? state.event : {};
    const event = {
        roundCount: clampInt(ev.roundCount, 1, 10, 1),
        roundMinutes: clampInt(ev.roundMinutes, 5, 240, 60),
        tournament: ev.tournament === true
    };
    const currentRound = clampInt(state.currentRound, 0, event.roundCount - 1, 0);

    const tables = (Array.isArray(state.tables) ? state.tables : [])
        .filter(t => isPlainObject(t) && t.id != null)
        .slice(0, MAX_TABLES)
        .map(t => ({
            id: String(t.id).slice(0, 64),
            name: String(t.name ?? 'Pod').slice(0, 80),
            capacity: clampInt(t.capacity, 3, 6, 4)
        }));
    const tableIds = new Set(tables.map(t => t.id));

    const round = Array.isArray(state.rounds) && isPlainObject(state.rounds[currentRound])
        ? state.rounds[currentRound]
        : {};
    const seating = Object.entries(round)
        .filter(([playerId, seat]) =>
            playerIds.has(lowerId(playerId)) &&
            isPlainObject(seat) &&
            tableIds.has(String(seat.tableId)) &&
            Number.isInteger(seat.seatIndex) && seat.seatIndex >= 0 && seat.seatIndex < 6)
        .map(([playerId, seat]) => ({
            playerId: lowerId(playerId),
            tableId: String(seat.tableId),
            seatIndex: seat.seatIndex
        }));

    return {
        id: lowerId(partyRow.Id),
        name: partyRow.Name,
        expiresAt: toIso(partyRow.ExpiresAt),
        event,
        currentRound,
        tables,
        seating,
        players
    };
}

module.exports = { buildPublicView, publicPlayer, toIso };
