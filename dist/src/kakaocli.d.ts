/**
 * Thin wrapper around the kakaocli (silver-flight-group/kakaocli) binary.
 *
 * Only the read side is needed here: list messages newer than the last
 * synced cursor. Sends are out of scope.
 */
import type { KakaoCliMessage } from './csv-reassemble.js';
export interface MessagesQuery {
    /** kakaocli chat display name. Mutually exclusive with `chatId`. */
    chat?: string;
    /**
     * kakaocli chat numeric id. Required when targeting open chats whose
     * `display_name` is "(unknown)" because the Mac KakaoTalk DB does not
     * populate names for server-pushed open chat rooms.
     *
     * Accepts a string or a number; chat ids that exceed
     * `Number.MAX_SAFE_INTEGER` should always be passed as a string to
     * survive `JSON.parse` round-trips. The value is forwarded to kakaocli
     * verbatim via `String(chatId)`.
     */
    chatId?: string | number;
    /** Optional ISO 8601 timestamp; only messages strictly after this are returned. */
    since?: string;
    /**
     * Maximum number of messages kakaocli should return. Forwarded as
     * `--limit <n>`. Defaults to 5000 — kakaocli's own default is 50,
     * which silently truncates large backlogs (e.g. KakaoTalk
     * cross-device login that floods 300+ deferred messages at once).
     * The cycle's client-side `since` filter still narrows the actual
     * upload set, so an oversized limit costs nothing when there is
     * nothing new to deliver.
     */
    limit?: number;
    /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
    binary?: string;
}
/**
 * Default cap for `kakaocli messages --limit`. Picked well above any
 * realistic single-cycle volume so that a multi-hour deferred backlog
 * (cross-device KakaoTalk login that flushes >50 messages at once) is
 * fetched in one call. kakaocli ships with a default of 50, which is
 * the number that bit a v0.3.0 user during a 10h offline gap.
 */
export declare const DEFAULT_MESSAGES_LIMIT = 5000;
/**
 * Invoke `kakaocli messages [--chat <name> | --chat-id <id>] [--since <iso>] --json`
 * and parse the JSON array on stdout. kakaocli streams a single JSON array (or
 * a newline-delimited stream when `--follow` is used; we never use `--follow`
 * because the daemon owns its own scheduler).
 *
 * Either `chat` or `chatId` is required. When both are supplied `chatId`
 * wins to keep behavior aligned with the daemon's room dispatch.
 */
export declare function listMessages(query: MessagesQuery): Promise<KakaoCliMessage[]>;
/**
 * KakaoTalk userIds (and chat ids, log ids) are 19-digit BigInts that
 * exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1 = 9007199254740992). When
 * `JSON.parse` hits a bare number literal in that range it silently
 * rounds the trailing digits to 0, e.g.
 *
 *   "sender_id": 8181328792600516744   →   8181328792600517000
 *
 * That breaks downstream lookups (the resolver's SQL `WHERE userId IN
 * (...)` no longer matches the real NTUser row, every sender falls to
 * the unresolved branch, and PR #7's strict-skip path stalls the
 * cycle indefinitely).
 *
 * We rewrite known BigInt-shaped numeric fields to JSON strings before
 * `JSON.parse` so the exact digits survive. Two emission shapes are
 * covered:
 *   1. Object form (`kakaocli messages --json`):
 *      `"sender_id": 8181328792600516744`  →  `"sender_id": "8181..."`
 *   2. Tuple form (`kakaocli query` 2-D array of `[userId, name]`):
 *      `[6321186593654462422, "드림솔져"]`  →  `["6321...", "드림솔져"]`
 *      Without this the v0.2.7 dho stuck regression happens — every 19-
 *      digit open-chat sender resolves to a rounded map key that no
 *      caller can match.
 *
 * Downstream code (`enrichSenders`, `resolveSenderNames.sanitizeIds`,
 * `parseQueryRows`) already accepts `number | string` for these fields.
 */
export declare function preserveBigIntPrecision(stdout: string): string;
export interface HarvestQuery {
    /** Process top N most recent chats. Default 5. Passed as `--top <n>`. */
    top?: number;
    /** Max 'View Previous Chats' clicks per chat. Passed as `--max-clicks <n>`. */
    maxClicks?: number;
    /** Delay between actions in seconds. Passed as `--scroll-delay <s>`. */
    scrollDelay?: number;
    /** Show what would be done without doing it. */
    dryRun?: boolean;
    /** Path to database file. */
    db?: string;
    /** Database encryption key. */
    key?: string;
    /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
    binary?: string;
    /** Spawn timeout in ms. Default 60000. */
    timeoutMs?: number;
}
export interface HarvestResult {
    code: number;
    stderr: string;
}
export interface HarvestCaps {
    /** kakaocli binary that was probed. */
    binary: string;
    /** Whether `harvest --scroll` is supported. */
    scrollSupported: boolean;
    /** Raw flags extracted from `harvest --help` stdout. */
    flags: string[];
}
/** Invalidate the probe cache (e.g. after exit-64 or SIGHUP). */
export declare function invalidateProbeCache(): void;
/**
 * Parse `kakaocli harvest --help` and return supported capabilities.
 * Result is cached for the process lifetime; call `invalidateProbeCache()` to refresh.
 */
export declare function probeHarvestCapabilities(binary?: string): Promise<HarvestCaps>;
/**
 * Invoke `kakaocli harvest --scroll [--top <n>] [--max-clicks <n>] [--scroll-delay <s>]`.
 * Best-effort: always resolves (never throws) so the caller can warn-log and continue normal sync.
 * On exit-64 the probe cache is invalidated so the next probe re-checks capabilities.
 */
export declare function harvestScroll(query: HarvestQuery): Promise<HarvestResult>;
