/**
 * Tests for src/bootstrap-resolver.ts.
 *
 * Strategy:
 *   - Mock src/api-client.js getBootstrap to inject 200/304/401/403/429/5xx/network outcomes.
 *   - Use a tmp HOME so the disk persistence path is exercised end-to-end.
 *   - Reset module-level state between tests via resetBootstrapCacheForTest().
 *   - Use vi.useFakeTimers() to drive the 24h continuous-failure clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/api-client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api-client.js')>(
    '../src/api-client.js'
  )
  return {
    ...actual,
    getBootstrap: vi.fn(),
  }
})

import {
  MAX_BOOTSTRAP_CACHE_AGE_MS,
  STALE_WARN_AGE_MS,
  bootstrapStatusLabel,
  getBootstrap as getCachedBootstrap,
  invalidatedCachePathPrefix,
  loadCachedSnapshotFromDisk,
  peekCachedSnapshot,
  primeBootstrap,
  resetBootstrapCacheForTest,
} from '../src/bootstrap-resolver'
import { ApiPatAuthError, getBootstrap as fetchBootstrapHttp } from '../src/api-client'
import { bootstrapCachePath, ensureChronosDir } from '../src/auth-file'
import type { AuthFile } from '../src/auth-file'

const PAT = 'chr_pat_' + 'a'.repeat(32)
const AUTH: AuthFile = {
  server_url: 'https://chronos.brightworks.app',
  user_email: 'user@example.com',
  pat_hash_prefix: 'abcdef012345',
  pat_storage: 'keychain',
  allow_file_pat: false,
  written_at: '2026-05-10T00:00:00.000Z',
}

const PAYLOAD_BASE = {
  server_url: AUTH.server_url,
  user_email: AUTH.user_email,
  interval_seconds: 300,
  rooms: [{ project_id: 'p1', room_name: 'r1', chat_name: 'kakao A' }],
  etag: 'abc123def456',
  fetched_at: '2026-05-10T00:00:00.000Z',
}

let tmpHome: string
let realHome: string | undefined
const log = vi.fn()

beforeEach(async () => {
  realHome = process.env.HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-bootstrap-'))
  process.env.HOME = tmpHome
  await ensureChronosDir()
  resetBootstrapCacheForTest()
  log.mockClear()
  vi.mocked(fetchBootstrapHttp).mockReset()
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  vi.useRealTimers()
})

describe('primeBootstrap — 200', () => {
  it('writes the cache file mode 0600 and updates module state', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValue({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    expect(existsSync(bootstrapCachePath())).toBe(true)
    expect(statSync(bootstrapCachePath()).mode & 0o777).toBe(0o600)
    const snapshot = peekCachedSnapshot()
    expect(snapshot?.rooms.length).toBe(1)
    expect(snapshot?.interval_seconds).toBe(300)
    expect(snapshot?.etag).toBe('abc123def456')
    expect(snapshot?.last_successful_fetch).toBeGreaterThan(0)
  })

  it('passes If-None-Match on subsequent calls', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 304,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    expect(vi.mocked(fetchBootstrapHttp).mock.calls[1][1]).toBe(PAYLOAD_BASE.etag)
  })
})

describe('primeBootstrap — 304', () => {
  it('refreshes last_successful_fetch but keeps rooms/etag', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)

    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    const after200 = peekCachedSnapshot()!
    expect(after200.last_successful_fetch).toBe(t0)

    vi.setSystemTime(t0 + 60 * 1000)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 304,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    const after304 = peekCachedSnapshot()!
    expect(after304.last_successful_fetch).toBe(t0 + 60 * 1000)
    expect(after304.rooms).toEqual(PAYLOAD_BASE.rooms)
    expect(after304.etag).toBe(PAYLOAD_BASE.etag)
  })
})

describe('primeBootstrap — 401 / 403 invalidate cache', () => {
  it('renames cache to .invalidated.<ts> on 401 and clears in-memory', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    expect(existsSync(bootstrapCachePath())).toBe(true)

    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new ApiPatAuthError())
    await primeBootstrap(AUTH, PAT, log)

    expect(peekCachedSnapshot()).toBeNull()
    expect(existsSync(bootstrapCachePath())).toBe(false)
    const dir = join(tmpHome, '.chronos')
    const files = readdirSync(dir).filter((f) => f.startsWith('config.cache.json.invalidated.'))
    expect(files.length).toBe(1)
  })

  it('detects 403 via HTTP status string and invalidates', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 403: pat_scope_reduced')
    )
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).toBeNull()
    const dir = join(tmpHome, '.chronos')
    expect(readdirSync(dir).some((f) => f.startsWith('config.cache.json.invalidated.'))).toBe(true)
  })
})

describe('primeBootstrap — 5xx / network keep cache', () => {
  it('keeps cache + last_successful_fetch unchanged on 5xx', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)

    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    const lsf = peekCachedSnapshot()!.last_successful_fetch

    vi.setSystemTime(t0 + 60 * 1000)
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 503')
    )
    await primeBootstrap(AUTH, PAT, log)

    const after = peekCachedSnapshot()!
    expect(after.last_successful_fetch).toBe(lsf) // not bumped
    expect(after.rooms).toEqual(PAYLOAD_BASE.rooms) // cache untouched
  })

  it('keeps cache on network error (ECONNREFUSED-style)', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
    await primeBootstrap(AUTH, PAT, log)

    expect(peekCachedSnapshot()?.rooms.length).toBe(1)
  })
})

describe('primeBootstrap — 429 keeps cache', () => {
  it('does not invalidate; logs Retry-After', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 429: rate_limited retry-after=60')
    )
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).not.toBeNull()
    const warnCall = log.mock.calls.find(
      (c) => c[0] === 'warn' && /rate-limited/.test(String(c[1]))
    )
    expect(warnCall).toBeDefined()
    expect(warnCall?.[2]).toMatchObject({ retry_after: '60' })
  })
})

describe('getBootstrap — 24h ceiling', () => {
  it('returns refuse=true when last_successful_fetch is >= 24h old', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    // 25h later, no successful refresh in between.
    const result = getCachedBootstrap(log, t0 + 25 * 3600 * 1000)
    expect(result.refuse).toBe(true)
    expect(result.status).toBe('refused-stale')
    expect(result.warning).toMatch(/> 24h/)
  })

  it('returns warning (refuse=false) in the 20-24h band', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    const result = getCachedBootstrap(log, t0 + 21 * 3600 * 1000)
    expect(result.refuse).toBe(false)
    expect(result.status).toBe('stale')
    expect(result.warning).toMatch(/≥20h/)
  })

  it('returns ok with no warning under 20h', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    const result = getCachedBootstrap(log, t0 + 5 * 60 * 1000)
    expect(result.refuse).toBe(false)
    expect(result.status).toBe('ok')
    expect(result.warning).toBeNull()
  })

  it('successful 200 at hour 25 resets clock and unblocks next cycle (NEW-2)', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    const t25 = t0 + 25 * 3600 * 1000
    vi.setSystemTime(t25)
    expect(getCachedBootstrap(log).refuse).toBe(true)

    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 304,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    const recovered = getCachedBootstrap(log)
    expect(recovered.refuse).toBe(false)
    expect(recovered.status).toBe('ok')
  })

  it('returns refuse=true with status=missing when no cache exists', () => {
    const result = getCachedBootstrap(log)
    expect(result.refuse).toBe(true)
    expect(result.status).toBe('missing')
    expect(result.snapshot).toBeNull()
  })
})

describe('loadCachedSnapshotFromDisk', () => {
  it('hydrates module state from disk on first call', async () => {
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)

    // Simulate a fresh process: clear in-memory only.
    resetBootstrapCacheForTest()

    const loaded = await loadCachedSnapshotFromDisk()
    expect(loaded).not.toBeNull()
    expect(loaded?.rooms).toEqual(PAYLOAD_BASE.rooms)
    expect(peekCachedSnapshot()).toEqual(loaded)
  })

  it('returns null when cache file is missing', async () => {
    const loaded = await loadCachedSnapshotFromDisk()
    expect(loaded).toBeNull()
  })

  it('treats malformed JSON as missing (does NOT throw)', async () => {
    await fs.writeFile(bootstrapCachePath(), '{ corrupt', 'utf8')
    const loaded = await loadCachedSnapshotFromDisk()
    expect(loaded).toBeNull()
  })

  it('treats incomplete shape as missing', async () => {
    await fs.writeFile(
      bootstrapCachePath(),
      JSON.stringify({ server_url: 'x' }), // missing required fields
      'utf8'
    )
    const loaded = await loadCachedSnapshotFromDisk()
    expect(loaded).toBeNull()
  })
})

describe('primeBootstrap — concurrency mutex', () => {
  it('three concurrent calls share the same in-flight promise', async () => {
    // Use a deferred Promise that we resolve after the IIFE has progressed
    // past the FS hydration step. `mockImplementation` is invoked *only* when
    // `fetchBootstrapHttp` is called inside the IIFE, after the disk read.
    let resolveFetch: (v: { status: 200; payload: typeof PAYLOAD_BASE; etag: string }) => void = () => {
      throw new Error('resolveFetch called before fetchBootstrapHttp was invoked')
    }
    const fetchInvoked = new Promise<void>((notifyInvoked) => {
      vi.mocked(fetchBootstrapHttp).mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFetch = res
            notifyInvoked()
          })
      )
    })
    const p1 = primeBootstrap(AUTH, PAT, log)
    const p2 = primeBootstrap(AUTH, PAT, log)
    const p3 = primeBootstrap(AUTH, PAT, log)
    expect(p1).toBe(p2)
    expect(p2).toBe(p3)
    // Wait for the IIFE to flush past loadCachedSnapshotFromDisk and call
    // fetchBootstrapHttp; only then is resolveFetch wired to the real resolver.
    await fetchInvoked
    resolveFetch({ status: 200, payload: PAYLOAD_BASE, etag: PAYLOAD_BASE.etag })
    await Promise.all([p1, p2, p3])
    expect(vi.mocked(fetchBootstrapHttp)).toHaveBeenCalledTimes(1)
  })
})

describe('bootstrapStatusLabel', () => {
  it('returns "missing" when no snapshot is cached', () => {
    expect(bootstrapStatusLabel()).toBe('missing')
  })

  it('returns "ok (Xs ago)" within 20h', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel(t0 + 30 * 1000)).toMatch(/^ok \(30s ago\)$/)
    expect(bootstrapStatusLabel(t0 + 5 * 60 * 1000)).toMatch(/^ok \(5m ago\)$/)
  })

  it('returns "stale (Xh ago)" in the 20-24h band', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel(t0 + 21 * 3600 * 1000)).toMatch(/^stale \(21h ago\)$/)
  })

  it('returns "refused (>24h)" past the ceiling', async () => {
    vi.useFakeTimers()
    const t0 = new Date('2026-05-10T00:00:00Z').getTime()
    vi.setSystemTime(t0)
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: PAYLOAD_BASE,
      etag: PAYLOAD_BASE.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel(t0 + 25 * 3600 * 1000)).toMatch(/refused \(>24h\)/)
  })
})

describe('exported constants match the plan', () => {
  it('MAX_BOOTSTRAP_CACHE_AGE_MS = 24h, STALE_WARN_AGE_MS = 20h', () => {
    expect(MAX_BOOTSTRAP_CACHE_AGE_MS).toBe(24 * 60 * 60 * 1000)
    expect(STALE_WARN_AGE_MS).toBe(20 * 60 * 60 * 1000)
  })

  it('invalidatedCachePathPrefix() points inside chronos dir', () => {
    expect(invalidatedCachePathPrefix()).toContain(tmpHome)
    expect(invalidatedCachePathPrefix()).toContain('config.cache.json.invalidated.')
  })
})
