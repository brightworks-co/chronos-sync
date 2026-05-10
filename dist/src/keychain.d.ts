/**
 * macOS Keychain wrapper around the `security` CLI.
 *
 * v0.5.0 stores chronos-sync PATs in the user's Login keychain under:
 *   service: chronos-sync   (constant — `KEYCHAIN_SERVICE`)
 *   account: <user_email>   (per-user — multiple chronos accounts on one Mac)
 *
 * We use `child_process.execFile` (NOT `exec`) with explicit argv. Args are
 * passed positionally so a malicious email or token never goes through a
 * shell parser.
 *
 * `probeKeychain()` is a cheap up-front check before any `setPat`. It runs
 * `security list-keychains -d user`, which exits non-zero if the `security`
 * binary is missing or the user keychain is unavailable (FileVault-locked
 * remote sessions, mostly). The result drives the auth-time fallback gate
 * documented in MAJ-4 of the auto-upload-server-driven-config plan.
 *
 * Note: this module is macOS-only. Calling `setPat`/`getPat` on Linux/Win
 * will surface the platform error verbatim — chronos-sync itself is
 * macOS-only today (kakaocli is macOS), so this matches the daemon's
 * existing scope.
 */
export declare const KEYCHAIN_SERVICE = "chronos-sync";
export interface KeychainProbeResult {
    available: boolean;
    /** Human-readable reason when `available === false`. */
    reason?: string;
}
/**
 * Cheap up-front availability probe. Returns `{available: false, reason}` on
 * any failure rather than throwing — the caller decides whether to honor
 * `--allow-file-pat` or exit.
 */
export declare function isKeychainAvailable(): Promise<KeychainProbeResult>;
/**
 * Add or update a PAT for `account`. Always overwrites any pre-existing
 * entry under the same (service, account) tuple — `-U` is the security
 * flag for "update if present."
 */
export declare function setPat(account: string, pat: string): Promise<void>;
/**
 * Look up a PAT for `account`. Returns null when no entry exists; throws on
 * any other `security` failure (locked keychain, etc.) so the caller can
 * surface an actionable error.
 */
export declare function getPat(account: string): Promise<string | null>;
/**
 * Remove the entry for `account`. No-op when missing — symmetric with
 * `getPat()` returning null. Throws on locked-keychain etc.
 */
export declare function deletePat(account: string): Promise<void>;
