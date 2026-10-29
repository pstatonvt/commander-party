'use strict';

const sql = require('mssql');
const { errorResponse } = require('./http');
const { DB_RETRY_AFTER_SECONDS } = require('./limits');

let poolPromise = null;

// One shared pool per function host. mssql closes idle connections after 30 s
// by default, which matters: an open connection keeps the serverless database
// awake and burns the free monthly compute allowance.
function getPool() {
    if (!poolPromise) {
        const connectionString = process.env.SQL_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error('SQL_CONNECTION_STRING is not set.');
        }
        const pool = new sql.ConnectionPool(connectionString);
        pool.on('error', () => { poolPromise = null; });
        poolPromise = pool.connect().catch(err => {
            poolPromise = null;
            throw err;
        });
    }
    return poolPromise;
}

// SQL error numbers that mean "the database is paused, resuming, or briefly
// unreachable" rather than a bug. The free offer auto-pauses when idle and for
// the rest of the month once the free allowance is used up.
const UNAVAILABLE_NUMBERS = new Set([40613, 40197, 40501, 49918, 49919, 49920, 42108, 42109]);
const UNAVAILABLE_CODES = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ENOTOPEN']);

function isDatabaseUnavailable(err) {
    for (let e = err, depth = 0; e && depth < 4; e = e.originalError, depth++) {
        if (UNAVAILABLE_NUMBERS.has(e.number) || UNAVAILABLE_NUMBERS.has(e.info?.number)) return true;
        if (UNAVAILABLE_CODES.has(e.code)) return true;
    }
    return false;
}

// Wraps a handler so database outages become a clean 503 and anything else a
// generic 500. Error details go to the function log, never to the client.
// Handlers call getPool() themselves, after validating input, so junk
// requests never wake a paused database.
function withDb(handler) {
    return async (request, context) => {
        try {
            return await handler(request, context);
        } catch (err) {
            if (isDatabaseUnavailable(err)) {
                context.warn('Database unavailable', err?.message);
                return errorResponse(503, 'database_unavailable',
                    'The party database is waking up or paused. Try again shortly.',
                    { 'Retry-After': String(DB_RETRY_AFTER_SECONDS) });
            }
            context.error('Unhandled error', err);
            return errorResponse(500, 'server_error', 'Something went wrong.');
        }
    };
}

module.exports = { sql, getPool, withDb, isDatabaseUnavailable };
