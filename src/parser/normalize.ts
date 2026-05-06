const SYSTEM_KEYWORDS = [
  '님이 들어왔습니다',
  '님이 나갔습니다',
  '님을 초대했습니다',
  '님을 내보냈습니다',
  '불법촬영물 식별',
  '운영정책을 위반',
  '동영상 또는 압축파일',
]

const ANNOUNCEMENT_KEYWORDS = [
  '님이 들어왔습니다',
  '님이 나갔습니다',
  '님을 초대했습니다',
  '님을 내보냈습니다',
]

const DELETED_RE = /^삭제된\s*메시지|메시지가\s*삭제되었습니다/

const MEDIA_KEYWORDS = [
  '사진',
  '동영상',
  '파일',
  '이모티콘',
  '연락처',
  '지도',
  '음성메시지',
  '음악',
]

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g
const MULTI_WS = /\s+/g

export function normalizeSender(raw: string): string {
  if (!raw) return ''
  let s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1)
  }
  s = s.replace(ZERO_WIDTH, '')
  s = s.replace(/\s+/g, '')
  s = s.replace(/\|\|/g, '__')
  s = s.normalize('NFC')
  return s
}

export function normalizeContent(raw: string): string {
  if (!raw) return ''
  return raw.replace(ZERO_WIDTH, '').normalize('NFC').trim()
}

export function collapseWhitespace(s: string): string {
  return s.replace(MULTI_WS, ' ').trim()
}

export function isSystemSender(text: string): boolean {
  return SYSTEM_KEYWORDS.some((kw) => text.includes(kw))
}

export function isMediaContent(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  return MEDIA_KEYWORDS.includes(trimmed)
}

import type { MessageKind } from './types.js'

export function classifyMessage(content: string, _sender: string): MessageKind {
  if (isSystemSender(content)) {
    return ANNOUNCEMENT_KEYWORDS.some((kw) => content.includes(kw)) ? 'announcement' : 'system'
  }
  if (DELETED_RE.test(content)) return 'deleted'
  if (isMediaContent(content)) return 'media'
  return 'text'
}
