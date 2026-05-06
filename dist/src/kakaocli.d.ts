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
