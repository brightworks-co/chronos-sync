import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../../src/state-file.js', () => ({
  loadConfig: vi.fn(),
  configPath: vi.fn(() => '/tmp/test-config.json'),
}))

vi.mock('../../src/kakaocli.js', () => ({
  listMessages: vi.fn(),
}))

vi.mock('../../src/sender-resolver.js', () => ({
  resolveSenderNames: vi.fn(),
}))

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

import { runDiagnoseSenders } from '../../src/cli/diagnose-senders'
import { loadConfig } from '../../src/state-file'
import { listMessages } from '../../src/kakaocli'
import { resolveSenderNames } from '../../src/sender-resolver'

class StringStream {
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

const BASE_CONFIG = {
  server_url: 'https://example.test',
  pat: 'chr_pat_' + 'a'.repeat(32),
  interval_seconds: 300,
  rooms: [
    { project_id: 'proj-aaaa-bbbb', room_name: 'main', chat_name: '테스트 채팅', kakao_original_name: '테스트 채팅' },
    { project_id: 'proj-cccc-dddd', room_name: 'side', chat_id: '12345', kakao_original_name: '익명 오픈챗' },
  ],
}

beforeEach(() => {
  vi.mocked(loadConfig).mockResolvedValue({ ...BASE_CONFIG })
  spawnMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeProbeChild(exitCode: number, stderr = ''): EventEmitter {
  const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
  ee.stderr = new EventEmitter()
  setImmediate(() => {
    if (stderr) ee.stderr.emit('data', Buffer.from(stderr))
    ee.emit('close', exitCode)
  })
  return ee
}

function makeMsg(id: number, sender: string | null, text = 'hi', isSelf = false) {
  return {
    chat_id: 1,
    id,
    sender,
    sender_id: id * 1000,
    text,
    timestamp: 1709289600000 + id,
    is_from_me: isSelf,
    type: 'text',
  }
}

describe('runDiagnoseSenders', () => {
  it('lists configured rooms when no arg given', async () => {
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders(undefined, out, err)
    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/사용법: chronos-sync diagnose senders/)
    expect(out.text()).toContain('테스트 채팅')
    expect(out.text()).toContain('12345')
  })

  it('errors out when chat name does not match any configured room', async () => {
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('없는채팅', out, err)
    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/알 수 없는 룸/)
  })

  it('exits 1 when config load fails', async () => {
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('ENOENT'))
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('테스트 채팅', out, err)
    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/config 로드 실패: ENOENT/)
  })

  it('reports zero-message room cleanly', async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([])
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('테스트 채팅', out, err)
    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/지난 24시간에 메시지가 없습니다/)
    expect(vi.mocked(resolveSenderNames)).not.toHaveBeenCalled()
  })

  it('classifies already_resolved + is_from_me + lookup-needed correctly', async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([
      makeMsg(1, '이몽룡', 'hello'),
      makeMsg(2, null, 'self', true),
      makeMsg(3, null, 'group msg'),
    ])
    vi.mocked(resolveSenderNames).mockResolvedValueOnce(new Map([['3000', '참가자A']]))
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('테스트 채팅', out, err)
    expect(result.exitCode).toBe(0)
    const text = out.text()
    expect(text).toMatch(/이미 해결됨.*1/)
    expect(text).toMatch(/is_from_me.*1/)
    expect(text).toMatch(/RESOLVED.*id=3000.*참가자A/s)
  })

  it('marks fallback_absent when NTUser probe returns 0 (id missing)', async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([
      makeMsg(7, null, '익명 멤버 메시지'),
    ])
    vi.mocked(resolveSenderNames).mockResolvedValueOnce(new Map())
    spawnMock.mockReturnValueOnce(fakeProbeChild(0))
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('테스트 채팅', out, err)
    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/NTUser에 없음/)
    expect(out.text()).toMatch(/오픈채팅 비친구 멤버/)
  })

  it('marks fallback_probe_failed when NTUser probe exits non-zero', async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([makeMsg(8, null, '...')])
    vi.mocked(resolveSenderNames).mockResolvedValueOnce(new Map())
    spawnMock.mockReturnValueOnce(fakeProbeChild(1, 'unknown subcommand: query'))
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('테스트 채팅', out, err)
    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/probe 실패/)
    expect(out.text()).toMatch(/kakaocli query 서브커맨드 미지원/)
  })

  it('surfaces resolver-throw separately from per-id probe', async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([makeMsg(9, null, 'x')])
    vi.mocked(resolveSenderNames).mockRejectedValueOnce(new Error('binary not found'))
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('테스트 채팅', out, err)
    expect(result.exitCode).toBe(0)
    expect(err.text()).toMatch(/resolveSenderNames 호출 자체가 throw/)
    expect(err.text()).toMatch(/binary not found/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('matches by chat_id when arg is numeric', async () => {
    vi.mocked(listMessages).mockResolvedValueOnce([])
    const out = new StringStream()
    const err = new StringStream()
    const result = await runDiagnoseSenders('12345', out, err)
    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/chat_id:   12345/)
  })
})
