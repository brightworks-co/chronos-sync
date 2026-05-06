import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveInterval } from '../src/interval-resolver.js'
import * as apiClient from '../src/api-client.js'
import { ApiPatAuthError } from '../src/api-client.js'
import { DEFAULT_INTERVAL_SECONDS, type DaemonConfig, type DaemonState } from '../src/types.js'

vi.mock('../src/api-client.js', () => ({
  getSyncSettings: vi.fn(),
  ApiPatAuthError: class ApiPatAuthError extends Error {
    constructor() {
      super('PAT authentication failed (401)')
      this.name = 'ApiPatAuthError'
    }
  },
}))

const BASE_NOW = 1_000_000_000_000

function makeConfig(interval_seconds = 120): DaemonConfig {
  return {
    server_url: 'https://chronos.example.com',
    pat: 'chr_pat_abc123',
    interval_seconds,
    rooms: [],
  }
}

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    rooms: {},
    daemon: { started_at: BASE_NOW, last_cycle_at: BASE_NOW, cycle_index: 0 },
    ...overrides,
  }
}

const noop = () => {}
const log = vi.fn()

const deps = { now: () => BASE_NOW, log }

beforeEach(() => {
  vi.clearAllMocks()
})

// 1. 정상 fetch → source='server', warning null, cache 갱신
it('scenario 1: successful fetch returns server source with null warning', async () => {
  vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({ interval_seconds: 180, updated_at: '2026-01-01T00:00:00Z' })
  const state = makeState()
  const result = await resolveInterval(makeConfig(), state, deps)
  expect(result.source).toBe('server')
  expect(result.value).toBe(180)
  expect(result.warning).toBeNull()
  expect(state.interval_cache?.value).toBe(180)
  expect(state.interval_cache?.consecutive_failures).toBe(0)
  expect(state.interval_cache?.skip_until_cycle).toBe(0)
})

// 2. 401 → source='cached' (cache 있음), warning includes 'PAT'
it('scenario 2: 401 with cache returns cached source and PAT warning', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new ApiPatAuthError())
  const cachedAt = new Date(BASE_NOW - 1000).toISOString()
  const state = makeState({
    interval_cache: { value: 200, fetched_at: cachedAt, source: 'server', consecutive_failures: 0, skip_until_cycle: 0 },
  })
  const result = await resolveInterval(makeConfig(), state, deps)
  expect(result.source).toBe('cached')
  expect(result.value).toBe(200)
  expect(result.warning).toContain('PAT')
  // consecutive_failures must NOT be incremented for 401
  expect(state.interval_cache?.consecutive_failures).toBe(0)
})

// 3. 401 + cache 없음 → source='config', warning includes 'PAT' + 'config'
it('scenario 3: 401 without cache falls back to config', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new ApiPatAuthError())
  const state = makeState()
  const result = await resolveInterval(makeConfig(90), state, deps)
  expect(result.source).toBe('config')
  expect(result.value).toBe(90)
  expect(result.warning).toContain('PAT')
})

// 4. 500 1회 → source='cached', failures=1, skip_until_cycle=0
it('scenario 4: single generic failure increments failures without opening circuit', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new Error('HTTP 500'))
  const cachedAt = new Date(BASE_NOW - 1000).toISOString()
  const state = makeState({
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 0, skip_until_cycle: 0 },
  })
  const result = await resolveInterval(makeConfig(), state, deps)
  expect(result.source).toBe('cached')
  expect(state.interval_cache?.consecutive_failures).toBe(1)
  expect(state.interval_cache?.skip_until_cycle).toBe(0)
})

// 5. 500 3회 연속 → 3회차에서 circuit open: skip_until_cycle = cycle_index + 5
it('scenario 5: three consecutive failures open the circuit breaker', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValue(new Error('HTTP 500'))
  const cachedAt = new Date(BASE_NOW - 1000).toISOString()
  const state = makeState({
    daemon: { started_at: BASE_NOW, last_cycle_at: BASE_NOW, cycle_index: 10 },
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 0, skip_until_cycle: 0 },
  })

  // 1st failure
  await resolveInterval(makeConfig(), state, deps)
  expect(state.interval_cache?.consecutive_failures).toBe(1)
  expect(state.interval_cache?.skip_until_cycle).toBe(0)

  // 2nd failure
  await resolveInterval(makeConfig(), state, deps)
  expect(state.interval_cache?.consecutive_failures).toBe(2)
  expect(state.interval_cache?.skip_until_cycle).toBe(0)

  // 3rd failure — circuit opens
  await resolveInterval(makeConfig(), state, deps)
  expect(state.interval_cache?.consecutive_failures).toBe(3)
  expect(state.interval_cache?.skip_until_cycle).toBe(10 + 5)
})

// 6. circuit open 동안 (cycle_index < skip_until) GET skip, source='cached'
it('scenario 6: circuit open skips GET and returns cached value', async () => {
  const cachedAt = new Date(BASE_NOW - 1000).toISOString()
  const state = makeState({
    daemon: { started_at: BASE_NOW, last_cycle_at: BASE_NOW, cycle_index: 12 },
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 3, skip_until_cycle: 15 },
  })
  const result = await resolveInterval(makeConfig(), state, deps)
  expect(result.source).toBe('cached')
  expect(result.warning).toContain('캐시된 값 사용 중')
  expect(apiClient.getSyncSettings).not.toHaveBeenCalled()
})

// 7. cache age 21h → source='cached' + warning includes 'stale'
it('scenario 7: stale cache (21h old) returns cached with stale warning', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new Error('HTTP 500'))
  const age21h = BASE_NOW - 21 * 3600 * 1000
  const cachedAt = new Date(age21h).toISOString()
  const state = makeState({
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 0, skip_until_cycle: 0 },
  })
  const result = await resolveInterval(makeConfig(), state, deps)
  expect(result.source).toBe('cached')
  expect(result.warning).toContain('stale')
})

// 8. cache age 25h (>24h cap) → source='config' (cache 만료 폐기)
it('scenario 8: expired cache (25h old) falls back to config', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new Error('HTTP 500'))
  const age25h = BASE_NOW - 25 * 3600 * 1000
  const cachedAt = new Date(age25h).toISOString()
  const state = makeState({
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 0, skip_until_cycle: 0 },
  })
  const result = await resolveInterval(makeConfig(90), state, deps)
  expect(result.source).toBe('config')
  expect(result.value).toBe(90)
})

// 9. fetch success after circuit open → consecutive_failures=0 reset, skip_until=0 reset
it('scenario 9: successful fetch after circuit open resets failures and skip_until', async () => {
  vi.mocked(apiClient.getSyncSettings).mockResolvedValueOnce({ interval_seconds: 180, updated_at: '2026-01-01T00:00:00Z' })
  const cachedAt = new Date(BASE_NOW - 1000).toISOString()
  // cycle_index >= skip_until_cycle so circuit is not open
  const state = makeState({
    daemon: { started_at: BASE_NOW, last_cycle_at: BASE_NOW, cycle_index: 15 },
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 3, skip_until_cycle: 15 },
  })
  const result = await resolveInterval(makeConfig(), state, deps)
  expect(result.source).toBe('server')
  expect(state.interval_cache?.consecutive_failures).toBe(0)
  expect(state.interval_cache?.skip_until_cycle).toBe(0)
})

// 10. config.interval_seconds 미정 + cache 만료 + fetch 실패 → source='default'
it('scenario 10: expired cache + fetch failure + no config falls back to default', async () => {
  vi.mocked(apiClient.getSyncSettings).mockRejectedValueOnce(new Error('HTTP 500'))
  const age25h = BASE_NOW - 25 * 3600 * 1000
  const cachedAt = new Date(age25h).toISOString()
  const state = makeState({
    interval_cache: { value: 150, fetched_at: cachedAt, source: 'server', consecutive_failures: 0, skip_until_cycle: 0 },
  })
  const config = makeConfig(0) // interval_seconds=0 is falsy
  const result = await resolveInterval(config, state, deps)
  expect(result.source).toBe('default')
  expect(result.value).toBe(DEFAULT_INTERVAL_SECONDS)
})
