import { getSyncSettings, ApiPatAuthError } from './api-client.js';
import { DEFAULT_INTERVAL_SECONDS } from './types.js';
const FETCH_TIMEOUT_MS = 5000;
const MAX_CACHE_AGE_MS = 24 * 3600 * 1000;
const STALE_WARN_AGE_MS = 20 * 3600 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_SKIP_CYCLES = 5;
function useCacheOrConfig(nowMs, nowIso, state, config, warning) {
    const cache = state.interval_cache;
    if (cache) {
        const age = nowMs - Date.parse(cache.fetched_at);
        if (age < MAX_CACHE_AGE_MS) {
            const staleWarning = age >= STALE_WARN_AGE_MS ? 'cache stale (≥20h)' : null;
            const combinedWarning = warning && staleWarning
                ? `${warning} / ${staleWarning}`
                : warning ?? staleWarning;
            return {
                value: cache.value,
                source: 'cached',
                fetched_at: cache.fetched_at,
                warning: combinedWarning,
            };
        }
    }
    if (config.interval_seconds) {
        return { value: config.interval_seconds, source: 'config', fetched_at: nowIso, warning: warning ?? 'config bootstrap 사용' };
    }
    return { value: DEFAULT_INTERVAL_SECONDS, source: 'default', fetched_at: nowIso, warning: warning ?? 'default 회귀 (모든 단계 실패)' };
}
export async function resolveInterval(config, state, deps) {
    const nowFn = deps.now ?? Date.now;
    const nowMs = nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const cycleIndex = state.daemon.cycle_index;
    const cache = state.interval_cache;
    // 1. Circuit breaker open — skip GET
    if (cache && cycleIndex < cache.skip_until_cycle) {
        const age = nowMs - Date.parse(cache.fetched_at);
        if (age < MAX_CACHE_AGE_MS) {
            return {
                value: cache.value,
                source: 'cached',
                fetched_at: cache.fetched_at,
                warning: '서버 도달 불가 — 캐시된 값 사용 중',
            };
        }
        return useCacheOrConfig(nowMs, nowIso, state, config, '캐시 만료 — config fallback');
    }
    // 2. Try server fetch
    try {
        const remote = await getSyncSettings({ serverUrl: config.server_url, pat: config.pat, timeoutMs: FETCH_TIMEOUT_MS });
        state.interval_cache = {
            value: remote.interval_seconds,
            fetched_at: nowIso,
            source: 'server',
            consecutive_failures: 0,
            skip_until_cycle: 0,
        };
        deps.log('info', 'interval fetched from server', { value: remote.interval_seconds });
        return { value: remote.interval_seconds, source: 'server', fetched_at: nowIso, warning: null };
    }
    catch (err) {
        if (err instanceof ApiPatAuthError) {
            deps.log('warn', 'PAT auth error fetching interval', { err });
            return useCacheOrConfig(nowMs, nowIso, state, config, 'PAT 만료 감지 — web에서 갱신 필요');
        }
        // Generic failure: increment counter, possibly open circuit
        const prevFailures = cache?.consecutive_failures ?? 0;
        const failures = prevFailures + 1;
        let skipUntilCycle = 0;
        if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
            skipUntilCycle = cycleIndex + CIRCUIT_BREAKER_SKIP_CYCLES;
            deps.log('warn', 'circuit breaker open', { failures, skip_until_cycle: skipUntilCycle });
        }
        state.interval_cache = {
            value: cache?.value ?? DEFAULT_INTERVAL_SECONDS,
            fetched_at: cache?.fetched_at ?? nowIso,
            source: cache?.source ?? 'default',
            consecutive_failures: failures,
            skip_until_cycle: skipUntilCycle,
        };
        deps.log('warn', 'interval fetch failed', { failures, err });
        return useCacheOrConfig(nowMs, nowIso, state, config, '서버 fetch 실패 — 캐시 사용');
    }
}
