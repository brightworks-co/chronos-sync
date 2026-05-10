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
export interface DaemonProbeResult {
    /** True iff at least one probe detected an active daemon. */
    running: boolean;
    /** PIDs from `pgrep`. Empty when none detected. */
    pids: number[];
    /** Plist labels from `launchctl list`. Empty when none detected. */
    launchdLabels: string[];
}
/**
 * Probe both `pgrep` and `launchctl`. Never throws — failures from either
 * tool surface as "not detected" so migrate can still proceed when the host
 * has unusual permissions. The caller's safety net is still the user prompt.
 */
export declare function probeRunningDaemon(): Promise<DaemonProbeResult>;
