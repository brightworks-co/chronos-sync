import { describe, it, expect } from 'vitest'
import {
  isFeedTypeText,
  parseFeedTypeText,
  feedTypeToPlaceholder,
  transformFeedTypeText,
} from '../../src/parser/feedtype'

describe('isFeedTypeText', () => {
  it('matches the canonical feedType prefix', () => {
    expect(isFeedTypeText('{"feedType":25,"hidden":true}')).toBe(true)
    expect(isFeedTypeText('  { "feedType" : 4 }')).toBe(true)
  })

  it('rejects normal user messages', () => {
    expect(isFeedTypeText('안녕하세요')).toBe(false)
    expect(isFeedTypeText('')).toBe(false)
    expect(isFeedTypeText('{"text":"feedType is just a word"}')).toBe(false)
  })
})

describe('parseFeedTypeText', () => {
  it('returns the parsed payload for valid feedType JSON', () => {
    const text = '{"feedType":25,"logId":3835554415426912257,"hidden":true,"targetRevision":1}'
    const payload = parseFeedTypeText(text)
    expect(payload).not.toBeNull()
    expect(payload?.feedType).toBe(25)
    expect(payload?.hidden).toBe(true)
  })

  it('preserves nested member arrays', () => {
    const text =
      '{"feedType":4,"members":[{"userId":6321186593654462422,"nickName":"드림솔져"}]}'
    const payload = parseFeedTypeText(text)
    expect(payload?.feedType).toBe(4)
    expect(payload?.members?.[0]?.nickName).toBe('드림솔져')
  })

  it('returns null for non-JSON text', () => {
    expect(parseFeedTypeText('hello world')).toBeNull()
  })

  it('returns null for malformed JSON that starts with the hint', () => {
    expect(parseFeedTypeText('{"feedType":25, oops')).toBeNull()
  })

  it('returns null when feedType is missing or non-numeric', () => {
    expect(parseFeedTypeText('{"feedType":"25"}')).toBeNull()
    expect(parseFeedTypeText('{"feedType":null}')).toBeNull()
  })
})

describe('feedTypeToPlaceholder', () => {
  it('renders feedType=25 as "삭제된 메시지" so classifyMessage maps it to kind=deleted', () => {
    expect(feedTypeToPlaceholder({ feedType: 25, hidden: true })).toBe('삭제된 메시지')
  })

  it('renders feedType=4 with nickName as a join announcement', () => {
    expect(
      feedTypeToPlaceholder({
        feedType: 4,
        members: [{ userId: 1, nickName: '드림솔져' }],
      })
    ).toBe('드림솔져님이 들어왔습니다')
  })

  it('falls back to "멤버" when feedType=4 has no nickName', () => {
    expect(feedTypeToPlaceholder({ feedType: 4 })).toBe('멤버님이 들어왔습니다')
    expect(
      feedTypeToPlaceholder({ feedType: 4, members: [{ userId: 1 }] })
    ).toBe('멤버님이 들어왔습니다')
  })

  it('renders feedType=11 as the voice/video call placeholder', () => {
    expect(feedTypeToPlaceholder({ feedType: 11 })).toBe('[보이스톡]')
  })

  it('renders feedType=1 / feedType=2 as enter/leave placeholders', () => {
    expect(feedTypeToPlaceholder({ feedType: 1 })).toBe('[채팅방 입장]')
    expect(feedTypeToPlaceholder({ feedType: 2 })).toBe('[채팅방 퇴장]')
  })

  it('renders unknown feedType as a generic system event placeholder', () => {
    expect(feedTypeToPlaceholder({ feedType: 99 })).toBe('[시스템 이벤트:99]')
    expect(feedTypeToPlaceholder({ feedType: 26 })).toBe('[시스템 이벤트:26]')
  })
})

describe('transformFeedTypeText', () => {
  it('converts a feedType payload to its placeholder', () => {
    const raw = '{"feedType":25,"logId":3835554415426912257,"hidden":true,"targetRevision":1}'
    expect(transformFeedTypeText(raw)).toBe('삭제된 메시지')
  })

  it('passes regular user text through unchanged', () => {
    expect(transformFeedTypeText('갤리로 꽉꽉 채워갑니다')).toBe('갤리로 꽉꽉 채워갑니다')
    expect(transformFeedTypeText('')).toBe('')
  })

  it('passes malformed feedType-like JSON through unchanged', () => {
    expect(transformFeedTypeText('{"feedType":25, oops')).toBe('{"feedType":25, oops')
  })
})
