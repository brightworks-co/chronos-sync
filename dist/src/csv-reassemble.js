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
    const lines = ['Date,User,Message'];
    for (const m of messages) {
        const date = toKstDateString(m.timestamp);
        // Mac CSV export quotes the User and Message columns so that
        // commas / newlines inside names or content do not break parsing.
        const user = csvQuote(m.sender ?? '', true);
        const message = csvQuote(m.text ?? '', true);
        lines.push(`${date},${user},${message}`);
    }
    // Trailing newline — Mac export ends with a final \n.
    return lines.join('\n') + '\n';
}
