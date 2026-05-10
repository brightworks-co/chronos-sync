import { toTimestampKst } from './kakao.js';
import { normalizeSender, normalizeContent, classifyMessage } from './normalize.js';
/**
 * Length to which raw kakaocli logId values are zero-padded so lexicographic
 * ASC = numeric ASC = utterance-time ASC. Real ids are 19 digits (observed
 * via T6 spike) — pad to 20 for a one-digit safety margin.
 */
const LOGID_PAD_LENGTH = 20;
function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}
/**
 * Minimal RFC-4180 CSV parser (state machine).
 * Returns array of rows, each row is array of field strings.
 * Handles: quoted fields, embedded commas, embedded newlines, escaped quotes ("").
 */
function parseCsvRows(raw) {
    const rows = [];
    const fields = [];
    let field = '';
    let inQuote = false;
    let i = 0;
    const flush = () => {
        fields.push(field);
        field = '';
    };
    const endRow = () => {
        flush();
        if (fields.length > 0) {
            rows.push([...fields]);
        }
        fields.length = 0;
    };
    while (i < raw.length) {
        const ch = raw[i];
        if (inQuote) {
            if (ch === '"') {
                // Peek next
                if (i + 1 < raw.length && raw[i + 1] === '"') {
                    // Escaped quote ""
                    field += '"';
                    i += 2;
                }
                else {
                    // End of quoted field
                    inQuote = false;
                    i += 1;
                }
            }
            else {
                field += ch;
                i += 1;
            }
        }
        else {
            if (ch === '"') {
                inQuote = true;
                i += 1;
            }
            else if (ch === ',') {
                flush();
                i += 1;
            }
            else if (ch === '\r') {
                // \r\n or lone \r
                endRow();
                i += 1;
                if (i < raw.length && raw[i] === '\n')
                    i += 1;
            }
            else if (ch === '\n') {
                endRow();
                i += 1;
            }
            else {
                field += ch;
                i += 1;
            }
        }
    }
    // Flush last field/row (no trailing newline)
    if (field.length > 0 || fields.length > 0) {
        endRow();
    }
    return rows;
}
export function parseMacCsv(raw, opts = {}) {
    // Strip BOM
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const rows = parseCsvRows(text);
    if (rows.length === 0) {
        return {
            room_name: '',
            kakao_original_name: '',
            exported_at: '',
            messages: [],
            header_variant: 'mac-csv',
            header_raw: { line1: '', line2: '' },
            error: 'Empty CSV',
        };
    }
    const headerRow = rows[0];
    const header_raw = {
        line1: headerRow.join(','),
        line2: rows[1]?.join(',') ?? '',
    };
    // Validate header (allow surrounding whitespace per dispatcher's lenient sniff)
    if (!headerRow[0]?.trim().match(/^Date$/i) ||
        !headerRow[1]?.trim().match(/^User$/i) ||
        !headerRow[2]?.trim().match(/^Message$/i)) {
        return {
            room_name: '',
            kakao_original_name: '',
            exported_at: '',
            messages: [],
            header_variant: 'unknown',
            header_raw,
            error: 'Unknown header format',
        };
    }
    // v5: detect csv-format-v5 variants by inspecting 4th+ header columns.
    //   - 3-col legacy:  Date,User,Message                                   (log_id undefined)
    //   - 4-col:         Date,User,Message,LogId                             (row[3] → log_id)
    //   - 6-col:         Date,User,Message,Seconds,LogId,ChatType            (row[4] → log_id)
    // Falls back to 3-col when none of the optional headers match — preserves
    // backward compat for any third-party producer.
    const col3 = headerRow[3]?.trim().toLowerCase() ?? '';
    const col4 = headerRow[4]?.trim().toLowerCase() ?? '';
    let logIdColumn = null;
    if (col3 === 'logid') {
        logIdColumn = 3;
    }
    else if (col4 === 'logid') {
        logIdColumn = 4;
    }
    const messages = [];
    let lastMinuteKey = null;
    let sequenceInMinute = 0;
    for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length < 3)
            continue;
        const rawDate = row[0]?.trim() ?? '';
        const rawUser = row[1]?.trim() ?? '';
        const rawMessage = row[2] ?? '';
        // Determine date/time
        let date = '';
        let time = '';
        let datetime = '';
        let timestamp = 0;
        if (rawDate) {
            // Mac KakaoTalk export uses a dotted, variable-width format —
            // e.g. `2026.5.5 0:02` (1~2 digit month/day/hour, no seconds).
            // Older exports use a dashed zero-padded format like
            // `2026-05-05 00:02:00`. Match both shapes and zero-pad to the
            // canonical `YYYY-MM-DD HH:MM` we store everywhere downstream.
            const m = rawDate.match(/^(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
            if (m) {
                const yyyy = m[1];
                const mo = m[2].padStart(2, '0');
                const d = m[3].padStart(2, '0');
                const hh = m[4].padStart(2, '0');
                const min = m[5];
                date = `${yyyy}-${mo}-${d}`;
                time = `${hh}:${min}`;
                datetime = `${date} ${time}`;
                timestamp = toTimestampKst(date, time);
            }
        }
        const senderRaw = rawUser;
        const senderNormalized = rawUser ? normalizeSender(rawUser) : '';
        const content = normalizeContent(rawMessage);
        // Skip empty-text rows. KakaoTalk Mac/Windows exports leave non-text
        // messages (이모티콘 / 사진 / 음성메시지 / 동영상 / 보이스톡) as a
        // blank Message column. Pushing them creates ghost rows in the
        // viewer ("아무 내용도 없는 채팅글"). The daemon's kakaocli output
        // independently emits the same blank text for the same messages
        // (type='unknown', text=''). Drop them here so daemon path and
        // manual export path produce the same record set.
        if (content.length === 0)
            continue;
        // sequence_in_minute — counted only for rows we keep.
        const minuteKey = date && time ? `${date}|${time}` : null;
        if (minuteKey) {
            if (minuteKey !== lastMinuteKey) {
                sequenceInMinute = 0;
                lastMinuteKey = minuteKey;
            }
            else {
                sequenceInMinute += 1;
            }
        }
        const kind = classifyMessage(content, senderRaw);
        // v5: capture logId when csv-format-v5 header was detected.
        let logId;
        if (logIdColumn !== null) {
            const raw = row[logIdColumn]?.trim() ?? '';
            if (raw.length > 0) {
                logId = raw.padStart(LOGID_PAD_LENGTH, '0');
            }
        }
        messages.push({
            date,
            time,
            datetime,
            timestamp,
            sequence_in_minute: minuteKey ? sequenceInMinute : 0,
            sender_raw: senderRaw,
            sender_normalized: senderNormalized,
            text: content,
            kind,
            ...(logId !== undefined ? { log_id: logId } : {}),
        });
    }
    return {
        room_name: '',
        kakao_original_name: '',
        exported_at: '',
        messages,
        header_variant: 'mac-csv',
        header_raw,
    };
}
