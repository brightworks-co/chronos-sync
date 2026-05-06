/**
 * chronos-sync persistent daemon (Plan 9 A-02 + A-06 + A-08).
 *
 * Lifecycle:
 *   1. Acquire single-instance lock at `~/.chronos/chronos-sync.lock`.
 *   2. Load config + state from `~/.chronos/{config,state}.json`.
 *   3. Loop on an internal `setInterval` (no launchd `StartInterval`):
 *      For each room: ask kakaocli for messages newer than the cursor,
 *      reassemble Mac CSV, parse via the shared dispatcher, upload to
 *      `/api/upload/init/chunk/finalize` with the PAT, advance the
 *      cursor only after a 200 from finalize.
 *   4. Self-terminate (exit 1) when the health checker says we are
 *      leaking, stuck, or repeatedly failing — launchd `KeepAlive`
 *      restarts a fresh process.
 *
 * Signals:
 *   SIGHUP  → reload config (next cycle picks it up; daemon does not
 *             need to drop the lock).
 *   SIGTERM → release lock + exit 0 cleanly.
 */

import { reassembleMacCsv, type KakaoCliMessage } from './csv-reassemble.js'
import { listMessages } from './kakaocli.js'
import { parseExport } from './parser/index.js'
import { resolveSenderNames } from './sender-resolver.js'
import { Uploader, UploadError } from './uploader.js'
import { checkHealth } from './health.js'
import {
  acquireLock,
  loadConfig,
  loadState,
  saveState,
  getRoomState,
  setRoomState,
  releaseLock,
} from './state-file.js'
import { resolveInterval, type ResolvedInterval } from './interval-resolver.js'
import type { DaemonConfig, DaemonState, RoomConfig } from './types.js'

interface CycleOutcome {
  /** Number of rooms with new messages uploaded this cycle. */
  uploaded_rooms: number
  /** Number of rooms whose cycle failed (kakaocli or HTTP). */
  failed_rooms: number
}

export type DaemonLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: unknown
) => void

export interface RoomCycleResult {
  room: RoomConfig
  new_messages: number
  error?: string
}

/**
 * Optional callback fired once per room after the cycle finishes that
 * room's work (success or failure). Used by the foreground UI to print
 * one human-readable line per cycle without coupling to the JSONL log.
 */
export type RoomCycleListener = (result: RoomCycleResult) => void

/**
 * Run a single sync cycle for every configured room. Returns counters
 * so the caller can decide whether the cycle was healthy overall.
 *
 * `onRoom` (optional) is invoked exactly once per room after that
 * room's work finishes — success or failure — so foreground UIs can
 * stream a per-room status line without parsing the JSONL log stream.
 */
export async function runCycle(
  cfg: DaemonConfig,
  state: DaemonState,
  log: DaemonLog = defaultLog,
  onRoom?: RoomCycleListener
): Promise<{ outcome: CycleOutcome; resolved: ResolvedInterval }> {
  state.daemon.cycle_index += 1
  const resolved = await resolveInterval(cfg, state, { now: Date.now, log })

  let uploaded_rooms = 0
  let failed_rooms = 0

  for (const room of cfg.rooms) {
    try {
      const newCount = await syncRoom(cfg, state, room, log)
      if (newCount > 0) uploaded_rooms += 1
      onRoom?.({ room, new_messages: newCount })
    } catch (err) {
      failed_rooms += 1
      const rs = getRoomState(state, room.project_id, room.room_name)
      setRoomState(state, room.project_id, room.room_name, {
        ...rs,
        consecutive_failures: rs.consecutive_failures + 1,
      })
      const message = err instanceof Error ? err.message : String(err)
      log('error', 'sync room failed', {
        chat_name: room.chat_name,
        chat_id: room.chat_id,
        room_name: room.room_name,
        error: message,
      })
      onRoom?.({ room, new_messages: 0, error: message })
    }
  }

  state.daemon.last_cycle_at = Date.now()
  await saveState(state)

  return { outcome: { uploaded_rooms, failed_rooms }, resolved }
}

/**
 * Compute the `--since` argument for a kakaocli call.
 *
 * Precedence:
 *   1. Cursor-based: if the room has a previously synced timestamp, use
 *      it directly (highest fidelity — never re-fetches messages we
 *      already accepted).
 *   2. Config override: `cfg.since.override_seconds` wins when set.
 *   3. Default fallback: `interval_seconds * (multiplier ?? 2)`. This
 *      covers the case where the daemon was offline for a stretch
 *      shorter than the multiplier window — we still pick up the gap.
 *
 * The first cycle (cursor 0, no override) returns `undefined` so
 * kakaocli emits its default backfill page. The next cycle is bounded
 * by the cursor.
 */
export function computeSince(
  cfg: DaemonConfig,
  cursor: { last_synced_ms: number },
  now: number = Date.now()
): string | undefined {
  if (cursor.last_synced_ms > 0) {
    return new Date(cursor.last_synced_ms).toISOString()
  }
  const override = cfg.since?.override_seconds
  if (override !== undefined) {
    if (override <= 0) return undefined
    return new Date(now - override * 1000).toISOString()
  }
  const multiplier = cfg.since?.multiplier ?? 0
  if (multiplier <= 0) return undefined
  const seconds = Math.max(1, Math.floor(cfg.interval_seconds * multiplier))
  return new Date(now - seconds * 1000).toISOString()
}

async function syncRoom(
  cfg: DaemonConfig,
  state: DaemonState,
  room: RoomConfig,
  log: DaemonLog
): Promise<number> {
  const cursor = getRoomState(state, room.project_id, room.room_name)
  const since = computeSince(cfg, cursor)

  const messages = await listMessages({
    chat: room.chat_id !== undefined ? undefined : room.chat_name,
    chatId: room.chat_id,
    since,
    binary: cfg.kakaocli_path,
  })

  if (messages.length === 0) {
    return 0
  }

  const enriched = await enrichSenders(messages, cfg.kakaocli_path, log)

  // Reassemble CSV → parse so the server sees ParsedMessage[] with `kind`.
  const csv = reassembleMacCsv(enriched)
  const parsed = parseExport(csv)
  if (parsed.error) {
    throw new Error(`reassembled CSV failed to parse: ${parsed.error}`)
  }

  // Open chats use chat_id and have no stable display_name — fall back to
  // room_name as the upload anchor so /api/upload/init still receives a value.
  const anchor =
    room.kakao_original_name ?? room.chat_name ?? `chat-${room.chat_id ?? room.room_name}`

  const uploader = new Uploader({ serverUrl: cfg.server_url, pat: cfg.pat })
  await uploader.uploadAll(
    {
      project_id: room.project_id,
      room_name: room.room_name,
      kakao_original_name: anchor,
      total_chunks: 0, // populated by uploader.uploadAll
      total_messages: 0,
      file_name: `chronos-sync-${room.room_name}.csv`,
    },
    parsed.messages,
    csv
  )

  // Advance the cursor only after finalize 200. The kakaocli timestamp is
  // either ms epoch or ISO; Date.parse handles both for the highest seen.
  const lastTs = messages.reduce((max, m) => {
    const t = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp)
    return Number.isFinite(t) && t > max ? t : max
  }, cursor.last_synced_ms)

  setRoomState(state, room.project_id, room.room_name, {
    last_synced_ms: lastTs,
    last_success_at: Date.now(),
    consecutive_failures: 0,
  })

  log('info', 'sync room ok', {
    chat_name: room.chat_name,
    chat_id: room.chat_id,
    room_name: room.room_name,
    new_messages: messages.length,
  })

  return messages.length
}

/**
 * Resolve `sender: null` rows by querying the local KakaoTalk DB for
 * `sender_id → display_name`. Falls back to `참여자_<id>` only when the
 * SQL JOIN cannot find the user (e.g. ex-members purged from NTUser).
 *
 * Errors from `kakaocli query` (binary missing, permission denied, ...)
 * are logged but do not fail the cycle — we degrade to the fallback.
 */
export async function enrichSenders(
  messages: KakaoCliMessage[],
  binary: string | undefined,
  log: DaemonLog
): Promise<KakaoCliMessage[]> {
  // Collect sender_ids that need a name lookup. Skip is_from_me rows —
  // those carry the local user's own name from kakaocli already.
  const needLookup = new Set<number>()
  for (const m of messages) {
    if (m.sender !== null && m.sender !== undefined && m.sender.length > 0) continue
    if (m.is_from_me) continue
    if (typeof m.sender_id === 'number' && Number.isFinite(m.sender_id) && m.sender_id > 0) {
      needLookup.add(m.sender_id)
    }
  }

  let nameMap = new Map<string, string>()
  if (needLookup.size > 0) {
    try {
      nameMap = await resolveSenderNames([...needLookup], { binary })
    } catch (err) {
      log('warn', 'sender resolver failed; falling back to 참여자_<id>', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return messages.map((m) => {
    if (m.sender !== null && m.sender !== undefined && m.sender.length > 0) return m
    if (m.is_from_me) return { ...m, sender: m.sender ?? '나' }
    const key = String(m.sender_id)
    const resolved = nameMap.get(key)
    if (resolved !== undefined) return { ...m, sender: resolved }
    return { ...m, sender: `참여자_${m.sender_id}` }
  })
}

export interface RunOptions {
  /**
   * Override for the JSONL log writer. When omitted the daemon uses
   * structured stdout/stderr writes; foreground callers replace this
   * with a quieter logger so the pretty per-cycle line is the primary
   * stdout stream.
   */
  log?: DaemonLog
  /**
   * Per-room cycle listener. Foreground callers use it to print one
   * human-readable line per room per cycle; the launchd loop leaves it
   * undefined.
   */
  onRoom?: RoomCycleListener
  /**
   * Called once after every cycle completes (after `runCycle` returns
   * but before the sleep + health check). Used by foreground UIs to
   * stream a "cycle finished, sleeping N s" footer.
   */
  onCycle?: (outcome: CycleOutcome, resolvedInterval?: ResolvedInterval) => void
  /**
   * When true the loop exits cleanly on health-check failure rather
   * than calling `process.exit(1)`. Foreground mode opts in so the
   * user sees a friendly farewell line; launchd mode keeps the exit
   * so KeepAlive recycles the process.
   */
  exit_on_health_failure?: boolean
}

/**
 * Long-running entry point — the loop body shared by `daemon` (launchd
 * background) and the foreground `chronos-sync` invocation.
 *
 * The launchd path keeps `exit_on_health_failure: true` so the OS
 * restarts a leaky process; the foreground path keeps the loop alive
 * but logs the verdict so the user can decide what to do.
 */
export async function runLoop(options: RunOptions = {}): Promise<void> {
  if (!acquireLock()) {
    process.stderr.write('chronos-sync: another instance already running\n')
    process.exit(0)
  }

  const log = options.log ?? defaultLog
  let cfg = await loadConfig()
  const state = await loadState()
  state.daemon.started_at = Date.now()

  process.on('SIGHUP', () => {
    void (async () => {
      try {
        cfg = await loadConfig()
        log('info', 'config reloaded via SIGHUP', {
          interval_seconds: cfg.interval_seconds,
          rooms: cfg.rooms.length,
        })
      } catch (err) {
        log('error', 'config reload failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  })

  let shuttingDown = false
  const shutdown = (sig: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', `received ${sig} — releasing lock and exiting`)
    releaseLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  while (!shuttingDown) {
    let resolved: ResolvedInterval | undefined
    try {
      const result = await runCycle(cfg, state, log, options.onRoom)
      resolved = result.resolved
      options.onCycle?.(result.outcome, resolved)
    } catch (err) {
      log('error', 'cycle threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const verdict = checkHealth(state)
    if (!verdict.healthy) {
      log('error', 'self-health check failed', { reason: verdict.reason })
      if (options.exit_on_health_failure) {
        releaseLock()
        process.exit(1)
      }
    }

    const sleepMs = resolved ? resolved.value * 1000 : cfg.interval_seconds * 1000
    await sleep(sleepMs)
  }
}

/**
 * Background (launchd) entry point. Keeps the legacy `chronos-sync
 * daemon` semantics: hard-exit on health failure so launchd's
 * `KeepAlive` swaps in a fresh process.
 */
export async function main(): Promise<void> {
  await runLoop({ exit_on_health_failure: true })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultLog(
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: unknown
): void {
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ctx: ctx ?? null,
  })
  if (level === 'error') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

// Re-export for tests + manual integration.
export { UploadError }
