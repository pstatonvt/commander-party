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

    // Seconds a client should wait when the database is paused or waking up.
    DB_RETRY_AFTER_SECONDS: 30
});
