import { describe, it, expect } from 'vitest'
import { renderStatus, formatLastSync } from '../../src/cli/status'
import type { DaemonConfig, DaemonState } from '../../src/types'

const FIXED_NOW = Date.parse('2026-05-06T10:42:00Z')

function baseConfig(rooms: DaemonConfig['rooms']): DaemonConfig {
  return {
    server_url: 'https://dev.chronos.brightworks.app',
    pat: 'chr_pat_' + 'a'.repeat(32),
    interval_seconds: 60,
    rooms,
  }
}

function emptyState(): DaemonState {
  return { rooms: {}, daemon: { started_at: 0, last_cycle_at: 0 } }
}

describe('renderStatus', () => {
  it('reports config + state header', () => {
    const out = renderStatus({
      version: '0.1.0-alpha.1',
      configPath: '/tmp/.chronos/config.json',
      statePath: '/tmp/.chronos/state.json',
      config: baseConfig([]),
      state: emptyState(),
      now: FIXED_NOW,
    })
    expect(out).toContain('chronos-sync v0.1.0-alpha.1')
    expect(out).toContain('config: /tmp/.chronos/config.json')
    expect(out).toContain('state:  /tmp/.chronos/state.json')
    expect(out).toContain('server: https://dev.chronos.brightworks.app')
    expect(out).toContain('interval: 60s')
  })

  it('prints "(no rooms configured)" when rooms is empty', () => {
    const out = renderStatus({
      version: '0.1.0-alpha.1',
      configPath: '/c',
      statePath: '/s',
      config: baseConfig([]),
      state: emptyState(),
      now: FIXED_NOW,
    })
    expect(out).toContain('(no rooms configured)')
  })

  it('renders one row per configured room with cursor + fails', () => {
    const cfg = baseConfig([
      {
        chat_name: 'team daily 🗓️',
        project_id: '550e8400-e29b-41d4-a716-446655440000',
        room_name: 'team-daily',
        kakao_original_name: 'team daily 🗓️',
      },
      {
        chat_name: 'eng banter',
        project_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        room_name: 'eng-banter',
        kakao_original_name: 'eng banter',
      },
    ])
    const state: DaemonState = {
      rooms: {
        '550e8400-e29b-41d4-a716-446655440000:team-daily': {
          last_synced_ms: 1714987320000,
          last_success_at: FIXED_NOW - 2 * 60 * 1000,
          consecutive_failures: 0,
        },
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8:eng-banter': {
          last_synced_ms: 0,
          last_success_at: 0,
          consecutive_failures: 3,
        },
      },
      daemon: { started_at: 0, last_cycle_at: 0 },
    }
    const out = renderStatus({
      version: '0.1.0-alpha.1',
      configPath: '/c',
      statePath: '/s',
      config: cfg,
      state,
      now: FIXED_NOW,
    })
    expect(out).toContain('"team daily 🗓️" → 550e8400/team-daily')
    expect(out).toContain('"eng banter" → 6ba7b810/eng-banter')
    expect(out).toContain('1714987320000')
    expect(out).toContain('never')
    expect(out).toMatch(/2분 전/)
    const engLine = out.split('\n').find((l) => l.includes('eng-banter'))
    expect(engLine).toBeDefined()
    expect(engLine!.split(/\s{2,}/).map((c) => c.trim())).toContain('3')
  })

  it('shows degraded header when config fails to load', () => {
    const out = renderStatus({
      version: '0.1.0-alpha.1',
      configPath: '/c',
      statePath: '/s',
      config: { error: 'config.pat missing or malformed' },
      state: emptyState(),
      now: FIXED_NOW,
    })
    expect(out).toContain('server: (config not loaded: config.pat missing or malformed)')
    expect(out).toContain('interval: (config not loaded)')
    expect(out).toContain('(no rooms configured)')
  })
})

describe('formatLastSync', () => {
  it('returns "never" for zero', () => {
    expect(formatLastSync(0, FIXED_NOW)).toBe('never')
  })

  it('returns seconds ago for sub-minute deltas', () => {
    expect(formatLastSync(FIXED_NOW - 30_000, FIXED_NOW)).toContain('30초 전')
  })

  it('returns minutes ago for sub-hour deltas', () => {
    expect(formatLastSync(FIXED_NOW - 5 * 60 * 1000, FIXED_NOW)).toContain('5분 전')
  })

  it('returns hours ago for sub-day deltas', () => {
    expect(formatLastSync(FIXED_NOW - 3 * 60 * 60 * 1000, FIXED_NOW)).toContain('3시간 전')
  })

  it('returns days ago beyond 24 hours', () => {
    expect(formatLastSync(FIXED_NOW - 2 * 24 * 60 * 60 * 1000, FIXED_NOW)).toContain('2일 전')
  })

  it('appends a HH:mm clock', () => {
    expect(formatLastSync(FIXED_NOW - 60_000, FIXED_NOW)).toMatch(/\(\d{2}:\d{2}\)$/)
  })
})
