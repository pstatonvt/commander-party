'use strict';

// Host sign-in with a shared password.
//
// The password lives only in the HOST_PASSWORD app setting on the Static Web
// App: never in this repository and never sent to the browser. Entering it
// at POST /api/auth/login gets the browser a signed session cookie that
// lasts SESSION_DAYS. Page scripts can't read the cookie (HttpOnly), it is
// only sent over HTTPS (Secure), and never on requests started by other
// sites (SameSite=Strict).
//
// Sessions are signed with a key made from HOST_SESSION_SECRET and the
// password together, so changing HOST_PASSWORD signs every device out.

const crypto = require('node:crypto');
const { errorResponse } = require('./http');

const COOKIE_NAME = 'cp_host';
const SESSION_DAYS = 30;
const MIN_SECRET_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 200;
const MAX_TOKEN_LENGTH = 512;

// Every password holder is the same host, so parties are owned by one id.
function hostUserId() {
    return process.env.HOST_USER_ID || 'host';
}

// Returns the settings, or null when sign-in isn't set up (which turns host routes off).
function loginConfig() {
    const password = process.env.HOST_PASSWORD || '';
    const secret = process.env.HOST_SESSION_SECRET || '';
    if (!password || secret.length < MIN_SECRET_LENGTH) return null;
    return { password, secret };
}

function signingKey(config) {
    return crypto.createHmac('sha256', config.secret).update(`host-session:${config.password}`).digest();
}

function createSessionToken(now = Date.now()) {
    const config = loginConfig();
    if (!config) throw new Error('Host sign-in is not configured.');
    const payload = Buffer.from(JSON.stringify({ v: 1, exp: Math.floor(now / 1000) + SESSION_DAYS * 86400 })).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey(config)).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function verifySessionToken(token, now = Date.now()) {
    const config = loginConfig();
    if (!config || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const [payload, signature] = parts;

    const expected = crypto.createHmac('sha256', signingKey(config)).update(payload).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;

    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return !!data && data.v === 1 && Number.isFinite(data.exp) && data.exp * 1000 > now;
    } catch {
        return false;
    }
}

// Constant-time comparison, so response timing reveals nothing about the password.
function passwordMatches(candidate) {
    const config = loginConfig();
    if (!config || typeof candidate !== 'string' || !candidate || candidate.length > MAX_PASSWORD_LENGTH) return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(config.password).digest();
    return crypto.timingSafeEqual(a, b);
}

function readCookie(request, name) {
    const header = request.headers.get('cookie') || '';
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

function sessionCookie(token) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearedSessionCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function isHostRequest(request) {
    return verifySessionToken(readCookie(request, COOKIE_NAME));
}

// Returns { ok: true, principal } or { ok: false, response }.
function requireHost(request) {
    if (!loginConfig()) {
        return { ok: false, response: errorResponse(503, 'host_login_off', 'Host sign-in is not set up yet.') };
    }
    if (!isHostRequest(request)) {
        return { ok: false, response: errorResponse(401, 'sign_in_required', 'Enter the host password to manage parties.') };
    }
    return { ok: true, principal: { userId: hostUserId() } };
}

// ---------- Admin: the GitHub account invited in the Static Web App ----------
//
// Admin routes live under /api/manage/*, which staticwebapp.config.json only
// opens to these roles, so Azure rejects everyone else before the API runs.
// Azure signs the visitor in with GitHub and passes who they are in the
// x-ms-client-principal header; requireAdmin() checks the role again.
// "host" is accepted because that's the role the admin account was first
// invited with.

const ADMIN_ROLES = ['admin', 'host'];
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
            userDetails: String(parsed.userDetails || ''),
            roles: Array.isArray(parsed.userRoles) ? parsed.userRoles.map(String) : []
        };
    } catch {
        return null;
    }
}

function requireAdmin(request) {
    const principal = getPrincipal(request);
    if (!principal) {
        return { ok: false, response: errorResponse(401, 'sign_in_required', 'Sign in with the admin GitHub account.') };
    }
    if (!principal.roles.some(role => ADMIN_ROLES.includes(role))) {
        return { ok: false, response: errorResponse(403, 'not_admin', 'This account is not an admin.') };
    }
    return { ok: true, principal };
}

module.exports = {
    ADMIN_ROLES, getPrincipal, requireAdmin,
    COOKIE_NAME, SESSION_DAYS,
    hostUserId, loginConfig, createSessionToken, verifySessionToken, passwordMatches,
    readCookie, sessionCookie, clearedSessionCookie, isHostRequest, requireHost
};
