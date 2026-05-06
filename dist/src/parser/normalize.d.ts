export declare function normalizeSender(raw: string): string;
export declare function normalizeContent(raw: string): string;
export declare function collapseWhitespace(s: string): string;
export declare function isSystemSender(text: string): boolean;
export declare function isMediaContent(text: string): boolean;
import type { MessageKind } from './types.js';
export declare function classifyMessage(content: string, _sender: string): MessageKind;
