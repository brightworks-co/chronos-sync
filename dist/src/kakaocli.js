/**
 * Thin wrapper around the kakaocli (silver-flight-group/kakaocli) binary.
 *
 * Only the read side is needed here: list messages newer than the last
 * synced cursor. Sends are out of scope.
 */
import { spawn } from 'node:child_process';
/**
 * Invoke `kakaocli messages [--chat <name> | --chat-id <id>] [--since <iso>] --json`
 * and parse the JSON array on stdout. kakaocli streams a single JSON array (or
 * a newline-delimited stream when `--follow` is used; we never use `--follow`
 * because the daemon owns its own scheduler).
 *
 * Either `chat` or `chatId` is required. When both are supplied `chatId`
 * wins to keep behavior aligned with the daemon's room dispatch.
 */
export async function listMessages(query) {
    const binary = query.binary ?? 'kakaocli';
    const args = ['messages', '--json'];
    if (query.chatId !== undefined) {
        args.splice(1, 0, '--chat-id', String(query.chatId));
    }
    else if (query.chat !== undefined) {
        args.splice(1, 0, '--chat', query.chat);
    }
    else {
        throw new Error('listMessages requires `chat` or `chatId`');
    }
    if (query.since) {
        args.push('--since', query.since);
    }
    const { stdout, stderr, code } = await runChild(binary, args);
    if (code !== 0) {
        throw new Error(`kakaocli exited with code ${code}: ${stderr.trim() || '(no stderr)'}`);
    }
    const trimmed = stdout.trim();
    if (!trimmed)
        return [];
    const safe = preserveBigIntPrecision(trimmed);
    // Tolerate both `[ {...}, {...} ]` and NDJSON (`{...}\n{...}`).
    if (safe.startsWith('[')) {
        const parsed = JSON.parse(safe);
        return Array.isArray(parsed) ? parsed : [];
    }
    const lines = safe.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
}
/**
 * KakaoTalk userIds (and chat ids, log ids) are 19-digit BigInts that
 * exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1 = 9007199254740992). When
 * `JSON.parse` hits a bare number literal in that range it silently
 * rounds the trailing digits to 0, e.g.
 *
 *   "sender_id": 8181328792600516744   →   8181328792600517000
 *
 * That breaks downstream lookups (the resolver's SQL `WHERE userId IN
 * (...)` no longer matches the real NTUser row, every sender falls to
 * the unresolved branch, and PR #7's strict-skip path stalls the
 * cycle indefinitely).
 *
 * We rewrite known BigInt-shaped numeric fields to JSON strings before
 * `JSON.parse` so the exact digits survive. Downstream code
 * (`enrichSenders`, `resolveSenderNames.sanitizeIds`) already accepts
 * `number | string` for these fields.
 */
export function preserveBigIntPrecision(stdout) {
    // Match `"key": <16+ digit number>` as a value (whitespace tolerant)
    // for the BigInt-shaped fields kakaocli emits. 16 digits is below
    // Number.MAX_SAFE_INTEGER but the cost of quoting a safe integer is
    // zero — the receiver tolerates strings either way.
    return stdout.replace(/"(sender_id|chat_id|id|logId|userId)"(\s*):(\s*)(\d{16,})/g, '"$1"$2:$3"$4"');
}
// Module-level probe cache — invalidated on exit-64 or SIGHUP.
let _probeCache = null;
/** Invalidate the probe cache (e.g. after exit-64 or SIGHUP). */
export function invalidateProbeCache() {
    _probeCache = null;
}
/**
 * Parse `kakaocli harvest --help` and return supported capabilities.
 * Result is cached for the process lifetime; call `invalidateProbeCache()` to refresh.
 */
export async function probeHarvestCapabilities(binary = 'kakaocli') {
    if (_probeCache !== null && _probeCache.binary === binary)
        return _probeCache;
    const { stdout, stderr } = await runChild(binary, ['harvest', '--help']);
    const combined = stdout + stderr;
    // Extract long-form flags from help text: --flag-name
    const flags = Array.from(combined.matchAll(/--([a-z][a-z0-9-]*)/g), (m) => `--${m[1]}`);
    const unique = [...new Set(flags)];
    const caps = {
        binary,
        scrollSupported: unique.includes('--scroll'),
        flags: unique,
    };
    _probeCache = caps;
    return caps;
}
/**
 * Invoke `kakaocli harvest --scroll [--top <n>] [--max-clicks <n>] [--scroll-delay <s>]`.
 * Best-effort: always resolves (never throws) so the caller can warn-log and continue normal sync.
 * On exit-64 the probe cache is invalidated so the next probe re-checks capabilities.
 */
export async function harvestScroll(query) {
    const binary = query.binary ?? 'kakaocli';
    const args = ['harvest', '--scroll'];
    if (query.top !== undefined) {
        args.push('--top', String(query.top));
    }
    if (query.maxClicks !== undefined) {
        args.push('--max-clicks', String(query.maxClicks));
    }
    if (query.scrollDelay !== undefined) {
        args.push('--scroll-delay', String(query.scrollDelay));
    }
    if (query.dryRun) {
        args.push('--dry-run');
    }
    if (query.db !== undefined) {
        args.push('--db', query.db);
    }
    if (query.key !== undefined) {
        args.push('--key', query.key);
    }
    const timeoutMs = query.timeoutMs ?? 60_000;
    const { stderr, code } = await runChild(binary, args, timeoutMs);
    if (code === 64)
        invalidateProbeCache();
    return { code, stderr };
}
function runChild(binary, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            resolve(result);
        };
        child.stdout.on('data', (d) => {
            stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d) => {
            stderr += d.toString('utf8');
        });
        child.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            settle({ stdout, stderr, code: code ?? -1 });
        });
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
                child.kill('SIGKILL');
                settle({ stdout, stderr, code: -1 });
            }, timeoutMs);
        }
    });
}
