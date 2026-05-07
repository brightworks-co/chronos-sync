import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { append } from '../src/notifications'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chronos-notifications-test-'))
  process.env['CHRONOS_NOTIFICATIONS_PATH'] = path.join(tmpDir, 'notifications.jsonl')
})

afterEach(async () => {
  delete process.env['CHRONOS_NOTIFICATIONS_PATH']
  await fs.promises.rm(tmpDir, { recursive: true, force: true })
})

function readLines(): NotificationLine[] {
  const filePath = process.env['CHRONOS_NOTIFICATIONS_PATH']!
  const raw = fs.readFileSync(filePath, 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as NotificationLine)
}

interface NotificationLine {
  ts: number
  level: string
  msg: string
  ctx?: Record<string, unknown>
}

describe('notifications.append', () => {
  it('writes a single JSONL line with ts, level, msg', async () => {
    await append({ level: 'info', msg: 'test message' })
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('info')
    expect(lines[0].msg).toBe('test message')
    expect(typeof lines[0].ts).toBe('number')
    expect(lines[0].ts).toBeGreaterThan(0)
  })

  it('writes ctx when provided', async () => {
    await append({ level: 'warn', msg: 'harvest failed', ctx: { room: 'dho', code: 64 } })
    const lines = readLines()
    expect(lines[0].ctx).toEqual({ room: 'dho', code: 64 })
  })

  it('omits ctx key when ctx is not provided', async () => {
    await append({ level: 'info', msg: 'no ctx' })
    const lines = readLines()
    expect('ctx' in lines[0]).toBe(false)
  })

  it('supports error_user_actionable level', async () => {
    await append({ level: 'error_user_actionable', msg: 'stuck room', ctx: { room: 'dho' } })
    const lines = readLines()
    expect(lines[0].level).toBe('error_user_actionable')
  })

  it('appends multiple records as separate JSONL lines', async () => {
    await append({ level: 'info', msg: 'first' })
    await append({ level: 'warn', msg: 'second' })
    await append({ level: 'error_user_actionable', msg: 'third' })
    const lines = readLines()
    expect(lines).toHaveLength(3)
    expect(lines[0].msg).toBe('first')
    expect(lines[1].msg).toBe('second')
    expect(lines[2].msg).toBe('third')
  })

  it('creates parent directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'notifications.jsonl')
    process.env['CHRONOS_NOTIFICATIONS_PATH'] = nested
    await append({ level: 'info', msg: 'nested dir test' })
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('resolves successfully even when write fails (best-effort)', async () => {
    // Point to a path where the directory is actually a file (unwritable)
    const blockingFile = path.join(tmpDir, 'blocker')
    fs.writeFileSync(blockingFile, 'not a dir')
    process.env['CHRONOS_NOTIFICATIONS_PATH'] = path.join(blockingFile, 'notifications.jsonl')

    // Should resolve without throwing
    await expect(append({ level: 'warn', msg: 'will fail' })).resolves.toBeUndefined()
  })

  it('ts is set to approximately now', async () => {
    const before = Date.now()
    await append({ level: 'info', msg: 'timing test' })
    const after = Date.now()
    const lines = readLines()
    expect(lines[0].ts).toBeGreaterThanOrEqual(before)
    expect(lines[0].ts).toBeLessThanOrEqual(after)
  })
})
