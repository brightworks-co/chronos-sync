import type { ParseResult, ParseOptions } from './types.js';
export declare function parseExport(raw: string, opts?: ParseOptions): ParseResult;
export { parseKakaoExport } from './kakao.js';
export { parseMacCsv } from './csv.js';
