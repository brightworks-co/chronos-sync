/**
 * config.json + state.json + flock helpers for the Mac sync daemon.
 *
 * Filesystem layout under `~/.chronos`:
 *   config.json — user-managed daemon settings
 *   state.json — daemon-managed since-cursor + failure counters
 *   chronos-sync.lock — single-instance PID lock
 */

import { promises as fs } from 'node:fs'
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DAEMON_DIR_NAME,
  CONFIG_FILE_NAME,
  STATE_FILE_NAME,
  LOCK_FILE_NAME,
} from './constants.js'
import {
  type DaemonConfig,
  type DaemonState,
  type RoomState,
  type SinceOverride,
  type HarvestThresholds,
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from './types.js'
import {
  authPath,
  chronosHomeDir,
  loadAuth,
  loadPatFile,
} from './auth-file.js'
import { getPat as keychainGetPat } from './keychain.js'
import { loadCachedSnapshotFromDisk } from './bootstrap-resolver.js'

let maxPagesWarnEmitted = false
let legacyDeprecationBannerEmitted = false

/** Reset the max_pages deprecation warn guard. For use in tests only. */
export function resetMaxPagesWarnForTest(): void {
  maxPagesWarnEmitted = false
}

/** Reset the v0.6.0 legacy deprecation banner guard. For use in tests only. */
export function resetLegacyDeprecationBannerForTest(): void {
  legacyDeprecationBannerEmitted = false
}

/**
 * Thrown when neither `~/.chronos/auth.json` nor `~/.chronos/config.json`
 * exists. Surfaces an actionable recovery message linking to the install
 * page so launchd's KeepAlive doesn't loop without context.
 */
export class ConfigMissingError extends Error {
  constructor() {
    super(
      `No chronos-sync config found.\n` +
        `  Expected ${authPath()} (run "chronos-sync auth")\n` +
        `  or legacy ${join(chronosHomeDir(), CONFIG_FILE_NAME)}.\n` +
        `  https://chronos.brightworks.app/account/auto-upload/install`
    )
    this.name = 'ConfigMissingError'
  }
}

/**
 * Thrown when both `~/.chronos/auth.json` AND a legacy `~/.chronos/config.json`
 * with embedded credentials/rooms are present. PR5's auth-time precondition
 * usually prevents this state; this is the defensive sibling check that fires
 * if the user fiddled manually.
 */
export class ConfigConflictError extends Error {
  constructor() {
    super(
      `both auth.json and legacy config.json with embedded credentials/rooms detected. ` +
        `Pick one — recommended: rm ${join(chronosHomeDir(), CONFIG_FILE_NAME)} ` +
        `(after copying any unmigrated rooms via "chronos-sync migrate"), or rm ${authPath()} to revert to legacy.`
    )
    this.name = 'ConfigConflictError'
  }
}

/**
 * Thrown when auth.json declares `pat_storage: 'keychain'` but the Keychain
 * lookup returns null (entry missing) — the user must re-run `chronos-sync
 * auth`. Distinct error class so the daemon can match it precisely.
 */
export class AuthCredentialMissingError extends Error {
  constructor(detail: string) {
    super(`Keychain entry missing for chronos-sync. Re-run "chronos-sync auth" to reauthorize. (${detail})`)
    this.name = 'AuthCredentialMissingError'
  }
}

export function chronosDir(): string {
  return chronosHomeDir()
}

export function configPath(): string {
  return join(chronosDir(), CONFIG_FILE_NAME)
}

export function statePath(): string {
  return join(chronosDir(), STATE_FILE_NAME)
}

export function lockPath(): string {
  return join(chronosDir(), LOCK_FILE_NAME)
}

/**
 * 4-branch precedence rule (PR6 of auto-upload-server-driven-config plan):
 *
 *   (1) auth.json present + (no legacy config.json OR legacy without embedded
 *       creds/rooms) → AUTH-MODE: read auth.json + bootstrap cache.
 *   (2) auth.json present + legacy config.json with embedded creds/rooms →
 *       defensive REFUSE (PR5 precondition usually prevents this).
 *   (3) legacy config.json only → LEGACY-MODE with one-shot deprecation banner.
 *   (4) neither → ConfigMissingError.
 *
 * Branch 1 returns a synthesized DaemonConfig. When the bootstrap cache is
 * absent (auth.json present but `chronos-sync` never ran successfully against
 * a reachable server post-auth), the config returns with `rooms: []` and
 * `interval_seconds: DEFAULT_INTERVAL_SECONDS`. The daemon uses the empty
 * rooms list as a signal that it must call `primeBootstrap` before cycling.
 */
export async function loadConfig(): Promise<DaemonConfig> {
  const auth = await loadAuth().catch(() => null)
  const legacyParsed = await readLegacyConfigIfPresent()

  const legacyHasCreds =
    legacyParsed !== null &&
    ((typeof legacyParsed.pat === 'string' && legacyParsed.pat.length > 0) ||
      (Array.isArray(legacyParsed.rooms) && legacyParsed.rooms.length > 0))

  // Branch 2: defensive refuse.
  if (auth && legacyHasCreds) {
    throw new ConfigConflictError()
  }

  // Branch 1: auth-mode.
  if (auth) {
    return await loadAuthModeConfig(auth)
  }

  // Branch 3: legacy.
  if (legacyParsed !== null) {
    emitLegacyDeprecationBannerOnce()
    return parseLegacyConfig(legacyParsed)
  }

  // Branch 4.
  throw new ConfigMissingError()
}

async function readLegacyConfigIfPresent(): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await fs.readFile(configPath(), 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>
    }
    throw new Error('config.json must be a JSON object')
  } catch (e) {
    if ((e as Error).name === 'SyntaxError') {
      throw new Error(`config.json is not valid JSON: ${(e as Error).message}`)
    }
    throw e
  }
}

function emitLegacyDeprecationBannerOnce(): void {
  if (legacyDeprecationBannerEmitted) return
  legacyDeprecationBannerEmitted = true
  process.stderr.write(
    '\x1b[33m!\x1b[0m legacy config.json detected; v0.6.0 will reject this. ' +
      'Run "chronos-sync migrate" to switch to auth-mode.\n'
  )
}

/**
 * Auth-mode config synthesis: auth.json + Keychain/file PAT + bootstrap cache.
 *
 * Cache-absent case (auth.json present but `~/.chronos/config.cache.json`
 * missing) returns a placeholder DaemonConfig with empty rooms so the daemon
 * can decide whether to prime now (server reachable) or exit loud (offline,
 * NTH-4). We deliberately do NOT do network I/O here — `primeBootstrap` lives
 * in the daemon orchestration layer, mirroring the existing
 * `primeIntervalCache` separation.
 */
async function loadAuthModeConfig(auth: Awaited<ReturnType<typeof loadAuth>>): Promise<DaemonConfig> {
  if (!auth) throw new Error('loadAuthModeConfig called without auth')

  // Resolve PAT — Keychain happy path or `--allow-file-pat` opt-in file.
  let pat: string
  if (auth.pat_storage === 'keychain') {
    let resolved: string | null = null
    try {
      resolved = await keychainGetPat(auth.user_email)
    } catch (e) {
      throw new AuthCredentialMissingError((e as Error).message)
    }
    if (!resolved) {
      throw new AuthCredentialMissingError(`account=${auth.user_email}`)
    }
    pat = resolved
  } else {
    const fromFile = await loadPatFile()
    if (!fromFile) {
      throw new AuthCredentialMissingError(
        `auth.token missing at ${join(chronosHomeDir(), 'auth.token')}`
      )
    }
    pat = fromFile
  }

  // Read the cached bootstrap snapshot from disk. Absent → empty rooms; the
  // daemon prime step will fill it.
  const snapshot = await loadCachedSnapshotFromDisk()
  const interval =
    snapshot?.interval_seconds !== undefined
      ? clampInterval(snapshot.interval_seconds)
      : DEFAULT_INTERVAL_SECONDS

  return {
    mode: 'auth',
    server_url: auth.server_url.replace(/\/+$/, ''),
    pat,
    interval_seconds: interval,
    rooms: snapshot?.rooms ?? [],
  }
}

/**
 * Validate + normalize a legacy config.json into a DaemonConfig. Same logic
 * as the v0.4.x `loadConfig` body — extracted so the auth-mode branch can
 * stay surgical.
 */
function parseLegacyConfig(parsed: Record<string, unknown>): DaemonConfig {
  if (!parsed.server_url || typeof parsed.server_url !== 'string') {
    throw new Error('config.server_url missing or not a string')
  }
  if (!parsed.pat || typeof parsed.pat !== 'string' || !parsed.pat.startsWith('chr_pat_')) {
    throw new Error('config.pat missing or malformed (expected chr_pat_<32hex>)')
  }
  if (!Array.isArray(parsed.rooms) || parsed.rooms.length === 0) {
    throw new Error('config.rooms must be a non-empty array')
  }

  const normalizedRooms = parsed.rooms.map((room, i) => {
    const hasName = typeof room?.chat_name === 'string' && room.chat_name.length > 0
    const normalizedChatId = normalizeChatId(room?.chat_id, i)
    if (!hasName && normalizedChatId === undefined) {
      throw new Error(`config.rooms[${i}] must have chat_name or chat_id`)
    }
    if (!room?.project_id || typeof room.project_id !== 'string') {
      throw new Error(`config.rooms[${i}].project_id missing or not a string`)
    }
    if (!room?.room_name || typeof room.room_name !== 'string') {
      throw new Error(`config.rooms[${i}].room_name missing or not a string`)
    }
    return { ...room, chat_id: normalizedChatId }
  })

  const interval = clampInterval((parsed.interval_seconds as number | undefined) ?? DEFAULT_INTERVAL_SECONDS)
  const since = normalizeSinceOverride(parsed.since)
  const harvest = normalizeHarvestThresholds(parsed.harvest)

  return {
    mode: 'legacy',
    server_url: parsed.server_url.replace(/\/+$/, ''),
    pat: parsed.pat,
    interval_seconds: interval,
    kakaocli_path: parsed.kakaocli_path as string | undefined,
    since,
    harvest,
    rooms: normalizedRooms,
  }
}

/**
 * Validate the optional `since` block in config.json. Either subfield is
 * optional but must be a non-negative finite number when present.
 */
function normalizeSinceOverride(value: unknown): SinceOverride | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') {
    throw new Error('config.since must be an object when present')
  }
  const raw = value as Record<string, unknown>
  const out: SinceOverride = {}
  if (raw.multiplier !== undefined) {
    const m = raw.multiplier
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) {
      throw new Error('config.since.multiplier must be a non-negative finite number')
    }
    out.multiplier = m
  }
  if (raw.override_seconds !== undefined) {
    const o = raw.override_seconds
    if (typeof o !== 'number' || !Number.isFinite(o) || o < 0) {
      throw new Error('config.since.override_seconds must be a non-negative finite number')
    }
    out.override_seconds = Math.floor(o)
  }
  return out
}

function normalizeHarvestThresholds(value: unknown): HarvestThresholds | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') {
    throw new Error('config.harvest must be an object when present')
  }
  const raw = value as Record<string, unknown>
  const out: HarvestThresholds = {}

  const intFields = [
    'gap_seconds',
    'startup_seconds',
    'rate_limit_seconds',
    'top',
    'max_clicks',
    'stuck_nudge_threshold',
    'harvest_failure_backoff_base_seconds',
    'harvest_failure_backoff_max_seconds',
  ] as const

  for (const k of intFields) {
    if (raw[k] !== undefined) {
      const v = raw[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`config.harvest.${k} must be a non-negative finite number`)
      }
      out[k] = Math.floor(v)
    }
  }

  // scroll_delay is a float (seconds), not floored
  if (raw.scroll_delay !== undefined) {
    const v = raw.scroll_delay
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error('config.harvest.scroll_delay must be a non-negative finite number')
    }
    out.scroll_delay = v
  }

  // max_pages: deprecated — read tolerated, emit one warn, then drop from output
  if (raw.max_pages !== undefined) {
    const v = raw.max_pages
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error('config.harvest.max_pages must be a non-negative finite number')
    }
    if (!maxPagesWarnEmitted) {
      maxPagesWarnEmitted = true
      process.stderr.write(
        '[chronos-sync] config.harvest.max_pages is deprecated and ignored. ' +
          'kakaocli 0.4.1 does not accept --max-pages. Use max_clicks instead.\n'
      )
    }
    out.max_pages = Math.floor(v)
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw new Error('config.harvest.enabled must be a boolean when present')
    }
    out.enabled = raw.enabled
  }

  return out
}

/**
 * Validate and normalize a `chat_id` to a numeric string.
 *
 * Returns `undefined` when the field is missing.
 *
 * Rules:
 *   - `string`: must match `/^[0-9]+$/`. Returned verbatim.
 *   - `number`: must be a non-negative `Number.isSafeInteger`. Numbers that
 *     overflow 2^53 - 1 are rejected because `JSON.parse` silently rounds
 *     them, which would route the daemon to the wrong room.
 *   - anything else throws.
 */
function normalizeChatId(value: unknown, index: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) {
      throw new Error(
        `config.rooms[${index}].chat_id ${JSON.stringify(value)} is not a numeric string. ` +
          `Use a positive integer in JSON quoted form, e.g. "18296430865364356".`
      )
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`config.rooms[${index}].chat_id is not a finite number`)
    }
    if (value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(
        `config.rooms[${index}].chat_id ${value} exceeds Number.MAX_SAFE_INTEGER. ` +
          `JSON parsing may have truncated the value. Re-issue chat_id as a quoted JSON ` +
          `string (e.g., "chat_id": "18296430865364356") to preserve precision.`
      )
    }
    return String(value)
  }
  throw new Error(
    `config.rooms[${index}].chat_id must be a string or number (got ${typeof value})`
  )
}

export function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SECONDS
  return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.floor(n)))
}

export function emptyState(): DaemonState {
  return {
    rooms: {},
    daemon: { started_at: Date.now(), last_cycle_at: 0, cycle_index: 0, last_harvest_at: 0 },
  }
}

export async function loadState(): Promise<DaemonState> {
  try {
    const raw = await fs.readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as DaemonState
    if (!parsed.rooms || typeof parsed.rooms !== 'object') return emptyState()
    if (!parsed.daemon) {
      parsed.daemon = { started_at: Date.now(), last_cycle_at: 0, cycle_index: 0 }
    }
    // Forward-compat: 0.2.6 state files lack last_harvest_at; default to 0.
    if (parsed.daemon.last_harvest_at === undefined) {
      parsed.daemon.last_harvest_at = 0
    }
    return parsed
  } catch {
    return emptyState()
  }
}

export async function saveState(state: DaemonState): Promise<void> {
  const tmp = `${statePath()}.tmp`
  await fs.mkdir(chronosDir(), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, statePath())
}

export function roomStateKey(projectId: string, roomName: string): string {
  return `${projectId}:${roomName}`
}

export function getRoomState(state: DaemonState, projectId: string, roomName: string): RoomState {
  const key = roomStateKey(projectId, roomName)
  return (
    state.rooms[key] ?? {
      last_synced_ms: 0,
      last_success_at: 0,
      consecutive_failures: 0,
      last_harvest_at: 0,
    }
  )
}

export function setRoomState(
  state: DaemonState,
  projectId: string,
  roomName: string,
  next: RoomState
): void {
  state.rooms[roomStateKey(projectId, roomName)] = next
}

/**
 * Acquire a single-instance lock by writing the current PID to the lock file.
 *
 * Returns true when the lock is acquired (this process owns it) and false
 * when an active sibling process already holds it. A stale lock (the
 * recorded PID no longer points to a live process) is reclaimed.
 */
export function acquireLock(): boolean {
  const path = lockPath()
  if (existsSync(path)) {
    try {
      const pid = parseInt(readFileSync(path, 'utf8').trim(), 10)
      if (Number.isFinite(pid) && isPidAlive(pid)) {
        return false
      }
    } catch {
      // unreadable lock file — treat as stale
    }
  }
  const fd = openSync(path, 'w')
  writeSync(fd, String(process.pid))
  closeSync(fd)
  return true
}

export function releaseLock(): void {
  const path = lockPath()
  try {
    if (existsSync(path)) {
      const pid = parseInt(readFileSync(path, 'utf8').trim(), 10)
      if (pid === process.pid) {
        // synchronous unlink so the SIGTERM handler completes before exit
        unlinkSync(path)
      }
    }
  } catch {
    // best effort
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // EPERM means the process exists but is owned by another user → still alive.
    return err.code === 'EPERM'
  }
}
