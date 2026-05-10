import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// child_process.execFile is the only system surface we touch. Each test
// stubs the callback-form `execFile` (Node default) which `node:util`
// `promisify` wraps. We use `vi.hoisted` to declare the mock state up-front
// so the `vi.mock` factory closes over a stable reference.
const state = vi.hoisted(() => ({
  responses: [] as Array<
    | { kind: 'ok'; stdout: string; stderr?: string }
    | { kind: 'err'; err: NodeJS.ErrnoException & { stderr?: string; signal?: string; code?: string | number } }
  >,
  calls: [] as Array<{ file: string; args: readonly string[] }>,
}))

vi.mock('node:child_process', async () => {
  const util = await import('node:util')
  const customSym = util.promisify.custom

  // util.promisify(execFile) returns `{stdout, stderr}` because the real
  // Node `execFile` carries a `util.promisify.custom` shim. Replicate that
  // here so the keychain code under test sees the real promise shape.
  function execFile(
    file: string,
    args: readonly string[],
    _opts: unknown,
    cb: (
      err: (NodeJS.ErrnoException & { stderr?: string; signal?: string }) | null,
      stdout: string,
      stderr: string
    ) => void
  ) {
    state.calls.push({ file, args })
    const next = state.responses.shift()
    if (!next) {
      cb(null, '', '')
      return
    }
    if (next.kind === 'ok') {
      cb(null, next.stdout, next.stderr ?? '')
    } else {
      cb(next.err, '', next.err.stderr ?? '')
    }
  }

  ;(execFile as unknown as Record<symbol, unknown>)[customSym] = (
    file: string,
    args: readonly string[],
    _opts?: unknown
  ) =>
    new Promise((resolve, reject) => {
      execFile(file, args, _opts, (err, stdout, stderr) => {
        if (err) {
          // Node attaches stdout/stderr to the error so callers can inspect them.
          ;(err as { stdout?: string }).stdout = stdout
          ;(err as { stderr?: string }).stderr = stderr
          reject(err)
        } else {
          resolve({ stdout, stderr })
        }
      })
    })

  return { execFile }
})

import {
  KEYCHAIN_SERVICE,
  deletePat,
  getPat,
  isKeychainAvailable,
  setPat,
} from '../src/keychain'

beforeEach(() => {
  state.responses.length = 0
  state.calls.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('isKeychainAvailable', () => {
  it('returns available=true when `security list-keychains` succeeds', async () => {
    state.responses.push({ kind: 'ok', stdout: '/Users/x/Library/Keychains/login.keychain-db' })
    const result = await isKeychainAvailable()
    expect(result.available).toBe(true)
    expect(state.calls[0]).toEqual({ file: 'security', args: ['list-keychains', '-d', 'user'] })
  })

  it('returns available=false with reason when `security` is missing (ENOENT)', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    state.responses.push({ kind: 'err', err })
    const result = await isKeychainAvailable()
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/security.*not found/i)
  })

  it('returns available=false with stderr message on generic failure', async () => {
    const err = Object.assign(new Error('boom'), { stderr: 'security: SecKeychainCopyDefault: User interaction is not allowed.' })
    state.responses.push({ kind: 'err', err })
    const result = await isKeychainAvailable()
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/User interaction is not allowed/)
  })
})

describe('setPat', () => {
  it('shells out add-generic-password with -U and explicit argv', async () => {
    state.responses.push({ kind: 'ok', stdout: '' })
    await setPat('user@example.com', 'chr_pat_' + 'a'.repeat(32))
    expect(state.calls[0].file).toBe('security')
    expect(state.calls[0].args).toEqual([
      'add-generic-password',
      '-U',
      '-s', KEYCHAIN_SERVICE,
      '-a', 'user@example.com',
      '-w', 'chr_pat_' + 'a'.repeat(32),
    ])
  })

  it('rejects empty account', async () => {
    await expect(setPat('', 'chr_pat_x')).rejects.toThrow(/account and pat are required/i)
  })

  it('rejects empty pat', async () => {
    await expect(setPat('user@example.com', '')).rejects.toThrow(/account and pat are required/i)
  })

  it('propagates execFile errors', async () => {
    const err = Object.assign(new Error('locked'), { stderr: 'errSecAuthFailed' })
    state.responses.push({ kind: 'err', err })
    await expect(setPat('user@example.com', 'chr_pat_' + 'a'.repeat(32))).rejects.toThrow(/locked/)
  })
})

describe('getPat', () => {
  it('returns the stored PAT (newline trimmed)', async () => {
    state.responses.push({ kind: 'ok', stdout: 'chr_pat_' + 'b'.repeat(32) + '\n' })
    const pat = await getPat('user@example.com')
    expect(pat).toBe('chr_pat_' + 'b'.repeat(32))
    expect(state.calls[0].args).toEqual([
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', 'user@example.com',
      '-w',
    ])
  })

  it('returns null when item not found (exit code 44)', async () => {
    const err = Object.assign(new Error('not found'), {
      code: 44,
      stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    })
    state.responses.push({ kind: 'err', err })
    const result = await getPat('nobody@example.com')
    expect(result).toBeNull()
  })

  it('returns null when stderr says could not be found regardless of code', async () => {
    const err = Object.assign(new Error('not found'), {
      code: 1,
      stderr: 'security: ... could not be found ...',
    })
    state.responses.push({ kind: 'err', err })
    const result = await getPat('nobody@example.com')
    expect(result).toBeNull()
  })

  it('throws on unrelated failures (locked keychain)', async () => {
    const err = Object.assign(new Error('locked'), { code: 36, stderr: 'errSecAuthFailed' })
    state.responses.push({ kind: 'err', err })
    await expect(getPat('user@example.com')).rejects.toThrow(/locked/)
  })
})

describe('deletePat', () => {
  it('shells out delete-generic-password', async () => {
    state.responses.push({ kind: 'ok', stdout: '' })
    await deletePat('user@example.com')
    expect(state.calls[0].args).toEqual([
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', 'user@example.com',
    ])
  })

  it('is a no-op when the entry does not exist', async () => {
    const err = Object.assign(new Error('not found'), {
      code: 44,
      stderr: 'security: ... could not be found ...',
    })
    state.responses.push({ kind: 'err', err })
    await expect(deletePat('user@example.com')).resolves.toBeUndefined()
  })
})
