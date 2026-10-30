'use strict';

// Admin endpoints under /api/manage/*, for the GitHub account invited in the
// Static Web App. staticwebapp.config.json only lets the admin roles reach
// these routes, and requireAdmin() checks again. Admins see every party,
// whoever made it, and are the only ones who can delete a party.
//
//   GET    /api/manage/parties             every party, newest first
//   DELETE /api/manage/parties/{partyId}   delete a party and its guest list

const { app } = require('@azure/functions');
const { sql, getPool, withDb } = require('../lib/db');
const { json, errorResponse } = require('../lib/http');
const { requireAdmin } = require('../lib/auth');
const { normalizeGuid } = require('../lib/validate');
const { toIso } = require('../lib/partyView');

function withAdmin(handler) {
    return withDb(async (request, context) => {
        const auth = requireAdmin(request);
        if (!auth.ok) return auth.response;
        return handler(request, context, auth.principal);
    });
}

const LIST_ALL_SQL = `
SET NOCOUNT ON;
SELECT y.Id, y.Name, y.CreatedAt, y.UpdatedAt, y.ExpiresAt,
       CASE WHEN y.ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS IsExpired,
       (SELECT COUNT(*) FROM dbo.Players p WHERE p.PartyId = y.Id) AS PlayerCount
FROM dbo.Parties y
ORDER BY y.CreatedAt DESC;`;

async function listAllParties() {
    const pool = await getPool();
    const result = await pool.request().query(LIST_ALL_SQL);
    return json(200, {
        parties: result.recordset.map(row => ({
            id: String(row.Id).toLowerCase(),
            name: row.Name,
            createdAt: toIso(row.CreatedAt),
            updatedAt: toIso(row.UpdatedAt),
            expiresAt: toIso(row.ExpiresAt),
            isExpired: row.IsExpired === 1 || row.IsExpired === true,
            playerCount: row.PlayerCount
        }))
    });
}

const DELETE_ANY_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DELETE FROM dbo.Parties WHERE Id = @partyId;
DECLARE @deleted INT = @@ROWCOUNT;
IF @deleted = 1 DELETE FROM dbo.JoinAttempts WHERE PartyId = @partyId;
COMMIT TRANSACTION;
SELECT @deleted AS Deleted;`;

async function deleteAnyParty(request, context, principal) {
    const partyId = normalizeGuid(request.params.partyId);
    if (!partyId) return errorResponse(404, 'not_found', 'No party matches this id.');

    const pool = await getPool();
    const result = await pool.request()
        .input('partyId', sql.UniqueIdentifier, partyId)
        .query(DELETE_ANY_SQL);

    if (result.recordset[0].Deleted !== 1) return errorResponse(404, 'not_found', 'No party matches this id.');
    context.log('Admin deleted party', { partyId, admin: principal.userDetails || principal.userId });
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
}

app.http('manageListParties', { methods: ['GET'], authLevel: 'anonymous', route: 'manage/parties', handler: withAdmin(listAllParties) });
app.http('manageDeleteParty', { methods: ['DELETE'], authLevel: 'anonymous', route: 'manage/parties/{partyId}', handler: withAdmin(deleteAnyParty) });

module.exports = { listAllParties, deleteAnyParty, withAdmin, LIST_ALL_SQL, DELETE_ANY_SQL };
