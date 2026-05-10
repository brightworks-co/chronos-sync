/**
 * Pretty console output for the foreground `chronos-sync` mode.
 *
 * The mental model is "open a terminal, see live status, close terminal
 * to stop". So output is conversational Korean, time-stamped, color-cued
 * (green ✓ for success / red ✗ for error). No JSONL — that stream is
 * available via `chronos-sync daemon` for log-aggregation pipelines.
 */
import type { DaemonConfig, RoomConfig } from './types.js';
import type { ResolvedInterval } from './interval-resolver.js';
export declare const ANSI: {
    readonly reset: "\u001B[0m";
    readonly green: "\u001B[32m";
    readonly red: "\u001B[31m";
    readonly yellow: "\u001B[33m";
    readonly dim: "\u001B[2m";
    readonly bold: "\u001B[1m";
};
export interface PrintHeaderInputs {
    config: DaemonConfig;
    configPath: string;
    version: string;
    resolved?: ResolvedInterval;
    /**
     * Auth-mode storage backend (`keychain` or `file`). Surfaced in the header
     * so the user can confirm at a glance which storage path is in effect.
     * Undefined in legacy-mode.
     */
    patStorage?: 'keychain' | 'file';
    /**
     * Pre-resolved bootstrap status label (e.g. `ok (3s ago)`, `stale (21h ago)`,
     * `refused (>24h)`, `missing`). When omitted, the renderer queries the
     * resolver directly. Tests can inject a fixed label for determinism.
     */
    bootstrapLabel?: string;
    /**
     * Tri-state override for the interval-prime probe. When omitted the renderer
     * derives this from `peekCachedSnapshot() != null`. Tests inject a literal
     * boolean for determinism. Auth-mode + `false` → render the
     * `서버에서 받아오는 중…` placeholder instead of the default interval.
     */
    bootstrapPrimed?: boolean;
}
/** Build the startup banner shown when foreground mode boots. */
export declare function formatHeader(inputs: PrintHeaderInputs): string;
export interface CycleLineInputs {
    room: RoomConfig;
    new_messages: number;
    error?: string;
    /** Wall-clock at the moment the cycle line is emitted. */
    now?: Date;
}
/**
 * Format a single per-room cycle result as a one-liner:
 *
 *   `21:38:05  ✓ ce3758/notice — 새 메시지 50개 업로드`
 *   `21:38:06  ✗ ce3758/notice — kakaocli exited with code 1`
 */
export declare function formatCycleLine(inputs: CycleLineInputs): string;
/** Closing line shown when the user hits Ctrl+C. */
export declare function formatShutdown(): string;
export interface ForegroundUi {
    printHeader: (cfg: DaemonConfig, resolved?: ResolvedInterval) => void;
    printCycleLine: (inputs: Omit<CycleLineInputs, 'now'>) => void;
    printShutdown: () => void;
    printWarning: (message: string) => void;
}
/**
 * Default foreground UI bound to `process.stdout`. Tests should build
 * their own `ForegroundUi` against an in-memory writer instead of
 * spying on stdout.
 */
export declare function createDefaultForegroundUi(): ForegroundUi;
