import { describe, it, expect } from 'vitest'
import { parseMacCsv } from '../../src/parser/csv'

describe('parseMacCsv — date formats and empty-text handling', () => {
  it('parses dotted variable-width Mac KakaoTalk export dates (e.g. `2026.5.5 0:02`)', () => {
    const raw = [
      'Date,User,Message',
      '2026.5.5 0:02,김영희,크으',
      '2026.5.5 0:02,김영희,참가자D는 찐 요리사!',
      '2026.5.5 22:15,참가자A(H),밤 인사',
      '2026.10.7 9:30,참가자B(A),아침 인사',
    ].join('\n')

    const result = parseMacCsv(raw)
    expect(result.header_variant).toBe('mac-csv')
    expect(result.messages.length).toBe(4)
    // Zero-padded canonical form everywhere downstream.
    expect(result.messages[0].date).toBe('2026-05-05')
    expect(result.messages[0].time).toBe('00:02')
    expect(result.messages[0].datetime).toBe('2026-05-05 00:02')
    expect(result.messages[2].time).toBe('22:15')
    expect(result.messages[3].date).toBe('2026-10-07')
    expect(result.messages[3].time).toBe('09:30')
    // sequence_in_minute still works after the new format.
    expect(result.messages[0].sequence_in_minute).toBe(0)
    expect(result.messages[1].sequence_in_minute).toBe(1)
    expect(result.messages[2].sequence_in_minute).toBe(0)
  })

  it('still parses the legacy zero-padded dashed format (backward compat with reassembled CSVs from kakaocli)', () => {
    const raw = [
      'Date,User,Message',
      '2026-05-05 10:14:00,김철수,아침',
      '2026-05-05 10:14:30,김철수,또 아침',
    ].join('\n')

    const result = parseMacCsv(raw)
    expect(result.messages.length).toBe(2)
    expect(result.messages[0].date).toBe('2026-05-05')
    expect(result.messages[0].time).toBe('10:14')
    expect(result.messages[1].sequence_in_minute).toBe(1)
  })

  it('skips rows whose Message column is blank (이모티콘 / 사진 / 음성 등)', () => {
    // The daemon's csv-reassemble emits the same blank for kakaocli
    // type='unknown' + text='' rows, so dropping them in the parser
    // keeps daemon path and manual upload path consistent — no ghost
    // rows in the viewer, and messageId dedup stays stable across
    // re-uploads.
    const raw = [
      'Date,User,Message',
      '2026.5.5 10:14,홍길동,텍스트 메시지',
      '2026.5.5 10:14,홍길동,', // 이모티콘 / 사진 / 음성 등
      '2026.5.5 10:14,홍길동,또 다른 텍스트',
      '2026.5.5 10:15,홍길동,',
    ].join('\n')

    const result = parseMacCsv(raw)
    expect(result.messages.length).toBe(2)
    expect(result.messages[0].text).toBe('텍스트 메시지')
    expect(result.messages[1].text).toBe('또 다른 텍스트')
    // sequence_in_minute counts only kept rows.
    expect(result.messages[0].sequence_in_minute).toBe(0)
    expect(result.messages[1].sequence_in_minute).toBe(1)
  })
})
