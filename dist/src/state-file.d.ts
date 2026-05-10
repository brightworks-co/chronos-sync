/**
 * config + state.json + flock helpers for the Mac sync daemon.
 *
 * v0.6.0+: legacy `~/.chronos/config.json` (with embedded `pat`+`rooms`) is
 * no longer supported. The only supported entry point is `auth.json` +
 * `config.cache.json` (auth-mode), populated by `chronos-sync auth`.
 *
 * Filesystem layout under `~/.chronos`:
 *   auth.json          — non-secret PAT metadata (mode 0600)
 *   auth.token         — opt-in plaintext PAT (mode 0600), only when --allow-file-pat
 *   config.cache.json  — server-derived bootstrap snapshot (mode 0600)
 *   state.json         — daemon-managed since-cursor + failure counters
 *   chronos-sync.lock  — single-instance PID lock
 */
import { type DaemonConfig, type DaemonState, type RoomState } from './types.js';
/**
 * Thrown when `~/.chronos/auth.json` is absent.
 */
export declare class ConfigMissingError extends Error {
    constructor();
}
/**
 * Thrown when a v0.4.x `~/.chronos/config.json` (with embedded `pat` or
 * `rooms`) is detected. v0.6.0+ requires auth-mode; the daemon refuses
 * rather than silently ignoring legacy state.
 */
export declare class LegacyConfigDetectedError extends Error {
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
 * Load the active daemon config. v0.6.0+: auth-mode only.
 *
 * Precedence:
 *   1. auth.json present → synthesize DaemonConfig from auth.json + bootstrap cache.
 *   2. auth.json absent + legacy config.json present → throw `LegacyConfigDetectedError`.
 *   3. neither → throw `ConfigMissingError`.
 *
 * When the bootstrap cache is missing, the synthesized config returns with
 * `rooms: []` and `interval_seconds: DEFAULT_INTERVAL_SECONDS`. The daemon
 * uses the empty rooms list as a signal that it must call `primeBootstrap`
 * before cycling (NTH-4: bootstrap-unreachable + no cache → exit loud).
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
