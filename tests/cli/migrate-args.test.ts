import { describe, it, expect } from 'vitest'
import { parseMigrateArgs } from '../../src/cli/migrate-args'

describe('parseMigrateArgs', () => {
  it('returns empty options on empty argv', () => {
    const r = parseMigrateArgs([])
    expect(r.kind).toBe('options')
    if (r.kind === 'options') expect(r.options).toEqual({})
  })

  it('parses --help / -h', () => {
    expect(parseMigrateArgs(['--help']).kind).toBe('help')
    expect(parseMigrateArgs(['-h']).kind).toBe('help')
    expect(parseMigrateArgs(['--dry-run', '--help']).kind).toBe('help')
  })

  it('parses --dry-run, --force, --allow-file-pat', () => {
    const r = parseMigrateArgs(['--dry-run', '--force', '--allow-file-pat'])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.dryRun).toBe(true)
    expect(r.options.force).toBe(true)
    expect(r.options.allowFilePat).toBe(true)
  })

  it('parses --server-url <url> and --server-url=<url>', () => {
    expect(
      (parseMigrateArgs(['--server-url', 'https://x']) as { options: { serverUrl: string } }).options.serverUrl
    ).toBe('https://x')
    expect(
      (parseMigrateArgs(['--server-url=https://y']) as { options: { serverUrl: string } }).options.serverUrl
    ).toBe('https://y')
  })

  it('rejects --server-url without a value', () => {
    expect(parseMigrateArgs(['--server-url']).kind).toBe('invalid')
    expect(parseMigrateArgs(['--server-url', '--dry-run']).kind).toBe('invalid')
  })

  it('rejects positional args', () => {
    const r = parseMigrateArgs(['extra'])
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') expect(r.message).toMatch(/positional/)
  })

  it('rejects unknown flags', () => {
    const r = parseMigrateArgs(['--no-such-flag'])
    expect(r.kind).toBe('invalid')
  })
})
