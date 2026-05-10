import { describe, it, expect } from 'vitest'
import { parseAuthArgs } from '../../src/cli/auth-args'

const PAT = 'chr_pat_' + 'a'.repeat(32)

describe('parseAuthArgs', () => {
  it('returns empty options on empty argv', () => {
    const result = parseAuthArgs([])
    expect(result.kind).toBe('options')
    if (result.kind === 'options') {
      expect(result.options).toEqual({})
    }
  })

  it('parses --help', () => {
    expect(parseAuthArgs(['--help']).kind).toBe('help')
    expect(parseAuthArgs(['-h']).kind).toBe('help')
    // --help wins even mixed with other args
    expect(parseAuthArgs(['--reset', '--help']).kind).toBe('help')
  })

  it('parses positional <PAT> as token without warning flag', () => {
    const r = parseAuthArgs([PAT])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.token).toBe(PAT)
    expect(r.options.tokenWasFlag).toBe(false)
  })

  it('parses --token <PAT> with tokenWasFlag=true', () => {
    const r = parseAuthArgs(['--token', PAT])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.token).toBe(PAT)
    expect(r.options.tokenWasFlag).toBe(true)
  })

  it('parses --token=<PAT> form', () => {
    const r = parseAuthArgs([`--token=${PAT}`])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.token).toBe(PAT)
    expect(r.options.tokenWasFlag).toBe(true)
  })

  it('parses --from-stdin', () => {
    const r = parseAuthArgs(['--from-stdin'])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.fromStdin).toBe(true)
  })

  it('parses --server-url <url>', () => {
    const r = parseAuthArgs(['--server-url', 'https://staging.example.test'])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.serverUrl).toBe('https://staging.example.test')
  })

  it('parses --server-url=<url>', () => {
    const r = parseAuthArgs(['--server-url=https://staging.example.test'])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.serverUrl).toBe('https://staging.example.test')
  })

  it('parses --allow-file-pat', () => {
    const r = parseAuthArgs(['--allow-file-pat'])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.allowFilePat).toBe(true)
  })

  it('parses --reset', () => {
    const r = parseAuthArgs(['--reset'])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options.reset).toBe(true)
  })

  it('combines flags: --reset --allow-file-pat --server-url x --token PAT', () => {
    const r = parseAuthArgs(['--reset', '--allow-file-pat', '--server-url', 'https://x', '--token', PAT])
    expect(r.kind).toBe('options')
    if (r.kind !== 'options') return
    expect(r.options).toEqual({
      reset: true,
      allowFilePat: true,
      serverUrl: 'https://x',
      token: PAT,
      tokenWasFlag: true,
    })
  })

  it('rejects unknown flag', () => {
    const r = parseAuthArgs(['--no-such-flag'])
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') {
      expect(r.message).toMatch(/unknown auth option/)
    }
  })

  it('rejects --token without a value', () => {
    expect(parseAuthArgs(['--token']).kind).toBe('invalid')
    expect(parseAuthArgs(['--token', '--reset']).kind).toBe('invalid')
  })

  it('rejects --server-url without a value', () => {
    expect(parseAuthArgs(['--server-url']).kind).toBe('invalid')
    expect(parseAuthArgs(['--server-url', '--reset']).kind).toBe('invalid')
  })

  it('rejects positional + --token combo', () => {
    const r = parseAuthArgs([PAT, '--token', PAT])
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') {
      expect(r.message).toMatch(/cannot combine positional/)
    }
  })

  it('rejects --from-stdin combined with token', () => {
    const r = parseAuthArgs(['--from-stdin', PAT])
    expect(r.kind).toBe('invalid')
  })

  it('rejects two positional args', () => {
    const r = parseAuthArgs([PAT, 'extra'])
    expect(r.kind).toBe('invalid')
  })
})
