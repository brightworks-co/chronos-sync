/**
 * `chronos-sync status` — render config + state for human eyes.
 *
 * Stdout-only happy path; stderr is reserved for unexpected throws.
 * Always exits 0 on degraded (config/state load failure) so users can
 * troubleshoot via the printed header instead of a stack trace.
 */
import { configPath, statePath, loadConfig, loadState } from '../state-file.js';
import { VERSION } from '../constants.js';
const ROOM_HEADER = 'ROOM (chat → chronos)';
const LAST_HEADER = 'LAST SYNC';
const FAILS_HEADER = 'FAILS';
const CURSOR_HEADER = 'CURSOR (ms)';
export function renderStatus(inputs) {
    const lines = [];
    lines.push(`chronos-sync v${inputs.version}`);
    lines.push(`config: ${inputs.configPath}`);
    lines.push(`state:  ${inputs.statePath}`);
    if ('error' in inputs.config) {
        lines.push(`server: (config not loaded: ${inputs.config.error})`);
        lines.push(`interval: (config not loaded)`);
        lines.push('');
        lines.push('(no rooms configured)');
        return lines.join('\n') + '\n';
    }
    lines.push(`server: ${inputs.config.server_url}`);
    lines.push(`interval: ${inputs.config.interval_seconds}s`);
    lines.push('');
    if (inputs.config.rooms.length === 0) {
        lines.push('(no rooms configured)');
        return lines.join('\n') + '\n';
    }
    const rows = inputs.config.rooms.map((room) => buildRow(room, inputs.state, inputs.now));
    const table = formatTable(rows);
    lines.push(...table);
    return lines.join('\n') + '\n';
}
function buildRow(room, state, now) {
    const key = `${room.project_id}:${room.room_name}`;
    const rs = state.rooms[key] ?? {
        last_synced_ms: 0,
        last_success_at: 0,
        consecutive_failures: 0,
    };
    const projectShort = room.project_id.slice(0, 8);
    const roomLabel = `"${room.chat_name}" → ${projectShort}/${room.room_name}`;
    return {
        room: roomLabel,
        last: formatLastSync(rs.last_success_at, now),
        fails: String(rs.consecutive_failures),
        cursor: String(rs.last_synced_ms),
    };
}
function formatTable(rows) {
    const widths = {
        room: Math.max(ROOM_HEADER.length, ...rows.map((r) => r.room.length)),
        last: Math.max(LAST_HEADER.length, ...rows.map((r) => r.last.length)),
        fails: Math.max(FAILS_HEADER.length, ...rows.map((r) => r.fails.length)),
        cursor: Math.max(CURSOR_HEADER.length, ...rows.map((r) => r.cursor.length)),
    };
    const header = pad(ROOM_HEADER, widths.room) +
        '  ' +
        pad(LAST_HEADER, widths.last) +
        '  ' +
        pad(FAILS_HEADER, widths.fails) +
        '  ' +
        CURSOR_HEADER;
    const lines = [header];
    for (const r of rows) {
        lines.push(pad(r.room, widths.room) +
            '  ' +
            pad(r.last, widths.last) +
            '  ' +
            pad(r.fails, widths.fails) +
            '  ' +
            r.cursor);
    }
    return lines;
}
function pad(s, width) {
    if (s.length >= width)
        return s;
    return s + ' '.repeat(width - s.length);
}
export function formatLastSync(lastSuccessAt, now) {
    if (!lastSuccessAt || lastSuccessAt <= 0)
        return 'never';
    const diffMs = now - lastSuccessAt;
    const clock = formatClock(lastSuccessAt);
    return `${formatRelative(diffMs)} (${clock})`;
}
function formatRelative(diffMs) {
    if (diffMs < 0)
        return '미래';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60)
        return `${sec}초 전`;
    const min = Math.floor(sec / 60);
    if (min < 60)
        return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24)
        return `${hr}시간 전`;
    const day = Math.floor(hr / 24);
    return `${day}일 전`;
}
function formatClock(epochMs) {
    const d = new Date(epochMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}
export async function runStatus(out = process.stdout) {
    let config;
    try {
        config = await loadConfig();
    }
    catch (e) {
        config = { error: e.message };
    }
    let state;
    try {
        state = await loadState();
    }
    catch {
        state = { rooms: {}, daemon: { started_at: 0, last_cycle_at: 0 } };
    }
    const text = renderStatus({
        version: VERSION,
        configPath: configPath(),
        statePath: statePath(),
        config,
        state,
        now: Date.now(),
    });
    out.write(text);
}
