/**
 * `chronos-sync migrate` — convert a v0.4.x `~/.chronos/config.json` into the
 * v0.5.0 auth-mode layout (Keychain/auth.token + auth.json).
 *
 * Plan reference: PR7 of `.cmux/plans/auto-upload-server-driven-config.md`
 * (MAJ-8 + CRIT-2).
 *
 * 11-step flow:
 *   1. Daemon detection (MAJ-8.3) — refuse unless `--force` if pgrep or
 *      launchctl shows a running chronos-sync.
 *   2. Read legacy config.json. Bail with "nothing to migrate" if absent or
 *      lacking embedded `pat`+`rooms`.
 *   3. Pre-flight project validation (MAJ-8.2) — GET /api/auto-upload/projects
 *      with the legacy PAT, filter rows pointing at archived/inaccessible
 *      projects.
 *   4. `--dry-run` (MAJ-8.1) — print summary and exit 0; zero side effects.
 *   5. Confirm prompt (skipped with `--force`).
 *   6. PUT /api/account/auto-upload/rooms with valid rows.
 *   7. PUT /api/account/settings/sync with legacy interval_seconds.
 *   8. GET /api/auto-upload/bootstrap with legacy PAT → user_email (CRIT-2).
 *   9. Persist PAT to Keychain (or auth.token with --allow-file-pat).
 *   10. saveAuth(...) → ~/.chronos/auth.json.
 *   11. Rename ~/.chronos/config.json → config.json.legacy.bak.<ts>.
 *
 * Rollback: any failure during steps 6-10 keeps the legacy config.json intact
 * (no rename). The user can fix the underlying issue and re-run; the function
 * is idempotent (PR1 PUT replaces, Keychain setPat upserts, saveAuth overwrites).
 */
export interface MigrateCliResult {
    exitCode: number;
}
export interface MigrateCliOptions {
    dryRun?: boolean;
    force?: boolean;
    serverUrl?: string;
    allowFilePat?: boolean;
}
export interface MigrateCliIo {
    out: NodeJS.WritableStream;
    err: NodeJS.WritableStream;
    /** Y/n confirm. Default reads from TTY stdin. */
    confirm?: (prompt: string) => Promise<boolean>;
}
export declare function runMigrate(opts: MigrateCliOptions, io?: MigrateCliIo): Promise<MigrateCliResult>;
