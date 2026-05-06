import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getSyncSettings, ApiPatAuthError } from '../src/api-client'

const BASE_OPTS = {
  serverUrl: 'https://example.test',
  pat: 'chr_pat_' + 'a'.repeat(32),
}

function makeFetchMock(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response)
}

beforeEach(() => {
  vi.stubGlobal('fetch', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getSyncSettings', () => {
  it('returns SyncSettingsResponse on 200', async () => {
    const body = { interval_seconds: 300, updated_at: '2024-01-01T00:00:00Z' }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    const result = await getSyncSettings(BASE_OPTS)
    expect(result.interval_seconds).toBe(300)
    expect(result.updated_at).toBe('2024-01-01T00:00:00Z')
  })

  it('throws ApiPatAuthError on 401', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, {}))

    await expect(getSyncSettings(BASE_OPTS)).rejects.toBeInstanceOf(ApiPatAuthError)
    await expect(getSyncSettings(BASE_OPTS)).rejects.toThrow('PAT authentication failed (401)')
  })

  it('throws generic Error on 500', async () => {
    vi.stubGlobal('fetch', makeFetchMock(500, {}))

    await expect(getSyncSettings(BASE_OPTS)).rejects.toThrow(/HTTP 500/)
  })

  it('propagates AbortError when fetch is aborted (timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const err = new DOMException('The operation was aborted.', 'AbortError')
        return Promise.reject(err)
      })
    )

    await expect(getSyncSettings({ ...BASE_OPTS, timeoutMs: 1 })).rejects.toThrow()
  })

  it('throws on invalid body schema (out of range interval_seconds)', async () => {
    const body = { interval_seconds: 5, updated_at: '2024-01-01T00:00:00Z' }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    await expect(getSyncSettings(BASE_OPTS)).rejects.toThrow(/interval_seconds/)
  })

  it('throws on invalid body schema (missing updated_at)', async () => {
    const body = { interval_seconds: 300 }
    vi.stubGlobal('fetch', makeFetchMock(200, body))

    await expect(getSyncSettings(BASE_OPTS)).rejects.toThrow(/updated_at/)
  })
})
