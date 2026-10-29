'use strict';

const crypto = require('node:crypto');

const BASE_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
});

function json(status, body, extraHeaders = {}) {
    return {
        status,
        headers: { ...BASE_HEADERS, ...extraHeaders },
        body: JSON.stringify(body)
    };
}

function errorResponse(status, code, message, extraHeaders = {}) {
    return json(status, { error: { code, message } }, extraHeaders);
}

// Reads and parses a JSON object body with a size cap.
// Returns { ok: true, value } or { ok: false, response }.
async function readJsonBody(request, maxBytes) {
    const contentType = request.headers.get('content-type') || '';
    if (!/^application\/json\b/i.test(contentType)) {
        return { ok: false, response: errorResponse(415, 'unsupported_media_type', 'Send the body as application/json.') };
    }

    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, response: errorResponse(413, 'body_too_large', `Body must be at most ${maxBytes} bytes.`) };
    }

    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { ok: false, response: errorResponse(413, 'body_too_large', `Body must be at most ${maxBytes} bytes.`) };
    }

    let value;
    try {
        value = JSON.parse(text);
    } catch {
        return { ok: false, response: errorResponse(400, 'invalid_json', 'Body is not valid JSON.') };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, response: errorResponse(400, 'invalid_body', 'Body must be a JSON object.') };
    }
    return { ok: true, value };
}

function stripPort(ip) {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
    if (bracketed) return bracketed[1];
    const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
    if (v4WithPort) return v4WithPort[1];
    return ip;
}

// Best-effort client IP for rate limiting. Static Web Apps sits behind Azure
// Front Door, which sets X-Azure-ClientIP itself; X-Forwarded-For is the
// fallback. A spoofed IP only dodges the per-IP join limit: the per-party
// player cap still holds no matter what.
function clientIp(request) {
    const direct = request.headers.get('x-azure-clientip') || request.headers.get('x-client-ip');
    const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0];
    const raw = (direct || forwarded || '').trim();
    return raw ? stripPort(raw) : 'unknown';
}

// Raw IPs are never stored; only a salted SHA-256.
function hashIp(ip) {
    const salt = process.env.IP_HASH_SALT || 'commander-party';
    return crypto.createHash('sha256').update(`${salt}|${ip}`).digest('hex');
}

module.exports = { json, errorResponse, readJsonBody, clientIp, hashIp };
