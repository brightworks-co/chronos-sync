import {
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  type RoomConfig,
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

/**
 * Server-side `/api/auto-upload/bootstrap` payload, mirrored from the
 * `BootstrapResponse` shape in the chronos web repo (PR2). Kept structural
 * here so the CLI side does not need a cross-repo type import.
 *
 * `etag` is informational only — the canonical etag for a 200 response is
 * the `ETag` HTTP header. The body field is exposed for diagnostics.
 */
export interface BootstrapPayload {
  server_url: string
  user_email: string
  interval_seconds: number
  rooms: RoomConfig[]
  etag: string
  fetched_at: string
}

export type BootstrapResult =
  | { status: 200; payload: BootstrapPayload; etag: string }
  | { status: 304; etag: string }

/**
 * GET `/api/auto-upload/bootstrap` with `Authorization: Bearer <PAT>`. Honors
 * `If-None-Match: <etag>` when `opts.etag` is set; on 304 returns the prior
 * etag (echoed by the server) without a body. On 200 returns the parsed
 * payload + the response `ETag` header.
 *
 * Rejects with `ApiPatAuthError` on 401. 403/5xx/network failures throw
 * generic `Error` instances; PR6's bootstrap-resolver classifies them.
 */
export async function getBootstrap(
  opts: ApiClientOptions,
  etag?: string
): Promise<BootstrapResult> {
  const { serverUrl, pat, timeoutMs = 10000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/json',
  }
  if (etag) headers['If-None-Match'] = etag

  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/auto-upload/bootstrap`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) {
    throw new ApiPatAuthError()
  }
  if (res.status === 304) {
    const responseEtag = res.headers.get('etag') ?? etag ?? ''
    return { status: 304, etag: responseEtag }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const errBody = (await res.json()) as { error?: string }
      if (errBody.error) detail = `: ${errBody.error}`
    } catch {
      // body not JSON
    }
    const ra = res.headers.get('retry-after')
    const raSuffix = ra ? ` retry-after=${ra}` : ''
    throw new Error(`Bootstrap GET failed: HTTP ${res.status}${detail}${raSuffix}`)
  }

  const body = await res.json()
  const responseEtag = res.headers.get('etag') ?? ''
  return { status: 200, payload: validateBootstrapBody(body), etag: responseEtag }
}

/**
 * Single eligible project (subset of fields chronos-sync needs).
 * Mirrors the chronos web `/api/auto-upload/projects` response shape; we
 * keep the type structural so PR1/PR2 schema additions don't break us.
 */
export interface EligibleProject {
  id: string
  name?: string
  archived?: boolean
}

/**
 * GET `/api/auto-upload/projects` with PAT auth — returns the list of
 * projects whose room mappings the user is allowed to PUT. Used by
 * `chronos-sync migrate` pre-flight (MAJ-8.2) to filter legacy rows
 * pointing at archived/inaccessible projects.
 */
export async function listEligibleProjects(
  opts: ApiClientOptions
): Promise<EligibleProject[]> {
  const { serverUrl, pat, timeoutMs = 5000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/auto-upload/projects`, {
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
  if (res.status === 401) throw new ApiPatAuthError()
  if (!res.ok) {
    throw new Error(`Eligible projects GET failed: HTTP ${res.status}`)
  }
  const body = (await res.json()) as { projects?: unknown }
  if (!Array.isArray(body.projects)) {
    throw new Error('Invalid /api/auto-upload/projects response: projects must be an array')
  }
  return body.projects.map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new Error(`Invalid project at index ${i}: expected object`)
    }
    const proj = p as Record<string, unknown>
    if (typeof proj.id !== 'string' || proj.id.length === 0) {
      throw new Error(`Invalid project at index ${i}: id must be a non-empty string`)
    }
    return {
      id: proj.id,
      name: typeof proj.name === 'string' ? proj.name : undefined,
      archived: typeof proj.archived === 'boolean' ? proj.archived : false,
    }
  })
}

/**
 * Whole-payload PUT to `/api/account/auto-upload/rooms` (PR1 contract).
 * Replaces (not merges) the user's room mapping list.
 */
export interface AutoUploadMappingRow {
  project_id: string
  room_name: string
  /** String wire form; never coerced to number (Number.MAX_SAFE_INTEGER risk). */
  chat_id: string
}

export async function putAutoUploadRooms(
  opts: ApiClientOptions,
  rows: AutoUploadMappingRow[]
): Promise<void> {
  const { serverUrl, pat, timeoutMs = 5000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/account/auto-upload/rooms`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rows }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) throw new ApiPatAuthError()
  if (!res.ok) {
    let detail = ''
    try {
      const errBody = (await res.json()) as { error?: string }
      if (errBody.error) detail = `: ${errBody.error}`
    } catch {
      // body not JSON
    }
    throw new Error(`Auto-upload rooms PUT failed: HTTP ${res.status}${detail}`)
  }
}

/**
 * DELETE `/api/account/auto-upload/rooms/{project_id}/{room_name}` — clears
 * `auto_mac_uploader` for that room. Used by `chronos-sync auth --reset`
 * to release a previously claimed room before issuing a new PAT.
 *
 * Returns true on 200/204 and on 404 (already released — idempotent). Throws
 * `ApiPatAuthError` on 401 so the caller can degrade gracefully when the old
 * PAT is already revoked.
 */
export async function deleteAutoUploadRoom(
  opts: ApiClientOptions,
  projectId: string,
  roomName: string
): Promise<void> {
  const { serverUrl, pat, timeoutMs = 5000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const url =
    `${serverUrl}/api/account/auto-upload/rooms/` +
    `${encodeURIComponent(projectId)}/${encodeURIComponent(roomName)}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'DELETE',
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
  if (res.ok || res.status === 404) return
  throw new Error(`Auto-upload room DELETE failed: HTTP ${res.status} (${projectId}/${roomName})`)
}

function validateBootstrapBody(body: unknown): BootstrapPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invalid bootstrap response: expected object')
  }
  const b = body as Record<string, unknown>
  for (const k of ['server_url', 'user_email', 'etag', 'fetched_at'] as const) {
    if (typeof b[k] !== 'string' || (b[k] as string).length === 0) {
      throw new Error(`Invalid bootstrap response: ${k} must be a non-empty string`)
    }
  }
  if (
    typeof b.interval_seconds !== 'number' ||
    !Number.isFinite(b.interval_seconds) ||
    b.interval_seconds < MIN_INTERVAL_SECONDS ||
    b.interval_seconds > MAX_INTERVAL_SECONDS
  ) {
    throw new Error(
      `Invalid bootstrap response: interval_seconds must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`
    )
  }
  if (!Array.isArray(b.rooms)) {
    throw new Error('Invalid bootstrap response: rooms must be an array')
  }
  return {
    server_url: b.server_url as string,
    user_email: b.user_email as string,
    interval_seconds: b.interval_seconds,
    rooms: b.rooms as RoomConfig[],
    etag: b.etag as string,
    fetched_at: b.fetched_at as string,
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
    res = await fetch(`${serverUrl}/api/account/settings/sync`, {
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

export async function putSyncSettings(
  opts: ApiClientOptions,
  intervalSeconds: number
): Promise<SyncSettingsResponse> {
  if (
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    throw new Error(
      `interval_seconds must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`
    )
  }

  const { serverUrl, pat, timeoutMs = 5000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/account/settings/sync`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ interval_seconds: Math.floor(intervalSeconds) }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) {
    throw new ApiPatAuthError()
  }
  if (!res.ok) {
    let detail = ''
    try {
      const errBody = (await res.json()) as { error?: string }
      if (errBody.error) detail = `: ${errBody.error}`
    } catch {
      // body not JSON
    }
    throw new Error(`Sync settings PUT failed: HTTP ${res.status}${detail}`)
  }

  const body = await res.json()
  return validateBody(body)
}
