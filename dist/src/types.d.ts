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
    chat_name?: string;
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
    chat_id?: string | number;
    /** Chronos project UUID. */
    project_id: string;
    /** Chronos room slug (the canonical key for the upload pipeline). */
    room_name: string;
    /**
     * Anchor used by `/api/upload/init` Case A/B/C consistency check.
     * Optional for open chats where the kakaocli display_name is `(unknown)`.
     */
    kakao_original_name?: string;
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
    multiplier?: number;
    /**
     * Hard override for the `--since` window, expressed in seconds. When
     * set, this wins over `multiplier`. Use `0` to disable the fallback
     * entirely (kakaocli will emit its default page).
     */
    override_seconds?: number;
}
export interface DaemonConfig {
    /** Base URL of the Chronos server, e.g. `https://chronos.brightworks.app`. */
    server_url: string;
    /** Personal Access Token (`chr_pat_<32hex>`). */
    pat: string;
    /** Cycle interval in seconds. Floor 10, ceiling 3600. */
    interval_seconds: number;
    /** Optional: path to kakaocli binary. Defaults to `kakaocli` on PATH. */
    kakaocli_path?: string;
    /**
     * Optional `--since` window tuning. When omitted, cycles use
     * `interval_seconds * 2` as the floor for the fallback window.
     */
    since?: SinceOverride;
    /** Optional harvest threshold overrides. When omitted, defaults apply (12h/24h/30min/5pages). */
    harvest?: HarvestThresholds;
    /** Rooms the daemon should keep in sync. */
    rooms: RoomConfig[];
}
export interface HarvestThresholds {
    /**
     * Enable automatic cycle-scope harvest. Default `false` as of v0.2.9.
     *
     * Rationale: KakaoTalk macOS auto-populates NTUser/NTMultiProfile when push
     * messages arrive in the foreground app, so an explicit `harvest --scroll`
     * is rarely required for steady-state sync. The auto-spawn was disruptive
     * in real-world use (KakaoTalk window stealing focus, unread chats getting
     * skipped anyway). With this flag off, the daemon never spawns harvest;
     * users who want a one-off backfill should run `chronos-sync harvest`.
     *
     * v0.2.7/0.2.8 behaved as if this flag were `true`. Set `enabled: true` in
     * config.json to keep that behavior.
     */
    enabled?: boolean;
    /** Gap threshold (sec). Gap between previous cycle last message and new message timestamp; triggers harvest when exceeded. Default 12h (43200). */
    gap_seconds?: number;
    /** Startup threshold (sec). On daemon first cycle, triggers harvest when last_message_at is older than this value. Default 24h (86400). */
    startup_seconds?: number;
    /** Rate limit (sec). Minimum interval between harvest calls for the same room. Default 30min (1800). */
    rate_limit_seconds?: number;
    /**
     * @deprecated kakaocli 0.4.1 `harvest` does not accept `--max-pages`. Use `max_clicks` instead.
     * Accepted on read for backwards compat; emits one warn at startup then ignored.
     */
    max_pages?: number;
    /** Process top N most recent chats. Passed as `--top <n>`. Default 5. */
    top?: number;
    /** Max 'View Previous Chats' clicks per chat. Passed as `--max-clicks <n>`. Default 3. */
    max_clicks?: number;
    /** Delay between scroll actions in seconds. Passed as `--scroll-delay <s>`. Default 1.5. */
    scroll_delay?: number;
    /** Consecutive stuck-cycles threshold before a nudge notification is emitted per room. Default 5. */
    stuck_nudge_threshold?: number;
    /** Base seconds for harvest failure exponential backoff. Default 1800. */
    harvest_failure_backoff_base_seconds?: number;
    /** Maximum seconds for harvest failure exponential backoff cap. Default 28800. */
    harvest_failure_backoff_max_seconds?: number;
}
export interface RoomState {
    /** Last message timestamp synced to the server, in epoch milliseconds. */
    last_synced_ms: number;
    /** Wall-clock timestamp of the last fully successful cycle. */
    last_success_at: number;
    /** Number of consecutive cycle failures since the last success. */
    consecutive_failures: number;
    /**
     * @deprecated Moved to `DaemonState.daemon.last_harvest_at` (daemon-scope). Reader-only for
     * backwards-compat with 0.2.6 state files; never written by 0.2.7+.
     */
    last_harvest_at?: number;
    /**
     * Number of consecutive cycles that were held back because at least one
     * `sender_id` could not be resolved to a display name. Reset to 0 when
     * a cycle uploads cleanly. The daemon never sends `참여자_<id>` to the
     * server; instead the whole cycle is skipped and the cursor stays put,
     * waiting for KakaoTalk to populate `NTUser`. This counter exists so
     * operators can detect senders that are stuck unresolvable indefinitely.
     */
    consecutive_stuck_cycles?: number;
}
export type IntervalSource = 'server' | 'cached' | 'config' | 'default';
/**
 * Persisted interval cache shape from v0.2.x. v0.3.0+ no longer writes
 * this field (the cache lives in `src/interval-resolver.ts` module
 * state, primed at boot and on SIGHUP). The interface stays for
 * read-side backward compatibility — older state.json files are loaded
 * without error, and the field is simply ignored on read.
 *
 * `consecutive_failures` and `skip_until_cycle` are optional with
 * default 0 because the v0.3.0 reader does not depend on them; a
 * strict schema validator must not reject either an absent or zero
 * value. Both fields are slated for removal in a future release.
 */
export interface IntervalCache {
    value: number;
    fetched_at: string;
    source: IntervalSource;
    consecutive_failures?: number;
    /** Cycle counter (monotonic) at which the next fetch should resume after circuit-open. 0 = not in skip mode. */
    skip_until_cycle?: number;
}
export interface DaemonState {
    /** Per-room cursor state, keyed by `${project_id}:${room_name}`. */
    rooms: Record<string, RoomState>;
    /** Daemon-level metadata. */
    daemon: {
        started_at: number;
        last_cycle_at: number;
        /** Monotonic cycle counter. Incremented at the start of every runCycle invocation. */
        cycle_index: number;
        /** Wall-clock epoch ms of the last harvestScroll spawn. 0 = never called. Persisted. */
        last_harvest_at?: number;
    };
    /** Last-known interval value resolved at the start of a cycle. Survives daemon restarts. */
    interval_cache?: IntervalCache;
}
export declare const DEFAULT_INTERVAL_SECONDS = 300;
export declare const MIN_INTERVAL_SECONDS = 10;
export declare const MAX_INTERVAL_SECONDS = 3600;
export declare const MAX_CONSECUTIVE_FAILURES = 5;
export declare const MAX_RSS_BYTES: number;
export declare const STUCK_THRESHOLD_MS: number;
export declare const CHUNK_SIZE = 500;
export declare const DEFAULT_HARVEST_GAP_SECONDS: number;
export declare const DEFAULT_HARVEST_STARTUP_SECONDS: number;
export declare const DEFAULT_HARVEST_RATE_LIMIT_SECONDS: number;
export declare const DEFAULT_HARVEST_MAX_PAGES = 5;
export declare const DEFAULT_HARVEST_TOP = 5;
export declare const DEFAULT_HARVEST_MAX_CLICKS = 3;
export declare const DEFAULT_HARVEST_SCROLL_DELAY = 1.5;
export declare const DEFAULT_HARVEST_STUCK_NUDGE_THRESHOLD = 5;
export declare const DEFAULT_HARVEST_FAILURE_BACKOFF_BASE_SECONDS = 1800;
export declare const DEFAULT_HARVEST_FAILURE_BACKOFF_MAX_SECONDS = 28800;
/**
 * Default for `HarvestThresholds.enabled`. v0.2.9 changed this from `true`
 * (the v0.2.7/0.2.8 implicit behavior) to `false`. See JSDoc on `enabled`.
 */
export declare const DEFAULT_HARVEST_ENABLED = false;
/**
 * In-memory only runtime state for the daemon. NOT persisted to state.json.
 * Reset to defaults on every process start.
 */
export interface DaemonRuntime {
    /** Wall-clock epoch ms of the last harvestScroll spawn. 0 = never called. */
    last_harvest_at: number;
    /** Number of consecutive harvestScroll non-zero exits since last success. Reset on process restart. */
    consecutive_harvest_failures: number;
    /** Per-room flag tracking whether a stuck-nudge has been emitted for the current stuck sequence. */
    stuck_nudge_flags: Record<string, boolean>;
    /**
     * PID of the `caffeinate -i -w <pid>` child spawned in foreground mode to
     * suppress macOS idle sleep. `undefined` when foreground mode is off, the
     * host is not darwin, or `CHRONOS_NO_CAFFEINATE=1` disabled the guard.
     * In-memory only — never persisted (a stale PID after crash would mis-kill
     * an unrelated process).
     */
    caffeinate_pid?: number;
}
