import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCycle, computeSince, enrichSenders } from '../src/daemon'
import { emptyState, getRoomState } from '../src/state-file'
import type { DaemonConfig } from '../src/types'
import type { KakaoCliMessage } from '../src/csv-reassemble'

vi.mock('../src/interval-resolver', () => ({
  resolveInterval: vi.fn().mockResolvedValue({
    value: 60,
    source: 'config',
    fetched_at: new Date().toISOString(),
    warning: null,
  }),
}))

vi.mock('../src/kakaocli', () => ({
  listMessages: vi.fn(),
  harvestScroll: vi.fn(),
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

import { listMessages, harvestScroll } from '../src/kakaocli'
import { resolveSenderNames } from '../src/sender-resolver'

let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-daemon-test-'))
  process.env.HOME = tmp
  await fs.mkdir(join(tmp, '.chronos'), { recursive: true })
  vi.resetAllMocks()
  vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
  // harvestScroll is called when last_synced_ms=0 on cycle 1 (startup_old).
  // Default it to a no-op so existing tests aren't disrupted.
  vi.mocked(harvestScroll).mockResolvedValue({ code: 0, stderr: '' })
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

    const { outcome } = await runCycle(baseConfig, state, () => {})

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

    const { outcome } = await runCycle(baseConfig, state, () => {})

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

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.failed_rooms).toBe(1)
    const cursor = getRoomState(state, 'p1', 'room-a')
    expect(cursor.last_synced_ms).toBe(1000)
    expect(cursor.consecutive_failures).toBe(2)
  })

  it('increments cycle_index on each runCycle call', async () => {
    vi.mocked(listMessages).mockResolvedValue([])
    const state = emptyState()
    expect(state.daemon.cycle_index).toBe(0)

    await runCycle(baseConfig, state, () => {})
    expect(state.daemon.cycle_index).toBe(1)

    await runCycle(baseConfig, state, () => {})
    expect(state.daemon.cycle_index).toBe(2)
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
    // Production path: kakaocli output flows through preserveBigIntPrecision
    // so 19-digit sender_id arrives as an exact JSON string. enrichSenders
    // forwards that exact string to the resolver — no JS number rounding.
    vi.mocked(listMessages).mockResolvedValue([
      {
        chat_id: 1,
        id: 1,
        sender: null,
        sender_id: '5283788016742773350',
        text: '안녕',
        timestamp: ts,
        is_from_me: false,
        type: 'text',
      },
    ])
    vi.mocked(resolveSenderNames).mockResolvedValue(
      new Map([['5283788016742773350', '이몽룡']])
    )

    const state = emptyState()
    await runCycle(baseConfig, state, () => {})

    expect(resolveSenderNames).toHaveBeenCalledTimes(1)
    const [ids] = vi.mocked(resolveSenderNames).mock.calls[0]
    expect(ids).toContain('5283788016742773350')
  })

  it('does not call resolveSenderNames when every row has a sender', async () => {
    const ts = Date.UTC(2026, 3, 26, 0, 0, 0)
    vi.mocked(listMessages).mockResolvedValue([
      {
        chat_id: 1,
        id: 1,
        sender: '이몽룡',
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
  // Real-world 19-digit BigInt sender_id from the dho open chat. After
  // preserveBigIntPrecision (kakaocli.ts) it arrives as an exact string
  // — that exact form is what the resolver's SQL `WHERE userId IN (...)`
  // needs to hit the right NTUser row.
  const exactSenderId = '5283788016742773350'

  function row(overrides: Partial<KakaoCliMessage> = {}): KakaoCliMessage {
    return {
      chat_id: 1,
      id: 1,
      sender: null,
      sender_id: exactSenderId,
      text: '안녕',
      timestamp: ts,
      is_from_me: false,
      type: 'text',
      ...overrides,
    }
  }

  it('replaces null sender with NTUser-resolved name', async () => {
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([[exactSenderId, '이몽룡']]))
    const out = await enrichSenders([row()], undefined, () => {})
    expect(out[0].sender).toBe('이몽룡')
  })

  it('leaves sender as null when name not found (caller holds back the cycle — no 참여자_<id> ever sent)', async () => {
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
    const out = await enrichSenders([row({ sender_id: 999 })], undefined, () => {})
    expect(out[0].sender).toBeNull()
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

  it('logs and leaves sender null when resolveSenderNames throws (caller will hold back the cycle)', async () => {
    vi.mocked(resolveSenderNames).mockRejectedValue(new Error('binary missing'))
    const logs: Array<{ level: string; msg: string }> = []
    const out = await enrichSenders(
      [row({ sender_id: 9999 })],
      undefined,
      (level, msg) => logs.push({ level, msg })
    )
    expect(out[0].sender).toBeNull()
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('sender resolver'))).toBe(true)
  })

  it('passes string sender_id (BigInt-shaped) through to the resolver verbatim — no precision loss', async () => {
    // Regression: before preserveBigIntPrecision, kakaocli emitted bare
    // 19-digit numbers and JSON.parse rounded them, so the SQL JOIN
    // missed and PR #7 stalled the cycle indefinitely. The resolver
    // must now receive the exact original digits.
    const captured: Array<ReadonlyArray<number | string>> = []
    vi.mocked(resolveSenderNames).mockImplementation(async (ids) => {
      captured.push(ids)
      return new Map([[exactSenderId, '참가자C']])
    })
    const out = await enrichSenders([row()], undefined, () => {})
    expect(out[0].sender).toBe('참가자C')
    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain(exactSenderId)
    // The number-rounded form must NOT be what we sent the resolver.
    expect(captured[0]).not.toContain('5283788016742774000')
  })

  it('accepts numeric sender_id below MAX_SAFE_INTEGER and stringifies it for the resolver', async () => {
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['42', '안전']]))
    const out = await enrichSenders([row({ sender_id: 42 })], undefined, () => {})
    expect(out[0].sender).toBe('안전')
  })
})

describe('runCycle harvest integration', () => {
  const NOW = Date.UTC(2026, 3, 26, 12, 0, 0)

  beforeEach(() => {
    vi.mocked(harvestScroll).mockResolvedValue({ code: 0, stderr: '' })
    vi.mocked(listMessages).mockResolvedValue([])
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls harvestScroll on cycle 1 when last_synced_ms is stale (startup_old)', async () => {
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: NOW - 25 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }

    await runCycle(baseConfig, state, () => {})

    expect(harvestScroll).toHaveBeenCalledTimes(1)
    const call = vi.mocked(harvestScroll).mock.calls[0][0]
    // kakaocli 0.4.1: harvest is not per-room; chat/chatId removed, top used instead
    expect(call.top).toBe(5)
  })

  it('AC-2: calls harvestScroll exactly once even when multiple rooms are stale', async () => {
    const twoRoomConfig: DaemonConfig = {
      ...baseConfig,
      rooms: [
        { chat_name: 'kakao chat A', project_id: 'p1', room_name: 'room-a' },
        { chat_name: 'kakao chat B', project_id: 'p1', room_name: 'room-b' },
      ],
    }
    const state = emptyState()
    // Both rooms stale beyond 24h startup threshold
    state.rooms['p1:room-a'] = {
      last_synced_ms: NOW - 25 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }
    state.rooms['p1:room-b'] = {
      last_synced_ms: NOW - 25 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }

    await runCycle(twoRoomConfig, state, () => {})

    // Cycle-scope hoist: single spawn regardless of how many rooms triggered
    expect(harvestScroll).toHaveBeenCalledTimes(1)
  })

  it('does not call harvestScroll when decision is null', async () => {
    const state = emptyState()
    // cycle_index starts at 0, incremented to 1 inside runCycle → startup check applies
    // but last_synced_ms is only 1h ago, well within 24h startup threshold
    state.rooms['p1:room-a'] = {
      last_synced_ms: NOW - 1 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }

    await runCycle(baseConfig, state, () => {})

    expect(harvestScroll).not.toHaveBeenCalled()
  })

  it('sets state.daemon.last_harvest_at after harvestScroll is called', async () => {
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: NOW - 25 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }

    await runCycle(baseConfig, state, () => {})

    expect(state.daemon.last_harvest_at).toBeGreaterThan(0)
    expect(state.daemon.last_harvest_at).toBe(NOW)
  })

  it('logs warn and continues sync when harvestScroll returns non-zero code', async () => {
    vi.mocked(harvestScroll).mockResolvedValue({ code: 1, stderr: 'harvest error' })
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: NOW - 25 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }
    const logs: Array<{ level: string; msg: string }> = []

    await runCycle(baseConfig, state, (level, msg) => logs.push({ level, msg }))

    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('non-zero'))).toBe(true)
    expect(listMessages).toHaveBeenCalled()
  })

  it('invokes onHarvest callback with trigger info', async () => {
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: NOW - 25 * 3600 * 1000,
      last_success_at: 0,
      consecutive_failures: 0,
    }
    const harvestEvents: Array<{ roomName: string; reason: string | null; code?: number }> = []

    await runCycle(baseConfig, state, () => {}, undefined, (info) => harvestEvents.push(info))

    expect(harvestEvents).toHaveLength(1)
    expect(harvestEvents[0].roomName).toBe('room-a')
    expect(harvestEvents[0].reason).toBe('startup_old')
    expect(harvestEvents[0].code).toBe(0)
  })
})

describe('runCycle — client-side post-filter (kakaocli --since not honored)', () => {
  const mkMsg = (id: number, ts: number, text = `m${id}`): KakaoCliMessage => ({
    chat_id: 1,
    id,
    sender: '홍길동',
    sender_id: 1,
    text,
    timestamp: ts,
    is_from_me: false,
    type: 'text',
  })

  it('skips upload when every kakaocli message is older than the cursor', async () => {
    const cursor = Date.UTC(2026, 3, 26, 1, 0, 0)
    const olderTs1 = Date.UTC(2026, 3, 26, 0, 0, 0)
    const olderTs2 = Date.UTC(2026, 3, 26, 0, 30, 0)
    vi.mocked(listMessages).mockResolvedValue([mkMsg(1, olderTs1), mkMsg(2, olderTs2)])
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: cursor,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(0)
    expect(outcome.failed_rooms).toBe(0)
    const after = getRoomState(state, 'p1', 'room-a')
    expect(after.last_synced_ms).toBe(cursor)
    expect(after.consecutive_failures).toBe(0)
  })

  it('uploads only messages newer than cursor and advances cursor to filtered max', async () => {
    const cursor = Date.UTC(2026, 3, 26, 1, 0, 0)
    const olderTs = Date.UTC(2026, 3, 26, 0, 0, 0)
    const newerTs1 = Date.UTC(2026, 3, 26, 2, 0, 0)
    const newerTs2 = Date.UTC(2026, 3, 26, 3, 0, 0)
    vi.mocked(listMessages).mockResolvedValue([
      mkMsg(1, olderTs, 'old'),
      mkMsg(2, newerTs1, 'new1'),
      mkMsg(3, newerTs2, 'new2'),
    ])
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: cursor,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(1)
    const after = getRoomState(state, 'p1', 'room-a')
    expect(after.last_synced_ms).toBe(newerTs2)
  })

  it('does not skip when cursor is 0 (first cycle bootstraps with all messages)', async () => {
    const ts1 = Date.UTC(2026, 3, 26, 0, 0, 0)
    const ts2 = Date.UTC(2026, 3, 26, 0, 5, 0)
    vi.mocked(listMessages).mockResolvedValue([mkMsg(1, ts1), mkMsg(2, ts2)])
    const state = emptyState()
    // last_synced_ms left at 0 (default)

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(1)
    const after = getRoomState(state, 'p1', 'room-a')
    expect(after.last_synced_ms).toBe(ts2)
  })
})

describe('runCycle — strict skip on unresolved senders (no 참여자_<id> ever sent)', () => {
  const STUCK_NOW = Date.UTC(2026, 3, 26, 12, 0, 0)

  const mkMsgNullSender = (id: number, ts: number, sender_id: number): KakaoCliMessage => ({
    chat_id: 1,
    id,
    sender: null,
    sender_id,
    text: `m${id}`,
    timestamp: ts,
    is_from_me: false,
    type: 'text',
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STUCK_NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds back the entire cycle when a single sender_id cannot be resolved, leaving the cursor untouched', async () => {
    // Use a very recent cursor so harvest does not fire (no grace cycle interference).
    const cursor = STUCK_NOW - 1000
    const ts1 = STUCK_NOW - 900
    const ts2 = STUCK_NOW - 800
    vi.mocked(listMessages).mockResolvedValue([
      mkMsgNullSender(1, ts1, 111),
      mkMsgNullSender(2, ts2, 222),
    ])
    // 111 resolves, 222 does NOT — cycle must skip everything.
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['111', '이몽룡']]))
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: cursor,
      last_success_at: 1,
      consecutive_failures: 0,
    }
    const logs: Array<{ level: string; msg: string }> = []

    const { outcome } = await runCycle(baseConfig, state, (level, msg) =>
      logs.push({ level, msg })
    )

    expect(outcome.uploaded_rooms).toBe(0)
    expect(outcome.failed_rooms).toBe(0)
    const after = getRoomState(state, 'p1', 'room-a')
    expect(after.last_synced_ms).toBe(cursor)
    expect(after.consecutive_stuck_cycles).toBe(1)
    expect(
      logs.some((l) => l.level === 'warn' && l.msg.includes('unresolved senders'))
    ).toBe(true)
  })

  it('increments consecutive_stuck_cycles each held-back cycle and resets to 0 on a clean cycle', async () => {
    // Use a very recent cursor so harvest does not fire (no grace cycle interference).
    const cursor = STUCK_NOW - 1000
    const ts1 = STUCK_NOW - 900
    vi.mocked(listMessages).mockResolvedValue([mkMsgNullSender(1, ts1, 555)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
    const state = emptyState()
    state.rooms['p1:room-a'] = {
      last_synced_ms: cursor,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    await runCycle(baseConfig, state, () => {})
    expect(getRoomState(state, 'p1', 'room-a').consecutive_stuck_cycles).toBe(1)

    await runCycle(baseConfig, state, () => {})
    expect(getRoomState(state, 'p1', 'room-a').consecutive_stuck_cycles).toBe(2)

    // Third cycle: 555 finally resolves → counter resets, cursor advances.
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['555', '뒤늦게-resolved']]))

    await runCycle(baseConfig, state, () => {})
    const after = getRoomState(state, 'p1', 'room-a')
    expect(after.consecutive_stuck_cycles).toBe(0)
    expect(after.last_synced_ms).toBe(ts1)
  })

  it('uploads cleanly when every sender resolves (no held-back path triggered)', async () => {
    const ts1 = Date.UTC(2026, 3, 26, 0, 5, 0)
    vi.mocked(listMessages).mockResolvedValue([mkMsgNullSender(1, ts1, 777)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['777', '잘-resolved']]))
    const state = emptyState()

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(1)
    const after = getRoomState(state, 'p1', 'room-a')
    expect(after.last_synced_ms).toBe(ts1)
    expect(after.consecutive_stuck_cycles).toBe(0)
  })
})
