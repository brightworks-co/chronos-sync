# ADR 0007 — Harvest State Split and CLI Surface Realignment

Status: Accepted | Date: 2026-05-07 | Decision-makers: ralplan consensus iteration 3

## Context

chronos-sync v0.2.6 daemon was stuck on the "dho" room for 33–34 consecutive cycles.
Root cause chain:

1. `harvestScroll` called `kakaocli harvest --chat-id <id> --max-pages <n>`.
2. Installed kakaocli 0.4.1 `harvest` only accepts `--top/--scroll/--max-clicks/--scroll-delay/--dry-run/--db/--key` — unknown flags caused exit 64 every cycle.
3. `daemon.ts` unconditionally wrote `last_harvest_at = Date.now()` after each failed harvest, so the next cycle was always rate-limited and skipped.
4. KakaoTalk UI auto-scroll never ran → 50 sender rows stayed unresolved in NTUser/NTMultiProfile DB.
5. PR #7 hold-back invariant: unresolved sender → cycle hold + cursor freeze → `consecutive_stuck_cycles` grew monotonically.

## Decision

Realign `harvestScroll` to the kakaocli 0.4.1 CLI surface and hoist harvest to daemon-cycle scope (single spawn per cycle). Persist `state.daemon.last_harvest_at` as a daemon-scope field in state.json. Keep `consecutive_harvest_failures` in-memory only (`DaemonRuntime`). Deprecate `RoomState.last_harvest_at` as reader-only.

## Reservation 1 — Write timing: optimistic

`state.daemon.last_harvest_at = Date.now()` is written **before** `await harvestScroll(...)` resolves (optimistic).

Justification: false-floor cost (1 cycle nudge delay) < launchd-restart-during-chain cost. If the process is killed mid-harvest, the next boot sees a recent timestamp and skips one cycle — acceptable. The conservative alternative would leave `last_harvest_at = 0` on restart, allowing immediate re-harvest into a potentially broken chain.

## Reservation 2 — Floor: uniform

`composeRateLimit` is applied uniformly including cold-start cycle 1. When `failures = 0`, effective floor = `max(rate_limit_seconds, 1800s)`. User's larger `rate_limit_seconds` is preserved via `max()`.

Justification: respects user config intent without silent override. Cold-start cycle 1 is not special-cased because the persisted `state.daemon.last_harvest_at` already provides the correct boot-guard signal.

## Drivers (weighted)

1. **TTR (Time-to-Recovery)** — dho room stuck 33–34 cycles, hours of missing data. Highest priority.
2. **Data quality** — hold-back invariant (PR #7) must be preserved. Loss is unrecoverable.
3. **External dependency minimization** — no kakaocli upstream changes, no brew round-trip.

## Alternatives Considered

- **A** (re-align only) — silent re-freeze if top-N misses stuck rooms. Insufficient alone.
- **B** (kakaocli upstream `--chat-id` PR) — 4–6 day lead time, 2 repos, KakaoTalk DOM risk. Follow-up #1.
- **C** (relax hold-back / allow `참여자_<id>`) — violates Principle 1. **INVALID**.
- **D** (A + probe + nudge, v1 draft) — superseded by D'.
- **D'** (D + Architect synthesis 6/6 + Critic patches 6+1) — **Adopted**.

## Why Chosen

1. Immediate TTR with zero external dependencies.
2. Hard hold-back invariant (PR #7) preserved without modification.
3. State schema churn minimized: one daemon-scope field added, no migration code needed (missing field → default 0).
4. Daemon-mode visibility: `~/.chronos/notifications.jsonl` append-only channel for launchd users.
5. launchd crash-loop regression sealed: boot guard + persisted `last_harvest_at`.

## Consequences

**Positive**:
- dho room stuck state immediately resolved.
- Harvest failure backoff prevents KakaoTalk UI thrash.
- launchd users can `tail ~/.chronos/notifications.jsonl` to detect incidents.
- Hold-back invariant regression guard formalized in T-7.

**Negative (honest)**:
- GUI automation responsibility not eliminated — kakaocli 0.4.1 still clicks KakaoTalk UI. `--top 5` mitigates but does not eliminate disruption during active use (Follow-up #2).
- Restart loses in-memory `consecutive_harvest_failures` → backoff resets to 1800s on next boot. Boot guard prevents thrash.
- `stuck_nudge_emitted` flags lost on restart → same sequence may fire nudge again (bounded by 5-cycle threshold, ≤2/day in practice).
- `top=5` heuristic — if 5+ rooms are simultaneously stuck, some rooms wait one extra cycle.
- Probe sentinel rarely fires on 0.4.1 — defense-in-depth for future surface changes.

## Follow-ups

1. kakaocli upstream `--chat-id`/`--chat-name` PR — room-precise harvest, retire `--top` heuristic.
2. Harvest as separate launchd Agent — isolate GUI automation crash domain.
3. Observability metrics — harvest spawn frequency, stuck sequence distribution, nudge statistics.
4. Operator guide — `docs/operator/harvest-recovery.md`: SIGHUP, kakaocli upgrade, notifications.jsonl monitoring.
5. PR #7 invariant mutation-test hardening — full cursor advance path coverage.

---

## Amendment (2026-05-08, v0.2.8)

After v0.2.7 ship, dho remained stuck. Spike against the live KakaoTalk DB revealed a separate latent bug, *unrelated* to the harvest CLI surface realignment in this ADR but exposed by the same cursor-frozen scenario:

`src/sender-resolver.ts:parseQueryRows` ran `kakaocli query` stdout through plain `JSON.parse`. Open-chat sender userIds are typically 19 digits (well past `Number.MAX_SAFE_INTEGER` = 16 digits), so JSON.parse rounded the trailing 2–3 digits to fit IEEE 754 doubles. The resulting nameMap keys (e.g. `6321186593654462000`) no longer matched the precision-preserved sender_id keys built from `kakaocli messages` output (`6321186593654462422`). Every open-chat sender failed lookup → daemon held back the cycle → cursor froze → dho stuck regardless of the v0.2.7 fixes.

### Decision (amendment)

Route `kakaocli query` stdout through `preserveBigIntPrecision` (shared with the messages parser) before `JSON.parse`. The function is extended to handle two emission shapes:

1. **Object form** (`kakaocli messages --json`): `"sender_id": 1234567890123456` → `"sender_id": "1234..."` (existing behavior).
2. **Tuple form** (`kakaocli query` 2-D array `[userId, name]`): `[1234567890123456, "name"]` → `["1234...", "name"]` (new).

The tuple-form regex matches the first numeric element of any array literal (the only place 19-digit BigInts appear in tuple position in our query results). It does not affect object-form output, so the messages parser's behavior is unchanged.

### Why this was missed

`tests/sender-resolver.test.ts` had a test ("keys by String(numericId) — both sides observe the same JS-rounded value") that *codified* the wrong assumption — that both sides observe the same lossy rounding, so lookups always align. That assumption stopped being true the moment `preserveBigIntPrecision` was added to the messages path (PR predating v0.2.7) but the resolver test was never updated. v0.2.7's PR #7 hold-back invariant then turned the silent precision drift into a permanently frozen cycle.

The replacement test (`preserves full precision for 19-digit BigInt userIds (regression: dho stuck v0.2.7)`) asserts full-precision round-trip with real-world sender_ids from the dho incident.

### Verification

Live KakaoTalk DB lookup (post-fix):

```
resolveSenderNames(['6321186593654462422', '7372629836270768733', '6763166015463444794'])
→ Map(3) {
    '6321186593654462422' → '드림솔져(헬)',
    '7372629836270768733' → '뀰꿀',
    '6763166015463444794' → '키루파(A)'
  }
```

All three match the daemon's hold-back sample sender_ids from the v0.2.7 incident.

### Consequences (amendment)

**Positive**:
- dho hold-back resolves on next cycle for all senders that have NTUser rows.
- Any other open-chat room with 19-digit sender_ids (most of them) starts working correctly.
- Object-form parser is unchanged — no risk to v0.2.7's harvest path.

**Negative**:
- Bug existed since `preserveBigIntPrecision` was first introduced to the messages path. Any silent data quality drift on prior versions is unrecoverable from logs.
- The tuple-form regex is conservative (first array element only). If future kakaocli queries return BigInt in non-leading positions, this regex won't catch them; a query-shape-specific helper may be required.

### Follow-ups (amendment)

6. Add a CI guard that runs the resolver against fixture stdout containing 19-digit BigInts on every PR, so any future precision regression fails the build.
7. Consider standardizing on a JSON-with-BigInt parser library (e.g. `json-bigint`) for all kakaocli stdout. The regex approach is fragile to emission-shape evolution; a library-level parser would be more robust but adds a dependency.
