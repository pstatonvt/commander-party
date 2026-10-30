'use strict';

// Host route tests with a fake database, plus the auth and state helpers.

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/lib/db');

let nextResult = null;
let calls = [];

// Must be swapped in before host.js is loaded, because it destructures getPool.
db.getPool = async () => {
    calls.push('connect');
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

const host = require('../src/functions/host');
const { getPrincipal, requireHost } = require('../src/lib/auth');
const { sanitizeState, remapStateIds, serializeState } = require('../src/lib/hostState');
const limits = require('../src/lib/limits');

const PARTY = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PLAYER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PARTNER = '16fd2706-8baf-433b-82eb-8c7fada847da';
const context = { warn() {}, error() {} };

function principalHeader(overrides = {}) {
    const principal = { identityProvider: 'github', userId: 'host-user-1', userDetails: 'someone', userRoles: ['anonymous', 'authenticated', 'host'], ...overrides };
    return Buffer.from(JSON.stringify(principal)).toString('base64');
}

function request({ params = {}, body, principal = principalHeader(), headers = {} } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const all = { 'content-type': 'application/json', ...headers };
    if (principal) all['x-ms-client-principal'] = principal;
    return { params, headers: new Headers(all), text: async () => text };
}

function call(handler, req) {
    return host.withHost(handler)(req, context);
}

const parse = res => JSON.parse(res.body);
const partyRow = (extra = {}) => ({
    Id: PARTY.toUpperCase(), Name: 'Friday', StateJson: '{"event":{"roundCount":1}}',
    CreatedAt: new Date('2026-10-30T00:00:00Z'), UpdatedAt: new Date('2026-10-30T00:00:00Z'),
    ExpiresAt: new Date('2026-12-29T00:00:00Z'), IsExpired: 0, ...extra
});

test.beforeEach(() => {
    nextResult = null;
    calls = [];
});

// ---------- auth ----------

test('getPrincipal decodes the SWA header and rejects junk', () => {
    const req = request();
    assert.equal(getPrincipal(req).userId, 'host-user-1');
    assert.equal(getPrincipal(request({ principal: 'not base64 json' })), null);
    assert.equal(getPrincipal(request({ principal: principalHeader({ userId: '' }) })), null);
    assert.equal(getPrincipal(request({ principal: principalHeader({ userId: 'x'.repeat(129) }) })), null);
    assert.equal(getPrincipal(request({ principal: null })), null);
});

test('requireHost: 401 when signed out, 403 without the host role', () => {
    assert.equal(requireHost(request({ principal: null })).response.status, 401);
    assert.equal(requireHost(request({ principal: principalHeader({ userRoles: ['authenticated'] }) })).response.status, 403);
    assert.equal(requireHost(request()).ok, true);
});

test('host routes refuse signed-out and non-host callers before touching the database', async () => {
    const handlers = [host.createParty, host.listParties, host.getHostParty, host.saveParty, host.deleteParty, host.addPlayer, host.updatePlayer, host.deletePlayer];
    for (const handler of handlers) {
        assert.equal((await call(handler, request({ principal: null, params: { partyId: PARTY, playerId: PLAYER } }))).status, 401);
        assert.equal((await call(handler, request({ principal: principalHeader({ userRoles: ['authenticated'] }), params: { partyId: PARTY, playerId: PLAYER } }))).status, 403);
    }
    assert.deepEqual(calls, []);
});

// ---------- state cleaning ----------

test('sanitizeState keeps a known shape, clamps numbers, drops junk', () => {
    const result = sanitizeState({
        app: 'mtg', version: 3, players: [{ secret: true }], hostile: { a: 1 },
        event: { roundCount: 2, roundMinutes: 9999, tournament: 'yes' },
        tables: [{ id: 'tbl_1', name: '  Pod  1 ', capacity: 99 }, { id: 'tbl_1', name: 'dup' }, { name: 'no id' }],
        rounds: [{ p1: { tableId: 'tbl_1', seatIndex: 0 }, p2: { tableId: 'tbl_1', seatIndex: 9 }, p3: 'junk' }],
        results: [{ p1: '35', p2: 'x', p3: -5 }],
        currentRound: 7
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
        event: { roundCount: 2, roundMinutes: 240, tournament: false },
        tables: [{ id: 'tbl_1', name: 'Pod 1', capacity: 6 }],
        rounds: [{ p1: { tableId: 'tbl_1', seatIndex: 0 } }, {}],
        results: [{ p1: 35, p3: 0 }, {}],
        currentRound: 1
    });
});

test('sanitizeState rejects oversized input', () => {
    assert.equal(sanitizeState(null).ok, false);
    assert.equal(sanitizeState([]).ok, false);
    assert.equal(sanitizeState({ tables: Array.from({ length: 51 }, (_, i) => ({ id: `t${i}` })) }).ok, false);
    assert.equal(sanitizeState({ rounds: Array(11).fill({}) }).ok, false);
    const bigRound = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, { tableId: 't', seatIndex: 0 }]));
    assert.equal(sanitizeState({ event: { roundCount: 1 }, rounds: [bigRound] }).ok, false);
});

test('remapStateIds rewrites seating and results to new ids and drops unknown players', () => {
    const state = sanitizeState({
        event: { roundCount: 1 },
        rounds: [{ old1: { tableId: 't', seatIndex: 0 }, gone: { tableId: 't', seatIndex: 1 } }],
        results: [{ old1: 20, gone: 10 }]
    }).value;
    const out = remapStateIds(state, new Map([['old1', PLAYER]]));
    assert.deepEqual(out.rounds, [{ [PLAYER]: { tableId: 't', seatIndex: 0 } }]);
    assert.deepEqual(out.results, [{ [PLAYER]: 20 }]);
});

test('serializeState enforces the 64 KB cap', () => {
    assert.ok(serializeState({ a: 'x' }));
    assert.equal(serializeState({ a: 'x'.repeat(limits.MAX_STATE_CHARS) }), null);
});

// ---------- importing players on create ----------

test('readImportedPlayers assigns GUIDs and keeps only mutual pairs', () => {
    const { players, idMap } = host.readImportedPlayers([
        { id: 'a', name: 'Ajani', experience: 'Veteran', dish: 'Pie', partnerId: 'b' },
        { id: 'b', name: 'Kaya', experience: 'New', partnerId: 'a' },
        { id: 'c', name: 'Chandra', experience: 'Learning', partnerId: 'a' }
    ]);
    assert.equal(idMap.size, 3);
    assert.match(players[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(players[0].partnerId, idMap.get('b'));
    assert.equal(players[1].partnerId, idMap.get('a'));
    assert.equal(players[2].partnerId, null, 'one-sided pair is dropped');
    assert.equal(players[1].dish, '');
});

test('readImportedPlayers rejects bad rosters', () => {
    assert.ok(host.readImportedPlayers('nope').error);
    assert.ok(host.readImportedPlayers([{ name: 'No id', experience: 'New' }]).error);
    assert.ok(host.readImportedPlayers([{ id: 'a', name: 'A', experience: 'New' }, { id: 'a', name: 'B', experience: 'New' }]).error);
    assert.ok(host.readImportedPlayers([{ id: 'a', name: '', experience: 'New' }]).error);
    assert.ok(host.readImportedPlayers(Array.from({ length: 41 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, experience: 'New' }))).error);
    assert.deepEqual(host.readImportedPlayers(undefined).players, []);
});

// ---------- createParty ----------

test('createParty: validates before the database', async () => {
    let res = await call(host.createParty, request({ body: { state: {}, extra: 1 } }));
    assert.equal(res.status, 400);
    res = await call(host.createParty, request({ body: { state: 'nope' } }));
    assert.equal(res.status, 400);
    res = await call(host.createParty, request({ body: { state: {}, name: 'x'.repeat(81) } }));
    assert.equal(res.status, 400);
    res = await call(host.createParty, request({ body: { state: {}, players: [{ id: 'a', name: '', experience: 'New' }] } }));
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
});

test('createParty: imports the roster, remaps seating, and returns the id map', async () => {
    nextResult = { recordsets: [[{ Outcome: 'ok' }], [partyRow()], [{ Id: PLAYER.toUpperCase(), Name: 'Ajani', Experience: 'Veteran', Dish: 'Pie', PartnerId: null, AddedByHost: true }]] };
    const res = await call(host.createParty, request({
        body: {
            name: ' Friday ',
            state: { event: { roundCount: 1 }, tables: [{ id: 'tbl_1', name: 'Pod 1', capacity: 4 }], rounds: [{ p_1: { tableId: 'tbl_1', seatIndex: 0 } }] },
            players: [{ id: 'p_1', name: 'Ajani', experience: 'Veteran', dish: 'Pie' }]
        }
    }));
    assert.equal(res.status, 201);
    const body = parse(res);
    assert.equal(body.party.id, PARTY);
    assert.equal(body.party.players[0].addedByHost, true);
    assert.match(body.idMap.p_1, /^[0-9a-f-]{36}$/);

    const { inputs } = calls[1];
    assert.equal(inputs.hostUserId, 'host-user-1', 'owner comes from the principal, not the body');
    assert.equal(inputs.name, 'Friday');
    assert.equal(inputs.maxParties, 20);
    assert.equal(inputs.lifetimeDays, 60);
    const stored = JSON.parse(inputs.stateJson);
    assert.deepEqual(Object.keys(stored.rounds[0]), [body.idMap.p_1]);
    assert.equal(JSON.parse(inputs.playersJson)[0].id, body.idMap.p_1);
});

test('createParty: defaults the name and reports the party cap', async () => {
    nextResult = { recordsets: [[{ Outcome: 'too_many' }], [], []] };
    const res = await call(host.createParty, request({ body: { state: {} } }));
    assert.equal(res.status, 409);
    assert.equal(parse(res).error.code, 'too_many_parties');
    assert.equal(calls[1].inputs.name, 'Commander Party');
});

test('createParty: uses a page-chosen id, so a retry is safe', async () => {
    nextResult = { recordsets: [[{ Outcome: 'ok' }], [partyRow()], []] };
    await call(host.createParty, request({ body: { id: PARTY.toUpperCase(), state: {} } }));
    assert.equal(calls[1].inputs.partyId, PARTY, 'page id is used, lower-cased');

    calls = [];
    const bad = await call(host.createParty, request({ body: { id: 'not-a-guid', state: {} } }));
    assert.equal(bad.status, 400);
    assert.equal(parse(bad).error.code, 'invalid_id');
    assert.deepEqual(calls, [], 'bad id rejected before the database');
});

test('createParty: a retry of a create that went through returns the same party', async () => {
    nextResult = { recordsets: [[{ Outcome: 'exists' }], [partyRow()], [{ Id: PLAYER, Name: 'Ajani', Experience: 'Veteran', Dish: '', PartnerId: null, AddedByHost: true }]] };
    const res = await call(host.createParty, request({ body: { id: PARTY, state: {} } }));
    assert.equal(res.status, 200);
    const body = parse(res);
    assert.equal(body.existing, true);
    assert.equal(body.party.id, PARTY);
    assert.equal(body.party.players.length, 1);
});

test('createParty: an id owned by another host is refused', async () => {
    nextResult = { recordsets: [[{ Outcome: 'taken' }], [], []] };
    const res = await call(host.createParty, request({ body: { id: PARTY, state: {} } }));
    assert.equal(res.status, 409);
    assert.equal(parse(res).error.code, 'id_taken');
});

// ---------- list / get / save / delete ----------

test('listParties returns only the fields the picker needs', async () => {
    nextResult = { recordset: [{ ...partyRow(), PlayerCount: 3, StateJson: undefined }] };
    const res = await call(host.listParties, request());
    assert.equal(res.status, 200);
    const body = parse(res);
    assert.deepEqual(Object.keys(body.parties[0]).sort(), ['createdAt', 'expiresAt', 'id', 'isExpired', 'name', 'playerCount', 'updatedAt']);
    assert.equal(body.limit, 20);
    assert.equal(calls[1].inputs.hostUserId, 'host-user-1');
});

test('getHostParty: 404 for bad ids and other hosts, full view for the owner', async () => {
    assert.equal((await call(host.getHostParty, request({ params: { partyId: 'bad' } }))).status, 404);
    assert.deepEqual(calls, []);

    nextResult = { recordsets: [[], []] };
    assert.equal((await call(host.getHostParty, request({ params: { partyId: PARTY } }))).status, 404);

    nextResult = { recordsets: [[partyRow()], [{ Id: PLAYER, Name: 'Kaya', Experience: 'New', Dish: '', PartnerId: null, AddedByHost: false }]] };
    const res = await call(host.getHostParty, request({ params: { partyId: PARTY } }));
    assert.equal(res.status, 200);
    const { party } = parse(res);
    assert.deepEqual(party.state, { event: { roundCount: 1 } });
    assert.equal(party.players[0].addedByHost, false);
    assert.ok(!JSON.stringify(party).includes('EditToken'));
});

test('saveParty: validates, then maps outcomes', async () => {
    assert.equal((await call(host.saveParty, request({ params: { partyId: PARTY }, body: { state: {}, players: [] } }))).status, 400);
    assert.equal((await call(host.saveParty, request({ params: { partyId: PARTY }, body: { state: {}, name: '' } }))).status, 400);
    assert.deepEqual(calls, []);

    nextResult = { recordset: [{ Outcome: 'ok', ExpiresAt: new Date('2026-12-29T00:00:00Z'), UpdatedAt: new Date('2026-10-30T01:00:00Z') }] };
    let res = await call(host.saveParty, request({ params: { partyId: PARTY }, body: { state: { event: { roundCount: 1 } } } }));
    assert.equal(res.status, 200);
    assert.equal(parse(res).updatedAt, '2026-10-30T01:00:00.000Z');
    assert.equal(calls[1].inputs.name, null, 'name is left alone when not sent');

    nextResult = { recordset: [{ Outcome: 'expired', ExpiresAt: new Date('2026-01-01T00:00:00Z'), UpdatedAt: null }] };
    res = await call(host.saveParty, request({ params: { partyId: PARTY }, body: { state: {} } }));
    assert.equal(res.status, 410);

    nextResult = { recordset: [{ Outcome: 'not_found', ExpiresAt: null, UpdatedAt: null }] };
    res = await call(host.saveParty, request({ params: { partyId: PARTY }, body: { state: {} } }));
    assert.equal(res.status, 404);
});

test('deleteParty: 204 when deleted, 404 otherwise', async () => {
    nextResult = { recordset: [{ Deleted: 1 }] };
    assert.equal((await call(host.deleteParty, request({ params: { partyId: PARTY } }))).status, 204);
    nextResult = { recordset: [{ Deleted: 0 }] };
    assert.equal((await call(host.deleteParty, request({ params: { partyId: PARTY } }))).status, 404);
});

// ---------- players ----------

const roster = [{ Id: PLAYER, Name: 'Ajani', Experience: 'Veteran', Dish: 'Pie', PartnerId: PARTNER, AddedByHost: true }];

test('addPlayer: returns the new id and roster; maps cap and duplicates', async () => {
    nextResult = { recordsets: [[{ Outcome: 'ok', ExpiresAt: new Date(), PlayerId: PLAYER.toUpperCase() }], roster] };
    let res = await call(host.addPlayer, request({ params: { partyId: PARTY }, body: { name: 'Ajani', experience: 'Veteran', dish: 'Pie' } }));
    assert.equal(res.status, 201);
    assert.equal(parse(res).playerId, PLAYER);

    for (const [outcome, status] of [['full', 409], ['duplicate_name', 409], ['not_found', 404]]) {
        nextResult = { recordsets: [[{ Outcome: outcome, ExpiresAt: null, PlayerId: null }], []] };
        res = await call(host.addPlayer, request({ params: { partyId: PARTY }, body: { name: 'B', experience: 'New' } }));
        assert.equal(res.status, status, outcome);
    }
});

test('updatePlayer: partnerId absent leaves the pair, null clears it, a GUID sets it', async () => {
    nextResult = { recordsets: [[{ Outcome: 'ok', ExpiresAt: new Date() }], roster] };
    const base = { name: 'Ajani', experience: 'Veteran', dish: 'Pie' };

    await call(host.updatePlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: base }));
    assert.equal(calls.at(-1).inputs.setPartner, 0);

    await call(host.updatePlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: { ...base, partnerId: null } }));
    assert.equal(calls.at(-1).inputs.setPartner, 1);
    assert.equal(calls.at(-1).inputs.partnerId, null);

    const res = await call(host.updatePlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: { ...base, partnerId: PARTNER.toUpperCase() } }));
    assert.equal(calls.at(-1).inputs.partnerId, PARTNER);
    assert.equal(res.status, 200);
    assert.equal(parse(res).players[0].partnerId, PARTNER);
});

test('updatePlayer: bad partner id is a 400 before the database; outcomes map', async () => {
    const res = await call(host.updatePlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: { name: 'A', experience: 'New', partnerId: 'nope' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);

    for (const [outcome, status] of [['bad_partner', 400], ['duplicate_name', 409], ['not_found', 404], ['expired', 410]]) {
        nextResult = { recordsets: [[{ Outcome: outcome, ExpiresAt: new Date('2026-01-01T00:00:00Z') }], []] };
        const r = await call(host.updatePlayer, request({ params: { partyId: PARTY, playerId: PLAYER }, body: { name: 'A', experience: 'New' } }));
        assert.equal(r.status, status, outcome);
    }
});

test('deletePlayer: returns the remaining roster', async () => {
    nextResult = { recordsets: [[{ Outcome: 'ok', ExpiresAt: new Date() }], []] };
    const res = await call(host.deletePlayer, request({ params: { partyId: PARTY, playerId: PLAYER } }));
    assert.equal(res.status, 200);
    assert.deepEqual(parse(res).players, []);
    assert.equal((await call(host.deletePlayer, request({ params: { partyId: PARTY, playerId: 'bad' } }))).status, 404);
});
