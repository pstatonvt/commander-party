'use strict';

// Host password sign-in.
//
//   POST /api/auth/login   { "password": "..." }  -> 204 + session cookie
//   GET  /api/auth/me                              -> { host: true|false }
//   POST /api/auth/logout                          -> 204, cookie cleared
//
// Wrong guesses are rate-limited per IP and overall (see limits.js), using the
// JoinAttempts table under a reserved bucket id, so no schema change is needed.

const { app } = require('@azure/functions');
const { sql, getPool, withDb } = require('../lib/db');
const { json, errorResponse, readJsonBody, clientIp, hashIp } = require('../lib/http');
const auth = require('../lib/auth');
const limits = require('../lib/limits');

const noStore = { 'Cache-Control': 'no-store' };

const LOGIN_CHECK_SQL = `
SET NOCOUNT ON;
DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
DELETE FROM dbo.JoinAttempts WHERE PartyId = @bucket AND AttemptedAt < DATEADD(HOUR, -1, @now);
SELECT
    (SELECT COUNT(*) FROM dbo.JoinAttempts
     WHERE PartyId = @bucket AND IpHash = @ipHash AND AttemptedAt >= DATEADD(MINUTE, -@windowMinutes, @now)) AS IpFailures,
    (SELECT COUNT(*) FROM dbo.JoinAttempts
     WHERE PartyId = @bucket AND AttemptedAt >= DATEADD(HOUR, -1, @now)) AS AllFailures;`;

const LOGIN_FAILURE_SQL = `
SET NOCOUNT ON;
INSERT dbo.JoinAttempts (PartyId, IpHash, AttemptedAt) VALUES (@bucket, @ipHash, SYSUTCDATETIME());`;

async function login(request, context) {
    if (!auth.loginConfig()) return errorResponse(503, 'host_login_off', 'Host sign-in is not set up yet.');

    const body = await readJsonBody(request, limits.MAX_GUEST_BODY_BYTES);
    if (!body.ok) return body.response;
    const unknown = Object.keys(body.value).filter(key => key !== 'password');
    if (unknown.length) return errorResponse(400, 'invalid_body', `Unknown field: ${unknown[0].slice(0, 40)}.`);
    const password = body.value.password;
    if (typeof password !== 'string' || !password) return errorResponse(400, 'password_required', 'Enter the host password.');

    const ipHash = hashIp(clientIp(request));
    const pool = await getPool();
    const check = await pool.request()
        .input('bucket', sql.UniqueIdentifier, limits.LOGIN_BUCKET_ID)
        .input('ipHash', sql.Char(64), ipHash)
        .input('windowMinutes', sql.Int, limits.LOGIN_WINDOW_MINUTES)
        .query(LOGIN_CHECK_SQL);
    const { IpFailures, AllFailures } = check.recordset[0];

    // Locked out: refuse without even checking the guess
    if (IpFailures >= limits.LOGIN_FAILURES_PER_IP || AllFailures >= limits.LOGIN_FAILURES_PER_HOUR) {
        return errorResponse(429, 'too_many_attempts', 'Too many wrong passwords. Wait 15 minutes and try again.',
            { 'Retry-After': String(limits.LOGIN_WINDOW_MINUTES * 60) });
    }

    if (!auth.passwordMatches(password)) {
        await pool.request()
            .input('bucket', sql.UniqueIdentifier, limits.LOGIN_BUCKET_ID)
            .input('ipHash', sql.Char(64), ipHash)
            .query(LOGIN_FAILURE_SQL);
        return errorResponse(401, 'wrong_password', "That password isn't right.");
    }

    return { status: 204, headers: { ...noStore, 'Set-Cookie': auth.sessionCookie(auth.createSessionToken()) } };
}

// No database involved: just checks the cookie
async function me(request) {
    return json(200, { host: auth.isHostRequest(request), configured: !!auth.loginConfig() });
}

async function logout() {
    return { status: 204, headers: { ...noStore, 'Set-Cookie': auth.clearedSessionCookie() } };
}

app.http('authLogin', { methods: ['POST'], authLevel: 'anonymous', route: 'auth/login', handler: withDb(login) });
app.http('authMe', { methods: ['GET'], authLevel: 'anonymous', route: 'auth/me', handler: me });
app.http('authLogout', { methods: ['POST'], authLevel: 'anonymous', route: 'auth/logout', handler: logout });

module.exports = { login, me, logout, LOGIN_CHECK_SQL, LOGIN_FAILURE_SQL };
