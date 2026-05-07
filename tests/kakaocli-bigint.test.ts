import { describe, it, expect } from 'vitest'
import { preserveBigIntPrecision } from '../src/kakaocli'

describe('preserveBigIntPrecision', () => {
  it('quotes 19-digit sender_id so JSON.parse keeps the exact value', () => {
    // Real-world value from chat_id 18296430865364356 (`dho` open chat).
    // Without preservation, JSON.parse rounds the trailing digits to 0:
    //   8181328792600516744 → 8181328792600517000
    const raw = '[{"sender_id": 8181328792600516744, "text": "hi"}]'
    const safe = preserveBigIntPrecision(raw)
    const parsed = JSON.parse(safe)
    expect(parsed[0].sender_id).toBe('8181328792600516744')
    // And the value survives toString round-trip — the SQL resolver's
    // sanitizeIds requires this digit-exact form.
    expect(String(parsed[0].sender_id)).toBe('8181328792600516744')
  })

  it('quotes chat_id, id, logId, userId fields too (all share the BigInt risk)', () => {
    const raw =
      '{"chat_id": 18296430865364356, "id": 1234567890123456789, ' +
      '"logId": 9876543210987654321, "userId": 5237539945804374099}'
    const safe = preserveBigIntPrecision(raw)
    const parsed = JSON.parse(safe)
    expect(parsed.chat_id).toBe('18296430865364356')
    expect(parsed.id).toBe('1234567890123456789')
    expect(parsed.logId).toBe('9876543210987654321')
    expect(parsed.userId).toBe('5237539945804374099')
  })

  it('leaves shorter numeric values alone (15 digits and below stay as numbers)', () => {
    // 15 digits is well within Number.MAX_SAFE_INTEGER (≈ 9e15).
    const raw = '{"sender_id": 123456789012345, "is_from_me": true}'
    const safe = preserveBigIntPrecision(raw)
    const parsed = JSON.parse(safe)
    expect(parsed.sender_id).toBe(123456789012345)
    expect(typeof parsed.sender_id).toBe('number')
    expect(parsed.is_from_me).toBe(true)
  })

  it('does not touch unrelated keys with similar names', () => {
    // `timestamp` is also numeric but is fine as a JS number for ms
    // epoch — we leave it alone so downstream code keeps doing math.
    const raw = '{"timestamp": 1778078257669, "text": "hi"}'
    const safe = preserveBigIntPrecision(raw)
    expect(safe).toBe(raw)
  })

  it('handles whitespace around the colon and the value', () => {
    const raw = '{"sender_id"  :   18296430865364356}'
    const safe = preserveBigIntPrecision(raw)
    const parsed = JSON.parse(safe)
    expect(parsed.sender_id).toBe('18296430865364356')
  })

  it('preserves strings that already are strings (idempotent)', () => {
    const raw = '{"sender_id": "8181328792600516744"}'
    const safe = preserveBigIntPrecision(raw)
    expect(safe).toBe(raw)
    const parsed = JSON.parse(safe)
    expect(parsed.sender_id).toBe('8181328792600516744')
  })
})
