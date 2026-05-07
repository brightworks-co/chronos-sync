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
export declare function chronosDir(): string;
export declare function configPath(): string;
export declare function statePath(): string;
export declare function lockPath(): string;
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
