import { type RoomConfig } from './types.js';
export interface SyncSettingsResponse {
    interval_seconds: number;
    updated_at: string;
}
export interface ApiClientOptions {
    serverUrl: string;
    pat: string;
    /** Fetch timeout in ms. Default 5000. */
    timeoutMs?: number;
}
export declare class ApiPatAuthError extends Error {
    constructor();
}
/**
 * Server-side `/api/auto-upload/bootstrap` payload, mirrored from the
 * `BootstrapResponse` shape in the chronos web repo (PR2). Kept structural
 * here so the CLI side does not need a cross-repo type import.
 *
 * `etag` is informational only — the canonical etag for a 200 response is
 * the `ETag` HTTP header. The body field is exposed for diagnostics.
 */
export interface BootstrapPayload {
    server_url: string;
    user_email: string;
    interval_seconds: number;
    rooms: RoomConfig[];
    etag: string;
    fetched_at: string;
}
export type BootstrapResult = {
    status: 200;
    payload: BootstrapPayload;
    etag: string;
} | {
    status: 304;
    etag: string;
};
/**
 * GET `/api/auto-upload/bootstrap` with `Authorization: Bearer <PAT>`. Honors
 * `If-None-Match: <etag>` when `opts.etag` is set; on 304 returns the prior
 * etag (echoed by the server) without a body. On 200 returns the parsed
 * payload + the response `ETag` header.
 *
 * Rejects with `ApiPatAuthError` on 401. 403/5xx/network failures throw
 * generic `Error` instances; PR6's bootstrap-resolver classifies them.
 */
export declare function getBootstrap(opts: ApiClientOptions, etag?: string): Promise<BootstrapResult>;
/**
 * Single eligible project (subset of fields chronos-sync needs).
 * Mirrors the chronos web `/api/auto-upload/projects` response shape; we
 * keep the type structural so PR1/PR2 schema additions don't break us.
 */
export interface EligibleProject {
    id: string;
    name?: string;
    archived?: boolean;
}
/**
 * GET `/api/auto-upload/projects` with PAT auth — returns the list of
 * projects whose room mappings the user is allowed to PUT. Used by
 * `chronos-sync migrate` pre-flight (MAJ-8.2) to filter legacy rows
 * pointing at archived/inaccessible projects.
 */
export declare function listEligibleProjects(opts: ApiClientOptions): Promise<EligibleProject[]>;
/**
 * Whole-payload PUT to `/api/account/auto-upload/rooms` (PR1 contract).
 * Replaces (not merges) the user's room mapping list.
 */
export interface AutoUploadMappingRow {
    project_id: string;
    room_name: string;
    /** String wire form; never coerced to number (Number.MAX_SAFE_INTEGER risk). */
    chat_id: string;
}
export declare function putAutoUploadRooms(opts: ApiClientOptions, rows: AutoUploadMappingRow[]): Promise<void>;
/**
 * DELETE `/api/account/auto-upload/rooms/{project_id}/{room_name}` — clears
 * `auto_mac_uploader` for that room. Used by `chronos-sync auth --reset`
 * to release a previously claimed room before issuing a new PAT.
 *
 * Returns true on 200/204 and on 404 (already released — idempotent). Throws
 * `ApiPatAuthError` on 401 so the caller can degrade gracefully when the old
 * PAT is already revoked.
 */
export declare function deleteAutoUploadRoom(opts: ApiClientOptions, projectId: string, roomName: string): Promise<void>;
export declare function getSyncSettings(opts: ApiClientOptions): Promise<SyncSettingsResponse>;
export declare function putSyncSettings(opts: ApiClientOptions, intervalSeconds: number): Promise<SyncSettingsResponse>;
