import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCycle, computeSince, enrichSenders } from '../src/daemon'
import { emptyState, getRoomState } from '../src/state-file'
import type { DaemonConfig } from '../src/types'
import type { KakaoCliMessage } from '../src/csv-reassemble'

vi.mock('../src/kakaocli', () => ({
  listMessages: vi.fn(),
}))

vi.mock('../src/sender-resolver', () => ({
  resolveSenderNames: vi.fn(),
}))

vi.mock('../src/uploader', () => {
  return {
    Uploader: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async uploadAll(..._args: any[]) {
        return {
          messages_processed: 0,
          nickname_changes: 0,
          duration_ms: 0,
          backup_skipped: true,
        }
      }
    },
    UploadError: class extends Error {
      constructor(msg: string) {
        super(msg)
      }
    },
  }
})

import { listMessages } from '../src/kakaocli'
import { resolveSenderNames } from '../src/sender-resolver'

let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-daemon-test-'))
  process.env.HOME = tmp
  await fs.mkdir(join(tmp, '.chronos'), { recursive: true })
  vi.resetAllMocks()
  vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
})

afterEach(async () => {
  if (process.env.HOME && process.env.HOME !== realHome) {
    await fs.rm(process.env.HOME, { recursive: true, force: true })
  }
  process.env.HOME = realHome
})

const baseConfig: DaemonConfig = {
  server_url: 'http://test',
  pat: 'chr_pat_' + 'a'.repeat(32),
  interval_seconds: 60,
  rooms: [
    {
      chat_name: 'kakao chat A',
      project_id: 'p1',
      room_name: 'room-a',
      kakao_original_name: 'kakao chat A',
    },
  ],
}

describe('runCycle', () => {
  it('skips a room cleanly when kakaocli returns no new messages', async () => {
    vi.mocked(listMessages).mockResolvedValue([])
    const state = emptyState()

    const outcome = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(0)
    expect(outcome.failed_rooms).toBe(0)
    const cursor = getRoomState(state, 'p1', 'room-a')
    expect(cursor.last_synced_ms).toBe(0)
    expect(cursor.consecutive_failures).toBe(0)
  })

  it('advances the cursor and resets failure counter on a successful upload', async () => {
    const ts1 = Date.UTC(2026, 3, 26, 0, 0, 0)
    const ts2 = Date.UTC(2026, 3, 26, 0, 5, 0)
    vi.mocked(listMessages).mockResolvedValue([
      {
        chat_id: 1,
        id: 1,
        sender: '홍길동',
        sender_id: 1,
        text: '안녕',
        timestamp: ts1,
        is_from_me: false,
        type: 'text',
      },
      {
        chat_id: 1,
        id: 2,
        sender: '홍길동',
        sender_id: 1,
        text: '잘 가',
        timestamp: ts2,
        is_from_me: false,
        type: 'text',
      },
    ])
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: 0,
      last_success_at: 0,
      consecutive_failures: 3,
    }

    const outcome = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(1)
    expect(outcome.failed_rooms).toBe(0)
    const cursor = getRoomState(state, 'p1', 'room-a')
    expect(cursor.last_synced_ms).toBe(ts2)
    expect(cursor.consecutive_failures).toBe(0)
    expect(cursor.last_success_at).toBeGreaterThan(0)
  })

  it('routes by chat_id and skips chat_name when both are configured', async () => {
    vi.mocked(listMessages).mockResolvedValue([])
    const state = emptyState()
    const cfg: DaemonConfig = {
      ...baseConfig,
      rooms: [
        {
          chat_name: 'should be ignored',
          chat_id: '18393235298236590',
          project_id: 'p1',
          room_name: 'room-a',
        },
      ],
    }

    await runCycle(cfg, state, () => {})

    expect(listMessages).toHaveBeenCalledTimes(1)
    const call = vi.mocked(listMessages).mock.calls[0][0]
    expect(call.chatId).toBe('18393235298236590')
    expect(call.chat).toBeUndefined()
  })

  it('routes by chat_name when chat_id is absent', async () => {
    vi.mocked(listMessages).mockResolvedValue([])
    const state = emptyState()

    await runCycle(baseConfig, state, () => {})

    expect(listMessages).toHaveBeenCalledTimes(1)
    const call = vi.mocked(listMessages).mock.calls[0][0]
    expect(call.chat).toBe('kakao chat A')
    expect(call.chatId).toBeUndefined()
  })

  it('increments consecutive_failures and leaves cursor untouched when kakaocli throws', async () => {
    vi.mocked(listMessages).mockRejectedValue(new Error('kakaocli boom'))
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: 1000,
      last_success_at: 999,
      consecutive_failures: 1,
    }

    const outcome = await runCycle(baseConfig, state, () => {})

    expect(outcome.failed_rooms).toBe(1)
    const cursor = getRoomState(state, 'p1', 'room-a')
    expect(cursor.last_synced_ms).toBe(1000)
    expect(cursor.consecutive_failures).toBe(2)
  })

  it('updates daemon.last_cycle_at and persists state to disk', async () => {
    vi.mocked(listMessages).mockResolvedValue([])
    const state = emptyState()
    const before = Date.now()

    await runCycle(baseConfig, state, () => {})

    expect(state.daemon.last_cycle_at).toBeGreaterThanOrEqual(before)

    const path = join(process.env.HOME!, '.chronos', 'state.json')
    const raw = await fs.readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.daemon.last_cycle_at).toBe(state.daemon.last_cycle_at)
  })

  it('invokes onRoom listener once per room with success outcomes', async () => {
    const ts1 = Date.UTC(2026, 3, 26, 0, 0, 0)
    vi.mocked(listMessages).mockResolvedValue([
      {
        chat_id: 1,
        id: 1,
        sender: '홍길동',
        sender_id: 1,
        text: '안녕',
        timestamp: ts1,
        is_from_me: false,
        type: 'text',
      },
    ])
    const state = emptyState()
    const calls: Array<{ room: string; new_messages: number; error?: string }> = []

    await runCycle(baseConfig, state, () => {}, (r) =>
      calls.push({ room: r.room.room_name, new_messages: r.new_messages, error: r.error })
    )

    expect(calls).toEqual([{ room: 'room-a', new_messages: 1, error: undefined }])
  })

  it('invokes onRoom listener with error message on failure', async () => {
    vi.mocked(listMessages).mockRejectedValue(new Error('kakaocli boom'))
    const state = emptyState()
    const calls: Array<{ error?: string }> = []

    await runCycle(baseConfig, state, () => {}, (r) => calls.push({ error: r.error }))

    expect(calls).toHaveLength(1)
    expect(calls[0].error).toBe('kakaocli boom')
  })

  it('enriches null sender via resolveSenderNames before reassembly', async () => {
    const ts = Date.UTC(2026, 3, 26, 0, 0, 0)
    vi.mocked(listMessages).mockResolvedValue([
      {
        chat_id: 1,
        id: 1,
        sender: null,
        sender_id: 5283788016742773350,
        text: '안녕',
        timestamp: ts,
        is_from_me: false,
        type: 'text',
      },
    ])
    vi.mocked(resolveSenderNames).mockResolvedValue(
      new Map([['5283788016742773350', '핑님']])
    )

    const state = emptyState()
    await runCycle(baseConfig, state, () => {})

    expect(resolveSenderNames).toHaveBeenCalledTimes(1)
    const [ids] = vi.mocked(resolveSenderNames).mock.calls[0]
    expect(ids).toContain(5283788016742773350)
  })

  it('does not call resolveSenderNames when every row has a sender', async () => {
    const ts = Date.UTC(2026, 3, 26, 0, 0, 0)
    vi.mocked(listMessages).mockResolvedValue([
      {
        chat_id: 1,
        id: 1,
        sender: '핑님',
        sender_id: 1,
        text: '안녕',
        timestamp: ts,
        is_from_me: false,
        type: 'text',
      },
    ])

    const state = emptyState()
    await runCycle(baseConfig, state, () => {})

    expect(resolveSenderNames).not.toHaveBeenCalled()
  })
})

describe('computeSince', () => {
  const cfg: DaemonConfig = {
    server_url: 'http://x',
    pat: 'chr_pat_' + 'a'.repeat(32),
    interval_seconds: 300,
    rooms: [],
  }

  it('returns the cursor ISO string when last_synced_ms is set', () => {
    const ts = Date.UTC(2026, 3, 26, 0, 0, 0)
    const out = computeSince(cfg, { last_synced_ms: ts })
    expect(out).toBe(new Date(ts).toISOString())
  })

  it('returns undefined for a fresh cursor with no since override', () => {
    const out = computeSince(cfg, { last_synced_ms: 0 })
    expect(out).toBeUndefined()
  })

  it('respects since.override_seconds when set', () => {
    const now = Date.UTC(2026, 3, 26, 0, 0, 0)
    const out = computeSince(
      { ...cfg, since: { override_seconds: 600 } },
      { last_synced_ms: 0 },
      now
    )
    expect(out).toBe(new Date(now - 600 * 1000).toISOString())
  })

  it('uses interval × multiplier as fallback', () => {
    const now = Date.UTC(2026, 3, 26, 0, 0, 0)
    const out = computeSince(
      { ...cfg, since: { multiplier: 2 } },
      { last_synced_ms: 0 },
      now
    )
    expect(out).toBe(new Date(now - 600 * 1000).toISOString())
  })

  it('treats override_seconds=0 as "no since"', () => {
    const out = computeSince(
      { ...cfg, since: { override_seconds: 0 } },
      { last_synced_ms: 0 }
    )
    expect(out).toBeUndefined()
  })
})

describe('enrichSenders', () => {
  const ts = Date.UTC(2026, 3, 26, 0, 0, 0)
  // KakaoCliMessage.sender_id is `number` — its in-memory representation
  // already loses precision for ids beyond 2^53. The map returned by
  // resolveSenderNames is keyed by `String(sender_id)` so both sides
  // observe the same lossy value (this matches the production path:
  // kakaocli messages JSON also pre-rounds the same id).
  const lossyId = Number(5283788016742773350)
  const lossyKey = String(lossyId)

  function row(overrides: Partial<KakaoCliMessage> = {}): KakaoCliMessage {
    return {
      chat_id: 1,
      id: 1,
      sender: null,
      sender_id: lossyId,
      text: '안녕',
      timestamp: ts,
      is_from_me: false,
      type: 'text',
      ...overrides,
    }
  }

  it('replaces null sender with NTUser-resolved name', async () => {
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([[lossyKey, '핑님']]))
    const out = await enrichSenders([row()], undefined, () => {})
    expect(out[0].sender).toBe('핑님')
  })

  it('falls back to 참여자_<id> when name not found', async () => {
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
    const out = await enrichSenders([row({ sender_id: 999 })], undefined, () => {})
    expect(out[0].sender).toBe('참여자_999')
  })

  it('preserves a non-null sender as-is', async () => {
    const out = await enrichSenders(
      [row({ sender: '홍길동' })],
      undefined,
      () => {}
    )
    expect(out[0].sender).toBe('홍길동')
    expect(resolveSenderNames).not.toHaveBeenCalled()
  })

  it('uses 나 for is_from_me rows without a sender', async () => {
    const out = await enrichSenders(
      [row({ sender: null, is_from_me: true })],
      undefined,
      () => {}
    )
    expect(out[0].sender).toBe('나')
  })

  it('logs and falls back when resolveSenderNames throws', async () => {
    vi.mocked(resolveSenderNames).mockRejectedValue(new Error('binary missing'))
    const logs: Array<{ level: string; msg: string }> = []
    const out = await enrichSenders(
      [row({ sender_id: 9999 })],
      undefined,
      (level, msg) => logs.push({ level, msg })
    )
    expect(out[0].sender).toBe('참여자_9999')
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('sender resolver'))).toBe(true)
  })
})
