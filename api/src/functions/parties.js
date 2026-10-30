'use strict';

// Guest endpoints. Anyone holding a party link can call these, so every input
// is validated and every write is capped. Host-only routes live under
// /api/host/* and are gated by the `host` role in staticwebapp.config.json.

const { app } = require('@azure/functions');
const { sql, getPool, withDb } = require('../lib/db');
const { json, errorResponse, readJsonBody, clientIp, hashIp } = require('../lib/http');
const { normalizeGuid, validatePlayerInput } = require('../lib/validate');
const { buildPublicView, toIso } = require('../lib/partyView');
const limits = require('../lib/limits');

const notFound = () => errorResponse(404, 'not_found', 'No party matches this link.');
const expired = expiresAt => json(410, {
    error: { code: 'expired', message: 'This party link has expired.' },
    expiresAt: toIso(expiresAt)
});

// ---------- GET /api/parties/{partyId} ----------

const GET_PARTY_SQL = `
SET NOCOUNT ON;
SELECT Id, Name, StateJson, ExpiresAt,
       CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS IsExpired
FROM dbo.Parties WHERE Id = @partyId;

SELECT p.Id, p.Name, p.Experience, p.Dish, p.PartnerId
FROM dbo.Players p
JOIN dbo.Parties y ON y.Id = p.PartyId AND y.ExpiresAt > SYSUTCDATETIME()
WHERE p.PartyId = @partyId
ORDER BY p.CreatedAt, p.Id;`;

async function getParty(request, context) {
    const partyId = normalizeGuid(request.params.partyId);
    if (!partyId) return notFound();

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .query(GET_PARTY_SQL);

    const party = result.recordsets[0][0];
    if (!party) return notFound();
    if (party.IsExpired) return expired(party.ExpiresAt);

    return json(200, buildPublicView(party, result.recordsets[1]));
}

// ---------- POST /api/parties/{partyId}/players ----------

// One batch, one transaction. The party row is locked so concurrent joins
// can't slip past the player cap or the duplicate-name check. Attempts are
// only recorded while under the limit, so a spammer can't grow the table.
const JOIN_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);
DECLARE @inserted TABLE (Id UNIQUEIDENTIFIER, EditToken UNIQUEIDENTIFIER);

BEGIN TRANSACTION;

SELECT @expiresAt = ExpiresAt FROM dbo.Parties WITH (UPDLOCK, HOLDLOCK) WHERE Id = @partyId;

IF @expiresAt IS NULL
    SET @outcome = 'not_found';
ELSE IF @expiresAt <= @now
    SET @outcome = 'expired';
ELSE
BEGIN
    DELETE FROM dbo.JoinAttempts WHERE PartyId = @partyId AND AttemptedAt < DATEADD(HOUR, -1, @now);

    IF (SELECT COUNT(*) FROM dbo.JoinAttempts
        WHERE PartyId = @partyId AND IpHash = @ipHash
          AND AttemptedAt >= DATEADD(MINUTE, -@windowMinutes, @now)) >= @maxAttempts
        SET @outcome = 'rate_limited';
    ELSE
    BEGIN
        INSERT dbo.JoinAttempts (PartyId, IpHash, AttemptedAt) VALUES (@partyId, @ipHash, @now);

        IF (SELECT COUNT(*) FROM dbo.Players WHERE PartyId = @partyId) >= @maxPlayers
            SET @outcome = 'full';
        ELSE IF EXISTS (SELECT 1 FROM dbo.Players WHERE PartyId = @partyId AND Name = @name)
            SET @outcome = 'duplicate_name';
        ELSE
        BEGIN
            INSERT dbo.Players (PartyId, Name, Experience, Dish)
            OUTPUT inserted.Id, inserted.EditToken INTO @inserted
            VALUES (@partyId, @name, @experience, @dish);

            UPDATE dbo.Parties SET JoinCount = JoinCount + 1 WHERE Id = @partyId;
            SET @outcome = 'ok';
        END
    END
END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome, @expiresAt AS ExpiresAt,
       (SELECT TOP 1 Id FROM @inserted) AS PlayerId,
       (SELECT TOP 1 EditToken FROM @inserted) AS EditToken;`;

async function joinParty(request, context) {
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
        .input('ipHash', sql.Char(64), hashIp(clientIp(request)))
        .input('name', sql.NVarChar(limits.PLAYER_NAME_MAX), name)
        .input('experience', sql.VarChar(10), experience)
        .input('dish', sql.NVarChar(limits.PLAYER_DISH_MAX), dish)
        .input('maxPlayers', sql.Int, limits.MAX_PLAYERS_PER_PARTY)
        .input('maxAttempts', sql.Int, limits.JOIN_ATTEMPTS_PER_WINDOW)
        .input('windowMinutes', sql.Int, limits.JOIN_WINDOW_MINUTES)
        .query(JOIN_SQL);

    const row = result.recordset[0];
    switch (row.Outcome) {
        case 'ok':
            return json(201, {
                player: { id: row.PlayerId.toLowerCase(), name, experience, dish, partnerId: null },
                editToken: row.EditToken.toLowerCase(),
                expiresAt: toIso(row.ExpiresAt)
            });
        case 'not_found':
            return notFound();
        case 'expired':
            return expired(row.ExpiresAt);
        case 'rate_limited':
            return errorResponse(429, 'rate_limited', 'Too many join attempts. Try again in a few minutes.',
                { 'Retry-After': String(limits.JOIN_WINDOW_MINUTES * 60) });
        case 'full':
            return errorResponse(409, 'party_full', `This party already has ${limits.MAX_PLAYERS_PER_PARTY} players.`);
        case 'duplicate_name':
            return errorResponse(409, 'duplicate_name', 'Someone at this party already has that name. Try adding an initial.');
        default:
            throw new Error(`Unexpected join outcome: ${row.Outcome}`);
    }
}

// ---------- PUT /api/parties/{partyId}/players/{playerId} ----------

// A guest edits only the row whose edit token they hold. A wrong token, a
// wrong player, or an expired party all look the same: 404.
const UPDATE_PLAYER_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);

BEGIN TRANSACTION;

SELECT @expiresAt = ExpiresAt FROM dbo.Parties WITH (UPDLOCK, HOLDLOCK) WHERE Id = @partyId;

IF @expiresAt IS NULL OR @expiresAt <= @now
   OR NOT EXISTS (SELECT 1 FROM dbo.Players
                  WHERE Id = @playerId AND PartyId = @partyId AND EditToken = @editToken)
    SET @outcome = 'not_found';
ELSE IF EXISTS (SELECT 1 FROM dbo.Players WHERE PartyId = @partyId AND Name = @name AND Id <> @playerId)
    SET @outcome = 'duplicate_name';
ELSE
BEGIN
    UPDATE dbo.Players
    SET Name = @name, Experience = @experience, Dish = @dish, UpdatedAt = @now
    WHERE Id = @playerId;
    SET @outcome = 'ok';
END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome,
       (SELECT PartnerId FROM dbo.Players WHERE Id = @playerId AND @outcome = 'ok') AS PartnerId;`;

async function updateMyPlayer(request, context) {
    const partyId = normalizeGuid(request.params.partyId);
    const playerId = normalizeGuid(request.params.playerId);
    if (!partyId || !playerId) return notFound();

    const body = await readJsonBody(request, limits.MAX_GUEST_BODY_BYTES);
    if (!body.ok) return body.response;

    const editToken = normalizeGuid(body.value.editToken);
    if (!editToken) return errorResponse(400, 'invalid_player', 'editToken is required.');

    const input = validatePlayerInput(body.value, ['editToken']);
    if (!input.ok) return errorResponse(400, 'invalid_player', input.message);
    const { name, experience, dish } = input.value;

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('playerId', sql.UniqueIdentifier, playerId)
        .input('editToken', sql.UniqueIdentifier, editToken)
        .input('name', sql.NVarChar(limits.PLAYER_NAME_MAX), name)
        .input('experience', sql.VarChar(10), experience)
        .input('dish', sql.NVarChar(limits.PLAYER_DISH_MAX), dish)
        .query(UPDATE_PLAYER_SQL);

    const row = result.recordset[0];
    switch (row.Outcome) {
        case 'ok':
            return json(200, {
                player: {
                    id: playerId, name, experience, dish,
                    partnerId: row.PartnerId ? row.PartnerId.toLowerCase() : null
                }
            });
        case 'not_found':
            return errorResponse(404, 'not_found', 'No matching player for this link.');
        case 'duplicate_name':
            return errorResponse(409, 'duplicate_name', 'Someone at this party already has that name. Try adding an initial.');
        default:
            throw new Error(`Unexpected update outcome: ${row.Outcome}`);
    }
}

// ---------- DELETE /api/parties/{partyId}/players/{playerId} ----------

// A guest takes themselves off the list ("I can't make it"). Like editing, it
// needs the guest's own edit token, and a wrong token, a wrong player, or an
// expired party all look the same: 404. A locked partner is freed.
const LEAVE_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @expiresAt DATETIME2(0);
DECLARE @outcome VARCHAR(20);

BEGIN TRANSACTION;

SELECT @expiresAt = ExpiresAt FROM dbo.Parties WITH (UPDLOCK, HOLDLOCK) WHERE Id = @partyId;

IF @expiresAt IS NULL OR @expiresAt <= @now
   OR NOT EXISTS (SELECT 1 FROM dbo.Players
                  WHERE Id = @playerId AND PartyId = @partyId AND EditToken = @editToken)
    SET @outcome = 'not_found';
ELSE
BEGIN
    UPDATE dbo.Players SET PartnerId = NULL, UpdatedAt = @now WHERE PartyId = @partyId AND PartnerId = @playerId;
    DELETE FROM dbo.Players WHERE Id = @playerId AND PartyId = @partyId;
    SET @outcome = 'ok';
END

COMMIT TRANSACTION;

SELECT @outcome AS Outcome;`;

async function leaveParty(request, context) {
    const partyId = normalizeGuid(request.params.partyId);
    const playerId = normalizeGuid(request.params.playerId);
    if (!partyId || !playerId) return notFound();

    const body = await readJsonBody(request, limits.MAX_GUEST_BODY_BYTES);
    if (!body.ok) return body.response;
    const unknown = Object.keys(body.value).filter(key => key !== 'editToken');
    if (unknown.length) return errorResponse(400, 'invalid_body', `Unknown field: ${unknown[0].slice(0, 40)}.`);
    const editToken = normalizeGuid(body.value.editToken);
    if (!editToken) return errorResponse(400, 'invalid_player', 'editToken is required.');

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .input('playerId', sql.UniqueIdentifier, playerId)
        .input('editToken', sql.UniqueIdentifier, editToken)
        .query(LEAVE_SQL);

    return result.recordset[0].Outcome === 'ok'
        ? { status: 204, headers: { 'Cache-Control': 'no-store' } }
        : errorResponse(404, 'not_found', 'No matching player for this link.');
}

// ---------- Registration ----------

app.http('getParty', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'parties/{partyId}',
    handler: withDb(getParty)
});

app.http('joinParty', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'parties/{partyId}/players',
    handler: withDb(joinParty)
});

app.http('updateMyPlayer', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'parties/{partyId}/players/{playerId}',
    handler: withDb(updateMyPlayer)
});

app.http('leaveParty', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'parties/{partyId}/players/{playerId}',
    handler: withDb(leaveParty)
});

module.exports = { getParty, joinParty, updateMyPlayer, leaveParty, GET_PARTY_SQL, JOIN_SQL, UPDATE_PLAYER_SQL, LEAVE_SQL };
