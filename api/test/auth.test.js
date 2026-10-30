'use strict';

// Host password sign-in, sessions, the login routes, and the admin routes.

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/lib/db');

let nextResults = [];
let calls = [];
db.getPool = async () => {
    calls.push('connect');
    return {
        request() {
            const inputs = {};
            return {
                input(name, type, value) { inputs[name] = value; return this; },
                async query(text) {
                    calls.push({ text, inputs });
                    return nextResults.shift() || { recordset: [{}] };
                }
            };
        }
    };
};

const auth = require('../src/lib/auth');
const authRoutes = require('../src/functions/auth');
const manage = require('../src/functions/manage');
const maintenance = require('../src/functions/maintenance');
const limits = require('../src/lib/limits');
const { withDb } = require('../src/lib/db');

const PASSWORD = 'correct-horse';
const SECRET = 'a-test-session-secret-that-is-long-enough';
const PARTY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const context = { log() {}, warn() {}, error() {} };

function request({ body, cookie, headers = {}, params = {} } = {}) {
    const all = { 'content-type': 'application/json', ...headers };
    if (cookie) all.cookie = cookie;
    const text = body === undefined ? '' : JSON.stringify(body);
    return { params, headers: new Headers(all), text: async () => text };
}
const loginCall = req => withDb(authRoutes.login)(req, context);
const parse = res => JSON.parse(res.body);
const adminHeader = (roles = ['anonymous', 'authenticated', 'host']) =>
    ({ 'x-ms-client-principal': Buffer.from(JSON.stringify({ identityProvider: 'github', userId: 'gh-1', userDetails: 'pstatonvt', userRoles: roles })).toString('base64') });

test.beforeEach(() => {
    process.env.HOST_PASSWORD = PASSWORD;
    process.env.HOST_SESSION_SECRET = SECRET;
    nextResults = [];
    calls = [];
});

// ---------- library ----------

test('sign-in is off unless both settings exist and the secret is long enough', () => {
    assert.ok(auth.loginConfig());
    process.env.HOST_SESSION_SECRET = 'short';
    assert.equal(auth.loginConfig(), null);
    process.env.HOST_SESSION_SECRET = SECRET;
    delete process.env.HOST_PASSWORD;
    assert.equal(auth.loginConfig(), null);
    assert.equal(auth.passwordMatches(PASSWORD), false);
});

test('passwordMatches needs the exact password', () => {
    assert.equal(auth.passwordMatches(PASSWORD), true);
    assert.equal(auth.passwordMatches(PASSWORD.toUpperCase()), false);
    assert.equal(auth.passwordMatches(`${PASSWORD} `), false);
    assert.equal(auth.passwordMatches(''), false);
    assert.equal(auth.passwordMatches(undefined), false);
    assert.equal(auth.passwordMatches('x'.repeat(201)), false);
});

test('session tokens verify, expire, resist tampering, and die when the password changes', () => {
    const token = auth.createSessionToken();
    assert.equal(auth.verifySessionToken(token), true);

    const [payload, sig] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, exp: 9999999999 })).toString('base64url');
    assert.equal(auth.verifySessionToken(`${forgedPayload}.${sig}`), false, 'payload swap');
    assert.equal(auth.verifySessionToken(`${payload}.${sig.slice(0, -2)}xx`), false, 'bad signature');
    assert.equal(auth.verifySessionToken(`${payload}`), false);
    assert.equal(auth.verifySessionToken('a.b.c'), false);
    assert.equal(auth.verifySessionToken(null), false);

    const old = auth.createSessionToken(Date.now() - 31 * 86400 * 1000);
    assert.equal(auth.verifySessionToken(old), false, 'expired after 30 days');

    process.env.HOST_PASSWORD = 'a-new-password';
    assert.equal(auth.verifySessionToken(token), false, 'changing the password signs everyone out');
});

test('the session cookie is HttpOnly, Secure, SameSite=Strict, and 30 days', () => {
    const cookie = auth.sessionCookie('abc');
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${30 * 86400}`]) {
        assert.ok(cookie.includes(part), part);
    }
    assert.ok(auth.clearedSessionCookie().includes('Max-Age=0'));
});

test('readCookie finds the session among other cookies', () => {
    const req = request({ cookie: `a=1; ${auth.COOKIE_NAME}=tok.en; b=2` });
    assert.equal(auth.readCookie(req, auth.COOKIE_NAME), 'tok.en');
    assert.equal(auth.readCookie(request(), auth.COOKIE_NAME), null);
});

test('requireAdmin needs a GitHub identity with an admin role', () => {
    assert.equal(auth.requireAdmin(request()).response.status, 401);
    assert.equal(auth.requireAdmin(request({ headers: adminHeader(['anonymous', 'authenticated']) })).response.status, 403);
    assert.equal(auth.requireAdmin(request({ headers: adminHeader() })).ok, true);
    assert.equal(auth.requireAdmin(request({ headers: adminHeader(['admin']) })).ok, true);
    assert.equal(auth.requireAdmin(request({ headers: { 'x-ms-client-principal': 'junk' } })).response.status, 401);
});

// ---------- POST /api/auth/login ----------

test('login: right password sets a working session cookie', async () => {
    nextResults = [{ recordset: [{ IpFailures: 0, AllFailures: 0 }] }];
    const res = await loginCall(request({ body: { password: PASSWORD }, headers: { 'x-azure-clientip': '203.0.113.9' } }));
    assert.equal(res.status, 204);
    const cookie = res.headers['Set-Cookie'];
    assert.ok(cookie.startsWith(`${auth.COOKIE_NAME}=`));
    const token = cookie.split(';')[0].split('=')[1];
    assert.equal(auth.verifySessionToken(token), true);
    assert.equal(calls.filter(c => c.text && c.text.includes('INSERT')).length, 0, 'no failure recorded');
    assert.equal(calls[1].inputs.bucket, limits.LOGIN_BUCKET_ID);
});

test('login: wrong password is a 401 and is recorded', async () => {
    nextResults = [{ recordset: [{ IpFailures: 2, AllFailures: 2 }] }];
    const res = await loginCall(request({ body: { password: 'waffles' } }));
    assert.equal(res.status, 401);
    assert.equal(parse(res).error.code, 'wrong_password');
    assert.equal(res.headers['Set-Cookie'], undefined);
    assert.ok(calls.some(c => c.text && c.text.includes('INSERT dbo.JoinAttempts')), 'failure recorded');
});

test('login: locked out after too many wrong guesses, even with the right password', async () => {
    nextResults = [{ recordset: [{ IpFailures: limits.LOGIN_FAILURES_PER_IP, AllFailures: 5 }] }];
    let res = await loginCall(request({ body: { password: PASSWORD } }));
    assert.equal(res.status, 429);
    assert.equal(res.headers['Retry-After'], String(limits.LOGIN_WINDOW_MINUTES * 60));

    nextResults = [{ recordset: [{ IpFailures: 0, AllFailures: limits.LOGIN_FAILURES_PER_HOUR }] }];
    res = await loginCall(request({ body: { password: PASSWORD } }));
    assert.equal(res.status, 429, 'overall hourly limit');
});

test('login: bad bodies are refused before the database; unset password turns it off', async () => {
    assert.equal((await loginCall(request({ body: {} }))).status, 400);
    assert.equal((await loginCall(request({ body: { password: '' } }))).status, 400);
    assert.equal((await loginCall(request({ body: { password: PASSWORD, role: 'admin' } }))).status, 400);
    assert.deepEqual(calls, []);
    delete process.env.HOST_PASSWORD;
    assert.equal((await loginCall(request({ body: { password: PASSWORD } }))).status, 503);
});

test('me and logout never touch the database', async () => {
    const token = auth.createSessionToken();
    let res = await authRoutes.me(request({ cookie: `${auth.COOKIE_NAME}=${token}` }));
    assert.deepEqual(parse(res), { host: true, configured: true });
    res = await authRoutes.me(request());
    assert.deepEqual(parse(res), { host: false, configured: true });
    res = await authRoutes.logout();
    assert.equal(res.status, 204);
    assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0'));
    assert.deepEqual(calls, []);
});

// ---------- admin routes ----------

test('admin routes refuse non-admins, including host-password sessions', async () => {
    const hostSession = `${auth.COOKIE_NAME}=${auth.createSessionToken()}`;
    for (const handler of [manage.listAllParties, manage.deleteAnyParty]) {
        const wrap = manage.withAdmin(handler);
        assert.equal((await wrap(request({ params: { partyId: PARTY } }), context)).status, 401);
        assert.equal((await wrap(request({ cookie: hostSession, params: { partyId: PARTY } }), context)).status, 401);
        assert.equal((await wrap(request({ headers: adminHeader(['authenticated']), params: { partyId: PARTY } }), context)).status, 403);
    }
    assert.deepEqual(calls, []);
});

test('admin can list every party and delete any one', async () => {
    nextResults = [{ recordset: [{ Id: PARTY.toUpperCase(), Name: 'Night', CreatedAt: new Date(), UpdatedAt: new Date(), ExpiresAt: new Date(), IsExpired: 0, PlayerCount: 3 }] }];
    let res = await manage.withAdmin(manage.listAllParties)(request({ headers: adminHeader() }), context);
    assert.equal(res.status, 200);
    assert.equal(parse(res).parties[0].id, PARTY);
    assert.ok(!/HostUserId/.test(manage.LIST_ALL_SQL.split('WHERE')[0]) && !/WHERE y\.HostUserId/.test(manage.LIST_ALL_SQL), 'not filtered by owner');

    nextResults = [{ recordset: [{ Deleted: 1 }] }];
    res = await manage.withAdmin(manage.deleteAnyParty)(request({ headers: adminHeader(), params: { partyId: PARTY } }), context);
    assert.equal(res.status, 204);
    nextResults = [{ recordset: [{ Deleted: 0 }] }];
    res = await manage.withAdmin(manage.deleteAnyParty)(request({ headers: adminHeader(), params: { partyId: PARTY } }), context);
    assert.equal(res.status, 404);
});

test('the weekly cleanup keeps recent wrong-password records', () => {
    assert.match(maintenance.PURGE_SQL, /PartyId <> @loginBucket/);
});
