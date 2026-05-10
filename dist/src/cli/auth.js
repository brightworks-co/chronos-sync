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
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { authPath, bootstrapCachePath, chronosHomeDir, ensureChronosDir, loadAuth, loadPatFile, saveAuth, savePatFile, wipeAuth, } from '../auth-file.js';
import { ApiPatAuthError, deleteAutoUploadRoom, getBootstrap, } from '../api-client.js';
import { CONFIG_FILE_NAME } from '../constants.js';
import { deletePat, getPat, isKeychainAvailable, setPat, } from '../keychain.js';
const DEFAULT_SERVER_URL = 'https://chronos.brightworks.app';
const PAT_REGEX = /^chr_pat_[a-f0-9]{32}$/;
export async function runAuth(opts, io = { out: process.stdout, err: process.stderr }) {
    const out = io.out;
    const err = io.err;
    // 1. Filesystem prep — fails loud with actionable copy on EACCES/EROFS.
    try {
        await ensureChronosDir();
    }
    catch (e) {
        err.write(`error: ${e.message}\n`);
        return { exitCode: 1 };
    }
    // 2. Legacy precondition (MAJ-6).
    const legacy = await detectLegacyConfig();
    if (legacy) {
        err.write('error: Legacy config.json detected with embedded credentials.\n' +
            '       Run "chronos-sync migrate" first to convert to the new format,\n' +
            '       then re-run "chronos-sync auth".\n');
        return { exitCode: 1 };
    }
    // 3. --reset rotation: unregister old rooms before wiping creds.
    if (opts.reset) {
        const resetResult = await runReset(opts, io);
        if (resetResult.exitCode !== 0)
            return resetResult;
    }
    // 4. Acquire PAT.
    let pat;
    try {
        pat = await acquirePat(opts, io);
    }
    catch (e) {
        err.write(`error: ${e.message}\n`);
        return { exitCode: 1 };
    }
    if (!PAT_REGEX.test(pat)) {
        err.write('error: PAT format invalid — expected "chr_pat_" followed by 32 hex characters.\n' +
            '       Issue a fresh PAT at https://chronos.brightworks.app/account/tokens\n');
        return { exitCode: 1 };
    }
    // 5. Storage backend decision.
    const allowFile = opts.allowFilePat || process.env.CHRONOS_ALLOW_FILE_PAT === '1';
    const probe = await isKeychainAvailable();
    let storage;
    if (probe.available) {
        storage = 'keychain';
    }
    else if (allowFile) {
        storage = 'file';
    }
    else {
        const reason = probe.reason ?? 'unknown reason';
        err.write(`error: Keychain unavailable (${reason}).\n` +
            '       Re-run with --allow-file-pat to store PAT in mode-0600 file ' +
            '(not recommended for shared hosts).\n');
        return { exitCode: 1 };
    }
    // 6. Bootstrap fetch with backoff. We need the user_email for auth.json
    //    even on success; on terminal network failure we write auth.json
    //    anyway with a stderr warning (Pre-mortem scenario 3 / Appendix C #5).
    const serverUrl = (opts.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
    const bootstrap = await fetchBootstrapWithBackoff({ serverUrl, pat }, err);
    if (bootstrap.kind === 'auth-failed') {
        // PAT rejected by server — do NOT write auth.json or Keychain.
        err.write('error: PAT rejected by server (401). auth.json was NOT written.\n');
        return { exitCode: 1 };
    }
    // 7. Persist PAT + auth.json + cache.
    let userEmail = bootstrap.kind === 'ok' ? bootstrap.payload.user_email : null;
    if (!userEmail) {
        // Without a successful bootstrap we have no email. The PAT was format-valid
        // and the server hasn't confirmed it (network failure path). We can't write
        // auth.json without `user_email`. The user should re-run when the server
        // is reachable. This is the trade-off the plan accepts: PAT validity is
        // confirmed only by a 200 or 401 response — neither of which we got.
        err.write('error: Bootstrap fetch failed and no prior auth.json exists, so user_email is unknown.\n' +
            '       Re-run "chronos-sync auth" once the server is reachable.\n');
        return { exitCode: 1 };
    }
    try {
        if (storage === 'keychain') {
            await setPat(userEmail, pat);
        }
        else {
            await savePatFile(pat);
        }
    }
    catch (e) {
        err.write(`error: failed to persist PAT (${storage}): ${e.message}\n`);
        return { exitCode: 1 };
    }
    const auth = {
        server_url: serverUrl,
        user_email: userEmail,
        pat_hash_prefix: hashPrefix(pat),
        pat_storage: storage,
        allow_file_pat: allowFile,
        written_at: new Date().toISOString(),
    };
    try {
        await saveAuth(auth);
    }
    catch (e) {
        err.write(`error: failed to write auth.json: ${e.message}\n`);
        return { exitCode: 1 };
    }
    if (bootstrap.kind === 'ok') {
        try {
            await writeBootstrapCache(bootstrap.payload, bootstrap.etag);
        }
        catch (e) {
            // Cache write failure is non-fatal — the daemon will reprime on first cycle.
            err.write(`! warning: failed to write config.cache.json: ${e.message}\n`);
        }
    }
    // 8. Success summary.
    if (bootstrap.kind === 'ok') {
        out.write(`auth saved (rooms: ${bootstrap.payload.rooms.length}, ` +
            `interval: ${bootstrap.payload.interval_seconds}s, ` +
            `pat_storage: ${storage})\n`);
        out.write(`next: run "chronos-sync" to start syncing.\n`);
    }
    else {
        // Bootstrap unreachable but auth saved (Pre-mortem scenario 3).
        out.write(`auth saved (pat_storage: ${storage}; bootstrap deferred)\n`);
        out.write(`next: run "chronos-sync" once the server is reachable; the daemon will fetch config on its first cycle.\n`);
    }
    return { exitCode: 0 };
}
/**
 * Detect legacy v0.4.x `~/.chronos/config.json` with embedded `pat` or
 * non-empty `rooms`. Pure detection — never writes.
 */
async function detectLegacyConfig() {
    const path = join(chronosHomeDir(), CONFIG_FILE_NAME);
    let raw;
    try {
        raw = await fs.readFile(path, 'utf8');
    }
    catch (e) {
        const err = e;
        if (err.code === 'ENOENT')
            return false;
        // A read error other than missing file is suspicious; treat as no-legacy
        // so we don't double-fail the user — they will hit it again on daemon start.
        return false;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return false;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return false;
    const v = parsed;
    if (typeof v.pat === 'string' && v.pat.length > 0)
        return true;
    if (Array.isArray(v.rooms) && v.rooms.length > 0)
        return true;
    return false;
}
/**
 * 4× exponential backoff (1s, 2s, 4s, 8s — total ≤ 15s). Returns:
 *   - `ok` on 200/304 (only 200 is meaningful here since we have no prior etag);
 *   - `auth-failed` on 401 (terminal, no retry);
 *   - `unreachable` after 4 failed attempts.
 */
async function fetchBootstrapWithBackoff(opts, err) {
    const delays = [1000, 2000, 4000, 8000];
    for (let i = 0; i < delays.length; i++) {
        try {
            const result = await getBootstrap(opts);
            if (result.status === 200) {
                return { kind: 'ok', payload: result.payload, etag: result.etag };
            }
            // 304 with no prior etag is a server bug — treat as unreachable.
            err.write(`! warning: bootstrap returned 304 unexpectedly; retrying...\n`);
        }
        catch (e) {
            if (e instanceof ApiPatAuthError) {
                return { kind: 'auth-failed' };
            }
            // Last attempt — print the warning the plan specifies and stop retrying.
            const isLast = i === delays.length - 1;
            if (isLast) {
                err.write(`! warning: bootstrap fetch failed (${e.message}). ` +
                    `auth.json will be written; run "chronos-sync" later to retry.\n`);
                return { kind: 'unreachable' };
            }
        }
        await sleep(delays[i]);
    }
    return { kind: 'unreachable' };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * SHA256 of the PAT, first 12 hex chars. Diagnostics only — never the PAT.
 */
function hashPrefix(pat) {
    return createHash('sha256').update(pat, 'utf8').digest('hex').slice(0, 12);
}
async function writeBootstrapCache(payload, etag) {
    const path = bootstrapCachePath();
    const tmp = `${path}.tmp`;
    // Snapshot shape mirrors what PR6's bootstrap-resolver expects to read.
    // last_successful_fetch is epoch ms; the resolver uses it to compute the
    // 24h continuous-failure ceiling. We seed it from `Date.now()` here so
    // the first cycle after auth doesn't immediately consider the cache stale.
    const snapshot = {
        server_url: payload.server_url,
        user_email: payload.user_email,
        interval_seconds: payload.interval_seconds,
        rooms: payload.rooms,
        etag,
        fetched_at: payload.fetched_at,
        last_successful_fetch: Date.now(),
    };
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, path);
}
async function acquirePat(opts, io) {
    if (opts.token) {
        if (opts.tokenWasFlag) {
            io.err.write('! warning: --token <PAT> exposes the PAT in shell history; ' +
                'prefer --from-stdin (e.g. `pbpaste | chronos-sync auth --from-stdin`).\n');
        }
        return opts.token.trim();
    }
    if (opts.fromStdin) {
        const reader = io.readStdin ?? defaultReadStdin;
        return (await reader()).trim();
    }
    // Interactive TTY no-echo prompt.
    const prompter = io.promptHidden ?? defaultPromptHidden;
    const value = await prompter('Enter PAT (input hidden): ');
    return value.trim();
}
async function defaultReadStdin() {
    let raw = '';
    return new Promise((resolve, reject) => {
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            raw += chunk;
        });
        process.stdin.on('end', () => resolve(raw));
        process.stdin.on('error', reject);
    });
}
/**
 * TTY no-echo prompt. Uses `readline` with `_writeToOutput` overridden so the
 * keystrokes do not echo. `process.stdin.setRawMode` is unnecessary — readline
 * already handles line-buffering — but echo suppression is the bit that keeps
 * the PAT off the screen.
 */
async function defaultPromptHidden(prompt) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });
    // _writeToOutput is undocumented but stable since Node 16. Override to swallow
    // keystroke echo while still rendering the prompt itself once.
    const rlAny = rl;
    let promptWritten = false;
    rlAny._writeToOutput = (s) => {
        if (!promptWritten) {
            process.stdout.write(s);
            promptWritten = true;
        }
        // swallow everything else (the keystrokes the user types)
    };
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            process.stdout.write('\n');
            rl.close();
            resolve(answer);
        });
    });
}
/**
 * `--reset` (MAJ-7): release rooms held by the old PAT, wipe local creds,
 * then return so the regular acquire-and-register flow can run with a fresh PAT.
 *
 * Graceful degradation: if the old PAT is already revoked (401 from the
 * server), we still wipe local creds and print actionable copy explaining
 * that the user must clear stuck rooms manually via the web UI.
 */
async function runReset(_opts, io) {
    const out = io.out;
    const err = io.err;
    const existing = await loadAuth().catch(() => null);
    if (!existing) {
        out.write('reset: no existing auth.json — nothing to revoke. Proceeding to fresh registration.\n');
        return { exitCode: 0 };
    }
    let oldPat = null;
    try {
        if (existing.pat_storage === 'keychain') {
            oldPat = await getPat(existing.user_email);
        }
        else {
            oldPat = await loadPatFile();
        }
    }
    catch (e) {
        err.write(`! warning: could not read old PAT for unregister (${e.message}). ` +
            'Wiping local creds anyway.\n');
    }
    if (oldPat) {
        try {
            const result = await getBootstrap({ serverUrl: existing.server_url, pat: oldPat });
            if (result.status === 200) {
                const rooms = result.payload.rooms;
                for (const room of rooms) {
                    try {
                        await deleteAutoUploadRoom({ serverUrl: existing.server_url, pat: oldPat }, room.project_id, room.room_name);
                        out.write(`reset: released ${room.project_id}/${room.room_name}\n`);
                    }
                    catch (e) {
                        err.write(`! warning: failed to release ${room.project_id}/${room.room_name}: ` +
                            `${e.message}\n`);
                    }
                }
            }
        }
        catch (e) {
            if (e instanceof ApiPatAuthError) {
                err.write('! warning: old PAT already invalid (401); cannot auto-unregister rooms.\n' +
                    '  After new auth, manually clear via web UI or call DELETE\n' +
                    '  /api/account/auto-upload/rooms/{project_id}/{room_name} with the new PAT.\n');
            }
            else {
                err.write(`! warning: unregister bootstrap fetch failed: ${e.message}\n`);
            }
        }
    }
    // Wipe local creds (best effort — symmetric with the rotation intent).
    try {
        if (existing.pat_storage === 'keychain') {
            await deletePat(existing.user_email);
        }
    }
    catch (e) {
        err.write(`! warning: failed to delete Keychain entry: ${e.message}\n`);
    }
    try {
        await wipeAuth();
    }
    catch (e) {
        err.write(`! warning: failed to wipe auth.json/auth.token: ${e.message}\n`);
    }
    // Cache file too — stale rooms list otherwise.
    try {
        await fs.unlink(bootstrapCachePath());
    }
    catch (e) {
        const errCode = e.code;
        if (errCode !== 'ENOENT') {
            err.write(`! warning: failed to remove cache: ${e.message}\n`);
        }
    }
    out.write('reset: local creds wiped. Proceeding to fresh registration.\n');
    return { exitCode: 0 };
}
export const __testing = {
    PAT_REGEX,
    authPath,
    hashPrefix,
};
