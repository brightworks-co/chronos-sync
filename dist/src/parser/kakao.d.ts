import type { ParseResult, ParseOptions } from './types.js';
export declare function toTimestampKst(date: string, time: string): number;
export declare function parseKakaoExport(raw: string, opts?: ParseOptions): ParseResult;
