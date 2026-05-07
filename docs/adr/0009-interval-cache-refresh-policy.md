# ADR 0009 — Interval Cache Refresh Policy + Foreground caffeinate

Status: Accepted | Date: 2026-05-08 | Decision-makers: chronos-sync owner

## Context

Two operational issues were observed in v0.2.9 24h field testing:

1. **macOS idle-sleep suspends the foreground daemon.** When the user
   leaves a foreground `chronos-sync` running in a terminal and the lid
   closes (or the display sleeps), the process is suspended and cycles
   are skipped. The previous workarounds — wrapping with
   `caffeinate -i chronos-sync`, setting `pmset -a sleep 0`, or using
   Amphetamine — all required conscious external setup. New users would
   ask "왜 sleep 후 sync 안 됐지?" and discover the gap only after data
   loss.

2. **Per-cycle GET to `/api/account/settings/sync` accumulates.** The
   v0.2.x interval resolver issued one HTTP fetch per cycle to pick up
   server-side interval changes. At a 5-minute cycle this is 288
   requests/day; at 30 seconds it is 2880/day. The payload is small but
   each round trip is a syscall, a TCP/TLS handshake (worst case), and a
   KV read on the server. v0.2.9 already reset the spirit toward
   "communicate only on events" by making `harvest` opt-in. Per-cycle
   polling for a value the user changes maybe once per quarter is the
   next obvious offender.

## Decision

### Part A — Foreground `caffeinate` self-attach

Spawn `caffeinate -i -w <chronos_pid>` from the foreground entry point
on darwin. The `-w` flag ties caffeinate's lifetime to our pid, so the
sleep policy reverts automatically when the daemon exits (including
SIGKILL). Skipped when:

- `foreground === false` (launchd path — launchd already controls
  wake/sleep via `KeepAlive`).
- host is not darwin.
- `CHRONOS_NO_CAFFEINATE=1` env is set (operator manages sleep
  externally).

The caffeinate PID is held in `DaemonRuntime.caffeinate_pid` (in-memory
only). Persisting to `DaemonState` (state.json) would risk killing an
unrelated process after a crash + restart with PID reuse, following
v0.2.7's pattern for `last_harvest_at` / `consecutive_harvest_failures`
/ `stuck_nudge_flags`.

### Part B — Interval cache refresh: boot + SIGHUP only (Option B)

The cycle loop no longer issues per-iteration GETs. The interval cache
is primed exactly twice in normal operation:

1. **Boot** — `runLoop` calls `await primeIntervalCache(cfg, log)` once
   right after `loadConfig`. Failures are swallowed inside prime, so
   the boot path is fail-soft (cycle 0 falls back to
   `cfg.interval_seconds` or `DEFAULT_INTERVAL_SECONDS`).
2. **SIGHUP** — `kill -HUP <daemon_pid>` triggers a re-prime alongside
   the existing `loadConfig` reload. An in-flight mutex inside
   `primeIntervalCache` deduplicates rapid bursts, so two SIGHUPs in
   quick succession produce exactly one HTTP fetch.

The cache lives in `src/interval-resolver.ts` module-level state (not
`DaemonState`), so it does not survive process restart — that is
intentional. A `resetIntervalCacheForTest()` export makes the module
reset between vitest cases.

`getCachedInterval(cfg, log)` is now synchronous and returns a
`ResolvedInterval` shape identical to v0.2.x for foreground UI
compatibility (`foreground-ui.printHeader` reads `value`, `source`,
`fetched_at`, `warning`).

## Drivers

1. macOS sleep miss → 0 cycle-miss complaints.
2. Outbound communication minimization (consistent with v0.2.9 harvest
   default-off).
3. Release scope small (< 2 change categories).
4. Reversibility: each side disabled via `CHRONOS_NO_CAFFEINATE=1`
   (Part A) or by reverting the daemon prime / cycle calls (Part B).
5. Test isolation (module-level cache must reset cleanly).

## Alternatives considered

### For Part A

- **`pmset -a sleep 0` system-wide** — affects all processes, requires
  sudo, irreversible without the user's explicit cleanup. Rejected:
  blast radius too wide for an opt-in daemon feature.
- **Document the manual `caffeinate -i chronos-sync` wrapper** — what
  v0.2.x already implicitly does. Rejected: the field test confirmed
  users do not discover this without help.
- **launchd-mode caffeinate** — out of scope; launchd controls wake/sleep
  itself via `KeepAlive`.

### For Part B

- **Keep per-cycle GET (status quo)** — accepted operationally for two
  releases, but inconsistent with the "ambient polling minimum"
  direction set by v0.2.9 harvest default-off. Rejected.
- **TTL = 1h (Option C)** — same shape as v0.2.x but lower frequency.
  Saves ~70% of GETs at 5-minute cycles, but still keeps the periodic
  cron pattern that the user pointed to as the smell. Rejected: half
  measure.
- **Refresh on every cycle but only when state has changed (delta GET)**
  — server-side support not available. Out of scope.
- **WebSocket push** — server complexity (reconnect, heartbeat, scale)
  far exceeds the ~10 LOC value. Rejected.

## Why chosen

Option B + foreground caffeinate together let the daemon "sit quiet"
between events: no idle sleep stealing cycles, no idle GET spending
syscalls. Both have explicit operator hatches (env override, SIGHUP)
that are cheap to use and easy to reason about. The combined diff is
small enough to ship in a single v0.3.0 with PR-level rollback
granularity.

## Consequences

- **Web UI interval changes are no longer auto-picked-up** by a running
  daemon. Operators must restart the daemon or send `kill -HUP <pid>`.
  `chronos-sync interval <seconds>` and `chronos-sync interval --get`
  CLI docs were updated to call this out. CHANGELOG flags it as a
  user-visible behavior change.
- **SIGHUP semantic is now triple-purpose** in foreground mode:
  (a) `bin/chronos-sync.ts` farewell printout, (b) `daemon.ts` config
  reload, (c) `daemon.ts` interval cache prime. The three handlers are
  registered as separate `process.on('SIGHUP', ...)` listeners (Node
  fires all of them). Functionally OK today; mental-model load grows.
  Follow-up: drop the foreground farewell SIGHUP listener in v0.3.1
  (`SIGINT` / `SIGTERM` already cover graceful exit).
- **`IntervalCache.consecutive_failures` and `IntervalCache.skip_until_cycle`
  are dead schema fields.** The cycle loop no longer issues GETs, so
  the in-cycle circuit breaker that incremented these has nothing to
  protect. Both fields are kept on `IntervalCache` for state-file
  backward compatibility, marked `?: number` so a strict validator
  parsing an old `state.json` does not reject it. Slated for removal in
  a future release.
- **Cache age can exceed 24h on long-running launchd daemons.** The
  reader returns the cached value with a warning string, but launchd
  has no foreground header to display it — only the JSONL log. Until
  the follow-up below ships, an unattended 24h+ launchd daemon may run
  on a stale interval if the operator never restarts or HUPs.
- **Cold restart always pays one prime fetch.** Bounded by
  `FETCH_TIMEOUT_MS = 5000`. Acceptable.

## Follow-ups

- v0.3.1: Append an `error_user_actionable` notification to
  `notifications.jsonl` when launchd-mode cache age exceeds
  `MAX_CACHE_AGE_MS`, so operators see "interval cache is 24h+ old —
  send SIGHUP or restart" without needing to check the foreground UI.
- v0.3.1: Drop the foreground farewell SIGHUP listener
  (`bin/chronos-sync.ts` near the runForeground signal block) so SIGHUP
  semantics collapse to a single "reload config + interval".
- Future: Remove `IntervalCache.consecutive_failures` /
  `skip_until_cycle` from `types.ts` once a few releases have shipped
  with read-side optional handling.

## References

- `/Users/bright/projects/chronos/.cmux/plans/chronos-sync-v0.3.0.md` —
  consensus plan (ralplan, 3 iterations).
- `docs/adr/0007-harvest-state-split.md` — v0.2.7+0.2.8 amendments.
- `docs/adr/0008-harvest-default-off-and-feedtype-placeholders.md` —
  v0.2.9 spirit ("communicate on events, not idle polls") that v0.3.0
  Part B carries forward.
- `src/interval-resolver.ts` — module-level cache + `primeIntervalCache`
  / `getCachedInterval` / `resetIntervalCacheForTest`.
- `src/daemon.ts` — boot prime call site, SIGHUP handler.
- `src/caffeinate.ts` — `maybeStartCaffeinate` / `maybeStopCaffeinate`.
