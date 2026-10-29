'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGuid, normalizeGuid, cleanText, validatePlayerInput } = require('../src/lib/validate');
const { readJsonBody, clientIp, hashIp } = require('../src/lib/http');
const { isDatabaseUnavailable } = require('../src/lib/db');
const { buildPublicView } = require('../src/lib/partyView');

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function fakeRequest({ headers = {}, body = '' } = {}) {
    return { headers: new Headers(headers), text: async () => body };
}

test('GUIDs are recognised and lower-cased', () => {
    assert.equal(isGuid(GUID), true);
    assert.equal(normalizeGuid(GUID.toUpperCase()), GUID);
    assert.equal(normalizeGuid('not-a-guid'), null);
    assert.equal(normalizeGuid(`${GUID}' OR 1=1 --`), null);
    assert.equal(normalizeGuid(42), null);
});

test('cleanText trims, collapses whitespace, strips invisible characters, rejects over-long text', () => {
    assert.equal(cleanText('  Jace \n\t Beleren  ', 40), 'Jace Beleren');
    assert.equal(cleanText('Zero​width‮flip', 40), 'Zerowidthflip');
    assert.equal(cleanText(undefined, 40), '');
    assert.equal(cleanText(12, 40), null);
    assert.equal(cleanText('x'.repeat(41), 40), null);
    assert.equal(cleanText('x'.repeat(40), 40), 'x'.repeat(40));
});

test('validatePlayerInput accepts a good guest', () => {
    const result = validatePlayerInput({ name: ' Chandra ', experience: 'New', dish: 'Hot wings' });
    assert.deepEqual(result, { ok: true, value: { name: 'Chandra', experience: 'New', dish: 'Hot wings' } });
});

test('validatePlayerInput treats a missing dish as empty', () => {
    const result = validatePlayerInput({ name: 'Liliana', experience: 'Veteran' });
    assert.equal(result.ok, true);
    assert.equal(result.value.dish, '');
});

test('validatePlayerInput rejects bad input', () => {
    assert.equal(validatePlayerInput(null).ok, false);
    assert.equal(validatePlayerInput([]).ok, false);
    assert.equal(validatePlayerInput({ name: '   ', experience: 'New' }).ok, false);
    assert.equal(validatePlayerInput({ name: 'Nissa', experience: 'Expert' }).ok, false);
    assert.equal(validatePlayerInput({ name: 'Nissa', experience: 'New', dish: 'x'.repeat(81) }).ok, false);
    assert.equal(validatePlayerInput({ name: 'Nissa', experience: 'New', addedByHost: true }).ok, false);
    assert.equal(validatePlayerInput({ name: 'Nissa', experience: 'New', editToken: GUID }).ok, false);
    assert.equal(validatePlayerInput({ name: 'Nissa', experience: 'New', editToken: GUID }, ['editToken']).ok, true);
});

test('readJsonBody enforces content type, size, and shape', async () => {
    const json = { 'content-type': 'application/json' };

    let r = await readJsonBody(fakeRequest({ headers: { 'content-type': 'text/plain' }, body: '{}' }), 100);
    assert.equal(r.response.status, 415);

    r = await readJsonBody(fakeRequest({ headers: { ...json, 'content-length': '5000' }, body: '{}' }), 100);
    assert.equal(r.response.status, 413);

    r = await readJsonBody(fakeRequest({ headers: json, body: JSON.stringify({ a: 'x'.repeat(200) }) }), 100);
    assert.equal(r.response.status, 413);

    r = await readJsonBody(fakeRequest({ headers: json, body: '{nope' }), 100);
    assert.equal(r.response.status, 400);

    r = await readJsonBody(fakeRequest({ headers: json, body: '[1,2]' }), 100);
    assert.equal(r.response.status, 400);

    r = await readJsonBody(fakeRequest({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":1}' }), 100);
    assert.deepEqual(r, { ok: true, value: { a: 1 } });
});

test('clientIp prefers the Front Door header and strips ports', () => {
    assert.equal(clientIp(fakeRequest({ headers: { 'x-azure-clientip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' } })), '203.0.113.9');
    assert.equal(clientIp(fakeRequest({ headers: { 'x-forwarded-for': '198.51.100.7:52311, 10.0.0.1' } })), '198.51.100.7');
    assert.equal(clientIp(fakeRequest({ headers: { 'x-forwarded-for': '[2001:db8::1]:443' } })), '2001:db8::1');
    assert.equal(clientIp(fakeRequest()), 'unknown');
});

test('hashIp is a stable 64-character hex digest that hides the IP', () => {
    const h = hashIp('203.0.113.9');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, hashIp('203.0.113.9'));
    assert.notEqual(h, hashIp('203.0.113.10'));
    assert.ok(!h.includes('203'));
});

test('isDatabaseUnavailable spots paused-database errors, including wrapped ones', () => {
    assert.equal(isDatabaseUnavailable({ number: 40613 }), true);
    assert.equal(isDatabaseUnavailable({ code: 'ELOGIN', originalError: { info: { number: 40613 } } }), true);
    assert.equal(isDatabaseUnavailable({ code: 'ETIMEOUT' }), true);
    assert.equal(isDatabaseUnavailable({ number: 2627 }), false);
    assert.equal(isDatabaseUnavailable(new Error('boom')), false);
});

test('buildPublicView exposes only safe fields and the current round seating', () => {
    const p1 = 'AAAAAAAA-0000-0000-0000-000000000001';
    const p2 = 'AAAAAAAA-0000-0000-0000-000000000002';
    const state = {
        event: { roundCount: 2, roundMinutes: 45, tournament: true },
        currentRound: 1,
        tables: [{ id: 'tbl_1', name: 'Pod 1', capacity: 4 }, { id: 'tbl_2', name: 'Pod 2', capacity: 9 }],
        rounds: [
            { [p1.toLowerCase()]: { tableId: 'tbl_1', seatIndex: 0 } },
            {
                [p1.toLowerCase()]: { tableId: 'tbl_2', seatIndex: 1 },
                [p2.toLowerCase()]: { tableId: 'ghost_table', seatIndex: 0 },
                'deleted-player': { tableId: 'tbl_1', seatIndex: 2 }
            }
        ],
        results: [{ secret: 40 }]
    };
    const party = {
        Id: '0F8FAD5B-D9CB-469F-A165-70867728950E',
        Name: 'Friday Commander',
        StateJson: JSON.stringify(state),
        ExpiresAt: new Date('2026-12-28T00:00:00Z'),
        HostUserId: 'host-123'
    };
    const players = [
        { Id: p1, Name: 'Ajani', Experience: 'Veteran', Dish: 'Pie', PartnerId: null, EditToken: 'secret' },
        { Id: p2, Name: 'Kaya', Experience: 'New', Dish: '', PartnerId: p1 }
    ];

    const view = buildPublicView(party, players);

    assert.equal(view.id, GUID);
    assert.equal(view.expiresAt, '2026-12-28T00:00:00.000Z');
    assert.deepEqual(view.event, { roundCount: 2, roundMinutes: 45, tournament: true });
    assert.equal(view.currentRound, 1);
    assert.equal(view.tables[1].capacity, 6, 'capacity is clamped');
    assert.deepEqual(view.seating, [{ playerId: p1.toLowerCase(), tableId: 'tbl_2', seatIndex: 1 }]);
    assert.equal(view.players[1].partnerId, p1.toLowerCase());

    const text = JSON.stringify(view);
    for (const leaked of ['secret', 'host-123', 'EditToken', 'HostUserId', 'results']) {
        assert.ok(!text.includes(leaked), `view must not contain ${leaked}`);
    }
});

test('buildPublicView survives corrupt saved state', () => {
    const view = buildPublicView(
        { Id: GUID, Name: 'Broken', StateJson: '{not json', ExpiresAt: '2026-12-28T00:00:00Z' },
        []
    );
    assert.deepEqual(view.tables, []);
    assert.deepEqual(view.seating, []);
    assert.equal(view.currentRound, 0);
});
