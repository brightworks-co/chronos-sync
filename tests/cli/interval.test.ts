import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/api-client.js', () => ({
  getSyncSettings: vi.fn(),
  putSyncSettings: vi.fn(),
  ApiPatAuthError: class ApiPatAuthError extends Error {
    constructor() {
      super('PAT authentication failed (401)')
      this.name = 'ApiPatAuthError'
    }
  },
}))

vi.mock('../../src/state-file.js', () => ({
  configPath: vi.fn(),
  loadConfig: vi.fn(),
}))

import { runIntervalSet, runIntervalGet } from '../../src/cli/interval'
import { getSyncSettings, putSyncSettings, ApiPatAuthError } from '../../src/api-client'
import { configPath, loadConfig } from '../../src/state-file'

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
  rooms: [],
}

let tmpDir: string
let tmpConfigPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chronos-sync-test-'))
  tmpConfigPath = join(tmpDir, 'config.json')
  writeFileSync(
    tmpConfigPath,
    JSON.stringify({ ...BASE_CONFIG, rooms: [] }, null, 2) + '\n',
    'utf8'
  )
  vi.mocked(configPath).mockReturnValue(tmpConfigPath)
  vi.mocked(loadConfig).mockResolvedValue({ ...BASE_CONFIG })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

describe('runIntervalSet', () => {
  it('calls PUT and updates local config on success', async () => {
    vi.mocked(putSyncSettings).mockResolvedValue({
      interval_seconds: 60,
      updated_at: '2024-01-01T00:00:00Z',
    })
    const out = new StringStream()
    const err = new StringStream()

    const result = await runIntervalSet('60', out, err)

    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/interval=60s saved \(web \+ local\)/)
    expect(vi.mocked(putSyncSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: BASE_CONFIG.server_url, pat: BASE_CONFIG.pat }),
      60
    )

    const updated = JSON.parse(readFileSync(tmpConfigPath, 'utf8'))
    expect(updated.interval_seconds).toBe(60)
  })

  it('rejects non-integer input', async () => {
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalSet('abc', out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/잘못된 값/)
    expect(vi.mocked(putSyncSettings)).not.toHaveBeenCalled()
  })

  it('rejects below MIN_INTERVAL_SECONDS (5)', async () => {
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalSet('5', out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/10~3600초 사이/)
    expect(vi.mocked(putSyncSettings)).not.toHaveBeenCalled()
  })

  it('rejects above MAX_INTERVAL_SECONDS (4000)', async () => {
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalSet('4000', out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/10~3600초 사이/)
  })

  it('exits 1 with friendly message when config.json missing', async () => {
    vi.mocked(loadConfig).mockRejectedValue(
      new Error('ENOENT: no such file or directory, open ~/.chronos/config.json')
    )
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalSet('60', out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/config 로드 실패/)
  })

  it('exits 1 with PAT-specific message on 401', async () => {
    vi.mocked(putSyncSettings).mockRejectedValue(new ApiPatAuthError())
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalSet('60', out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/PAT 인증 실패 \(401\)/)
  })

  it('exits 1 on generic PUT failure', async () => {
    vi.mocked(putSyncSettings).mockRejectedValue(new Error('network error'))
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalSet('60', out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/PUT 실패: network error/)
  })

  it('exits 0 with degraded message when local config write fails after KV success', async () => {
    vi.mocked(putSyncSettings).mockResolvedValue({
      interval_seconds: 60,
      updated_at: '2024-01-01T00:00:00Z',
    })
    rmSync(tmpConfigPath)
    const out = new StringStream()
    const err = new StringStream()

    const result = await runIntervalSet('60', out, err)

    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/web only — 로컬 sync 실패/)
    expect(err.text()).toMatch(/로컬 config 동기화 실패/)
  })
})

describe('runIntervalGet', () => {
  it('prints current interval from web KV', async () => {
    vi.mocked(getSyncSettings).mockResolvedValue({
      interval_seconds: 300,
      updated_at: '2024-01-01T00:00:00Z',
    })
    const out = new StringStream()
    const err = new StringStream()

    const result = await runIntervalGet(out, err)

    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/interval=300s/)
    expect(out.text()).toMatch(/last updated: 2024-01-01T00:00:00Z/)
  })

  it('flags drift when web value differs from local config', async () => {
    vi.mocked(getSyncSettings).mockResolvedValue({
      interval_seconds: 60,
      updated_at: '2024-01-01T00:00:00Z',
    })
    const out = new StringStream()
    const err = new StringStream()

    const result = await runIntervalGet(out, err)

    expect(result.exitCode).toBe(0)
    expect(out.text()).toMatch(/drift/)
    expect(out.text()).toMatch(/local config: 300s/)
  })

  it('exits 1 with PAT-specific message on 401', async () => {
    vi.mocked(getSyncSettings).mockRejectedValue(new ApiPatAuthError())
    const out = new StringStream()
    const err = new StringStream()
    const result = await runIntervalGet(out, err)

    expect(result.exitCode).toBe(1)
    expect(err.text()).toMatch(/PAT 인증 실패 \(401\)/)
  })
})
