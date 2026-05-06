/**
 * Shared types for the Mac chronos-sync daemon.
 */

export interface RoomConfig {
  /**
   * kakaocli chat name (passed as `--chat <name>`).
   *
   * Either `chat_name` or `chat_id` must be set; when both are present
   * `chat_id` wins. Open chat rooms surface as `(unknown)` in
   * `kakaocli chats --json` because the Mac KakaoTalk DB does not
   * populate `display_name` for server-pushed open chats — those rooms
   * must use `chat_id` instead.
   */
  chat_name?: string
  /**
   * kakaocli numeric chat id (passed as `--chat-id <id>`). Required for
   * open chat rooms whose display name is `(unknown)`.
   *
   * Real KakaoTalk chat ids can exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1),
   * so prefer a quoted JSON string ("18296430865364356") to avoid silent
   * precision loss during `JSON.parse`. A bare number is accepted only when
   * it is a safe integer; loadConfig throws otherwise. After validation
   * loadConfig normalizes the field to `string`.
   */
  chat_id?: string | number
  /** Chronos project UUID. */
  project_id: string
  /** Chronos room slug (the canonical key for the upload pipeline). */
  room_name: string
  /**
   * Anchor used by `/api/upload/init` Case A/B/C consistency check.
   * Optional for open chats where the kakaocli display_name is `(unknown)`.
   */
  kakao_original_name?: string
}

export interface SinceOverride {
  /**
   * Multiplier applied to `interval_seconds` when computing the
   * fallback `--since` window for incremental cycles. Default 2.
   *
   * Used only when the per-room cursor is unset (`last_synced_ms === 0`)
   * so the first cycle still runs unbounded; the cursor takes over from
   * the second cycle onward.
   */
  multiplier?: number
  /**
   * Hard override for the `--since` window, expressed in seconds. When
   * set, this wins over `multiplier`. Use `0` to disable the fallback
   * entirely (kakaocli will emit its default page).
   */
  override_seconds?: number
}

export interface DaemonConfig {
  /** Base URL of the Chronos server, e.g. `https://chronos.brightworks.app`. */
  server_url: string
  /** Personal Access Token (`chr_pat_<32hex>`). */
  pat: string
  /** Cycle interval in seconds. Floor 10, ceiling 3600. */
  interval_seconds: number
  /** Optional: path to kakaocli binary. Defaults to `kakaocli` on PATH. */
  kakaocli_path?: string
  /**
   * Optional `--since` window tuning. When omitted, cycles use
   * `interval_seconds * 2` as the floor for the fallback window.
   */
  since?: SinceOverride
  /** Rooms the daemon should keep in sync. */
  rooms: RoomConfig[]
}

export interface RoomState {
  /** Last message timestamp synced to the server, in epoch milliseconds. */
  last_synced_ms: number
  /** Wall-clock timestamp of the last fully successful cycle. */
  last_success_at: number
  /** Number of consecutive cycle failures since the last success. */
  consecutive_failures: number
}

export interface DaemonState {
  /** Per-room cursor state, keyed by `${project_id}:${room_name}`. */
  rooms: Record<string, RoomState>
  /** Daemon-level metadata. */
  daemon: {
    started_at: number
    last_cycle_at: number
  }
}

export const DEFAULT_INTERVAL_SECONDS = 300
export const MIN_INTERVAL_SECONDS = 10
export const MAX_INTERVAL_SECONDS = 3600
export const MAX_CONSECUTIVE_FAILURES = 5
export const MAX_RSS_BYTES = 200 * 1024 * 1024
export const STUCK_THRESHOLD_MS = 60 * 60 * 1000
export const CHUNK_SIZE = 500
