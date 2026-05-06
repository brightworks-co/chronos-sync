# chronos-sync

Mac KakaoTalk 메시지를 Chronos 서버로 자동 동기화하는 CLI 데몬입니다.  
[kakaocli](https://github.com/silver-flight-group/kakaocli)를 통해 Mac KakaoTalk 로컬 DB를 읽고, 지정한 채팅방의 메시지를 주기적으로 업로드합니다.

## 요구 사항

| 항목 | 버전 |
|------|------|
| macOS | 12 Monterey 이상 |
| Node.js | 20.0.0 이상 |
| kakaocli | 최신 버전 권장 |
| KakaoTalk (Mac) | 실행 중 상태 유지 |

## 설치

```bash
npm install -g @brightworks/chronos-sync
```

설치 확인:

```bash
chronos-sync --version
```

## 설정

설정 파일 위치: `~/.chronos/config.json`

디렉터리가 없으면 먼저 생성합니다:

```bash
mkdir -p ~/.chronos
```

### 기본 설정 예시

```json
{
  "server_url": "https://your-chronos-server.example.com",
  "pat": "chr_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "interval_seconds": 300,
  "rooms": [
    {
      "chat_name": "팀 채팅방",
      "project_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "room_name": "team-chat"
    }
  ]
}
```

### 설정 필드 설명

| 필드 | 필수 | 설명 |
|------|------|------|
| `server_url` | 필수 | Chronos 서버 주소 |
| `pat` | 필수 | Chronos API 키 (`chr_pat_`으로 시작하는 32자 hex) |
| `interval_seconds` | 선택 | 동기화 주기(초). 기본값 `300`, 범위 `10`–`3600` |
| `kakaocli_path` | 선택 | kakaocli 바이너리 경로. 생략 시 `$PATH`에서 탐색 |
| `since` | 선택 | `--since` 윈도우 세부 조정 ([아래 참고](#since-옵션)) |
| `rooms` | 필수 | 동기화할 채팅방 목록 (1개 이상) |

### rooms 필드

| 필드 | 필수 | 설명 |
|------|------|------|
| `chat_name` | `chat_id` 없을 때 필수 | kakaocli에서 표시되는 채팅방 이름 |
| `chat_id` | `chat_name` 없을 때 필수 | 카카오 채팅방 고유 ID (오픈채팅은 반드시 사용) |
| `project_id` | 필수 | Chronos 프로젝트 UUID |
| `room_name` | 필수 | Chronos 내부 룸 슬러그 |
| `kakao_original_name` | 선택 | 오픈채팅 원본 이름 (일관성 검증용) |

> **오픈채팅방 주의**: 오픈채팅은 `kakaocli chats --json`에서 이름이 `(unknown)`으로 표시됩니다.  
> 이 경우 `chat_name` 대신 `chat_id`를 사용해야 합니다.  
> `chat_id`는 정밀도 손실 방지를 위해 **반드시 문자열**로 입력하세요.

```json
{
  "chat_id": "18296430865364356",
  "project_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "room_name": "open-chat-room"
}
```

### since 옵션

첫 동기화 시 `--since` 윈도우를 조정할 때 사용합니다.

```json
{
  "since": {
    "multiplier": 2,
    "override_seconds": 0
  }
}
```

| 필드 | 설명 |
|------|------|
| `multiplier` | `interval_seconds`에 곱해 폴백 윈도우 계산. 기본값 `2` |
| `override_seconds` | 윈도우를 이 값으로 고정. `0`이면 kakaocli 기본 페이지 사용 |

## 명령어

### 기본 실행 (포그라운드 모드)

```bash
chronos-sync
```

또는 동일하게:

```bash
chronos-sync run
chronos-sync start
```

터미널에서 동기화 상태를 실시간으로 출력합니다.  
**Ctrl+C** 또는 터미널을 닫으면 락을 해제하고 정상 종료됩니다.

---

### status — 동기화 상태 확인

```bash
chronos-sync status
```

설정된 각 채팅방의 마지막 동기화 시각과 연속 실패 횟수를 표시합니다.

---

### health — 헬스 체크

```bash
chronos-sync health
```

JSON 형식으로 데몬 상태를 출력합니다. 이상 감지 시 exit code 1로 종료됩니다.

---

### version — 버전 확인

```bash
chronos-sync version
chronos-sync --version
chronos-sync -v
```

---

### help — 도움말

```bash
chronos-sync help
chronos-sync --help
chronos-sync -h
```

---

### daemon — 백그라운드 모드 (launchd 전용)

```bash
chronos-sync daemon
```

> launchd plist와의 호환성 유지를 위해 존재합니다.  
> **일반 사용자는 이 명령을 직접 실행하지 않아도 됩니다.** 터미널에서는 인자 없이 `chronos-sync`를 실행하세요.

## 파일 위치

| 파일 | 경로 | 설명 |
|------|------|------|
| 설정 파일 | `~/.chronos/config.json` | 사용자가 직접 편집 |
| 상태 파일 | `~/.chronos/state.json` | 데몬이 자동 관리 (편집 불필요) |
| 락 파일 | `~/.chronos/chronos-sync.lock` | 단일 인스턴스 보장용 |

## 단일 인스턴스 동작

chronos-sync는 동시에 하나의 프로세스만 허용합니다.  
이미 실행 중인 인스턴스가 있으면 새 실행이 즉시 종료됩니다.  
프로세스가 비정상 종료된 경우 스테일 락은 자동으로 재취득됩니다.

## 문제 해결

**`config.pat missing or malformed` 오류**  
API 키가 `chr_pat_`으로 시작하는지 확인하세요.

**오픈채팅방 이름이 `(unknown)`으로 나옴**  
`chat_name` 대신 `chat_id`를 문자열로 입력하세요.

**`chat_id` 정밀도 손실 경고**  
채팅 ID가 큰 숫자인 경우 JSON에서 반드시 따옴표로 감쌉니다: `"chat_id": "18296430865364356"`

**kakaocli를 찾을 수 없음**  
`kakaocli_path` 필드에 바이너리 전체 경로를 지정하거나, `$PATH`에 kakaocli가 있는지 확인하세요.

## 라이선스

MIT
