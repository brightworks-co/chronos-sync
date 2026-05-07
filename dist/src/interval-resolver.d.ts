import { type DaemonConfig, type IntervalSource } from './types.js';
export interface ResolvedInterval {
    value: number;
    source: IntervalSource;
    fetched_at: string;
    /** Visible warning to surface in foreground header. null if no warning. */
    warning: string | null;
}
type LogFn = (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
/**
 * Fetch the current interval from the server and update the in-process
 * cache. Never throws — fetch failures (network, 401, abort, parse) are
 * swallowed and logged so the daemon boot path is fail-soft (callers
 * may `await` without a try/catch).
 *
 * Concurrent calls share the same in-flight promise (mutex), so two
 * SIGHUP signals in quick succession produce exactly one HTTP fetch.
 */
export declare function primeIntervalCache(cfg: DaemonConfig, log: LogFn): Promise<void>;
/**
 * Synchronous read of the cached interval. Returns a `ResolvedInterval`
 * shape so callers (foreground UI header, daemon log) can render the
 * source/warning consistently with previous releases.
 *
 * Source precedence:
 *   1. cache (any age) when primed
 *   2. `cfg.interval_seconds` when set
 *   3. `DEFAULT_INTERVAL_SECONDS` as last resort
 *
 * cache age >= 20h adds a stale warning. cache age >= 24h still uses
 * the cached value but escalates the warning text — operators on
 * launchd (no foreground header) only see this in the JSONL log.
 */
export declare function getCachedInterval(cfg: DaemonConfig, log: LogFn): ResolvedInterval;
/**
 * Reset the module-level cache state. Tests must call this in
 * `beforeEach` so cached state from a previous case does not leak.
 */
export declare function resetIntervalCacheForTest(): void;
export {};
