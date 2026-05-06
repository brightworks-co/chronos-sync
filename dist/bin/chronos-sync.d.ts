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
 *   daemon                Background loop for launchd. Deprecated for human use;
 *                         retained so existing launchd plists keep working.
 *   daemon --status       Raw JSON daemon snapshot (internal).
 *   status                Pretty per-room sync status (one-shot).
 *   health                Health check verdict.
 *   version               Print version.
 */
export {};
