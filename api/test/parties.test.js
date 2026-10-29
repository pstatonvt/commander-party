'use strict';

// Handler tests with a fake database. The fake pool records each query so the
// tests can check both the HTTP result and that bad requests never touch SQL.

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/lib/db');

let nextResult = null;
let nextError = null;
let calls = [];

// Must be swapped in before parties.js is loaded, because it destructures getPool.
db.getPool = async () => {
    calls.push('connect');
    if (nextError) throw nextError;
    return {
        request() {
            const inputs = {};
            return {
                input(name, type, value) { inputs[name] = value; return this; },
                async query(text) {
                    calls.push({ text, inputs });
                    return nextResult;
                }
            };
        }
    };
};

const { getParty, joinParty, updateMyPlayer } = require('../src/functions/parties');
const { withDb } = require('../src/lib/db');

const PARTY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PLAYER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TOKEN = '16fd2706-8baf-433b-82eb-8c7fada847da';

const context = { warn() {}, error() {} };

function request({ params = {}, body, headers = {} } = {}) {
    const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return {
        params,
        headers: new Headers({ 'content-type': 'application/json', ...headers }),
        text: async () => text
    };
}

function call(handler, req) {
    return withDb(handler)(req, context);
}

function parse(res) {
    return JSON.parse(res.body);
}

test.beforeEach(() => {
    nextResult = null;
    nextError = null;
    calls = [];
});

// ---------- getParty ----------

test('getParty: a malformed id is a 404 and never wakes the database', async () => {
    const res = await call(getParty, request({ params: { partyId: 'garbage' } }));
    assert.equal(res.status, 404);
    assert.deepEqual(calls, []);
});

test('getParty: unknown party is 404', async () => {
    nextResult = { recordsets: [[], []] };
    const res = await call(getParty, request({ params: { partyId: PARTY } }));
    assert.equal(res.status, 404);
});

test('getParty: expired party is 410 with the expiry date', async () => {
    nextResult = { recordsets: [[{ Id: PARTY, Name: 'Old', StateJson: '{}', ExpiresAt: new Date('2026-01-01T00:00:00Z'), IsExpired: 1 }], []] };
    const res = await call(getParty, request({ params: { partyId: PARTY } }));
    assert.equal(res.status, 410);
    assert.equal(parse(res).expiresAt, '2026-01-01T00:00:00.000Z');
});

test('getParty: live party returns the public view, uncached', async () => {
    nextResult = {
        recordsets: [
            [{ Id: PARTY.toUpperCase(), Name: 'Friday', StateJson: '{}', ExpiresAt: new Date('2026-12-28T00:00:00Z'), IsExpired: 0 }],
            [{ Id: PLAYER.toUpperCase(), Name: 'Ajani', Experience: 'Veteran', Dish: 'Pie', PartnerId: null }]
        ]
    };
    const res = await call(getParty, request({ params: { partyId: PARTY.toUpperCase() } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const body = parse(res);
    assert.equal(body.name, 'Friday');
    assert.equal(body.players[0].id, PLAYER);
    assert.equal(calls[1].inputs.partyId, PARTY, 'id is lower-cased before it reaches SQL');
});

// ---------- joinParty ----------

const guest = { name: 'Chandra', experience: 'New', dish: 'Wings' };

test('joinParty: invalid input is rejected before the database', async () => {
    const res = await call(joinParty, request({ params: { partyId: PARTY }, body: { name: '', experience: 'New' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
});

test('joinParty: oversized body is 413 before the database', async () => {
    const res = await call(joinParty, request({ params: { partyId: PARTY }, body: { ...guest, dish: 'x'.repeat(20000) } }));
    assert.equal(res.status, 413);
    assert.deepEqual(calls, []);
});

test('joinParty: success returns the player and edit token, and passes the caps to SQL', async () => {
    nextResult = { recordset: [{ Outcome: 'ok', ExpiresAt: new Date('2026-12-28T00:00:00Z'), PlayerId: PLAYER.toUpperCase(), EditToken: TOKEN.toUpperCase() }] };
    const res = await call(joinParty, request({
        params: { partyId: PARTY },
        body: { ...guest, name: '  Chandra  ' },
        headers: { 'x-azure-clientip': '203.0.113.9' }
    }));
    assert.equal(res.status, 201);
    const body = parse(res);
    assert.deepEqual(body.player, { id: PLAYER, name: 'Chandra', experience: 'New', dish: 'Wings', partnerId: null });
    assert.equal(body.editToken, TOKEN);

    const { inputs } = calls[1];
    assert.equal(inputs.name, 'Chandra');
    assert.equal(inputs.maxPlayers, 40);
    assert.equal(inputs.maxAttempts, 5);
    assert.match(inputs.ipHash, /^[0-9a-f]{64}$/);
});

for (const [outcome, status, code] of [
    ['not_found', 404, 'not_found'],
    ['expired', 410, 'expired'],
    ['rate_limited', 429, 'rate_limited'],
    ['full', 409, 'party_full'],
    ['duplicate_name', 409, 'duplicate_name']
]) {
    test(`joinParty: outcome ${outcome} maps to ${status}`, async () => {
        nextResult = { recordset: [{ Outcome: outcome, ExpiresAt: new Date('2026-01-01T00:00:00Z'), PlayerId: null, EditToken: null }] };
        const res = await call(joinParty, request({ params: { partyId: PARTY }, body: guest }));
        assert.equal(res.status, status);
        assert.equal(parse(res).error.code, code);
        if (status === 429) assert.equal(res.headers['Retry-After'], '600');
    });
}

// ---------- updateMyPlayer ----------

test('updateMyPlayer: missing edit token is 400 before the database', async () => {
    const res = await call(updateMyPlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: guest }));
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
});

test('updateMyPlayer: wrong token is a plain 404', async () => {
    nextResult = { recordset: [{ Outcome: 'not_found', PartnerId: null }] };
    const res = await call(updateMyPlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: { ...guest, editToken: TOKEN } }));
    assert.equal(res.status, 404);
});

test('updateMyPlayer: success returns the updated player', async () => {
    nextResult = { recordset: [{ Outcome: 'ok', PartnerId: null }] };
    const res = await call(updateMyPlayer, request({
        params: { partyId: PARTY, playerId: PLAYER.toUpperCase() },
        body: { ...guest, dish: 'Nachos', editToken: TOKEN.toUpperCase() }
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(parse(res).player, { id: PLAYER, name: 'Chandra', experience: 'New', dish: 'Nachos', partnerId: null });
    assert.equal(calls[1].inputs.editToken, TOKEN);
});

// ---------- error mapping ----------

test('a paused database becomes a 503 with Retry-After', async () => {
    nextError = Object.assign(new Error('Database is not currently available'), { code: 'ELOGIN', originalError: { info: { number: 40613 } } });
    const res = await call(getParty, request({ params: { partyId: PARTY } }));
    assert.equal(res.status, 503);
    assert.equal(res.headers['Retry-After'], '30');
});

test('other failures become a generic 500 that leaks nothing', async () => {
    nextError = new Error('Login failed for user commander_api at secret-server');
    const res = await call(getParty, request({ params: { partyId: PARTY } }));
    assert.equal(res.status, 500);
    assert.ok(!res.body.includes('secret-server'));
});
