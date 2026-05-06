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
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from './types.js'

export function chronosDir(): string {
  return join(homedir(), DAEMON_DIR_NAME)
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

export async function loadConfig(): Promise<DaemonConfig> {
  const raw = await fs.readFile(configPath(), 'utf8')
  const parsed = JSON.parse(raw) as Partial<DaemonConfig>

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

  const interval = clampInterval(parsed.interval_seconds ?? DEFAULT_INTERVAL_SECONDS)
  const since = normalizeSinceOverride(parsed.since)

  return {
    server_url: parsed.server_url.replace(/\/+$/, ''),
    pat: parsed.pat,
    interval_seconds: interval,
    kakaocli_path: parsed.kakaocli_path,
    since,
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
    daemon: { started_at: Date.now(), last_cycle_at: 0, cycle_index: 0 },
  }
}

export async function loadState(): Promise<DaemonState> {
  try {
    const raw = await fs.readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as DaemonState
    if (!parsed.rooms || typeof parsed.rooms !== 'object') return emptyState()
    if (!parsed.daemon) parsed.daemon = { started_at: Date.now(), last_cycle_at: 0, cycle_index: 0 }
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
