import { describe, it, expect } from 'vitest'
import {
  composeRateLimit,
} from '../src/harvest-detector'
import {
  DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS,
  DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS,
} from '../src/types'

// T-13: composeRateLimit unit tests — AC-13 floor synthesis cases
describe('composeRateLimit', () => {
  it('AC-13: rate_limit=600, failures=0 → effective=1800 (backoff floor wins)', () => {
    expect(composeRateLimit(600, 0)).toBe(1800)
  })

  it('AC-13: rate_limit=600, failures=2 → effective=7200 (backoff wins)', () => {
    expect(composeRateLimit(600, 2)).toBe(7200)
  })

  it('user rate_limit larger than backoff is preserved', () => {
    // failures=0 → backoff=1800; user=3600 → max(3600,1800)=3600
    expect(composeRateLimit(3600, 0)).toBe(3600)
  })

  it('user rate_limit=0 + failures=0 → backoff floor=1800', () => {
    expect(composeRateLimit(0, 0)).toBe(1800)
  })

  it('large user rate_limit always preserved even with high failures', () => {
    // failures=5 → backoff=28800 (capped); user=50000 → max(50000,28800)=50000
    expect(composeRateLimit(50000, 5)).toBe(50000)
  })

  it('custom baseSeconds respected', () => {
    // base=900, failures=1 → 900*2=1800; user=0 → 1800
    expect(composeRateLimit(0, 1, 900, 86400)).toBe(1800)
  })

  it('custom maxSeconds cap respected', () => {
    // base=1800, failures=10 → uncapped would be huge; max=3600
    expect(composeRateLimit(0, 10, 1800, 3600)).toBe(3600)
  })
})

// T-11: backoff curve steps — AC-11
describe('composeRateLimit — backoff curve AC-11', () => {
  const base = DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS  // 1800
  const max = DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS    // 28800

  const cases: [number, number][] = [
    [0, 1800],
    [1, 3600],
    [2, 7200],
    [3, 14400],
    [4, 28800],
    [5, 28800],  // cap
  ]

  for (const [failures, expected] of cases) {
    it(`failures=${failures} → effective=${expected}`, () => {
      // user=0 so backoff wins unconditionally
      expect(composeRateLimit(0, failures, base, max)).toBe(expected)
    })
  }
})
