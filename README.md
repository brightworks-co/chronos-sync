# chronos-sync

Mac KakaoTalk → Chronos 동기화 데몬. 웹의 **Auto-Upload** 탭에서 룸 매핑·주기·PAT를 관리하고, 이 CLI는 그 설정을 받아 메시지를 업로드합니다.

> **v0.6.0 (2026-05-11)** — legacy `~/.chronos/config.json` 지원 종료. v0.4.x 사용자는 [Migration](#migration-v04x--v06x) 섹션을 참고하세요 (v0.5.x를 경유). 자세한 변경점은 [CHANGELOG.md](CHANGELOG.md).

## 요구 사항

| 항목 | 버전 |
|------|------|
| macOS | 12 Monterey 이상 |
| Node.js | 20.0.0 이상 |
| kakaocli | 최신 권장 |
| KakaoTalk (Mac) | 실행 중 |
| Chronos 계정 | PAT 발급 가능한 권한 |

## 설치 (greenfield, v0.6.0)

```bash
npm install -g @brightworks/chronos-sync@latest
```

설치 확인:

```bash
chronos-sync --version
```

## 빠른 시작 (4 step)

1. **PAT 발급** — `https://chronos.brightworks.app/account/api/tokens`에서 새 토큰을 만듭니다 (`chr_pat_<32hex>` 형식). PAT는 한 번만 표시되니 즉시 클립보드에 복사하세요.
2. **웹에서 Auto-Upload 설정** — `https://chronos.brightworks.app/account/auto-upload`에서 룸 매핑(KakaoTalk chat_id ↔ Chronos `project_id/room_name`)과 동기화 주기를 입력합니다.
3. **PAT 등록** — Mac 터미널에서:
   ```bash
   chronos-sync auth                        # 대화형 (입력 숨김)
   pbpaste | chronos-sync auth --from-stdin # 또는 클립보드에서
   ```
   PAT는 macOS Keychain에 저장됩니다. Keychain 사용이 불가하면 `--allow-file-pat`으로 mode-0600 파일 저장에 명시적으로 동의해야 합니다.
4. **데몬 기동** —
   ```bash
   chronos-sync                             # foreground (Ctrl+C로 종료)
   ```
   상시 백그라운드는 launchd plist를 만들어 `chronos-sync daemon`을 등록합니다. 예시 plist는 아래 [launchd 등록](#launchd-등록-선택) 참조.

## 명령어 요약

| 명령 | 설명 |
|---|---|
| `chronos-sync` (= `run` / `start`) | foreground 동기화 루프. 추천 진입점. |
| `chronos-sync auth [<PAT>]` | PAT 등록. `--from-stdin`, `--token`, `--reset`, `--allow-file-pat`, `--server-url`. |
| `chronos-sync daemon` | launchd 호환 백그라운드 모드. 일반 사용자 비권장. |
| `chronos-sync status` | 룸별 마지막 동기화 시각. |
| `chronos-sync health` | 헬스 체크 (JSON). 실패 시 exit 1. |
| `chronos-sync interval <초> \| --get` | 주기 직접 PUT/GET. auth-mode에서는 웹 Auto-Upload 탭 사용 권장. |
| `chronos-sync diagnose senders [chat]` | `참여자_<id>` 폴백 원인 분석. |
| `chronos-sync harvest` | KakaoTalk UI 자동 스크롤 1회 (수동 backfill). |
| `chronos-sync version` / `--version` / `-v` | 버전. |
| `chronos-sync help` / `--help` / `-h` | 도움말. |

각 서브커맨드의 상세 도움말은 `chronos-sync <cmd> --help`.

## Migration (v0.4.x → v0.6.x)

v0.6.0은 legacy `~/.chronos/config.json`을 더 이상 받지 않습니다. v0.4.x에서 직접 v0.6.x로 올라갈 수는 없으므로 v0.5.x의 `chronos-sync migrate`를 한 번 거쳐야 합니다.

```bash
npm install -g @brightworks/chronos-sync@0.5      # 마지막 v0.5.x로 잠시 내림
chronos-sync migrate --dry-run                    # (선택) 변경 미리 보기
chronos-sync migrate                              # 실행 — config.json → auth.json + Keychain
npm install -g @brightworks/chronos-sync@latest   # v0.6.x로 다시 올림
chronos-sync                                      # auth-mode로 부팅
```

`v0.5.x migrate`가 하는 일은 [v0.5.0 CHANGELOG](CHANGELOG.md#050-2026-05-11) 참조. step 5-9 중 어느 하나라도 실패하면 legacy `config.json`은 보존됩니다 (idempotent — 원인 해결 후 재실행).

수동 경로 (advanced): 새 PAT를 발급한 뒤 `mv ~/.chronos/config.json ~/.chronos/config.json.legacy.bak`, `chronos-sync auth chr_pat_…`. 룸 매핑은 웹 Auto-Upload 탭에서 다시 입력합니다.

## Troubleshooting

### Keychain 사용 불가 (`Keychain unavailable`)

원인: `security` CLI가 PATH에 없거나, 사용자 keychain이 잠겨 있거나, headless/CI 환경.

```bash
# 일회성 — 위험을 감수하고 file 저장 (mode 0600 inside ~/.chronos/ mode 0700)
chronos-sync auth --allow-file-pat

# 환경변수로 설정
CHRONOS_ALLOW_FILE_PAT=1 chronos-sync auth
```

shared host에서는 권장하지 않습니다.

### Legacy config 감지 (`Legacy v0.4.x config.json detected`)

v0.6.0에서 `~/.chronos/config.json`이 발견되면 daemon은 즉시 `LegacyConfigDetectedError`로 종료합니다. 위 [Migration](#migration-v04x--v06x) 섹션의 v0.5.x 경유 절차를 따르거나, 새 PAT를 발급한 뒤 legacy 파일을 직접 치우세요:

```bash
mv ~/.chronos/config.json ~/.chronos/config.json.legacy.bak
chronos-sync auth chr_pat_…
```

### Bootstrap cache stale > 24h (`bootstrap cache stale > 24h; check network`)

서버 outage가 24h 이상 지속되면 데몬이 업로드를 거부하고 exit 1로 종료합니다. 네트워크 복구 후 `chronos-sync` 재실행 시 첫 cycle에서 prime 성공하면 다시 동작합니다. 24h 미만 outage는 정상 동작 (캐시 사용 + foreground UI에 `stale` 경고).

### 401 — PAT 거부 (`PAT rejected by server`)

웹에서 PAT가 revoke됐거나 scope이 축소된 경우. cache가 자동 무효화 (`config.cache.json` → `.invalidated.<ts>`로 rename) 되고 데몬이 종료합니다. 새 PAT를 발급한 뒤:

```bash
chronos-sync auth --reset    # 기존 룸 등록 해제 후 재등록
# 또는 단순 재인증
chronos-sync auth
```

### `~/.chronos` 권한 오류 (`cannot create ~/.chronos: permission denied`)

대개 root 소유로 만들어진 디렉터리:

```bash
sudo chown -R "$(whoami)" ~/.chronos && chmod 700 ~/.chronos
chronos-sync auth
```

`HOME`이 read-only 볼륨이면 `CHRONOS_HOME=<writable path>` 환경변수로 우회:

```bash
CHRONOS_HOME=/var/cache/chronos-sync chronos-sync auth
CHRONOS_HOME=/var/cache/chronos-sync chronos-sync
```

### Sender 미해결 — 룸이 `consecutive_stuck_cycles` 증가

`chronos-sync diagnose senders <chat>`로 어떤 sender_id가 NTUser에 매칭되지 않는지 확인. 일시적이라면 `chronos-sync harvest`로 강제 backfill.

## 환경변수

| 변수 | 효과 |
|---|---|
| `CHRONOS_HOME` | `~/.chronos` 대신 사용할 경로. read-only HOME 우회. |
| `CHRONOS_ALLOW_FILE_PAT=1` | `--allow-file-pat`과 동일 — Keychain 불가 시 0600 파일에 PAT 저장 동의. |
| `CHRONOS_NO_CAFFEINATE=1` | foreground 모드에서 macOS idle sleep 방지를 위한 `caffeinate` 자동 attach 비활성화. |

## ~/.chronos 레이아웃 (v0.6.x)

```
~/.chronos/
  auth.json              필수. mode 0600. server_url, user_email, pat_hash_prefix, pat_storage, allow_file_pat, written_at.
  auth.token             pat_storage='file' 일 때만. mode 0600. PAT 본문 (Keychain 대체).
  config.cache.json      bootstrap snapshot. mode 0600. server_url, user_email, interval_seconds, rooms, etag, fetched_at, last_successful_fetch.
  state.json             데몬-관리. 룸별 cursor + 사이클 상태.
  chronos-sync.lock      single-instance PID lock.
  config.json.legacy.bak.<ts>   v0.5.x migrate 후 보관 (v0.6.x에서 직접 사용 안 함).
```

## launchd 등록 (선택)

```xml
<!-- ~/Library/LaunchAgents/com.brightworks.chronos-sync.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>      <string>com.brightworks.chronos-sync</string>
  <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/chronos-sync</string>
      <string>daemon</string>
    </array>
  <key>KeepAlive</key>  <true/>
  <key>StandardOutPath</key> <string>/tmp/chronos-sync.out</string>
  <key>StandardErrorPath</key> <string>/tmp/chronos-sync.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.brightworks.chronos-sync.plist
```

## 라이센스

MIT.
