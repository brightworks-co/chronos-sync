/**
 * Thin wrapper around the kakaocli (silver-flight-group/kakaocli) binary.
 *
 * Only the read side is needed here: list messages newer than the last
 * synced cursor. Sends are out of scope.
 */
import { spawn } from 'node:child_process';
/**
 * Invoke `kakaocli messages [--chat <name> | --chat-id <id>] [--since <iso>] --json`
 * and parse the JSON array on stdout. kakaocli streams a single JSON array (or
 * a newline-delimited stream when `--follow` is used; we never use `--follow`
 * because the daemon owns its own scheduler).
 *
 * Either `chat` or `chatId` is required. When both are supplied `chatId`
 * wins to keep behavior aligned with the daemon's room dispatch.
 */
export async function listMessages(query) {
    const binary = query.binary ?? 'kakaocli';
    const args = ['messages', '--json'];
    if (query.chatId !== undefined) {
        args.splice(1, 0, '--chat-id', String(query.chatId));
    }
    else if (query.chat !== undefined) {
        args.splice(1, 0, '--chat', query.chat);
    }
    else {
        throw new Error('listMessages requires `chat` or `chatId`');
    }
    if (query.since) {
        args.push('--since', query.since);
    }
    const { stdout, stderr, code } = await runChild(binary, args);
    if (code !== 0) {
        throw new Error(`kakaocli exited with code ${code}: ${stderr.trim() || '(no stderr)'}`);
    }
    const trimmed = stdout.trim();
    if (!trimmed)
        return [];
    // Tolerate both `[ {...}, {...} ]` and NDJSON (`{...}\n{...}`).
    if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
    }
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
}
function runChild(binary, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
            stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d) => {
            stderr += d.toString('utf8');
        });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            resolve({ stdout, stderr, code: code ?? -1 });
        });
    });
}
