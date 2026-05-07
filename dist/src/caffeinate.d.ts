import { spawn } from 'node:child_process';
/**
 * Structural alias of `daemon.ts#DaemonLog`. Declared locally to avoid a
 * circular import — `daemon.ts` imports from this file and not the other
 * way around.
 */
type LogFn = (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
export interface CaffeinateGuardOptions {
    foreground: boolean;
    log: LogFn;
    /** Test seam — defaults to `process.platform`. */
    platform?: NodeJS.Platform;
    /** Test seam — defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Test seam — defaults to `process.pid`. */
    pid?: number;
    /** Test seam — defaults to `node:child_process spawn`. */
    spawnImpl?: typeof spawn;
}
export interface CaffeinateGuard {
    /** PID of the spawned `caffeinate` child, or undefined when guard is inactive. */
    pid: number | undefined;
}
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
export declare function maybeStartCaffeinate(opts: CaffeinateGuardOptions): CaffeinateGuard;
export interface CaffeinateStopOptions {
    pid: number | undefined;
    log: LogFn;
    /** Test seam — defaults to `process.kill`. */
    killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}
/**
 * Send SIGTERM to a previously spawned caffeinate child. No-op when the
 * guard never spawned (`pid === undefined`). Errors during kill are
 * swallowed and logged — caffeinate's own `-w pid` watcher reaps it
 * within a polling interval even if our explicit kill fails.
 */
export declare function maybeStopCaffeinate(opts: CaffeinateStopOptions): void;
export {};
