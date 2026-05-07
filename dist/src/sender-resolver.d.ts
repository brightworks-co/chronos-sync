/**
 * Resolve KakaoTalk `sender_id` numeric ids to human-readable nicknames by
 * querying the local KakaoTalk Mac DB through `kakaocli query`.
 *
 * Why this exists
 * ---------------
 * `kakaocli messages --json` v0.6.0 emits `sender: null` for most rows in
 * group / open-chat rooms — the message table does not denormalise the
 * sender's display name. The names live in the `NTUser` table (and an
 * optional `NTMultiProfile` overlay for open chats). A single SQL JOIN
 * gives us the real nickname per `sender_id`, eliminating the
 * `참여자_xxxxxx` placeholder fallback for the typical case.
 *
 * Verified shape (2026-05-06):
 *   SELECT u.userId,
 *          COALESCE(mp.displayName, u.friendNickName, u.nickName, u.displayName) AS name
 *   FROM NTUser u
 *   LEFT JOIN NTMultiProfile mp ON mp.userId = u.userId AND mp.linkId = u.linkId
 *   WHERE u.userId IN (...)
 *
 *   →  [[5283788016742773350, "이몽룡"],
 *       [7193858608577706758, "참가자A(H)"],
 *       [7620971378568187247, "참가자B(E)"]]
 *
 * Precision note
 * --------------
 * KakaoTalk userIds can exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1). 19-digit
 * BigInt userIds (typical for open-chat senders) lose their last 2-3 digits
 * to IEEE 754 rounding when fed through plain `JSON.parse`. We run the
 * `kakaocli query` stdout through `preserveBigIntPrecision` (shared with the
 * `kakaocli messages` parser) before `JSON.parse` so the map keys retain
 * full precision and align exactly with the `String(sender_id)` lookup keys
 * the caller uses.
 *
 * The `IN (...)` clause is built from numbers only; we re-validate that
 * every input is a finite number before stringifying so the query stays
 * SQL-injection safe even though `kakaocli query` is invoked via spawn.
 */
export interface ResolveSenderOptions {
    /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
    binary?: string;
}
/**
 * Look up display names for a list of `sender_id` values.
 *
 * Returns a `Map<string, string>` keyed by `String(sender_id)`. Senders
 * not present in the local DB are simply absent from the map; callers
 * are expected to fall back (e.g. to `참여자_<id>`).
 *
 * Empty input short-circuits without spawning the kakaocli binary so the
 * happy path on a no-op cycle stays free.
 */
export declare function resolveSenderNames(senderIds: ReadonlyArray<number | string>, options?: ResolveSenderOptions): Promise<Map<string, string>>;
/**
 * Build the SQLite query that resolves a comma-separated `userId IN (…)`
 * list to display names.
 *
 * `NULLIF(col, '')` wraps every candidate so empty strings — common for
 * `mp.displayName` in open chats where the multi-profile slot exists but
 * is unset — are treated as missing. Without NULLIF, COALESCE picks the
 * empty string as the first non-NULL value and the row resolves to an
 * empty name, forcing the `참여자_<id>` fallback even when `nickName` has
 * a perfectly good value.
 *
 * Exported so the caller (`resolveSenderNames`) and the test suite share
 * exactly the same statement — regression tests assert the NULLIF wrap
 * stays in place.
 */
export declare function buildResolverSql(idsClause: string): string;
/**
 * Parse `kakaocli query` JSON output. The current shape (verified
 * 2026-05-06) is `[[col1, col2, ...], ...]` — a 2-D array where each row
 * is a tuple of column values in the order they appear in the SELECT.
 *
 * We tolerate the transitional shape `[col1, ...]` (single-column,
 * 1-D array) for forward-compatibility with single-column queries, but
 * the rows we care about here are always 2-D `[userId, name]` pairs.
 */
export declare function parseQueryRows(stdout: string): Map<string, string>;
