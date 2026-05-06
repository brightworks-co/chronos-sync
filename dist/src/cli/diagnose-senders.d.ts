/**
 * `chronos-sync diagnose senders [<chat-name|chat-id>]`
 *
 * One-shot tool for figuring out *why* a chat is showing
 * `참여자_<sender_id>` in Chronos. The daemon's `enrichSenders`
 * resolves missing names via `kakaocli query` against the local Mac
 * KakaoTalk DB (NTUser + NTMultiProfile join). When that JOIN can't
 * find a row — open chats with non-friend members, ex-members purged
 * from NTUser, kakaocli `query` subcommand missing, userId precision
 * overflow — we fall back to the `참여자_<id>` placeholder.
 *
 * This subcommand prints a per-sender_id breakdown of a recent message
 * window so the user can tell the failure mode at a glance:
 *   - already populated by kakaocli messages JSON
 *   - is_from_me (local user, skipped on purpose)
 *   - resolved via NTUser JOIN (current happy path)
 *   - NOT FOUND — actual fallback hits with hints
 *
 * For every NOT FOUND we also probe NTUser directly via
 * `kakaocli query` so the report distinguishes "id legitimately missing
 * from local DB" from "kakaocli query subcommand failing for a different
 * reason".
 */
export interface DiagnoseResult {
    exitCode: number;
}
/**
 * Print a friendly diagnostic report for one room. Returns exit code 0
 * for any successful report (even when fallbacks are present — the
 * report itself is the deliverable). Returns 1 only on hard failures
 * like missing config or unparseable arguments.
 */
export declare function runDiagnoseSenders(arg: string | undefined, out?: NodeJS.WritableStream, err?: NodeJS.WritableStream): Promise<DiagnoseResult>;
