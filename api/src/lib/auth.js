'use strict';

// Reads the signed-in user that Static Web Apps passes to the API.
//
// SWA authenticates the visitor and forwards their identity in the
// x-ms-client-principal header (base64 JSON). Managed functions are only
// reachable through SWA, which sets this header itself, so it can be trusted.
// The `host` role is already enforced by staticwebapp.config.json; checking it
// again here means a routing mistake can't open the host API.

const { errorResponse } = require('./http');

const HOST_ROLE = 'host';
const USER_ID_MAX = 128;

function getPrincipal(request) {
    const header = request.headers.get('x-ms-client-principal');
    if (!header) return null;
    try {
        const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        if (!parsed || typeof parsed.userId !== 'string') return null;
        const userId = parsed.userId.trim();
        if (!userId || userId.length > USER_ID_MAX) return null;
        return {
            userId,
            identityProvider: String(parsed.identityProvider || ''),
            userDetails: String(parsed.userDetails || ''),
            roles: Array.isArray(parsed.userRoles) ? parsed.userRoles.map(String) : []
        };
    } catch {
        return null;
    }
}

// Returns { ok: true, principal } or { ok: false, response }.
function requireHost(request) {
    const principal = getPrincipal(request);
    if (!principal) {
        return { ok: false, response: errorResponse(401, 'sign_in_required', 'Sign in to manage parties.') };
    }
    if (!principal.roles.includes(HOST_ROLE)) {
        return { ok: false, response: errorResponse(403, 'not_host', 'This account is not allowed to host parties.') };
    }
    return { ok: true, principal };
}

module.exports = { getPrincipal, requireHost, HOST_ROLE };
