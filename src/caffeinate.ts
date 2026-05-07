import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * Structural alias of `daemon.ts#DaemonLog`. Declared locally to avoid a
 * circular import — `daemon.ts` imports from this file and not the other
 * way around.
 */
type LogFn = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: unknown
) => void

export interface CaffeinateGuardOptions {
  foreground: boolean
  log: LogFn
  /** Test seam — defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Test seam — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Test seam — defaults to `process.pid`. */
  pid?: number
  /** Test seam — defaults to `node:child_process spawn`. */
  spawnImpl?: typeof spawn
}

export interface CaffeinateGuard {
  /** PID of the spawned `caffeinate` child, or undefined when guard is inactive. */
  pid: number | undefined
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
export function maybeStartCaffeinate(
  opts: CaffeinateGuardOptions
): CaffeinateGuard {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const pid = opts.pid ?? process.pid
  const spawnFn = opts.spawnImpl ?? spawn

  if (!opts.foreground) return { pid: undefined }
  if (platform !== 'darwin') return { pid: undefined }
  if (env.CHRONOS_NO_CAFFEINATE === '1') return { pid: undefined }

  let child: ChildProcess
  try {
    child = spawnFn('caffeinate', ['-i', '-w', String(pid)], {
      stdio: 'ignore',
      detached: false,
    })
  } catch (err) {
    opts.log('warn', 'caffeinate spawn threw', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { pid: undefined }
  }

  child.on('error', (err) => {
    opts.log('warn', 'caffeinate child errored', {
      error: err instanceof Error ? err.message : String(err),
    })
  })

  if (typeof child.pid !== 'number') {
    opts.log('warn', 'caffeinate spawned but pid is unavailable', {})
    return { pid: undefined }
  }

  opts.log('info', 'caffeinate guard started', { pid: child.pid })
  return { pid: child.pid }
}

export interface CaffeinateStopOptions {
  pid: number | undefined
  log: LogFn
  /** Test seam — defaults to `process.kill`. */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Send SIGTERM to a previously spawned caffeinate child. No-op when the
 * guard never spawned (`pid === undefined`). Errors during kill are
 * swallowed and logged — caffeinate's own `-w pid` watcher reaps it
 * within a polling interval even if our explicit kill fails.
 */
export function maybeStopCaffeinate(opts: CaffeinateStopOptions): void {
  if (typeof opts.pid !== 'number') return
  const killFn =
    opts.killImpl ??
    ((p: number, sig: NodeJS.Signals) => {
      process.kill(p, sig)
    })
  try {
    killFn(opts.pid, 'SIGTERM')
    opts.log('info', 'caffeinate guard stopped', { pid: opts.pid })
  } catch (err) {
    opts.log('warn', 'caffeinate kill failed', {
      pid: opts.pid,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
