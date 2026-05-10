/**
 * config + state.json + flock helpers for the Mac sync daemon.
 *
 * v0.6.0+: legacy `~/.chronos/config.json` (with embedded `pat`+`rooms`) is
 * no longer supported. The only supported entry point is `auth.json` +
 * `config.cache.json` (auth-mode), populated by `chronos-sync auth`.
 *
 * Filesystem layout under `~/.chronos`:
 *   auth.json          — non-secret PAT metadata (mode 0600)
 *   auth.token         — opt-in plaintext PAT (mode 0600), only when --allow-file-pat
 *   config.cache.json  — server-derived bootstrap snapshot (mode 0600)
 *   state.json         — daemon-managed since-cursor + failure counters
 *   chronos-sync.lock  — single-instance PID lock
 */

import { promises as fs } from 'node:fs'
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_FILE_NAME,
  STATE_FILE_NAME,
  LOCK_FILE_NAME,
} from './constants.js'
import {
  type DaemonConfig,
  type DaemonState,
  type RoomState,
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

/**
 * Thrown when `~/.chronos/auth.json` is absent.
 */
export class ConfigMissingError extends Error {
  constructor() {
    super(
      `No chronos-sync auth.json found.\n` +
        `  Expected ${authPath()} (run "chronos-sync auth chr_pat_...").\n` +
        `  Issue a PAT at https://chronos.brightworks.app/account/api/tokens\n` +
        `  then https://chronos.brightworks.app/account/auto-upload to map rooms.`
    )
    this.name = 'ConfigMissingError'
  }
}

/**
 * Thrown when a v0.4.x `~/.chronos/config.json` (with embedded `pat` or
 * `rooms`) is detected. v0.6.0+ requires auth-mode; the daemon refuses
 * rather than silently ignoring legacy state.
 */
export class LegacyConfigDetectedError extends Error {
  constructor() {
    super(
      `Legacy v0.4.x config.json detected at ${join(chronosHomeDir(), CONFIG_FILE_NAME)}.\n` +
        `  v0.6.0+ requires auth-mode. Issue a fresh PAT and run:\n` +
        `    chronos-sync auth chr_pat_<32hex>\n` +
        `  Then remove the legacy file: rm ${join(chronosHomeDir(), CONFIG_FILE_NAME)}`
    )
    this.name = 'LegacyConfigDetectedError'
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
 * Load the active daemon config. v0.6.0+: auth-mode only.
 *
 * Precedence:
 *   1. auth.json present → synthesize DaemonConfig from auth.json + bootstrap cache.
 *   2. auth.json absent + legacy config.json present → throw `LegacyConfigDetectedError`.
 *   3. neither → throw `ConfigMissingError`.
 *
 * When the bootstrap cache is missing, the synthesized config returns with
 * `rooms: []` and `interval_seconds: DEFAULT_INTERVAL_SECONDS`. The daemon
 * uses the empty rooms list as a signal that it must call `primeBootstrap`
 * before cycling (NTH-4: bootstrap-unreachable + no cache → exit loud).
 */
export async function loadConfig(): Promise<DaemonConfig> {
  const auth = await loadAuth().catch(() => null)
  if (auth) {
    return await loadAuthModeConfig(auth)
  }
  // No auth.json. Distinguish "first-time install" from "lingering v0.4.x
  // config.json" so the error message is actionable.
  if (existsSync(configPath())) {
    throw new LegacyConfigDetectedError()
  }
  throw new ConfigMissingError()
}

/**
 * Auth-mode config synthesis: auth.json + Keychain/file PAT + bootstrap cache.
 *
 * Cache-absent case (auth.json present but `~/.chronos/config.cache.json`
 * missing) returns a placeholder DaemonConfig with empty rooms so the daemon
 * can decide whether to prime now (server reachable) or exit loud (offline).
 * No network I/O is performed here — `primeBootstrap` lives in the daemon
 * orchestration layer.
 */
async function loadAuthModeConfig(auth: NonNullable<Awaited<ReturnType<typeof loadAuth>>>): Promise<DaemonConfig> {
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

  const snapshot = await loadCachedSnapshotFromDisk()
  const interval =
    snapshot?.interval_seconds !== undefined
      ? clampInterval(snapshot.interval_seconds)
      : DEFAULT_INTERVAL_SECONDS

  return {
    server_url: auth.server_url.replace(/\/+$/, ''),
    pat,
    interval_seconds: interval,
    rooms: snapshot?.rooms ?? [],
  }
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
