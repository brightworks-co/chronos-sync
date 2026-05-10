/**
 * `~/.chronos/config.cache.json` lifecycle: prime, refresh, ETag, 24h ceiling.
 *
 * v0.5.0 auth-mode replaces the legacy `config.json` static rooms+pat with a
 * server-driven snapshot fetched at boot and on SIGHUP. Mirrors the proven
 * `interval-resolver.ts` shape: module-level cache, in-flight mutex, primed
 * cache + STALE_WARN_AGE_MS + MAX_BOOTSTRAP_CACHE_AGE_MS hard ceiling.
 *
 * Plan reference: PR6 of `.cmux/plans/auto-upload-server-driven-config.md`.
 *
 * Key invariants:
 *   - `last_successful_fetch` (epoch ms) is updated ONLY on 200/304. Network
 *     failure / 5xx / 429 / 401 / 403 do NOT touch it. This makes the 24h
 *     clock count *continuous failure time*, not absolute snapshot age.
 *   - 401/403 INVALIDATE the cache (rename to `.invalidated.<ts>`) so a
 *     daemon restart cannot accidentally resume with revoked credentials.
 *   - 5xx / network / 429 keep the cache; 429 honors `Retry-After`.
 *   - On disk: atomic temp+rename, mode 0600.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  bootstrapCachePath,
  chronosHomeDir,
  type AuthFile,
} from './auth-file.js'
import {
  ApiPatAuthError,
  getBootstrap as fetchBootstrapHttp,
  type BootstrapPayload,
} from './api-client.js'
import type { RoomConfig } from './types.js'

/** Continuous-failure ceiling. Past this, daemon refuses to upload. */
export const MAX_BOOTSTRAP_CACHE_AGE_MS = 24 * 60 * 60 * 1000
/** Cycle-by-cycle warning threshold below the ceiling. */
export const STALE_WARN_AGE_MS = 20 * 60 * 60 * 1000

export type BootstrapMode = 'auth'

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void

/**
 * Persisted snapshot. The `last_successful_fetch` field is the authoritative
 * clock for the 24h ceiling — semantically distinct from `fetched_at` (which
 * is the server-reported wall clock and may be older than a 304 hit).
 */
export interface BootstrapSnapshot {
  server_url: string
  user_email: string
  interval_seconds: number
  rooms: RoomConfig[]
  etag: string
  /** ISO 8601 server-reported timestamp from the most recent 200 payload. */
  fetched_at: string
  /**
   * Epoch ms of the most recent successful 200/304. Updated on every refresh
   * that round-trips OK; pointedly NOT updated on 401/403/5xx/429/network.
   * Drives the 24h continuous-failure ceiling.
   */
  last_successful_fetch: number
}

/**
 * One-shot getter result returned to callers (daemon cycle, foreground UI).
 *
 * `refuse=true` means the daemon must NOT upload this cycle (24h ceiling
 * exceeded, OR cache invalidated by 401/403). `warning` is non-null when the
 * snapshot is in the 20-24h stale band.
 */
export interface BootstrapGetResult {
  snapshot: BootstrapSnapshot | null
  warning: string | null
  refuse: boolean
  /** Optional reason classifier so foreground UI can render `bootstrap: refused (>24h)` etc. */
  status: 'ok' | 'stale' | 'offline' | 'refused-stale' | 'refused-auth' | 'missing'
}

let cached: BootstrapSnapshot | null = null
let inFlight: Promise<void> | null = null
let cacheLoadAttempted = false

/**
 * Reset module-level state. Tests must call this in `beforeEach`.
 */
export function resetBootstrapCacheForTest(): void {
  cached = null
  inFlight = null
  cacheLoadAttempted = false
}

/**
 * Best-effort load of the persisted snapshot from disk. Idempotent — only
 * the first call hits the filesystem; subsequent calls are no-ops until
 * `resetBootstrapCacheForTest()`.
 */
export async function loadCachedSnapshotFromDisk(): Promise<BootstrapSnapshot | null> {
  if (cacheLoadAttempted) return cached
  cacheLoadAttempted = true
  try {
    const raw = await fs.readFile(bootstrapCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BootstrapSnapshot>
    if (!isValidSnapshot(parsed)) return null
    cached = parsed
    return cached
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    // Corrupt JSON / bad shape — treat as missing. The next prime() will
    // overwrite atomically; meanwhile the daemon falls back to `cached=null`
    // and the caller surfaces `status: 'missing'`.
    return null
  }
}

function isValidSnapshot(v: Partial<BootstrapSnapshot>): v is BootstrapSnapshot {
  return (
    typeof v.server_url === 'string' &&
    typeof v.user_email === 'string' &&
    typeof v.interval_seconds === 'number' &&
    Array.isArray(v.rooms) &&
    typeof v.etag === 'string' &&
    typeof v.fetched_at === 'string' &&
    typeof v.last_successful_fetch === 'number' &&
    Number.isFinite(v.last_successful_fetch)
  )
}

/**
 * Atomic write of the cache file: temp + rename, mode 0600.
 */
async function persistSnapshot(snapshot: BootstrapSnapshot): Promise<void> {
  const path = bootstrapCachePath()
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
  await fs.chmod(tmp, 0o600)
  await fs.rename(tmp, path)
}

/**
 * Rename the on-disk cache to `.invalidated.<ts>` so a forensic record exists.
 * Used on 401/403 (PAT revoked / scope reduced) — Daemon must re-auth.
 */
async function invalidateCacheOnDisk(log: LogFn): Promise<void> {
  const path = bootstrapCachePath()
  const ts = Date.now()
  const dst = `${path}.invalidated.${ts}`
  try {
    await fs.rename(path, dst)
    log('warn', 'bootstrap cache invalidated', { renamed_to: dst })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') {
      log('warn', 'failed to invalidate bootstrap cache', { error: err.message })
    }
  }
}

/**
 * Fetch + refresh the cache. Mirrors `primeIntervalCache`: never throws on
 * fetch failure (caller awaits without try/catch); concurrent calls share
 * the same in-flight promise.
 *
 * Outcome handling (CRIT-3):
 *   200      → atomic snapshot replace + last_successful_fetch=now
 *   304      → keep cache + last_successful_fetch=now
 *   401/403  → invalidate cache on disk + clear in-memory + LOG ERROR
 *              (daemon decides whether to exit; resolver does not call exit)
 *   5xx      → keep cache, log warn
 *   network  → keep cache, log warn
 *   429      → keep cache, log warn (Retry-After is logged for diagnostics)
 *
 * The 401/403 path is signaled to the caller via the next `getBootstrap`
 * return: `cached` becomes `null` and the on-disk cache is renamed away,
 * so the next call returns `{ snapshot: null, refuse: true, status: 'refused-auth' }`.
 */
export function primeBootstrap(auth: AuthFile, pat: string, log: LogFn): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    // First-call FS hydration: pull the on-disk snapshot into memory once
    // before the network round-trip so `If-None-Match` can be set if we
    // had a prior etag.
    if (!cacheLoadAttempted) {
      await loadCachedSnapshotFromDisk()
    }

    const etag = cached?.etag
    try {
      const result = await fetchBootstrapHttp(
        { serverUrl: auth.server_url, pat },
        etag
      )
      const now = Date.now()
      if (result.status === 200) {
        const next: BootstrapSnapshot = {
          server_url: result.payload.server_url,
          user_email: result.payload.user_email,
          interval_seconds: result.payload.interval_seconds,
          rooms: result.payload.rooms,
          etag: result.etag || result.payload.etag,
          fetched_at: result.payload.fetched_at,
          last_successful_fetch: now,
        }
        cached = next
        try {
          await persistSnapshot(next)
        } catch (e) {
          log('warn', 'bootstrap snapshot persist failed (in-memory still updated)', {
            error: e instanceof Error ? e.message : String(e),
          })
        }
        log('info', 'bootstrap refreshed (200)', {
          rooms: next.rooms.length,
          interval_seconds: next.interval_seconds,
          etag: next.etag,
        })
      } else {
        // 304 — server says cache is current. Refresh the success timestamp
        // so the 24h clock resets. We don't rewrite the file (etag and rooms
        // unchanged), but in-memory state stays consistent.
        if (cached) {
          cached.last_successful_fetch = now
          // Persist the bumped clock so a daemon restart sees an up-to-date
          // success time and doesn't immediately decide it's stale.
          try {
            await persistSnapshot(cached)
          } catch (e) {
            log('warn', 'bootstrap clock persist failed', {
              error: e instanceof Error ? e.message : String(e),
            })
          }
          log('info', 'bootstrap unchanged (304)', { etag: cached.etag })
        } else {
          // 304 with no prior cache is a server bug — log and treat as soft fail.
          log('warn', 'bootstrap returned 304 without a prior cache', {})
        }
      }
    } catch (e) {
      if (e instanceof ApiPatAuthError) {
        // 401 — PAT revoked. Invalidate cache; the next get returns refuse=true.
        cached = null
        await invalidateCacheOnDisk(log)
        log('error', 'bootstrap auth failed (401) — cache invalidated', {})
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      // 403 surfaces as a generic Error from getBootstrap (status string in
      // message). Detect via substring — the API client formats `HTTP 403`.
      if (/HTTP 403/.test(msg)) {
        cached = null
        await invalidateCacheOnDisk(log)
        log('error', 'bootstrap auth failed (403) — cache invalidated', {})
        return
      }
      if (/HTTP 429/.test(msg)) {
        // Extract Retry-After if the message included it (api-client adds `retry-after=...`).
        const ra = /retry-after=([^\s]+)/.exec(msg)?.[1]
        log('warn', 'bootstrap rate-limited (429); cache untouched', {
          retry_after: ra ?? null,
        })
        return
      }
      // 5xx and network failures (timeout, ECONNREFUSED, abort) — keep cache.
      log('warn', 'bootstrap fetch failed; cache untouched', { error: msg })
    }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Synchronous read for the cycle path. Classifies snapshot freshness vs
 * the 24h ceiling and emits the appropriate `status` + `warning` flags.
 *
 * `refuse: true` means the daemon must NOT upload this cycle. Two paths
 * lead there:
 *   - cache present but `last_successful_fetch` >= 24h ago
 *   - cache absent (was invalidated, OR never primed)
 *
 * The caller (daemon) decides what to do with `refuse`. We DO NOT call
 * `process.exit` from here — keeps this module pure for tests and lets the
 * daemon gate exit on `options.exit_on_health_failure`.
 */
export function getBootstrap(
  log: LogFn,
  now: number = Date.now()
): BootstrapGetResult {
  if (!cached) {
    return {
      snapshot: null,
      warning: null,
      refuse: true,
      status: 'missing',
    }
  }
  const age = now - cached.last_successful_fetch
  if (age >= MAX_BOOTSTRAP_CACHE_AGE_MS) {
    log('warn', 'bootstrap cache stale > 24h — refusing to upload', { age_ms: age })
    return {
      snapshot: cached,
      warning: 'bootstrap cache stale > 24h; check network',
      refuse: true,
      status: 'refused-stale',
    }
  }
  if (age >= STALE_WARN_AGE_MS) {
    return {
      snapshot: cached,
      warning: 'bootstrap stale (≥20h) — server has been unreachable',
      refuse: false,
      status: 'stale',
    }
  }
  return {
    snapshot: cached,
    warning: null,
    refuse: false,
    status: 'ok',
  }
}

/**
 * For the foreground UI header: "bootstrap: ok (Xs ago) | stale | offline | refused (>24h) | missing".
 * Pure — derives label from the snapshot only.
 */
export function bootstrapStatusLabel(now: number = Date.now()): string {
  if (!cached) return 'missing'
  const ageSec = Math.floor((now - cached.last_successful_fetch) / 1000)
  if (now - cached.last_successful_fetch >= MAX_BOOTSTRAP_CACHE_AGE_MS) {
    return `refused (>24h)`
  }
  if (now - cached.last_successful_fetch >= STALE_WARN_AGE_MS) {
    return `stale (${formatAge(ageSec)} ago)`
  }
  return `ok (${formatAge(ageSec)} ago)`
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

/**
 * Test/inspection helper: peek at the in-memory snapshot without touching
 * the FS or recomputing freshness. Daemon code should use `getBootstrap()`.
 */
export function peekCachedSnapshot(): BootstrapSnapshot | null {
  return cached
}

/**
 * Return the path the resolver renames to on 401/403. Exposed for tests so
 * they can assert the invalidated file exists at the expected location.
 */
export function invalidatedCachePathPrefix(): string {
  return join(chronosHomeDir(), 'config.cache.json.invalidated.')
}
