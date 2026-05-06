import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Must be hoisted: vi.mock is hoisted to top of file by vitest
const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

// Import after mock is set up
const { harvestScroll } = await import('../src/kakaocli')

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
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('harvestScroll', () => {
  it('resolves with code 0 on success', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    const result = await harvestScroll({ chat: 'my-room' })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('resolves with non-zero exit code and forwards stderr', async () => {
    spawnMock.mockReturnValue(makeChild(1, 'harvest failed'))
    const result = await harvestScroll({ chat: 'my-room' })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('harvest failed')
  })

  it('passes --max-pages argument when maxPages is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ chat: 'my-room', maxPages: 3 })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--max-pages')
    expect(args[args.indexOf('--max-pages') + 1]).toBe('3')
  })

  it('does not pass --max-pages when maxPages is not set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ chat: 'my-room' })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--max-pages')
  })

  it('prefers chatId over chat when both are supplied', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ chat: 'fallback', chatId: '99999' })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--chat-id')
    expect(args[args.indexOf('--chat-id') + 1]).toBe('99999')
    expect(args).not.toContain('--chat')
  })

  it('uses --chat when only chat is supplied', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ chat: 'my-room' })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--chat')
    expect(args[args.indexOf('--chat') + 1]).toBe('my-room')
  })

  it('throws when neither chat nor chatId is provided', async () => {
    await expect(harvestScroll({})).rejects.toThrow(/chat|chatId/)
  })

  it('resolves with code -1 when spawn times out', async () => {
    spawnMock.mockReturnValue(makeChild(0, '', 500))
    const result = await harvestScroll({ chat: 'my-room', timeoutMs: 50 })
    expect(result.code).toBe(-1)
  })

  it('passes harvest and --scroll as the first two args', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ chat: 'my-room' })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[0]).toBe('harvest')
    expect(args[1]).toBe('--scroll')
  })
})
