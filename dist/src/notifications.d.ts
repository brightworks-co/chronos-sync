export interface NotificationRecord {
    ts: number;
    level: 'info' | 'warn' | 'error_user_actionable';
    msg: string;
    ctx?: Record<string, unknown>;
}
/**
 * Append a notification record to the JSONL file.
 * Best-effort: never throws; errors are written to stderr.
 */
export declare function append(rec: Omit<NotificationRecord, 'ts'>): Promise<void>;
