/**
 * Argv parsing for `chronos-sync auth`.
 *
 * Lives in `src/cli/` rather than inline in `bin/chronos-sync.ts` because
 * the bin file is a tight dispatch shell; pulling the parser out keeps the
 * surface testable without spawning a child process.
 */
import type { AuthCliOptions } from './auth.js';
export type ParseAuthArgsResult = {
    kind: 'options';
    options: AuthCliOptions;
} | {
    kind: 'help';
} | {
    kind: 'invalid';
    message: string;
};
export declare function parseAuthArgs(argv: readonly string[]): ParseAuthArgsResult;
