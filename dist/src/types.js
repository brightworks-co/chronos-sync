/**
 * Shared types for the Mac chronos-sync daemon.
 */
export const DEFAULT_INTERVAL_SECONDS = 300;
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 3600;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const MAX_RSS_BYTES = 200 * 1024 * 1024;
export const STUCK_THRESHOLD_MS = 60 * 60 * 1000;
export const CHUNK_SIZE = 500;
export const DEFAULT_HARVEST_GAP_SECONDS = 12 * 3600;
export const DEFAULT_HARVEST_STARTUP_SECONDS = 24 * 3600;
export const DEFAULT_HARVEST_RATE_LIMIT_SECONDS = 30 * 60;
export const DEFAULT_HARVEST_MAX_PAGES = 5;
