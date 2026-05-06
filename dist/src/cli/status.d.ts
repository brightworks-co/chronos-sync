/**
 * `chronos-sync status` — render config + state for human eyes.
 *
 * Stdout-only happy path; stderr is reserved for unexpected throws.
 * Always exits 0 on degraded (config/state load failure) so users can
 * troubleshoot via the printed header instead of a stack trace.
 */
import type { DaemonConfig, DaemonState } from '../types.js';
interface StatusInputs {
    version: string;
    configPath: string;
    statePath: string;
    config: DaemonConfig | {
        error: string;
    };
    state: DaemonState;
    now: number;
}
export declare function renderStatus(inputs: StatusInputs): string;
export declare function formatLastSync(lastSuccessAt: number, now: number): string;
export declare function runStatus(out?: NodeJS.WritableStream): Promise<void>;
export {};
