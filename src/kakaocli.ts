/**
 * Thin wrapper around the kakaocli (silver-flight-group/kakaocli) binary.
 *
 * Only the read side is needed here: list messages newer than the last
 * synced cursor. Sends are out of scope.
 */

import { spawn } from 'node:child_process'
import type { KakaoCliMessage } from './csv-reassemble.js'

export interface MessagesQuery {
  /** kakaocli chat display name. Mutually exclusive with `chatId`. */
  chat?: string
  /**
   * kakaocli chat numeric id. Required when targeting open chats whose
   * `display_name` is "(unknown)" because the Mac KakaoTalk DB does not
   * populate names for server-pushed open chat rooms.
   *
   * Accepts a string or a number; chat ids that exceed
   * `Number.MAX_SAFE_INTEGER` should always be passed as a string to
   * survive `JSON.parse` round-trips. The value is forwarded to kakaocli
   * verbatim via `String(chatId)`.
   */
  chatId?: string | number
  /** Optional ISO 8601 timestamp; only messages strictly after this are returned. */
  since?: string
  /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
  binary?: string
}

/**
 * Invoke `kakaocli messages [--chat <name> | --chat-id <id>] [--since <iso>] --json`
 * and parse the JSON array on stdout. kakaocli streams a single JSON array (or
 * a newline-delimited stream when `--follow` is used; we never use `--follow`
 * because the daemon owns its own scheduler).
 *
 * Either `chat` or `chatId` is required. When both are supplied `chatId`
 * wins to keep behavior aligned with the daemon's room dispatch.
 */
export async function listMessages(
  query: MessagesQuery
): Promise<KakaoCliMessage[]> {
  const binary = query.binary ?? 'kakaocli'
  const args = ['messages', '--json']
  if (query.chatId !== undefined) {
    args.splice(1, 0, '--chat-id', String(query.chatId))
  } else if (query.chat !== undefined) {
    args.splice(1, 0, '--chat', query.chat)
  } else {
    throw new Error('listMessages requires `chat` or `chatId`')
  }
  if (query.since) {
    args.push('--since', query.since)
  }

  const { stdout, stderr, code } = await runChild(binary, args)
  if (code !== 0) {
    throw new Error(
      `kakaocli exited with code ${code}: ${stderr.trim() || '(no stderr)'}`
    )
  }

  const trimmed = stdout.trim()
  if (!trimmed) return []

  const safe = preserveBigIntPrecision(trimmed)

  // Tolerate both `[ {...}, {...} ]` and NDJSON (`{...}\n{...}`).
  if (safe.startsWith('[')) {
    const parsed = JSON.parse(safe) as KakaoCliMessage[]
    return Array.isArray(parsed) ? parsed : []
  }

  const lines = safe.split(/\r?\n/).filter((l) => l.trim().length > 0)
  return lines.map((l) => JSON.parse(l) as KakaoCliMessage)
}

/**
 * KakaoTalk userIds (and chat ids, log ids) are 19-digit BigInts that
 * exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1 = 9007199254740992). When
 * `JSON.parse` hits a bare number literal in that range it silently
 * rounds the trailing digits to 0, e.g.
 *
 *   "sender_id": 8181328792600516744   →   8181328792600517000
 *
 * That breaks downstream lookups (the resolver's SQL `WHERE userId IN
 * (...)` no longer matches the real NTUser row, every sender falls to
 * the unresolved branch, and PR #7's strict-skip path stalls the
 * cycle indefinitely).
 *
 * We rewrite known BigInt-shaped numeric fields to JSON strings before
 * `JSON.parse` so the exact digits survive. Two emission shapes are
 * covered:
 *   1. Object form (`kakaocli messages --json`):
 *      `"sender_id": 8181328792600516744`  →  `"sender_id": "8181..."`
 *   2. Tuple form (`kakaocli query` 2-D array of `[userId, name]`):
 *      `[6321186593654462422, "드림솔져"]`  →  `["6321...", "드림솔져"]`
 *      Without this the v0.2.7 dho stuck regression happens — every 19-
 *      digit open-chat sender resolves to a rounded map key that no
 *      caller can match.
 *
 * Downstream code (`enrichSenders`, `resolveSenderNames.sanitizeIds`,
 * `parseQueryRows`) already accepts `number | string` for these fields.
 */
export function preserveBigIntPrecision(stdout: string): string {
  return (
    stdout
      // Object form: `"key": 1234567890123456`
      .replace(
        /"(sender_id|chat_id|id|logId|userId)"(\s*):(\s*)(\d{16,})/g,
        '"$1"$2:$3"$4"'
      )
      // Tuple form: `[ 1234567890123456 ,` (first element of an array literal)
      .replace(/\[(\s*)(\d{16,})(\s*),/g, '[$1"$2"$3,')
  )
}

export interface HarvestQuery {
  /** Process top N most recent chats. Default 5. Passed as `--top <n>`. */
  top?: number
  /** Max 'View Previous Chats' clicks per chat. Passed as `--max-clicks <n>`. */
  maxClicks?: number
  /** Delay between actions in seconds. Passed as `--scroll-delay <s>`. */
  scrollDelay?: number
  /** Show what would be done without doing it. */
  dryRun?: boolean
  /** Path to database file. */
  db?: string
  /** Database encryption key. */
  key?: string
  /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
  binary?: string
  /** Spawn timeout in ms. Default 60000. */
  timeoutMs?: number
}

export interface HarvestResult {
  code: number
  stderr: string
}

export interface HarvestCaps {
  /** kakaocli binary that was probed. */
  binary: string
  /** Whether `harvest --scroll` is supported. */
  scrollSupported: boolean
  /** Raw flags extracted from `harvest --help` stdout. */
  flags: string[]
}

// Module-level probe cache — invalidated on exit-64 or SIGHUP.
let _probeCache: HarvestCaps | null = null

/** Invalidate the probe cache (e.g. after exit-64 or SIGHUP). */
export function invalidateProbeCache(): void {
  _probeCache = null
}

/**
 * Parse `kakaocli harvest --help` and return supported capabilities.
 * Result is cached for the process lifetime; call `invalidateProbeCache()` to refresh.
 */
export async function probeHarvestCapabilities(binary = 'kakaocli'): Promise<HarvestCaps> {
  if (_probeCache !== null && _probeCache.binary === binary) return _probeCache

  const { stdout, stderr } = await runChild(binary, ['harvest', '--help'])
  const combined = stdout + stderr
  // Extract long-form flags from help text: --flag-name
  const flags = Array.from(combined.matchAll(/--([a-z][a-z0-9-]*)/g), (m) => `--${m[1]}`)
  const unique = [...new Set(flags)]
  const caps: HarvestCaps = {
    binary,
    scrollSupported: unique.includes('--scroll'),
    flags: unique,
  }
  _probeCache = caps
  return caps
}

/**
 * Invoke `kakaocli harvest --scroll [--top <n>] [--max-clicks <n>] [--scroll-delay <s>]`.
 * Best-effort: always resolves (never throws) so the caller can warn-log and continue normal sync.
 * On exit-64 the probe cache is invalidated so the next probe re-checks capabilities.
 */
export async function harvestScroll(query: HarvestQuery): Promise<HarvestResult> {
  const binary = query.binary ?? 'kakaocli'
  const args = ['harvest', '--scroll']
  if (query.top !== undefined) {
    args.push('--top', String(query.top))
  }
  if (query.maxClicks !== undefined) {
    args.push('--max-clicks', String(query.maxClicks))
  }
  if (query.scrollDelay !== undefined) {
    args.push('--scroll-delay', String(query.scrollDelay))
  }
  if (query.dryRun) {
    args.push('--dry-run')
  }
  if (query.db !== undefined) {
    args.push('--db', query.db)
  }
  if (query.key !== undefined) {
    args.push('--key', query.key)
  }

  const timeoutMs = query.timeoutMs ?? 60_000
  const { stderr, code } = await runChild(binary, args, timeoutMs)
  if (code === 64) invalidateProbeCache()
  return { code, stderr }
}

interface ChildResult {
  stdout: string
  stderr: string
  code: number
}

function runChild(binary: string, args: string[], timeoutMs?: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (result: ChildResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      settle({ stdout, stderr, code: code ?? -1 })
    })

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle({ stdout, stderr, code: -1 })
      }, timeoutMs)
    }
  })
}
