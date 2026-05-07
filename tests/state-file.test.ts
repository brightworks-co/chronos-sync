import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    expect(s.interval_cache).toBeUndefined()
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

describe('loadConfig', () => {
  async function writeConfig(body: unknown): Promise<void> {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    await fs.writeFile(
      join(process.env.HOME!, '.chronos', 'config.json'),
      JSON.stringify(body),
      'utf8'
    )
  }

  const validBase = {
    server_url: 'https://example.test',
    pat: 'chr_pat_' + 'a'.repeat(32),
    interval_seconds: 60,
  }

  it('accepts a room configured with chat_name only', async () => {
    await writeConfig({
      ...validBase,
      rooms: [
        {
          chat_name: 'kakao chat A',
          project_id: 'p1',
          room_name: 'room-a',
          kakao_original_name: 'kakao chat A',
        },
      ],
    })
    const cfg = await loadConfig()
    expect(cfg.rooms).toHaveLength(1)
    expect(cfg.rooms[0].chat_name).toBe('kakao chat A')
  })

  it('accepts a room configured with chat_id as a quoted string (open chat case)', async () => {
    await writeConfig({
      ...validBase,
      rooms: [
        {
          chat_id: '18393235298236590',
          project_id: 'p1',
          room_name: 'open-room',
        },
      ],
    })
    const cfg = await loadConfig()
    expect(cfg.rooms[0].chat_id).toBe('18393235298236590')
    expect(cfg.rooms[0].chat_name).toBeUndefined()
  })

  it('normalizes a safe-integer chat_id number to a string', async () => {
    await writeConfig({
      ...validBase,
      rooms: [
        {
          chat_id: 12345,
          project_id: 'p1',
          room_name: 'room-a',
        },
      ],
    })
    const cfg = await loadConfig()
    expect(cfg.rooms[0].chat_id).toBe('12345')
  })

  it('throws when chat_id is a number that exceeds Number.MAX_SAFE_INTEGER', async () => {
    await writeConfig({
      ...validBase,
      rooms: [
        {
          chat_id: 18296430865364356,
          project_id: 'p1',
          room_name: 'room-a',
        },
      ],
    })
    await expect(loadConfig()).rejects.toThrow(/MAX_SAFE_INTEGER|quoted JSON string/)
  })

  it('throws when chat_id is a non-numeric string', async () => {
    await writeConfig({
      ...validBase,
      rooms: [
        {
          chat_id: 'abc',
          project_id: 'p1',
          room_name: 'room-a',
        },
      ],
    })
    await expect(loadConfig()).rejects.toThrow(/numeric string/)
  })

  it('accepts a room with both chat_name and chat_id (chat_id wins downstream)', async () => {
    await writeConfig({
      ...validBase,
      rooms: [
        {
          chat_name: 'fallback name',
          chat_id: 42,
          project_id: 'p1',
          room_name: 'room-a',
        },
      ],
    })
    const cfg = await loadConfig()
    expect(cfg.rooms[0].chat_name).toBe('fallback name')
    expect(cfg.rooms[0].chat_id).toBe('42')
  })

  it('throws when a room has neither chat_name nor chat_id', async () => {
    await writeConfig({
      ...validBase,
      rooms: [{ project_id: 'p1', room_name: 'room-a' }],
    })
    await expect(loadConfig()).rejects.toThrow(/chat_name or chat_id/)
  })

  it('throws when chat_name is empty and chat_id is absent', async () => {
    await writeConfig({
      ...validBase,
      rooms: [{ chat_name: '', project_id: 'p1', room_name: 'room-a' }],
    })
    await expect(loadConfig()).rejects.toThrow(/chat_name or chat_id/)
  })

  it('throws when project_id is missing', async () => {
    await writeConfig({
      ...validBase,
      rooms: [{ chat_name: 'k', room_name: 'room-a' }],
    })
    await expect(loadConfig()).rejects.toThrow(/project_id/)
  })

  it('throws when rooms is empty', async () => {
    await writeConfig({ ...validBase, rooms: [] })
    await expect(loadConfig()).rejects.toThrow(/rooms must be a non-empty array/)
  })

  const validRoom = { chat_name: 'room', project_id: 'p1', room_name: 'r1' }

  it('accepts harvest config with all fields', async () => {
    await writeConfig({
      ...validBase,
      rooms: [validRoom],
      harvest: {
        gap_seconds: 3600,
        startup_seconds: 7200,
        rate_limit_seconds: 600,
        max_pages: 10,
      },
    })
    const cfg = await loadConfig()
    expect(cfg.harvest?.gap_seconds).toBe(3600)
    expect(cfg.harvest?.startup_seconds).toBe(7200)
    expect(cfg.harvest?.rate_limit_seconds).toBe(600)
    expect(cfg.harvest?.max_pages).toBe(10)
  })

  it('returns undefined harvest when harvest field is absent', async () => {
    await writeConfig({ ...validBase, rooms: [validRoom] })
    const cfg = await loadConfig()
    expect(cfg.harvest).toBeUndefined()
  })

  it('rejects harvest.gap_seconds that is negative', async () => {
    await writeConfig({
      ...validBase,
      rooms: [validRoom],
      harvest: { gap_seconds: -1 },
    })
    await expect(loadConfig()).rejects.toThrow(/config\.harvest\.gap_seconds/)
  })

  it('rejects harvest when value is not an object', async () => {
    await writeConfig({ ...validBase, rooms: [validRoom], harvest: 42 })
    await expect(loadConfig()).rejects.toThrow(/config\.harvest must be an object/)
  })

  it('floors fractional harvest field values', async () => {
    await writeConfig({
      ...validBase,
      rooms: [validRoom],
      harvest: { max_pages: 3.9 },
    })
    const cfg = await loadConfig()
    expect(cfg.harvest?.max_pages).toBe(3)
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

describe('loadConfig — harvest new fields accepted', () => {
  async function writeConfig(body: unknown): Promise<void> {
    await fs.mkdir(join(process.env.HOME!, '.chronos'), { recursive: true })
    await fs.writeFile(
      join(process.env.HOME!, '.chronos', 'config.json'),
      JSON.stringify(body),
      'utf8'
    )
  }

  const validBase = {
    server_url: 'https://example.test',
    pat: 'chr_pat_' + 'a'.repeat(32),
    interval_seconds: 60,
    rooms: [{ chat_name: 'room', project_id: 'p1', room_name: 'r1' }],
  }

  it('accepts all new harvest fields', async () => {
    await writeConfig({
      ...validBase,
      harvest: {
        top: 5,
        max_clicks: 3,
        scroll_delay: 1.5,
        stuck_nudge_threshold: 5,
        harvest_failure_backoff_base_seconds: 1800,
        harvest_failure_backoff_max_seconds: 28800,
      },
    })
    const cfg = await loadConfig()
    expect(cfg.harvest?.top).toBe(5)
    expect(cfg.harvest?.max_clicks).toBe(3)
    expect(cfg.harvest?.scroll_delay).toBe(1.5)
    expect(cfg.harvest?.stuck_nudge_threshold).toBe(5)
    expect(cfg.harvest?.harvest_failure_backoff_base_seconds).toBe(1800)
    expect(cfg.harvest?.harvest_failure_backoff_max_seconds).toBe(28800)
  })

  it('floors integer harvest fields but preserves scroll_delay as float', async () => {
    await writeConfig({
      ...validBase,
      harvest: { top: 5.9, scroll_delay: 1.75 },
    })
    const cfg = await loadConfig()
    expect(cfg.harvest?.top).toBe(5)
    expect(cfg.harvest?.scroll_delay).toBe(1.75)
  })

  it('accepts max_pages (deprecated) without throwing and keeps the value', async () => {
    await writeConfig({
      ...validBase,
      harvest: { max_pages: 5 },
    })
    const cfg = await loadConfig()
    // deprecated but tolerated — value present in output for read compat
    expect(cfg.harvest?.max_pages).toBe(5)
  })

  it('accepts harvest.enabled boolean and rejects non-boolean values', async () => {
    await writeConfig({ ...validBase, harvest: { enabled: true } })
    let cfg = await loadConfig()
    expect(cfg.harvest?.enabled).toBe(true)

    await writeConfig({ ...validBase, harvest: { enabled: false } })
    cfg = await loadConfig()
    expect(cfg.harvest?.enabled).toBe(false)

    await writeConfig({ ...validBase, harvest: {} })
    cfg = await loadConfig()
    expect(cfg.harvest?.enabled).toBeUndefined()

    await writeConfig({ ...validBase, harvest: { enabled: 'yes' } })
    await expect(loadConfig()).rejects.toThrow(/enabled.*boolean/)
  })

  it('AC-12: max_pages deprecation warn emitted exactly once across multiple loadConfig calls', async () => {
    const { resetMaxPagesWarnForTest } = await import('../src/state-file')
    resetMaxPagesWarnForTest()

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await writeConfig({ ...validBase, harvest: { max_pages: 5 } })
      await loadConfig()
      await loadConfig()
      await loadConfig()

      const warnCalls = stderrSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('max_pages')
      )
      expect(warnCalls).toHaveLength(1)
    } finally {
      stderrSpy.mockRestore()
      resetMaxPagesWarnForTest()
    }
  })

  it('rejects negative scroll_delay', async () => {
    await writeConfig({
      ...validBase,
      harvest: { scroll_delay: -1 },
    })
    await expect(loadConfig()).rejects.toThrow(/config\.harvest\.scroll_delay/)
  })
})
