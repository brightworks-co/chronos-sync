import { type DaemonConfig, type DaemonState, type RoomState } from './types.js';
export type HarvestReason = 'startup_old' | 'gap_exceeded' | 'rate_limited_skip' | null;
export interface HarvestDecision {
    trigger: boolean;
    reason: HarvestReason;
}
export interface DetectInputs {
    config: DaemonConfig;
    state: DaemonState;
    roomState: RoomState;
    now: number;
    cycleIndex: number;
}
/**
 * Decide whether harvest --scroll should run for this room this cycle.
 *
 * Check order:
 *   1. Rate limit: last_harvest_at within rate_limit_seconds → rate_limited_skip (no trigger)
 *   2. Startup: cycleIndex === 1 AND last_synced_ms older than startup_seconds → startup_old
 *   3. Gap: last_synced_ms older than gap_seconds → gap_exceeded
 *   4. Otherwise → null (no trigger)
 */
export declare function detectHarvest(inputs: DetectInputs): HarvestDecision;
