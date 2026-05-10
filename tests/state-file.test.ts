import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireLock,
  releaseLock,
  clampInterval,
  emptyState,
  getRoomState,
  setRoomState,
  loadState,
  saveState,
  roomStateKey,
  loadConfig,
  LegacyConfigDetectedError,
  ConfigMissingError,
} from '../src/state-file'
import {
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from '../src/types'


let realHome: string | undefined

beforeEach(async () => {
  realHome = process.env.HOME
  const tmp = await fs.mkdtemp(join(tmpdir(), 'chronos-sync-test-'))
  process.env.HOME = tmp
})

afterEach(async () => {
  if (process.env.HOME && process.env.HOME !== realHome) {
    await fs.rm(process.env.HOME, { recursive: true, force: true })
  }
  process.env.HOME = realHome
})

describe('clampInterval', () => {
  it('returns default for non-finite input', () => {
    expect(clampInterval(NaN)).toBe(DEFAULT_INTERVAL_SECONDS)
    expect(clampInterval(Infinity)).toBe(DEFAULT_INTERVAL_SECONDS)
  })

  it('floors values below the minimum', () => {
    expect(clampInterval(5)).toBe(MIN_INTERVAL_SECONDS)
  })

  it('caps values above the maximum', () => {
    expect(clampInterval(100_000)).toBe(MAX_INTERVAL_SECONDS)
  })

  it('rounds fractional input down', () => {
    expect(clampInterval(45.9)).toBe(45)
  })
})

describe('roomStateKey', () => {
  it('joins project_id and room_name with a colon', () => {
    expect(roomStateKey('p1', 'room-a')).toBe('p1:room-a')
  })
})

describe('getRoomState / setRoomState', () => {
  it('returns a default cursor for an unseen room', () => {
    const s = emptyState()
    const rs = getRoomState(s, 'p1', 'unseen')
    expect(rs.last_synced_ms).toBe(0)
    expect(rs.consecutive_failures).toBe(0)
    expect(s.daemon.cycle_index).toBe(0)
  })

  it('round-trips a stored cursor', () => {
    const s = emptyState()
    setRoomState(s, 'p1', 'r1', {
      last_synced_ms: 12345,
      last_success_at: 67890,
      consecutive_failures: 2,
    })
    expect(getRoomState(s, 'p1', 'r1').last_synced_ms).toBe(12345)
    expect(getRoomState(s, 'p1', 'r1').consecutive_failures).toBe(2)
  })
})

describe('saveState / loadState', () => {
  it('persists to disk and reads back equivalently', async () => {
    const s = emptyState()
    setRoomState(s, 'p1', 'r1', {
      last_synced_ms: 999,
      last_success_at: 111,
      consecutive_failures: 0,
    })
    await saveState(s)
    const loaded = await loadState()
    expect(loaded.rooms['p1:r1'].last_synced_ms).toBe(999)
  })

  it('returns empty state when no file exists', async () => {
    const loaded = await loadState()
    expect(Object.keys(loaded.rooms)).toHaveLength(0)
  })
})

describe('acquireLock / releaseLock', () => {
  it('acquires a fresh lock and releases it', async () => {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    expect(acquireLock()).toBe(true)
    expect(existsSync(join(process.env.HOME!, '.chronos', 'chronos-sync.lock'))).toBe(true)
    releaseLock()
    expect(existsSync(join(process.env.HOME!, '.chronos', 'chronos-sync.lock'))).toBe(false)
  })

  it('rejects a second acquire while the first owner is alive', async () => {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    expect(acquireLock()).toBe(true)
    const lockPath = join(process.env.HOME!, '.chronos', 'chronos-sync.lock')
    await fs.writeFile(lockPath, String(process.ppid))
    expect(acquireLock()).toBe(false)
    await fs.writeFile(lockPath, String(process.pid))
    releaseLock()
  })

  it('reclaims a stale lock whose PID is no longer alive', async () => {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    const lockPath = join(process.env.HOME!, '.chronos', 'chronos-sync.lock')
    await fs.writeFile(lockPath, '999999')
    expect(acquireLock()).toBe(true)
    releaseLock()
  })
})

describe('loadConfig — v0.6.0 auth-mode gates', () => {
  // v0.6.0 removed the legacy `~/.chronos/config.json` entry point. Schema
  // validation that previously lived in loadConfig (chat_id parsing, harvest
  // field validation, room shape checks) now lives in the bootstrap-resolver
  // snapshot-ingestion layer and is exercised by its own specs. The remaining
  // loadConfig responsibility is the auth.json / config.json branch gating.

  it('throws ConfigMissingError when neither auth.json nor config.json exists', async () => {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    await expect(loadConfig()).rejects.toBeInstanceOf(ConfigMissingError)
  })

  it('throws LegacyConfigDetectedError when only legacy config.json is present', async () => {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    await fs.writeFile(
      join(process.env.HOME!, '.chronos', 'config.json'),
      JSON.stringify({
        server_url: 'https://example.test',
        pat: 'chr_pat_' + 'a'.repeat(32),
        rooms: [{ chat_name: 'k', project_id: 'p1', room_name: 'r1' }],
      }),
      'utf8'
    )
    await expect(loadConfig()).rejects.toBeInstanceOf(LegacyConfigDetectedError)
  })

  it('LegacyConfigDetectedError message points the user to chronos-sync auth', async () => {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    await fs.writeFile(
      join(process.env.HOME!, '.chronos', 'config.json'),
      JSON.stringify({}),
      'utf8'
    )
    await expect(loadConfig()).rejects.toThrow(/chronos-sync auth/)
  })
})

describe('getRoomState last_harvest_at default', () => {
  it('returns last_harvest_at 0 for an unseen room', () => {
    const s = emptyState()
    const rs = getRoomState(s, 'p1', 'unseen')
    expect(rs.last_harvest_at).toBe(0)
  })
})

describe('loadState — state.daemon.last_harvest_at forward-compat (0.2.6 state files)', () => {
  it('defaults last_harvest_at to 0 when field is absent (0.2.6 state)', async () => {
    const chronosDir = join(process.env.HOME!, '.chronos')
    await fs.mkdir(chronosDir, { recursive: true })
    // Write a 0.2.6-style state without last_harvest_at
    const oldState = {
      rooms: {},
      daemon: { started_at: 1000, last_cycle_at: 2000, cycle_index: 3 },
    }
    await fs.writeFile(join(chronosDir, 'state.json'), JSON.stringify(oldState), 'utf8')
    const loaded = await loadState()
    expect(loaded.daemon.last_harvest_at).toBe(0)
  })

  it('preserves last_harvest_at when present', async () => {
    const chronosDir = join(process.env.HOME!, '.chronos')
    await fs.mkdir(chronosDir, { recursive: true })
    const newState = {
      rooms: {},
      daemon: { started_at: 1000, last_cycle_at: 2000, cycle_index: 3, last_harvest_at: 9999 },
    }
    await fs.writeFile(join(chronosDir, 'state.json'), JSON.stringify(newState), 'utf8')
    const loaded = await loadState()
    expect(loaded.daemon.last_harvest_at).toBe(9999)
  })
})

describe('emptyState — daemon.last_harvest_at initialized to 0', () => {
  it('returns last_harvest_at 0 in a fresh state', () => {
    const s = emptyState()
    expect(s.daemon.last_harvest_at).toBe(0)
  })
})
