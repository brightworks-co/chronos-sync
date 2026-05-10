# chronos-sync

Mac KakaoTalk → Chronos 동기화 데몬. 웹의 **Auto-Upload** 탭에서 룸 매핑·주기·PAT를 관리하고, 이 CLI는 그 설정을 받아 메시지를 업로드합니다.

> **v0.5.0 (2026-05-11)** — 서버 주도 설정으로 전환. v0.4.x `~/.chronos/config.json` 사용자는 [Migration](#migration-v04x--v05x) 섹션을 참고하세요. 자세한 변경점은 [CHANGELOG.md](CHANGELOG.md).

## 요구 사항

| 항목 | 버전 |
|------|------|
| macOS | 12 Monterey 이상 |
| Node.js | 20.0.0 이상 |
| kakaocli | 최신 권장 |
| KakaoTalk (Mac) | 실행 중 |
| Chronos 계정 | PAT 발급 가능한 권한 |

## 설치 (greenfield, v0.5.0)

```bash
npm install -g @brightworks/chronos-sync@next
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
| `chronos-sync migrate` | v0.4.x `config.json` → auth-mode 일회성 변환. `--dry-run`, `--force`. |
| `chronos-sync daemon` | launchd 호환 백그라운드 모드. 일반 사용자 비권장. |
| `chronos-sync status` | 룸별 마지막 동기화 시각. |
| `chronos-sync health` | 헬스 체크 (JSON). 실패 시 exit 1. |
| `chronos-sync interval <초> \| --get` | 주기 직접 PUT/GET (legacy-mode 잔존). auth-mode에서는 웹 UI 사용 권장. |
| `chronos-sync diagnose senders [chat]` | `참여자_<id>` 폴백 원인 분석. |
| `chronos-sync harvest` | KakaoTalk UI 자동 스크롤 1회 (수동 backfill). |
| `chronos-sync version` / `--version` / `-v` | 버전. |
| `chronos-sync help` / `--help` / `-h` | 도움말. |

각 서브커맨드의 상세 도움말은 `chronos-sync <cmd> --help`.

## Migration (v0.4.x → v0.5.x)

v0.4.x는 `~/.chronos/config.json`에 `pat`과 `rooms`를 직접 적었습니다. v0.5.0부터는 PAT는 Keychain, 룸/주기는 서버에서 관리합니다.

```bash
chronos-sync migrate --dry-run    # 변경 내용 미리 보기 (서버/Keychain/FS 무변경)
chronos-sync migrate              # 실행. legacy config.json은 .legacy.bak.<ts>로 rename.
chronos-sync                      # foreground 재시작 — auth-mode로 부팅
```

`migrate`가 하는 일 (요약):

1. 실행 중 데몬 검출 — `--force` 없이는 거부.
2. legacy `config.json` 파싱.
3. 서버 pre-flight (eligible projects 확인) → archived 룸은 자동 제외.
4. (옵션) Y/n 확인.
5. PUT `/api/account/auto-upload/rooms` (legacy PAT 사용).
6. PUT `/api/account/settings/sync` (legacy interval).
7. GET `/api/auto-upload/bootstrap` → `user_email` 추출.
8. PAT를 Keychain에 저장 (또는 `--allow-file-pat`로 0600 파일).
9. `~/.chronos/auth.json` 작성.
10. `~/.chronos/config.json` → `config.json.legacy.bak.<timestamp>`로 rename.

step 5-9 중 하나라도 실패하면 step 10(rename)은 실행되지 않고 legacy `config.json`은 그대로 보존됩니다. 사용자는 원인을 해결한 뒤 동일한 명령으로 재시도하면 됩니다 (idempotent).

> **호환 윈도우:** v0.5.x는 legacy `config.json`을 deprecation 배너와 함께 계속 받아들입니다. v0.6.0부터 거부됩니다. v0.6.0 컷오버 시점은 별도 공지 (adoption 지표 ≥80%/14d 기준).

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

### Legacy config 감지 (`Legacy config.json detected`)

`chronos-sync auth` 호출 시 `~/.chronos/config.json`에 `pat` 또는 `rooms`가 남아 있으면 거부됩니다 (PR5 precondition). 먼저 `chronos-sync migrate`로 변환하거나, 이미 인증이 끝났다면 legacy 파일을 직접 옮기세요:

```bash
mv ~/.chronos/config.json ~/.chronos/config.json.legacy.bak
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

### 데몬 실행 중 migrate 시도 (`daemon is running`)

```bash
launchctl unload ~/Library/LaunchAgents/com.brightworks.chronos-sync.plist
chronos-sync migrate
launchctl load ~/Library/LaunchAgents/com.brightworks.chronos-sync.plist
```

또는 `chronos-sync migrate --force` (running daemon이 같은 `~/.chronos`에 동시 쓰기를 할 수 있다는 점 감수).

### Sender 미해결 — 룸이 `consecutive_stuck_cycles` 증가

`chronos-sync diagnose senders <chat>`로 어떤 sender_id가 NTUser에 매칭되지 않는지 확인. 일시적이라면 `chronos-sync harvest`로 강제 backfill.

## 환경변수

| 변수 | 효과 |
|---|---|
| `CHRONOS_HOME` | `~/.chronos` 대신 사용할 경로. read-only HOME 우회. |
| `CHRONOS_ALLOW_FILE_PAT=1` | `--allow-file-pat`과 동일 — Keychain 불가 시 0600 파일에 PAT 저장 동의. |
| `CHRONOS_NO_CAFFEINATE=1` | foreground 모드에서 macOS idle sleep 방지를 위한 `caffeinate` 자동 attach 비활성화. |

## ~/.chronos 레이아웃 (v0.5.x)

```
~/.chronos/
  auth.json              v0.5.0+ 필수. mode 0600. server_url, user_email, pat_hash_prefix, pat_storage, allow_file_pat, written_at.
  auth.token             pat_storage='file' 일 때만. mode 0600. PAT 본문 (Keychain 대체).
  config.cache.json      bootstrap snapshot. mode 0600. server_url, user_email, interval_seconds, rooms, etag, fetched_at, last_successful_fetch.
  state.json             데몬-관리. 룸별 cursor + 사이클 상태.
  chronos-sync.lock      single-instance PID lock.
  config.json.legacy.bak.<ts>   migrate 후 보관용.
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
