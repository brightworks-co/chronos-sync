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
export declare function getSyncSettings(opts: ApiClientOptions): Promise<SyncSettingsResponse>;
export declare function putSyncSettings(opts: ApiClientOptions, intervalSeconds: number): Promise<SyncSettingsResponse>;
