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
    /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
    binary?: string;
}
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
 * `JSON.parse` so the exact digits survive. Downstream code
 * (`enrichSenders`, `resolveSenderNames.sanitizeIds`) already accepts
 * `number | string` for these fields.
 */
export declare function preserveBigIntPrecision(stdout: string): string;
export interface HarvestQuery {
    /** kakaocli chat display name. Mutually exclusive with `chatId`. */
    chat?: string;
    /** kakaocli chat numeric id. */
    chatId?: string | number;
    /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
    binary?: string;
    /** Max scroll pages. Default 5. Passed as `--max-pages <n>`. */
    maxPages?: number;
    /** Spawn timeout in ms. Default 60000. */
    timeoutMs?: number;
}
export interface HarvestResult {
    code: number;
    stderr: string;
}
/**
 * Invoke `kakaocli harvest --scroll [--chat <name> | --chat-id <id>] [--max-pages <n>]`.
 * Best-effort: always resolves (never throws) so the caller can warn-log and continue normal sync.
 */
export declare function harvestScroll(query: HarvestQuery): Promise<HarvestResult>;
