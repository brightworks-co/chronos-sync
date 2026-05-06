import type { ParsedMessage, ParseResult, ParseOptions } from './types.js'
import { toTimestampKst } from './kakao.js'
import { normalizeSender, normalizeContent, classifyMessage } from './normalize.js'

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Minimal RFC-4180 CSV parser (state machine).
 * Returns array of rows, each row is array of field strings.
 * Handles: quoted fields, embedded commas, embedded newlines, escaped quotes ("").
 */
function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = []
  const fields: string[] = []
  let field = ''
  let inQuote = false
  let i = 0

  const flush = () => {
    fields.push(field)
    field = ''
  }

  const endRow = () => {
    flush()
    if (fields.length > 0) {
      rows.push([...fields])
    }
    fields.length = 0
  }

  while (i < raw.length) {
    const ch = raw[i]

    if (inQuote) {
      if (ch === '"') {
        // Peek next
        if (i + 1 < raw.length && raw[i + 1] === '"') {
          // Escaped quote ""
          field += '"'
          i += 2
        } else {
          // End of quoted field
          inQuote = false
          i += 1
        }
      } else {
        field += ch
        i += 1
      }
    } else {
      if (ch === '"') {
        inQuote = true
        i += 1
      } else if (ch === ',') {
        flush()
        i += 1
      } else if (ch === '\r') {
        // \r\n or lone \r
        endRow()
        i += 1
        if (i < raw.length && raw[i] === '\n') i += 1
      } else if (ch === '\n') {
        endRow()
        i += 1
      } else {
        field += ch
        i += 1
      }
    }
  }

  // Flush last field/row (no trailing newline)
  if (field.length > 0 || fields.length > 0) {
    endRow()
  }

  return rows
}

export function parseMacCsv(raw: string, opts: ParseOptions = {}): ParseResult {
  // Strip BOM
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  const rows = parseCsvRows(text)

  if (rows.length === 0) {
    return {
      room_name: '',
      kakao_original_name: '',
      exported_at: '',
      messages: [],
      header_variant: 'mac-csv',
      header_raw: { line1: '', line2: '' },
      error: 'Empty CSV',
    }
  }

  const headerRow = rows[0]
  const header_raw = {
    line1: headerRow.join(','),
    line2: rows[1]?.join(',') ?? '',
  }

  // Validate header (allow surrounding whitespace per dispatcher's lenient sniff)
  if (
    !headerRow[0]?.trim().match(/^Date$/i) ||
    !headerRow[1]?.trim().match(/^User$/i) ||
    !headerRow[2]?.trim().match(/^Message$/i)
  ) {
    return {
      room_name: '',
      kakao_original_name: '',
      exported_at: '',
      messages: [],
      header_variant: 'unknown',
      header_raw,
      error: 'Unknown header format',
    }
  }

  const messages: ParsedMessage[] = []
  let lastMinuteKey: string | null = null
  let sequenceInMinute = 0

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]
    if (!row || row.length < 3) continue

    const rawDate = row[0]?.trim() ?? ''
    const rawUser = row[1]?.trim() ?? ''
    const rawMessage = row[2] ?? ''

    // Determine date/time
    let date = ''
    let time = ''
    let datetime = ''
    let timestamp = 0

    if (rawDate) {
      // Format: YYYY-MM-DD HH:MM:SS
      const m = rawDate.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})/)
      if (m) {
        date = m[1]
        time = `${m[2]}:${m[3]}`
        datetime = `${date} ${time}`
        timestamp = toTimestampKst(date, time)
      }
    }

    // sequence_in_minute
    const minuteKey = date && time ? `${date}|${time}` : null
    if (minuteKey) {
      if (minuteKey !== lastMinuteKey) {
        sequenceInMinute = 0
        lastMinuteKey = minuteKey
      } else {
        sequenceInMinute += 1
      }
    }

    const senderRaw = rawUser
    const senderNormalized = rawUser ? normalizeSender(rawUser) : ''
    const content = normalizeContent(rawMessage)
    const kind = classifyMessage(content, senderRaw)

    messages.push({
      date,
      time,
      datetime,
      timestamp,
      sequence_in_minute: minuteKey ? sequenceInMinute : 0,
      sender_raw: senderRaw,
      sender_normalized: senderNormalized,
      text: content,
      kind,
    })
  }

  return {
    room_name: '',
    kakao_original_name: '',
    exported_at: '',
    messages,
    header_variant: 'mac-csv',
    header_raw,
  }
}
