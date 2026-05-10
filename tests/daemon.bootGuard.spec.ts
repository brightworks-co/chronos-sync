/**
 * AC-14: boot rate-limit guard
 *
 * When state.json already contains a recent last_harvest_at the daemon MUST
 * suppress the startup_old harvest trigger (rate-limited_skip). When the
 * stored last_harvest_at is old enough (exceeds rate_limit_seconds) the
 * trigger must fire.
 *
 * The test drives runCycle directly (cycleIndex=1 path) and measures
 * harvestScroll call count.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCycle } from '../src/daemon'
import { emptyState } from '../src/state-file'
import type { DaemonConfig } from '../src/types'
import { DEFAULT_HARVEST_RATE_LIMIT_SECONDS } from '../src/types'

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

// Fixed point in time
const NOW = Date.UTC(2026, 3, 26, 12, 0, 0)

// Default rate limit is 1800 s (30 min).
// 15 min ago → within limit → suppress
const WITHIN_RATE_LIMIT_MS = NOW - 15 * 60 * 1000
// 62 min ago → beyond limit → allow
const BEYOND_RATE_LIMIT_MS = NOW - 62 * 60 * 1000

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

let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-bootguard-test-'))
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

describe('AC-14: boot rate-limit guard', () => {
  it('suppresses startup_old harvest when last_harvest_at is within rate_limit_seconds', async () => {
    // Seed state with a recent harvest and a stale room cursor (startup_old candidate).
    // Room cursor = 0 (never synced) → would trigger startup_old on cycle 1 but
    // daemon-scope rate limit (15 min < 30 min) must suppress it.
    const state = emptyState()
    state.daemon.last_harvest_at = WITHIN_RATE_LIMIT_MS
    state.rooms['p1:dho'] = { last_synced_ms: 0, last_success_at: 0, consecutive_failures: 0 }

    await runCycle(baseConfig, state, () => {})

    expect(vi.mocked(harvestScroll)).not.toHaveBeenCalled()
  })

  it('allows startup_old harvest when last_harvest_at exceeds rate_limit_seconds', async () => {
    // Seed state with an old harvest and a stale room cursor.
    // Room cursor = 0 → startup_old trigger fires because 62 min > 30 min rate limit.
    const state = emptyState()
    state.daemon.last_harvest_at = BEYOND_RATE_LIMIT_MS
    state.rooms['p1:dho'] = { last_synced_ms: 0, last_success_at: 0, consecutive_failures: 0 }

    await runCycle(baseConfig, state, () => {})

    expect(vi.mocked(harvestScroll)).toHaveBeenCalledTimes(1)
  })

  it('rate_limit_seconds default is 1800', () => {
    expect(DEFAULT_HARVEST_RATE_LIMIT_SECONDS).toBe(1800)
  })
})
