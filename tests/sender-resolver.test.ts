import { describe, it, expect } from 'vitest'
import { parseQueryRows, buildResolverSql } from '../src/sender-resolver'

describe('parseQueryRows', () => {
  it('returns an empty map for an empty stdout', () => {
    expect(parseQueryRows('')).toEqual(new Map())
    expect(parseQueryRows('   \n  ')).toEqual(new Map())
  })

  it('returns an empty map when JSON is malformed', () => {
    expect(parseQueryRows('not json')).toEqual(new Map())
  })

  it('parses 2-D array of [userId, name] tuples (within safe-integer range)', () => {
    const stdout = JSON.stringify([
      [42, '이몽룡'],
      [99, '참가자A(H)'],
      [12345, '참가자B(E)'],
    ])
    const map = parseQueryRows(stdout)
    expect(map.size).toBe(3)
    expect(map.get('42')).toBe('이몽룡')
    expect(map.get('99')).toBe('참가자A(H)')
    expect(map.get('12345')).toBe('참가자B(E)')
  })

  it('keys by String(numericId) — both sides observe the same JS-rounded value', () => {
    // KakaoTalk userIds beyond 2^53 lose precision when JSON.parse hits
    // a bare number literal. The map's keys mirror that lossy value;
    // this is acceptable because kakaocli's `messages --json` output
    // suffers the identical rounding, so callers always look up under
    // the same key. We simulate that real-world shape here.
    const id = Number(5283788016742773350) // already 5283788016742774000
    const stdout = `[[${id}, "이몽룡"]]`
    const map = parseQueryRows(stdout)
    expect(map.get(String(id))).toBe('이몽룡')
  })

  it('accepts userId as a string and preserves precision', () => {
    const stdout = JSON.stringify([['9007199254740993', '큰id']])
    const map = parseQueryRows(stdout)
    expect(map.get('9007199254740993')).toBe('큰id')
  })

  it('drops rows without a name or with non-string name', () => {
    const stdout = JSON.stringify([
      [1, ''],
      [2, null],
      [3, '정상'],
    ])
    const map = parseQueryRows(stdout)
    expect(map.size).toBe(1)
    expect(map.get('3')).toBe('정상')
  })

  it('drops rows with malformed userId column', () => {
    const stdout = JSON.stringify([
      ['not-a-number', '잘못'],
      [42, '맞음'],
    ])
    const map = parseQueryRows(stdout)
    expect(map.size).toBe(1)
    expect(map.get('42')).toBe('맞음')
  })
})

describe('buildResolverSql', () => {
  it('wraps every name candidate in NULLIF so empty strings are treated as missing', () => {
    // Regression guard: open-chat NTMultiProfile rows often store an
    // empty string in `displayName`. Plain COALESCE would pick that
    // empty string as the first non-NULL value, forcing the
    // `참여자_<id>` fallback even when `nickName` has a real nickname.
    const sql = buildResolverSql('1,2,3')
    expect(sql).toContain("NULLIF(mp.displayName, '')")
    expect(sql).toContain("NULLIF(u.friendNickName, '')")
    expect(sql).toContain("NULLIF(u.nickName, '')")
    expect(sql).toContain("NULLIF(u.displayName, '')")
  })

  it('joins NTMultiProfile on (userId, linkId) so open-chat profiles override friend nicknames', () => {
    const sql = buildResolverSql('42')
    expect(sql).toContain('FROM NTUser u')
    expect(sql).toContain(
      'LEFT JOIN NTMultiProfile mp ON mp.userId = u.userId AND mp.linkId = u.linkId'
    )
  })

  it('substitutes the IN clause verbatim', () => {
    const sql = buildResolverSql('1,2,3')
    expect(sql).toContain('IN (1,2,3)')
  })

  it('orders the COALESCE candidates so multi-profile (open-chat) wins over friendNickName, nickName, then displayName', () => {
    const sql = buildResolverSql('1')
    const mpIdx = sql.indexOf("NULLIF(mp.displayName, '')")
    const friendIdx = sql.indexOf("NULLIF(u.friendNickName, '')")
    const nickIdx = sql.indexOf("NULLIF(u.nickName, '')")
    const displayIdx = sql.indexOf("NULLIF(u.displayName, '')")
    expect(mpIdx).toBeGreaterThan(-1)
    expect(mpIdx).toBeLessThan(friendIdx)
    expect(friendIdx).toBeLessThan(nickIdx)
    expect(nickIdx).toBeLessThan(displayIdx)
  })
})
