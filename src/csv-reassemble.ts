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
 * the message body are preserved.
 */

export interface KakaoCliMessage {
  /**
   * KakaoTalk chat id. Real ids are 17~19 digit BigInts that exceed
   * `Number.MAX_SAFE_INTEGER`; kakaocli emits them as bare JSON numbers
   * which the daemon rewrites to strings before `JSON.parse` (see
   * `preserveBigIntPrecision` in kakaocli.ts) so the exact digits
   * survive. The field stays union-typed for that reason.
   */
  chat_id: number | string
  /** kakaocli row id; same BigInt risk as `chat_id`. */
  id: number | string
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
  sender: string | null
  /**
   * KakaoTalk userId. Same BigInt risk as `chat_id` — kakaocli emits a
   * bare 19-digit number that loses precision in `JSON.parse`. The
   * daemon rewrites it to a string up front so the resolver's SQL
   * `WHERE userId IN (...)` matches the exact NTUser row. May be 0
   * when `is_from_me` is true.
   */
  sender_id: number | string
  text: string
  /** Unix epoch milliseconds (kakaocli emits ms) or ISO string. */
  timestamp: number | string
  is_from_me: boolean
  /** Message kind hint from kakaocli ("text", ...). */
  type: string
}

/** Pad a number to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Format `Date` as `YYYY-MM-DD HH:MM:SS` in KST (UTC+9), matching what the
 * Mac KakaoTalk app writes in its CSV export.
 */
function toKstDateString(input: number | string): string {
  const ms = typeof input === 'number' ? input : Date.parse(input)
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp: ${input}`)
  }
  const kst = new Date(ms + 9 * 3600 * 1000)
  return (
    `${kst.getUTCFullYear()}-` +
    `${pad2(kst.getUTCMonth() + 1)}-` +
    `${pad2(kst.getUTCDate())} ` +
    `${pad2(kst.getUTCHours())}:` +
    `${pad2(kst.getUTCMinutes())}:` +
    `${pad2(kst.getUTCSeconds())}`
  )
}

/**
 * Quote a CSV field per RFC 4180. Only quotes when needed
 * (contains `,`, `"`, `\n`, or `\r`); always quotes if the caller
 * asked for it (e.g. for the author column which holds names that
 * may contain spaces — Mac CSV export quotes every non-empty cell).
 */
function csvQuote(s: string, alwaysQuote = false): string {
  if (!alwaysQuote && !/[",\r\n]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
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
export function reassembleMacCsv(messages: KakaoCliMessage[]): string {
  const lines: string[] = ['Date,User,Message']
  for (const m of messages) {
    const date = toKstDateString(m.timestamp)
    // Mac CSV export quotes the User and Message columns so that
    // commas / newlines inside names or content do not break parsing.
    const user = csvQuote(m.sender ?? '', true)
    const message = csvQuote(m.text ?? '', true)
    lines.push(`${date},${user},${message}`)
  }
  // Trailing newline — Mac export ends with a final \n.
  return lines.join('\n') + '\n'
}
