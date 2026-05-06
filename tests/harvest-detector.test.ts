import { describe, it, expect } from 'vitest'
import { detectHarvest } from '../src/harvest-detector'
import {
  DEFAULT_HARVEST_GAP_SECONDS,
  DEFAULT_HARVEST_STARTUP_SECONDS,
  DEFAULT_HARVEST_RATE_LIMIT_SECONDS,
  type DaemonConfig,
  type DaemonState,
  type RoomState,
} from '../src/types'

const baseConfig: DaemonConfig = {
  server_url: 'http://test',
  pat: 'chr_pat_' + 'a'.repeat(32),
  interval_seconds: 60,
  rooms: [],
}

function makeState(cycleIndex: number): DaemonState {
  return {
    rooms: {},
    daemon: {
      started_at: 0,
      last_cycle_at: 0,
      cycle_index: cycleIndex,
    },
  }
}

function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    last_synced_ms: 0,
    last_success_at: 0,
    consecutive_failures: 0,
    ...overrides,
  }
}

describe('detectHarvest', () => {
  const now = Date.UTC(2026, 3, 26, 12, 0, 0)

  it('scenario 1: cycle 1, last_synced_ms 25h ago → startup_old', () => {
    const lastSyncedMs = now - 25 * 3600 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(1),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 1,
    })
    expect(result.trigger).toBe(true)
    expect(result.reason).toBe('startup_old')
  })

  it('scenario 2: cycle 1, last_synced_ms 5h ago → no trigger (within startup window)', () => {
    const lastSyncedMs = now - 5 * 3600 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(1),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 1,
    })
    expect(result.trigger).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('scenario 3: cycle 2, last_synced_ms 13h ago → gap_exceeded', () => {
    const lastSyncedMs = now - 13 * 3600 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(2),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 2,
    })
    expect(result.trigger).toBe(true)
    expect(result.reason).toBe('gap_exceeded')
  })

  it('scenario 4: cycle 2, last_synced_ms 10h ago → no trigger (within gap)', () => {
    const lastSyncedMs = now - 10 * 3600 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(2),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 2,
    })
    expect(result.trigger).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('scenario 5: cycle 1, last_synced_ms 25h ago, last_harvest_at 10min ago → rate_limited_skip', () => {
    const lastSyncedMs = now - 25 * 3600 * 1000
    const lastHarvestAt = now - 10 * 60 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(1),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs, last_harvest_at: lastHarvestAt }),
      now,
      cycleIndex: 1,
    })
    expect(result.trigger).toBe(false)
    expect(result.reason).toBe('rate_limited_skip')
  })

  it('scenario 6: cycle 5, last_synced_ms 13h ago, last_harvest_at 35min ago → gap_exceeded (rate limit cleared)', () => {
    const lastSyncedMs = now - 13 * 3600 * 1000
    const lastHarvestAt = now - 35 * 60 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(5),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs, last_harvest_at: lastHarvestAt }),
      now,
      cycleIndex: 5,
    })
    expect(result.trigger).toBe(true)
    expect(result.reason).toBe('gap_exceeded')
  })

  it('scenario 7: cycle 1, last_synced_ms = 0 (never synced) → startup_old', () => {
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(1),
      roomState: makeRoomState({ last_synced_ms: 0 }),
      now,
      cycleIndex: 1,
    })
    expect(result.trigger).toBe(true)
    expect(result.reason).toBe('startup_old')
  })

  it('scenario 8: config.harvest override gap_seconds=3600, last_synced_ms 2h ago → gap_exceeded', () => {
    const cfg: DaemonConfig = {
      ...baseConfig,
      harvest: { gap_seconds: 3600 },
    }
    const lastSyncedMs = now - 2 * 3600 * 1000
    const result = detectHarvest({
      config: cfg,
      state: makeState(2),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 2,
    })
    expect(result.trigger).toBe(true)
    expect(result.reason).toBe('gap_exceeded')
  })

  it('uses DEFAULT_HARVEST_GAP_SECONDS when no config override', () => {
    // Exactly at the boundary (not exceeded)
    const lastSyncedMs = now - DEFAULT_HARVEST_GAP_SECONDS * 1000 + 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(2),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 2,
    })
    expect(result.trigger).toBe(false)
  })

  it('uses DEFAULT_HARVEST_STARTUP_SECONDS when no config override', () => {
    // last_synced_ms 1h ago: well within both startup (24h) and gap (12h) thresholds → no trigger
    const lastSyncedMs = now - 1 * 3600 * 1000
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(1),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs }),
      now,
      cycleIndex: 1,
    })
    expect(result.trigger).toBe(false)
  })

  it('uses DEFAULT_HARVEST_RATE_LIMIT_SECONDS when no config override', () => {
    // Just inside rate limit window → suppressed
    const lastSyncedMs = now - 25 * 3600 * 1000
    const lastHarvestAt = now - (DEFAULT_HARVEST_RATE_LIMIT_SECONDS * 1000 - 1000)
    const result = detectHarvest({
      config: baseConfig,
      state: makeState(1),
      roomState: makeRoomState({ last_synced_ms: lastSyncedMs, last_harvest_at: lastHarvestAt }),
      now,
      cycleIndex: 1,
    })
    expect(result.trigger).toBe(false)
    expect(result.reason).toBe('rate_limited_skip')
  })
})
