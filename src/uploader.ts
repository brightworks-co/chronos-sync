/**
 * HTTP client for the Chronos upload pipeline using a Personal Access Token.
 *
 * Mirrors the three-step `init → chunk → finalize` flow the in-app
 * UploadModal uses, but with `Authorization: Bearer chr_pat_…` instead of a
 * NextAuth session cookie.
 */

import type { ParsedMessage } from './parser/types.js'
import { CHUNK_SIZE } from './types.js'

export interface UploaderConfig {
  serverUrl: string
  pat: string
}

export interface InitInput {
  project_id: string
  room_name: string
  kakao_original_name: string
  total_chunks: number
  total_messages: number
  file_name: string
}

export interface FinalizeStats {
  messages_processed: number
  nickname_changes: number
  duration_ms: number
  backup_skipped: boolean
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export class Uploader {
  constructor(private readonly cfg: UploaderConfig) {}

  async init(input: InitInput): Promise<{ batch_id: string }> {
    const res = await this.post('/api/upload/init', { ...input, force: false })
    if (res.status === 409) {
      // header mismatch — caller decides whether to retry with force
      throw new UploadError('kakao_original_name mismatch', 409, await safeJson(res))
    }
    return this.expectJson<{ batch_id: string }>(res, '/api/upload/init')
  }

  async chunk(batchId: string, chunkIndex: number, messages: ParsedMessage[]): Promise<void> {
    const res = await this.post('/api/upload/chunk', {
      batch_id: batchId,
      chunk_index: chunkIndex,
      messages,
    })
    if (!res.ok) {
      throw new UploadError(
        `chunk ${chunkIndex} failed: ${res.status}`,
        res.status,
        await safeJson(res)
      )
    }
  }

  async finalize(batchId: string, rawText?: string): Promise<FinalizeStats> {
    const body: Record<string, unknown> = { batch_id: batchId }
    if (rawText) body.raw_text = rawText
    const res = await this.post('/api/upload/finalize', body)
    const json = await this.expectJson<{ success: boolean; stats: FinalizeStats }>(
      res,
      '/api/upload/finalize'
    )
    return json.stats
  }

  /**
   * Upload a parsed-message array end-to-end. Returns the finalize stats.
   *
   * Splits messages into chunks of CHUNK_SIZE and uploads them sequentially
   * (the daemon optimises for predictability over throughput — concurrency
   * is the in-app modal's concern since it is bandwidth-constrained on a
   * mobile network).
   */
  async uploadAll(
    init: InitInput,
    messages: ParsedMessage[],
    rawText?: string
  ): Promise<FinalizeStats> {
    const totalChunks = Math.max(1, Math.ceil(messages.length / CHUNK_SIZE))
    const initWithCounts: InitInput = {
      ...init,
      total_chunks: totalChunks,
      total_messages: messages.length,
    }
    const { batch_id } = await this.init(initWithCounts)

    for (let i = 0; i < totalChunks; i++) {
      const slice = messages.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      if (slice.length === 0) continue
      await this.chunk(batch_id, i, slice)
    }

    return this.finalize(batch_id, rawText)
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.cfg.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.pat}`,
      },
      body: JSON.stringify(body),
    })
  }

  private async expectJson<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      const body = await safeJson(res)
      throw new UploadError(`${path} failed: ${res.status}`, res.status, body)
    }
    return (await res.json()) as T
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}
