import { describe, it, expect } from 'vitest'
import { reassembleMacCsv } from '../src/csv-reassemble'
import { parseMacCsv } from '../src/parser/csv'

function msg(overrides: Partial<Parameters<typeof reassembleMacCsv>[0][number]>) {
  return {
    chat_id: 12345,
    id: 1,
    sender: '홍길동',
    sender_id: 99,
    text: '안녕',
    timestamp: Date.UTC(2026, 3, 26, 0, 0, 0),
    is_from_me: false,
    type: 'text',
    ...overrides,
  }
}

describe('reassembleMacCsv', () => {
  it('emits the canonical Mac CSV header on the first line', () => {
    const csv = reassembleMacCsv([])
    expect(csv.startsWith('Date,User,Message\n')).toBe(true)
  })

  it('formats timestamps as KST YYYY-MM-DD HH:MM:SS', () => {
    const utcMs = Date.UTC(2026, 3, 25, 22, 13, 31)
    const csv = reassembleMacCsv([msg({ timestamp: utcMs })])
    expect(csv).toContain('2026-04-26 07:13:31')
  })

  it('quotes fields containing commas, quotes, or newlines', () => {
    const csv = reassembleMacCsv([
      msg({ text: 'hello, "world"\nsecond line' }),
    ])
    expect(csv).toContain('"hello, ""world""\nsecond line"')
  })

  it('round-trips through parseMacCsv with kind correctly classified', () => {
    const csv = reassembleMacCsv([
      msg({ id: 1, sender: '홍길동', text: '안녕' }),
      msg({
        id: 2,
        sender: '5동 1006호',
        text: '사진',
        timestamp: Date.UTC(2026, 3, 26, 0, 1, 0),
      }),
      msg({
        id: 3,
        sender: '7동 1504호 제니',
        text: '7동 1504호 제니님이 나갔습니다.',
        timestamp: Date.UTC(2026, 3, 26, 0, 2, 0),
      }),
    ])

    const parsed = parseMacCsv(csv)
    expect(parsed.header_variant).toBe('mac-csv')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0].kind).toBe('text')
    expect(parsed.messages[1].kind).toBe('media')
    expect(parsed.messages[2].kind).toBe('announcement')
  })

  it('preserves multi-line message bodies through CSV quoting', () => {
    const csv = reassembleMacCsv([
      msg({ text: 'line one\nline two\nline three' }),
    ])
    const parsed = parseMacCsv(csv)
    expect(parsed.messages[0].text).toBe('line one\nline two\nline three')
  })

  it('accepts ISO-8601 timestamps as well as epoch ms', () => {
    const csv = reassembleMacCsv([
      msg({ timestamp: '2026-04-26T00:00:00.000Z' }),
    ])
    expect(csv).toContain('2026-04-26 09:00:00')
  })

  it('throws on invalid timestamp', () => {
    expect(() =>
      reassembleMacCsv([msg({ timestamp: 'not-a-date' })])
    ).toThrow(/Invalid timestamp/)
  })

  it('uses the v0.6.0 sender/text fields verbatim', () => {
    const csv = reassembleMacCsv([
      msg({ sender: '카카오봇', text: '오픈채팅 메시지' }),
    ])
    expect(csv).toContain('"카카오봇"')
    expect(csv).toContain('"오픈채팅 메시지"')
  })

  it('rewrites feedType system-event payloads to localized placeholders', () => {
    const csv = reassembleMacCsv([
      msg({
        id: 1,
        sender: '드림솔져(헬)',
        text: '{"feedType":25,"logId":3835554415426912257,"hidden":true,"targetRevision":1}',
      }),
      msg({
        id: 2,
        sender: '시스템',
        text: '{"feedType":4,"members":[{"userId":6321186593654462422,"nickName":"드림솔져"}]}',
        timestamp: Date.UTC(2026, 3, 26, 0, 1, 0),
      }),
    ])
    const parsed = parseMacCsv(csv)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].text).toBe('삭제된 메시지')
    expect(parsed.messages[0].kind).toBe('deleted')
    expect(parsed.messages[1].text).toBe('드림솔져님이 들어왔습니다')
    expect(parsed.messages[1].kind).toBe('announcement')
    // Raw JSON must not leak into the CSV
    expect(csv).not.toContain('feedType')
  })
})
