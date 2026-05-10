/**
 * Argv parsing for `chronos-sync auth`.
 *
 * Lives in `src/cli/` rather than inline in `bin/chronos-sync.ts` because
 * the bin file is a tight dispatch shell; pulling the parser out keeps the
 * surface testable without spawning a child process.
 */
export function parseAuthArgs(argv) {
    const options = {};
    let positional;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h')
            return { kind: 'help' };
        if (a === '--from-stdin') {
            options.fromStdin = true;
            continue;
        }
        if (a === '--allow-file-pat') {
            options.allowFilePat = true;
            continue;
        }
        if (a === '--reset') {
            options.reset = true;
            continue;
        }
        if (a === '--token') {
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                return { kind: 'invalid', message: '--token requires a value' };
            }
            options.token = next;
            options.tokenWasFlag = true;
            i++;
            continue;
        }
        if (a.startsWith('--token=')) {
            const value = a.slice('--token='.length);
            if (!value)
                return { kind: 'invalid', message: '--token requires a value' };
            options.token = value;
            options.tokenWasFlag = true;
            continue;
        }
        if (a === '--server-url') {
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                return { kind: 'invalid', message: '--server-url requires a value' };
            }
            options.serverUrl = next;
            i++;
            continue;
        }
        if (a.startsWith('--server-url=')) {
            const value = a.slice('--server-url='.length);
            if (!value)
                return { kind: 'invalid', message: '--server-url requires a value' };
            options.serverUrl = value;
            continue;
        }
        if (a.startsWith('--')) {
            return { kind: 'invalid', message: `unknown auth option: ${a}` };
        }
        if (positional === undefined) {
            positional = a;
        }
        else {
            return { kind: 'invalid', message: `unexpected extra argument: ${a}` };
        }
    }
    if (positional !== undefined) {
        if (options.token !== undefined) {
            return { kind: 'invalid', message: 'cannot combine positional <PAT> with --token' };
        }
        options.token = positional;
        options.tokenWasFlag = false;
    }
    if (options.fromStdin && options.token !== undefined) {
        return {
            kind: 'invalid',
            message: 'cannot combine --from-stdin with positional <PAT> or --token',
        };
    }
    return { kind: 'options', options };
}
