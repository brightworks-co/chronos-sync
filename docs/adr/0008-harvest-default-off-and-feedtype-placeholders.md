# ADR 0008 — Harvest Default-Off and feedType Placeholders

Status: Accepted | Date: 2026-05-08 | Decision-makers: chronos-sync owner

## Context

After v0.2.7 (cycle-scope harvest hoist) and v0.2.8 (sender-resolver BigInt precision fix) shipped, real-world operation surfaced two unrelated issues:

### 1. Cycle-scope auto-harvest is rarely useful and frequently disruptive

The original v0.2.7 design assumed the daemon needs `kakaocli harvest --scroll` to populate `NTUser` / `NTMultiProfile` whenever a sender_id was unresolved. Operation showed otherwise:

- KakaoTalk macOS already populates `NTUser` automatically when push messages arrive in the foreground app. With v0.2.8's precision fix, sender resolution succeeds for typical message volumes (e.g. 136 unread, all senders resolved) without any harvest at all.
- `kakaocli harvest --scroll` skips chats with `unread > 0` (it never auto-marks-as-read on the user's behalf). High-traffic open chats — exactly the rooms most likely to trigger our stuck signal — are precisely the ones that always have unread messages. Auto-harvest was attempting to recover them every cycle, getting skipped by kakaocli policy, and stealing KakaoTalk's window focus in the process.
- Even when harvest *did* find a candidate chat, the user observed it taking visible focus to scroll — a meaningful daily-driver disruption.

Net result: the cycle-scope auto-harvest infrastructure built in v0.2.7 was correct in design but a poor fit for the actual workload.

### 2. System-event payloads leak as raw JSON

`kakaocli messages --json` emits system events (deletions, member changes, voice-call markers) as raw JSON literals in the `text` field, e.g. `{"feedType":25,"hidden":true,...}`. The Chronos viewer was rendering these verbatim, surprising users who saw garbled JSON among normal messages. KakaoTalk macOS itself converts these payloads into localized placeholders (`삭제된 메시지`, member change announcements, etc.) at render time.

## Decision

### Harvest auto-spawn → opt-in

`HarvestThresholds.enabled` is now an explicit boolean field, defaulting to **`false`** (`DEFAULT_HARVEST_ENABLED = false`). When unset or `false`:

- `runLoop` short-circuits the boot probe and pins the `harvestDisabled` sentinel (reusing the existing v0.2.7 disabled-path code), so `decideCycleHarvest` always returns `rate_limited` (`shouldHarvest: false`).
- One `info`-level log record is emitted at boot announcing the disabled state and pointing at the new manual command.
- All cycle-scope harvest infrastructure (probe cache, backoff curve, stuck nudge, file-based notifications) remains intact and re-activates the moment the user sets `enabled: true`.

A new CLI subcommand `chronos-sync harvest [--top N] [--max-clicks N] [--scroll-delay S] [--dry-run]` is added for one-off backfill scenarios. It loads config, probes kakaocli capabilities, then directly invokes `harvestScroll` and prints exit status to stdout/stderr. Exit code mirrors kakaocli's exit code so it can be wired into shell scripts.

### feedType payload normalization

`src/parser/feedtype.ts` (new) provides:

- `isFeedTypeText(text)` — cheap regex pre-check (`/^\s*\{\s*"feedType"\s*:/`).
- `parseFeedTypeText(text): FeedTypePayload | null` — `JSON.parse` + integer-`feedType` validation. Returns `null` for non-payloads.
- `feedTypeToPlaceholder(payload): string` — observation-based mapping (`25` → `삭제된 메시지`, `4` with `members[].nickName` → `<nick>님이 들어왔습니다`, `11` → `[보이스톡]`, `1`/`2` → `[채팅방 입장/퇴장]`, unknown → `[시스템 이벤트:<N>]`).
- `transformFeedTypeText(text): string` — one-shot pass-through helper.

`csv-reassemble.ts` runs every message body through `transformFeedTypeText` before quoting it into the CSV column. Downstream `parseMacCsv` → `classifyMessage` then routes the placeholder into a sensible `kind` (e.g. `삭제된 메시지` matches `DELETED_RE` → `kind='deleted'`; `<nick>님이 들어왔습니다` matches the announcement keyword set → `kind='announcement'`).

Unknown feedType codes are *not* silently dropped — they surface as `[시스템 이벤트:<N>]` so an operator can spot a new code in the wild and add a case to the mapping.

## Why these defaults

- `enabled = false`: matches observed reality (auto-harvest provides marginal benefit at meaningful UX cost). Prior users who depended on the v0.2.7/0.2.8 implicit `true` will see harvest stop spawning after upgrade; the CHANGELOG and the boot `info` log both surface this clearly. Users who want the old behavior set one boolean.
- feedType placeholders in Korean: matches what KakaoTalk macOS itself shows for the same payloads, so the Chronos viewer reads consistently with the source app.

## Alternatives considered

- **Drop feedType rows entirely** — rejected. Loses the audit trail (a deleted message *was* sent at some point; a member *did* join). Placeholders preserve the timeline.
- **Move feedType handling to the Chronos server** — rejected. Server already accepts arbitrary text; pushing the transform server-side would require coordinated chronos+chronos-sync deploys. Doing it at reassembly time keeps the change scoped to chronos-sync.
- **Keep auto-harvest on by default but throttle harder** — rejected. Doesn't address the `unread > 0` skip-by-kakaocli reality. Throttling makes the disruption rarer, not the design more correct.

## Consequences

### Positive

- Daemon no longer auto-spawns KakaoTalk window focus disruption.
- Default sync experience for typical workloads (incoming push, NTUser auto-populated) needs zero harvest.
- Power users can flip one boolean to opt back into the v0.2.7/0.2.8 cycle-scope behavior.
- New `chronos-sync harvest` is a clean separation of concerns — backfill is a deliberate user action, not a hidden side-effect of running the daemon.
- System-event rows render as readable placeholders in the Chronos viewer.
- All v0.2.7 harvest infrastructure (probe, backoff, nudge, JSONL notifications) is preserved and re-activates when `enabled: true`.

### Negative

- Behavior change for v0.2.7/0.2.8 users who depended on auto-harvest (small, given the unread-skip pattern) — surfaced via boot `info` log and CHANGELOG entry.
- feedType mapping is observation-based — codes 1, 2, 4, 11, 25 are mapped explicitly; everything else falls through to a generic `[시스템 이벤트:<N>]`. New codes will land as generic until the mapping is updated.
- The `chronos-sync harvest` CLI requires the user to keep KakaoTalk in foreground while it runs. Documentation in the help text covers this; it is not a UX regression because the same constraint applied to the auto-harvest path.

## Follow-ups

1. Operator guide (`docs/operator/harvest-recovery.md`) covering: when to run `chronos-sync harvest`, how to read `~/.chronos/notifications.jsonl`, troubleshooting `unread > 0` skip pattern.
2. Maintain the feedType code mapping. Each new generic `[시스템 이벤트:<N>]` observed in the wild should be triaged into an explicit case via PR.
3. Consider a `chronos-sync diagnose harvest <chat-id>` subcommand that runs `kakaocli harvest --top N --dry-run` and surfaces per-chat skip reasons (e.g. `unread > 0`, `window didn't open`).
4. Long term: investigate whether kakaocli upstream would accept a `--include-unread` (or `--force-scroll`) flag for explicit user-driven backfill cases. That would let `chronos-sync harvest` recover high-traffic open chats without requiring the user to mark-as-read first.
