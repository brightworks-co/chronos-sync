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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = 'chronos-sync';
/**
 * Cheap up-front availability probe. Returns `{available: false, reason}` on
 * any failure rather than throwing — the caller decides whether to honor
 * `--allow-file-pat` or exit.
 */
export async function isKeychainAvailable() {
    try {
        await execFileAsync('security', ['list-keychains', '-d', 'user'], {
            timeout: 3000,
        });
        return { available: true };
    }
    catch (e) {
        const err = e;
        if (err.code === 'ENOENT') {
            return { available: false, reason: '`security` CLI not found on PATH' };
        }
        if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
            return { available: false, reason: '`security list-keychains` timed out' };
        }
        const stderr = (err.stderr ?? '').toString().trim();
        return {
            available: false,
            reason: stderr.length > 0 ? stderr : (err.message || 'unknown failure'),
        };
    }
}
/**
 * Add or update a PAT for `account`. Always overwrites any pre-existing
 * entry under the same (service, account) tuple — `-U` is the security
 * flag for "update if present."
 */
export async function setPat(account, pat) {
    if (!account || !pat) {
        throw new Error('setPat: account and pat are required');
    }
    await execFileAsync('security', [
        'add-generic-password',
        '-U',
        '-s', KEYCHAIN_SERVICE,
        '-a', account,
        '-w', pat,
        // -T '' means: allow access only to the binary that wrote it. We
        // intentionally omit -T so the user's interactive session can read
        // it after a restart without a confirmation dialog. The TCC prompt
        // on first read is the standard macOS security UX.
    ], { timeout: 5000 });
}
/**
 * Look up a PAT for `account`. Returns null when no entry exists; throws on
 * any other `security` failure (locked keychain, etc.) so the caller can
 * surface an actionable error.
 */
export async function getPat(account) {
    if (!account) {
        throw new Error('getPat: account is required');
    }
    try {
        const { stdout } = await execFileAsync('security', [
            'find-generic-password',
            '-s', KEYCHAIN_SERVICE,
            '-a', account,
            '-w', // print only the password to stdout
        ], { timeout: 5000 });
        // `security -w` emits the password followed by a newline. Trim it but
        // do NOT trim leading/trailing whitespace inside — PATs are alnum/_,
        // but a defensive trim only at the line edges is the correct shape.
        return stdout.replace(/\r?\n$/, '');
    }
    catch (e) {
        const err = e;
        const stderr = (err.stderr ?? '').toString();
        // Exit code 44 = SecKeychainSearchCopyNext: the item could not be found.
        if (stderr.includes('could not be found') ||
            stderr.includes('SecKeychainSearchCopyNext') ||
            err.code === 44 ||
            err.code === '44') {
            return null;
        }
        throw e;
    }
}
/**
 * Remove the entry for `account`. No-op when missing — symmetric with
 * `getPat()` returning null. Throws on locked-keychain etc.
 */
export async function deletePat(account) {
    if (!account) {
        throw new Error('deletePat: account is required');
    }
    try {
        await execFileAsync('security', [
            'delete-generic-password',
            '-s', KEYCHAIN_SERVICE,
            '-a', account,
        ], { timeout: 5000 });
    }
    catch (e) {
        const err = e;
        const stderr = (err.stderr ?? '').toString();
        if (stderr.includes('could not be found') ||
            err.code === 44 ||
            err.code === '44') {
            return;
        }
        throw e;
    }
}
