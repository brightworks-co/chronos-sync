# Changelog

## 0.3.1 (unreleased)

### Fixed

- **`kakaocli messages` was silently truncated to 50 results.** `listMessages` did not pass `--limit`, so kakaocli's own default of 50 took over. In normal steady-state operation the cap was harmless (a 5-minute cycle rarely sees more than a handful of new messages), but a cross-device KakaoTalk login that flushes a multi-hour backlog at once exposed it: only the most recent 50 messages crossed the daemon's `since` filter, the room cursor advanced past them, and everything older than the 50th-most-recent message was permanently skipped. v0.3.1 forwards `--limit 5000` by default and exposes a per-config override at `messages.limit` in `~/.chronos/config.json` for operators who want a different ceiling. The exhaustive 5000-default sits well above any realistic single-cycle volume; kakaocli still streams whatever subset matches the filter, so an oversized limit costs nothing when there is nothing new to deliver.

## 0.3.0 (2026-05-08)

### Added

- **Foreground macOS sleep prevention via `caffeinate -i -w <pid>` self-attach.** When you run `chronos-sync` in a terminal on macOS, the daemon now spawns `caffeinate` as a child so the host does not idle-sleep while the loop is running. The `-w` flag ties caffeinate's lifetime to the daemon pid, so caffeinate exits on its own when the daemon dies (including SIGKILL) — the sleep policy reverts automatically, no leftover assertion. Skipped when (a) running under launchd (which controls wake/sleep itself via `KeepAlive`), (b) host is not darwin, or (c) `CHRONOS_NO_CAFFEINATE=1` is set (operator manages sleep externally via `pmset` / Amphetamine). The caffeinate PID lives on `DaemonRuntime` in-memory only, never persisted. ([ADR 0009 Part A](docs/adr/0009-interval-cache-refresh-policy.md))

### Changed (BREAKING for users who change interval via web UI mid-run)

- **`chronos-sync` no longer issues a per-cycle GET to `/api/account/settings/sync`.** The interval cache is primed exactly twice in normal operation: once at boot (right after `loadConfig`) and once per `kill -HUP <pid>` (alongside the existing config reload). To pick up a new interval set via web UI or `chronos-sync interval <seconds>`, either restart the daemon or send SIGHUP. Concurrent SIGHUP signals are deduplicated by an in-flight mutex inside `primeIntervalCache`. Boot fetch failures are swallowed (fail-soft) — cycle 0 falls back to `cfg.interval_seconds` or `DEFAULT_INTERVAL_SECONDS`. ([ADR 0009 Part B](docs/adr/0009-interval-cache-refresh-policy.md))

### Deprecated

- `IntervalCache.consecutive_failures` and `IntervalCache.skip_until_cycle` are now optional and unused at runtime — the cycle loop no longer increments them because there is no longer a per-cycle fetch to fail. The fields stay on the schema for state-file backward compatibility (older `~/.chronos/state.json` writes still parse) and will be removed in a later release.

### Notes

- SIGHUP now serves three purposes in foreground mode (farewell printout, config reload, interval cache prime). Each listener is registered separately and Node fires all of them; functionally fine today. v0.3.1 follow-up will drop the foreground farewell listener so SIGHUP semantics collapse to "reload + interval".
- Long-running launchd daemons can let the cache age past `MAX_CACHE_AGE_MS = 24h`; the reader returns the cached value with a warning string. Foreground header surfaces the warning; launchd path only writes it to the JSONL log. v0.3.1 follow-up will append an `error_user_actionable` notification when the cache crosses 24h on launchd.

## 0.2.9 (2026-05-08)

### Changed (BREAKING for users who relied on auto-harvest)

- **`config.harvest.enabled` defaults to `false`.** v0.2.7/0.2.8 implicitly auto-spawned `kakaocli harvest --scroll` once per cycle when a stuck-room signal fired. Real-world usage showed that (a) KakaoTalk macOS auto-populates `NTUser` on incoming push messages, so steady-state sync rarely benefits from explicit harvest, and (b) the auto-spawn was disruptive — it stole window focus, and the high-traffic open chats it was meant to recover were `unread > 0` and therefore skipped by kakaocli's own policy. Users who want the previous behavior must set `"harvest": { "enabled": true }` in `~/.chronos/config.json`. Users who want a one-off backfill (initial install, after a long offline stretch) should run the new `chronos-sync harvest` command instead.
- `chronos-sync harvest` is a new CLI subcommand. Wraps `harvestScroll` with the same defaults as the daemon (`--top 5`, `--max-clicks 3`, `--scroll-delay 1.5`). Accepts `--top N`, `--max-clicks N`, `--scroll-delay S`, `--dry-run`. Probes kakaocli capabilities first; fails fast if `--scroll` is unsupported.

### Fixed

- **Raw `{"feedType":...}` system-event JSON leaking into Chronos viewer.** `kakaocli messages --json` emits some non-user-message rows (deletions, member changes, voice-call markers) as raw JSON in the `text` field. The reassembler now passes message text through `transformFeedTypeText` (`src/parser/feedtype.ts`), which renders these payloads as Korean placeholders matching how KakaoTalk macOS displays them in the chat UI:
  - `feedType=25` → `삭제된 메시지` (classified as `kind='deleted'`)
  - `feedType=4` with `members[].nickName` → `<nick>님이 들어왔습니다` (classified as `announcement`)
  - `feedType=11` → `[보이스톡]`
  - `feedType=1` / `feedType=2` → `[채팅방 입장]` / `[채팅방 퇴장]`
  - unknown feedType → `[시스템 이벤트:<N>]` (never silently dropped)

## 0.2.8 (2026-05-08)

### Fixed

- **Open-chat sender resolution silently fails for 19-digit BigInt userIds (regression: dho stuck after v0.2.7)**: `parseQueryRows` ran `kakaocli query` stdout through plain `JSON.parse`, which rounded the trailing 2–3 digits of every 19-digit `userId` (well past `Number.MAX_SAFE_INTEGER`). The resulting map keys (e.g. `6321186593654462000`) no longer matched the precision-preserved sender_id keys built from `kakaocli messages` output (`6321186593654462422`), so every open-chat sender failed lookup. The hold-back invariant (PR #7) then froze the cycle indefinitely. Fix: route `kakaocli query` stdout through `preserveBigIntPrecision` (now also handles tuple-form `[<bigint>, "name"]` 2-D arrays) before `JSON.parse`. ([ADR 0007 amendment](docs/adr/0007-harvest-state-split.md))

### Changed

- `preserveBigIntPrecision` now covers two emission shapes: object form (`"key": <bigint>`) and tuple form (`[<bigint>, ...]`). The tuple branch is what `kakaocli query` returns.

## 0.2.7 (2026-05-07)

### Fixed

- **dho room stuck (33–34 cycles)**: `harvestScroll` was passing `--chat-id`/`--max-pages` flags that kakaocli 0.4.1 does not accept (exit 64). Realigned to the actual 0.4.1 surface (`--top`, `--max-clicks`, `--scroll-delay`, `--dry-run`, `--db`, `--key`). ([ADR 0007](docs/adr/0007-harvest-state-split.md))

### Changed

- Harvest hoisted from per-room `syncRoom` to cycle-scope `runCycle` pre-loop. At most one `harvestScroll` spawn per cycle regardless of the number of stuck rooms.
- `state.daemon.last_harvest_at` is now persisted to `state.json` (daemon-scope). `RoomState.last_harvest_at` is deprecated as reader-only for 0.2.6 state-file backwards compatibility.
- `consecutive_harvest_failures` is in-memory only (`DaemonRuntime`); resets to 0 on process restart.
- Exponential backoff for repeated harvest failures: `max(rate_limit_seconds, 1800 × 2^min(failures, 4))`, capped at 28800s.
- Grace cycle: when harvest runs in a cycle, held-back rooms do not increment `consecutive_stuck_cycles` that cycle (NTUser settle time).
- Probe at boot: `probeHarvestCapabilities` runs once; if `--scroll` is unsupported, harvest is disabled for the session without `process.exit(1)` (avoids launchd crash-loop).
- SIGHUP now also calls `invalidateProbeCache()` so the next cycle re-probes kakaocli capabilities.
- Stuck-room nudge: when `consecutive_stuck_cycles ≥ stuck_nudge_threshold` (default 5), one `error_user_actionable` record is appended to `~/.chronos/notifications.jsonl` with `chronos-sync diagnose senders` guidance. Flag resets on successful sync.

### Deprecated

- `config.harvest.max_pages`: accepted on read for backwards compatibility; emits one deprecation warning to stderr then ignored. Use `max_clicks` instead.

### Added

- `~/.chronos/notifications.jsonl` append-only notification channel (`{ ts, level, msg, ctx }`).
- New `config.harvest` fields: `top` (default 5), `max_clicks` (default 3), `scroll_delay` (default 1.5), `stuck_nudge_threshold` (default 5), `harvest_failure_backoff_base_seconds` (default 1800), `harvest_failure_backoff_max_seconds` (default 28800).
