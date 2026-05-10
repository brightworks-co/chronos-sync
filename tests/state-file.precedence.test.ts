/**
 * Tests for the 4-branch precedence rule in `state-file.loadConfig` (PR6
 * of `.cmux/plans/auto-upload-server-driven-config.md`).
 *
 *   (1) auth.json + (no legacy / legacy without creds) → AUTH-MODE
 *   (2) auth.json + legacy with embedded creds       → REFUSE
 *   (3) legacy alone                                  → LEGACY (with banner)
 *   (4) neither                                       → ConfigMissingError
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/keychain.js', () => ({
  KEYCHAIN_SERVICE: 'chronos-sync',
  isKeychainAvailable: vi.fn(),
  setPat: vi.fn(),
  getPat: vi.fn(),
  deletePat: vi.fn(),
}))

import {
  loadConfig,
  ConfigMissingError,
  ConfigConflictError,
  AuthCredentialMissingError,
  resetLegacyDeprecationBannerForTest,
} from '../src/state-file'
import {
  authPath,
  bootstrapCachePath,
  ensureChronosDir,
  saveAuth,
  savePatFile,
  type AuthFile,
} from '../src/auth-file'
import { getPat as keychainGetPat } from '../src/keychain'
import { resetBootstrapCacheForTest } from '../src/bootstrap-resolver'
import { configPath } from '../src/state-file'

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

beforeEach(async () => {
  realHome = process.env.HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-precedence-'))
  process.env.HOME = tmpHome
  resetBootstrapCacheForTest()
  resetLegacyDeprecationBannerForTest()
  vi.mocked(keychainGetPat).mockResolvedValue(PAT)
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  vi.clearAllMocks()
})

async function writeLegacy(body: unknown): Promise<void> {
  await ensureChronosDir()
  await fs.writeFile(configPath(), JSON.stringify(body), 'utf8')
}

async function writeCache(snapshot: unknown): Promise<void> {
  await ensureChronosDir()
  await fs.writeFile(bootstrapCachePath(), JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
}

describe('Branch 1 — auth-mode', () => {
  it('auth.json + cache → synthesized DaemonConfig with mode=auth', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)
    await writeCache({
      server_url: AUTH.server_url,
      user_email: AUTH.user_email,
      interval_seconds: 600,
      rooms: [{ project_id: 'p1', room_name: 'r1', chat_name: 'kakao A' }],
      etag: 'abc',
      fetched_at: '2026-05-10T00:00:00.000Z',
      last_successful_fetch: Date.now(),
    })

    const cfg = await loadConfig()
    expect(cfg.mode).toBe('auth')
    expect(cfg.server_url).toBe(AUTH.server_url)
    expect(cfg.pat).toBe(PAT)
    expect(cfg.interval_seconds).toBe(600)
    expect(cfg.rooms).toEqual([{ project_id: 'p1', room_name: 'r1', chat_name: 'kakao A' }])
  })

  it('auth.json without cache returns empty rooms (daemon will prime)', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)

    const cfg = await loadConfig()
    expect(cfg.mode).toBe('auth')
    expect(cfg.rooms).toEqual([])
  })

  it('auth.json + legacy without embedded creds (server_url only) → auth-mode', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)
    await writeLegacy({ server_url: 'https://stale.example.test' }) // no pat, no rooms

    const cfg = await loadConfig()
    expect(cfg.mode).toBe('auth')
    expect(cfg.server_url).toBe(AUTH.server_url)
  })

  it('auth-mode reads file PAT when pat_storage=file', async () => {
    await ensureChronosDir()
    const fileAuth: AuthFile = { ...AUTH, pat_storage: 'file', allow_file_pat: true }
    await saveAuth(fileAuth)
    await savePatFile(PAT)

    const cfg = await loadConfig()
    expect(cfg.pat).toBe(PAT)
    expect(cfg.mode).toBe('auth')
    expect(vi.mocked(keychainGetPat)).not.toHaveBeenCalled()
  })

  it('throws AuthCredentialMissingError when Keychain entry missing', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)
    vi.mocked(keychainGetPat).mockResolvedValue(null)
    await expect(loadConfig()).rejects.toBeInstanceOf(AuthCredentialMissingError)
  })

  it('throws AuthCredentialMissingError when auth.token missing for file storage', async () => {
    await ensureChronosDir()
    await saveAuth({ ...AUTH, pat_storage: 'file', allow_file_pat: true })
    await expect(loadConfig()).rejects.toBeInstanceOf(AuthCredentialMissingError)
  })
})

describe('Branch 2 — both present (defensive refuse)', () => {
  it('auth.json + legacy with embedded pat → ConfigConflictError', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)
    await writeLegacy({
      server_url: 'https://chronos.brightworks.app',
      pat: 'chr_pat_legacy',
      rooms: [],
    })
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigConflictError)
  })

  it('auth.json + legacy with non-empty rooms → ConfigConflictError', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)
    await writeLegacy({
      server_url: 'https://chronos.brightworks.app',
      rooms: [{ project_id: 'p', room_name: 'r' }],
    })
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigConflictError)
  })

  it('refuses with both signals (pat AND rooms)', async () => {
    await ensureChronosDir()
    await saveAuth(AUTH)
    await writeLegacy({
      server_url: 'https://chronos.brightworks.app',
      pat: 'chr_pat_legacy',
      rooms: [{ project_id: 'p', room_name: 'r' }],
    })
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigConflictError)
  })
})

describe('Branch 3 — legacy alone', () => {
  it('returns legacy DaemonConfig with mode=legacy', async () => {
    await writeLegacy({
      server_url: 'https://chronos.brightworks.app',
      pat: 'chr_pat_' + 'b'.repeat(32),
      interval_seconds: 120,
      rooms: [{ chat_name: 'a', project_id: 'p1', room_name: 'r1' }],
    })
    const cfg = await loadConfig()
    expect(cfg.mode).toBe('legacy')
    expect(cfg.interval_seconds).toBe(120)
    expect(cfg.rooms.length).toBe(1)
  })

  it('emits the v0.6.0 deprecation banner on stderr exactly once', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await writeLegacy({
        server_url: 'https://chronos.brightworks.app',
        pat: 'chr_pat_' + 'c'.repeat(32),
        rooms: [{ chat_name: 'a', project_id: 'p1', room_name: 'r1' }],
      })
      await loadConfig()
      await loadConfig()
      await loadConfig()

      const bannerCalls = stderrSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' && (c[0] as string).includes('legacy config.json detected')
      )
      expect(bannerCalls.length).toBe(1)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('still runs all v0.4.x validation rules (rooms required, pat format)', async () => {
    await writeLegacy({
      server_url: 'https://chronos.brightworks.app',
      pat: 'chr_pat_' + 'd'.repeat(32),
      rooms: [],
    })
    await expect(loadConfig()).rejects.toThrow(/rooms must be a non-empty array/)
  })
})

describe('Branch 4 — neither', () => {
  it('throws ConfigMissingError with actionable copy', async () => {
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigMissingError)
    try {
      await loadConfig()
    } catch (e) {
      expect((e as Error).message).toMatch(/auth\.json/)
      expect((e as Error).message).toMatch(/install/)
    }
  })

  it('rejects when chronos dir does not exist either', async () => {
    // No setup at all — fresh tmp HOME means ~/.chronos doesn't exist.
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigMissingError)
  })
})
