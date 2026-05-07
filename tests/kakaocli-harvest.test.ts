import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Must be hoisted: vi.mock is hoisted to top of file by vitest
const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

// Import after mock is set up
const { harvestScroll, invalidateProbeCache } = await import('../src/kakaocli')

function makeChild(exitCode: number, stderrText = '', delayMs = 0) {
  const stdoutEE = new EventEmitter()
  const stderrEE = new EventEmitter()
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = stdoutEE
  child.stderr = stderrEE
  child.kill = vi.fn()

  setTimeout(() => {
    if (stderrText) stderrEE.emit('data', Buffer.from(stderrText))
    child.emit('close', exitCode)
  }, delayMs)

  return child
}

beforeEach(() => {
  spawnMock.mockReset()
  invalidateProbeCache()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('harvestScroll', () => {
  it('resolves with code 0 on success', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    const result = await harvestScroll({})
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('resolves with non-zero exit code and forwards stderr', async () => {
    spawnMock.mockReturnValue(makeChild(1, 'harvest failed'))
    const result = await harvestScroll({})
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('harvest failed')
  })

  it('passes --max-clicks argument when maxClicks is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ maxClicks: 3 })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--max-clicks')
    expect(args[args.indexOf('--max-clicks') + 1]).toBe('3')
  })

  it('does not pass --max-clicks when maxClicks is not set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--max-clicks')
  })

  it('passes --top when top is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ top: 5 })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--top')
    expect(args[args.indexOf('--top') + 1]).toBe('5')
  })

  it('does not pass --chat or --chat-id (kakaocli 0.4.1 harvest has no per-room flag)', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--chat')
    expect(args).not.toContain('--chat-id')
  })

  it('does not pass --max-pages (removed in 0.4.1)', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--max-pages')
  })

  it('resolves with code -1 when spawn times out', async () => {
    spawnMock.mockReturnValue(makeChild(0, '', 500))
    const result = await harvestScroll({ timeoutMs: 50 })
    expect(result.code).toBe(-1)
  })

  it('passes harvest and --scroll as the first two args', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[0]).toBe('harvest')
    expect(args[1]).toBe('--scroll')
  })
})
