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
import { listMessages, harvestScroll, probeHarvestCapabilities, invalidateProbeCache } from './kakaocli.js'
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
import {
  getBootstrap as getCachedBootstrap,
  primeBootstrap,
} from './bootstrap-resolver.js'
import { loadAuth } from './auth-file.js'
import type {
  DaemonConfig,
  DaemonState,
  RoomConfig,
  DaemonRuntime,
  ResolvedInterval,
} from './types.js'
import {
  DEFAULT_HARVEST_TOP,
  DEFAULT_HARVEST_MAX_CLICKS,
  DEFAULT_HARVEST_SCROLL_DELAY,
  DEFAULT_HARVEST_STUCK_NUDGE_THRESHOLD,
  DEFAULT_HARVEST_ENABLED,
} from './types.js'
import { decideCycleHarvest, type HarvestReason } from './harvest-detector.js'
import { append } from './notifications.js'
import { maybeStartCaffeinate, maybeStopCaffeinate } from './caffeinate.js'

interface CycleOutcome {
  /** Number of rooms with new messages uploaded this cycle. */
  uploaded_rooms: number
  /** Number of rooms whose cycle failed (kakaocli or HTTP). */
  failed_rooms: number
  /**
   * Set when auth-mode bootstrap-resolver classifies the snapshot as
   * `refuse: true` — either 24h continuous-failure ceiling exceeded
   * (`refused-stale`) or the on-disk cache was invalidated by a 401/403
   * response (`refused-auth`/`missing`). Caller (runLoop) translates this
   * into a non-zero exit per CRIT-3.
   */
  refused?: 'refused-stale' | 'refused-auth' | 'missing'
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

// Module-level daemon runtime state — reset on every runLoop start.
let daemonRuntime: DaemonRuntime = {
  last_harvest_at: 0,
  consecutive_harvest_failures: 0,
  stuck_nudge_flags: {},
}

/**
 * Evaluate per-room stuck-nudge thresholds after the room loop.
 * Emits exactly one notification per room per stuck sequence.
 * Flag is reset on successful cycle (in syncRoom success path).
 */
async function evaluateStuckNudge(
  state: DaemonState,
  cfg: DaemonConfig,
  log: DaemonLog
): Promise<void> {
  const nudgeThreshold =
    cfg.harvest?.stuck_nudge_threshold ?? DEFAULT_HARVEST_STUCK_NUDGE_THRESHOLD

  for (const room of cfg.rooms) {
    const roomKey = `${room.project_id}/${room.room_name}`
    const rs = getRoomState(state, room.project_id, room.room_name)
    const stuck = rs.consecutive_stuck_cycles ?? 0
    if (stuck >= nudgeThreshold && !daemonRuntime.stuck_nudge_flags[roomKey]) {
      daemonRuntime.stuck_nudge_flags[roomKey] = true
      log('warn', 'stuck room nudge threshold reached', {
        room_name: room.room_name,
        consecutive_stuck_cycles: stuck,
      })
      await append({
        level: 'error_user_actionable',
        msg: `Room "${room.room_name}" has been stuck for ${stuck} consecutive cycles. Run: chronos-sync diagnose senders`,
        ctx: {
          room_name: room.room_name,
          project_id: room.project_id,
          consecutive_stuck_cycles: stuck,
        },
      })
    }
  }
}

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
  onRoom?: RoomCycleListener,
  onHarvest?: RunOptions['onHarvest']
): Promise<{ outcome: CycleOutcome; resolved: ResolvedInterval }> {
  state.daemon.cycle_index += 1

  // bootstrap-resolver is the sole truth for interval + rooms. If the
  // resolver classifies the cache as `refuse: true` (24h ceiling or
  // 401-invalidated or missing), short-circuit the cycle so runLoop can
  // exit per CRIT-3.
  const bootstrap = getCachedBootstrap(log)
  if (bootstrap.refuse) {
    log('error', 'bootstrap refused upload', {
      status: bootstrap.status,
      warning: bootstrap.warning,
    })
    return {
      outcome: {
        uploaded_rooms: 0,
        failed_rooms: 0,
        refused:
          bootstrap.status === 'refused-stale' ||
          bootstrap.status === 'refused-auth' ||
          bootstrap.status === 'missing'
            ? bootstrap.status
            : 'missing',
      },
      resolved: {
        value: cfg.interval_seconds,
        source: 'config',
        fetched_at: new Date().toISOString(),
        warning: bootstrap.warning,
      },
    }
  }
  const effectiveCfg: DaemonConfig = {
    ...cfg,
    interval_seconds: bootstrap.snapshot?.interval_seconds ?? cfg.interval_seconds,
    rooms: bootstrap.snapshot?.rooms ?? cfg.rooms,
  }
  const resolved: ResolvedInterval = {
    value: effectiveCfg.interval_seconds,
    source: 'cached',
    fetched_at: bootstrap.snapshot?.fetched_at ?? new Date().toISOString(),
    warning: bootstrap.warning,
  }

  // Daemon-scope harvest decision (pre-loop, cycle-scoped, ≤1 spawn per cycle).
  const cycleDecision = decideCycleHarvest({
    rooms: state.rooms,
    daemonLastHarvestAt: state.daemon.last_harvest_at ?? 0,
    consecutiveHarvestFailures: daemonRuntime.consecutive_harvest_failures,
    now: Date.now(),
    thresholds: cfg.harvest,
  })

  let harvested_this_cycle = false

  if (cycleDecision.shouldHarvest) {
    // Optimistic write (ADR 0007): record spawn time before await to guard
    // against launchd restart during the harvest chain.
    state.daemon.last_harvest_at = Date.now()
    daemonRuntime.last_harvest_at = state.daemon.last_harvest_at

    log('info', 'harvest --scroll triggered (cycle-scope)', {
      triggers: cycleDecision.triggers,
    })

    const harvest = await harvestScroll({
      top: cfg.harvest?.top ?? DEFAULT_HARVEST_TOP,
      maxClicks: cfg.harvest?.max_clicks ?? DEFAULT_HARVEST_MAX_CLICKS,
      scrollDelay: cfg.harvest?.scroll_delay ?? DEFAULT_HARVEST_SCROLL_DELAY,
      binary: cfg.kakaocli_path,
    })

    if (harvest.code !== 0) {
      daemonRuntime.consecutive_harvest_failures += 1
      log('warn', 'harvest --scroll non-zero exit (continuing)', {
        code: harvest.code,
        stderr: harvest.stderr.slice(0, 200),
      })
      await append({
        level: 'warn',
        msg: 'harvest --scroll failed',
        ctx: { code: harvest.code, consecutive_failures: daemonRuntime.consecutive_harvest_failures },
      })
    } else {
      daemonRuntime.consecutive_harvest_failures = 0
    }

    harvested_this_cycle = true
    // roomKey is "${project_id}:${room_name}" — extract room_name for the callback
    const firstTriggerKey = cycleDecision.triggers[0]?.roomKey ?? ''
    const firstRoomName = firstTriggerKey.includes(':')
      ? firstTriggerKey.slice(firstTriggerKey.indexOf(':') + 1)
      : firstTriggerKey
    onHarvest?.({
      roomName: firstRoomName,
      reason: cycleDecision.triggers[0]?.reason ?? null,
      code: harvest.code,
    })
  }

  let uploaded_rooms = 0
  let failed_rooms = 0

  for (const room of effectiveCfg.rooms) {
    try {
      const newCount = await syncRoom(effectiveCfg, state, room, log, harvested_this_cycle)
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

  // Evaluate stuck-nudge after room loop
  await evaluateStuckNudge(state, effectiveCfg, log)

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
  log: DaemonLog,
  harvestedThisCycle: boolean
): Promise<number> {
  const cursor = getRoomState(state, room.project_id, room.room_name)
  const since = computeSince(cfg, cursor)

  const messages = await listMessages({
    chat: room.chat_id !== undefined ? undefined : room.chat_name,
    chatId: room.chat_id,
    since,
    limit: cfg.messages?.limit,
    binary: cfg.kakaocli_path,
  })

  if (messages.length === 0) {
    return 0
  }

  // Client-side post-filter: kakaocli's `--since` argument is not honored —
  // the binary returns the most recent N messages regardless of the timestamp.
  // Without this guard every cycle re-uploads the same window as a dup-only
  // batch, polluting the project's upload history and wasting server hits.
  // Once kakaocli respects `--since` natively this guard becomes a no-op.
  const filtered =
    cursor.last_synced_ms > 0
      ? messages.filter((m) => {
          const ts =
            typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp)
          return Number.isFinite(ts) && ts > cursor.last_synced_ms
        })
      : messages

  if (filtered.length === 0) {
    return 0
  }

  const enriched = await enrichSenders(filtered, cfg.kakaocli_path, log)

  // Hold back the entire cycle if any sender could not be resolved. We
  // never send `참여자_<id>` to the server — once KakaoTalk populates
  // NTUser for the missing sender_id (typically within a few minutes
  // after the user first appears in the chat) the next cycle will pick
  // those messages up cleanly. Cursor stays put so we re-fetch them.
  const unresolved = enriched.filter(
    (m) => m.sender === null || m.sender === undefined || m.sender.length === 0
  )
  if (unresolved.length > 0) {
    // Grace cycle: if harvest ran this cycle, do not increment stuck counter yet.
    // NTUser may still be settling — give it one cycle grace period.
    const currentStuck = cursor.consecutive_stuck_cycles ?? 0
    const nextStuck = harvestedThisCycle ? currentStuck : currentStuck + 1
    setRoomState(state, room.project_id, room.room_name, {
      ...cursor,
      consecutive_stuck_cycles: nextStuck,
    })
    log('warn', 'unresolved senders — cycle held back, cursor unchanged', {
      chat_name: room.chat_name,
      chat_id: room.chat_id,
      room_name: room.room_name,
      held_back: unresolved.length,
      sample_sender_ids: unresolved.slice(0, 3).map((m) => m.sender_id),
      consecutive_stuck_cycles: nextStuck,
    })
    return 0
  }

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
  // Use `filtered` so the cursor reflects only the messages we actually
  // uploaded — kakaocli emits older messages too (since-filter is broken).
  const lastTs = filtered.reduce((max, m) => {
    const t = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp)
    return Number.isFinite(t) && t > max ? t : max
  }, cursor.last_synced_ms)

  const roomKey = `${room.project_id}/${room.room_name}`
  // Reset stuck-nudge flag on success so the next stuck sequence can re-fire.
  delete daemonRuntime.stuck_nudge_flags[roomKey]

  setRoomState(state, room.project_id, room.room_name, {
    ...cursor,
    last_synced_ms: lastTs,
    last_success_at: Date.now(),
    consecutive_failures: 0,
    consecutive_stuck_cycles: 0,
  })

  log('info', 'sync room ok', {
    chat_name: room.chat_name,
    chat_id: room.chat_id,
    room_name: room.room_name,
    new_messages: filtered.length,
    raw_messages: messages.length,
  })

  return filtered.length
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
  // sender_id may be a string when it exceeds Number.MAX_SAFE_INTEGER —
  // see preserveBigIntPrecision in kakaocli.ts.
  const needLookup = new Set<string>()
  for (const m of messages) {
    if (m.sender !== null && m.sender !== undefined && m.sender.length > 0) continue
    if (m.is_from_me) continue
    if (typeof m.sender_id === 'number') {
      if (!Number.isFinite(m.sender_id) || m.sender_id <= 0) continue
      needLookup.add(String(m.sender_id))
    } else if (typeof m.sender_id === 'string') {
      if (!/^[1-9][0-9]*$/.test(m.sender_id)) continue
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
    // Resolution failed. Leave `sender` as null so the caller can hold
    // back the entire cycle — we never send `참여자_<id>` to the server.
    return { ...m, sender: null }
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
  /**
   * Called when a harvest --scroll is triggered or skipped (rate limited).
   * Foreground UIs use this to surface harvest events to the user.
   */
  onHarvest?: (info: { roomName: string; reason: HarvestReason; code?: number }) => void
  /**
   * When true the loop spawns `caffeinate -i -w <pid>` on darwin so macOS
   * does not idle-sleep while the daemon is running. The launchd path
   * leaves this off (launchd controls wake/sleep itself); the foreground
   * `chronos-sync` invocation opts in.
   *
   * Skipped on non-darwin hosts and when `CHRONOS_NO_CAFFEINATE=1` is set.
   */
  foreground?: boolean
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

  // Reset runtime state at loop start so restart gives a clean slate.
  daemonRuntime = {
    last_harvest_at: 0,
    consecutive_harvest_failures: 0,
    stuck_nudge_flags: {},
    caffeinate_pid: undefined,
  }

  // Foreground mode on darwin: keep the host awake while the daemon is
  // running. `caffeinate -i -w <pid>` exits automatically when this
  // process dies, so SIGKILL still releases the sleep policy.
  const caffeinate = maybeStartCaffeinate({
    foreground: options.foreground === true,
    log,
  })
  daemonRuntime.caffeinate_pid = caffeinate.pid

  let cfg = await loadConfig()
  const state = await loadState()
  state.daemon.started_at = Date.now()

  // bootstrap-resolver is the sole source of truth for `interval_seconds`
  // and `rooms`. Prime once at boot + on SIGHUP, never per-cycle.
  const auth = await loadAuth()
  if (!auth) {
    log('error', 'auth.json missing after loadConfig — re-run "chronos-sync auth"')
    releaseLock()
    process.exit(1)
  }
  await primeBootstrap(auth, cfg.pat, log)
  // Cache may have been freshly primed; re-load so cfg.rooms reflects it.
  try {
    cfg = await loadConfig()
  } catch (err) {
    log('error', 'config reload after first prime failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // auth.json present + bootstrap unreachable + no prior cache → exit loud
  // with an actionable error rather than spinning a useless cycle loop.
  if (cfg.rooms.length === 0) {
    log('error', 'bootstrap snapshot unavailable: server unreachable AND no cached snapshot. Re-run when network is available.')
    releaseLock()
    process.exit(1)
  }

  // Probe harvest capabilities once at boot — only when harvest is enabled.
  // v0.2.9 changed `enabled` default to false (see HarvestThresholds JSDoc):
  // KakaoTalk auto-populates NTUser on incoming push messages, so steady-state
  // sync rarely needs harvest. Users who want one-off backfill should run
  // `chronos-sync harvest` instead.
  let harvestDisabled = false
  const harvestEnabled = cfg.harvest?.enabled ?? DEFAULT_HARVEST_ENABLED
  if (!harvestEnabled) {
    harvestDisabled = true
    log(
      'info',
      'harvest disabled by config (harvest.enabled is not true). Run `chronos-sync harvest` for a one-off backfill.'
    )
  } else {
    try {
      const caps = await probeHarvestCapabilities(cfg.kakaocli_path ?? 'kakaocli')
      if (!caps.scrollSupported) {
        harvestDisabled = true
        log('warn', 'harvest disabled: kakaocli does not support --scroll', {
          binary: cfg.kakaocli_path ?? 'kakaocli',
          flags: caps.flags,
        })
        await append({
          level: 'error_user_actionable',
          msg: 'harvest --scroll is not supported by the installed kakaocli binary. Upgrade kakaocli to re-enable harvest.',
          ctx: { binary: cfg.kakaocli_path ?? 'kakaocli' },
        })
      } else {
        log('info', 'harvest probe ok', { scrollSupported: true })
      }
    } catch (err) {
      harvestDisabled = true
      log('warn', 'harvest probe failed; harvest disabled for this session', {
        error: err instanceof Error ? err.message : String(err),
      })
      await append({
        level: 'error_user_actionable',
        msg: 'harvest probe failed at startup. Harvest is disabled. Check kakaocli installation.',
        ctx: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // Wrap runCycle to inject harvestDisabled into decideCycleHarvest via state override.
  // When harvest is disabled, we stub out state.daemon.last_harvest_at to a far-future
  // value so decideCycleHarvest always returns rate_limited (shouldHarvest: false).
  const harvestDisabledSentinel = Date.now() + 365 * 24 * 3600 * 1000

  process.on('SIGHUP', () => {
    void (async () => {
      try {
        cfg = await loadConfig()
        invalidateProbeCache()
        log('info', 'config reloaded via SIGHUP', {
          interval_seconds: cfg.interval_seconds,
          rooms: cfg.rooms.length,
        })
      } catch (err) {
        log('error', 'config reload failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Refresh bootstrap from the server. In-flight mutex inside primeBootstrap
      // deduplicates rapid SIGHUP bursts. Errors swallowed inside prime.
      const refreshAuth = await loadAuth().catch(() => null)
      if (refreshAuth) void primeBootstrap(refreshAuth, cfg.pat, log)
    })()
  })

  let shuttingDown = false
  const shutdown = (sig: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', `received ${sig} — releasing lock and exiting`)
    maybeStopCaffeinate({ pid: daemonRuntime.caffeinate_pid, log })
    releaseLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  while (!shuttingDown) {
    // When harvest is disabled, pin last_harvest_at to far-future so
    // decideCycleHarvest always skips without any code changes in runCycle.
    if (harvestDisabled) {
      state.daemon.last_harvest_at = harvestDisabledSentinel
    }

    let resolved: ResolvedInterval | undefined
    let refused: CycleOutcome['refused']
    try {
      const result = await runCycle(cfg, state, log, options.onRoom, options.onHarvest)
      resolved = result.resolved
      refused = result.outcome.refused
      options.onCycle?.(result.outcome, resolved)
    } catch (err) {
      log('error', 'cycle threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Auth-mode CRIT-3: cache invalidated (401/403), or 24h continuous-failure
    // ceiling exceeded, or no cache + server unreachable. Daemon must exit
    // non-zero so launchd KeepAlive cycles a fresh process (which then runs
    // through loadConfig/primeBootstrap again and either recovers or dies loud).
    if (refused) {
      const message =
        refused === 'refused-auth'
          ? 'PAT rejected by server (401/403). re-run "chronos-sync auth" with a fresh PAT.'
          : refused === 'refused-stale'
            ? 'bootstrap cache stale > 24h; check network.'
            : 'bootstrap snapshot unavailable. re-run "chronos-sync auth" or check network.'
      log('error', message, { reason: refused })
      releaseLock()
      process.exit(1)
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
