import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  primeIntervalCache,
  getCachedInterval,
  resetIntervalCacheForTest,
} from '../src/interval-resolver.js'
import * as apiClient from '../src/api-client.js'
import { ApiPatAuthError } from '../src/api-client.js'
import { DEFAULT_INTERVAL_SECONDS, type DaemonConfig } from '../src/types.js'

vi.mock('../src/api-client.js', () => ({
  getSyncSettings: vi.fn(),
  ApiPatAuthError: class ApiPatAuthError extends Error {
    constructor() {
      super('PAT authentication failed (401)')
      this.name = 'ApiPatAuthError'
    }
  },
}))

const log = vi.fn()

function makeConfig(interval_seconds = 120): DaemonConfig {
  return {
    server_url: 'https://chronos.example.com',
    pat: 'chr_pat_abc123',
    interval_seconds,
    rooms: [],
  }
}

beforeEach(() => {
  resetIntervalCacheForTest()
  vi.clearAllMocks()
})

describe('primeIntervalCache', () => {
  it('A4: populates the cache from a successful server fetch', async () => {
    vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({
      interval_seconds: 180,
      updated_at: '2026-05-08T00:00:00Z',
    })
    await primeIntervalCache(makeConfig(), log)
    const result = getCachedInterval(makeConfig(), log)
    expect(result.value).toBe(180)
    expect(result.source).toBe('cached')
  })

  it('A7: swallows network errors so the daemon boot path is fail-soft', async () => {
    vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    )
    await expect(primeIntervalCache(makeConfig(), log)).resolves.toBeUndefined()
    // Cache stays empty → getCachedInterval falls back to config.
    const result = getCachedInterval(makeConfig(90), log)
    expect(result.source).toBe('config')
    expect(result.value).toBe(90)
  })

  it('A7: swallows ApiPatAuthError', async () => {
    vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new ApiPatAuthError())
    await expect(primeIntervalCache(makeConfig(), log)).resolves.toBeUndefined()
    const result = getCachedInterval(makeConfig(45), log)
    expect(result.source).toBe('config')
    expect(result.value).toBe(45)
  })

  it('A8: deduplicates concurrent SIGHUP refreshes via in-flight mutex', async () => {
    let resolveFetch: (v: { interval_seconds: number; updated_at: string }) => void = () => {}
    vi.mocked(apiClient.getSyncSettings).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFetch = res
        })
    )
    const cfg = makeConfig()

    const p1 = primeIntervalCache(cfg, log)
    const p2 = primeIntervalCache(cfg, log)
    const p3 = primeIntervalCache(cfg, log)

    // All three callers received the same in-flight promise.
    expect(p1).toBe(p2)
    expect(p2).toBe(p3)

    resolveFetch({ interval_seconds: 200, updated_at: '2026-05-08T00:00:00Z' })
    await Promise.all([p1, p2, p3])

    expect(apiClient.getSyncSettings).toHaveBeenCalledTimes(1)
    const result = getCachedInterval(cfg, log)
    expect(result.value).toBe(200)
  })

  it('A8: a fresh prime after the previous one settles re-fetches', async () => {
    vi.mocked(apiClient.getSyncSettings)
      .mockResolvedValueOnce({ interval_seconds: 100, updated_at: 't1' })
      .mockResolvedValueOnce({ interval_seconds: 250, updated_at: 't2' })

    await primeIntervalCache(makeConfig(), log)
    expect(getCachedInterval(makeConfig(), log).value).toBe(100)

    await primeIntervalCache(makeConfig(), log)
    expect(apiClient.getSyncSettings).toHaveBeenCalledTimes(2)
    expect(getCachedInterval(makeConfig(), log).value).toBe(250)
  })
})

describe('getCachedInterval', () => {
  it('A4: returns the cached value with source=cached after a successful prime', async () => {
    vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({
      interval_seconds: 180,
      updated_at: 't',
    })
    await primeIntervalCache(makeConfig(), log)
    const result = getCachedInterval(makeConfig(), log)
    expect(result.source).toBe('cached')
    expect(result.value).toBe(180)
    expect(result.warning).toBeNull()
  })

  it('A7: falls back to config.interval_seconds when no cache exists', () => {
    const result = getCachedInterval(makeConfig(90), log)
    expect(result.source).toBe('config')
    expect(result.value).toBe(90)
    expect(result.warning).toContain('config bootstrap')
  })

  it('A7: falls back to DEFAULT_INTERVAL_SECONDS when neither cache nor config is available', () => {
    const result = getCachedInterval(makeConfig(0), log)
    expect(result.source).toBe('default')
    expect(result.value).toBe(DEFAULT_INTERVAL_SECONDS)
    expect(result.warning).toContain('default')
  })

  it('emits a stale warning when the cache is between 20h and 24h old', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-05-08T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({
        interval_seconds: 150,
        updated_at: 't',
      })
      await primeIntervalCache(makeConfig(), log)

      vi.setSystemTime(t0 + 21 * 3600 * 1000) // 21h later
      const result = getCachedInterval(makeConfig(), log)
      expect(result.source).toBe('cached')
      expect(result.value).toBe(150)
      expect(result.warning).toContain('20h')
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates the warning when the cache is at least 24h old', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-05-08T00:00:00Z').getTime()
      vi.setSystemTime(t0)
      vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({
        interval_seconds: 150,
        updated_at: 't',
      })
      await primeIntervalCache(makeConfig(), log)

      vi.setSystemTime(t0 + 25 * 3600 * 1000) // 25h later
      const result = getCachedInterval(makeConfig(), log)
      expect(result.source).toBe('cached')
      expect(result.value).toBe(150)
      expect(result.warning).toContain('24h')
      expect(result.warning).toContain('SIGHUP')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SIGHUP refresh integration (A6 — module-level)', () => {
  it('A6: a second prime call after settle picks up the new server value', async () => {
    vi.mocked(apiClient.getSyncSettings)
      .mockResolvedValueOnce({ interval_seconds: 60, updated_at: 'boot' })
      .mockResolvedValueOnce({ interval_seconds: 600, updated_at: 'after-hup' })

    // Boot prime.
    await primeIntervalCache(makeConfig(), log)
    expect(getCachedInterval(makeConfig(), log).value).toBe(60)

    // Operator runs `kill -HUP <pid>` → daemon SIGHUP handler primes again.
    await primeIntervalCache(makeConfig(), log)
    expect(getCachedInterval(makeConfig(), log).value).toBe(600)
  })
})

describe('resetIntervalCacheForTest', () => {
  it('clears the cached value and the in-flight promise', async () => {
    vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({
      interval_seconds: 99,
      updated_at: 't',
    })
    await primeIntervalCache(makeConfig(), log)
    expect(getCachedInterval(makeConfig(), log).source).toBe('cached')

    resetIntervalCacheForTest()
    expect(getCachedInterval(makeConfig(45), log).source).toBe('config')
  })
})
