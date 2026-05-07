/**
 * kakaocli `messages --json` output → Mac KakaoTalk CSV export format.
 *
 * The Chronos server already accepts the Mac CSV format (`Date,User,Message`)
 * at `/api/upload/init/chunk/finalize`. Reassembling kakaocli's JSON into the
 * same shape avoids a second ingest path on the server.
 *
 * kakaocli v0.6.0 row schema (from `kakaocli messages --chat <name> --json`
 * or `kakaocli messages --chat-id <id> --json`):
 *   { chat_id, id, sender, sender_id, text, timestamp, is_from_me, type }
 *
 * Output rows are RFC 4180-quoted. Embedded newlines, commas, and quotes in
 * the message body are preserved. System-event payloads (raw JSON like
 * `{"feedType":25,...}`) are rewritten to localized Korean placeholders so
 * the Chronos viewer shows readable text instead of the raw JSON.
 */
export interface KakaoCliMessage {
    /**
     * KakaoTalk chat id. Real ids are 17~19 digit BigInts that exceed
     * `Number.MAX_SAFE_INTEGER`; kakaocli emits them as bare JSON numbers
     * which the daemon rewrites to strings before `JSON.parse` (see
     * `preserveBigIntPrecision` in kakaocli.ts) so the exact digits
     * survive. The field stays union-typed for that reason.
     */
    chat_id: number | string;
    /** kakaocli row id; same BigInt risk as `chat_id`. */
    id: number | string;
    /**
     * Display name from kakaocli's `messages --json` output. KakaoTalk Mac
     * v0.6.0 leaves this `null` for most rows in group / open-chat rooms
     * because the message table does not denormalise the sender's name.
     *
     * Daemon callers should resolve `null` via `resolveSenderNames()`
     * (NTUser SQL JOIN) before reassembly. `reassembleMacCsv()` itself
     * tolerates the leftover `null` and emits an empty user column rather
     * than crashing — that yields a parseable CSV that the server's
     * Chronos parser will still accept.
     */
    sender: string | null;
    /**
     * KakaoTalk userId. Same BigInt risk as `chat_id` — kakaocli emits a
     * bare 19-digit number that loses precision in `JSON.parse`. The
     * daemon rewrites it to a string up front so the resolver's SQL
     * `WHERE userId IN (...)` matches the exact NTUser row. May be 0
     * when `is_from_me` is true.
     */
    sender_id: number | string;
    text: string;
    /** Unix epoch milliseconds (kakaocli emits ms) or ISO string. */
    timestamp: number | string;
    is_from_me: boolean;
    /** Message kind hint from kakaocli ("text", ...). */
    type: string;
}
/**
 * Reassemble kakaocli messages into Mac CSV text.
 *
 * The result starts with the canonical header row and contains one CSV
 * row per message in input order. The Chronos parser's content sniff
 * matches the header and the parser handles missing room name gracefully
 * (UploadModal falls back to the user-selected room name; daemon callers
 * must pass `kakao_original_name` separately to `/api/upload/init`).
 */
export declare function reassembleMacCsv(messages: KakaoCliMessage[]): string;
