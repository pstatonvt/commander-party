'use strict';

// POST /api/maintenance/purge
//
// Called weekly by .github/workflows/purge-expired.yml. Deletes parties more
// than PURGE_GRACE_DAYS past their expiry (their players go with them), and
// join-rate-limit records older than an hour or for parties that no longer
// exist. The caller must send the PURGE_SECRET app setting in the
// x-purge-secret header. Anything else gets the same 404 as an unknown route,
// before the database is touched.
//
// The route isn't under /api/admin because Azure Functions reserves routes
// that start with "admin" for its own management API.

const crypto = require('node:crypto');
const { app } = require('@azure/functions');
const { sql, getPool, withDb } = require('../lib/db');
const { json, errorResponse } = require('../lib/http');
const limits = require('../lib/limits');

const MIN_SECRET_LENGTH = 16;

// Constant-time comparison of the header against the configured secret.
// A missing or short PURGE_SECRET disables the route entirely.
function secretMatches(provided) {
    const expected = process.env.PURGE_SECRET || '';
    if (expected.length < MIN_SECRET_LENGTH || typeof provided !== 'string' || !provided) return false;
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

const PURGE_SQL = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DECLARE @cutoff DATETIME2(0) = DATEADD(DAY, -@graceDays, @now);
DECLARE @parties INT, @players INT, @attempts INT;

BEGIN TRANSACTION;

SELECT @players = COUNT(*)
FROM dbo.Players p JOIN dbo.Parties y ON y.Id = p.PartyId
WHERE y.ExpiresAt < @cutoff;

DELETE FROM dbo.Parties WHERE ExpiresAt < @cutoff;
SET @parties = @@ROWCOUNT;

DELETE FROM dbo.JoinAttempts
WHERE AttemptedAt < DATEADD(HOUR, -1, @now)
   OR PartyId NOT IN (SELECT Id FROM dbo.Parties);
SET @attempts = @@ROWCOUNT;

COMMIT TRANSACTION;

SELECT @parties AS PartiesDeleted, @players AS PlayersDeleted, @attempts AS JoinAttemptsDeleted,
       (SELECT COUNT(*) FROM dbo.Parties) AS PartiesRemaining;`;

async function purge(request, context) {
    if (!secretMatches(request.headers.get('x-purge-secret'))) {
        return errorResponse(404, 'not_found', 'Not found.');
    }

    const pool = await getPool();
    const result = await pool.request()
        .input('graceDays', sql.Int, limits.PURGE_GRACE_DAYS)
        .query(PURGE_SQL);

    const row = result.recordset[0];
    const summary = {
        partiesDeleted: row.PartiesDeleted,
        playersDeleted: row.PlayersDeleted,
        joinAttemptsDeleted: row.JoinAttemptsDeleted,
        partiesRemaining: row.PartiesRemaining,
        graceDays: limits.PURGE_GRACE_DAYS
    };
    context.log('Purge finished', summary);
    return json(200, summary);
}

app.http('maintenancePurge', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'maintenance/purge',
    handler: withDb(purge)
});

module.exports = { purge, secretMatches, PURGE_SQL };
