import { parseKakaoExport } from './kakao.js'
import { parseMacCsv } from './csv.js'
import type { ParseResult, ParseOptions } from './types.js'

export function parseExport(raw: string, opts: ParseOptions = {}): ParseResult {
  const trimmed = raw.replace(/^﻿/, '').trimStart()
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ''
  if (/^Date\s*,\s*User\s*,\s*Message/i.test(firstLine)) {
    return parseMacCsv(raw, opts)
  }
  return parseKakaoExport(raw, opts)
}

export { parseKakaoExport } from './kakao.js'
export { parseMacCsv } from './csv.js'
