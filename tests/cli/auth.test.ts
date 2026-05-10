/**
 * Tests for `chronos-sync auth` (src/cli/auth.ts).
 *
 * Mocks: ../src/keychain (Keychain probe + setPat + getPat + deletePat),
 *        ../src/api-client (getBootstrap + deleteAutoUploadRoom),
 *        process.env.HOME → tmp dir per test.
 *
 * The CLI handler reads/writes real files under `~/.chronos`, so each test
 * isolates HOME via `mkdtemp`. Network I/O and Keychain calls are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, statSync, existsSync } from 'node:fs'
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
    getBootstrap: vi.fn(),
    deleteAutoUploadRoom: vi.fn(),
  }
})

import { runAuth } from '../../src/cli/auth'
import {
  isKeychainAvailable,
  setPat,
  getPat,
  deletePat,
} from '../../src/keychain'
import {
  ApiPatAuthError,
  deleteAutoUploadRoom,
  getBootstrap,
} from '../../src/api-client'
import { authPath, authTokenPath, bootstrapCachePath } from '../../src/auth-file'

class StringStream {
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

const VALID_PAT = 'chr_pat_' + 'a'.repeat(32)
const VALID_PAT_2 = 'chr_pat_' + 'b'.repeat(32)

let tmpHome: string
let realHome: string | undefined
let realChronosHome: string | undefined
let realAllowFileEnv: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  realChronosHome = process.env.CHRONOS_HOME
  realAllowFileEnv = process.env.CHRONOS_ALLOW_FILE_PAT
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-auth-cli-'))
  process.env.HOME = tmpHome
  delete process.env.CHRONOS_HOME
  delete process.env.CHRONOS_ALLOW_FILE_PAT

  vi.mocked(isKeychainAvailable).mockResolvedValue({ available: true })
  vi.mocked(setPat).mockResolvedValue(undefined)
  vi.mocked(getPat).mockResolvedValue(null)
  vi.mocked(deletePat).mockResolvedValue(undefined)
  vi.mocked(getBootstrap).mockResolvedValue({
    status: 200,
    payload: {
      server_url: 'https://chronos.brightworks.app',
      user_email: 'user@example.com',
      interval_seconds: 300,
      rooms: [],
      etag: 'abc123def456',
      fetched_at: '2026-05-10T00:00:00.000Z',
    },
    etag: 'abc123def456',
  })
  vi.mocked(deleteAutoUploadRoom).mockResolvedValue(undefined)
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realChronosHome === undefined) delete process.env.CHRONOS_HOME
  else process.env.CHRONOS_HOME = realChronosHome
  if (realAllowFileEnv === undefined) delete process.env.CHRONOS_ALLOW_FILE_PAT
  else process.env.CHRONOS_ALLOW_FILE_PAT = realAllowFileEnv
  vi.clearAllMocks()
})

function makeIo() {
  return { out: new StringStream(), err: new StringStream() }
}

describe('runAuth — happy path (Keychain)', () => {
  it('writes auth.json with pat_storage=keychain on success', async () => {
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT, tokenWasFlag: false }, io)
    expect(result.exitCode).toBe(0)
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.pat_storage).toBe('keychain')
    expect(auth.user_email).toBe('user@example.com')
    expect(auth.allow_file_pat).toBe(false)
    expect(auth.pat_hash_prefix).toMatch(/^[a-f0-9]{12}$/)
    expect(auth.server_url).toBe('https://chronos.brightworks.app')
    expect(vi.mocked(setPat)).toHaveBeenCalledWith('user@example.com', VALID_PAT)
    expect(io.out.text()).toMatch(/auth saved.*rooms: 0.*pat_storage: keychain/)
  })

  it('writes auth.json mode 0600 and chronos dir 0700', async () => {
    const io = makeIo()
    await runAuth({ token: VALID_PAT }, io)
    expect(statSync(authPath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(tmpHome, '.chronos')).mode & 0o777).toBe(0o700)
  })

  it('persists bootstrap snapshot to config.cache.json mode 0600', async () => {
    const io = makeIo()
    await runAuth({ token: VALID_PAT }, io)
    expect(existsSync(bootstrapCachePath())).toBe(true)
    expect(statSync(bootstrapCachePath()).mode & 0o777).toBe(0o600)
    const snapshot = JSON.parse(await fs.readFile(bootstrapCachePath(), 'utf8'))
    expect(snapshot.user_email).toBe('user@example.com')
    expect(snapshot.interval_seconds).toBe(300)
    expect(typeof snapshot.last_successful_fetch).toBe('number')
  })

  it('respects --server-url override', async () => {
    const io = makeIo()
    await runAuth({ token: VALID_PAT, serverUrl: 'https://staging.example.test/' }, io)
    expect(vi.mocked(getBootstrap)).toHaveBeenCalledWith({
      serverUrl: 'https://staging.example.test',
      pat: VALID_PAT,
    })
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.server_url).toBe('https://staging.example.test')
  })
})

describe('runAuth — PAT acquisition', () => {
  it('emits stderr warning when --token flag was used', async () => {
    const io = makeIo()
    await runAuth({ token: VALID_PAT, tokenWasFlag: true }, io)
    expect(io.err.text()).toMatch(/--token.*shell history/)
  })

  it('does NOT warn when PAT was a positional arg', async () => {
    const io = makeIo()
    await runAuth({ token: VALID_PAT, tokenWasFlag: false }, io)
    expect(io.err.text()).not.toMatch(/shell history/)
  })

  it('reads from stdin when --from-stdin', async () => {
    const io = {
      out: new StringStream(),
      err: new StringStream(),
      readStdin: vi.fn().mockResolvedValue(VALID_PAT + '\n'),
    }
    const result = await runAuth({ fromStdin: true }, io)
    expect(result.exitCode).toBe(0)
    expect(io.readStdin).toHaveBeenCalled()
  })

  it('uses promptHidden when no flags supplied', async () => {
    const io = {
      out: new StringStream(),
      err: new StringStream(),
      promptHidden: vi.fn().mockResolvedValue(VALID_PAT),
    }
    const result = await runAuth({}, io)
    expect(result.exitCode).toBe(0)
    expect(io.promptHidden).toHaveBeenCalledWith('Enter PAT (input hidden): ')
  })

  it('rejects PAT with bad format', async () => {
    const io = makeIo()
    const result = await runAuth({ token: 'not_a_pat' }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/PAT format invalid/)
    expect(existsSync(authPath())).toBe(false)
  })

  it('rejects PAT with wrong hex length', async () => {
    const io = makeIo()
    const result = await runAuth({ token: 'chr_pat_' + 'a'.repeat(31) }, io)
    expect(result.exitCode).toBe(1)
  })
})

describe('runAuth — legacy precondition (MAJ-6)', () => {
  it('refuses when ~/.chronos/config.json has embedded pat', async () => {
    const dir = join(tmpHome, '.chronos')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ server_url: 'x', pat: 'chr_pat_legacy', rooms: [] }),
      'utf8'
    )
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/Legacy config\.json detected/)
    expect(io.err.text()).toMatch(/migrate/)
    // No side effects — auth.json + Keychain not touched
    expect(existsSync(authPath())).toBe(false)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('refuses when legacy config has non-empty rooms but no pat field', async () => {
    const dir = join(tmpHome, '.chronos')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ server_url: 'x', rooms: [{ project_id: 'p', room_name: 'r' }] }),
      'utf8'
    )
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/Legacy config\.json detected/)
  })

  it('proceeds when config.json exists but is empty/non-legacy', async () => {
    const dir = join(tmpHome, '.chronos')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ server_url: 'x', rooms: [] }),
      'utf8'
    )
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(0)
  })
})

describe('runAuth — Keychain unavailable + --allow-file-pat (MAJ-4)', () => {
  it('exits 1 when Keychain unavailable and no opt-in', async () => {
    vi.mocked(isKeychainAvailable).mockResolvedValue({
      available: false,
      reason: 'security CLI missing',
    })
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/Keychain unavailable.*security CLI missing/)
    expect(io.err.text()).toMatch(/--allow-file-pat/)
    expect(existsSync(authPath())).toBe(false)
  })

  it('writes file PAT when --allow-file-pat opt-in', async () => {
    vi.mocked(isKeychainAvailable).mockResolvedValue({
      available: false,
      reason: 'keychain locked',
    })
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT, allowFilePat: true }, io)
    expect(result.exitCode).toBe(0)
    expect(existsSync(authTokenPath())).toBe(true)
    expect(statSync(authTokenPath()).mode & 0o777).toBe(0o600)
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.pat_storage).toBe('file')
    expect(auth.allow_file_pat).toBe(true)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('writes file PAT when CHRONOS_ALLOW_FILE_PAT=1 env is set', async () => {
    process.env.CHRONOS_ALLOW_FILE_PAT = '1'
    vi.mocked(isKeychainAvailable).mockResolvedValue({ available: false })
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(0)
    const auth = JSON.parse(await fs.readFile(authPath(), 'utf8'))
    expect(auth.pat_storage).toBe('file')
    expect(auth.allow_file_pat).toBe(true)
  })
})

describe('runAuth — bootstrap network handling', () => {
  it('exits 1 on 401 and does NOT write auth.json', async () => {
    vi.mocked(getBootstrap).mockRejectedValue(new ApiPatAuthError())
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/PAT rejected by server/)
    expect(existsSync(authPath())).toBe(false)
    expect(vi.mocked(setPat)).not.toHaveBeenCalled()
  })

  it('on terminal network failure: exits 1 (no email = nothing to write)', async () => {
    vi.mocked(getBootstrap).mockRejectedValue(new Error('ECONNREFUSED'))
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(1)
    expect(io.err.text()).toMatch(/bootstrap fetch failed/)
    expect(io.err.text()).toMatch(/user_email is unknown/)
    expect(existsSync(authPath())).toBe(false)
  }, 30000)

  it('retries 4× on transient failures before giving up', async () => {
    vi.mocked(getBootstrap)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        status: 200,
        payload: {
          server_url: 'https://chronos.brightworks.app',
          user_email: 'user@example.com',
          interval_seconds: 300,
          rooms: [],
          etag: 'e1',
          fetched_at: '2026-05-10T00:00:00.000Z',
        },
        etag: 'e1',
      })
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT }, io)
    expect(result.exitCode).toBe(0)
    expect(vi.mocked(getBootstrap)).toHaveBeenCalledTimes(2)
  }, 10000)
})

describe('runAuth — --reset rotation (MAJ-7)', () => {
  it('unregisters claimed rooms then re-registers', async () => {
    // Pre-existing auth.json + Keychain entry
    const dir = join(tmpHome, '.chronos')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      authPath(),
      JSON.stringify({
        server_url: 'https://chronos.brightworks.app',
        user_email: 'user@example.com',
        pat_hash_prefix: 'oldoldoldold',
        pat_storage: 'keychain',
        allow_file_pat: false,
        written_at: '2026-04-01T00:00:00.000Z',
      }),
      { mode: 0o600 }
    )
    const OLD_PAT = 'chr_pat_' + 'c'.repeat(32)
    vi.mocked(getPat).mockResolvedValue(OLD_PAT)

    // First getBootstrap call (during reset, with old PAT) returns 2 rooms.
    // Second call (after reset, with new PAT) returns 0 rooms.
    vi.mocked(getBootstrap)
      .mockResolvedValueOnce({
        status: 200,
        payload: {
          server_url: 'https://chronos.brightworks.app',
          user_email: 'user@example.com',
          interval_seconds: 300,
          rooms: [
            { project_id: 'p1', room_name: 'r1' },
            { project_id: 'p2', room_name: 'r2' },
          ],
          etag: 'old',
          fetched_at: '2026-04-01T00:00:00.000Z',
        },
        etag: 'old',
      })
      .mockResolvedValueOnce({
        status: 200,
        payload: {
          server_url: 'https://chronos.brightworks.app',
          user_email: 'user@example.com',
          interval_seconds: 300,
          rooms: [],
          etag: 'new',
          fetched_at: '2026-05-10T00:00:00.000Z',
        },
        etag: 'new',
      })

    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT_2, reset: true }, io)
    expect(result.exitCode).toBe(0)

    // Both rooms unregistered with the OLD PAT
    expect(vi.mocked(deleteAutoUploadRoom)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deleteAutoUploadRoom)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: OLD_PAT }),
      'p1', 'r1'
    )
    expect(vi.mocked(deleteAutoUploadRoom)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: OLD_PAT }),
      'p2', 'r2'
    )
    // Keychain entry deleted
    expect(vi.mocked(deletePat)).toHaveBeenCalledWith('user@example.com')
    // New PAT stored
    expect(vi.mocked(setPat)).toHaveBeenCalledWith('user@example.com', VALID_PAT_2)
    expect(io.out.text()).toMatch(/released p1\/r1/)
    expect(io.out.text()).toMatch(/released p2\/r2/)
  })

  it('graceful degradation when old PAT is already invalid', async () => {
    const dir = join(tmpHome, '.chronos')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      authPath(),
      JSON.stringify({
        server_url: 'https://chronos.brightworks.app',
        user_email: 'user@example.com',
        pat_hash_prefix: 'invalidatd01',
        pat_storage: 'keychain',
        allow_file_pat: false,
        written_at: '2026-04-01T00:00:00.000Z',
      }),
      { mode: 0o600 }
    )
    vi.mocked(getPat).mockResolvedValue('chr_pat_' + 'd'.repeat(32))
    vi.mocked(getBootstrap)
      .mockRejectedValueOnce(new ApiPatAuthError())
      // After reset, the new PAT works.
      .mockResolvedValueOnce({
        status: 200,
        payload: {
          server_url: 'https://chronos.brightworks.app',
          user_email: 'user@example.com',
          interval_seconds: 300,
          rooms: [],
          etag: 'new',
          fetched_at: '2026-05-10T00:00:00.000Z',
        },
        etag: 'new',
      })

    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT_2, reset: true }, io)
    expect(result.exitCode).toBe(0)
    expect(io.err.text()).toMatch(/old PAT already invalid/)
    expect(io.err.text()).toMatch(/manually clear/)
    // No rooms unregistered (couldn't fetch the list)
    expect(vi.mocked(deleteAutoUploadRoom)).not.toHaveBeenCalled()
  })

  it('reset with no prior auth.json proceeds to fresh registration', async () => {
    const io = makeIo()
    const result = await runAuth({ token: VALID_PAT, reset: true }, io)
    expect(result.exitCode).toBe(0)
    expect(io.out.text()).toMatch(/no existing auth\.json/)
    expect(vi.mocked(deleteAutoUploadRoom)).not.toHaveBeenCalled()
  })
})

describe('runAuth — CHRONOS_HOME override', () => {
  it('writes auth.json under CHRONOS_HOME when set', async () => {
    const customDir = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-custom-home-'))
    try {
      process.env.CHRONOS_HOME = customDir
      const io = makeIo()
      const result = await runAuth({ token: VALID_PAT }, io)
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(customDir, 'auth.json'))).toBe(true)
      // The default ~/.chronos was NOT created
      expect(existsSync(join(tmpHome, '.chronos', 'auth.json'))).toBe(false)
    } finally {
      await fs.rm(customDir, { recursive: true, force: true })
    }
  })
})
