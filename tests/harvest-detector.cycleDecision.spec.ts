import { describe, it, expect } from 'vitest'
import { decideCycleHarvest } from '../src/harvest-detector'
import type { RoomState } from '../src/types'
import {
  DEFAULT_HARVEST_GAP_SECONDS,
  DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS,
  DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS,
} from '../src/types'

const NOW = 1_700_000_000_000

function freshRoom(overrides: Partial<RoomState> = {}): RoomState {
  return {
    last_synced_ms: NOW - 5 * 60 * 1000, // 5 min ago — healthy
    last_success_at: NOW - 5 * 60 * 1000,
    consecutive_failures: 0,
    ...overrides,
  }
}

function staleRoom(overrides: Partial<RoomState> = {}): RoomState {
  return {
    last_synced_ms: NOW - (DEFAULT_HARVEST_GAP_SECONDS + 1) * 1000, // beyond gap threshold
    last_success_at: 0,
    consecutive_failures: 0,
    ...overrides,
  }
}

// T-4: stuck=0 → no_stuck_rooms
describe('decideCycleHarvest — no stuck rooms', () => {
  it('returns no_stuck_rooms when all rooms are healthy', () => {
    const result = decideCycleHarvest({
      rooms: { 'p1:room-a': freshRoom(), 'p1:room-b': freshRoom() },
      daemonLastHarvestAt: 0,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(false)
    if (!result.shouldHarvest) expect(result.reason).toBe('no_stuck_rooms')
  })

  it('returns no_stuck_rooms with empty rooms map', () => {
    const result = decideCycleHarvest({
      rooms: {},
      daemonLastHarvestAt: 0,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(false)
    if (!result.shouldHarvest) expect(result.reason).toBe('no_stuck_rooms')
  })
})

describe('decideCycleHarvest — stuck rooms trigger harvest', () => {
  it('returns shouldHarvest=true with trigger list when a room is stale', () => {
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: 0,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(true)
    if (result.shouldHarvest) {
      expect(result.triggers).toHaveLength(1)
      expect(result.triggers[0].roomKey).toBe('p1:dho')
    }
  })

  it('includes all stuck rooms in trigger list', () => {
    const result = decideCycleHarvest({
      rooms: {
        'p1:room-a': staleRoom(),
        'p1:room-b': freshRoom(),
        'p1:room-c': staleRoom(),
      },
      daemonLastHarvestAt: 0,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(true)
    if (result.shouldHarvest) {
      expect(result.triggers).toHaveLength(2)
      const keys = result.triggers.map((t) => t.roomKey)
      expect(keys).toContain('p1:room-a')
      expect(keys).toContain('p1:room-c')
    }
  })
})

// T-6: rate-limit preservation — AC-6
describe('decideCycleHarvest — daemon-scope rate limit', () => {
  it('skips harvest when daemonLastHarvestAt is within effective rate limit', () => {
    // last harvest 10 min ago; default rate limit 1800s (30 min)
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: NOW - 10 * 60 * 1000,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(false)
    if (!result.shouldHarvest) expect(result.reason).toBe('rate_limited')
  })

  it('allows harvest when daemonLastHarvestAt is beyond rate limit', () => {
    // last harvest 31 min ago; default rate limit 30 min
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: NOW - 31 * 60 * 1000,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(true)
  })

  it('daemonLastHarvestAt=0 (never harvested) bypasses rate limit', () => {
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: 0,
      consecutiveHarvestFailures: 0,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(true)
  })
})

// T-8: backoff skip — AC-8
describe('decideCycleHarvest — backoff skip', () => {
  it('skips with reason=backoff when failures>0 and within backoff window', () => {
    // failures=1 → effective=max(1800,3600)=3600s; last harvest 1 hour ago = 3600s → boundary
    // use 3599s ago → still within
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: NOW - 3599 * 1000,
      consecutiveHarvestFailures: 1,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(false)
    if (!result.shouldHarvest) expect(result.reason).toBe('backoff')
  })

  it('allows harvest after backoff window expires', () => {
    // failures=1 → effective=3600s; last harvest 3601s ago → expired
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: NOW - 3601 * 1000,
      consecutiveHarvestFailures: 1,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(true)
  })

  it('AC-8: failures=2 backoff=7200s; 7199s ago → skip', () => {
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: NOW - 7199 * 1000,
      consecutiveHarvestFailures: 2,
      now: NOW,
    })
    expect(result.shouldHarvest).toBe(false)
    if (!result.shouldHarvest) expect(result.reason).toBe('backoff')
  })

  it('custom backoff thresholds respected', () => {
    const result = decideCycleHarvest({
      rooms: { 'p1:dho': staleRoom() },
      daemonLastHarvestAt: NOW - 500 * 1000,
      consecutiveHarvestFailures: 1,
      now: NOW,
      thresholds: {
        harvest_failure_backoff_base_seconds: 200,  // 200*2=400s for failures=1
        harvest_failure_backoff_max_seconds: DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS,
        rate_limit_seconds: 100,
      },
    })
    // effective = max(100, max(200*2^1, ...)) = max(100, 400) = 400s
    // last harvest 500s ago → 500 > 400 → should harvest
    expect(result.shouldHarvest).toBe(true)
  })
})
