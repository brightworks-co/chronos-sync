/**
 * `chronos-sync diagnose senders [<chat-name|chat-id>]`
 *
 * One-shot tool for figuring out *why* a chat is showing
 * `참여자_<sender_id>` in Chronos. The daemon's `enrichSenders`
 * resolves missing names via `kakaocli query` against the local Mac
 * KakaoTalk DB (NTUser + NTMultiProfile join). When that JOIN can't
 * find a row — open chats with non-friend members, ex-members purged
 * from NTUser, kakaocli `query` subcommand missing, userId precision
 * overflow — we fall back to the `참여자_<id>` placeholder.
 *
 * This subcommand prints a per-sender_id breakdown of a recent message
 * window so the user can tell the failure mode at a glance:
 *   - already populated by kakaocli messages JSON
 *   - is_from_me (local user, skipped on purpose)
 *   - resolved via NTUser JOIN (current happy path)
 *   - NOT FOUND — actual fallback hits with hints
 *
 * For every NOT FOUND we also probe NTUser directly via
 * `kakaocli query` so the report distinguishes "id legitimately missing
 * from local DB" from "kakaocli query subcommand failing for a different
 * reason".
 */

import { spawn } from 'node:child_process'
import { listMessages } from '../kakaocli.js'
import { resolveSenderNames } from '../sender-resolver.js'
import { loadConfig, configPath } from '../state-file.js'
import type { KakaoCliMessage } from '../csv-reassemble.js'
import type { RoomConfig } from '../types.js'

export interface DiagnoseResult {
  exitCode: number
}

interface SenderBucket {
  already_resolved: number
  is_from_me: number
  unique_ids_needing_lookup: Set<string>
}

interface IdReport {
  sender_id: string
  /** How many messages used this id within the window. */
  message_count: number
  /** First message text (clipped) for context. */
  sample_text: string
  /** 'resolved' | 'fallback' | 'probe_failed' | 'probe_absent' */
  status: 'resolved' | 'fallback_absent' | 'fallback_probe_failed'
  /** Resolved name (if status='resolved') OR NTUser probe stderr (if probe_failed). */
  detail: string
}

const RECENT_WINDOW_HOURS = 24

/**
 * Print a friendly diagnostic report for one room. Returns exit code 0
 * for any successful report (even when fallbacks are present — the
 * report itself is the deliverable). Returns 1 only on hard failures
 * like missing config or unparseable arguments.
 */
export async function runDiagnoseSenders(
  arg: string | undefined,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr
): Promise<DiagnoseResult> {
  let config
  try {
    config = await loadConfig()
  } catch (e) {
    err.write(`config 로드 실패: ${(e as Error).message}\n`)
    err.write(`(${configPath()} 가 존재하고 유효한지 확인하세요.)\n`)
    return { exitCode: 1 }
  }

  if (!arg) {
    out.write('사용법: chronos-sync diagnose senders <chat-name | chat-id>\n\n')
    out.write('설정된 룸:\n')
    for (const room of config.rooms) {
      const id = room.chat_id ?? '(none)'
      const name = room.chat_name ?? '(none)'
      out.write(`  - chat_name=${name}  chat_id=${id}  → ${room.project_id.slice(0, 8)}/${room.room_name}\n`)
    }
    return { exitCode: 0 }
  }

  const room = pickRoom(config.rooms, arg)
  if (!room) {
    err.write(`알 수 없는 룸: "${arg}". 설정된 chat_name 또는 chat_id 와 일치해야 합니다.\n`)
    return { exitCode: 1 }
  }

  const since = new Date(Date.now() - RECENT_WINDOW_HOURS * 3600 * 1000).toISOString()
  let messages: KakaoCliMessage[]
  try {
    messages = await listMessages({
      chat: room.chat_id !== undefined ? undefined : room.chat_name,
      chatId: room.chat_id,
      since,
      binary: config.kakaocli_path,
    })
  } catch (e) {
    err.write(`kakaocli messages 호출 실패: ${(e as Error).message}\n`)
    return { exitCode: 1 }
  }

  out.write(
    `\n=== 진단 대상 ===\n` +
      `chat_name: ${room.chat_name ?? '(none)'}\n` +
      `chat_id:   ${room.chat_id ?? '(none)'}\n` +
      `project:   ${room.project_id.slice(0, 8)}/${room.room_name}\n` +
      `window:    최근 ${RECENT_WINDOW_HOURS}h (since ${since})\n` +
      `messages:  ${messages.length}\n\n`
  )

  if (messages.length === 0) {
    out.write('지난 24시간에 메시지가 없습니다. 더 활발한 룸 또는 더 긴 윈도우가 필요할 수 있습니다.\n')
    return { exitCode: 0 }
  }

  const bucket = bucketSenders(messages)
  out.write(
    `=== 분류 ===\n` +
      `이미 해결됨 (kakaocli JSON 에 sender 채워짐): ${bucket.already_resolved}\n` +
      `is_from_me (로컬 사용자):                  ${bucket.is_from_me}\n` +
      `lookup 필요한 unique sender_id:            ${bucket.unique_ids_needing_lookup.size}\n\n`
  )

  if (bucket.unique_ids_needing_lookup.size === 0) {
    out.write('이 윈도우에서는 lookup 필요한 sender_id가 없습니다. 참여자_n 폴백이 발생했을 가능성 낮음.\n')
    return { exitCode: 0 }
  }

  const ids = [...bucket.unique_ids_needing_lookup]
  let nameMap = new Map<string, string>()
  let resolverError: string | null = null
  try {
    nameMap = await resolveSenderNames(ids, { binary: config.kakaocli_path })
  } catch (e) {
    resolverError = (e as Error).message
  }

  if (resolverError) {
    err.write(
      `\n! resolveSenderNames 호출 자체가 throw — kakaocli query 서브커맨드 부재/권한 문제로 추정\n` +
        `  error: ${resolverError}\n\n` +
        `  이 경우 데몬 enrichSenders의 catch 블록이 'sender resolver failed' 경고를 찍고\n` +
        `  모든 sender가 참여자_<id> 로 fallback 됩니다.\n`
    )
    return { exitCode: 0 }
  }

  const reports = await buildIdReports(ids, messages, nameMap, config.kakaocli_path)
  printIdReports(out, reports)
  return { exitCode: 0 }
}

function pickRoom(rooms: ReadonlyArray<RoomConfig>, arg: string): RoomConfig | null {
  for (const r of rooms) {
    if (r.chat_id !== undefined && String(r.chat_id) === arg.trim()) return r
    if (r.chat_name !== undefined && r.chat_name === arg) return r
  }
  return null
}

function bucketSenders(messages: KakaoCliMessage[]): SenderBucket {
  const bucket: SenderBucket = {
    already_resolved: 0,
    is_from_me: 0,
    unique_ids_needing_lookup: new Set<string>(),
  }
  for (const m of messages) {
    if (m.sender !== null && m.sender !== undefined && m.sender.length > 0) {
      bucket.already_resolved += 1
      continue
    }
    if (m.is_from_me) {
      bucket.is_from_me += 1
      continue
    }
    if (typeof m.sender_id === 'number' && Number.isFinite(m.sender_id) && m.sender_id > 0) {
      bucket.unique_ids_needing_lookup.add(String(m.sender_id))
    }
  }
  return bucket
}

async function buildIdReports(
  ids: string[],
  messages: KakaoCliMessage[],
  nameMap: Map<string, string>,
  binary: string | undefined
): Promise<IdReport[]> {
  const countById = new Map<string, number>()
  const sampleById = new Map<string, string>()
  for (const m of messages) {
    if (typeof m.sender_id !== 'number') continue
    const key = String(m.sender_id)
    countById.set(key, (countById.get(key) ?? 0) + 1)
    if (!sampleById.has(key)) {
      sampleById.set(key, (m.text ?? '').slice(0, 60))
    }
  }

  const reports: IdReport[] = []
  for (const id of ids) {
    const count = countById.get(id) ?? 0
    const sample = sampleById.get(id) ?? ''
    const resolved = nameMap.get(id)
    if (resolved !== undefined) {
      reports.push({
        sender_id: id,
        message_count: count,
        sample_text: sample,
        status: 'resolved',
        detail: resolved,
      })
      continue
    }
    const probe = await probeNTUser(id, binary)
    reports.push({
      sender_id: id,
      message_count: count,
      sample_text: sample,
      status: probe.error ? 'fallback_probe_failed' : 'fallback_absent',
      detail: probe.error ?? '',
    })
  }
  reports.sort((a, b) => b.message_count - a.message_count)
  return reports
}

interface ProbeResult {
  error?: string
}

async function probeNTUser(senderId: string, binary: string | undefined): Promise<ProbeResult> {
  const sql = `SELECT count(*) FROM NTUser WHERE userId = ${senderId}`
  const child = spawn(binary ?? 'kakaocli', ['query', sql], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8')
  })
  return new Promise<ProbeResult>((resolve) => {
    child.on('error', (e) => resolve({ error: e.message }))
    child.on('close', (code) => {
      if (code === 0) {
        resolve({})
      } else {
        resolve({ error: `kakaocli query exit ${code}: ${stderr.trim().slice(0, 120)}` })
      }
    })
  })
}

function printIdReports(out: NodeJS.WritableStream, reports: IdReport[]): void {
  out.write('=== sender_id 별 결과 ===\n')
  let resolvedCount = 0
  let absentCount = 0
  let probeFailedCount = 0

  for (const r of reports) {
    const tag =
      r.status === 'resolved'
        ? `\x1b[32m✓ RESOLVED\x1b[0m`
        : r.status === 'fallback_absent'
          ? `\x1b[33m✗ NTUser에 없음\x1b[0m`
          : `\x1b[31m✗ NTUser probe 실패\x1b[0m`
    out.write(
      `  ${tag}  id=${r.sender_id}  msgs=${r.message_count}  ` +
        (r.detail ? `→ ${r.detail}` : '') +
        (r.sample_text ? `\n     샘플: "${r.sample_text}"` : '') +
        '\n'
    )
    if (r.status === 'resolved') resolvedCount += 1
    else if (r.status === 'fallback_absent') absentCount += 1
    else probeFailedCount += 1
  }

  out.write('\n=== 요약 ===\n')
  out.write(`  resolved (NTUser JOIN 성공): ${resolvedCount}\n`)
  out.write(`  fallback (NTUser에 없음):    ${absentCount}\n`)
  out.write(`  probe 실패 (NTUser query):    ${probeFailedCount}\n`)

  if (absentCount > 0) {
    out.write('\n참여자_n 원인 후보:\n')
    out.write('  - 오픈채팅 비친구 멤버 (NTUser에 추가 안 됨)\n')
    out.write('  - 채팅방 탈퇴 후 NTUser purge\n')
    out.write('  - userId precision overflow (Number.MAX_SAFE_INTEGER 초과)\n')
    out.write('    → src/sender-resolver.ts 헤더 주석 참조\n')
  }
  if (probeFailedCount > 0) {
    out.write('\nprobe 실패 원인 후보:\n')
    out.write('  - kakaocli query 서브커맨드 미지원 (kakaocli 구버전)\n')
    out.write('  - Mac KakaoTalk DB 접근 권한 문제 (Full Disk Access 미허용)\n')
    out.write('  - kakaocli 바이너리 자체 부재\n')
  }
}
