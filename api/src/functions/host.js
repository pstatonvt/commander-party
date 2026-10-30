'use strict';

// Host endpoints under /api/host/*. requireHost() only lets through requests
// carrying a valid host session cookie (see lib/auth.js), and every query is
// scoped to the host's user id.
//
// Party state (tables, rounds, results, settings) is saved as one JSON blob.
// Players are separate rows that guests can add to at any time, so the host
// changes them one at a time through the player routes. A whole-roster save
// could silently delete a guest who joined a moment earlier.

const crypto = require('node:crypto');
const { app } = require('@azure/functions');
const { sql, getPool, withDb } = require('../lib/db');
const { json, errorResponse, readJsonBody } = require('../lib/http');
const { requireHost } = require('../lib/auth');
const { normalizeGuid, cleanText, validatePlayerInput } = require('../lib/validate');
const { sanitizeState, remapStateIds, serializeState } = require('../lib/hostState');
const { toIso } = require('../lib/partyView');
const limits = require('../lib/limits');

// ---------- helpers ----------

function withHost(handler) {
    return withDb(async (request, context) => {
        const auth = requireHost(request);
        if (!auth.ok) return auth.response;
        return handler(request, context, auth.principal);
    });
}

const notFound = () => errorResponse(404, 'not_found', 'No party of yours matches this id.');
const playerNotFound = () => errorResponse(404, 'not_found', 'No such player at this party.');
const expired = expiresAt => json(410, {
    error: { code: 'expired', message: 'This party has expired and can no longer be changed.' },
    expiresAt: toIso(expiresAt)
});
const duplicateName = () => errorResponse(409, 'duplicate_name', 'Someone at this party already has that name.');
const partyFull = () => errorResponse(409, 'party_full', `A party can have at most ${limits.MAX_PLAYERS_PER_PARTY} players.`);

function lower(value) {
    return value == null ? null : String(value).toLowerCase();
}

function hostPlayer(row) {
    return {
        id: lower(row.Id),
        name: row.Name,
        experience: row.Experience,
        dish: row.Dish,
        partnerId: lower(row.PartnerId),
        addedByHost: row.AddedByHost === true || row.AddedByHost === 1
    };
}

function parseStateJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function hostView(partyRow, playerRows) {
    return {
        id: lower(partyRow.Id),
        name: partyRow.Name,
        createdAt: toIso(partyRow.CreatedAt),
        updatedAt: toIso(partyRow.UpdatedAt),
        expiresAt: toIso(partyRow.ExpiresAt),
        isExpired: partyRow.IsExpired === 1 || partyRow.IsExpired === true,
        state: parseStateJson(partyRow.StateJson),
        players: playerRows.map(hostPlayer)
    };
}

function rejectUnknownKeys(body, allowed) {
    const unknown = Object.keys(body).filter(key => !allowed.includes(key));
    return unknown.length ? errorResponse(400, 'invalid_body', `Unknown field: ${unknown[0].slice(0, 40)}.`) : null;
}

// Party name: optional on save, defaults on create. Returns undefined when
// absent, null when invalid, or the cleaned name.
function readPartyName(body) {
    if (body.name === undefined) return undefined;
    const name = cleanText(body.name, limits.PARTY_NAME_MAX);
    return name === null ? null : name;
}

function cleanStateOrError(rawState) {
    const state = sanitizeState(rawState);
    if (!state.ok) return { error: errorResponse(400, 'invalid_state', state.message) };
    return { state: state.value };
}

// Shared SELECTs. The roster is scoped by @outcome so mutations only return it on success.
const SELECT_HOST_PARTY = `
SELECT Id, Name, StateJson, CreatedAt, UpdatedAt, ExpiresAt,
       CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS IsExpired
FROM dbo.Parties WHERE Id = @partyId AND HostUserId = @hostUserId;

SELECT p.Id, p.Name, p.Experience, p.Dish, p.PartnerId, p.AddedByHost
FROM dbo.Players p
JOIN dbo.Parties y ON y.Id = p.PartyId AND y.HostUserId = @hostUserId
WHERE p.PartyId = @partyId
ORDER BY p.CreatedAt, p.Id;`;

const SELECT_ROSTER_IF_OK = `
SELECT Id, Name, Experience, Dish, PartnerId, AddedByHost
FROM dbo.Players
WHERE PartyId = @partyId AND @outcome = 'ok'
ORDER BY CreatedAt, Id;`;

// Locks the host's party row and sets @expiresAt (NULL when it isn't theirs).
const LOCK_PARTY = `
SELECT @expiresAt = ExpiresAt FROM dbo.Parties WITH (UPDLOCK, HOLDLOCK)
WHERE Id = @partyId AND HostUserId = @hostUserId;`;

// ---------- POST /api/host/parties ----------

// Creates a party from the organizer's current event. Players come with the
// organizer's local ids; the API gives each a new GUID, rewrites the seating
// and results to match, and returns the old-to-new id map.
//
// The page may choose the party's id itself (body.id). That makes creating
// safe to retry: if a slow first attempt timed out at the gateway but still
// finished, the retry finds the same id and gets the existing party back
// instead of a duplicate.
const CREATE_PARTY_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @outcome VARCHAR(20);
DECLARE @existingHost NVARCHAR(128);
DECLARE @playerCount INT = (SELECT COUNT(*) FROM OPENJSON(@playersJson));

BEGIN TRANSACTION;

SELECT @existingHost = HostUserId FROM dbo.Parties WITH (UPDLOCK, HOLDLOCK) WHERE Id = @partyId;

IF @existingHost IS NOT NULL
    SET @outcome = CASE WHEN @existingHost = @hostUserId THEN 'exists' ELSE 'taken' END;
ELSE
BEGIN

IF (SELECT COUNT(*) FROM dbo.Parties WITH (UPDLOCK, HOLDLOCK) WHERE HostUserId = @hostUserId) >= @maxParties
BEGIN
    DELETE FROM dbo.JoinAttempts
    WHERE PartyId IN (SELECT Id FROM dbo.Parties WHERE HostUserId = @hostUserId AND ExpiresAt <= @now);
    DELETE FROM dbo.Parties WHERE HostUserId = @hostUserId AND ExpiresAt <= @now;
END

IF (SELECT COUNT(*) FROM dbo.Parties WHERE HostUserId = @hostUserId) >= @maxParties
    SET @outcome = 'too_many';
ELSE
BEGIN
    INSERT dbo.Parties (Id, HostUserId, Name, StateJson, CreatedAt, UpdatedAt, ExpiresAt)
    VALUES (@partyId, @hostUserId, @name, @stateJson, @now, @now, DATEADD(DAY, @lifetimeDays, @now));

    -- CreatedAt steps back one second per player so the roster keeps the organizer's order.
    INSERT dbo.Players (Id, PartyId, Name, Experience, Dish, PartnerId, AddedByHost, CreatedAt, UpdatedAt)
    SELECT p.id, @partyId, p.name, p.experience, p.dish, p.partnerId, 1,
           DATEADD(SECOND, CAST(a.[key] AS INT) - @playerCount, @now), @now
    FROM OPENJSON(@playersJson) a
    CROSS APPLY OPENJSON(a.value) WITH (
        id         UNIQUEIDENTIFIER '$.id',
        name       NVARCHAR(40)     '$.name',
        experience VARCHAR(10)      '$.experience',
        dish       NVARCHAR(80)     '$.dish',
        partnerId  UNIQUEIDENTIFIER '$.partnerId'
    ) p;

    SET @outcome = 'ok';
END

END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome;
${SELECT_HOST_PARTY}`;

function readImportedPlayers(rawPlayers) {
    if (rawPlayers === undefined) return { players: [], idMap: new Map() };
    if (!Array.isArray(rawPlayers)) return { error: 'players must be an array.' };
    if (rawPlayers.length > limits.MAX_PLAYERS_PER_PARTY) {
        return { error: `A party can have at most ${limits.MAX_PLAYERS_PER_PARTY} players.` };
    }

    const idMap = new Map();
    const cleaned = [];
    for (const [index, raw] of rawPlayers.entries()) {
        const input = validatePlayerInput(raw, ['id', 'partnerId']);
        if (!input.ok) return { error: `Player ${index + 1}: ${input.message}` };
        const localId = raw.id == null ? '' : String(raw.id).trim();
        if (!localId || localId.length > limits.STATE_ID_MAX) return { error: `Player ${index + 1}: id is required.` };
        if (idMap.has(localId)) return { error: `Player ${index + 1}: duplicate id.` };
        idMap.set(localId, crypto.randomUUID());
        cleaned.push({ localId, partnerLocalId: raw.partnerId == null ? null : String(raw.partnerId), ...input.value });
    }

    // Keep a locked pair only when both players point at each other.
    const byLocal = new Map(cleaned.map(p => [p.localId, p]));
    const players = cleaned.map(p => {
        const partner = p.partnerLocalId ? byLocal.get(p.partnerLocalId) : null;
        const mutual = partner && partner.localId !== p.localId && partner.partnerLocalId === p.localId;
        return {
            id: idMap.get(p.localId),
            name: p.name,
            experience: p.experience,
            dish: p.dish,
            partnerId: mutual ? idMap.get(partner.localId) : null
        };
    });
    return { players, idMap };
}

async function createParty(request, context, principal) {
    const body = await readJsonBody(request, limits.MAX_HOST_BODY_BYTES);
    if (!body.ok) return body.response;
    const unknown = rejectUnknownKeys(body.value, ['id', 'name', 'state', 'players']);
    if (unknown) return unknown;

    const partyId = body.value.id === undefined ? crypto.randomUUID() : normalizeGuid(body.value.id);
    if (!partyId) return errorResponse(400, 'invalid_id', 'id must be a GUID.');

    const name = readPartyName(body.value);
    if (name === null) return errorResponse(400, 'invalid_name', `Party name must be text of at most ${limits.PARTY_NAME_MAX} characters.`);

    const cleaned = cleanStateOrError(body.value.state);
    if (cleaned.error) return cleaned.error;

    const imported = readImportedPlayers(body.value.players);
    if (imported.error) return errorResponse(400, 'invalid_player', imported.error);

    const stateJson = serializeState(remapStateIds(cleaned.state, imported.idMap));
    if (!stateJson) return errorResponse(413, 'state_too_large', 'The saved event is too large.');

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .input('name', sql.NVarChar(limits.PARTY_NAME_MAX), name || 'Commander Party')
        .input('stateJson', sql.NVarChar(sql.MAX), stateJson)
        .input('playersJson', sql.NVarChar(sql.MAX), JSON.stringify(imported.players))
        .input('maxParties', sql.Int, limits.MAX_PARTIES_PER_HOST)
        .input('lifetimeDays', sql.Int, limits.PARTY_LIFETIME_DAYS)
        .query(CREATE_PARTY_SQL);

    const outcome = result.recordsets[0][0].Outcome;
    if (outcome === 'too_many') {
        return errorResponse(409, 'too_many_parties',
            `You already have ${limits.MAX_PARTIES_PER_HOST} parties that haven't expired. Delete one first.`);
    }
    if (outcome === 'taken') {
        return errorResponse(409, 'id_taken', 'That party id is already in use. Try again.');
    }
    if (outcome === 'exists') {
        // A retry of a create that already went through: hand back the same party
        return json(200, { party: hostView(result.recordsets[1][0], result.recordsets[2]), idMap: {}, existing: true });
    }
    if (outcome !== 'ok') throw new Error(`Unexpected create outcome: ${outcome}`);

    return json(201, {
        party: hostView(result.recordsets[1][0], result.recordsets[2]),
        idMap: Object.fromEntries(imported.idMap)
    });
}

// ---------- GET /api/host/parties ----------

const LIST_PARTIES_SQL = `
SET NOCOUNT ON;
SELECT y.Id, y.Name, y.CreatedAt, y.UpdatedAt, y.ExpiresAt,
       CASE WHEN y.ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS IsExpired,
       (SELECT COUNT(*) FROM dbo.Players p WHERE p.PartyId = y.Id) AS PlayerCount
FROM dbo.Parties y
WHERE y.HostUserId = @hostUserId
ORDER BY y.CreatedAt DESC;`;

async function listParties(request, context, principal) {
    const pool = await getPool();
    const result = await pool.request()
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .query(LIST_PARTIES_SQL);

    return json(200, {
        parties: result.recordset.map(row => ({
            id: lower(row.Id),
            name: row.Name,
            createdAt: toIso(row.CreatedAt),
            updatedAt: toIso(row.UpdatedAt),
            expiresAt: toIso(row.ExpiresAt),
            isExpired: row.IsExpired === 1 || row.IsExpired === true,
            playerCount: row.PlayerCount
        })),
        limit: limits.MAX_PARTIES_PER_HOST
    });
}

// ---------- GET /api/host/parties/{partyId} ----------

async function getHostParty(request, context, principal) {
    const partyId = normalizeGuid(request.params.partyId);
    if (!partyId) return notFound();

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .query(`SET NOCOUNT ON;${SELECT_HOST_PARTY}`);

    const party = result.recordsets[0][0];
    if (!party) return notFound();
    return json(200, { party: hostView(party, result.recordsets[1]) });
}

// ---------- PUT /api/host/parties/{partyId} ----------

// Autosave. Replaces the party's state and, if given, its name. Players are
// not touched here.
const SAVE_PARTY_SQL = `
SET NOCOUNT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);

SELECT @expiresAt = ExpiresAt FROM dbo.Parties WHERE Id = @partyId AND HostUserId = @hostUserId;

IF @expiresAt IS NULL
    SET @outcome = 'not_found';
ELSE IF @expiresAt <= @now
    SET @outcome = 'expired';
ELSE
BEGIN
    UPDATE dbo.Parties
    SET StateJson = @stateJson, Name = COALESCE(@name, Name), UpdatedAt = @now
    WHERE Id = @partyId AND HostUserId = @hostUserId AND ExpiresAt > @now;
    SET @outcome = CASE WHEN @@ROWCOUNT = 1 THEN 'ok' ELSE 'expired' END;
END

SELECT @outcome AS Outcome, @expiresAt AS ExpiresAt, @now AS UpdatedAt;`;

async function saveParty(request, context, principal) {
    const partyId = normalizeGuid(request.params.partyId);
    if (!partyId) return notFound();

    const body = await readJsonBody(request, limits.MAX_HOST_BODY_BYTES);
    if (!body.ok) return body.response;
    const unknown = rejectUnknownKeys(body.value, ['name', 'state']);
    if (unknown) return unknown;

    const name = readPartyName(body.value);
    if (name === null || name === '') {
        return errorResponse(400, 'invalid_name', `Party name must be 1 to ${limits.PARTY_NAME_MAX} characters.`);
    }

    const cleaned = cleanStateOrError(body.value.state);
    if (cleaned.error) return cleaned.error;
    const stateJson = serializeState(cleaned.state);
    if (!stateJson) return errorResponse(413, 'state_too_large', 'The saved event is too large.');

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .input('name', sql.NVarChar(limits.PARTY_NAME_MAX), name === undefined ? null : name)
        .input('stateJson', sql.NVarChar(sql.MAX), stateJson)
        .query(SAVE_PARTY_SQL);

    const row = result.recordset[0];
    switch (row.Outcome) {
        case 'ok': return json(200, { updatedAt: toIso(row.UpdatedAt), expiresAt: toIso(row.ExpiresAt) });
        case 'not_found': return notFound();
        case 'expired': return expired(row.ExpiresAt);
        default: throw new Error(`Unexpected save outcome: ${row.Outcome}`);
    }
}

// Deleting a party is admin-only: see manage.js.

// ---------- POST /api/host/parties/{partyId}/players ----------

const ADD_PLAYER_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);
DECLARE @inserted TABLE (Id UNIQUEIDENTIFIER);

BEGIN TRANSACTION;
${LOCK_PARTY}

IF @expiresAt IS NULL
    SET @outcome = 'not_found';
ELSE IF @expiresAt <= @now
    SET @outcome = 'expired';
ELSE IF (SELECT COUNT(*) FROM dbo.Players WHERE PartyId = @partyId) >= @maxPlayers
    SET @outcome = 'full';
ELSE IF EXISTS (SELECT 1 FROM dbo.Players WHERE PartyId = @partyId AND Name = @name)
    SET @outcome = 'duplicate_name';
ELSE
BEGIN
    INSERT dbo.Players (PartyId, Name, Experience, Dish, AddedByHost, CreatedAt, UpdatedAt)
    OUTPUT inserted.Id INTO @inserted
    VALUES (@partyId, @name, @experience, @dish, 1, @now, @now);
    SET @outcome = 'ok';
END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome, @expiresAt AS ExpiresAt, (SELECT TOP 1 Id FROM @inserted) AS PlayerId;
${SELECT_ROSTER_IF_OK}`;

async function addPlayer(request, context, principal) {
    const partyId = normalizeGuid(request.params.partyId);
    if (!partyId) return notFound();

    const body = await readJsonBody(request, limits.MAX_GUEST_BODY_BYTES);
    if (!body.ok) return body.response;
    const input = validatePlayerInput(body.value);
    if (!input.ok) return errorResponse(400, 'invalid_player', input.message);
    const { name, experience, dish } = input.value;

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .input('name', sql.NVarChar(limits.PLAYER_NAME_MAX), name)
        .input('experience', sql.VarChar(10), experience)
        .input('dish', sql.NVarChar(limits.PLAYER_DISH_MAX), dish)
        .input('maxPlayers', sql.Int, limits.MAX_PLAYERS_PER_PARTY)
        .query(ADD_PLAYER_SQL);

    const row = result.recordsets[0][0];
    switch (row.Outcome) {
        case 'ok': return json(201, { playerId: lower(row.PlayerId), players: result.recordsets[1].map(hostPlayer) });
        case 'not_found': return notFound();
        case 'expired': return expired(row.ExpiresAt);
        case 'full': return partyFull();
        case 'duplicate_name': return duplicateName();
        default: throw new Error(`Unexpected add outcome: ${row.Outcome}`);
    }
}

// ---------- PUT /api/host/parties/{partyId}/players/{playerId} ----------

// Edits any player. When partnerId is present the lock is rewritten so pairs
// stay mutual: null unlocks, a player id locks the two together and frees
// whoever either of them was paired with before.
const UPDATE_PLAYER_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);

BEGIN TRANSACTION;
${LOCK_PARTY}

IF @expiresAt IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.Players WHERE Id = @playerId AND PartyId = @partyId)
    SET @outcome = 'not_found';
ELSE IF @expiresAt <= @now
    SET @outcome = 'expired';
ELSE IF @setPartner = 1 AND @partnerId IS NOT NULL
     AND (@partnerId = @playerId OR NOT EXISTS (SELECT 1 FROM dbo.Players WHERE Id = @partnerId AND PartyId = @partyId))
    SET @outcome = 'bad_partner';
ELSE IF EXISTS (SELECT 1 FROM dbo.Players WHERE PartyId = @partyId AND Name = @name AND Id <> @playerId)
    SET @outcome = 'duplicate_name';
ELSE
BEGIN
    UPDATE dbo.Players
    SET Name = @name, Experience = @experience, Dish = @dish, UpdatedAt = @now
    WHERE Id = @playerId;

    IF @setPartner = 1
    BEGIN
        UPDATE dbo.Players SET PartnerId = NULL, UpdatedAt = @now
        WHERE PartyId = @partyId
          AND (Id = @playerId OR PartnerId = @playerId OR Id = @partnerId OR PartnerId = @partnerId);

        IF @partnerId IS NOT NULL
            UPDATE dbo.Players
            SET PartnerId = CASE WHEN Id = @playerId THEN @partnerId ELSE @playerId END, UpdatedAt = @now
            WHERE Id IN (@playerId, @partnerId);
    END

    SET @outcome = 'ok';
END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome, @expiresAt AS ExpiresAt;
${SELECT_ROSTER_IF_OK}`;

async function updatePlayer(request, context, principal) {
    const partyId = normalizeGuid(request.params.partyId);
    const playerId = normalizeGuid(request.params.playerId);
    if (!partyId || !playerId) return playerNotFound();

    const body = await readJsonBody(request, limits.MAX_GUEST_BODY_BYTES);
    if (!body.ok) return body.response;
    const input = validatePlayerInput(body.value, ['partnerId']);
    if (!input.ok) return errorResponse(400, 'invalid_player', input.message);
    const { name, experience, dish } = input.value;

    const setPartner = Object.prototype.hasOwnProperty.call(body.value, 'partnerId');
    const partnerId = setPartner && body.value.partnerId !== null ? normalizeGuid(body.value.partnerId) : null;
    if (setPartner && body.value.partnerId !== null && !partnerId) {
        return errorResponse(400, 'invalid_player', 'partnerId must be a player id or null.');
    }

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .input('playerId', sql.UniqueIdentifier, playerId)
        .input('name', sql.NVarChar(limits.PLAYER_NAME_MAX), name)
        .input('experience', sql.VarChar(10), experience)
        .input('dish', sql.NVarChar(limits.PLAYER_DISH_MAX), dish)
        .input('setPartner', sql.Bit, setPartner ? 1 : 0)
        .input('partnerId', sql.UniqueIdentifier, partnerId)
        .query(UPDATE_PLAYER_SQL);

    const row = result.recordsets[0][0];
    switch (row.Outcome) {
        case 'ok': return json(200, { players: result.recordsets[1].map(hostPlayer) });
        case 'not_found': return playerNotFound();
        case 'expired': return expired(row.ExpiresAt);
        case 'bad_partner': return errorResponse(400, 'invalid_partner', 'The partner must be another player at this party.');
        case 'duplicate_name': return duplicateName();
        default: throw new Error(`Unexpected update outcome: ${row.Outcome}`);
    }
}

// ---------- DELETE /api/host/parties/{partyId}/players/{playerId} ----------

const DELETE_PLAYER_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);

BEGIN TRANSACTION;
${LOCK_PARTY}

IF @expiresAt IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.Players WHERE Id = @playerId AND PartyId = @partyId)
    SET @outcome = 'not_found';
ELSE IF @expiresAt <= @now
    SET @outcome = 'expired';
ELSE
BEGIN
    UPDATE dbo.Players SET PartnerId = NULL, UpdatedAt = @now WHERE PartyId = @partyId AND PartnerId = @playerId;
    DELETE FROM dbo.Players WHERE Id = @playerId AND PartyId = @partyId;
    SET @outcome = 'ok';
END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome, @expiresAt AS ExpiresAt;
${SELECT_ROSTER_IF_OK}`;

async function deletePlayer(request, context, principal) {
    const partyId = normalizeGuid(request.params.partyId);
    const playerId = normalizeGuid(request.params.playerId);
    if (!partyId || !playerId) return playerNotFound();

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('hostUserId', sql.NVarChar(128), principal.userId)
        .input('playerId', sql.UniqueIdentifier, playerId)
        .query(DELETE_PLAYER_SQL);

    const row = result.recordsets[0][0];
    switch (row.Outcome) {
        case 'ok': return json(200, { players: result.recordsets[1].map(hostPlayer) });
        case 'not_found': return playerNotFound();
        case 'expired': return expired(row.ExpiresAt);
        default: throw new Error(`Unexpected delete outcome: ${row.Outcome}`);
    }
}

// ---------- Registration ----------

const routes = [
    ['hostCreateParty', 'POST', 'host/parties', createParty],
    ['hostListParties', 'GET', 'host/parties', listParties],
    ['hostGetParty', 'GET', 'host/parties/{partyId}', getHostParty],
    ['hostSaveParty', 'PUT', 'host/parties/{partyId}', saveParty],
    ['hostAddPlayer', 'POST', 'host/parties/{partyId}/players', addPlayer],
    ['hostUpdatePlayer', 'PUT', 'host/parties/{partyId}/players/{playerId}', updatePlayer],
    ['hostDeletePlayer', 'DELETE', 'host/parties/{partyId}/players/{playerId}', deletePlayer]
];

for (const [name, method, route, handler] of routes) {
    app.http(name, { methods: [method], authLevel: 'anonymous', route, handler: withHost(handler) });
}

module.exports = {
    createParty, listParties, getHostParty, saveParty, addPlayer, updatePlayer, deletePlayer,
    withHost, readImportedPlayers,
    CREATE_PARTY_SQL, LIST_PARTIES_SQL, SELECT_HOST_PARTY, SAVE_PARTY_SQL,
    ADD_PLAYER_SQL, UPDATE_PLAYER_SQL, DELETE_PLAYER_SQL
};
