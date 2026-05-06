/**
 * Self-health checks for the persistent daemon (Plan 9 A-08).
 *
 * launchd `KeepAlive` restarts a process that exits with non-zero status,
 * so the daemon's recovery story is "exit hard, let launchd start me
 * fresh" rather than try to repair leaks in-place.
 */
import { MAX_CONSECUTIVE_FAILURES, MAX_RSS_BYTES, STUCK_THRESHOLD_MS, } from './types.js';
/**
 * Decide whether the daemon should self-terminate so launchd can restart
 * it. Triggers:
 *   1. RSS exceeds 200 MB (memory leak)
 *   2. >1 hour since the last successful cycle (stuck)
 *   3. ≥5 consecutive failures on any one room (kakaocli or upload broken)
 */
export function checkHealth(state, now = Date.now()) {
    const rss = process.memoryUsage().rss;
    if (rss > MAX_RSS_BYTES) {
        return { healthy: false, reason: `RSS ${rss} > ${MAX_RSS_BYTES}` };
    }
    // Skip the stuck check until the daemon has actually had a chance to run
    // a cycle (avoid restarting a freshly-started process).
    if (state.daemon.last_cycle_at > 0 && now - state.daemon.last_cycle_at > STUCK_THRESHOLD_MS) {
        return {
            healthy: false,
            reason: `last cycle ${now - state.daemon.last_cycle_at} ms ago > ${STUCK_THRESHOLD_MS}`,
        };
    }
    for (const [key, room] of Object.entries(state.rooms)) {
        if (room.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
            return {
                healthy: false,
                reason: `room ${key} has ${room.consecutive_failures} consecutive failures`,
            };
        }
    }
    return { healthy: true };
}
