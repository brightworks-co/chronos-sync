/**
 * Argv parsing for `chronos-sync migrate`. Lives separately from the main
 * handler so the parser can be unit-tested without spawning a child process
 * (mirrors src/cli/auth-args.ts).
 */

export interface MigrateCliOptions {
  /** Print the intended changes and exit 0 without touching state. */
  dryRun?: boolean
  /** Skip confirm prompts and the running-daemon refusal. */
  force?: boolean
  /** Override the chronos server URL (defaults to legacy config's server_url). */
  serverUrl?: string
  /** Permit file-based PAT storage when Keychain is unavailable. */
  allowFilePat?: boolean
}

export type ParseMigrateArgsResult =
  | { kind: 'options'; options: MigrateCliOptions }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string }

export function parseMigrateArgs(argv: readonly string[]): ParseMigrateArgsResult {
  const options: MigrateCliOptions = {}

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { kind: 'help' }
    if (a === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (a === '--force') {
      options.force = true
      continue
    }
    if (a === '--allow-file-pat') {
      options.allowFilePat = true
      continue
    }
    if (a === '--server-url') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        return { kind: 'invalid', message: '--server-url requires a value' }
      }
      options.serverUrl = next
      i++
      continue
    }
    if (a.startsWith('--server-url=')) {
      const value = a.slice('--server-url='.length)
      if (!value) return { kind: 'invalid', message: '--server-url requires a value' }
      options.serverUrl = value
      continue
    }
    if (a.startsWith('--')) {
      return { kind: 'invalid', message: `unknown migrate option: ${a}` }
    }
    return { kind: 'invalid', message: `unexpected positional argument: ${a}` }
  }

  return { kind: 'options', options }
}
