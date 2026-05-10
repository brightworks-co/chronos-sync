/**
 * Tests for `chronos-sync migrate` (src/cli/migrate.ts).
 *
 * Mocks api-client (network), keychain (Keychain), daemon-detect (probe).
 * Uses tmp HOME for filesystem isolation.
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
  ApiPatAuthError,
  getBootstrap,
  listEligibleProjects,
  putAutoUploadRooms,
  putSyncSettings,
} from '../../src/api-client'
import { isKeychainAvailable, setPat } from '../../src/keychain'
import { probeRunningDaemon } from '../../src/daemon-detect'
import {
  authPath,
  authTokenPath,
  bootstrapCachePath,
  ensureChronosDir,
} from '../../src/auth-file'
import { configPath } from '../../src/state-file'

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

const LEGACY_PAT = 'chr_pat_' + 'a'.repeat(32)
const LEGACY = {
  server_url: 'https://chronos.brightworks.app',
  pat: LEGACY_PAT,
  interval_seconds: 300,
  rooms: [
    {
      chat_id: '12345',
      project_id: 'project-1',
      room_name: 'room-a',
    },
    {
      chat_id: '67890',
      project_id: 'project-archived',
      room_name: 'room-b',
    },
    {
      chat_name: 'no-chat-id-room',
      project_id: 'project-1',
      room_name: 'room-c',
    },
  ],
}

let tmpHome: string
let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-migrate-'))
  process.env.HOME = tmpHome
  delete process.env.CHRONOS_HOME
  delete process.env.CHRONOS_ALLOW_FILE_PAT
  await ensureChronosDir()
  await fs.writeFile(configPath(), JSON.stringify(LEGACY, null, 2), 'utf8')

  vi.mocked(probeRunningDaemon).mockResolvedValue({ running: false, pids: [], launchdLabels: [] })
  vi.mocked(isKeychainAvailable).mockResolvedValue({ available: true })
  vi.mocked(setPat).mockResolvedValue(undefined)
  vi.mocked(listEligibleProjects).mockResolvedValue([
    { id: 'project-1', name: 'Project 1', archived: false },
    { id: 'project-archived', name: 'Project Z', archived: true },
  ])
  vi.mocked(putAutoUploadRooms).mockResolvedValue(undefined)
  vi.mocked(putSyncSettings).mockResolvedValue({
    interval_seconds: 300,
    updated_at: '2026-05-10T00:00:00.000Z',
  })
  vi.mocked(getBootstrap).mockResolvedValue({
    status: 200,
    payload: {
      server_url: LEGACY.server_url,
      user_email: 'user@example.com',
      interval_seconds: 300,
      rooms: [{ project_id: 'project-1', room_name: 'room-a', chat_name: '' }],
      etag: 'e1',
      fetched_at: '2026-05-10T00:00:00.000Z',
    },
    etag: 'e1',
  })
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  vi.clearAllMocks()
})

function makeIo(autoConfirm = true) {
  const out = new StringStream()
  const err = new StringStream()
  return {
    out,
    err,
    confirm: vi.fn().mockResolvedValue(autoConfirm),
  }
}

describe('runMigrate — daemon detection (MAJ-8.3)', () => {
  it('refuses when daemon detected without --force', async () => {
    vi.mocked(probeRunningDaemon).mockResolvedValue({
      running: true,
      pids: [9999],
      launchdLabels: ['com.brightworks.chronos-sync'],
    })
    const io = makeIo()
    const result = await runMigrate({}, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/daemon is running/)
    expect(io.err.text()).toMatch(/launchctl unload/)
    // No state changes
    expect(existsSync(authPath())).toBe(false)
    expect(vi.mocked(putAutoUploadRooms)).not.toHaveBeenCalled()
  })

  it('proceeds with --force when daemon detected', async () => {
    vi.mocked(probeRunningDaemon).mockResolvedValue({
      running: true,
      pids: [9999],
      launchdLabels: [],
    })
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(0)
    expect(vi.mocked(putAutoUploadRooms)).toHaveBeenCalledTimes(1)
  })
})

describe('runMigrate — nothing to migrate', () => {
  it('exits 0 when config.json missing', async () => {
    await fs.unlink(configPath())
    const io = makeIo()
    const result = await runMigrate({}, io)
    expect(result.exitCode).toBe(0)
    expect(io.out.text()).toMatch(/nothing to migrate/)
  })

  it('exits 0 when legacy has no embedded pat or rooms', async () => {
    await fs.writeFile(configPath(), JSON.stringify({ server_url: 'https://x' }), 'utf8')
    const io = makeIo()
    const result = await runMigrate({}, io)
    expect(result.exitCode).toBe(0)
    expect(io.out.text()).toMatch(/nothing to migrate/)
  })
})

describe('runMigrate — --dry-run (MAJ-8.1)', () => {
  it('prints summary including valid + dropped + skipped, makes no changes', async () => {
    const io = makeIo()
    const result = await runMigrate({ dryRun: true }, io)
    expect(result.exitCode).toBe(0)
    expect(io.out.text()).toMatch(/migrate plan/)
    expect(io.out.text()).toMatch(/project-1\/room-a/)
    expect(io.out.text()).toMatch(/dropped/)
    expect(io.out.text()).toMatch(/project-archived\/room-b/)
    expect(io.out.text()).toMatch(/skipped/)
    expect(io.out.text()).toMatch(/project-1\/room-c/)
    expect(io.out.text()).toMatch(/dry-run.*no changes/)
    // No state changes
    expect(existsSync(authPath())).toBe(false)
    expect(existsSync(configPath())).toBe(true)
    expect(vi.mocked(putAutoUploadRooms)).not.toHaveBeenCalled()
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
    // Pre-flight is allowed (read-only)
    expect(vi.mocked(listEligibleProjects)).toHaveBeenCalledTimes(1)
  })
})

describe('runMigrate — pre-flight (MAJ-8.2)', () => {
  it('drops rows pointing at archived projects', async () => {
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(0)
    const putCall = vi.mocked(putAutoUploadRooms).mock.calls[0]
    const rowsArg = putCall[1]
    expect(rowsArg.length).toBe(1)
    expect(rowsArg[0].project_id).toBe('project-1')
    expect(rowsArg[0].room_name).toBe('room-a')
  })

  it('exits 1 with actionable copy when legacy PAT is rejected during pre-flight', async () => {
    vi.mocked(listEligibleProjects).mockRejectedValue(new ApiPatAuthError())
    const io = makeIo()
    const result = await runMigrate({}, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/legacy PAT rejected/)
    expect(existsSync(configPath())).toBe(true) // legacy preserved
  })

  it('exits 1 when no valid rows remain after pre-flight', async () => {
    vi.mocked(listEligibleProjects).mockResolvedValue([
      { id: 'project-1', archived: true },
      { id: 'project-archived', archived: true },
    ])
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/no valid rooms/)
    expect(existsSync(configPath())).toBe(true)
  })
})

describe('runMigrate — confirm prompt', () => {
  it('aborts cleanly on N answer, no state change', async () => {
    const io = makeIo(false) // confirm returns false
    const result = await runMigrate({}, io)
    expect(result.exitCode).toBe(0)
    expect(io.out.text()).toMatch(/aborted by user/)
    expect(existsSync(authPath())).toBe(false)
    expect(existsSync(configPath())).toBe(true)
    expect(vi.mocked(putAutoUploadRooms)).not.toHaveBeenCalled()
  })

  it('skips prompt with --force', async () => {
    const io = makeIo(false) // would say no, but force bypasses
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(0)
    expect(io.confirm).not.toHaveBeenCalled()
  })
})

describe('runMigrate — happy path', () => {
  it('completes all 11 steps, leaves system in auth-mode', async () => {
    const io = makeIo()
    const result = await runMigrate({}, io)
    expect(result.exitCode).toBe(0)

    // step 6: rooms PUT
    expect(vi.mocked(putAutoUploadRooms)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: LEGACY_PAT }),
      [{ project_id: 'project-1', room_name: 'room-a', chat_id: '12345' }]
    )
    // step 7: interval PUT
    expect(vi.mocked(putSyncSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: LEGACY_PAT }),
      300
    )
    // step 8: bootstrap GET
    expect(vi.mocked(getBootstrap)).toHaveBeenCalled()
    // step 9: Keychain
    expect(vi.mocked(setPat)).toHaveBeenCalledWith('user@example.com', LEGACY_PAT)
    // step 10: auth.json
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.user_email).toBe('user@example.com')
    expect(auth.pat_storage).toBe('keychain')
    expect(auth.allow_file_pat).toBe(false)
    expect(statSync(authPath()).mode & 0o777).toBe(0o600)
    // step 11: legacy renamed
    expect(existsSync(configPath())).toBe(false)
    const dir = join(tmpHome, '.chronos')
    const baks = readdirSync(dir).filter((f) => f.startsWith('config.json.legacy.bak.'))
    expect(baks.length).toBe(1)
  })

  it('honors --allow-file-pat when Keychain unavailable', async () => {
    vi.mocked(isKeychainAvailable).mockResolvedValue({
      available: false,
      reason: 'security CLI missing',
    })
    const io = makeIo()
    const result = await runMigrate({ allowFilePat: true, force: true }, io)
    expect(result.exitCode).toBe(0)
    expect(existsSync(authTokenPath())).toBe(true)
    expect(statSync(authTokenPath()).mode & 0o777).toBe(0o600)
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.pat_storage).toBe('file')
    expect(auth.allow_file_pat).toBe(true)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('refuses when Keychain unavailable without --allow-file-pat', async () => {
    vi.mocked(isKeychainAvailable).mockResolvedValue({
      available: false,
      reason: 'locked',
    })
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/Keychain unavailable/)
    expect(io.err.text()).toMatch(/--allow-file-pat/)
    expect(existsSync(configPath())).toBe(true) // legacy preserved
  })

  it('removes stale config.cache.json after successful migrate', async () => {
    await fs.writeFile(bootstrapCachePath(), '{}', { encoding: 'utf8', mode: 0o600 })
    expect(existsSync(bootstrapCachePath())).toBe(true)
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(0)
    expect(existsSync(bootstrapCachePath())).toBe(false)
  })
})

describe('runMigrate — partial-failure rollback (legacy preserved)', () => {
  it('step 6 (room PUT) failure → no Keychain write, no rename', async () => {
    vi.mocked(putAutoUploadRooms).mockRejectedValue(new Error('500 server'))
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/room PUT failed/)
    expect(io.err.text()).toMatch(/legacy config\.json preserved/)
    expect(existsSync(configPath())).toBe(true)
    expect(existsSync(authPath())).toBe(false)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('step 7 (interval PUT) failure → no auth.json, no rename', async () => {
    vi.mocked(putSyncSettings).mockRejectedValue(new Error('boom'))
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/interval PUT failed/)
    expect(existsSync(configPath())).toBe(true)
    expect(existsSync(authPath())).toBe(false)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('step 8 (bootstrap) 401 → no Keychain, no rename', async () => {
    vi.mocked(getBootstrap).mockRejectedValue(new ApiPatAuthError())
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/bootstrap/)
    expect(io.err.text()).toMatch(/legacy config preserved/)
    expect(existsSync(configPath())).toBe(true)
    expect(existsSync(authPath())).toBe(false)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('step 9 (Keychain setPat) failure → no auth.json, no rename', async () => {
    vi.mocked(setPat).mockRejectedValue(new Error('keychain locked'))
    const io = makeIo()
    const result = await runMigrate({ force: true }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/failed to persist PAT/)
    expect(existsSync(configPath())).toBe(true)
    expect(existsSync(authPath())).toBe(false)
  })

  it('step 11 (rename) failure surfaces actionable warning', async () => {
    // saveAuth's atomic temp+rename also uses fs.rename. We need to fail ONLY
    // the final legacy → bak rename, not the auth.json temp rename. Match by
    // source path so the mock is precise.
    const real = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (typeof oldPath === 'string' && oldPath === configPath()) {
        throw new Error('EXDEV: cross-device rename not supported')
      }
      return real(oldPath, newPath)
    })
    try {
      const io = makeIo()
      const result = await runMigrate({ force: true }, io)
      expect(result.exitCode).toBe(1)
      expect(io.err.text()).toMatch(/renaming legacy config\.json failed/)
      expect(io.err.text()).toMatch(/manually/)
      // auth.json was already written before the rename attempt
      expect(existsSync(authPath())).toBe(true)
      // legacy still present (rename failed)
      expect(existsSync(configPath())).toBe(true)
    } finally {
      renameSpy.mockRestore()
    }
  })
})

describe('runMigrate — idempotent re-run', () => {
  it('second run after success exits with "nothing to migrate"', async () => {
    const io1 = makeIo()
    const r1 = await runMigrate({ force: true }, io1)
    expect(r1.exitCode).toBe(0)
    expect(existsSync(configPath())).toBe(false)

    // Re-run: legacy is already renamed away; migrate finds nothing.
    const io2 = makeIo()
    const r2 = await runMigrate({ force: true }, io2)
    expect(r2.exitCode).toBe(0)
    expect(io2.out.text()).toMatch(/nothing to migrate/)
  })
})
