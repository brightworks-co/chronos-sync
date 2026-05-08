import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { listMessages, DEFAULT_MESSAGES_LIMIT } from '../src/kakaocli'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  stderr = new EventEmitter() as EventEmitter & { setEncoding: () => void }
  constructor(private payload: string, private exitCode = 0) {
    super()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
    queueMicrotask(() => {
      this.stdout.emit('data', this.payload)
      this.stdout.emit('end')
      this.stderr.emit('end')
      this.emit('close', this.exitCode)
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listMessages args (v0.3.1 --limit fix)', () => {
  it('forwards --limit with the DEFAULT_MESSAGES_LIMIT when callers do not override', async () => {
    vi.mocked(spawn).mockReturnValueOnce(new FakeChild('[]') as never)
    await listMessages({ chat: 'dho' })

    expect(spawn).toHaveBeenCalledTimes(1)
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('--limit')
    const idx = args.indexOf('--limit')
    expect(args[idx + 1]).toBe(String(DEFAULT_MESSAGES_LIMIT))
  })

  it('forwards a caller-supplied --limit', async () => {
    vi.mocked(spawn).mockReturnValueOnce(new FakeChild('[]') as never)
    await listMessages({ chat: 'dho', limit: 200 })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    const idx = args.indexOf('--limit')
    expect(args[idx + 1]).toBe('200')
  })

  it('keeps --since alongside --limit when both are present', async () => {
    vi.mocked(spawn).mockReturnValueOnce(new FakeChild('[]') as never)
    await listMessages({
      chatId: '12345',
      since: '2026-05-08T00:00:00Z',
      limit: 1000,
    })

    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('--since')
    expect(args).toContain('2026-05-08T00:00:00Z')
    expect(args).toContain('--limit')
    expect(args[args.indexOf('--limit') + 1]).toBe('1000')
  })

  it('default limit is comfortably above the kakaocli default (50) so a 300+ backlog fits in one fetch', () => {
    expect(DEFAULT_MESSAGES_LIMIT).toBeGreaterThanOrEqual(1000)
  })
})
