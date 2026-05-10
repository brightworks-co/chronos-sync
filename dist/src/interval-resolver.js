import { getSyncSettings } from './api-client.js';
import { DEFAULT_INTERVAL_SECONDS } from './types.js';
const FETCH_TIMEOUT_MS = 5000;
const MAX_CACHE_AGE_MS = 24 * 3600 * 1000;
const STALE_WARN_AGE_MS = 20 * 3600 * 1000;
let cached = null;
let inFlight = null;
/**
 * Fetch the current interval from the server and update the in-process
 * cache. Never throws — fetch failures (network, 401, abort, parse) are
 * swallowed and logged so the daemon boot path is fail-soft (callers
 * may `await` without a try/catch).
 *
 * Concurrent calls share the same in-flight promise (mutex), so two
 * SIGHUP signals in quick succession produce exactly one HTTP fetch.
 */
export function primeIntervalCache(cfg, log) {
    // Note: not declared `async`. We need every concurrent caller to receive
    // the *same* promise reference (the in-flight mutex), and an outer
    // `async` wrapper would create a fresh wrapper promise per call.
    if (inFlight)
        return inFlight;
    inFlight = (async () => {
        try {
            const remote = await getSyncSettings({
                serverUrl: cfg.server_url,
                pat: cfg.pat,
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            cached = {
                value: remote.interval_seconds,
                fetched_at: new Date().toISOString(),
            };
            log('info', 'interval cache primed', {
                interval_seconds: remote.interval_seconds,
            });
        }
        catch (err) {
            log('warn', 'interval prime failed; falling back to config/default', {
                error: err instanceof Error ? err.message : String(err),
            });
            // SWALLOW — never propagate.
        }
    })().finally(() => {
        inFlight = null;
    });
    return inFlight;
}
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
export function getCachedInterval(cfg, log) {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    if (cached) {
        const age = nowMs - Date.parse(cached.fetched_at);
        let warning = null;
        if (age >= MAX_CACHE_AGE_MS) {
            warning = 'cache stale (≥24h) — auto-refresh triggered';
            log('warn', 'interval cache exceeded MAX_CACHE_AGE; using last value', {
                age_ms: age,
            });
            // Self-heal in launchd-style background daemons that have no foreground
            // SIGHUP path. Fire-and-forget; the in-flight mutex in primeIntervalCache
            // dedupes concurrent stale reads, and the next call returns fresh value.
            void primeIntervalCache(cfg, log);
        }
        else if (age >= STALE_WARN_AGE_MS) {
            warning = 'cache stale (≥20h)';
        }
        return {
            value: cached.value,
            source: 'cached',
            fetched_at: cached.fetched_at,
            warning,
        };
    }
    if (cfg.interval_seconds) {
        return {
            value: cfg.interval_seconds,
            source: 'config',
            fetched_at: nowIso,
            warning: 'config bootstrap 사용',
        };
    }
    return {
        value: DEFAULT_INTERVAL_SECONDS,
        source: 'default',
        fetched_at: nowIso,
        warning: 'default 회귀 (모든 단계 실패)',
    };
}
/**
 * Reset the module-level cache state. Tests must call this in
 * `beforeEach` so cached state from a previous case does not leak.
 */
export function resetIntervalCacheForTest() {
    cached = null;
    inFlight = null;
}
