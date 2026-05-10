/**
 * Detect a running chronos-sync daemon (foreground or launchd).
 *
 * Used by `chronos-sync migrate` (PR7 of auto-upload-server-driven-config plan,
 * MAJ-8.3): refusing to mutate `~/.chronos` while another instance might write
 * to it concurrently.
 *
 * Two probes:
 *   1. `pgrep -f chronos-sync` — catches the foreground process and the
 *      launchd-spawned background daemon. Excludes the *current* process so
 *      `migrate` doesn't detect itself.
 *   2. `launchctl list | grep chronos-sync` — catches plists that are loaded
 *      but currently between cycles (`pgrep` would miss the process during
 *      its sleep window). Detected even when `KeepAlive` is in cooldown.
 *
 * Either probe firing → daemon is "running" for migrate's purposes.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DaemonProbeResult {
  /** True iff at least one probe detected an active daemon. */
  running: boolean
  /** PIDs from `pgrep`. Empty when none detected. */
  pids: number[]
  /** Plist labels from `launchctl list`. Empty when none detected. */
  launchdLabels: string[]
}

/**
 * Probe both `pgrep` and `launchctl`. Never throws — failures from either
 * tool surface as "not detected" so migrate can still proceed when the host
 * has unusual permissions. The caller's safety net is still the user prompt.
 */
export async function probeRunningDaemon(): Promise<DaemonProbeResult> {
  const [pids, launchdLabels] = await Promise.all([
    pgrepChronos(),
    launchctlChronos(),
  ])
  return {
    running: pids.length > 0 || launchdLabels.length > 0,
    pids,
    launchdLabels,
  }
}

async function pgrepChronos(): Promise<number[]> {
  try {
    // -f matches against the full command line (so `node ... chronos-sync ...`
    // is detected). Excluding our own PID so `migrate` doesn't detect itself.
    const { stdout } = await execFileAsync('pgrep', ['-f', 'chronos-sync'], {
      timeout: 3000,
    })
    const ownPid = process.pid
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Number(line))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== ownPid)
  } catch {
    // pgrep returns non-zero exit when no processes match — that's the common
    // happy path. Any other failure (binary missing, permission denied) → no
    // detection, caller still gets the launchctl check.
    return []
  }
}

async function launchctlChronos(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['list'], {
      timeout: 3000,
    })
    // launchctl list output: "PID\tStatus\tLabel". Match labels containing
    // chronos-sync (case-insensitive — the user's plist convention varies:
    // com.brightworks.chronos-sync, dev.chronos-sync, etc.).
    const labels: string[] = []
    for (const line of stdout.split('\n')) {
      const cols = line.split('\t')
      if (cols.length < 3) continue
      const label = cols[2].trim()
      if (/chronos-sync/i.test(label)) {
        labels.push(label)
      }
    }
    return labels
  } catch {
    // launchctl missing or list failed — caller falls back to pgrep alone.
    return []
  }
}
