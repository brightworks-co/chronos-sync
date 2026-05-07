import { describe, it, expect } from 'vitest'
import { parseHarvestArgs } from '../../src/cli/harvest'

describe('parseHarvestArgs', () => {
  it('returns empty options when no args', () => {
    expect(parseHarvestArgs([])).toEqual({})
  })

  it('parses --top as a non-negative integer', () => {
    expect(parseHarvestArgs(['--top', '10'])).toEqual({ top: 10 })
    expect(parseHarvestArgs(['--top', '5.7'])).toEqual({ top: 5 }) // floored
  })

  it('parses --max-clicks as a non-negative integer', () => {
    expect(parseHarvestArgs(['--max-clicks', '3'])).toEqual({ maxClicks: 3 })
  })

  it('parses --scroll-delay as a float', () => {
    expect(parseHarvestArgs(['--scroll-delay', '1.5'])).toEqual({ scrollDelay: 1.5 })
  })

  it('parses --dry-run as a boolean flag', () => {
    expect(parseHarvestArgs(['--dry-run'])).toEqual({ dryRun: true })
  })

  it('combines multiple flags', () => {
    expect(
      parseHarvestArgs(['--top', '8', '--max-clicks', '2', '--scroll-delay', '2', '--dry-run'])
    ).toEqual({ top: 8, maxClicks: 2, scrollDelay: 2, dryRun: true })
  })

  it('throws on negative values', () => {
    expect(() => parseHarvestArgs(['--top', '-1'])).toThrow(/non-negative/)
    expect(() => parseHarvestArgs(['--max-clicks', '-3'])).toThrow(/non-negative/)
    expect(() => parseHarvestArgs(['--scroll-delay', '-0.1'])).toThrow(/non-negative/)
  })

  it('throws on non-numeric values', () => {
    expect(() => parseHarvestArgs(['--top', 'abc'])).toThrow(/non-negative/)
  })

  it('throws on unknown flags', () => {
    expect(() => parseHarvestArgs(['--unknown'])).toThrow(/알 수 없는 옵션/)
  })
})
