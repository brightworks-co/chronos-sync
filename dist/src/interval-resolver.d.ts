import { type DaemonConfig, type DaemonState, type IntervalSource } from './types.js';
export interface ResolvedInterval {
    value: number;
    source: IntervalSource;
    fetched_at: string;
    /** Visible warning to surface in foreground header. null if no warning. */
    warning: string | null;
}
export interface IntervalResolverDeps {
    /** Injectable clock for test. Default Date.now. */
    now?: () => number;
    /** Logger. */
    log: (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
}
export declare function resolveInterval(config: DaemonConfig, state: DaemonState, deps: IntervalResolverDeps): Promise<ResolvedInterval>;
