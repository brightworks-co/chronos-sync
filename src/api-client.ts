import {
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from './types.js'

export interface SyncSettingsResponse {
  interval_seconds: number
  updated_at: string
}

export interface ApiClientOptions {
  serverUrl: string
  pat: string
  /** Fetch timeout in ms. Default 5000. */
  timeoutMs?: number
}

export class ApiPatAuthError extends Error {
  constructor() {
    super('PAT authentication failed (401)')
    this.name = 'ApiPatAuthError'
  }
}

function validateBody(body: unknown): SyncSettingsResponse {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid response: expected object')
  }
  const b = body as Record<string, unknown>
  if (
    typeof b.interval_seconds !== 'number' ||
    !Number.isFinite(b.interval_seconds) ||
    b.interval_seconds < MIN_INTERVAL_SECONDS ||
    b.interval_seconds > MAX_INTERVAL_SECONDS
  ) {
    throw new Error(
      `Invalid response: interval_seconds must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`
    )
  }
  if (typeof b.updated_at !== 'string') {
    throw new Error('Invalid response: updated_at must be a string')
  }
  return { interval_seconds: b.interval_seconds, updated_at: b.updated_at }
}

export async function getSyncSettings(opts: ApiClientOptions): Promise<SyncSettingsResponse> {
  const { serverUrl, pat, timeoutMs = 5000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/sync-settings`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) {
    throw new ApiPatAuthError()
  }
  if (!res.ok) {
    throw new Error(`Sync settings request failed: HTTP ${res.status}`)
  }

  const body = await res.json()
  return validateBody(body)
}
