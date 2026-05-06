import { MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, } from './types.js';
export class ApiPatAuthError extends Error {
    constructor() {
        super('PAT authentication failed (401)');
        this.name = 'ApiPatAuthError';
    }
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
