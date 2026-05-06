import { describe, it, expect } from 'vitest'
import { parseQueryRows } from '../src/sender-resolver'

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
      [42, '핑님'],
      [99, '새싹간호사(H)'],
      [12345, '호랑아밥먹어(E)'],
    ])
    const map = parseQueryRows(stdout)
    expect(map.size).toBe(3)
    expect(map.get('42')).toBe('핑님')
    expect(map.get('99')).toBe('새싹간호사(H)')
    expect(map.get('12345')).toBe('호랑아밥먹어(E)')
  })

  it('keys by String(numericId) — both sides observe the same JS-rounded value', () => {
    // KakaoTalk userIds beyond 2^53 lose precision when JSON.parse hits
    // a bare number literal. The map's keys mirror that lossy value;
    // this is acceptable because kakaocli's `messages --json` output
    // suffers the identical rounding, so callers always look up under
    // the same key. We simulate that real-world shape here.
    const id = Number(5283788016742773350) // already 5283788016742774000
    const stdout = `[[${id}, "핑님"]]`
    const map = parseQueryRows(stdout)
    expect(map.get(String(id))).toBe('핑님')
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
