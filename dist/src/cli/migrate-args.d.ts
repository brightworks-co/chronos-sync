/**
 * Argv parsing for `chronos-sync migrate`. Lives separately from the main
 * handler so the parser can be unit-tested without spawning a child process
 * (mirrors src/cli/auth-args.ts).
 */
export interface MigrateCliOptions {
    /** Print the intended changes and exit 0 without touching state. */
    dryRun?: boolean;
    /** Skip confirm prompts and the running-daemon refusal. */
    force?: boolean;
    /** Override the chronos server URL (defaults to legacy config's server_url). */
    serverUrl?: string;
    /** Permit file-based PAT storage when Keychain is unavailable. */
    allowFilePat?: boolean;
}
export type ParseMigrateArgsResult = {
    kind: 'options';
    options: MigrateCliOptions;
} | {
    kind: 'help';
} | {
    kind: 'invalid';
    message: string;
};
export declare function parseMigrateArgs(argv: readonly string[]): ParseMigrateArgsResult;
