import { describe, it, expect } from 'vitest'
import {
  formatHeader,
  formatCycleLine,
  formatShutdown,
  ANSI,
} from '../src/foreground-ui'
import type { DaemonConfig, RoomConfig } from '../src/types'
import type { ResolvedInterval } from '../src/interval-resolver'

const baseRoom: RoomConfig = {
  chat_name: 'kakao A',
  project_id: '1ce3758d-bfac-4916-9b48-07ad8ba3f5f4',
  room_name: 'notice',
  kakao_original_name: 'kakao A',
}

const baseConfig: DaemonConfig = {
  server_url: 'https://dev.chronos.brightworks.app',
  pat: 'chr_pat_' + 'a'.repeat(32),
  interval_seconds: 300,
  rooms: [baseRoom],
}

describe('formatHeader', () => {
  it('shows version, server, room count, and interval', () => {
    const out = formatHeader({
      config: baseConfig,
      configPath: '/u/.chronos/config.json',
      version: '0.1.0-alpha.1',
    })
    expect(out).toContain('chronos-sync')
    expect(out).toContain('0.1.0-alpha.1')
    expect(out).toContain('/u/.chronos/config.json')
    expect(out).toContain('https://dev.chronos.brightworks.app')
    expect(out).toContain('1개 매핑')
    expect(out).toContain('5분')
    expect(out).toContain('Ctrl+C')
  })

  it('lists the room source → target mapping', () => {
    const out = formatHeader({
      config: baseConfig,
      configPath: '/x/config.json',
      version: '1.0.0',
    })
    expect(out).toContain('kakao A → 1ce3758d/notice')
  })

  it('falls back to chat_id when chat_name is absent', () => {
    const cfg: DaemonConfig = {
      ...baseConfig,
      rooms: [
        {
          chat_id: '18393235298236590',
          project_id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
          room_name: 'open-chat',
        },
      ],
    }
    const out = formatHeader({ config: cfg, configPath: '/x', version: '1' })
    expect(out).toContain('18393235298236590 → aaaabbbb/open-chat')
  })

  it('renders sub-minute intervals in seconds', () => {
    const cfg: DaemonConfig = { ...baseConfig, interval_seconds: 30 }
    const out = formatHeader({ config: cfg, configPath: '/x', version: '1' })
    expect(out).toContain('30초마다')
  })

  it('shows source tag when resolved is provided', () => {
    const resolved: ResolvedInterval = {
      value: 60,
      source: 'server',
      fetched_at: new Date().toISOString(),
      warning: null,
    }
    const out = formatHeader({ config: baseConfig, configPath: '/x', version: '1', resolved })
    expect(out).toContain('(server)')
    expect(out).toContain('1분')
  })

  it('shows cached source tag', () => {
    const resolved: ResolvedInterval = {
      value: 120,
      source: 'cached',
      fetched_at: new Date().toISOString(),
      warning: null,
    }
    const out = formatHeader({ config: baseConfig, configPath: '/x', version: '1', resolved })
    expect(out).toContain('(cached)')
  })

  it('shows warning line when resolved has a warning', () => {
    const resolved: ResolvedInterval = {
      value: 300,
      source: 'cached',
      fetched_at: new Date().toISOString(),
      warning: 'PAT 만료 감지 — web에서 갱신 필요',
    }
    const out = formatHeader({ config: baseConfig, configPath: '/x', version: '1', resolved })
    expect(out).toContain('PAT 만료 감지')
  })

  it('shows default source tag', () => {
    const resolved: ResolvedInterval = {
      value: 300,
      source: 'default',
      fetched_at: new Date().toISOString(),
      warning: null,
    }
    const out = formatHeader({ config: baseConfig, configPath: '/x', version: '1', resolved })
    expect(out).toContain('(default)')
  })
})

describe('formatCycleLine', () => {
  const fixedNow = new Date('2026-05-06T12:38:05')

  it('emits a green ✓ with the upload count when work happened', () => {
    const line = formatCycleLine({
      room: baseRoom,
      new_messages: 50,
      now: fixedNow,
    })
    expect(line).toContain(`${ANSI.green}✓${ANSI.reset}`)
    expect(line).toContain('1ce3758d/notice')
    expect(line).toContain('새 메시지 50개 업로드')
  })

  it('says "변동 없음" when the cycle had no new messages', () => {
    const line = formatCycleLine({
      room: baseRoom,
      new_messages: 0,
      now: fixedNow,
    })
    expect(line).toContain(`${ANSI.green}✓${ANSI.reset}`)
    expect(line).toContain('변동 없음')
  })

  it('emits a red ✗ with the error message on failure', () => {
    const line = formatCycleLine({
      room: baseRoom,
      new_messages: 0,
      error: 'kakaocli exited with code 1',
      now: fixedNow,
    })
    expect(line).toContain(`${ANSI.red}✗${ANSI.reset}`)
    expect(line).toContain('kakaocli exited with code 1')
  })

  it('formats the timestamp as HH:MM:SS', () => {
    const line = formatCycleLine({
      room: baseRoom,
      new_messages: 1,
      now: fixedNow,
    })
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}/)
  })
})

describe('formatShutdown', () => {
  it('mentions chronos-sync re-run instruction', () => {
    const out = formatShutdown()
    expect(out).toContain('chronos-sync')
    expect(out).toContain('다시 실행')
  })
})
