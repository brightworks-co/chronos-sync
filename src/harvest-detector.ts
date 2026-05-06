import {
  DEFAULT_HARVEST_GAP_SECONDS,
  DEFAULT_HARVEST_STARTUP_SECONDS,
  DEFAULT_HARVEST_RATE_LIMIT_SECONDS,
  type DaemonConfig,
  type DaemonState,
  type RoomState,
} from './types.js'

export type HarvestReason =
  | 'startup_old'
  | 'gap_exceeded'
  | 'rate_limited_skip'
  | null

export interface HarvestDecision {
  trigger: boolean
  reason: HarvestReason
}

export interface DetectInputs {
  config: DaemonConfig
  state: DaemonState
  roomState: RoomState
  now: number
  cycleIndex: number
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
export function detectHarvest(inputs: DetectInputs): HarvestDecision {
  const { config, roomState, now, cycleIndex } = inputs
  const thresholds = config.harvest ?? {}

  const gapSeconds = thresholds.gap_seconds ?? DEFAULT_HARVEST_GAP_SECONDS
  const startupSeconds = thresholds.startup_seconds ?? DEFAULT_HARVEST_STARTUP_SECONDS
  const rateLimitSeconds = thresholds.rate_limit_seconds ?? DEFAULT_HARVEST_RATE_LIMIT_SECONDS

  const lastHarvestAt = roomState.last_harvest_at ?? 0
  const lastSyncedMs = roomState.last_synced_ms

  // Rate limit check: suppress trigger if harvested too recently
  if (lastHarvestAt > 0 && now - lastHarvestAt < rateLimitSeconds * 1000) {
    return { trigger: false, reason: 'rate_limited_skip' }
  }

  // Startup condition: first cycle and last sync is stale
  if (cycleIndex === 1 && now - lastSyncedMs > startupSeconds * 1000) {
    return { trigger: true, reason: 'startup_old' }
  }

  // Gap condition: last sync is beyond the gap threshold
  if (now - lastSyncedMs > gapSeconds * 1000) {
    return { trigger: true, reason: 'gap_exceeded' }
  }

  return { trigger: false, reason: null }
}
