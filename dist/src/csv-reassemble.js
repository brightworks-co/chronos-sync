/**
 * kakaocli `messages --json` output → Mac KakaoTalk CSV export format.
 *
 * The Chronos server accepts the Mac CSV format at
 * `/api/upload/init/chunk/finalize`. Reassembling kakaocli's JSON into the
 * same shape avoids a second ingest path on the server.
 *
 * Output schema (csv-format-v5, 4-col): `Date,User,Message,LogId`. The Chronos
 * v5 receiver auto-detects the header and falls back to legacy 3-col
 * (`Date,User,Message`) so older daemons keep working. The 4-col `LogId`
 * column carries kakaocli's monotone-increasing row id (`m.id`, BigInt-safe
 * stringified) and powers the v5 sort tuple (`compareForSequencing` 5-tier:
 * timestamp / log_id / text / sender / message_id) — fixing the v4 fundamental
 * tiebreak defect where same-minute messages were ordered by text-ASC instead
 * of natural utterance order.
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
import { transformFeedTypeText } from './parser/feedtype.js';
/** Pad a number to two digits. */
function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}
/**
 * Format `Date` as `YYYY-MM-DD HH:MM:SS` in KST (UTC+9), matching what the
 * Mac KakaoTalk app writes in its CSV export.
 */
function toKstDateString(input) {
    const ms = typeof input === 'number' ? input : Date.parse(input);
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid timestamp: ${input}`);
    }
    const kst = new Date(ms + 9 * 3600 * 1000);
    return (`${kst.getUTCFullYear()}-` +
        `${pad2(kst.getUTCMonth() + 1)}-` +
        `${pad2(kst.getUTCDate())} ` +
        `${pad2(kst.getUTCHours())}:` +
        `${pad2(kst.getUTCMinutes())}:` +
        `${pad2(kst.getUTCSeconds())}`);
}
/**
 * Quote a CSV field per RFC 4180. Only quotes when needed
 * (contains `,`, `"`, `\n`, or `\r`); always quotes if the caller
 * asked for it (e.g. for the author column which holds names that
 * may contain spaces — Mac CSV export quotes every non-empty cell).
 */
function csvQuote(s, alwaysQuote = false) {
    if (!alwaysQuote && !/[",\r\n]/.test(s))
        return s;
    return `"${s.replace(/"/g, '""')}"`;
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
export function reassembleMacCsv(messages) {
    const lines = ['Date,User,Message,LogId'];
    for (const m of messages) {
        const date = toKstDateString(m.timestamp);
        // Mac CSV export quotes the User and Message columns so that
        // commas / newlines inside names or content do not break parsing.
        const user = csvQuote(m.sender ?? '', true);
        const message = csvQuote(transformFeedTypeText(m.text ?? ''), true);
        // logId is kakaocli's monotone row id. Stringified to dodge JS number
        // precision loss (real ids are 19-digit BigInts > 2^53). Always quoted
        // so receivers do not numeric-cast the column.
        const logId = csvQuote(String(m.id ?? ''), true);
        lines.push(`${date},${user},${message},${logId}`);
    }
    // Trailing newline — Mac export ends with a final \n.
    return lines.join('\n') + '\n';
}
