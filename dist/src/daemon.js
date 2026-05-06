/**
 * chronos-sync persistent daemon (Plan 9 A-02 + A-06 + A-08).
 *
 * Lifecycle:
 *   1. Acquire single-instance lock at `~/.chronos/chronos-sync.lock`.
 *   2. Load config + state from `~/.chronos/{config,state}.json`.
 *   3. Loop on an internal `setInterval` (no launchd `StartInterval`):
 *      For each room: ask kakaocli for messages newer than the cursor,
 *      reassemble Mac CSV, parse via the shared dispatcher, upload to
 *      `/api/upload/init/chunk/finalize` with the PAT, advance the
 *      cursor only after a 200 from finalize.
 *   4. Self-terminate (exit 1) when the health checker says we are
 *      leaking, stuck, or repeatedly failing — launchd `KeepAlive`
 *      restarts a fresh process.
 *
 * Signals:
 *   SIGHUP  → reload config (next cycle picks it up; daemon does not
 *             need to drop the lock).
 *   SIGTERM → release lock + exit 0 cleanly.
 */
import { reassembleMacCsv } from './csv-reassemble.js';
import { listMessages, harvestScroll } from './kakaocli.js';
import { parseExport } from './parser/index.js';
import { resolveSenderNames } from './sender-resolver.js';
import { Uploader, UploadError } from './uploader.js';
import { checkHealth } from './health.js';
import { acquireLock, loadConfig, loadState, saveState, getRoomState, setRoomState, releaseLock, } from './state-file.js';
import { resolveInterval } from './interval-resolver.js';
import { DEFAULT_HARVEST_MAX_PAGES } from './types.js';
import { detectHarvest } from './harvest-detector.js';
/**
 * Run a single sync cycle for every configured room. Returns counters
 * so the caller can decide whether the cycle was healthy overall.
 *
 * `onRoom` (optional) is invoked exactly once per room after that
 * room's work finishes — success or failure — so foreground UIs can
 * stream a per-room status line without parsing the JSONL log stream.
 */
export async function runCycle(cfg, state, log = defaultLog, onRoom, onHarvest) {
    state.daemon.cycle_index += 1;
    const resolved = await resolveInterval(cfg, state, { now: Date.now, log });
    let uploaded_rooms = 0;
    let failed_rooms = 0;
    for (const room of cfg.rooms) {
        try {
            const newCount = await syncRoom(cfg, state, room, log, onHarvest);
            if (newCount > 0)
                uploaded_rooms += 1;
            onRoom?.({ room, new_messages: newCount });
        }
        catch (err) {
            failed_rooms += 1;
            const rs = getRoomState(state, room.project_id, room.room_name);
            setRoomState(state, room.project_id, room.room_name, {
                ...rs,
                consecutive_failures: rs.consecutive_failures + 1,
            });
            const message = err instanceof Error ? err.message : String(err);
            log('error', 'sync room failed', {
                chat_name: room.chat_name,
                chat_id: room.chat_id,
                room_name: room.room_name,
                error: message,
            });
            onRoom?.({ room, new_messages: 0, error: message });
        }
    }
    state.daemon.last_cycle_at = Date.now();
    await saveState(state);
    return { outcome: { uploaded_rooms, failed_rooms }, resolved };
}
/**
 * Compute the `--since` argument for a kakaocli call.
 *
 * Precedence:
 *   1. Cursor-based: if the room has a previously synced timestamp, use
 *      it directly (highest fidelity — never re-fetches messages we
 *      already accepted).
 *   2. Config override: `cfg.since.override_seconds` wins when set.
 *   3. Default fallback: `interval_seconds * (multiplier ?? 2)`. This
 *      covers the case where the daemon was offline for a stretch
 *      shorter than the multiplier window — we still pick up the gap.
 *
 * The first cycle (cursor 0, no override) returns `undefined` so
 * kakaocli emits its default backfill page. The next cycle is bounded
 * by the cursor.
 */
export function computeSince(cfg, cursor, now = Date.now()) {
    if (cursor.last_synced_ms > 0) {
        return new Date(cursor.last_synced_ms).toISOString();
    }
    const override = cfg.since?.override_seconds;
    if (override !== undefined) {
        if (override <= 0)
            return undefined;
        return new Date(now - override * 1000).toISOString();
    }
    const multiplier = cfg.since?.multiplier ?? 0;
    if (multiplier <= 0)
        return undefined;
    const seconds = Math.max(1, Math.floor(cfg.interval_seconds * multiplier));
    return new Date(now - seconds * 1000).toISOString();
}
async function syncRoom(cfg, state, room, log, onHarvest) {
    const cursor = getRoomState(state, room.project_id, room.room_name);
    const decision = detectHarvest({
        config: cfg,
        state,
        roomState: cursor,
        now: Date.now(),
        cycleIndex: state.daemon.cycle_index,
    });
    if (decision.trigger && (room.chat_name !== undefined || room.chat_id !== undefined)) {
        log('info', 'harvest --scroll triggered', {
            room_name: room.room_name,
            reason: decision.reason,
        });
        const harvest = await harvestScroll({
            chat: room.chat_id !== undefined ? undefined : room.chat_name,
            chatId: room.chat_id,
            binary: cfg.kakaocli_path,
            maxPages: cfg.harvest?.max_pages ?? DEFAULT_HARVEST_MAX_PAGES,
        });
        if (harvest.code !== 0) {
            log('warn', 'harvest --scroll non-zero exit (continuing)', {
                room_name: room.room_name,
                code: harvest.code,
                stderr: harvest.stderr.slice(0, 200),
            });
        }
        // mark last_harvest_at regardless of code (rate limit gates retries)
        setRoomState(state, room.project_id, room.room_name, {
            ...cursor,
            last_harvest_at: Date.now(),
        });
        onHarvest?.({ roomName: room.room_name, reason: decision.reason, code: harvest.code });
    }
    else if (decision.reason === 'rate_limited_skip') {
        log('info', 'harvest --scroll skipped (rate limited)', {
            room_name: room.room_name,
        });
        onHarvest?.({ roomName: room.room_name, reason: 'rate_limited_skip' });
    }
    // Re-read cursor after possible last_harvest_at update
    const updatedCursor = getRoomState(state, room.project_id, room.room_name);
    const since = computeSince(cfg, updatedCursor);
    const messages = await listMessages({
        chat: room.chat_id !== undefined ? undefined : room.chat_name,
        chatId: room.chat_id,
        since,
        binary: cfg.kakaocli_path,
    });
    if (messages.length === 0) {
        return 0;
    }
    // Client-side post-filter: kakaocli's `--since` argument is not honored —
    // the binary returns the most recent N messages regardless of the timestamp.
    // Without this guard every cycle re-uploads the same window as a dup-only
    // batch, polluting the project's upload history and wasting server hits.
    // Once kakaocli respects `--since` natively this guard becomes a no-op.
    const filtered = updatedCursor.last_synced_ms > 0
        ? messages.filter((m) => {
            const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp);
            return Number.isFinite(ts) && ts > updatedCursor.last_synced_ms;
        })
        : messages;
    if (filtered.length === 0) {
        return 0;
    }
    const enriched = await enrichSenders(filtered, cfg.kakaocli_path, log);
    // Reassemble CSV → parse so the server sees ParsedMessage[] with `kind`.
    const csv = reassembleMacCsv(enriched);
    const parsed = parseExport(csv);
    if (parsed.error) {
        throw new Error(`reassembled CSV failed to parse: ${parsed.error}`);
    }
    // Open chats use chat_id and have no stable display_name — fall back to
    // room_name as the upload anchor so /api/upload/init still receives a value.
    const anchor = room.kakao_original_name ?? room.chat_name ?? `chat-${room.chat_id ?? room.room_name}`;
    const uploader = new Uploader({ serverUrl: cfg.server_url, pat: cfg.pat });
    await uploader.uploadAll({
        project_id: room.project_id,
        room_name: room.room_name,
        kakao_original_name: anchor,
        total_chunks: 0, // populated by uploader.uploadAll
        total_messages: 0,
        file_name: `chronos-sync-${room.room_name}.csv`,
    }, parsed.messages, csv);
    // Advance the cursor only after finalize 200. The kakaocli timestamp is
    // either ms epoch or ISO; Date.parse handles both for the highest seen.
    // Use `filtered` so the cursor reflects only the messages we actually
    // uploaded — kakaocli emits older messages too (since-filter is broken).
    const lastTs = filtered.reduce((max, m) => {
        const t = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp);
        return Number.isFinite(t) && t > max ? t : max;
    }, updatedCursor.last_synced_ms);
    setRoomState(state, room.project_id, room.room_name, {
        ...updatedCursor,
        last_synced_ms: lastTs,
        last_success_at: Date.now(),
        consecutive_failures: 0,
    });
    log('info', 'sync room ok', {
        chat_name: room.chat_name,
        chat_id: room.chat_id,
        room_name: room.room_name,
        new_messages: filtered.length,
        raw_messages: messages.length,
    });
    return filtered.length;
}
/**
 * Resolve `sender: null` rows by querying the local KakaoTalk DB for
 * `sender_id → display_name`. Falls back to `참여자_<id>` only when the
 * SQL JOIN cannot find the user (e.g. ex-members purged from NTUser).
 *
 * Errors from `kakaocli query` (binary missing, permission denied, ...)
 * are logged but do not fail the cycle — we degrade to the fallback.
 */
export async function enrichSenders(messages, binary, log) {
    // Collect sender_ids that need a name lookup. Skip is_from_me rows —
    // those carry the local user's own name from kakaocli already.
    const needLookup = new Set();
    for (const m of messages) {
        if (m.sender !== null && m.sender !== undefined && m.sender.length > 0)
            continue;
        if (m.is_from_me)
            continue;
        if (typeof m.sender_id === 'number' && Number.isFinite(m.sender_id) && m.sender_id > 0) {
            needLookup.add(m.sender_id);
        }
    }
    let nameMap = new Map();
    if (needLookup.size > 0) {
        try {
            nameMap = await resolveSenderNames([...needLookup], { binary });
        }
        catch (err) {
            log('warn', 'sender resolver failed; falling back to 참여자_<id>', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return messages.map((m) => {
        if (m.sender !== null && m.sender !== undefined && m.sender.length > 0)
            return m;
        if (m.is_from_me)
            return { ...m, sender: m.sender ?? '나' };
        const key = String(m.sender_id);
        const resolved = nameMap.get(key);
        if (resolved !== undefined)
            return { ...m, sender: resolved };
        return { ...m, sender: `참여자_${m.sender_id}` };
    });
}
/**
 * Long-running entry point — the loop body shared by `daemon` (launchd
 * background) and the foreground `chronos-sync` invocation.
 *
 * The launchd path keeps `exit_on_health_failure: true` so the OS
 * restarts a leaky process; the foreground path keeps the loop alive
 * but logs the verdict so the user can decide what to do.
 */
export async function runLoop(options = {}) {
    if (!acquireLock()) {
        process.stderr.write('chronos-sync: another instance already running\n');
        process.exit(0);
    }
    const log = options.log ?? defaultLog;
    let cfg = await loadConfig();
    const state = await loadState();
    state.daemon.started_at = Date.now();
    process.on('SIGHUP', () => {
        void (async () => {
            try {
                cfg = await loadConfig();
                log('info', 'config reloaded via SIGHUP', {
                    interval_seconds: cfg.interval_seconds,
                    rooms: cfg.rooms.length,
                });
            }
            catch (err) {
                log('error', 'config reload failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        })();
    });
    let shuttingDown = false;
    const shutdown = (sig) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log('info', `received ${sig} — releasing lock and exiting`);
        releaseLock();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    while (!shuttingDown) {
        let resolved;
        try {
            const result = await runCycle(cfg, state, log, options.onRoom, options.onHarvest);
            resolved = result.resolved;
            options.onCycle?.(result.outcome, resolved);
        }
        catch (err) {
            log('error', 'cycle threw', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        const verdict = checkHealth(state);
        if (!verdict.healthy) {
            log('error', 'self-health check failed', { reason: verdict.reason });
            if (options.exit_on_health_failure) {
                releaseLock();
                process.exit(1);
            }
        }
        const sleepMs = resolved ? resolved.value * 1000 : cfg.interval_seconds * 1000;
        await sleep(sleepMs);
    }
}
/**
 * Background (launchd) entry point. Keeps the legacy `chronos-sync
 * daemon` semantics: hard-exit on health failure so launchd's
 * `KeepAlive` swaps in a fresh process.
 */
export async function main() {
    await runLoop({ exit_on_health_failure: true });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function defaultLog(level, msg, ctx) {
    const line = JSON.stringify({
        level,
        msg,
        ts: new Date().toISOString(),
        ctx: ctx ?? null,
    });
    if (level === 'error') {
        process.stderr.write(line + '\n');
    }
    else {
        process.stdout.write(line + '\n');
    }
}
// Re-export for tests + manual integration.
export { UploadError };
