import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

const { harvestScroll, probeHarvestCapabilities, invalidateProbeCache } = await import('../src/kakaocli')

function makeChild(exitCode: number, stdout = '', stderr = '', delayMs = 0) {
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
    if (stdout) stdoutEE.emit('data', Buffer.from(stdout))
    if (stderr) stderrEE.emit('data', Buffer.from(stderr))
    child.emit('close', exitCode)
  }, delayMs)

  return child
}

const HARVEST_HELP = `OVERVIEW: Capture chat names and load message history from KakaoTalk UI

USAGE: kakaocli harvest [--top <top>] [--scroll] [--max-clicks <max-clicks>] [--scroll-delay <scroll-delay>] [--dry-run] [--db <db>] [--key <key>]

OPTIONS:
  --top <top>             Process top N most recent chats (default: all)
  --scroll                Open chats and load history via scroll
  --max-clicks <max-clicks>  Max 'View Previous Chats' clicks per chat (default: 10)
  --scroll-delay <scroll-delay>  Delay between actions in seconds (default: 1.5)
  --dry-run               Show what would be done without doing it
  --db <db>               Path to database file
  --key <key>             Database encryption key
  --version               Show the version.
  -h, --help              Show help information.
`

beforeEach(() => {
  spawnMock.mockReset()
  invalidateProbeCache()
})

afterEach(() => {
  vi.clearAllMocks()
})

// AC-1 regression: --chat-id and --max-pages must never appear
describe('harvestScroll — kakaocli 0.4.1 surface regression', () => {
  it('never passes --chat-id in args', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--chat-id')
  })

  it('never passes --max-pages in args', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--max-pages')
  })

  it('always passes harvest and --scroll as the first two args', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[0]).toBe('harvest')
    expect(args[1]).toBe('--scroll')
  })
})

describe('harvestScroll — 0.4.1 flag surface', () => {
  it('passes --top when top is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ top: 5 })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--top')
    expect(args[args.indexOf('--top') + 1]).toBe('5')
  })

  it('does not pass --top when top is not set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({})
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--top')
  })

  it('passes --max-clicks when maxClicks is set', async () => {
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

  it('passes --scroll-delay when scrollDelay is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ scrollDelay: 2.0 })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--scroll-delay')
    expect(args[args.indexOf('--scroll-delay') + 1]).toBe('2')
  })

  it('passes --dry-run when dryRun is true', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ dryRun: true })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--dry-run')
  })

  it('does not pass --dry-run when dryRun is false', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ dryRun: false })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('--dry-run')
  })

  it('passes --db when db is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ db: '/path/to/db' })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--db')
    expect(args[args.indexOf('--db') + 1]).toBe('/path/to/db')
  })

  it('passes --key when key is set', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    await harvestScroll({ key: 'secret' })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--key')
    expect(args[args.indexOf('--key') + 1]).toBe('secret')
  })
})

describe('harvestScroll — result handling', () => {
  it('resolves with code 0 on success', async () => {
    spawnMock.mockReturnValue(makeChild(0))
    const result = await harvestScroll({})
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('resolves with non-zero exit code and forwards stderr', async () => {
    spawnMock.mockReturnValue(makeChild(1, '', 'harvest failed'))
    const result = await harvestScroll({})
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('harvest failed')
  })

  it('resolves with code -1 when spawn times out', async () => {
    spawnMock.mockReturnValue(makeChild(0, '', '', 500))
    const result = await harvestScroll({ timeoutMs: 50 })
    expect(result.code).toBe(-1)
  })
})

// AC-10: probe cache invalidated on exit-64
describe('harvestScroll — exit-64 invalidates probe cache', () => {
  it('invalidates probe cache on exit 64 so next probeHarvestCapabilities re-spawns', async () => {
    spawnMock
      .mockReturnValueOnce(makeChild(64, '', "Error: Unknown option '--chat-id'"))
      .mockReturnValueOnce(makeChild(0, HARVEST_HELP))

    await harvestScroll({})
    // probe cache was invalidated; next call should re-spawn
    await probeHarvestCapabilities()
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const probeArgs = spawnMock.mock.calls[1][1] as string[]
    expect(probeArgs).toEqual(['harvest', '--help'])
  })

  it('does not invalidate probe cache on non-64 exit', async () => {
    spawnMock
      .mockReturnValueOnce(makeChild(0, HARVEST_HELP))
      .mockReturnValueOnce(makeChild(1, '', 'some error'))

    await probeHarvestCapabilities()
    await harvestScroll({})
    // probe cache intact; calling probeHarvestCapabilities again should NOT re-spawn
    await probeHarvestCapabilities()
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})

describe('probeHarvestCapabilities', () => {
  it('returns scrollSupported=true when --scroll appears in help', async () => {
    spawnMock.mockReturnValue(makeChild(0, HARVEST_HELP))
    const caps = await probeHarvestCapabilities()
    expect(caps.scrollSupported).toBe(true)
  })

  it('returns scrollSupported=false when --scroll is absent from help', async () => {
    spawnMock.mockReturnValue(makeChild(0, 'USAGE: kakaocli harvest [--top <top>]\nOPTIONS:\n  --top <top>  Process top N\n'))
    const caps = await probeHarvestCapabilities()
    expect(caps.scrollSupported).toBe(false)
  })

  it('includes known 0.4.1 flags in result', async () => {
    spawnMock.mockReturnValue(makeChild(0, HARVEST_HELP))
    const caps = await probeHarvestCapabilities()
    expect(caps.flags).toContain('--scroll')
    expect(caps.flags).toContain('--top')
    expect(caps.flags).toContain('--max-clicks')
    expect(caps.flags).toContain('--scroll-delay')
    expect(caps.flags).toContain('--dry-run')
    expect(caps.flags).toContain('--db')
    expect(caps.flags).toContain('--key')
  })

  it('does not include --chat-id or --max-pages in 0.4.1 probe result', async () => {
    spawnMock.mockReturnValue(makeChild(0, HARVEST_HELP))
    const caps = await probeHarvestCapabilities()
    expect(caps.flags).not.toContain('--chat-id')
    expect(caps.flags).not.toContain('--max-pages')
  })

  it('caches result and does not re-spawn on second call', async () => {
    spawnMock.mockImplementation(() => makeChild(0, HARVEST_HELP))
    await probeHarvestCapabilities()
    await probeHarvestCapabilities()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('re-spawns after invalidateProbeCache()', async () => {
    spawnMock.mockImplementation(() => makeChild(0, HARVEST_HELP))
    await probeHarvestCapabilities()
    invalidateProbeCache()
    await probeHarvestCapabilities()
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
