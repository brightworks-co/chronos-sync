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

  // Tolerate both `[ {...}, {...} ]` and NDJSON (`{...}\n{...}`).
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as KakaoCliMessage[]
    return Array.isArray(parsed) ? parsed : []
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0)
  return lines.map((l) => JSON.parse(l) as KakaoCliMessage)
}

export interface HarvestQuery {
  /** kakaocli chat display name. Mutually exclusive with `chatId`. */
  chat?: string
  /** kakaocli chat numeric id. */
  chatId?: string | number
  /** Optional kakaocli binary path. Defaults to `kakaocli` on PATH. */
  binary?: string
  /** Max scroll pages. Default 5. Passed as `--max-pages <n>`. */
  maxPages?: number
  /** Spawn timeout in ms. Default 60000. */
  timeoutMs?: number
}

export interface HarvestResult {
  code: number
  stderr: string
}

/**
 * Invoke `kakaocli harvest --scroll [--chat <name> | --chat-id <id>] [--max-pages <n>]`.
 * Best-effort: always resolves (never throws) so the caller can warn-log and continue normal sync.
 */
export async function harvestScroll(query: HarvestQuery): Promise<HarvestResult> {
  const binary = query.binary ?? 'kakaocli'
  const args = ['harvest', '--scroll']
  if (query.chatId !== undefined) {
    args.push('--chat-id', String(query.chatId))
  } else if (query.chat !== undefined) {
    args.push('--chat', query.chat)
  } else {
    throw new Error('harvestScroll requires `chat` or `chatId`')
  }
  if (query.maxPages !== undefined) {
    args.push('--max-pages', String(query.maxPages))
  }

  const timeoutMs = query.timeoutMs ?? 60_000
  const { stderr, code } = await runChild(binary, args, timeoutMs)
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
