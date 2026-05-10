#!/usr/bin/env node
/**
 * chronos-sync CLI entry point.
 *
 * Default invocation (`chronos-sync` with no args) runs the foreground
 * mode: a pretty-printed loop the user keeps open in a terminal.
 * Hitting Ctrl+C — or just closing the terminal — releases the lock
 * and exits cleanly.
 *
 * Subcommands:
 *   (none) | run | start  Foreground mode (default — the user-facing entry).
 *   auth [<PAT>]          Register a PAT (Keychain happy path; `--allow-file-pat`
 *                         opt-in falls back to mode 0600 file). v0.5.0+.
 *   migrate               One-shot v0.4.x config.json → auth-mode conversion.
 *                         `--dry-run` prints intended changes without touching
 *                         server/Keychain/FS. `--force` skips daemon detect +
 *                         confirm prompt. v0.5.0+.
 *   daemon                Background loop for launchd. Deprecated for human use;
 *                         retained so existing launchd plists keep working.
 *   daemon --status       Raw JSON daemon snapshot (internal).
 *   status                Pretty per-room sync status (one-shot).
 *   health                Health check verdict.
 *   interval <seconds>    Set sync interval via web KV PUT (10~3600).
 *   interval --get        Show current sync interval from web KV.
 *   diagnose senders [chat]  Inspect 참여자_<id> fallback for a configured room.
 *   version               Print version.
 */
export {};
