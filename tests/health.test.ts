import { describe, it, expect } from 'vitest'
import { checkHealth } from '../src/health'
import { MAX_CONSECUTIVE_FAILURES, type DaemonState } from '../src/types'

function baseState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    rooms: {},
    daemon: { started_at: Date.now(), last_cycle_at: 0 },
    ...overrides,
  }
}

describe('checkHealth', () => {
  it('returns healthy when state is fresh and rooms are empty', () => {
    const verdict = checkHealth(baseState())
    expect(verdict.healthy).toBe(true)
  })

  it('returns unhealthy when a room exceeds the failure threshold', () => {
    const state = baseState({
      rooms: {
        'p1:room-a': {
          last_synced_ms: 0,
          last_success_at: 0,
          consecutive_failures: MAX_CONSECUTIVE_FAILURES,
        },
      },
    })
    const verdict = checkHealth(state)
    expect(verdict.healthy).toBe(false)
    expect(verdict.reason).toContain('p1:room-a')
  })

  it('returns unhealthy when the daemon has been stuck for more than an hour', () => {
    const now = Date.now()
    const state = baseState({
      daemon: {
        started_at: now - 2 * 60 * 60 * 1000,
        last_cycle_at: now - 2 * 60 * 60 * 1000,
      },
    })
    const verdict = checkHealth(state, now)
    expect(verdict.healthy).toBe(false)
    expect(verdict.reason).toContain('last cycle')
  })

  it('does not flag stuck before the daemon has run any cycle', () => {
    const verdict = checkHealth(baseState({ daemon: { started_at: 0, last_cycle_at: 0 } }))
    expect(verdict.healthy).toBe(true)
  })

  it('keeps a healthy verdict for a room well under the failure threshold', () => {
    const state = baseState({
      rooms: {
        'p1:room-a': {
          last_synced_ms: 0,
          last_success_at: 0,
          consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1,
        },
      },
    })
    expect(checkHealth(state).healthy).toBe(true)
  })
})
