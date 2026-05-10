/**
 * Pretty console output for the foreground `chronos-sync` mode.
 *
 * The mental model is "open a terminal, see live status, close terminal
 * to stop". So output is conversational Korean, time-stamped, color-cued
 * (green ✓ for success / red ✗ for error). No JSONL — that stream is
 * available via `chronos-sync daemon` for log-aggregation pipelines.
 */
import { configPath } from './state-file.js';
import { VERSION } from './constants.js';
import { bootstrapStatusLabel, peekCachedSnapshot } from './bootstrap-resolver.js';
export const ANSI = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
};
/** Build the startup banner shown when foreground mode boots. */
export function formatHeader(inputs) {
    const lines = [];
    lines.push(`${ANSI.bold}chronos-sync${ANSI.reset} v${inputs.version}`);
    lines.push(`${ANSI.dim}config:${ANSI.reset} ${inputs.configPath}`);
    lines.push(`${ANSI.dim}서버:${ANSI.reset}   ${inputs.config.server_url}`);
    lines.push(`${ANSI.dim}룸:${ANSI.reset}     ${inputs.config.rooms.length}개 매핑 — ${formatRoomList(inputs.config.rooms)}`);
    // Interval display precedence (v0.6.0 root-cause fix):
    //   1. `resolved.value`   — freshest signal (post-cycle).
    //   2. cached snapshot    — bootstrap-resolver's persisted interval.
    //   3. `cfg.interval_seconds` — fallback only when neither is available
    //      (e.g. very first run before the bootstrap cache exists).
    //
    // Pre-v0.6.0 we used cfg.interval_seconds as the second tier, which made
    // the second-and-onward foreground starts briefly show the cfg default
    // (e.g. "5분") before swapping in the cached value (e.g. "30초") after
    // the first cycle. The cache-precedence step closes that gap.
    const cachedSnapshot = inputs.cachedSnapshot !== undefined ? inputs.cachedSnapshot : peekCachedSnapshot();
    const showPlaceholder = inputs.resolved === undefined && cachedSnapshot === null;
    if (showPlaceholder) {
        lines.push(`${ANSI.dim}주기:${ANSI.reset}   서버에서 받아오는 중… — 끄려면 Ctrl+C 또는 터미널 닫기`);
    }
    else {
        const intervalSeconds = inputs.resolved?.value
            ?? cachedSnapshot?.interval_seconds
            ?? inputs.config.interval_seconds;
        const source = inputs.resolved?.source;
        const minutes = intervalSeconds / 60;
        const pretty = minutes >= 1 && Number.isInteger(minutes)
            ? `${minutes}분`
            : `${intervalSeconds}초`;
        const sourceTag = source ? ` (${source})` : '';
        lines.push(`${ANSI.dim}주기:${ANSI.reset}   ${pretty}마다 동기화${sourceTag} — 끄려면 Ctrl+C 또는 터미널 닫기`);
    }
    // Auth context line (bootstrap freshness + PAT storage).
    const bootstrapLabel = inputs.bootstrapLabel ?? bootstrapStatusLabel();
    const pat = inputs.patStorage ?? 'keychain';
    lines.push(`${ANSI.dim}인증:${ANSI.reset}   bootstrap: ${bootstrapLabel}, pat: ${pat}`);
    if (inputs.resolved?.warning) {
        lines.push(`${ANSI.yellow}! ${inputs.resolved.warning}${ANSI.reset}`);
    }
    lines.push('─────────────────────────────────────────');
    return lines.join('\n') + '\n';
}
function formatRoomList(rooms) {
    if (rooms.length === 0)
        return '(없음)';
    return rooms
        .map((r) => {
        const projectShort = r.project_id.slice(0, 8);
        const target = `${projectShort}/${r.room_name}`;
        const source = r.chat_id ?? r.chat_name ?? '(unknown)';
        return `${source} → ${target}`;
    })
        .join(', ');
}
/**
 * Format a single per-room cycle result as a one-liner:
 *
 *   `21:38:05  ✓ ce3758/notice — 새 메시지 50개 업로드`
 *   `21:38:06  ✗ ce3758/notice — kakaocli exited with code 1`
 */
export function formatCycleLine(inputs) {
    const time = formatClock(inputs.now ?? new Date());
    const projectShort = inputs.room.project_id.slice(0, 8);
    const target = `${projectShort}/${inputs.room.room_name}`;
    if (inputs.error) {
        return `${time}  ${ANSI.red}✗${ANSI.reset} ${target} — ${inputs.error}`;
    }
    const tail = inputs.new_messages > 0
        ? `새 메시지 ${inputs.new_messages}개 업로드`
        : '변동 없음';
    return `${time}  ${ANSI.green}✓${ANSI.reset} ${target} — ${tail}`;
}
/** Closing line shown when the user hits Ctrl+C. */
export function formatShutdown() {
    return ('\n' +
        `${ANSI.dim}종료. 다시 동기화하려면 ${ANSI.reset}${ANSI.bold}chronos-sync${ANSI.reset}${ANSI.dim}를 다시 실행하세요.${ANSI.reset}\n`);
}
function formatClock(d) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}
/**
 * Default foreground UI bound to `process.stdout`. Tests should build
 * their own `ForegroundUi` against an in-memory writer instead of
 * spying on stdout.
 */
export function createDefaultForegroundUi() {
    return {
        printHeader: (cfg, resolved) => {
            process.stdout.write(formatHeader({ config: cfg, configPath: configPath(), version: VERSION, resolved }));
        },
        printCycleLine: (inputs) => {
            process.stdout.write(formatCycleLine(inputs) + '\n');
        },
        printShutdown: () => {
            process.stdout.write(formatShutdown());
        },
        printWarning: (message) => {
            process.stderr.write(`${ANSI.yellow}!${ANSI.reset} ${message}\n`);
        },
    };
}
