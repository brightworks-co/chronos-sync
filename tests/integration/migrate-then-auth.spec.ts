/**
 * Cross-PR integration spec for the v0.5.0 happy-path lifecycle:
 *   PR7 migrate → PR5 auth-mode loadConfig → PR6 bootstrap-resolver
 *
 * Runs end-to-end against mocked api-client + mocked Keychain + a tmp HOME.
 * Verifies that a v0.4.x install with a hand-edited config.json can:
 *   1. Run `migrate` and end up in auth-mode (auth.json + Keychain set + legacy renamed).
 *   2. Run `loadConfig()` immediately after — gets mode='auth' synthesized.
 *   3. Run `primeBootstrap()` — populates the cache from the server.
 *   4. Run `getCachedBootstrap()` — returns refuse=false with the fresh snapshot.
 *
 * The integration boundary here is intentionally CLI-shaped: we don't spin up
 * the full daemon (kakaocli, uploader, lock file, signal handlers). Those
 * surfaces have their own unit tests. The point of this spec is to catch a
 * regression where one of the three PRs' contracts drifts out of sync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/keychain.js', () => ({
  KEYCHAIN_SERVICE: 'chronos-sync',
  isKeychainAvailable: vi.fn(),
  setPat: vi.fn(),
  getPat: vi.fn(),
  deletePat: vi.fn(),
}))
vi.mock('../../src/api-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/api-client.js')>(
    '../../src/api-client.js'
  )
  return {
    ...actual,
    listEligibleProjects: vi.fn(),
    putAutoUploadRooms: vi.fn(),
    putSyncSettings: vi.fn(),
    getBootstrap: vi.fn(),
  }
})
vi.mock('../../src/daemon-detect.js', () => ({
  probeRunningDaemon: vi.fn(),
}))

import { runMigrate } from '../../src/cli/migrate'
import {
  getBootstrap,
  listEligibleProjects,
  putAutoUploadRooms,
  putSyncSettings,
} from '../../src/api-client'
import {
  isKeychainAvailable,
  setPat,
  getPat,
} from '../../src/keychain'
import { probeRunningDaemon } from '../../src/daemon-detect'
import {
  authPath,
  bootstrapCachePath,
  ensureChronosDir,
} from '../../src/auth-file'
import {
  configPath,
  loadConfig,
  resetLegacyDeprecationBannerForTest,
} from '../../src/state-file'
import {
  getBootstrap as getCachedBootstrap,
  peekCachedSnapshot,
  primeBootstrap,
  resetBootstrapCacheForTest,
} from '../../src/bootstrap-resolver'

const LEGACY_PAT = 'chr_pat_' + 'a'.repeat(32)
const LEGACY_CONFIG = {
  server_url: 'https://chronos.brightworks.app',
  pat: LEGACY_PAT,
  interval_seconds: 60,
  rooms: [
    { chat_id: '12345', project_id: 'project-1', room_name: 'room-a' },
    { chat_id: '67890', project_id: 'project-1', room_name: 'room-b' },
  ],
}

let tmpHome: string
let realHome: string | undefined
const log = vi.fn()

class StringStream {
  chunks: string[] = []
  write(s: string): boolean {
    this.chunks.push(s)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

beforeEach(async () => {
  realHome = process.env.HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-int-migrate-auth-'))
  process.env.HOME = tmpHome
  delete process.env.CHRONOS_HOME
  delete process.env.CHRONOS_ALLOW_FILE_PAT

  await ensureChronosDir()
  await fs.writeFile(configPath(), JSON.stringify(LEGACY_CONFIG, null, 2), 'utf8')

  resetBootstrapCacheForTest()
  resetLegacyDeprecationBannerForTest()
  log.mockClear()

  vi.mocked(probeRunningDaemon).mockResolvedValue({ running: false, pids: [], launchdLabels: [] })
  vi.mocked(isKeychainAvailable).mockResolvedValue({ available: true })
  vi.mocked(setPat).mockResolvedValue(undefined)
  vi.mocked(getPat).mockResolvedValue(LEGACY_PAT)
  vi.mocked(listEligibleProjects).mockResolvedValue([
    { id: 'project-1', archived: false },
  ])
  vi.mocked(putAutoUploadRooms).mockResolvedValue(undefined)
  vi.mocked(putSyncSettings).mockResolvedValue({
    interval_seconds: 60,
    updated_at: '2026-05-11T00:00:00.000Z',
  })
  vi.mocked(getBootstrap).mockReset()
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  vi.clearAllMocks()
})

describe('migrate → loadConfig → primeBootstrap → getCachedBootstrap', () => {
  it('runs the full happy-path lifecycle without manual intervention', async () => {
    // ----- step 1: migrate -----
    // migrate's step 8 fetches /api/auto-upload/bootstrap once to discover
    // user_email; no etag yet, so it returns 200.
    vi.mocked(getBootstrap).mockResolvedValueOnce({
      status: 200,
      payload: {
        server_url: LEGACY_CONFIG.server_url,
        user_email: 'user@example.com',
        interval_seconds: LEGACY_CONFIG.interval_seconds,
        rooms: LEGACY_CONFIG.rooms.map((r) => ({
          project_id: r.project_id,
          room_name: r.room_name,
          chat_id: r.chat_id,
        })),
        etag: 'etag-after-migrate',
        fetched_at: '2026-05-11T00:00:00.000Z',
      },
      etag: 'etag-after-migrate',
    })
    const migrateOut = new StringStream()
    const migrateErr = new StringStream()
    const migrateResult = await runMigrate(
      { force: true },
      { out: migrateOut, err: migrateErr, confirm: vi.fn().mockResolvedValue(true) }
    )
    expect(migrateResult.exitCode).toBe(0)

    // Post-migrate FS state.
    expect(existsSync(authPath())).toBe(true)
    expect(statSync(authPath()).mode & 0o777).toBe(0o600)
    expect(existsSync(configPath())).toBe(false) // legacy renamed
    const dir = join(tmpHome, '.chronos')
    expect(readdirSync(dir).some((f) => f.startsWith('config.json.legacy.bak.'))).toBe(true)

    // The auth.json captures the migration outcome.
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.user_email).toBe('user@example.com')
    expect(auth.pat_storage).toBe('keychain')
    expect(auth.allow_file_pat).toBe(false)

    // Server-side mutations executed in the right order.
    expect(vi.mocked(putAutoUploadRooms)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: LEGACY_PAT }),
      expect.arrayContaining([
        { project_id: 'project-1', room_name: 'room-a', chat_id: '12345' },
        { project_id: 'project-1', room_name: 'room-b', chat_id: '67890' },
      ])
    )
    expect(vi.mocked(putSyncSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: LEGACY_PAT }),
      LEGACY_CONFIG.interval_seconds
    )
    expect(vi.mocked(setPat)).toHaveBeenCalledWith('user@example.com', LEGACY_PAT)

    // ----- step 2: loadConfig() in auth-mode -----
    // No cache yet (migrate sweeps it away). loadConfig should still produce
    // a valid auth-mode DaemonConfig with empty rooms — daemon will then
    // call primeBootstrap to fill them.
    expect(existsSync(bootstrapCachePath())).toBe(false)
    const cfg = await loadConfig()
    expect(cfg.mode).toBe('auth')
    expect(cfg.server_url).toBe(LEGACY_CONFIG.server_url)
    expect(cfg.pat).toBe(LEGACY_PAT)
    expect(cfg.rooms).toEqual([])

    // ----- step 3: primeBootstrap() -----
    vi.mocked(getBootstrap).mockResolvedValueOnce({
      status: 200,
      payload: {
        server_url: LEGACY_CONFIG.server_url,
        user_email: 'user@example.com',
        interval_seconds: LEGACY_CONFIG.interval_seconds,
        rooms: [
          { project_id: 'project-1', room_name: 'room-a', chat_name: 'kakao A' },
          { project_id: 'project-1', room_name: 'room-b', chat_name: 'kakao B' },
        ],
        etag: 'etag-after-prime',
        fetched_at: '2026-05-11T00:01:00.000Z',
      },
      etag: 'etag-after-prime',
    })
    await primeBootstrap(auth, cfg.pat, log)
    expect(existsSync(bootstrapCachePath())).toBe(true)
    expect(statSync(bootstrapCachePath()).mode & 0o777).toBe(0o600)

    const snapshot = peekCachedSnapshot()
    expect(snapshot?.rooms.length).toBe(2)
    expect(snapshot?.interval_seconds).toBe(LEGACY_CONFIG.interval_seconds)

    // ----- step 4: getCachedBootstrap() -----
    const result = getCachedBootstrap(log)
    expect(result.refuse).toBe(false)
    expect(result.status).toBe('ok')
    expect(result.snapshot?.rooms.length).toBe(2)

    // ----- step 5: re-loadConfig now sees rooms from the primed cache -----
    const cfg2 = await loadConfig()
    expect(cfg2.mode).toBe('auth')
    expect(cfg2.rooms.length).toBe(2)
    expect(cfg2.interval_seconds).toBe(LEGACY_CONFIG.interval_seconds)
  })

  it('migrate with --dry-run does not touch any of the auth/cache surfaces', async () => {
    vi.mocked(getBootstrap).mockReset()
    const out = new StringStream()
    const err = new StringStream()
    const result = await runMigrate(
      { dryRun: true, force: true },
      { out, err, confirm: vi.fn() }
    )
    expect(result.exitCode).toBe(0)
    // Pre-flight allowed (read-only) but no writes.
    expect(existsSync(authPath())).toBe(false)
    expect(existsSync(bootstrapCachePath())).toBe(false)
    expect(existsSync(configPath())).toBe(true) // legacy still in place
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
    expect(vi.mocked(putAutoUploadRooms)).not.toHaveBeenCalled()
    expect(vi.mocked(getBootstrap)).not.toHaveBeenCalled()

    // loadConfig still lands in legacy-mode (auth.json absent + legacy intact).
    resetLegacyDeprecationBannerForTest()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const cfg = await loadConfig()
      expect(cfg.mode).toBe('legacy')
      expect(cfg.rooms.length).toBe(2)
    } finally {
      stderrSpy.mockRestore()
    }
  })
})
