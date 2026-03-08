# 🎙️ Discord 라이브 회의 노트 테이킹 봇

ElevenLabs Scribe v2 Realtime STT(Speech-to-Text) API를 활용한 디스코드 회의 자동 기록 봇입니다.  
음성 채널의 대화를 실시간으로 전사하고, 회의 종료 시 LLM 기반 자동 요약 노트를 생성합니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 🎙️ 음성 전사 | 음성 채널 대화를 ElevenLabs Scribe v2로 실시간 전사 |
| 💬 채팅 수집 | 텍스트 채널의 사람 메시지도 함께 수집 |
| 📋 LLM 요약 | 회의 종료 시 OpenRouter(Claude) 기반 자동 요약 노트 생성 |
| 📄 통합 회의록 | 음성 전사 + 채팅을 통합한 `.txt` 파일 첨부 |
| 🔒 DAVE E2EE | Discord 암호화 음성(DAVE 프로토콜) 완전 지원 |
| ⏹️ 자동 종료 | 봇만 남으면 2분 후 자동으로 회의 종료 |

---

## 슬래시 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/meeting-start` | 현재 접속 중인 음성 채널에서 회의 기록 시작 |
| `/meeting-stop` | 회의 기록 종료 + 요약 노트 생성 |
| `/meeting-status` | 현재 회의 기록 상태 확인 (경과시간, 발언 수, 화자) |

---

## 사전 준비

이 봇을 사용하려면 4가지 키가 필요합니다:

### 1. Discord 봇 생성 및 토큰 발급

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. 우측 상단 **New Application** 클릭 → 이름 입력 (예: `회의 노트봇`) → **Create**
3. 좌측 메뉴 **Bot** 클릭
4. **Reset Token** 클릭 → 봇 토큰 복사 → 안전한 곳에 저장  
   ⚠️ 이 토큰은 한 번만 표시됩니다. 분실 시 재발급 필요.
5. 같은 페이지에서 **Privileged Gateway Intents** 섹션:
   - ✅ **SERVER MEMBERS INTENT** 켜기
   - ✅ **MESSAGE CONTENT INTENT** 켜기
6. 좌측 메뉴 **General Information** 에서 **APPLICATION ID** 복사 → 이것이 `DISCORD_CLIENT_ID`

### 2. 봇을 디스코드 서버에 초대

1. 좌측 메뉴 **OAuth2** → **URL Generator** 클릭
2. **SCOPES** 에서 체크:
   - ✅ `bot`
   - ✅ `applications.commands`
3. **BOT PERMISSIONS** 에서 체크:
   - ✅ Connect (음성 채널 접속)
   - ✅ Speak (음성 채널 활동)
   - ✅ Use Voice Activity
   - ✅ Send Messages (텍스트 전송)
   - ✅ Attach Files (전사록 파일 첨부)
   - ✅ Embed Links (요약 임베드 전송)
4. 하단에 생성된 **URL을 복사** → 브라우저에서 열기 → 서버 선택 → **승인**

### 3. ElevenLabs API 키 발급

1. [elevenlabs.io](https://elevenlabs.io) 접속 → 회원가입
2. 대시보드 **Profile + API key** 에서 API 키 복사
3. 가격: **$0.28/시간** (STT Scribe v2 Realtime 기준)

### 4. OpenRouter API 키 발급

1. [openrouter.ai](https://openrouter.ai) 접속 → 회원가입
2. **Keys** 페이지에서 API 키 생성
3. 회의 종료 시 LLM 요약 생성에 사용 (기본 모델: `anthropic/claude-opus-4.6`)

---

## 사용 방법

### 회의 시작하기

1. 디스코드에서 **음성 채널에 먼저 접속**합니다
2. 아무 텍스트 채널에서 `/meeting-start` 입력
3. 봇이 음성 채널에 참가하고, 전사가 시작됩니다
4. 전사 결과는 서버 로그에 기록됩니다 (채팅 출력 비활성화)

```
🎙️ 회의 기록 시작
음성 채널: 일반 음성
시작자: username#1234
텍스트 채널: #회의록

회의 내용이 실시간으로 전사됩니다.
종료하려면 /meeting-stop을 입력하세요.
```

### 회의 상태 확인

회의 중에 `/meeting-status` 를 입력하면:

```
📊 회의 기록 상태
🎙️ 음성 채널: 일반 음성
👤 시작자: username#1234
⏱️ 경과 시간: 15:30
🗣️ 발언 수: 42건
👥 감지된 화자: 유저A, 유저B
🌐 언어: ko
```

### 회의 종료하기

1. `/meeting-stop` 입력
2. 봇이 ElevenLabs 세션을 종료하고 LLM 요약을 생성합니다
3. 다음이 텍스트 채널에 전송됩니다:

**통합 요약 임베드 (회의 정보 + LLM 요약 통합):**
```
📋 회의 요약 노트
⏱️ 32:15  ·  👥 유저A, 유저B  ·  🗣️ 발언 87건  ·  🌐 ko

───

📌 핵심 요약
오늘 회의에서는 Q2 마케팅 전략에 대해 논의했습니다. ...

📋 주요 논의 사항
- ...

✅ 결정 사항 / 액션 아이템
- ...
```

**통합 회의록 파일:**
```
📄 전체 회의 기록이 첨부되었습니다.
📎 회의록_2026-03-07_1430.txt
```

회의록 파일에는 음성 전사와 텍스트 채팅이 구분되어 포함됩니다:
```
═══ 음성 전사 ═══

[00:00] 유저A: 안녕하세요, 오늘 회의 시작하겠습니다.
[00:06] 유저B: 네, 먼저 지난주 진행사항부터 공유드릴게요.

═══ 텍스트 채팅 ═══

[14:30] 유저C: 관련 자료 링크 공유합니다.
```

### 자동 종료

봇만 음성 채널에 남으면 **2분 후 자동으로 회의가 종료**됩니다.  
이때에도 요약 노트와 회의록 파일이 정상적으로 생성됩니다.

---

## 설치 및 배포

### 방법 1: Railway 배포 (권장)

이미 Railway에 배포 준비가 되어 있습니다.

1. [Railway](https://railway.app) 대시보드에서 프로젝트 확인
2. **Variables** 탭에서 환경변수 설정:
   ```
   DISCORD_TOKEN=봇_토큰
   DISCORD_CLIENT_ID=앱_ID
   ELEVENLABS_API_KEY=ElevenLabs_API_키
   OPENROUTER_API_KEY=OpenRouter_API_키
   OPENROUTER_MODEL=anthropic/claude-opus-4.6
   ```
3. GitHub에 push하면 자동으로 빌드 및 배포됩니다

**슬래시 커맨드 등록 (최초 1회 필요):**

Railway 배포 후, 로컬 PC에서 한 번 실행하거나 Railway Shell에서:
```bash
DISCORD_TOKEN=봇_토큰 DISCORD_CLIENT_ID=앱_ID node register-commands.js
```

### 방법 2: 로컬 실행

```bash
# 저장소 클론
git clone https://github.com/leepacific/discord-meeting-bot.git
cd discord-meeting-bot

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 열어서 4개의 키를 입력

# 슬래시 커맨드 등록 (최초 1회)
npm run register

# 봇 실행
npm start
```

### .env 파일 예시

```env
DISCORD_TOKEN=MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXX
DISCORD_CLIENT_ID=123456789012345678
ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_MODEL=anthropic/claude-opus-4.6
```

---

## 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `DISCORD_TOKEN` | ✅ | Discord 봇 토큰 |
| `DISCORD_CLIENT_ID` | ✅ | Discord 애플리케이션 ID |
| `ELEVENLABS_API_KEY` | ✅ | ElevenLabs API 키 (STT용) |
| `OPENROUTER_API_KEY` | ✅ | OpenRouter API 키 (LLM 요약용) |
| `OPENROUTER_MODEL` | ❌ | LLM 모델 (기본값: `anthropic/claude-opus-4.6`) |

---

## 프로젝트 구조

```
discord-meeting-bot/
├── index.js                    # 봇 메인 (슬래시 커맨드 핸들링, 세션 관리)
├── register-commands.js        # 슬래시 커맨드 Discord 등록 (최초 1회)
├── package.json
├── Dockerfile                  # Railway/Docker 배포용
├── .env.example                # 환경변수 템플릿
├── .gitignore
└── src/
    ├── config.js               # 환경변수 로드 및 ElevenLabs/OpenRouter 설정
    ├── voiceHandler.js          # Discord 음성 채널 접속, Opus→PCM 변환, DAVE E2EE
    ├── elevenlabsClient.js      # ElevenLabs Scribe v2 Realtime WebSocket STT 클라이언트
    ├── transcriptManager.js     # 전사 결과 관리, 통계 집계 (채팅 출력 비활성화)
    ├── chatCollector.js         # 텍스트 채널 채팅 수집기
    ├── llmSummarizer.js         # OpenRouter LLM 회의 요약 생성기
    ├── summaryGenerator.js      # 통합 요약 임베드 + 회의록 파일 생성
    └── gladiaClient.js          # (레거시) 이전 Gladia STT 클라이언트 — 사용하지 않음
```

---

## 아키텍처

```
Discord 음성 채널 (Opus 48kHz stereo, DAVE E2EE)
        │
        ▼
  voiceHandler.js
  ├─ DAVE 복호화 (@snazzah/davey)
  ├─ Opus → PCM 디코딩 (opusscript + prism-media)
  ├─ 48kHz stereo → 16kHz mono 다운샘플링
  ├─ 유저별 SSRC → 화자 구분
  └─ 100ms 간격으로 모노 믹스다운 후 전송
        │
        ▼  PCM 16kHz mono (base64 JSON)
  elevenlabsClient.js
  ├─ WebSocket: wss://api.elevenlabs.io/v1/speech-to-text/realtime
  ├─ 인증: xi-api-key 헤더
  ├─ 오디오: {"message_type":"input_audio_chunk","audio_base_64":"..."}
  ├─ VAD 기반 자동 커밋 (무음 1.0초 → committed_transcript 수신)
  ├─ Keep-alive: 25초 무활동 시 무음 패킷 전송
  └─ 종료: commit:true 플러시 → 2초 대기 → ws.close(1000)
        │
        ▼  committed_transcript
  transcriptManager.js
  ├─ 전사 결과 축적 (entries 배열)
  ├─ 화자별 이름 매핑 (Discord 닉네임)
  ├─ 실시간 채팅 출력: 비활성화 (서버 로그에만 기록)
  └─ 통계 집계 (발언 수, 화자, 경과시간)
        │
        ▼  회의 종료 (/meeting-stop)
  chatCollector.js → 텍스트 채팅 수집 결과 반환
  llmSummarizer.js → OpenRouter API로 LLM 요약 생성
  summaryGenerator.js
  ├─ 통합 임베드: 회의 정보 헤더 + LLM 요약 (단일 임베드)
  └─ 회의록 .txt 파일: 음성 전사 + 채팅 통합
```

---

## ElevenLabs Scribe v2 Realtime 설정

`src/config.js`에서 STT 관련 설정을 조정할 수 있습니다:

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `modelId` | `scribe_v2_realtime` | ElevenLabs STT 모델 |
| `languageCode` | `ko` | 인식 언어 (제거하면 자동 감지) |
| `commitStrategy` | `vad` | 음성 구간 자동 감지로 전사 커밋 |
| `vadSilenceThresholdSecs` | `1.0` | 무음 감지 후 커밋까지 대기 시간 (초) |
| `vadThreshold` | `0.4` | VAD 감도 (0.0~1.0, 낮을수록 민감) |

### ElevenLabs WebSocket 프로토콜 요약

- **엔드포인트**: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
- **인증**: WebSocket handshake 시 `xi-api-key` 헤더에 API 키 전달
- **오디오 형식**: PCM 16kHz 16-bit mono, base64 인코딩
- **전송 형식**: `{"message_type":"input_audio_chunk","audio_base_64":"<base64>"}`
- **수신 메시지 타입** (`message_type` 필드):
  - `session_started` — 세션 연결 확인
  - `partial_transcript` — 부분 전사 (확정 전)
  - `committed_transcript` — 확정된 전사 결과
  - `auth_error`, `quota_exceeded`, `rate_limited` 등 — 오류
- **종료 절차**: `commit:true` 포함 청크 전송 → 2초 대기 → `ws.close(1000)`
- **Keep-alive**: 25초 무활동 시 무음 패킷 전송 (연결 유지)
- **가격**: $0.28/시간

---

## 주의사항 및 제한

| 항목 | 내용 |
|------|------|
| ElevenLabs 비용 | STT Scribe v2 Realtime: $0.28/시간 |
| OpenRouter 비용 | LLM 요약 생성 시 토큰 사용량에 따라 과금 |
| Railway 비용 | Worker 서비스 상시 실행으로 크레딧 소모 |
| 동시 회의 | 서버(길드)당 여러 음성 채널 동시 기록 가능 |
| 언어 | 기본 한국어 (`ko`), config에서 변경 가능 |
| 봇 권한 | 음성 채널 Connect + 텍스트 채널 Send Messages 필수 |
| DAVE E2EE | Discord 암호화 음성 프로토콜 지원 (`@snazzah/davey`) |
| 실시간 채팅 출력 | 비활성화됨 — 전사 결과는 서버 로그 + 종료 시 파일로만 제공 |

---

## 트러블슈팅

### 봇이 음성 채널에 들어오지 않아요
- 봇에 **Connect**, **Speak** 권한이 있는지 확인
- 음성 채널에 먼저 접속한 후 `/meeting-start` 실행

### 전사가 안 돼요 / 빈 텍스트만 나와요
- ElevenLabs API 키가 올바른지 확인 (`sk_`로 시작, 끝에 불필요한 문자 없는지 체크)
- Railway 로그에서 `[ElevenLabs] 세션 시작 확인` 메시지가 나오는지 확인
- `auth_error` 로그가 보이면 API 키를 재확인
- `insufficient_audio_activity` 로그가 보이면 마이크가 정상 동작하는지 확인

### 요약이 생성되지 않아요
- `OPENROUTER_API_KEY`가 설정되어 있는지 확인
- OpenRouter 계정에 크레딧이 있는지 확인
- Railway 로그에서 `[LLM] OpenRouter 요약 요청 중...` 메시지 확인

### VAD가 너무 빨리/느리게 커밋해요
- `src/config.js`에서 `vadSilenceThresholdSecs` 값을 조절 (기본 1.0초)
- 값을 높이면 더 긴 무음 후에 커밋, 낮추면 빠르게 커밋

### 슬래시 커맨드가 안 보여요
- `npm run register` (또는 `node register-commands.js`)를 실행했는지 확인
- 환경변수 `DISCORD_TOKEN`과 `DISCORD_CLIENT_ID`가 정확한지 확인
- 커맨드 등록 후 Discord에 반영되기까지 최대 1시간 걸릴 수 있음 (글로벌 커맨드)

### Railway 빌드가 실패해요
- Dockerfile이 포함되어 있는지 확인
- 네이티브 모듈 대신 순수 JS 패키지(`opusscript`, `libsodium-wrappers`)를 사용하므로 대부분 빌드 문제 없음
- `@snazzah/davey`의 DAVE 바이너리는 Dockerfile의 `node:22-slim` 이미지에서 정상 동작

### 디버그 로그 확인

Railway 로그 또는 콘솔에서 다음 접두사로 문제를 추적할 수 있습니다:

| 로그 접두사 | 모듈 | 내용 |
|------------|------|------|
| `[ElevenLabs]` | elevenlabsClient.js | STT 세션/연결/전사/오류 |
| `[Voice]` | voiceHandler.js | 음성 채널 접속/스트림/UDP |
| `[Transcript]` | transcriptManager.js | 전사 결과 기록 |
| `[LLM]` | llmSummarizer.js | OpenRouter 요약 요청/응답 |
| `[Summary]` | summaryGenerator.js | 임베드/파일 전송 |
| `[ChatCollector]` | chatCollector.js | 채팅 수집 상태 |
| `[Main]` | index.js | 세션 관리, 커맨드 처리 |

---

## 기술 스택

| 구성 요소 | 기술 |
|-----------|------|
| 런타임 | Node.js 22+ (ESM) |
| Discord 라이브러리 | discord.js v14 |
| 음성 처리 | @discordjs/voice, prism-media, opusscript |
| DAVE E2EE | @snazzah/davey |
| STT 엔진 | ElevenLabs Scribe v2 Realtime (WebSocket) |
| LLM 요약 | OpenRouter API (기본: Claude Opus) |
| WebSocket | ws |
| 배포 | Railway (Docker) |

---

## 라이선스

MIT
