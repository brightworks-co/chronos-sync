/**
 * `~/.chronos/config.cache.json` lifecycle: prime, refresh, ETag, 24h ceiling.
 *
 * v0.5.0 auth-mode replaces the legacy `config.json` static rooms+pat with a
 * server-driven snapshot fetched at boot and on SIGHUP. Mirrors the proven
 * `interval-resolver.ts` shape: module-level cache, in-flight mutex, primed
 * cache + STALE_WARN_AGE_MS + MAX_BOOTSTRAP_CACHE_AGE_MS hard ceiling.
 *
 * Plan reference: PR6 of `.cmux/plans/auto-upload-server-driven-config.md`.
 *
 * Key invariants:
 *   - `last_successful_fetch` (epoch ms) is updated ONLY on 200/304. Network
 *     failure / 5xx / 429 / 401 / 403 do NOT touch it. This makes the 24h
 *     clock count *continuous failure time*, not absolute snapshot age.
 *   - 401/403 INVALIDATE the cache (rename to `.invalidated.<ts>`) so a
 *     daemon restart cannot accidentally resume with revoked credentials.
 *   - 5xx / network / 429 keep the cache; 429 honors `Retry-After`.
 *   - On disk: atomic temp+rename, mode 0600.
 */
import { type AuthFile } from './auth-file.js';
import type { RoomConfig } from './types.js';
/** Continuous-failure ceiling. Past this, daemon refuses to upload. */
export declare const MAX_BOOTSTRAP_CACHE_AGE_MS: number;
/** Cycle-by-cycle warning threshold below the ceiling. */
export declare const STALE_WARN_AGE_MS: number;
export type BootstrapMode = 'auth';
export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
/**
 * Persisted snapshot. The `last_successful_fetch` field is the authoritative
 * clock for the 24h ceiling — semantically distinct from `fetched_at` (which
 * is the server-reported wall clock and may be older than a 304 hit).
 */
export interface BootstrapSnapshot {
    server_url: string;
    user_email: string;
    interval_seconds: number;
    rooms: RoomConfig[];
    etag: string;
    /** ISO 8601 server-reported timestamp from the most recent 200 payload. */
    fetched_at: string;
    /**
     * Epoch ms of the most recent successful 200/304. Updated on every refresh
     * that round-trips OK; pointedly NOT updated on 401/403/5xx/429/network.
     * Drives the 24h continuous-failure ceiling.
     */
    last_successful_fetch: number;
}
/**
 * One-shot getter result returned to callers (daemon cycle, foreground UI).
 *
 * `refuse=true` means the daemon must NOT upload this cycle (24h ceiling
 * exceeded, OR cache invalidated by 401/403). `warning` is non-null when the
 * snapshot is in the 20-24h stale band.
 */
export interface BootstrapGetResult {
    snapshot: BootstrapSnapshot | null;
    warning: string | null;
    refuse: boolean;
    /** Optional reason classifier so foreground UI can render `bootstrap: refused (>24h)` etc. */
    status: 'ok' | 'stale' | 'offline' | 'refused-stale' | 'refused-auth' | 'missing';
}
/**
 * Reset module-level state. Tests must call this in `beforeEach`.
 */
export declare function resetBootstrapCacheForTest(): void;
/**
 * Best-effort load of the persisted snapshot from disk. Idempotent — only
 * the first call hits the filesystem; subsequent calls are no-ops until
 * `resetBootstrapCacheForTest()`.
 */
export declare function loadCachedSnapshotFromDisk(): Promise<BootstrapSnapshot | null>;
/**
 * Fetch + refresh the cache. Mirrors `primeIntervalCache`: never throws on
 * fetch failure (caller awaits without try/catch); concurrent calls share
 * the same in-flight promise.
 *
 * Outcome handling (CRIT-3):
 *   200      → atomic snapshot replace + last_successful_fetch=now
 *   304      → keep cache + last_successful_fetch=now
 *   401/403  → invalidate cache on disk + clear in-memory + LOG ERROR
 *              (daemon decides whether to exit; resolver does not call exit)
 *   5xx      → keep cache, log warn
 *   network  → keep cache, log warn
 *   429      → keep cache, log warn (Retry-After is logged for diagnostics)
 *
 * The 401/403 path is signaled to the caller via the next `getBootstrap`
 * return: `cached` becomes `null` and the on-disk cache is renamed away,
 * so the next call returns `{ snapshot: null, refuse: true, status: 'refused-auth' }`.
 */
export declare function primeBootstrap(auth: AuthFile, pat: string, log: LogFn): Promise<void>;
/**
 * Synchronous read for the cycle path. Classifies snapshot freshness vs
 * the 24h ceiling and emits the appropriate `status` + `warning` flags.
 *
 * `refuse: true` means the daemon must NOT upload this cycle. Two paths
 * lead there:
 *   - cache present but `last_successful_fetch` >= 24h ago
 *   - cache absent (was invalidated, OR never primed)
 *
 * The caller (daemon) decides what to do with `refuse`. We DO NOT call
 * `process.exit` from here — keeps this module pure for tests and lets the
 * daemon gate exit on `options.exit_on_health_failure`.
 */
export declare function getBootstrap(log: LogFn, now?: number): BootstrapGetResult;
/**
 * For the foreground UI header: "bootstrap: ok (Xs ago) | stale | offline | refused (>24h) | missing".
 * Pure — derives label from the snapshot only.
 */
export declare function bootstrapStatusLabel(now?: number): string;
/**
 * Test/inspection helper: peek at the in-memory snapshot without touching
 * the FS or recomputing freshness. Daemon code should use `getBootstrap()`.
 */
export declare function peekCachedSnapshot(): BootstrapSnapshot | null;
/**
 * Return the path the resolver renames to on 401/403. Exposed for tests so
 * they can assert the invalidated file exists at the expected location.
 */
export declare function invalidatedCachePathPrefix(): string;
