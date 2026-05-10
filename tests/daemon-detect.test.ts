import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({
  responses: new Map<string, { stdout: string; err?: NodeJS.ErrnoException & { code?: string | number; stderr?: string } }>(),
  calls: [] as Array<{ file: string; args: readonly string[] }>,
}))

vi.mock('node:child_process', async () => {
  const util = await import('node:util')
  const customSym = util.promisify.custom

  function execFile(
    file: string,
    args: readonly string[],
    _opts: unknown,
    cb: (
      err: (NodeJS.ErrnoException & { stderr?: string }) | null,
      stdout: string,
      stderr: string
    ) => void
  ) {
    state.calls.push({ file, args })
    const key = `${file}:${args.join(' ')}`
    const next = state.responses.get(key) ?? state.responses.get(file)
    if (!next) {
      cb(null, '', '')
      return
    }
    if (next.err) {
      cb(next.err, '', next.err.stderr ?? '')
    } else {
      cb(null, next.stdout, '')
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

import { probeRunningDaemon } from '../src/daemon-detect'

beforeEach(() => {
  state.responses.clear()
  state.calls.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('probeRunningDaemon', () => {
  it('returns running=false when both probes fail', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    state.responses.set('pgrep', { stdout: '', err })
    state.responses.set('launchctl', { stdout: '', err })
    const r = await probeRunningDaemon()
    expect(r.running).toBe(false)
    expect(r.pids).toEqual([])
    expect(r.launchdLabels).toEqual([])
  })

  it('detects via pgrep when chronos-sync is in the process list', async () => {
    state.responses.set('pgrep', { stdout: `${process.pid + 100}\n${process.pid + 200}\n` })
    state.responses.set('launchctl', { stdout: '' })
    const r = await probeRunningDaemon()
    expect(r.running).toBe(true)
    expect(r.pids.sort()).toEqual([process.pid + 100, process.pid + 200].sort())
  })

  it('excludes own PID from pgrep result', async () => {
    state.responses.set('pgrep', { stdout: `${process.pid}\n${process.pid + 50}\n` })
    state.responses.set('launchctl', { stdout: '' })
    const r = await probeRunningDaemon()
    expect(r.pids).toEqual([process.pid + 50])
  })

  it('detects via launchctl when plist is loaded', async () => {
    state.responses.set('pgrep', { stdout: '' })
    state.responses.set('launchctl', {
      stdout:
        `12345\t0\tcom.example.other.tool\n` +
        `9876\t0\tcom.brightworks.chronos-sync\n` +
        `-\t0\tcom.brightworks.chronos-sync.dev\n`,
    })
    const r = await probeRunningDaemon()
    expect(r.running).toBe(true)
    expect(r.launchdLabels).toEqual([
      'com.brightworks.chronos-sync',
      'com.brightworks.chronos-sync.dev',
    ])
    expect(r.pids).toEqual([])
  })

  it('matches launchctl labels case-insensitively', async () => {
    state.responses.set('pgrep', { stdout: '' })
    state.responses.set('launchctl', {
      stdout: `100\t0\tdev.CHRONOS-SYNC.legacy\n`,
    })
    const r = await probeRunningDaemon()
    expect(r.launchdLabels).toEqual(['dev.CHRONOS-SYNC.legacy'])
  })

  it('reports both probes when each detects something', async () => {
    state.responses.set('pgrep', { stdout: `${process.pid + 5}\n` })
    state.responses.set('launchctl', { stdout: `1\t0\tcom.example.chronos-sync\n` })
    const r = await probeRunningDaemon()
    expect(r.running).toBe(true)
    expect(r.pids).toEqual([process.pid + 5])
    expect(r.launchdLabels).toEqual(['com.example.chronos-sync'])
  })
})
