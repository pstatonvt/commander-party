'use strict';

// Hard caps that keep anyone with a party link from filling the database.
// The SQL schema enforces the field lengths too; these are the API's first line.
module.exports = Object.freeze({
    MAX_PLAYERS_PER_PARTY: 40,

    // A guest IP may try to join a given party this many times per window.
    JOIN_ATTEMPTS_PER_WINDOW: 5,
    JOIN_WINDOW_MINUTES: 10,

    // Largest request body accepted from guests.
    MAX_GUEST_BODY_BYTES: 16 * 1024,

    PLAYER_NAME_MAX: 40,
    PLAYER_DISH_MAX: 80,
    EXPERIENCE_LEVELS: Object.freeze(['New', 'Learning', 'Veteran']),

    // Host limits. When a host is at the party cap, their expired parties are
    // deleted to make room before a new one is refused.
    MAX_PARTIES_PER_HOST: 20,
    PARTY_LIFETIME_DAYS: 60,
    PARTY_NAME_MAX: 80,
    MAX_HOST_BODY_BYTES: 96 * 1024,

    // Saved organizer state. MAX_STATE_CHARS matches the 64 KB NVARCHAR check
    // on Parties.StateJson.
    MAX_STATE_CHARS: 65536,
    MAX_TABLES: 50,
    MAX_ROUNDS: 10,
    MAX_ROUND_ENTRIES: 100,
    STATE_ID_MAX: 64,
    TABLE_NAME_MAX: 80,

    // The weekly cleanup deletes parties this many days after they expire.
    PURGE_GRACE_DAYS: 30,

    // Seconds a client should wait when the database is paused or waking up.
    DB_RETRY_AFTER_SECONDS: 30
});
