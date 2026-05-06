/**
 * `chronos-sync interval <seconds>` / `chronos-sync interval --get`
 *
 * Talks directly to the chronos web KV via PUT/GET. The running daemon
 * will pick up the new value at the next cycle (PR-C resolveInterval).
 *
 * On PUT success we also rewrite ~/.chronos/config.json's
 * interval_seconds atomically. The daemon's source of truth remains the
 * web KV (see plan ADR-001), but having config.json carry the latest
 * value keeps the "KV unreachable + daemon restart" path from rolling
 * back to a stale local value.
 *
 * If the local rewrite fails, the KV write still wins — we surface a
 * warning to stderr and exit 0 because the next successful KV fetch
 * (next cycle) will re-derive the right value anyway.
 */

import { promises as fs } from 'node:fs'
import {
  getSyncSettings,
  putSyncSettings,
  ApiPatAuthError,
  type SyncSettingsResponse,
} from '../api-client.js'
import { configPath, loadConfig } from '../state-file.js'
import {
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from '../types.js'

export interface IntervalCliResult {
  exitCode: number
}

/**
 * `chronos-sync interval <seconds>` — PUT new interval to web KV, then
 * sync the local config.json. The daemon picks up the value on its next
 * cycle (no signal needed thanks to PR-C per-cycle resolveInterval).
 */
export async function runIntervalSet(
  rawSeconds: string,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr
): Promise<IntervalCliResult> {
  const parsed = parseSeconds(rawSeconds)
  if (parsed === null) {
    err.write(`잘못된 값: "${rawSeconds}" — 정수만 허용합니다.\n`)
    return { exitCode: 1 }
  }
  if (parsed < MIN_INTERVAL_SECONDS || parsed > MAX_INTERVAL_SECONDS) {
    err.write(
      `값 범위 오류: ${parsed}초 — ${MIN_INTERVAL_SECONDS}~${MAX_INTERVAL_SECONDS}초 사이여야 합니다.\n`
    )
    return { exitCode: 1 }
  }

  const config = await tryLoadConfig(err)
  if (!config) return { exitCode: 1 }

  let response: SyncSettingsResponse
  try {
    response = await putSyncSettings(
      { serverUrl: config.server_url, pat: config.pat },
      parsed
    )
  } catch (e) {
    if (e instanceof ApiPatAuthError) {
      err.write('PAT 인증 실패 (401). web에서 PAT를 갱신하고 ~/.chronos/config.json에 새 값을 넣으세요.\n')
      return { exitCode: 1 }
    }
    err.write(`PUT 실패: ${(e as Error).message}\n`)
    return { exitCode: 1 }
  }

  const localSyncOk = await syncLocalConfig(parsed, err)
  if (localSyncOk) {
    out.write(
      `interval=${response.interval_seconds}s saved (web + local). ` +
        `데몬이 다음 cycle에서 자동 반영합니다.\n`
    )
  } else {
    out.write(
      `interval=${response.interval_seconds}s saved (web only — 로컬 sync 실패). ` +
        `데몬은 다음 KV fetch 성공 시 새 값을 가져옵니다.\n`
    )
  }
  return { exitCode: 0 }
}

/**
 * `chronos-sync interval --get` — pretty-print the current value from
 * the web KV plus the local config.json so users can spot drift.
 */
export async function runIntervalGet(
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr
): Promise<IntervalCliResult> {
  const config = await tryLoadConfig(err)
  if (!config) return { exitCode: 1 }

  let response: SyncSettingsResponse
  try {
    response = await getSyncSettings({ serverUrl: config.server_url, pat: config.pat })
  } catch (e) {
    if (e instanceof ApiPatAuthError) {
      err.write('PAT 인증 실패 (401). web에서 PAT를 갱신하고 ~/.chronos/config.json에 새 값을 넣으세요.\n')
      return { exitCode: 1 }
    }
    err.write(`GET 실패: ${(e as Error).message}\n`)
    return { exitCode: 1 }
  }

  const drift = response.interval_seconds !== config.interval_seconds
  const driftLabel = drift ? `  (local config: ${config.interval_seconds}s — drift)` : ''
  out.write(
    `interval=${response.interval_seconds}s ` +
      `(last updated: ${response.updated_at})${driftLabel}\n`
  )
  return { exitCode: 0 }
}

function parseSeconds(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return null
  return n
}

async function tryLoadConfig(
  err: NodeJS.WritableStream
): Promise<Awaited<ReturnType<typeof loadConfig>> | null> {
  try {
    return await loadConfig()
  } catch (e) {
    err.write(`config 로드 실패: ${(e as Error).message}\n`)
    err.write(`(${configPath()} 가 존재하고 유효한지 확인하세요.)\n`)
    return null
  }
}

/**
 * Rewrite the local config.json's interval_seconds atomically. Returns
 * true on success, false on any failure (caller surfaces a softer
 * message and still exits 0 because the KV write is the truth).
 */
async function syncLocalConfig(
  intervalSeconds: number,
  err: NodeJS.WritableStream
): Promise<boolean> {
  const path = configPath()
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (e) {
    err.write(`! 로컬 config 동기화 실패 (read): ${(e as Error).message}\n`)
    return false
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    err.write(`! 로컬 config 동기화 실패 (parse): ${(e as Error).message}\n`)
    return false
  }

  parsed.interval_seconds = intervalSeconds

  const tmp = `${path}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, path)
  } catch (e) {
    err.write(`! 로컬 config 동기화 실패 (write): ${(e as Error).message}\n`)
    return false
  }
  return true
}
