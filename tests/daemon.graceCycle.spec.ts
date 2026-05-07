/**
 * AC-15: grace cycle — consecutive_stuck_cycles NOT incremented on harvest cycle
 *
 * When harvestScroll runs in a cycle (harvestedThisCycle=true) and senders are
 * still unresolved, the room's consecutive_stuck_cycles must NOT increment.
 * NTUser may still be settling — one grace period is given before counting.
 *
 * On the next cycle without harvest (rate-limited), the counter increments by 1.
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
  primeIntervalCache: vi.fn().mockResolvedValue(undefined),
  getCachedInterval: vi.fn().mockReturnValue({
    value: 60,
    source: 'config',
    fetched_at: new Date().toISOString(),
    warning: null,
  }),
  resetIntervalCacheForTest: vi.fn(),
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
    constructor(msg: string) {
      super(msg)
    }
  },
}))

vi.mock('../src/notifications', () => ({
  append: vi.fn().mockResolvedValue(undefined),
}))

import { listMessages, harvestScroll } from '../src/kakaocli'
import { resolveSenderNames } from '../src/sender-resolver'

// Fixed point in time
const NOW = Date.UTC(2026, 3, 26, 12, 0, 0)

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

function makeMsg(id: number, ts: number): KakaoCliMessage {
  return {
    chat_id: 1,
    id,
    sender: null,
    sender_id: 777,
    text: `msg-${id}`,
    timestamp: ts,
    is_from_me: false,
    type: 'text',
  }
}

let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-gracecycle-test-'))
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

describe('AC-15: grace cycle', () => {
  it('does not increment consecutive_stuck_cycles when harvest ran in the same cycle', async () => {
    const ts1 = NOW - 900

    // Unresolved sender — holds back cycle
    vi.mocked(listMessages).mockResolvedValue([makeMsg(1, ts1)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    // State: cursor = 0 (stale, startup_old triggers harvest on cycle 1)
    // last_harvest_at = 0 (never) so rate limit does not suppress
    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: 0,
      last_success_at: 0,
      consecutive_failures: 0,
    }

    // Cycle N: harvest fires (startup_old), harvestedThisCycle=true
    await runCycle(baseConfig, state, () => {})

    expect(vi.mocked(harvestScroll)).toHaveBeenCalledTimes(1)

    // consecutive_stuck_cycles must NOT increment on a harvest cycle (grace)
    const afterCycleN = getRoomState(state, 'p1', 'dho')
    expect(afterCycleN.consecutive_stuck_cycles ?? 0).toBe(0)
  })

  it('increments consecutive_stuck_cycles by 1 on the next non-harvest cycle', async () => {
    const ts1 = NOW - 900

    vi.mocked(listMessages).mockResolvedValue([makeMsg(1, ts1)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    state.rooms['p1:dho'] = {
      last_synced_ms: 0,
      last_success_at: 0,
      consecutive_failures: 0,
    }

    // Cycle N: harvest fires, grace → stuck stays at 0
    await runCycle(baseConfig, state, () => {})
    expect((getRoomState(state, 'p1', 'dho').consecutive_stuck_cycles) ?? 0).toBe(0)

    // Cycle N+1: harvest is now rate-limited (just ran), harvestedThisCycle=false
    // Use a newer message timestamp so it isn't filtered by the cursor check.
    // cursor is still 0 (held back), so any ts > 0 passes the filter.
    vi.mocked(listMessages).mockResolvedValue([makeMsg(2, ts1 + 100)])
    await runCycle(baseConfig, state, () => {})

    expect(vi.mocked(harvestScroll)).toHaveBeenCalledTimes(1) // still only 1 call total
    expect(getRoomState(state, 'p1', 'dho').consecutive_stuck_cycles).toBe(1)
  })
})
