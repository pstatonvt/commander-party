'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/lib/db');

let calls = [];
db.getPool = async () => {
    calls.push('connect');
    return {
        request() {
            const inputs = {};
            return {
                input(name, type, value) { inputs[name] = value; return this; },
                async query() {
                    calls.push({ inputs });
                    return { recordset: [{ PartiesDeleted: 2, PlayersDeleted: 7, JoinAttemptsDeleted: 30, PartiesRemaining: 5 }] };
                }
            };
        }
    };
};

const { purge, secretMatches } = require('../src/functions/maintenance');
const { withDb } = require('../src/lib/db');

const SECRET = 'a-very-long-random-purge-secret-value';
const context = { log() {}, warn() {}, error() {} };
const request = headers => ({ params: {}, headers: new Headers(headers), text: async () => '' });
const call = req => withDb(purge)(req, context);

test.beforeEach(() => {
    calls = [];
    process.env.PURGE_SECRET = SECRET;
});

test.after(() => {
    delete process.env.PURGE_SECRET;
});

test('secretMatches needs the exact configured secret', () => {
    assert.equal(secretMatches(SECRET), true);
    assert.equal(secretMatches(`${SECRET}x`), false);
    assert.equal(secretMatches(''), false);
    assert.equal(secretMatches(undefined), false);
});

test('a short or missing PURGE_SECRET disables the route', () => {
    process.env.PURGE_SECRET = 'short';
    assert.equal(secretMatches('short'), false);
    delete process.env.PURGE_SECRET;
    assert.equal(secretMatches(''), false);
});

test('wrong or missing secret gets a 404 and never touches the database', async () => {
    assert.equal((await call(request({}))).status, 404);
    assert.equal((await call(request({ 'x-purge-secret': 'guess' }))).status, 404);
    delete process.env.PURGE_SECRET;
    assert.equal((await call(request({ 'x-purge-secret': SECRET }))).status, 404);
    assert.deepEqual(calls, []);
});

test('right secret runs the purge with the 30-day grace period', async () => {
    const res = await call(request({ 'x-purge-secret': SECRET }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { partiesDeleted: 2, playersDeleted: 7, joinAttemptsDeleted: 30, partiesRemaining: 5, graceDays: 30 });
    assert.equal(calls[1].inputs.graceDays, 30);
});
