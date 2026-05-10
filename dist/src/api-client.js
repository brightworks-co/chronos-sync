import { MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, } from './types.js';
export class ApiPatAuthError extends Error {
    constructor() {
        super('PAT authentication failed (401)');
        this.name = 'ApiPatAuthError';
    }
}
/**
 * GET `/api/auto-upload/bootstrap` with `Authorization: Bearer <PAT>`. Honors
 * `If-None-Match: <etag>` when `opts.etag` is set; on 304 returns the prior
 * etag (echoed by the server) without a body. On 200 returns the parsed
 * payload + the response `ETag` header.
 *
 * Rejects with `ApiPatAuthError` on 401. 403/5xx/network failures throw
 * generic `Error` instances; PR6's bootstrap-resolver classifies them.
 */
export async function getBootstrap(opts, etag) {
    const { serverUrl, pat, timeoutMs = 10000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
    };
    if (etag)
        headers['If-None-Match'] = etag;
    let res;
    try {
        res = await fetch(`${serverUrl}/api/auto-upload/bootstrap`, {
            method: 'GET',
            headers,
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (res.status === 401) {
        throw new ApiPatAuthError();
    }
    if (res.status === 304) {
        const responseEtag = res.headers.get('etag') ?? etag ?? '';
        return { status: 304, etag: responseEtag };
    }
    if (!res.ok) {
        let detail = '';
        try {
            const errBody = (await res.json());
            if (errBody.error)
                detail = `: ${errBody.error}`;
        }
        catch {
            // body not JSON
        }
        const ra = res.headers.get('retry-after');
        const raSuffix = ra ? ` retry-after=${ra}` : '';
        throw new Error(`Bootstrap GET failed: HTTP ${res.status}${detail}${raSuffix}`);
    }
    const body = await res.json();
    const responseEtag = res.headers.get('etag') ?? '';
    return { status: 200, payload: validateBootstrapBody(body), etag: responseEtag };
}
/**
 * DELETE `/api/account/auto-upload/rooms/{project_id}/{room_name}` — clears
 * `auto_mac_uploader` for that room. Used by `chronos-sync auth --reset`
 * to release a previously claimed room before issuing a new PAT.
 *
 * Returns true on 200/204 and on 404 (already released — idempotent). Throws
 * `ApiPatAuthError` on 401 so the caller can degrade gracefully when the old
 * PAT is already revoked.
 */
export async function deleteAutoUploadRoom(opts, projectId, roomName) {
    const { serverUrl, pat, timeoutMs = 5000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${serverUrl}/api/account/auto-upload/rooms/` +
        `${encodeURIComponent(projectId)}/${encodeURIComponent(roomName)}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${pat}`,
                Accept: 'application/json',
            },
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (res.status === 401) {
        throw new ApiPatAuthError();
    }
    if (res.ok || res.status === 404)
        return;
    throw new Error(`Auto-upload room DELETE failed: HTTP ${res.status} (${projectId}/${roomName})`);
}
function validateBootstrapBody(body) {
    if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid bootstrap response: expected object');
    }
    const b = body;
    for (const k of ['server_url', 'user_email', 'etag', 'fetched_at']) {
        if (typeof b[k] !== 'string' || b[k].length === 0) {
            throw new Error(`Invalid bootstrap response: ${k} must be a non-empty string`);
        }
    }
    if (typeof b.interval_seconds !== 'number' ||
        !Number.isFinite(b.interval_seconds) ||
        b.interval_seconds < MIN_INTERVAL_SECONDS ||
        b.interval_seconds > MAX_INTERVAL_SECONDS) {
        throw new Error(`Invalid bootstrap response: interval_seconds must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
    }
    if (!Array.isArray(b.rooms)) {
        throw new Error('Invalid bootstrap response: rooms must be an array');
    }
    return {
        server_url: b.server_url,
        user_email: b.user_email,
        interval_seconds: b.interval_seconds,
        rooms: b.rooms,
        etag: b.etag,
        fetched_at: b.fetched_at,
    };
}
function validateBody(body) {
    if (typeof body !== 'object' || body === null) {
        throw new Error('Invalid response: expected object');
    }
    const b = body;
    if (typeof b.interval_seconds !== 'number' ||
        !Number.isFinite(b.interval_seconds) ||
        b.interval_seconds < MIN_INTERVAL_SECONDS ||
        b.interval_seconds > MAX_INTERVAL_SECONDS) {
        throw new Error(`Invalid response: interval_seconds must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
    }
    if (typeof b.updated_at !== 'string') {
        throw new Error('Invalid response: updated_at must be a string');
    }
    return { interval_seconds: b.interval_seconds, updated_at: b.updated_at };
}
export async function getSyncSettings(opts) {
    const { serverUrl, pat, timeoutMs = 5000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(`${serverUrl}/api/account/settings/sync`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${pat}`,
                Accept: 'application/json',
            },
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (res.status === 401) {
        throw new ApiPatAuthError();
    }
    if (!res.ok) {
        throw new Error(`Sync settings request failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    return validateBody(body);
}
export async function putSyncSettings(opts, intervalSeconds) {
    if (!Number.isFinite(intervalSeconds) ||
        intervalSeconds < MIN_INTERVAL_SECONDS ||
        intervalSeconds > MAX_INTERVAL_SECONDS) {
        throw new Error(`interval_seconds must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
    }
    const { serverUrl, pat, timeoutMs = 5000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(`${serverUrl}/api/account/settings/sync`, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${pat}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ interval_seconds: Math.floor(intervalSeconds) }),
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (res.status === 401) {
        throw new ApiPatAuthError();
    }
    if (!res.ok) {
        let detail = '';
        try {
            const errBody = (await res.json());
            if (errBody.error)
                detail = `: ${errBody.error}`;
        }
        catch {
            // body not JSON
        }
        throw new Error(`Sync settings PUT failed: HTTP ${res.status}${detail}`);
    }
    const body = await res.json();
    return validateBody(body);
}
