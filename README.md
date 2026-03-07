# 🎙️ Discord 라이브 회의 노트 테이킹 봇

Gladia 실시간 STT(Speech-to-Text) API를 활용한 디스코드 회의 자동 기록 봇입니다.  
음성 채널의 대화를 실시간으로 전사하고, 회의 종료 시 자동 요약 노트를 생성합니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 🔴 실시간 전사 | 음성 채널 대화를 텍스트 채널에 실시간 출력 |
| 👥 화자 구분 | Gladia 내장 diarization으로 누가 말했는지 자동 구분 |
| 📋 회의 요약 | 회의 종료 시 자동으로 요약 노트 생성 (임베드) |
| 📄 전사록 파일 | 전체 회의록을 `.txt` 파일로 첨부 |
| 🌐 다국어 지원 | 100+ 언어 자동 감지, 코드 스위칭(다국어 혼용) 지원 |

---

## 슬래시 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/meeting-start` | 현재 접속 중인 음성 채널에서 회의 기록 시작 |
| `/meeting-stop` | 회의 기록 종료 + 요약 노트 생성 |
| `/meeting-status` | 현재 회의 기록 상태 확인 (경과시간, 발언 수, 화자, 언어) |

---

## 사전 준비

이 봇을 사용하려면 3가지 키가 필요합니다:

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

### 3. Gladia API 키 발급

1. [app.gladia.io](https://app.gladia.io) 접속 → 회원가입
2. 무료 플랜: **월 10시간** 전사 무료 제공
3. 대시보드 Home 페이지에서 **API Key** 복사

---

## 사용 방법

### 회의 시작하기

1. 디스코드에서 **음성 채널에 먼저 접속**합니다
2. 아무 텍스트 채널에서 `/meeting-start` 입력
3. 봇이 음성 채널에 참가하고, 실시간 전사가 시작됩니다
4. 전사 결과는 커맨드를 입력한 텍스트 채널에 자동으로 출력됩니다

```
🎙️ 회의 기록 시작
음성 채널: 일반 음성
시작자: username#1234
텍스트 채널: #회의록

회의 내용이 실시간으로 전사됩니다.
종료하려면 /meeting-stop을 입력하세요.
```

### 회의 중 실시간 전사

회의가 진행되는 동안, 텍스트 채널에 다음과 같이 실시간으로 표시됩니다:

```
화자 1  00:12
안녕하세요, 오늘 회의 시작하겠습니다.

화자 2  00:18
네, 먼저 지난주 진행사항부터 공유드릴게요.
```

- 발언이 끝날 때마다 자동으로 텍스트가 올라옵니다
- 3초 간격으로 모아서 전송하므로 채팅이 지나치게 빠르게 올라오지 않습니다

### 회의 상태 확인

회의 중에 `/meeting-status` 를 입력하면:

```
📊 회의 기록 상태
🎙️ 음성 채널: 일반 음성
👤 시작자: username#1234
⏱️ 경과 시간: 15:30
🗣️ 발언 수: 42건
👥 감지된 화자: 화자 1, 화자 2, 화자 3
🌐 언어: ko, en
```

### 회의 종료하기

1. `/meeting-stop` 입력
2. 봇이 Gladia 서버에 후처리(요약)를 요청합니다
3. 잠시 후 다음이 텍스트 채널에 전송됩니다:

**요약 임베드:**
```
📋 회의 요약 노트
⏱️ 회의 시간: 32:15
👥 참가자: 화자 1, 화자 2, 화자 3
🗣️ 발언 수: 87건
🌐 감지된 언어: ko

📝 요약
오늘 회의에서는 Q2 마케팅 전략에 대해 논의했습니다.
주요 결정사항: ...
```

**전사록 파일:**
```
📄 전체 전사록이 첨부되었습니다.
📎 회의록_2026-03-07_1430.txt
```

전사록 파일에는 타임스탬프와 함께 전체 대화 내용이 포함됩니다:
```
[00:00] 화자 1: 안녕하세요, 오늘 회의 시작하겠습니다.
[00:06] 화자 2: 네, 먼저 지난주 진행사항부터 공유드릴게요.
[00:15] 화자 2: 지난주에 말씀드린 A 프로젝트는 ...
...
```

---

## 설치 및 배포

### 방법 1: Railway 배포 (권장)

이미 Railway에 배포 준비가 되어 있습니다.

1. [Railway](https://railway.app) 대시보드에서 프로젝트 확인
2. **Variables** 탭에서 환경변수 설정:
   ```
   DISCORD_TOKEN=봇_토큰
   DISCORD_CLIENT_ID=앱_ID
   GLADIA_API_KEY=Gladia_API_키
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
# .env 파일을 열어서 3개의 키를 입력

# 슬래시 커맨드 등록 (최초 1회)
npm run register

# 봇 실행
npm start
```

### .env 파일 예시

```env
DISCORD_TOKEN=MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXX
DISCORD_CLIENT_ID=123456789012345678
GLADIA_API_KEY=12fcfc34-0fd8-42ec-969a-0b815bf3677f
```

---

## 프로젝트 구조

```
discord-meeting-bot/
├── index.js                  # 봇 메인 (슬래시 커맨드 핸들링, 세션 관리)
├── register-commands.js      # 슬래시 커맨드 Discord 등록 (최초 1회)
├── package.json
├── Dockerfile                # Railway/Docker 배포용
├── .env.example              # 환경변수 템플릿
├── .gitignore
└── src/
    ├── config.js             # 환경변수 로드 및 Gladia 설정
    ├── voiceHandler.js       # Discord 음성 채널 접속, Opus→PCM 변환
    ├── gladiaClient.js       # Gladia WebSocket 실시간 STT 클라이언트
    ├── transcriptManager.js  # 전사 결과 버퍼링 및 Discord 채널 출력
    └── summaryGenerator.js   # 회의 종료 후 요약 임베드 + 전사록 생성
```

### 아키텍처

```
Discord 음성 채널 (Opus 48kHz stereo)
        │
        ▼
  voiceHandler.js
  ├─ Opus → PCM 디코딩 (opusscript + prism-media)
  ├─ 48kHz stereo → 16kHz mono 다운샘플링
  └─ 100ms 간격으로 오디오 버퍼 전송
        │
        ▼  PCM 16kHz mono (WebSocket binary)
  gladiaClient.js
  ├─ POST /v2/live 세션 초기화
  ├─ WebSocket으로 실시간 오디오 스트리밍
  ├─ 전사 결과 수신 (transcript 이벤트)
  └─ 세션 종료 시 요약 수신 (post_processing 이벤트)
        │
        ▼  전사 텍스트 + 요약
  transcriptManager.js → Discord 텍스트 채널 실시간 출력
  summaryGenerator.js  → 임베드 요약 + 전사록 .txt 파일
```

---

## 주의사항 및 제한

| 항목 | 내용 |
|------|------|
| Gladia 무료 플랜 | 월 10시간 전사 무료. 초과 시 유료 플랜 필요 |
| Railway 비용 | Worker 서비스 상시 실행으로 크레딧 소모 |
| 동시 회의 | 서버(길드)당 1개 회의만 동시 기록 가능 |
| 언어 | 자동 감지 (100+ 언어). 코드 스위칭 지원 |
| 봇 권한 | 음성 채널 Connect + 텍스트 채널 Send Messages 필수 |

---

## 트러블슈팅

### 봇이 음성 채널에 들어오지 않아요
- 봇에 **Connect**, **Speak** 권한이 있는지 확인
- 음성 채널에 먼저 접속한 후 `/meeting-start` 실행

### 전사가 안 돼요 / 빈 텍스트만 나와요
- Gladia API 키가 올바른지 확인
- Gladia 무료 사용량(10시간/월)이 남아있는지 [app.gladia.io](https://app.gladia.io) 에서 확인
- Railway 로그에서 `[Gladia] 세션 생성 완료` 메시지가 나오는지 확인

### 슬래시 커맨드가 안 보여요
- `npm run register` (또는 `node register-commands.js`)를 실행했는지 확인
- 환경변수 `DISCORD_TOKEN`과 `DISCORD_CLIENT_ID`가 정확한지 확인
- 커맨드 등록 후 Discord에 반영되기까지 최대 1시간 걸릴 수 있음 (글로벌 커맨드)

### Railway 빌드가 실패해요
- Dockerfile이 포함되어 있는지 확인
- 네이티브 모듈 대신 순수 JS 패키지(`opusscript`, `libsodium-wrappers`)를 사용하므로 대부분 빌드 문제 없음

---

## 라이선스

MIT
