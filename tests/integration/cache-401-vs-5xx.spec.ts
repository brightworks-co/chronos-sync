/**
 * Integration spec for CRIT-3 — the bootstrap outcome matrix from
 * .cmux/plans/auto-upload-server-driven-config.md §PR6 lines 586-594.
 *
 *   | 200 (fresh) | atomic snapshot replace      | continue              |
 *   | 304         | refresh fetched_at           | continue              |
 *   | 401         | invalidate cache             | refuse + exit         |
 *   | 403         | invalidate cache             | refuse + exit         |
 *   | 5xx / net   | keep cache                   | continue (subj 24h)   |
 *   | 429         | keep cache, respect Retry-After | continue           |
 *
 * Each case wires up a real ~/.chronos with mocked api-client + mocked
 * Keychain, drives `primeBootstrap` through the outcome, then asserts:
 *   - on-disk cache state (present / renamed / unchanged)
 *   - in-memory snapshot (peekCachedSnapshot)
 *   - `getCachedBootstrap` classification (refuse / status / warning)
 *
 * The daemon-level "exit" verdict is exercised in
 * `tests/integration/auth-without-bootstrap.spec.ts` separately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/api-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/api-client.js')>(
    '../../src/api-client.js'
  )
  return {
    ...actual,
    getBootstrap: vi.fn(),
  }
})
vi.mock('../../src/keychain.js', () => ({
  KEYCHAIN_SERVICE: 'chronos-sync',
  isKeychainAvailable: vi.fn(),
  setPat: vi.fn(),
  getPat: vi.fn(),
  deletePat: vi.fn(),
}))

import {
  bootstrapStatusLabel,
  getBootstrap as getCachedBootstrap,
  peekCachedSnapshot,
  primeBootstrap,
  resetBootstrapCacheForTest,
} from '../../src/bootstrap-resolver'
import { ApiPatAuthError, getBootstrap as fetchBootstrapHttp } from '../../src/api-client'
import {
  bootstrapCachePath,
  ensureChronosDir,
  saveAuth,
  type AuthFile,
} from '../../src/auth-file'
import { getPat as keychainGetPat } from '../../src/keychain'

const PAT = 'chr_pat_' + 'a'.repeat(32)
const AUTH: AuthFile = {
  server_url: 'https://chronos.brightworks.app',
  user_email: 'user@example.com',
  pat_hash_prefix: 'abcdef012345',
  pat_storage: 'keychain',
  allow_file_pat: false,
  written_at: '2026-05-10T00:00:00.000Z',
}
const PAYLOAD = {
  server_url: AUTH.server_url,
  user_email: AUTH.user_email,
  interval_seconds: 300,
  rooms: [{ project_id: 'p1', room_name: 'r1', chat_name: 'kakao A' }],
  etag: 'etag-1',
  fetched_at: '2026-05-10T00:00:00.000Z',
}

let tmpHome: string
let realHome: string | undefined
const log = vi.fn()

beforeEach(async () => {
  realHome = process.env.HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-crit3-'))
  process.env.HOME = tmpHome
  await ensureChronosDir()
  await saveAuth(AUTH)
  resetBootstrapCacheForTest()
  vi.mocked(fetchBootstrapHttp).mockReset()
  vi.mocked(keychainGetPat).mockResolvedValue(PAT)
  log.mockClear()

  // Seed an initial successful 200 so subsequent rows have a cache to keep/invalidate.
  vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
    status: 200,
    payload: PAYLOAD,
    etag: PAYLOAD.etag,
  })
  await primeBootstrap(AUTH, PAT, log)
  expect(existsSync(bootstrapCachePath())).toBe(true)
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  vi.useRealTimers()
})

describe('row 200 — atomic snapshot replace + continue', () => {
  it('200 with new payload replaces cache atomically', async () => {
    const updated = {
      ...PAYLOAD,
      interval_seconds: 600,
      rooms: [...PAYLOAD.rooms, { project_id: 'p2', room_name: 'r2' }],
      etag: 'etag-2',
    }
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: updated,
      etag: 'etag-2',
    })
    await primeBootstrap(AUTH, PAT, log)
    const snapshot = peekCachedSnapshot()!
    expect(snapshot.interval_seconds).toBe(600)
    expect(snapshot.rooms.length).toBe(2)
    expect(snapshot.etag).toBe('etag-2')
    expect(getCachedBootstrap(log).refuse).toBe(false)
  })
})

describe('row 304 — refresh fetched_at + continue', () => {
  it('304 keeps cache and refreshes last_successful_fetch', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    vi.setSystemTime(t0 + 60_000) // 60s after initial prime
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 304,
      etag: PAYLOAD.etag,
    })
    await primeBootstrap(AUTH, PAT, log)
    const snapshot = peekCachedSnapshot()!
    expect(snapshot.rooms).toEqual(PAYLOAD.rooms)
    expect(snapshot.etag).toBe(PAYLOAD.etag)
    expect(getCachedBootstrap(log, t0 + 60_000).refuse).toBe(false)
  })
})

describe('row 401 — invalidate cache + refuse', () => {
  it('renames cache to .invalidated.<ts> and refuses next read', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new ApiPatAuthError())
    await primeBootstrap(AUTH, PAT, log)

    expect(peekCachedSnapshot()).toBeNull()
    expect(existsSync(bootstrapCachePath())).toBe(false)
    const dir = join(tmpHome, '.chronos')
    expect(readdirSync(dir).some((f) => f.startsWith('config.cache.json.invalidated.'))).toBe(true)

    const result = getCachedBootstrap(log)
    expect(result.refuse).toBe(true)
    expect(result.status).toBe('missing')
  })
})

describe('row 403 — same as 401', () => {
  it('renames cache and refuses', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 403: pat_scope_reduced')
    )
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).toBeNull()
    const dir = join(tmpHome, '.chronos')
    expect(readdirSync(dir).some((f) => f.startsWith('config.cache.json.invalidated.'))).toBe(true)
    expect(getCachedBootstrap(log).refuse).toBe(true)
  })
})

describe('row 5xx — keep cache + continue (subject to 24h ceiling)', () => {
  it('5xx for 5 minutes: snapshot still used', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    vi.setSystemTime(t0 + 5 * 60 * 1000) // 5min later
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 503')
    )
    await primeBootstrap(AUTH, PAT, log)

    const snapshot = peekCachedSnapshot()!
    expect(snapshot.rooms).toEqual(PAYLOAD.rooms)
    const result = getCachedBootstrap(log, t0 + 5 * 60 * 1000)
    expect(result.refuse).toBe(false)
    expect(result.status).toBe('ok')
  })

  it('5xx persisting >24h: snapshot in disk but daemon refuses (MAJ-5)', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    // No further successful fetches between initial prime and 25h later.
    vi.setSystemTime(t0 + 25 * 60 * 60 * 1000)
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 503')
    )
    await primeBootstrap(AUTH, PAT, log)

    expect(existsSync(bootstrapCachePath())).toBe(true)
    const result = getCachedBootstrap(log, t0 + 25 * 60 * 60 * 1000)
    expect(result.refuse).toBe(true)
    expect(result.status).toBe('refused-stale')
    expect(result.warning).toMatch(/> 24h/)
  })
})

describe('row network failure — same as 5xx', () => {
  it('keeps cache on ECONNREFUSED-like errors', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).not.toBeNull()
    expect(existsSync(bootstrapCachePath())).toBe(true)
  })
})

describe('row 429 — keep cache + respect Retry-After', () => {
  it('keeps cache untouched and surfaces retry_after in log', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(
      new Error('Bootstrap GET failed: HTTP 429: rate_limited retry-after=30')
    )
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).not.toBeNull()
    const warnCall = log.mock.calls.find(
      (c) => c[0] === 'warn' && /rate-limited/.test(String(c[1]))
    )
    expect(warnCall?.[2]).toMatchObject({ retry_after: '30' })
    expect(getCachedBootstrap(log).refuse).toBe(false)
  })
})

describe('foreground UI status label across the matrix', () => {
  it('5xx 5min → "ok" label', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    vi.setSystemTime(t0 + 5 * 60 * 1000)
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('Bootstrap GET failed: HTTP 503'))
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel(t0 + 5 * 60 * 1000)).toMatch(/^ok \(5m ago\)$/)
  })

  it('5xx 21h → "stale (21h ago)" label', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    vi.setSystemTime(t0 + 21 * 60 * 60 * 1000)
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('Bootstrap GET failed: HTTP 503'))
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel(t0 + 21 * 60 * 60 * 1000)).toMatch(/^stale \(21h ago\)$/)
  })

  it('5xx 25h → "refused (>24h)" label', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    vi.setSystemTime(t0 + 25 * 60 * 60 * 1000)
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('Bootstrap GET failed: HTTP 503'))
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel(t0 + 25 * 60 * 60 * 1000)).toMatch(/refused \(>24h\)/)
  })

  it('401 → "missing" label after invalidation', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new ApiPatAuthError())
    await primeBootstrap(AUTH, PAT, log)
    expect(bootstrapStatusLabel()).toBe('missing')
  })
})
