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

import { promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ApiPatAuthError,
  getBootstrap,
  listEligibleProjects,
  putAutoUploadRooms,
  putSyncSettings,
  type AutoUploadMappingRow,
  type EligibleProject,
} from '../api-client.js'
import {
  authPath,
  bootstrapCachePath,
  chronosHomeDir,
  ensureChronosDir,
  saveAuth,
  savePatFile,
  type AuthFile,
} from '../auth-file.js'
import { CONFIG_FILE_NAME } from '../constants.js'
import { isKeychainAvailable, setPat } from '../keychain.js'
import { probeRunningDaemon } from '../daemon-detect.js'

export interface MigrateCliResult {
  exitCode: number
}

export interface MigrateCliOptions {
  dryRun?: boolean
  force?: boolean
  serverUrl?: string
  allowFilePat?: boolean
}

export interface MigrateCliIo {
  out: NodeJS.WritableStream
  err: NodeJS.WritableStream
  /** Y/n confirm. Default reads from TTY stdin. */
  confirm?: (prompt: string) => Promise<boolean>
}

export async function runMigrate(
  opts: MigrateCliOptions,
  io: MigrateCliIo = { out: process.stdout, err: process.stderr }
): Promise<MigrateCliResult> {
  const out = io.out
  const err = io.err

  // --- step 1: daemon detection (MAJ-8.3) ---
  const probe = await probeRunningDaemon()
  if (probe.running && !opts.force) {
    err.write(
      `error: chronos-sync daemon is running (pids=${probe.pids.join(',') || 'none'} ` +
        `launchd=${probe.launchdLabels.join(',') || 'none'}).\n` +
        `Stop the daemon first: launchctl unload ~/Library/LaunchAgents/com.brightworks.chronos-sync.plist\n` +
        `(or kill the foreground process). Or re-run with --force to proceed despite the running daemon.\n`
    )
    return { exitCode: 1 }
  }

  // --- step 2: read legacy config.json ---
  await ensureChronosDir().catch(() => undefined) // tolerate missing dir
  const legacyPath = join(chronosHomeDir(), CONFIG_FILE_NAME)
  let legacyParsed: Record<string, unknown>
  try {
    const raw = await fs.readFile(legacyPath, 'utf8')
    legacyParsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      out.write('migrate: no legacy config.json found — nothing to migrate.\n')
      return { exitCode: 0 }
    }
    err.write(`error: failed to read ${legacyPath}: ${(e as Error).message}\n`)
    return { exitCode: 1 }
  }

  const legacyPat = typeof legacyParsed.pat === 'string' ? legacyParsed.pat : null
  const legacyRoomsRaw = Array.isArray(legacyParsed.rooms) ? legacyParsed.rooms : []
  const legacyServerUrl =
    typeof legacyParsed.server_url === 'string'
      ? legacyParsed.server_url.replace(/\/+$/, '')
      : null
  const legacyInterval =
    typeof legacyParsed.interval_seconds === 'number' &&
    Number.isFinite(legacyParsed.interval_seconds)
      ? Math.floor(legacyParsed.interval_seconds)
      : null

  if (!legacyPat || legacyRoomsRaw.length === 0) {
    out.write(
      'migrate: legacy config.json has no embedded pat/rooms — nothing to migrate.\n' +
        '  (run "chronos-sync auth" directly to set up auth-mode.)\n'
    )
    return { exitCode: 0 }
  }
  if (!legacyServerUrl) {
    err.write(`error: legacy config.json missing server_url\n`)
    return { exitCode: 1 }
  }

  const serverUrl = (opts.serverUrl ?? legacyServerUrl).replace(/\/+$/, '')

  // Transform legacy rooms → AutoUploadMappingRow. Rows must have a chat_id;
  // legacy rows that only carry chat_name (kakaocli display-name lookup)
  // cannot be migrated automatically — surface them for manual web-UI entry.
  const mappingCandidates: Array<{
    row: AutoUploadMappingRow
    legacyIndex: number
  }> = []
  const skippedNoChatId: Array<{ index: number; project_id: string; room_name: string }> = []
  for (let i = 0; i < legacyRoomsRaw.length; i++) {
    const r = legacyRoomsRaw[i] as Record<string, unknown>
    const project_id = typeof r.project_id === 'string' ? r.project_id : ''
    const room_name = typeof r.room_name === 'string' ? r.room_name : ''
    if (!project_id || !room_name) continue
    let chatId: string | null = null
    if (typeof r.chat_id === 'string' && /^[0-9]+$/.test(r.chat_id)) {
      chatId = r.chat_id
    } else if (
      typeof r.chat_id === 'number' &&
      Number.isFinite(r.chat_id) &&
      Number.isSafeInteger(r.chat_id) &&
      r.chat_id >= 0
    ) {
      chatId = String(r.chat_id)
    }
    if (chatId === null) {
      skippedNoChatId.push({ index: i, project_id, room_name })
      continue
    }
    mappingCandidates.push({
      row: { project_id, room_name, chat_id: chatId },
      legacyIndex: i,
    })
  }

  // --- step 3: pre-flight project validation (MAJ-8.2) ---
  let eligibleProjects: EligibleProject[]
  try {
    eligibleProjects = await listEligibleProjects({ serverUrl, pat: legacyPat })
  } catch (e) {
    if (e instanceof ApiPatAuthError) {
      err.write(
        'error: legacy PAT rejected by server (401). Cannot pre-flight project validation.\n' +
          '  Issue a fresh PAT and run "chronos-sync auth" directly instead.\n'
      )
      return { exitCode: 1 }
    }
    err.write(`error: pre-flight failed: ${(e as Error).message}\n`)
    return { exitCode: 1 }
  }
  const eligibleIds = new Set(
    eligibleProjects.filter((p) => p.archived !== true).map((p) => p.id)
  )

  const validRows: AutoUploadMappingRow[] = []
  const droppedArchived: AutoUploadMappingRow[] = []
  for (const { row } of mappingCandidates) {
    if (eligibleIds.has(row.project_id)) {
      validRows.push(row)
    } else {
      droppedArchived.push(row)
    }
  }

  // --- step 4: --dry-run summary, then exit 0 (no state change) ---
  if (opts.dryRun) {
    printMigrateSummary({
      out,
      validRows,
      droppedArchived,
      skippedNoChatId,
      legacyInterval,
      legacyPat,
      serverUrl,
      allowFilePat: opts.allowFilePat ?? false,
    })
    out.write('\n[dry-run] no changes made.\n')
    return { exitCode: 0 }
  }

  if (validRows.length === 0) {
    err.write(
      `error: no valid rooms to migrate (legacy=${legacyRoomsRaw.length}, ` +
        `dropped=${droppedArchived.length}, skipped-no-chat-id=${skippedNoChatId.length}).\n` +
        '  Re-add rooms via the web UI after running "chronos-sync auth" directly.\n'
    )
    return { exitCode: 1 }
  }

  // --- step 5: confirm (skipped with --force) ---
  if (!opts.force) {
    printMigrateSummary({
      out,
      validRows,
      droppedArchived,
      skippedNoChatId,
      legacyInterval,
      legacyPat,
      serverUrl,
      allowFilePat: opts.allowFilePat ?? false,
    })
    const promptText = `\nContinue with ${validRows.length} valid room(s)` +
      (droppedArchived.length ? ` (drop ${droppedArchived.length} archived)` : '') +
      `? [Y/n] `
    const confirmer = io.confirm ?? defaultConfirm
    const proceed = await confirmer(promptText)
    if (!proceed) {
      out.write('migrate: aborted by user. No changes made.\n')
      return { exitCode: 0 }
    }
  }

  // --- step 6: PUT rooms ---
  try {
    await putAutoUploadRooms({ serverUrl, pat: legacyPat }, validRows)
  } catch (e) {
    if (e instanceof ApiPatAuthError) {
      err.write('error: legacy PAT rejected by server (401) during room PUT. Aborting; legacy config preserved.\n')
      return { exitCode: 1 }
    }
    err.write(
      `error: room PUT failed: ${(e as Error).message}\n` +
        '  legacy config.json preserved; re-run "chronos-sync migrate" after resolving.\n'
    )
    return { exitCode: 1 }
  }

  // --- step 7: PUT interval (if legacy specified one) ---
  if (legacyInterval !== null) {
    try {
      await putSyncSettings({ serverUrl, pat: legacyPat }, legacyInterval)
    } catch (e) {
      if (e instanceof ApiPatAuthError) {
        err.write('error: legacy PAT rejected by server (401) during interval PUT. Aborting; legacy config preserved.\n')
        return { exitCode: 1 }
      }
      err.write(
        `error: interval PUT failed: ${(e as Error).message}\n` +
          '  legacy config.json preserved; re-run "chronos-sync migrate" after resolving.\n'
      )
      return { exitCode: 1 }
    }
  }

  // --- step 8: GET bootstrap → user_email (CRIT-2) ---
  let userEmail: string
  try {
    const bootstrap = await getBootstrap({ serverUrl, pat: legacyPat })
    if (bootstrap.status !== 200) {
      err.write(
        `error: bootstrap returned status ${bootstrap.status} unexpectedly; aborting. Legacy config preserved.\n`
      )
      return { exitCode: 1 }
    }
    userEmail = bootstrap.payload.user_email
  } catch (e) {
    if (e instanceof ApiPatAuthError) {
      err.write('error: legacy PAT rejected by server (401) during bootstrap. Aborting; legacy config preserved.\n')
      return { exitCode: 1 }
    }
    err.write(
      `error: bootstrap fetch failed: ${(e as Error).message}\n` +
        '  legacy config.json preserved; re-run "chronos-sync migrate" after resolving.\n'
    )
    return { exitCode: 1 }
  }

  // --- step 9: persist PAT to Keychain or opt-in file ---
  const allowFile = opts.allowFilePat || process.env.CHRONOS_ALLOW_FILE_PAT === '1'
  const probeKey = await isKeychainAvailable()
  let storage: 'keychain' | 'file'
  if (probeKey.available) {
    storage = 'keychain'
  } else if (allowFile) {
    storage = 'file'
  } else {
    err.write(
      `error: Keychain unavailable (${probeKey.reason ?? 'unknown reason'}).\n` +
        '  Re-run "chronos-sync migrate --allow-file-pat" to store PAT in mode-0600 file ' +
        '(not recommended for shared hosts). Legacy config preserved.\n'
    )
    return { exitCode: 1 }
  }

  try {
    if (storage === 'keychain') {
      await setPat(userEmail, legacyPat)
    } else {
      await savePatFile(legacyPat)
    }
  } catch (e) {
    err.write(
      `error: failed to persist PAT (${storage}): ${(e as Error).message}\n` +
        '  legacy config.json preserved.\n'
    )
    return { exitCode: 1 }
  }

  // --- step 10: write auth.json ---
  const auth: AuthFile = {
    server_url: serverUrl,
    user_email: userEmail,
    pat_hash_prefix: hashPrefix(legacyPat),
    pat_storage: storage,
    allow_file_pat: allowFile,
    written_at: new Date().toISOString(),
  }
  try {
    await saveAuth(auth)
  } catch (e) {
    err.write(
      `error: failed to write auth.json: ${(e as Error).message}\n` +
        '  legacy config.json preserved.\n'
    )
    return { exitCode: 1 }
  }

  // --- step 11: rename legacy config to .legacy.bak.<ts> ---
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${legacyPath}.legacy.bak.${ts}`
  try {
    await fs.rename(legacyPath, backupPath)
  } catch (e) {
    // auth.json + Keychain are already written. Without the rename, PR6's
    // "both present → defensive refuse" branch would fire on next daemon
    // start. Surface this loudly so the user can rm/manual-rename.
    err.write(
      `! warning: auth.json + Keychain written, but renaming legacy config.json failed: ${(e as Error).message}\n` +
        `  Run: mv "${legacyPath}" "${backupPath}"  (manually) before starting the daemon,\n` +
        '  or PR6\'s defensive check will refuse to start with both files present.\n'
    )
    return { exitCode: 1 }
  }

  // Optional sweep: remove any stale bootstrap cache so the daemon's next
  // prime fetches fresh state. Best effort.
  try {
    await fs.unlink(bootstrapCachePath())
  } catch {
    // ENOENT is fine
  }

  out.write(
    `migrate: success.\n` +
      `  rooms migrated: ${validRows.length}\n` +
      `  pat_storage:    ${storage}\n` +
      `  user_email:     ${userEmail}\n` +
      `  legacy backup:  ${backupPath}\n` +
      `  next: run "chronos-sync" to start syncing in auth-mode.\n`
  )
  return { exitCode: 0 }
}

function hashPrefix(pat: string): string {
  return createHash('sha256').update(pat, 'utf8').digest('hex').slice(0, 12)
}

interface SummaryInputs {
  out: NodeJS.WritableStream
  validRows: AutoUploadMappingRow[]
  droppedArchived: AutoUploadMappingRow[]
  skippedNoChatId: Array<{ index: number; project_id: string; room_name: string }>
  legacyInterval: number | null
  legacyPat: string
  serverUrl: string
  allowFilePat: boolean
}

function printMigrateSummary(inputs: SummaryInputs): void {
  const { out } = inputs
  out.write(`migrate plan:\n`)
  out.write(`  server_url:       ${inputs.serverUrl}\n`)
  out.write(`  pat_hash_prefix:  ${hashPrefix(inputs.legacyPat)}\n`)
  out.write(`  interval_seconds: ${inputs.legacyInterval ?? '(unchanged)'}\n`)
  out.write(`  pat_storage:      ${inputs.allowFilePat ? 'keychain (or file with --allow-file-pat)' : 'keychain'}\n`)
  out.write(`  rooms (valid, ${inputs.validRows.length}):\n`)
  for (const row of inputs.validRows) {
    out.write(`    - ${row.project_id}/${row.room_name} (chat_id=${row.chat_id})\n`)
  }
  if (inputs.droppedArchived.length > 0) {
    out.write(`  rooms (dropped — archived/inaccessible, ${inputs.droppedArchived.length}):\n`)
    for (const row of inputs.droppedArchived) {
      out.write(`    - ${row.project_id}/${row.room_name}\n`)
    }
  }
  if (inputs.skippedNoChatId.length > 0) {
    out.write(`  rooms (skipped — no chat_id; re-add via web UI, ${inputs.skippedNoChatId.length}):\n`)
    for (const row of inputs.skippedNoChatId) {
      out.write(`    - ${row.project_id}/${row.room_name}\n`)
    }
  }
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      // Default Y on empty input.
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes')
    })
  })
}
