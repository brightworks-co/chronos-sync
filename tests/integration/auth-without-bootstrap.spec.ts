/**
 * NTH-4 cross-PR integration spec.
 *
 * Plan §PR8 §681: "auth → server immediately offline → first daemon cycle
 * exits loud with actionable error" — combines PR5 (auth wrote auth.json)
 * + PR6 (state-file/loadConfig + bootstrap-resolver).
 *
 * Daemon-level exit is exercised via the resolver chain rather than spawning
 * a real daemon process (kakaocli, uploader, lock file, signals — too much
 * surface for a unit-fast spec). The chain is:
 *   loadConfig() in auth-mode without cache → returns rooms=[] (signal
 *     to daemon to prime).
 *   primeBootstrap() with the network down → cache stays absent.
 *   getCachedBootstrap() returns refuse=true / status='missing' →
 *     daemon translates to process.exit(1) per the runLoop logic.
 *
 * The spec asserts each of those steps so a regression in any one tier is
 * caught at the right granularity.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
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
  getBootstrap as getCachedBootstrap,
  peekCachedSnapshot,
  primeBootstrap,
  resetBootstrapCacheForTest,
} from '../../src/bootstrap-resolver'
import { getBootstrap as fetchBootstrapHttp } from '../../src/api-client'
import {
  bootstrapCachePath,
  ensureChronosDir,
  saveAuth,
  type AuthFile,
} from '../../src/auth-file'
import { getPat as keychainGetPat } from '../../src/keychain'
import { loadConfig } from '../../src/state-file'

const PAT = 'chr_pat_' + 'a'.repeat(32)
const AUTH: AuthFile = {
  server_url: 'https://chronos.brightworks.app',
  user_email: 'user@example.com',
  pat_hash_prefix: 'abcdef012345',
  pat_storage: 'keychain',
  allow_file_pat: false,
  written_at: '2026-05-10T00:00:00.000Z',
}

let tmpHome: string
let realHome: string | undefined
const log = vi.fn()

beforeEach(async () => {
  realHome = process.env.HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-nth4-'))
  process.env.HOME = tmpHome
  await ensureChronosDir()
  // Auth happened (PR5) but bootstrap never landed (server outage during auth
  // OR auth ran with --offline; either way, the daemon now boots with auth.json
  // and no cache).
  await saveAuth(AUTH)
  resetBootstrapCacheForTest()
  vi.mocked(fetchBootstrapHttp).mockReset()
  vi.mocked(keychainGetPat).mockResolvedValue(PAT)
  log.mockClear()
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  vi.clearAllMocks()
})

describe('NTH-4: auth.json present + no cache + server unreachable', () => {
  it('loadConfig returns auth-mode with empty rooms (signal to daemon to prime)', async () => {
    expect(existsSync(bootstrapCachePath())).toBe(false)
    const cfg = await loadConfig()
    // v0.6.0+: auth-mode is the only mode; no `.mode` discriminator on DaemonConfig.
    expect(cfg.rooms).toEqual([])
    expect(cfg.pat).toBe(PAT)
    expect(cfg.server_url).toBe(AUTH.server_url)
  })

  it('primeBootstrap with network down keeps cache absent', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).toBeNull()
    expect(existsSync(bootstrapCachePath())).toBe(false)
  })

  it('getCachedBootstrap returns refuse=true status=missing', async () => {
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
    await primeBootstrap(AUTH, PAT, log)
    const result = getCachedBootstrap(log)
    expect(result.refuse).toBe(true)
    expect(result.status).toBe('missing')
    expect(result.snapshot).toBeNull()
  })

  it('happy-path recovery: server reachable on retry → loadConfig now has rooms', async () => {
    // First prime fails (boot during outage).
    vi.mocked(fetchBootstrapHttp).mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'))
    await primeBootstrap(AUTH, PAT, log)
    expect(peekCachedSnapshot()).toBeNull()

    // Second prime succeeds (network came back).
    vi.mocked(fetchBootstrapHttp).mockResolvedValueOnce({
      status: 200,
      payload: {
        server_url: AUTH.server_url,
        user_email: AUTH.user_email,
        interval_seconds: 300,
        rooms: [{ project_id: 'p1', room_name: 'r1', chat_name: 'kakao A' }],
        etag: 'etag-1',
        fetched_at: '2026-05-10T01:00:00.000Z',
      },
      etag: 'etag-1',
    })
    await primeBootstrap(AUTH, PAT, log)

    const cfg = await loadConfig()
    expect(cfg.rooms.length).toBe(1)
    expect(cfg.rooms[0].room_name).toBe('r1')
  })
})
