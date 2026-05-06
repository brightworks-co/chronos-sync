/**
 * Self-health checks for the persistent daemon (Plan 9 A-08).
 *
 * launchd `KeepAlive` restarts a process that exits with non-zero status,
 * so the daemon's recovery story is "exit hard, let launchd start me
 * fresh" rather than try to repair leaks in-place.
 */
import { type DaemonState } from './types.js';
export interface HealthVerdict {
    healthy: boolean;
    reason?: string;
}
/**
 * Decide whether the daemon should self-terminate so launchd can restart
 * it. Triggers:
 *   1. RSS exceeds 200 MB (memory leak)
 *   2. >1 hour since the last successful cycle (stuck)
 *   3. ≥5 consecutive failures on any one room (kakaocli or upload broken)
 */
export declare function checkHealth(state: DaemonState, now?: number): HealthVerdict;
