/**
 * AC-5: stuck-nudge idempotency
 *
 * daemonRuntime.stuck_nudge_flags deduplicates notifications so that:
 *   - exactly 1 append call fires when consecutive_stuck_cycles first reaches
 *     the threshold (DEFAULT_HARVEST_STUCK_NUDGE_THRESHOLD = 5)
 *   - subsequent stuck cycles (K+1, K+2, K+3) produce 0 additional calls
 *   - a success cycle clears the flag
 *   - the next stuck sequence past threshold fires exactly 1 more call
 *
 * Because daemonRuntime is module-level and resets only in runLoop (not
 * between runCycle calls), tests within a describe block share the same
 * runtime state — this is intentional and mirrors the production path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCycle } from '../src/daemon'
import { emptyState, getRoomState } from '../src/state-file'
import type { DaemonConfig } from '../src/types'
import type { KakaoCliMessage } from '../src/csv-reassemble'
import { DEFAULT_HARVEST_STUCK_NUDGE_THRESHOLD } from '../src/types'

const bootstrapMocks = vi.hoisted(() => ({
  primeBootstrap: vi.fn(),
  getBootstrap: vi.fn(),
  peekCachedSnapshot: vi.fn(),
  bootstrapStatusLabel: vi.fn(),
  loadCachedSnapshotFromDisk: vi.fn(),
  resetBootstrapCacheForTest: vi.fn(),
}))
vi.mock('../src/bootstrap-resolver', () => bootstrapMocks)

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
import { append } from '../src/notifications'

// Fixed point in time — recent enough that no room triggers harvest
const NOW = Date.UTC(2026, 3, 26, 12, 0, 0)
const K = DEFAULT_HARVEST_STUCK_NUDGE_THRESHOLD

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

function makeMsg(
  id: number,
  ts: number,
  sender: string | null,
  sender_id: number,
): KakaoCliMessage {
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

let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-sticknudge-test-'))
  process.env.HOME = tmp
  await fs.mkdir(join(tmp, '.chronos'), { recursive: true })
  vi.resetAllMocks()
  // Re-establish bootstrap-resolver mock defaults wiped by resetAllMocks().
  bootstrapMocks.getBootstrap.mockReturnValue({
    snapshot: null,
    warning: null,
    refuse: false,
    status: 'ok',
  })
  bootstrapMocks.peekCachedSnapshot.mockReturnValue(null)
  bootstrapMocks.bootstrapStatusLabel.mockReturnValue('ok (1s ago)')
  bootstrapMocks.loadCachedSnapshotFromDisk.mockResolvedValue(null)
  bootstrapMocks.primeBootstrap.mockResolvedValue(undefined)
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

describe('AC-5: stuck-nudge idempotency', () => {
  it(`fires exactly 1 append at cycle ${K}, then 0 more for K+1..K+3, then 1 more after a success cycle`, async () => {
    const cursorMs = NOW - 1000
    const ts1 = NOW - 900

    // Unresolved sender — holds back the cycle each time
    vi.mocked(listMessages).mockResolvedValue([makeMsg(1, ts1, null, 777)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    // Set recent cursor so harvest grace does NOT fire
    state.rooms['p1:dho'] = {
      last_synced_ms: cursorMs,
      last_success_at: NOW - 500,
      consecutive_failures: 0,
    }

    // Run K-1 cycles — nudge must NOT fire yet
    for (let i = 0; i < K - 1; i++) {
      await runCycle(baseConfig, state, () => {})
    }
    expect(vi.mocked(append)).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error_user_actionable' }),
    )

    // Cycle K — nudge fires exactly once
    await runCycle(baseConfig, state, () => {})
    expect(vi.mocked(append)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(append)).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error_user_actionable' }),
    )

    const callsAfterK = vi.mocked(append).mock.calls.length

    // Cycles K+1, K+2, K+3 — no additional error_user_actionable calls
    for (let i = 0; i < 3; i++) {
      await runCycle(baseConfig, state, () => {})
    }
    const errorCalls = vi.mocked(append).mock.calls.filter(
      (args) =>
        typeof args[0] === 'object' &&
        args[0] !== null &&
        (args[0] as { level?: string }).level === 'error_user_actionable',
    )
    expect(errorCalls.length).toBe(callsAfterK)

    // Success cycle — all senders resolve → stuck_nudge_flags cleared
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map([['777', '이몽룡']]))
    await runCycle(baseConfig, state, () => {})

    const afterSuccess = getRoomState(state, 'p1', 'dho')
    expect(afterSuccess.consecutive_stuck_cycles ?? 0).toBe(0)

    // Post-success: run K more stuck cycles — must fire exactly 1 more.
    // After the success cycle the cursor advanced to ts1, so the same ts1
    // message would be filtered out (ts <= cursor). Use a newer timestamp.
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())
    const ts2 = NOW - 500
    vi.mocked(listMessages).mockResolvedValue([makeMsg(2, ts2, null, 777)])

    const callsBeforeSecondSeq = vi.mocked(append).mock.calls.filter(
      (args) =>
        typeof args[0] === 'object' &&
        args[0] !== null &&
        (args[0] as { level?: string }).level === 'error_user_actionable',
    ).length

    for (let i = 0; i < K; i++) {
      await runCycle(baseConfig, state, () => {})
    }

    const callsAfterSecondSeq = vi.mocked(append).mock.calls.filter(
      (args) =>
        typeof args[0] === 'object' &&
        args[0] !== null &&
        (args[0] as { level?: string }).level === 'error_user_actionable',
    ).length

    expect(callsAfterSecondSeq - callsBeforeSecondSeq).toBe(1)
  })

  it('nudge contains room_name and project_id in ctx', async () => {
    // Use a different room so daemonRuntime.stuck_nudge_flags from the
    // previous test ('p1/dho') does not interfere.
    const cfg2: DaemonConfig = {
      ...baseConfig,
      rooms: [
        {
          chat_name: 'dho2',
          project_id: 'p1',
          room_name: 'dho2',
        },
      ],
    }

    const cursorMs = NOW - 1000
    const ts1 = NOW - 900

    vi.mocked(listMessages).mockResolvedValue([makeMsg(2, ts1, null, 888)])
    vi.mocked(resolveSenderNames).mockResolvedValue(new Map())

    const state = emptyState()
    state.rooms['p1:dho2'] = {
      last_synced_ms: cursorMs,
      last_success_at: NOW - 500,
      consecutive_failures: 0,
    }

    for (let i = 0; i < K; i++) {
      await runCycle(cfg2, state, () => {})
    }

    const errorCalls = vi.mocked(append).mock.calls.filter(
      (args) =>
        typeof args[0] === 'object' &&
        args[0] !== null &&
        (args[0] as { level?: string }).level === 'error_user_actionable',
    )
    // Only the calls from this test's room — filter by ctx.room_name
    const roomCalls = errorCalls.filter(
      (args) => (args[0] as { ctx?: Record<string, unknown> }).ctx?.room_name === 'dho2',
    )
    expect(roomCalls.length).toBe(1)

    const rec = roomCalls[0][0] as { ctx?: Record<string, unknown> }
    expect(rec.ctx?.room_name).toBe('dho2')
    expect(rec.ctx?.project_id).toBe('p1')
    expect(rec.ctx?.consecutive_stuck_cycles).toBe(K)
  })
})
