import { spawn } from 'node:child_process';
/**
 * Spawn `caffeinate -i -w <pid>` so macOS does not idle-sleep while the
 * foreground daemon is running. The `-w` flag ties caffeinate's lifetime
 * to the daemon pid, so caffeinate exits automatically when the daemon
 * dies (including SIGKILL).
 *
 * Skipped when:
 *   - `foreground` is false (launchd takes over via `KeepAlive`).
 *   - host OS is not darwin.
 *   - `CHRONOS_NO_CAFFEINATE=1` is set (operator manages sleep externally
 *     via `pmset` / Amphetamine).
 */
export function maybeStartCaffeinate(opts) {
    const platform = opts.platform ?? process.platform;
    const env = opts.env ?? process.env;
    const pid = opts.pid ?? process.pid;
    const spawnFn = opts.spawnImpl ?? spawn;
    if (!opts.foreground)
        return { pid: undefined };
    if (platform !== 'darwin')
        return { pid: undefined };
    if (env.CHRONOS_NO_CAFFEINATE === '1')
        return { pid: undefined };
    let child;
    try {
        child = spawnFn('caffeinate', ['-i', '-w', String(pid)], {
            stdio: 'ignore',
            detached: false,
        });
    }
    catch (err) {
        opts.log('warn', 'caffeinate spawn threw', {
            error: err instanceof Error ? err.message : String(err),
        });
        return { pid: undefined };
    }
    child.on('error', (err) => {
        opts.log('warn', 'caffeinate child errored', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
    if (typeof child.pid !== 'number') {
        opts.log('warn', 'caffeinate spawned but pid is unavailable', {});
        return { pid: undefined };
    }
    opts.log('info', 'caffeinate guard started', { pid: child.pid });
    return { pid: child.pid };
}
/**
 * Send SIGTERM to a previously spawned caffeinate child. No-op when the
 * guard never spawned (`pid === undefined`). Errors during kill are
 * swallowed and logged — caffeinate's own `-w pid` watcher reaps it
 * within a polling interval even if our explicit kill fails.
 */
export function maybeStopCaffeinate(opts) {
    if (typeof opts.pid !== 'number')
        return;
    const killFn = opts.killImpl ??
        ((p, sig) => {
            process.kill(p, sig);
        });
    try {
        killFn(opts.pid, 'SIGTERM');
        opts.log('info', 'caffeinate guard stopped', { pid: opts.pid });
    }
    catch (err) {
        opts.log('warn', 'caffeinate kill failed', {
            pid: opts.pid,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
