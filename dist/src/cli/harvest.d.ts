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
export interface HarvestCliOptions {
    top?: number;
    maxClicks?: number;
    scrollDelay?: number;
    dryRun?: boolean;
}
export interface HarvestCliResult {
    exitCode: number;
    code: number;
    stderr: string;
}
/**
 * Parse `chronos-sync harvest` CLI args. Each flag accepts the form
 * `--name value` (kept simple — no `=` form, no short flags).
 */
export declare function parseHarvestArgs(args: ReadonlyArray<string>): HarvestCliOptions;
export declare function runHarvest(argv: ReadonlyArray<string>, io?: {
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
}): Promise<HarvestCliResult>;
