/**
 * `chronos-sync harvest` — manual one-off backfill trigger.
 *
 * As of v0.2.9 the daemon does NOT auto-spawn harvest by default
 * (see `HarvestThresholds.enabled` JSDoc — KakaoTalk auto-populates
 * NTUser on incoming push, so cycle-scope harvest was disruptive
 * without much benefit). Users who want a one-off backfill (initial
 * install, or after KakaoTalk has been offline for a long stretch)
 * should run this command and keep KakaoTalk in the foreground while
 * it executes.
 *
 * Usage:
 *   chronos-sync harvest                    (defaults: --top 5)
 *   chronos-sync harvest --top 10
 *   chronos-sync harvest --max-clicks 5
 *   chronos-sync harvest --scroll-delay 2
 *   chronos-sync harvest --dry-run
 *
 * Output:
 *   Stdout: kakaocli's own progress + summary, then a one-line summary.
 *   Exit code: 0 on harvest exit 0, 1 otherwise.
 */
import { harvestScroll, probeHarvestCapabilities } from '../kakaocli.js';
import { loadConfig } from '../state-file.js';
import { DEFAULT_HARVEST_TOP, DEFAULT_HARVEST_MAX_CLICKS, DEFAULT_HARVEST_SCROLL_DELAY, } from '../types.js';
/**
 * Parse `chronos-sync harvest` CLI args. Each flag accepts the form
 * `--name value` (kept simple — no `=` form, no short flags).
 */
export function parseHarvestArgs(args) {
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        switch (a) {
            case '--top': {
                const v = Number(args[++i]);
                if (!Number.isFinite(v) || v < 0)
                    throw new Error('--top requires a non-negative number');
                out.top = Math.floor(v);
                break;
            }
            case '--max-clicks': {
                const v = Number(args[++i]);
                if (!Number.isFinite(v) || v < 0)
                    throw new Error('--max-clicks requires a non-negative number');
                out.maxClicks = Math.floor(v);
                break;
            }
            case '--scroll-delay': {
                const v = Number(args[++i]);
                if (!Number.isFinite(v) || v < 0)
                    throw new Error('--scroll-delay requires a non-negative number');
                out.scrollDelay = v;
                break;
            }
            case '--dry-run':
                out.dryRun = true;
                break;
            default:
                throw new Error(`알 수 없는 옵션: ${a}`);
        }
    }
    return out;
}
export async function runHarvest(argv, io = process) {
    let opts;
    try {
        opts = parseHarvestArgs(argv);
    }
    catch (err) {
        io.stderr.write('chronos-sync harvest: ' + (err instanceof Error ? err.message : String(err)) + '\n');
        return { exitCode: 2, code: -1, stderr: '' };
    }
    let cfg;
    try {
        cfg = await loadConfig();
    }
    catch (err) {
        io.stderr.write('chronos-sync harvest: config load error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n');
        return { exitCode: 1, code: -1, stderr: '' };
    }
    const binary = cfg.kakaocli_path ?? 'kakaocli';
    // Probe first so we fail fast if kakaocli is missing or doesn't support --scroll.
    try {
        const caps = await probeHarvestCapabilities(binary);
        if (!caps.scrollSupported) {
            io.stderr.write(`chronos-sync harvest: kakaocli (${binary})는 --scroll을 지원하지 않습니다. kakaocli를 업그레이드하세요.\n`);
            return { exitCode: 1, code: -1, stderr: '' };
        }
    }
    catch (err) {
        io.stderr.write(`chronos-sync harvest: probe 실패: ${err instanceof Error ? err.message : String(err)}\n`);
        return { exitCode: 1, code: -1, stderr: '' };
    }
    io.stdout.write('KakaoTalk을 foreground로 두고 마우스/키보드를 사용하지 마세요. harvest 진행 중...\n');
    const result = await harvestScroll({
        top: opts.top ?? DEFAULT_HARVEST_TOP,
        maxClicks: opts.maxClicks ?? DEFAULT_HARVEST_MAX_CLICKS,
        scrollDelay: opts.scrollDelay ?? DEFAULT_HARVEST_SCROLL_DELAY,
        dryRun: opts.dryRun,
        binary,
    });
    if (result.code === 0) {
        io.stdout.write('harvest 완료 (exit 0)\n');
        return { exitCode: 0, code: 0, stderr: result.stderr };
    }
    io.stderr.write(`harvest 실패 (exit ${result.code}). stderr: ${result.stderr.slice(0, 500)}\n`);
    return { exitCode: 1, code: result.code, stderr: result.stderr };
}
