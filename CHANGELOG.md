# Changelog

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
