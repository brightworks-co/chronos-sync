/**
 * `~/.chronos/auth.json` + `~/.chronos/auth.token` helpers.
 *
 * v0.5.0 introduces the `auth-mode` storage layout for chronos-sync:
 *
 *   ~/.chronos/auth.json    — non-secret metadata (server URL, user email,
 *                             pat_hash_prefix, pat_storage). Mode 0600.
 *   ~/.chronos/auth.token   — opt-in plaintext PAT file (only when
 *                             `--allow-file-pat` was passed at auth time).
 *                             Mode 0600 inside dir mode 0700.
 *   ~/.chronos/config.cache.json — bootstrap snapshot (PR6, not this PR).
 *
 * The `~/.chronos` directory itself is created with mode 0700, idempotent.
 *
 * `CHRONOS_HOME` env var, when set, overrides `~/.chronos` for the entire
 * filesystem layout. This is the documented escape hatch for read-only HOME
 * volumes (see Pre-mortem scenario 4 in the auto-upload-server-driven-config
 * plan). Empty string is treated as unset.
 */
export declare const AUTH_FILE_NAME = "auth.json";
export declare const AUTH_TOKEN_FILE_NAME = "auth.token";
export declare const BOOTSTRAP_CACHE_FILE_NAME = "config.cache.json";
export interface AuthFile {
    /** Base URL of the chronos server, no trailing slash. */
    server_url: string;
    /** Resolved from `/api/auto-upload/bootstrap` payload. */
    user_email: string;
    /** First 12 chars of `sha256(pat)` — diagnostics only, never the PAT itself. */
    pat_hash_prefix: string;
    /** Where the PAT lives. `keychain` is the happy path; `file` is opt-in via --allow-file-pat. */
    pat_storage: 'keychain' | 'file';
    /**
     * Echoes whether `--allow-file-pat` (or `CHRONOS_ALLOW_FILE_PAT=1`) was set
     * at registration time, regardless of which storage backend was actually
     * used. Useful for diagnostics — distinguishes "fell back to file" from
     * "Keychain happened to fail right now."
     */
    allow_file_pat: boolean;
    /** ISO 8601 timestamp of `chronos-sync auth` completion. */
    written_at: string;
}
/**
 * Resolve the chronos directory. Honors `CHRONOS_HOME` env override.
 *
 * - `CHRONOS_HOME` set to non-empty → `<CHRONOS_HOME>` verbatim (the env
 *   variable IS the directory, not a parent). This matches the install-page
 *   troubleshooting copy: `CHRONOS_HOME=/var/cache/chronos`.
 * - `CHRONOS_HOME` unset/empty → `~/.chronos`.
 */
export declare function chronosHomeDir(): string;
export declare function authPath(): string;
export declare function authTokenPath(): string;
export declare function bootstrapCachePath(): string;
/**
 * `mkdir -p` the chronos directory with mode 0700. Idempotent.
 *
 * On EACCES/EPERM/EROFS we surface an actionable recovery one-liner per
 * Pre-mortem scenario 4. The error is rethrown so the CLI handler can exit
 * non-zero with the user-visible message.
 */
export declare function ensureChronosDir(): Promise<void>;
export declare function loadAuth(): Promise<AuthFile | null>;
/**
 * Atomic write: temp + rename, mode 0600. The chronos dir must already exist
 * (call `ensureChronosDir()` first).
 */
export declare function saveAuth(auth: AuthFile): Promise<void>;
export declare function wipeAuth(): Promise<void>;
/**
 * Read the opt-in plaintext PAT file. Returns null when absent.
 */
export declare function loadPatFile(): Promise<string | null>;
/**
 * Atomic write of the opt-in plaintext PAT file. Mode 0600, verified post-write.
 * Caller MUST have set `auth.json.pat_storage = 'file'` and `allow_file_pat = true`.
 */
export declare function savePatFile(token: string): Promise<void>;
