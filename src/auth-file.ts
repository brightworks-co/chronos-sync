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

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_DIR_NAME } from './constants.js'

export const AUTH_FILE_NAME = 'auth.json'
export const AUTH_TOKEN_FILE_NAME = 'auth.token'
export const BOOTSTRAP_CACHE_FILE_NAME = 'config.cache.json'

export interface AuthFile {
  /** Base URL of the chronos server, no trailing slash. */
  server_url: string
  /** Resolved from `/api/auto-upload/bootstrap` payload. */
  user_email: string
  /** First 12 chars of `sha256(pat)` — diagnostics only, never the PAT itself. */
  pat_hash_prefix: string
  /** Where the PAT lives. `keychain` is the happy path; `file` is opt-in via --allow-file-pat. */
  pat_storage: 'keychain' | 'file'
  /**
   * Echoes whether `--allow-file-pat` (or `CHRONOS_ALLOW_FILE_PAT=1`) was set
   * at registration time, regardless of which storage backend was actually
   * used. Useful for diagnostics — distinguishes "fell back to file" from
   * "Keychain happened to fail right now."
   */
  allow_file_pat: boolean
  /** ISO 8601 timestamp of `chronos-sync auth` completion. */
  written_at: string
}

/**
 * Resolve the chronos directory. Honors `CHRONOS_HOME` env override.
 *
 * - `CHRONOS_HOME` set to non-empty → `<CHRONOS_HOME>` verbatim (the env
 *   variable IS the directory, not a parent). This matches the install-page
 *   troubleshooting copy: `CHRONOS_HOME=/var/cache/chronos`.
 * - `CHRONOS_HOME` unset/empty → `~/.chronos`.
 */
export function chronosHomeDir(): string {
  const override = process.env.CHRONOS_HOME
  if (typeof override === 'string' && override.length > 0) {
    return override
  }
  return join(homedir(), DAEMON_DIR_NAME)
}

export function authPath(): string {
  return join(chronosHomeDir(), AUTH_FILE_NAME)
}

export function authTokenPath(): string {
  return join(chronosHomeDir(), AUTH_TOKEN_FILE_NAME)
}

export function bootstrapCachePath(): string {
  return join(chronosHomeDir(), BOOTSTRAP_CACHE_FILE_NAME)
}

/**
 * `mkdir -p` the chronos directory with mode 0700. Idempotent.
 *
 * On EACCES/EPERM/EROFS we surface an actionable recovery one-liner per
 * Pre-mortem scenario 4. The error is rethrown so the CLI handler can exit
 * non-zero with the user-visible message.
 */
export async function ensureChronosDir(): Promise<void> {
  const dir = chronosHomeDir()
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(
        `cannot create ${dir} (permission denied)\n` +
          `fix:   sudo chown -R "$(whoami)" "${dir}" && chmod 700 "${dir}"\n` +
          `docs:  https://chronos.brightworks.app/account/auto-upload/install#troubleshooting`
      )
    }
    if (err.code === 'EROFS') {
      throw new Error(
        `${dir} cannot be created (HOME is read-only). ` +
          `Set CHRONOS_HOME=<writable path> and re-run.`
      )
    }
    throw err
  }
  // mkdir({recursive:true,mode:...}) does NOT chmod existing dirs on every
  // platform. Force the mode on the leaf so a pre-existing 0755 dir tightens
  // back to 0700 — this is a security floor, not advisory.
  try {
    await fs.chmod(dir, 0o700)
  } catch {
    // best effort; perms might be unchangeable on exotic filesystems
  }
}

export async function loadAuth(): Promise<AuthFile | null> {
  let raw: string
  try {
    raw = await fs.readFile(authPath(), 'utf8')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`auth.json is not valid JSON: ${(e as Error).message}`)
  }
  return validateAuth(parsed)
}

/**
 * Atomic write: temp + rename, mode 0600. The chronos dir must already exist
 * (call `ensureChronosDir()` first).
 */
export async function saveAuth(auth: AuthFile): Promise<void> {
  validateAuth(auth) // throws on bad shape — fail loud
  const path = authPath()
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(auth, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(tmp, 0o600) // belt-and-suspenders: writeFile mode honors umask on some platforms
  await fs.rename(tmp, path)
}

export async function wipeAuth(): Promise<void> {
  for (const p of [authPath(), authTokenPath()]) {
    try {
      await fs.unlink(p)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') throw err
    }
  }
}

/**
 * Read the opt-in plaintext PAT file. Returns null when absent.
 */
export async function loadPatFile(): Promise<string | null> {
  try {
    const raw = await fs.readFile(authTokenPath(), 'utf8')
    return raw.trim()
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Atomic write of the opt-in plaintext PAT file. Mode 0600, verified post-write.
 * Caller MUST have set `auth.json.pat_storage = 'file'` and `allow_file_pat = true`.
 */
export async function savePatFile(token: string): Promise<void> {
  if (!token || typeof token !== 'string') {
    throw new Error('savePatFile: token must be a non-empty string')
  }
  const path = authTokenPath()
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, token + '\n', { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(tmp, 0o600)
  await fs.rename(tmp, path)
  // Verify post-rename; the rename target inherits perms from the source on
  // all POSIX filesystems we support, but on exotic FS we surface a loud error.
  const stat = await fs.stat(path)
  const mode = stat.mode & 0o777
  if (mode !== 0o600) {
    throw new Error(
      `${path} mode is ${mode.toString(8)} after write — expected 600. ` +
        `Refusing to leave PAT material with non-0600 permissions.`
    )
  }
}

function validateAuth(value: unknown): AuthFile {
  if (typeof value !== 'object' || value === null) {
    throw new Error('auth.json must be an object')
  }
  const v = value as Record<string, unknown>
  for (const k of ['server_url', 'user_email', 'pat_hash_prefix', 'written_at'] as const) {
    if (typeof v[k] !== 'string' || (v[k] as string).length === 0) {
      throw new Error(`auth.json.${k} missing or not a non-empty string`)
    }
  }
  if (v.pat_storage !== 'keychain' && v.pat_storage !== 'file') {
    throw new Error(`auth.json.pat_storage must be 'keychain' or 'file' (got ${JSON.stringify(v.pat_storage)})`)
  }
  if (typeof v.allow_file_pat !== 'boolean') {
    throw new Error('auth.json.allow_file_pat must be a boolean')
  }
  return {
    server_url: v.server_url as string,
    user_email: v.user_email as string,
    pat_hash_prefix: v.pat_hash_prefix as string,
    pat_storage: v.pat_storage as 'keychain' | 'file',
    allow_file_pat: v.allow_file_pat,
    written_at: v.written_at as string,
  }
}
