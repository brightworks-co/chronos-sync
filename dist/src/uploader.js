/**
 * HTTP client for the Chronos upload pipeline using a Personal Access Token.
 *
 * Mirrors the three-step `init → chunk → finalize` flow the in-app
 * UploadModal uses, but with `Authorization: Bearer chr_pat_…` instead of a
 * NextAuth session cookie.
 */
import { CHUNK_SIZE } from './types.js';
export class UploadError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'UploadError';
    }
}
export class Uploader {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    async init(input) {
        const res = await this.post('/api/upload/init', { ...input, force: false });
        if (res.status === 409) {
            // header mismatch — caller decides whether to retry with force
            throw new UploadError('kakao_original_name mismatch', 409, await safeJson(res));
        }
        return this.expectJson(res, '/api/upload/init');
    }
    async chunk(batchId, chunkIndex, messages) {
        const res = await this.post('/api/upload/chunk', {
            batch_id: batchId,
            chunk_index: chunkIndex,
            messages,
        });
        if (!res.ok) {
            throw new UploadError(`chunk ${chunkIndex} failed: ${res.status}`, res.status, await safeJson(res));
        }
    }
    async finalize(batchId, rawText) {
        const body = { batch_id: batchId };
        if (rawText)
            body.raw_text = rawText;
        const res = await this.post('/api/upload/finalize', body);
        const json = await this.expectJson(res, '/api/upload/finalize');
        return json.stats;
    }
    /**
     * Upload a parsed-message array end-to-end. Returns the finalize stats.
     *
     * Splits messages into chunks of CHUNK_SIZE and uploads them sequentially
     * (the daemon optimises for predictability over throughput — concurrency
     * is the in-app modal's concern since it is bandwidth-constrained on a
     * mobile network).
     */
    async uploadAll(init, messages, rawText) {
        const totalChunks = Math.max(1, Math.ceil(messages.length / CHUNK_SIZE));
        const initWithCounts = {
            ...init,
            total_chunks: totalChunks,
            total_messages: messages.length,
        };
        const { batch_id } = await this.init(initWithCounts);
        for (let i = 0; i < totalChunks; i++) {
            const slice = messages.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            if (slice.length === 0)
                continue;
            await this.chunk(batch_id, i, slice);
        }
        return this.finalize(batch_id, rawText);
    }
    async post(path, body) {
        return fetch(`${this.cfg.serverUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.cfg.pat}`,
            },
            body: JSON.stringify(body),
        });
    }
    async expectJson(res, path) {
        if (!res.ok) {
            const body = await safeJson(res);
            throw new UploadError(`${path} failed: ${res.status}`, res.status, body);
        }
        return (await res.json());
    }
}
async function safeJson(res) {
    try {
        return await res.json();
    }
    catch {
        return null;
    }
}
