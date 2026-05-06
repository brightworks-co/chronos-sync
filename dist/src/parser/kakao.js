import { normalizeSender, normalizeContent, isSystemSender, classifyMessage } from './normalize.js';
// Each entry: [regex, variant, capture-group-index-for-name]
// Room line variants — first match wins
const ROOM_LINE_VARIANTS = [
    [/^(.+?)\s*님과\s*카카오톡\s*대화\s*$/, 'ios'], // iOS KR default
    [/^(.+?)\s*님과의\s*카카오톡\s*대화\s*$/, 'aos'], // AOS KR "님과의"
    [/^(.+?)\s*Talk Chats\s*$/i, 'english-ios'], // English iOS (observed)
    [/^KakaoTalk Chats with\s*(.+?)\s*$/i, 'english-aos'], // English AOS (observed)
];
const SAVED_LINE_VARIANTS = [
    /^저장한\s*날짜\s*:\s*(.+)$/, // iOS KR
    /^Date Saved\s*:\s*(.+)$/i, // English
    /^Saved Date\s*:\s*(.+)$/i, // alt English (observed)
];
const DATE_LINE = /^-+\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*[월화수목금토일]요일\s*-+$/;
const MSG_LINE = /^\[(.+?)\]\s*\[(오전|오후)\s+(\d{1,2}):(\d{2})\]\s?(.*)$/;
function stripBom(s) {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}
function to24Hour(ampm, hour) {
    if (ampm === '오전')
        return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
}
export function toTimestampKst(date, time) {
    return Date.parse(`${date}T${time}:00+09:00`);
}
function matchRoomLine(line) {
    for (const [re, variant] of ROOM_LINE_VARIANTS) {
        const m = line.match(re);
        if (m)
            return { variant, name: m[1].trim() };
    }
    return null;
}
function matchSavedLine(line) {
    for (const re of SAVED_LINE_VARIANTS) {
        const m = line.match(re);
        if (m)
            return m[1].trim();
    }
    return null;
}
export function parseKakaoExport(raw, opts = {}) {
    const text = stripBom(raw);
    const lines = text.split(/\r?\n/);
    // Collect first two non-empty lines for header_raw
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const header_raw = {
        line1: nonEmpty[0] ?? '',
        line2: nonEmpty[1] ?? '',
    };
    let kakao_original_name = '';
    let exported_at = '';
    let header_variant = 'unknown';
    if (lines.length > 0) {
        const hit = matchRoomLine(lines[0]);
        if (hit) {
            kakao_original_name = hit.name;
            header_variant = hit.variant;
        }
    }
    if (lines.length > 1) {
        const saved = matchSavedLine(lines[1]);
        if (saved)
            exported_at = saved;
    }
    // Unknown header — return early unless force=true
    if (header_variant === 'unknown' && !opts.force) {
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
    const messages = [];
    let currentDate = null;
    let currentMsg = null;
    let lastMinuteKey = null;
    let sequenceInMinute = 0;
    // When force=true and unknown, start from line 0; otherwise skip header (line 2+)
    const startLine = header_variant === 'unknown' ? 0 : 2;
    const flush = () => {
        if (!currentMsg)
            return;
        currentMsg.kind = classifyMessage(currentMsg.text, currentMsg.sender_raw);
        messages.push(currentMsg);
        currentMsg = null;
    };
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
            continue;
        }
        const dateMatch = line.match(DATE_LINE);
        if (dateMatch) {
            flush();
            const [, y, mo, d] = dateMatch;
            currentDate = `${y}-${pad2(parseInt(mo, 10))}-${pad2(parseInt(d, 10))}`;
            continue;
        }
        const msgMatch = line.match(MSG_LINE);
        if (msgMatch && currentDate) {
            flush();
            const [, sender, ampm, hourStr, minStr, content] = msgMatch;
            const hour24 = to24Hour(ampm, parseInt(hourStr, 10));
            const time = `${pad2(hour24)}:${minStr}`;
            const datetime = `${currentDate} ${time}`;
            const minuteKey = `${currentDate}|${time}`;
            if (minuteKey !== lastMinuteKey) {
                sequenceInMinute = 0;
                lastMinuteKey = minuteKey;
            }
            else {
                sequenceInMinute += 1;
            }
            currentMsg = {
                date: currentDate,
                time,
                datetime,
                timestamp: toTimestampKst(currentDate, time),
                sequence_in_minute: sequenceInMinute,
                sender_raw: `[${sender}]`,
                sender_normalized: normalizeSender(`[${sender}]`),
                text: normalizeContent(content),
                kind: 'text', // placeholder, overwritten by flush()
            };
            continue;
        }
        if (line.trim() && isSystemSender(line)) {
            // Stand-alone system/announcement line (not MSG_LINE-matched)
            flush();
            if (currentDate) {
                const lastTime = lastMinuteKey ? lastMinuteKey.split('|')[1] : '00:00';
                const datetime = `${currentDate} ${lastTime}`;
                const kind = classifyMessage(line, '');
                messages.push({
                    date: currentDate,
                    time: lastTime,
                    datetime,
                    timestamp: toTimestampKst(currentDate, lastTime),
                    sequence_in_minute: 0,
                    sender_raw: '',
                    sender_normalized: '',
                    text: normalizeContent(line),
                    kind,
                });
            }
            continue;
        }
        if (currentMsg && line.trim()) {
            currentMsg.text += `\n${normalizeContent(line)}`;
        }
    }
    flush();
    return {
        room_name: '',
        kakao_original_name,
        exported_at,
        messages,
        header_variant,
        header_raw,
    };
}
