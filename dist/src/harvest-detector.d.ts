import { type DaemonConfig, type DaemonState, type RoomState, type HarvestThresholds } from './types.js';
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
/**
 * Compute the effective rate-limit floor by composing the user-configured rate limit
 * with an exponential backoff based on consecutive harvest failures.
 *
 * Backoff curve: 1800 * 2^min(failures, 4), capped at maxSeconds.
 * Effective = max(userRateLimit, backoff). Applies uniformly including cycle 1 (ADR 0007).
 */
export declare function composeRateLimit(userRateLimit: number, failures: number, baseSeconds?: number, maxSeconds?: number): number;
export type CycleHarvestSkipReason = 'no_stuck_rooms' | 'rate_limited' | 'backoff';
export type CycleHarvestDecision = {
    shouldHarvest: false;
    reason: CycleHarvestSkipReason;
} | {
    shouldHarvest: true;
    triggers: Array<{
        roomKey: string;
        reason: HarvestReason;
    }>;
};
export interface DecideCycleHarvestInputs {
    /** Per-room state map (keyed by `${project_id}:${room_name}`). */
    rooms: Record<string, RoomState>;
    /** Wall-clock epoch ms of the last daemon-scope harvestScroll spawn. 0 = never. */
    daemonLastHarvestAt: number;
    /** Consecutive harvestScroll non-zero exits since last success. */
    consecutiveHarvestFailures: number;
    /** Current wall-clock epoch ms. */
    now: number;
    /** Resolved harvest thresholds from config (may be undefined). */
    thresholds?: HarvestThresholds;
}
/**
 * Decide whether the daemon should run a single cycle-scope harvestScroll.
 *
 * 1. Gather per-room signals via detectHarvest (re-using room-scope logic).
 * 2. Apply daemon-scope rate-limit / backoff via composeRateLimit.
 * 3. Return { shouldHarvest: true, triggers } or { shouldHarvest: false, reason }.
 *
 * NOTE: this function needs a minimal DaemonConfig + DaemonState to call detectHarvest.
 * It builds synthetic wrappers from the flat inputs to avoid coupling callers to full state.
 */
export declare function decideCycleHarvest(inputs: DecideCycleHarvestInputs): CycleHarvestDecision;
export type { DaemonConfig, DaemonState, HarvestThresholds };
