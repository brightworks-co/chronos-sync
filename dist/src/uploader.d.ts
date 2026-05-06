/**
 * HTTP client for the Chronos upload pipeline using a Personal Access Token.
 *
 * Mirrors the three-step `init → chunk → finalize` flow the in-app
 * UploadModal uses, but with `Authorization: Bearer chr_pat_…` instead of a
 * NextAuth session cookie.
 */
import type { ParsedMessage } from './parser/types.js';
export interface UploaderConfig {
    serverUrl: string;
    pat: string;
}
export interface InitInput {
    project_id: string;
    room_name: string;
    kakao_original_name: string;
    total_chunks: number;
    total_messages: number;
    file_name: string;
}
export interface FinalizeStats {
    messages_processed: number;
    nickname_changes: number;
    duration_ms: number;
    backup_skipped: boolean;
}
export declare class UploadError extends Error {
    readonly status: number;
    readonly body?: unknown | undefined;
    constructor(message: string, status: number, body?: unknown | undefined);
}
export declare class Uploader {
    private readonly cfg;
    constructor(cfg: UploaderConfig);
    init(input: InitInput): Promise<{
        batch_id: string;
    }>;
    chunk(batchId: string, chunkIndex: number, messages: ParsedMessage[]): Promise<void>;
    finalize(batchId: string, rawText?: string): Promise<FinalizeStats>;
    /**
     * Upload a parsed-message array end-to-end. Returns the finalize stats.
     *
     * Splits messages into chunks of CHUNK_SIZE and uploads them sequentially
     * (the daemon optimises for predictability over throughput — concurrency
     * is the in-app modal's concern since it is bandwidth-constrained on a
     * mobile network).
     */
    uploadAll(init: InitInput, messages: ParsedMessage[], rawText?: string): Promise<FinalizeStats>;
    private post;
    private expectJson;
}
