import { collapseWhitespace } from './normalize.js'

type MessageIdInput = {
  project_id: string
  room_name: string
  datetime: string
  sequence_in_minute: number
  text: string
}

type ContentHashInput = {
  datetime: string
  room_name: string
  text: string
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToUuid(hex: string): string {
  const h = hex.slice(0, 32)
  const v = (parseInt(h[12], 16) & 0x3) | 0x4
  const r = (parseInt(h[16], 16) & 0x3) | 0x8
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `${v.toString(16)}${h.slice(13, 16)}`,
    `${r.toString(16)}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-')
}

export async function messageId(input: MessageIdInput): Promise<string> {
  const key = [
    input.project_id,
    input.room_name,
    input.datetime,
    String(input.sequence_in_minute),
    input.text,
  ].join('|')
  return hexToUuid(await sha256Hex(key))
}

export async function contentHash(input: ContentHashInput): Promise<string> {
  const normalized = collapseWhitespace(input.text)
  const key = [input.datetime, input.room_name, normalized].join('|')
  return (await sha256Hex(key)).slice(0, 16)
}
