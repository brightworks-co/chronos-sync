import { DEFAULT_HARVEST_GAP_SECONDS, DEFAULT_HARVEST_STARTUP_SECONDS, DEFAULT_HARVEST_RATE_LIMIT_SECONDS, DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS, DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS, } from './types.js';
/**
 * Decide whether harvest --scroll should run for this room this cycle.
 *
 * Check order:
 *   1. Rate limit: last_harvest_at within rate_limit_seconds → rate_limited_skip (no trigger)
 *   2. Startup: cycleIndex === 1 AND last_synced_ms older than startup_seconds → startup_old
 *   3. Gap: last_synced_ms older than gap_seconds → gap_exceeded
 *   4. Otherwise → null (no trigger)
 */
export function detectHarvest(inputs) {
    const { config, roomState, now, cycleIndex } = inputs;
    const thresholds = config.harvest ?? {};
    const gapSeconds = thresholds.gap_seconds ?? DEFAULT_HARVEST_GAP_SECONDS;
    const startupSeconds = thresholds.startup_seconds ?? DEFAULT_HARVEST_STARTUP_SECONDS;
    const rateLimitSeconds = thresholds.rate_limit_seconds ?? DEFAULT_HARVEST_RATE_LIMIT_SECONDS;
    const lastHarvestAt = roomState.last_harvest_at ?? 0;
    const lastSyncedMs = roomState.last_synced_ms;
    // Rate limit check: suppress trigger if harvested too recently
    if (lastHarvestAt > 0 && now - lastHarvestAt < rateLimitSeconds * 1000) {
        return { trigger: false, reason: 'rate_limited_skip' };
    }
    // Startup condition: first cycle and last sync is stale
    if (cycleIndex === 1 && now - lastSyncedMs > startupSeconds * 1000) {
        return { trigger: true, reason: 'startup_old' };
    }
    // Gap condition: last sync is beyond the gap threshold
    if (now - lastSyncedMs > gapSeconds * 1000) {
        return { trigger: true, reason: 'gap_exceeded' };
    }
    return { trigger: false, reason: null };
}
/**
 * Compute the effective rate-limit floor by composing the user-configured rate limit
 * with an exponential backoff based on consecutive harvest failures.
 *
 * Backoff curve: 1800 * 2^min(failures, 4), capped at maxSeconds.
 * Effective = max(userRateLimit, backoff). Applies uniformly including cycle 1 (ADR 0007).
 */
export function composeRateLimit(userRateLimit, failures, baseSeconds = DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS, maxSeconds = DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS) {
    const backoff = Math.min(baseSeconds * Math.pow(2, Math.min(failures, 4)), maxSeconds);
    return Math.max(userRateLimit, backoff);
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
export function decideCycleHarvest(inputs) {
    const { rooms, daemonLastHarvestAt, consecutiveHarvestFailures, now, thresholds } = inputs;
    const userRateLimit = thresholds?.rate_limit_seconds ?? DEFAULT_HARVEST_RATE_LIMIT_SECONDS;
    const baseSeconds = thresholds?.harvest_failure_backoff_base_seconds ?? DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS;
    const maxSeconds = thresholds?.harvest_failure_backoff_max_seconds ?? DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS;
    const effectiveRateLimit = composeRateLimit(userRateLimit, consecutiveHarvestFailures, baseSeconds, maxSeconds);
    // Daemon-scope rate-limit check
    if (daemonLastHarvestAt > 0 && now - daemonLastHarvestAt < effectiveRateLimit * 1000) {
        const reason = consecutiveHarvestFailures > 0 ? 'backoff' : 'rate_limited';
        return { shouldHarvest: false, reason };
    }
    // Collect per-room triggers using detectHarvest with a synthetic config/state
    const triggers = [];
    for (const [roomKey, roomState] of Object.entries(rooms)) {
        const gapSeconds = thresholds?.gap_seconds ?? DEFAULT_HARVEST_GAP_SECONDS;
        const startupSeconds = thresholds?.startup_seconds ?? DEFAULT_HARVEST_STARTUP_SECONDS;
        // Build minimal synthetic wrappers for detectHarvest
        const syntheticConfig = {
            server_url: '',
            pat: '',
            interval_seconds: 300,
            rooms: [],
            harvest: thresholds,
        };
        const syntheticState = {
            rooms: { [roomKey]: roomState },
            daemon: { started_at: 0, last_cycle_at: 0, cycle_index: 1 },
        };
        // Use room-level last_harvest_at for per-room signal (deprecated field, reader-only)
        const roomLastHarvest = roomState.last_harvest_at ?? 0;
        const decision = detectHarvest({
            config: syntheticConfig,
            state: syntheticState,
            roomState: { ...roomState, last_harvest_at: roomLastHarvest },
            now,
            cycleIndex: 1,
        });
        // Validate thresholds are used (silence unused var warnings)
        void gapSeconds;
        void startupSeconds;
        if (decision.trigger) {
            triggers.push({ roomKey, reason: decision.reason });
        }
    }
    if (triggers.length === 0) {
        return { shouldHarvest: false, reason: 'no_stuck_rooms' };
    }
    return { shouldHarvest: true, triggers };
}
