import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  authPath,
  authTokenPath,
  bootstrapCachePath,
  chronosHomeDir,
  ensureChronosDir,
  loadAuth,
  loadPatFile,
  saveAuth,
  savePatFile,
  wipeAuth,
  type AuthFile,
} from '../src/auth-file'

let tmpHome: string
let realHome: string | undefined
let realChronosHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  realChronosHome = process.env.CHRONOS_HOME
  tmpHome = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-auth-file-'))
  process.env.HOME = tmpHome
  delete process.env.CHRONOS_HOME
})

afterEach(async () => {
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true })
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realChronosHome === undefined) delete process.env.CHRONOS_HOME
  else process.env.CHRONOS_HOME = realChronosHome
})

const VALID_AUTH: AuthFile = {
  server_url: 'https://chronos.brightworks.app',
  user_email: 'user@example.com',
  pat_hash_prefix: 'abcdef012345',
  pat_storage: 'keychain',
  allow_file_pat: false,
  written_at: '2026-05-10T00:00:00.000Z',
}

describe('chronosHomeDir', () => {
  it('defaults to ~/.chronos', () => {
    expect(chronosHomeDir()).toBe(join(tmpHome, '.chronos'))
  })

  it('honors CHRONOS_HOME when set', () => {
    process.env.CHRONOS_HOME = '/var/cache/chronos-test'
    expect(chronosHomeDir()).toBe('/var/cache/chronos-test')
  })

  it('treats empty CHRONOS_HOME as unset', () => {
    process.env.CHRONOS_HOME = ''
    expect(chronosHomeDir()).toBe(join(tmpHome, '.chronos'))
  })
})

describe('ensureChronosDir', () => {
  it('creates ~/.chronos with mode 0700 when missing', async () => {
    await ensureChronosDir()
    const dir = chronosHomeDir()
    const stat = statSync(dir)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  it('is idempotent', async () => {
    await ensureChronosDir()
    await ensureChronosDir()
    const dir = chronosHomeDir()
    const stat = statSync(dir)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  it('tightens permissions on a pre-existing 0755 directory', async () => {
    const dir = chronosHomeDir()
    await fs.mkdir(dir, { recursive: true, mode: 0o755 })
    await ensureChronosDir()
    const stat = statSync(dir)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  it('throws an actionable error when parent is not writable', async () => {
    process.env.CHRONOS_HOME = '/proc/no-such-dir/chronos'
    await expect(ensureChronosDir()).rejects.toThrow(/permission denied|cannot be created|EACCES|EROFS|ENOENT/i)
  })
})

describe('saveAuth / loadAuth', () => {
  it('round-trips a full auth file', async () => {
    await ensureChronosDir()
    await saveAuth(VALID_AUTH)
    const loaded = await loadAuth()
    expect(loaded).toEqual(VALID_AUTH)
  })

  it('writes auth.json with mode 0600', async () => {
    await ensureChronosDir()
    await saveAuth(VALID_AUTH)
    const stat = statSync(authPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null when auth.json is missing', async () => {
    await ensureChronosDir()
    const loaded = await loadAuth()
    expect(loaded).toBeNull()
  })

  it('rejects malformed auth.json', async () => {
    await ensureChronosDir()
    await fs.writeFile(authPath(), '{ not json', 'utf8')
    await expect(loadAuth()).rejects.toThrow(/not valid JSON/i)
  })

  it('rejects bad pat_storage value', async () => {
    await ensureChronosDir()
    await fs.writeFile(
      authPath(),
      JSON.stringify({ ...VALID_AUTH, pat_storage: 'cloud' }),
      'utf8'
    )
    await expect(loadAuth()).rejects.toThrow(/pat_storage/i)
  })

  it('rejects when allow_file_pat is not a boolean', async () => {
    await ensureChronosDir()
    await fs.writeFile(
      authPath(),
      JSON.stringify({ ...VALID_AUTH, allow_file_pat: 'yes' }),
      'utf8'
    )
    await expect(loadAuth()).rejects.toThrow(/allow_file_pat/i)
  })

  it('rejects empty user_email', async () => {
    await ensureChronosDir()
    await expect(saveAuth({ ...VALID_AUTH, user_email: '' })).rejects.toThrow(/user_email/i)
  })

  it('saveAuth replaces an existing file atomically', async () => {
    await ensureChronosDir()
    await saveAuth(VALID_AUTH)
    const updated: AuthFile = { ...VALID_AUTH, pat_storage: 'file', allow_file_pat: true }
    await saveAuth(updated)
    const loaded = await loadAuth()
    expect(loaded?.pat_storage).toBe('file')
    expect(loaded?.allow_file_pat).toBe(true)
  })
})

describe('savePatFile / loadPatFile', () => {
  it('writes auth.token with mode 0600', async () => {
    await ensureChronosDir()
    await savePatFile('chr_pat_' + 'a'.repeat(32))
    const stat = statSync(authTokenPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('reads back the token verbatim (sans trailing newline)', async () => {
    await ensureChronosDir()
    const pat = 'chr_pat_' + 'b'.repeat(32)
    await savePatFile(pat)
    const loaded = await loadPatFile()
    expect(loaded).toBe(pat)
  })

  it('returns null when auth.token is missing', async () => {
    await ensureChronosDir()
    const loaded = await loadPatFile()
    expect(loaded).toBeNull()
  })

  it('rejects empty token', async () => {
    await ensureChronosDir()
    await expect(savePatFile('')).rejects.toThrow(/non-empty/i)
  })
})

describe('wipeAuth', () => {
  it('removes auth.json and auth.token; idempotent', async () => {
    await ensureChronosDir()
    await saveAuth(VALID_AUTH)
    await savePatFile('chr_pat_' + 'c'.repeat(32))
    await wipeAuth()
    expect(await loadAuth()).toBeNull()
    expect(await loadPatFile()).toBeNull()
    // second call should not throw
    await wipeAuth()
  })
})

describe('paths', () => {
  it('places artifacts inside chronosHomeDir()', () => {
    expect(authPath()).toBe(join(chronosHomeDir(), 'auth.json'))
    expect(authTokenPath()).toBe(join(chronosHomeDir(), 'auth.token'))
    expect(bootstrapCachePath()).toBe(join(chronosHomeDir(), 'config.cache.json'))
  })
})
