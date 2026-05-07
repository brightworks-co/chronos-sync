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
import { type KakaoCliMessage } from './csv-reassemble.js';
import { UploadError } from './uploader.js';
import { type ResolvedInterval } from './interval-resolver.js';
import type { DaemonConfig, DaemonState, RoomConfig } from './types.js';
import { type HarvestReason } from './harvest-detector.js';
interface CycleOutcome {
    /** Number of rooms with new messages uploaded this cycle. */
    uploaded_rooms: number;
    /** Number of rooms whose cycle failed (kakaocli or HTTP). */
    failed_rooms: number;
}
export type DaemonLog = (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
export interface RoomCycleResult {
    room: RoomConfig;
    new_messages: number;
    error?: string;
}
/**
 * Optional callback fired once per room after the cycle finishes that
 * room's work (success or failure). Used by the foreground UI to print
 * one human-readable line per cycle without coupling to the JSONL log.
 */
export type RoomCycleListener = (result: RoomCycleResult) => void;
/**
 * Run a single sync cycle for every configured room. Returns counters
 * so the caller can decide whether the cycle was healthy overall.
 *
 * `onRoom` (optional) is invoked exactly once per room after that
 * room's work finishes — success or failure — so foreground UIs can
 * stream a per-room status line without parsing the JSONL log stream.
 */
export declare function runCycle(cfg: DaemonConfig, state: DaemonState, log?: DaemonLog, onRoom?: RoomCycleListener, onHarvest?: RunOptions['onHarvest']): Promise<{
    outcome: CycleOutcome;
    resolved: ResolvedInterval;
}>;
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
export declare function computeSince(cfg: DaemonConfig, cursor: {
    last_synced_ms: number;
}, now?: number): string | undefined;
/**
 * Resolve `sender: null` rows by querying the local KakaoTalk DB for
 * `sender_id → display_name`. Falls back to `참여자_<id>` only when the
 * SQL JOIN cannot find the user (e.g. ex-members purged from NTUser).
 *
 * Errors from `kakaocli query` (binary missing, permission denied, ...)
 * are logged but do not fail the cycle — we degrade to the fallback.
 */
export declare function enrichSenders(messages: KakaoCliMessage[], binary: string | undefined, log: DaemonLog): Promise<KakaoCliMessage[]>;
export interface RunOptions {
    /**
     * Override for the JSONL log writer. When omitted the daemon uses
     * structured stdout/stderr writes; foreground callers replace this
     * with a quieter logger so the pretty per-cycle line is the primary
     * stdout stream.
     */
    log?: DaemonLog;
    /**
     * Per-room cycle listener. Foreground callers use it to print one
     * human-readable line per room per cycle; the launchd loop leaves it
     * undefined.
     */
    onRoom?: RoomCycleListener;
    /**
     * Called once after every cycle completes (after `runCycle` returns
     * but before the sleep + health check). Used by foreground UIs to
     * stream a "cycle finished, sleeping N s" footer.
     */
    onCycle?: (outcome: CycleOutcome, resolvedInterval?: ResolvedInterval) => void;
    /**
     * When true the loop exits cleanly on health-check failure rather
     * than calling `process.exit(1)`. Foreground mode opts in so the
     * user sees a friendly farewell line; launchd mode keeps the exit
     * so KeepAlive recycles the process.
     */
    exit_on_health_failure?: boolean;
    /**
     * Called when a harvest --scroll is triggered or skipped (rate limited).
     * Foreground UIs use this to surface harvest events to the user.
     */
    onHarvest?: (info: {
        roomName: string;
        reason: HarvestReason;
        code?: number;
    }) => void;
    /**
     * When true the loop spawns `caffeinate -i -w <pid>` on darwin so macOS
     * does not idle-sleep while the daemon is running. The launchd path
     * leaves this off (launchd controls wake/sleep itself); the foreground
     * `chronos-sync` invocation opts in.
     *
     * Skipped on non-darwin hosts and when `CHRONOS_NO_CAFFEINATE=1` is set.
     */
    foreground?: boolean;
}
/**
 * Long-running entry point — the loop body shared by `daemon` (launchd
 * background) and the foreground `chronos-sync` invocation.
 *
 * The launchd path keeps `exit_on_health_failure: true` so the OS
 * restarts a leaky process; the foreground path keeps the loop alive
 * but logs the verdict so the user can decide what to do.
 */
export declare function runLoop(options?: RunOptions): Promise<void>;
/**
 * Background (launchd) entry point. Keeps the legacy `chronos-sync
 * daemon` semantics: hard-exit on health failure so launchd's
 * `KeepAlive` swaps in a fresh process.
 */
export declare function main(): Promise<void>;
export { UploadError };
