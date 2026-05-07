/**
 * config.json + state.json + flock helpers for the Mac sync daemon.
 *
 * Filesystem layout under `~/.chronos`:
 *   config.json — user-managed daemon settings
 *   state.json — daemon-managed since-cursor + failure counters
 *   chronos-sync.lock — single-instance PID lock
 */
import { promises as fs } from 'node:fs';
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_DIR_NAME, CONFIG_FILE_NAME, STATE_FILE_NAME, LOCK_FILE_NAME, } from './constants.js';
import { DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, } from './types.js';
let maxPagesWarnEmitted = false;
/** Reset the max_pages deprecation warn guard. For use in tests only. */
export function resetMaxPagesWarnForTest() {
    maxPagesWarnEmitted = false;
}
export function chronosDir() {
    return join(homedir(), DAEMON_DIR_NAME);
}
export function configPath() {
    return join(chronosDir(), CONFIG_FILE_NAME);
}
export function statePath() {
    return join(chronosDir(), STATE_FILE_NAME);
}
export function lockPath() {
    return join(chronosDir(), LOCK_FILE_NAME);
}
export async function loadConfig() {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.server_url || typeof parsed.server_url !== 'string') {
        throw new Error('config.server_url missing or not a string');
    }
    if (!parsed.pat || typeof parsed.pat !== 'string' || !parsed.pat.startsWith('chr_pat_')) {
        throw new Error('config.pat missing or malformed (expected chr_pat_<32hex>)');
    }
    if (!Array.isArray(parsed.rooms) || parsed.rooms.length === 0) {
        throw new Error('config.rooms must be a non-empty array');
    }
    const normalizedRooms = parsed.rooms.map((room, i) => {
        const hasName = typeof room?.chat_name === 'string' && room.chat_name.length > 0;
        const normalizedChatId = normalizeChatId(room?.chat_id, i);
        if (!hasName && normalizedChatId === undefined) {
            throw new Error(`config.rooms[${i}] must have chat_name or chat_id`);
        }
        if (!room?.project_id || typeof room.project_id !== 'string') {
            throw new Error(`config.rooms[${i}].project_id missing or not a string`);
        }
        if (!room?.room_name || typeof room.room_name !== 'string') {
            throw new Error(`config.rooms[${i}].room_name missing or not a string`);
        }
        return { ...room, chat_id: normalizedChatId };
    });
    const interval = clampInterval(parsed.interval_seconds ?? DEFAULT_INTERVAL_SECONDS);
    const since = normalizeSinceOverride(parsed.since);
    const harvest = normalizeHarvestThresholds(parsed.harvest);
    return {
        server_url: parsed.server_url.replace(/\/+$/, ''),
        pat: parsed.pat,
        interval_seconds: interval,
        kakaocli_path: parsed.kakaocli_path,
        since,
        harvest,
        rooms: normalizedRooms,
    };
}
/**
 * Validate the optional `since` block in config.json. Either subfield is
 * optional but must be a non-negative finite number when present.
 */
function normalizeSinceOverride(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'object') {
        throw new Error('config.since must be an object when present');
    }
    const raw = value;
    const out = {};
    if (raw.multiplier !== undefined) {
        const m = raw.multiplier;
        if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) {
            throw new Error('config.since.multiplier must be a non-negative finite number');
        }
        out.multiplier = m;
    }
    if (raw.override_seconds !== undefined) {
        const o = raw.override_seconds;
        if (typeof o !== 'number' || !Number.isFinite(o) || o < 0) {
            throw new Error('config.since.override_seconds must be a non-negative finite number');
        }
        out.override_seconds = Math.floor(o);
    }
    return out;
}
function normalizeHarvestThresholds(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'object') {
        throw new Error('config.harvest must be an object when present');
    }
    const raw = value;
    const out = {};
    const intFields = [
        'gap_seconds',
        'startup_seconds',
        'rate_limit_seconds',
        'top',
        'max_clicks',
        'stuck_nudge_threshold',
        'harvest_failure_backoff_base_seconds',
        'harvest_failure_backoff_max_seconds',
    ];
    for (const k of intFields) {
        if (raw[k] !== undefined) {
            const v = raw[k];
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
                throw new Error(`config.harvest.${k} must be a non-negative finite number`);
            }
            out[k] = Math.floor(v);
        }
    }
    // scroll_delay is a float (seconds), not floored
    if (raw.scroll_delay !== undefined) {
        const v = raw.scroll_delay;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new Error('config.harvest.scroll_delay must be a non-negative finite number');
        }
        out.scroll_delay = v;
    }
    // max_pages: deprecated — read tolerated, emit one warn, then drop from output
    if (raw.max_pages !== undefined) {
        const v = raw.max_pages;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new Error('config.harvest.max_pages must be a non-negative finite number');
        }
        if (!maxPagesWarnEmitted) {
            maxPagesWarnEmitted = true;
            process.stderr.write('[chronos-sync] config.harvest.max_pages is deprecated and ignored. ' +
                'kakaocli 0.4.1 does not accept --max-pages. Use max_clicks instead.\n');
        }
        out.max_pages = Math.floor(v);
    }
    return out;
}
/**
 * Validate and normalize a `chat_id` to a numeric string.
 *
 * Returns `undefined` when the field is missing.
 *
 * Rules:
 *   - `string`: must match `/^[0-9]+$/`. Returned verbatim.
 *   - `number`: must be a non-negative `Number.isSafeInteger`. Numbers that
 *     overflow 2^53 - 1 are rejected because `JSON.parse` silently rounds
 *     them, which would route the daemon to the wrong room.
 *   - anything else throws.
 */
function normalizeChatId(value, index) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string') {
        if (!/^[0-9]+$/.test(value)) {
            throw new Error(`config.rooms[${index}].chat_id ${JSON.stringify(value)} is not a numeric string. ` +
                `Use a positive integer in JSON quoted form, e.g. "18296430865364356".`);
        }
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`config.rooms[${index}].chat_id is not a finite number`);
        }
        if (value < 0 || !Number.isSafeInteger(value)) {
            throw new Error(`config.rooms[${index}].chat_id ${value} exceeds Number.MAX_SAFE_INTEGER. ` +
                `JSON parsing may have truncated the value. Re-issue chat_id as a quoted JSON ` +
                `string (e.g., "chat_id": "18296430865364356") to preserve precision.`);
        }
        return String(value);
    }
    throw new Error(`config.rooms[${index}].chat_id must be a string or number (got ${typeof value})`);
}
export function clampInterval(n) {
    if (!Number.isFinite(n))
        return DEFAULT_INTERVAL_SECONDS;
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.floor(n)));
}
export function emptyState() {
    return {
        rooms: {},
        daemon: { started_at: Date.now(), last_cycle_at: 0, cycle_index: 0, last_harvest_at: 0 },
    };
}
export async function loadState() {
    try {
        const raw = await fs.readFile(statePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed.rooms || typeof parsed.rooms !== 'object')
            return emptyState();
        if (!parsed.daemon) {
            parsed.daemon = { started_at: Date.now(), last_cycle_at: 0, cycle_index: 0 };
        }
        // Forward-compat: 0.2.6 state files lack last_harvest_at; default to 0.
        if (parsed.daemon.last_harvest_at === undefined) {
            parsed.daemon.last_harvest_at = 0;
        }
        return parsed;
    }
    catch {
        return emptyState();
    }
}
export async function saveState(state) {
    const tmp = `${statePath()}.tmp`;
    await fs.mkdir(chronosDir(), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, statePath());
}
export function roomStateKey(projectId, roomName) {
    return `${projectId}:${roomName}`;
}
export function getRoomState(state, projectId, roomName) {
    const key = roomStateKey(projectId, roomName);
    return (state.rooms[key] ?? {
        last_synced_ms: 0,
        last_success_at: 0,
        consecutive_failures: 0,
        last_harvest_at: 0,
    });
}
export function setRoomState(state, projectId, roomName, next) {
    state.rooms[roomStateKey(projectId, roomName)] = next;
}
/**
 * Acquire a single-instance lock by writing the current PID to the lock file.
 *
 * Returns true when the lock is acquired (this process owns it) and false
 * when an active sibling process already holds it. A stale lock (the
 * recorded PID no longer points to a live process) is reclaimed.
 */
export function acquireLock() {
    const path = lockPath();
    if (existsSync(path)) {
        try {
            const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
            if (Number.isFinite(pid) && isPidAlive(pid)) {
                return false;
            }
        }
        catch {
            // unreadable lock file — treat as stale
        }
    }
    const fd = openSync(path, 'w');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
}
export function releaseLock() {
    const path = lockPath();
    try {
        if (existsSync(path)) {
            const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
            if (pid === process.pid) {
                // synchronous unlink so the SIGTERM handler completes before exit
                unlinkSync(path);
            }
        }
    }
    catch {
        // best effort
    }
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        const err = e;
        // EPERM means the process exists but is owned by another user → still alive.
        return err.code === 'EPERM';
    }
}
