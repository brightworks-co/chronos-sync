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
 *   interval <seconds>    Set sync interval via web KV PUT (10~3600).
 *   interval --get        Show current sync interval from web KV.
 *   diagnose senders [chat]  Inspect 참여자_<id> fallback for a configured room.
 *   version               Print version.
 */
import { VERSION } from '../src/constants.js';
const [, , cmd, ...args] = process.argv;
switch (cmd) {
    case undefined:
    case 'run':
    case 'start':
        runForeground();
        break;
    case 'daemon':
        if (args.includes('--status')) {
            import('../src/state-file.js').then(async (m) => {
                const state = await m.loadState();
                const started = state.daemon.started_at
                    ? new Date(state.daemon.started_at).toISOString()
                    : 'never';
                const lastCycle = state.daemon.last_cycle_at
                    ? new Date(state.daemon.last_cycle_at).toISOString()
                    : 'never';
                process.stdout.write(JSON.stringify({ started_at: started, last_cycle_at: lastCycle, rooms: state.rooms }, null, 2) + '\n');
            }).catch((err) => {
                process.stderr.write('chronos-sync: status error: ' + String(err) + '\n');
                process.exit(1);
            });
        }
        else {
            process.stderr.write('\x1b[33m!\x1b[0m "chronos-sync daemon"은 launchd 호환용으로만 유지됩니다. ' +
                '터미널에서 직접 사용하실 때는 인자 없이 "chronos-sync"를 실행하세요.\n');
            import('../src/daemon.js').then((m) => m.main()).catch((err) => {
                process.stderr.write('chronos-sync: daemon error: ' + String(err) + '\n');
                process.exit(1);
            });
        }
        break;
    case 'status':
        import('../src/cli/status.js').then((m) => m.runStatus()).catch((err) => {
            process.stderr.write('chronos-sync: status error: ' + String(err) + '\n');
            process.exit(1);
        });
        break;
    case 'interval':
        import('../src/cli/interval.js').then(async (m) => {
            const result = args[0] === '--get' || args.length === 0
                ? await m.runIntervalGet()
                : await m.runIntervalSet(args[0]);
            process.exit(result.exitCode);
        }).catch((err) => {
            process.stderr.write('chronos-sync: interval error: ' + String(err) + '\n');
            process.exit(1);
        });
        break;
    case 'diagnose':
        if (args[0] !== 'senders') {
            process.stderr.write('지원되는 진단: chronos-sync diagnose senders [<chat-name | chat-id>]\n');
            process.exit(1);
        }
        import('../src/cli/diagnose-senders.js').then(async (m) => {
            const result = await m.runDiagnoseSenders(args[1]);
            process.exit(result.exitCode);
        }).catch((err) => {
            process.stderr.write('chronos-sync: diagnose error: ' + String(err) + '\n');
            process.exit(1);
        });
        break;
    case 'harvest':
        import('../src/cli/harvest.js').then(async (m) => {
            const result = await m.runHarvest(args);
            process.exit(result.exitCode);
        }).catch((err) => {
            process.stderr.write('chronos-sync: harvest error: ' + String(err) + '\n');
            process.exit(1);
        });
        break;
    case 'auth':
        Promise.all([
            import('../src/cli/auth.js'),
            import('../src/cli/auth-args.js'),
        ])
            .then(async ([authModule, argsModule]) => {
            const parsed = argsModule.parseAuthArgs(args);
            if (parsed.kind === 'help') {
                printAuthUsage();
                process.exit(0);
            }
            if (parsed.kind === 'invalid') {
                process.stderr.write(`error: ${parsed.message}\n`);
                process.exit(1);
            }
            const result = await authModule.runAuth(parsed.options);
            process.exit(result.exitCode);
        })
            .catch((err) => {
            process.stderr.write('chronos-sync: auth error: ' + String(err) + '\n');
            process.exit(1);
        });
        break;
    case 'health':
        import('../src/state-file.js').then(async (stateModule) => {
            const { checkHealth } = await import('../src/health.js');
            const state = await stateModule.loadState();
            const verdict = checkHealth(state);
            process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
            if (!verdict.healthy) {
                process.exit(1);
            }
        }).catch((err) => {
            process.stderr.write('chronos-sync: health error: ' + String(err) + '\n');
            process.exit(1);
        });
        break;
    case 'version':
    case '--version':
    case '-v':
        process.stdout.write(VERSION + '\n');
        break;
    case 'help':
    case '--help':
    case '-h':
        printUsage();
        break;
    default:
        process.stderr.write(`알 수 없는 명령: ${cmd}\n`);
        printUsage();
        process.exit(1);
}
function printUsage() {
    process.stdout.write(`chronos-sync v${VERSION}

기본 사용:
  chronos-sync              터미널에서 동기화 시작 (Ctrl+C로 종료)

명령어:
  auth [<PAT>]              PAT 등록 (Keychain 우선, --allow-file-pat 시 0600 파일).
                            옵션: --from-stdin, --token <PAT>, --server-url <url>,
                                  --allow-file-pat, --reset, --help
  status                    설정 + 룸별 마지막 동기화 시각
  health                    헬스 체크 결과 (JSON)
  interval <초>             동기화 주기 변경 (10~3600). 데몬 다음 cycle 자동 반영.
  interval --get            현재 동기화 주기 조회 (web KV 기준).
  diagnose senders [chat]   참여자_<id> 폴백 원인 분석 (특정 룸의 sender_id 별 NTUser 매칭)
  harvest                   KakaoTalk UI 자동 스크롤 1회 실행 (수동 backfill).
                            옵션: --top N, --max-clicks N, --scroll-delay S, --dry-run
                            v0.2.9부터 cycle harvest는 default off — 필요 시 이 명령 사용.
  daemon                    백그라운드 루프 (launchd 전용, 일반 사용자 비권장)
  version                   버전 표시
  help                      도움말 표시
`);
}
function printAuthUsage() {
    process.stdout.write(`chronos-sync auth — PAT 등록 + 부트스트랩 프라임

사용:
  chronos-sync auth                        대화형 프롬프트 (입력 숨김)
  chronos-sync auth <PAT>                  PAT를 명령줄로 직접 (셸 히스토리 노출 경고)
  pbpaste | chronos-sync auth --from-stdin 클립보드 / 스크립트용
  chronos-sync auth --reset                기존 PAT의 룸 등록 해제 후 새 PAT로 교체

옵션:
  --token <PAT>             명시적 PAT (--<PAT>와 동일하지만 위치 인자 대신 플래그)
  --from-stdin              stdin 한 줄 읽어서 PAT로 사용
  --server-url <url>        chronos 서버 URL (기본: https://chronos.brightworks.app)
  --allow-file-pat          Keychain 사용 불가 시 ~/.chronos/auth.token (mode 0600)에 저장.
                            CHRONOS_ALLOW_FILE_PAT=1 환경변수도 동일.
  --reset                   기존 auth + Keychain entry 삭제, 등록된 룸 해제, 새 PAT 등록.
  --help                    이 도움말

환경변수:
  CHRONOS_HOME              ~/.chronos 대신 사용할 경로 (read-only HOME 등)
  CHRONOS_ALLOW_FILE_PAT=1  --allow-file-pat과 동일
`);
}
function runForeground() {
    Promise.all([
        import('../src/daemon.js'),
        import('../src/foreground-ui.js'),
    ])
        .then(([daemon, ui]) => {
        const view = ui.createDefaultForegroundUi();
        // The header reads `cfg`, but `runLoop` also loads the config.
        // We pre-load + print, then `runLoop` re-loads internally —
        // simple and robust against a transient FS hiccup between the
        // two loads (each call surfaces its own error message).
        return import('../src/state-file.js').then(async ({ loadConfig }) => {
            let bannerCfg;
            try {
                bannerCfg = await loadConfig();
            }
            catch (err) {
                process.stderr.write('chronos-sync: config load error: ' +
                    (err instanceof Error ? err.message : String(err)) +
                    '\n');
                process.exit(1);
            }
            view.printHeader(bannerCfg);
            let headerRefreshed = false;
            const runOptions = {
                foreground: true,
                // Quiet logger: only surface warnings/errors so the cycle
                // lines stay the primary signal. info-level events (config
                // reload, startup) are intentionally swallowed in fg mode.
                log: (level, msg, ctx) => {
                    if (level === 'info')
                        return;
                    const prefix = level === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m!\x1b[0m';
                    const ctxText = ctx ? ' ' + JSON.stringify(ctx) : '';
                    process.stderr.write(`${prefix} ${msg}${ctxText}\n`);
                },
                onRoom: (result) => {
                    view.printCycleLine({
                        room: result.room,
                        new_messages: result.new_messages,
                        error: result.error,
                    });
                },
                onCycle: (_outcome, resolved) => {
                    if (!headerRefreshed && resolved) {
                        headerRefreshed = true;
                        view.printHeader(bannerCfg, resolved);
                    }
                },
                onHarvest: (info) => {
                    if (info.reason === 'rate_limited_skip')
                        return;
                    process.stdout.write(`\x1b[33m⤴\x1b[0m harvest 호출: ${info.roomName} (reason: ${info.reason}` +
                        (info.code !== undefined ? `, code: ${info.code}` : '') +
                        ')\n');
                },
                // exit_on_health_failure stays false → the loop keeps trying;
                // the user can Ctrl+C if it's truly stuck.
            };
            // Hook Ctrl+C / terminal close to the friendly farewell. The
            // daemon module also installs SIGINT/SIGTERM handlers that
            // release the lock + exit, so this handler must run *first*
            // (process.on stacks listeners — first registered runs first).
            const farewell = () => {
                view.printShutdown();
            };
            process.on('SIGINT', farewell);
            process.on('SIGTERM', farewell);
            process.on('SIGHUP', farewell);
            await daemon.runLoop(runOptions);
        });
    })
        .catch((err) => {
        process.stderr.write('chronos-sync: foreground error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n');
        process.exit(1);
    });
}
