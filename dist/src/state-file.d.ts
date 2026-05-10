/**
 * config.json + state.json + flock helpers for the Mac sync daemon.
 *
 * Filesystem layout under `~/.chronos`:
 *   config.json — user-managed daemon settings
 *   state.json — daemon-managed since-cursor + failure counters
 *   chronos-sync.lock — single-instance PID lock
 */
import { type DaemonConfig, type DaemonState, type RoomState } from './types.js';
/** Reset the max_pages deprecation warn guard. For use in tests only. */
export declare function resetMaxPagesWarnForTest(): void;
/** Reset the v0.6.0 legacy deprecation banner guard. For use in tests only. */
export declare function resetLegacyDeprecationBannerForTest(): void;
/**
 * Thrown when neither `~/.chronos/auth.json` nor `~/.chronos/config.json`
 * exists. Surfaces an actionable recovery message linking to the install
 * page so launchd's KeepAlive doesn't loop without context.
 */
export declare class ConfigMissingError extends Error {
    constructor();
}
/**
 * Thrown when both `~/.chronos/auth.json` AND a legacy `~/.chronos/config.json`
 * with embedded credentials/rooms are present. PR5's auth-time precondition
 * usually prevents this state; this is the defensive sibling check that fires
 * if the user fiddled manually.
 */
export declare class ConfigConflictError extends Error {
    constructor();
}
/**
 * Thrown when auth.json declares `pat_storage: 'keychain'` but the Keychain
 * lookup returns null (entry missing) — the user must re-run `chronos-sync
 * auth`. Distinct error class so the daemon can match it precisely.
 */
export declare class AuthCredentialMissingError extends Error {
    constructor(detail: string);
}
export declare function chronosDir(): string;
export declare function configPath(): string;
export declare function statePath(): string;
export declare function lockPath(): string;
/**
 * 4-branch precedence rule (PR6 of auto-upload-server-driven-config plan):
 *
 *   (1) auth.json present + (no legacy config.json OR legacy without embedded
 *       creds/rooms) → AUTH-MODE: read auth.json + bootstrap cache.
 *   (2) auth.json present + legacy config.json with embedded creds/rooms →
 *       defensive REFUSE (PR5 precondition usually prevents this).
 *   (3) legacy config.json only → LEGACY-MODE with one-shot deprecation banner.
 *   (4) neither → ConfigMissingError.
 *
 * Branch 1 returns a synthesized DaemonConfig. When the bootstrap cache is
 * absent (auth.json present but `chronos-sync` never ran successfully against
 * a reachable server post-auth), the config returns with `rooms: []` and
 * `interval_seconds: DEFAULT_INTERVAL_SECONDS`. The daemon uses the empty
 * rooms list as a signal that it must call `primeBootstrap` before cycling.
 */
export declare function loadConfig(): Promise<DaemonConfig>;
export declare function clampInterval(n: number): number;
export declare function emptyState(): DaemonState;
export declare function loadState(): Promise<DaemonState>;
export declare function saveState(state: DaemonState): Promise<void>;
export declare function roomStateKey(projectId: string, roomName: string): string;
export declare function getRoomState(state: DaemonState, projectId: string, roomName: string): RoomState;
export declare function setRoomState(state: DaemonState, projectId: string, roomName: string, next: RoomState): void;
/**
 * Acquire a single-instance lock by writing the current PID to the lock file.
 *
 * Returns true when the lock is acquired (this process owns it) and false
 * when an active sibling process already holds it. A stale lock (the
 * recorded PID no longer points to a live process) is reclaimed.
 */
export declare function acquireLock(): boolean;
export declare function releaseLock(): void;
