/**
 * `chronos-sync interval <seconds>` / `chronos-sync interval --get`
 *
 * Talks directly to the chronos web KV via PUT/GET. As of v0.3.0 (ADR
 * 0009, Option B) the running daemon refreshes its interval cache only
 * at boot and on SIGHUP — it no longer issues a per-cycle GET. To pick
 * up a new value immediately, either restart the daemon or send
 * `kill -HUP <daemon_pid>`. Otherwise the daemon will keep using the
 * cached value until the next prime.
 *
 * On PUT success we also rewrite ~/.chronos/config.json's
 * interval_seconds atomically. The daemon's source of truth remains the
 * web KV (see plan ADR-001), but having config.json carry the latest
 * value keeps the "KV unreachable + daemon restart" path from rolling
 * back to a stale local value.
 *
 * If the local rewrite fails, the KV write still wins — we surface a
 * warning to stderr and exit 0 because the next successful KV fetch
 * (next prime) will re-derive the right value anyway.
 */
export interface IntervalCliResult {
    exitCode: number;
}
/**
 * `chronos-sync interval <seconds>` — PUT new interval to web KV, then
 * sync the local config.json. v0.3.0+: the running daemon does not pick
 * up the new value automatically; restart it or send `kill -HUP <pid>`
 * to trigger an interval cache prime.
 */
export declare function runIntervalSet(rawSeconds: string, out?: NodeJS.WritableStream, err?: NodeJS.WritableStream): Promise<IntervalCliResult>;
/**
 * `chronos-sync interval --get` — pretty-print the current value from
 * the web KV plus the local config.json so users can spot drift.
 */
export declare function runIntervalGet(out?: NodeJS.WritableStream, err?: NodeJS.WritableStream): Promise<IntervalCliResult>;
