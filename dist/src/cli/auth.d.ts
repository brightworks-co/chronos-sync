/**
 * `chronos-sync auth` — register a Personal Access Token (PAT) and prime
 * the bootstrap snapshot for `auto-upload` server-driven config.
 *
 * Flow (happy path on a fresh Mac):
 *   1. Ensure `~/.chronos` exists (mode 0700).
 *   2. Refuse if legacy `~/.chronos/config.json` has embedded `pat`/`rooms`
 *      (MAJ-6 — Critic 제3안). User must run `chronos-sync migrate` first.
 *   3. Acquire PAT (positional arg → --token → --from-stdin → TTY no-echo).
 *   4. Validate PAT format `chr_pat_<32hex>`.
 *   5. Probe Keychain. If unavailable, require --allow-file-pat opt-in.
 *   6. GET `/api/auto-upload/bootstrap` with 4× exponential backoff.
 *   7. Persist Keychain (or auth.token), `auth.json`, and config.cache.json.
 *   8. Print success.
 *
 * `--reset` rotation flow (MAJ-7):
 *   - Read existing auth.json + old PAT.
 *   - GET bootstrap with old PAT to enumerate claimed rooms.
 *   - DELETE each `(project_id, room_name)` to release `auto_mac_uploader`.
 *   - Wipe Keychain entry + auth.token + auth.json.
 *   - Fall through to the regular acquire-and-register flow with the new PAT.
 *
 * The contract here is intentionally narrow: this command only writes
 * credentials and primes the cache. Daemon refresh / SIGHUP is PR6's job.
 */
import { authPath } from '../auth-file.js';
export interface AuthCliResult {
    exitCode: number;
}
export interface AuthCliOptions {
    /** PAT supplied directly (positional arg or `--token`). Triggers a stderr warning. */
    token?: string;
    /** Read PAT from stdin (single line, trimmed). */
    fromStdin?: boolean;
    /** Server URL override; defaults to `https://chronos.brightworks.app`. */
    serverUrl?: string;
    /** Permit file-based PAT storage when Keychain is unavailable. */
    allowFilePat?: boolean;
    /** Rotation flow — wipe existing creds + unregister old rooms first. */
    reset?: boolean;
    /** When true, the caller passed `--token <PAT>` (vs. positional). */
    tokenWasFlag?: boolean;
}
/**
 * Programmatic IO ports — mirrors the existing CLI conventions. Tests
 * inject string streams and a stub prompter.
 */
export interface AuthCliIo {
    out: NodeJS.WritableStream;
    err: NodeJS.WritableStream;
    /** Read PAT from a TTY with input hidden. */
    promptHidden?: (prompt: string) => Promise<string>;
    /** Read PAT from stdin. */
    readStdin?: () => Promise<string>;
}
export declare function runAuth(opts: AuthCliOptions, io?: AuthCliIo): Promise<AuthCliResult>;
/**
 * SHA256 of the PAT, first 12 hex chars. Diagnostics only — never the PAT.
 */
declare function hashPrefix(pat: string): string;
export declare const __testing: {
    PAT_REGEX: RegExp;
    authPath: typeof authPath;
    hashPrefix: typeof hashPrefix;
};
export {};
