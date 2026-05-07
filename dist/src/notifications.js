import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const DEFAULT_NOTIFICATIONS_PATH = path.join(os.homedir(), '.chronos', 'notifications.jsonl');
function getNotificationsPath() {
    return process.env['CHRONOS_NOTIFICATIONS_PATH'] ?? DEFAULT_NOTIFICATIONS_PATH;
}
/**
 * Append a notification record to the JSONL file.
 * Best-effort: never throws; errors are written to stderr.
 */
export async function append(rec) {
    const record = { ts: Date.now(), ...rec };
    const line = JSON.stringify(record) + '\n';
    const filePath = getNotificationsPath();
    try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, line, 'utf8');
    }
    catch (err) {
        process.stderr.write('chronos-sync: notification write failed: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n');
    }
}
