/**
 * T-7: PR #7 hold-back invariant regression guard.
 *
 * The daemon MUST NOT send `참여자_<id>` (placeholder names) to the server.
 * When any sender_id cannot be resolved to a display name, the entire cycle
 * is held back: cursor stays put, upload is skipped, consecutive_stuck_cycles
 * increments. This test is a regression guard to ensure this invariant is
 * preserved across all future refactors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCycle } from '../src/daemon'
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
  probeHarvestCapabilities: vi.fn(),
  invalidateProbeCache: vi.fn(),
}))

vi.mock('../src/sender-resolver', () => ({
  resolveSenderNames: vi.fn(),
}))

vi.mock('../src/uploader', () => ({
  Uploader: class {
    async uploadAll() {
      return { messages_processed: 0, nickname_changes: 0, duration_ms: 0, backup_skipped: true }
    }
  },
  UploadError: class extends Error {
    constructor(msg: string) { super(msg) }
  },
}))

vi.mock('../src/notifications', () => ({
  append: vi.fn().mockResolvedValue(undefined),
}))

import { listMessages, harvestScroll } from '../src/kakaocli'
import { resolveSenderNames } from '../src/sender-resolver'

const NOW = Date.UTC(2026, 3, 26, 12, 0, 0)

let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-holdback-test-'))
  process.env.HOME = tmp
  await fs.mkdir(join(tmp, '.chronos'), { recursive: true })
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(harvestScroll).mockResolvedValue({ code: 0, stderr: '' })
  vi.mocked(listMessages).mockResolvedValue([])
  vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
})

afterEach(async () => {
  vi.useRealTimers()
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
      chat_name: 'dho',
      project_id: 'p1',
      room_name: 'dho',
    },
  ],
}

function makeMsg(id: number, ts: number, sender: string | null, sender_id: number | string): KakaoCliMessage {
  return {
    chat_id: 1,
    id,
    sender,
    sender_id,
    text: `msg-${id}`,
    timestamp: ts,
    is_from_me: false,
    type: 'text',
  }
}

describe('PR #7 hold-back invariant — regression guard', () => {
  it('holds back entire cycle and freezes cursor when any sender is unresolved', async () => {
    const cursorMs = NOW - 1000
    const ts1 = NOW - 900
    const ts2 = NOW - 800

    vi.mocked(listMessages).mockResolvedValue([
      makeMsg(1, ts1, null, 111),
      makeMsg(2, ts2, null, 222),
    ])
    // 111 resolves, 222 does NOT
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['111', '이몽룡']]))

    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: cursorMs,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    const logs: Array<{ level: string; msg: string }> = []
    const { outcome } = await runCycle(baseConfig, state, (level, msg) => logs.push({ level, msg }))

    // Upload must NOT happen
    expect(outcome.uploaded_rooms).toBe(0)
    expect(outcome.failed_rooms).toBe(0)

    // Cursor must remain frozen
    const after = getRoomState(state, 'p1', 'dho')
    expect(after.last_synced_ms).toBe(cursorMs)

    // stuck counter increments
    expect(after.consecutive_stuck_cycles).toBe(1)

    // warn log emitted
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('unresolved senders'))).toBe(true)
  })

  it('never sends 참여자_<id> placeholder to the server', async () => {
    const cursorMs = NOW - 1000
    const ts1 = NOW - 900

    vi.mocked(listMessages).mockResolvedValue([
      makeMsg(1, ts1, null, 555),
    ])
    // sender 555 cannot be resolved
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: cursorMs,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    const { outcome } = await runCycle(baseConfig, state, () => {})

    // Upload skipped — 참여자_<id> never reaches the server
    expect(outcome.uploaded_rooms).toBe(0)
    const after = getRoomState(state, 'p1', 'dho')
    expect(after.last_synced_ms).toBe(cursorMs)
  })

  it('consecutive_stuck_cycles increments each held-back cycle', async () => {
    const cursorMs = NOW - 1000
    const ts1 = NOW - 900

    vi.mocked(listMessages).mockResolvedValue([makeMsg(1, ts1, null, 777)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: cursorMs,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    await runCycle(baseConfig, state, () => {})
    expect(getRoomState(state, 'p1', 'dho').consecutive_stuck_cycles).toBe(1)

    await runCycle(baseConfig, state, () => {})
    expect(getRoomState(state, 'p1', 'dho').consecutive_stuck_cycles).toBe(2)
  })

  it('resets consecutive_stuck_cycles and advances cursor when all senders resolve', async () => {
    const cursorMs = NOW - 1000
    const ts1 = NOW - 900

    // First two cycles: unresolved
    vi.mocked(listMessages).mockResolvedValue([makeMsg(1, ts1, null, 888)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: cursorMs,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    await runCycle(baseConfig, state, () => {})
    await runCycle(baseConfig, state, () => {})
    expect(getRoomState(state, 'p1', 'dho').consecutive_stuck_cycles).toBe(2)

    // Third cycle: 888 finally resolves
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['888', '뒤늦게-resolved']]))

    await runCycle(baseConfig, state, () => {})
    const after = getRoomState(state, 'p1', 'dho')
    expect(after.consecutive_stuck_cycles).toBe(0)
    expect(after.last_synced_ms).toBe(ts1)
  })

  it('does not hold back when all senders are resolved', async () => {
    const ts1 = NOW - 900

    vi.mocked(listMessages).mockResolvedValue([
      makeMsg(1, ts1, '이몽룡', 111),
    ])

    const state = emptyState()

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(1)
    const after = getRoomState(state, 'p1', 'dho')
    expect(after.last_synced_ms).toBe(ts1)
    expect(after.consecutive_stuck_cycles ?? 0).toBe(0)
  })

  it('holds back when sender field is empty string (treated as unresolved)', async () => {
    const cursorMs = NOW - 1000
    const ts1 = NOW - 900

    vi.mocked(listMessages).mockResolvedValue([
      makeMsg(1, ts1, '', 999),
    ])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: cursorMs,
      last_success_at: 1,
      consecutive_failures: 0,
    }

    const { outcome } = await runCycle(baseConfig, state, () => {})

    expect(outcome.uploaded_rooms).toBe(0)
    const after = getRoomState(state, 'p1', 'dho')
    expect(after.last_synced_ms).toBe(cursorMs)
  })
})
