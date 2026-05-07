import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { maybeStartCaffeinate, maybeStopCaffeinate } from '../src/caffeinate'

function makeChild(pid: number | undefined): EventEmitter & { pid?: number } {
  const ee = new EventEmitter() as EventEmitter & { pid?: number }
  ee.pid = pid
  return ee
}

function makeLog() {
  const calls: Array<{ level: string; msg: string; ctx?: unknown }> = []
  const log = (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => {
    calls.push({ level, msg, ctx })
  }
  return { calls, log }
}

describe('maybeStartCaffeinate (A1, A2)', () => {
  it('A1: spawns caffeinate -i -w <pid> in foreground darwin mode', () => {
    const spawnImpl = vi.fn().mockReturnValue(makeChild(4321))
    const { log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: true,
      log,
      platform: 'darwin',
      env: {},
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(spawnImpl).toHaveBeenCalledWith(
      'caffeinate',
      ['-i', '-w', '1234'],
      expect.objectContaining({ stdio: 'ignore', detached: false })
    )
    expect(guard.pid).toBe(4321)
  })

  it('A1: skips spawn when foreground is false (launchd path)', () => {
    const spawnImpl = vi.fn()
    const { log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: false,
      log,
      platform: 'darwin',
      env: {},
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(guard.pid).toBeUndefined()
  })

  it('A1: skips spawn on linux', () => {
    const spawnImpl = vi.fn()
    const { log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: true,
      log,
      platform: 'linux',
      env: {},
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(guard.pid).toBeUndefined()
  })

  it('A1: skips spawn on win32', () => {
    const spawnImpl = vi.fn()
    const { log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: true,
      log,
      platform: 'win32',
      env: {},
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(guard.pid).toBeUndefined()
  })

  it('A2: skips spawn when CHRONOS_NO_CAFFEINATE=1', () => {
    const spawnImpl = vi.fn()
    const { log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: true,
      log,
      platform: 'darwin',
      env: { CHRONOS_NO_CAFFEINATE: '1' },
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(guard.pid).toBeUndefined()
  })

  it('logs and returns undefined pid when spawn throws (best-effort)', () => {
    const spawnImpl = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { calls, log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: true,
      log,
      platform: 'darwin',
      env: {},
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(guard.pid).toBeUndefined()
    expect(calls.some((c) => c.level === 'warn' && c.msg.includes('caffeinate'))).toBe(
      true
    )
  })

  it('returns undefined pid when child has no pid', () => {
    const spawnImpl = vi.fn().mockReturnValue(makeChild(undefined))
    const { log } = makeLog()
    const guard = maybeStartCaffeinate({
      foreground: true,
      log,
      platform: 'darwin',
      env: {},
      pid: 1234,
      spawnImpl: spawnImpl as never,
    })
    expect(guard.pid).toBeUndefined()
  })
})

describe('maybeStopCaffeinate (A3)', () => {
  it('A3: sends SIGTERM to the caffeinate child on shutdown', () => {
    const killImpl = vi.fn()
    const { calls, log } = makeLog()
    maybeStopCaffeinate({ pid: 4321, log, killImpl })
    expect(killImpl).toHaveBeenCalledTimes(1)
    expect(killImpl).toHaveBeenCalledWith(4321, 'SIGTERM')
    expect(calls.some((c) => c.level === 'info' && c.msg.includes('stopped'))).toBe(
      true
    )
  })

  it('A3: no-op when pid is undefined (guard never spawned)', () => {
    const killImpl = vi.fn()
    const { log } = makeLog()
    maybeStopCaffeinate({ pid: undefined, log, killImpl })
    expect(killImpl).not.toHaveBeenCalled()
  })

  it('swallows kill errors (caffeinate may already be reaped)', () => {
    const killImpl = vi.fn().mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const { calls, log } = makeLog()
    expect(() =>
      maybeStopCaffeinate({ pid: 4321, log, killImpl })
    ).not.toThrow()
    expect(calls.some((c) => c.level === 'warn' && c.msg.includes('kill'))).toBe(true)
  })
})
