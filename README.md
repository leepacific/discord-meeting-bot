# 🎙️ Discord 라이브 회의 노트 테이킹 봇

Gladia 실시간 STT API를 활용한 디스코드 회의 자동 기록 봇입니다.

## 기능

- **실시간 전사** — 음성 채널의 대화가 텍스트 채널에 실시간으로 기록됩니다
- **화자 구분** — Gladia 내장 diarization으로 누가 말했는지 구분합니다
- **회의 요약** — 회의 종료 시 자동으로 요약 노트가 생성됩니다
- **전사록 파일** — 전체 회의 전사록이 텍스트 파일로 첨부됩니다
- **다국어 지원** — 언어 자동 감지 및 코드 스위칭 지원

## 슬래시 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/meeting-start` | 현재 음성 채널에서 회의 기록 시작 |
| `/meeting-stop` | 기록 종료 + 요약 노트 생성 |
| `/meeting-status` | 현재 기록 상태 확인 |

---

## 사전 준비

### 1. Discord 봇 생성

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. **New Application** → 이름 입력 → 생성
3. **Bot** 탭 → **Reset Token** → 토큰 복사 (안전하게 보관)
4. **Bot** 탭에서 아래 Privileged Gateway Intents 활성화:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. **OAuth2** → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `Use Voice Activity`, `Send Messages`, `Attach Files`, `Embed Links`
6. 생성된 URL로 봇을 서버에 초대

### 2. Gladia API 키 발급

1. [app.gladia.io](https://app.gladia.io) 가입
2. 무료 플랜: 월 10시간 무료
3. Home 페이지에서 API Key 복사

---

## 로컬 실행

```bash
# 저장소 클론
git clone <your-repo-url>
cd discord-meeting-bot

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일에 토큰/키 입력

# 슬래시 커맨드 등록 (최초 1회)
npm run register

# 봇 실행
npm start
```

### .env 파일

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_client_id
GLADIA_API_KEY=your_gladia_api_key
```

---

## Railway 배포

1. Railway 대시보드 → **New Project** → **Deploy from GitHub repo**
2. GitHub 저장소 연결
3. Variables 탭에서 `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GLADIA_API_KEY` 추가
4. GitHub push 시 자동 빌드/배포

---

## 프로젝트 구조

```
discord-meeting-bot/
├── index.js                  # 봇 메인 엔트리포인트
├── register-commands.js      # 슬래시 커맨드 등록 (최초 1회)
├── package.json
├── Dockerfile                # Railway 배포용
├── .env.example
└── src/
    ├── config.js             # 환경변수 및 설정 관리
    ├── voiceHandler.js       # 음성 채널 접속 및 오디오 캡처
    ├── gladiaClient.js       # Gladia WebSocket STT 클라이언트
    ├── transcriptManager.js  # 전사 결과 관리 및 디스코드 출력
    └── summaryGenerator.js   # 회의 요약 임베드 생성
```

## 주의사항

- Gladia 무료 플랜은 월 10시간입니다
- Railway Worker 서비스는 상시 실행되므로 크레딧이 소모됩니다
- `@discordjs/opus`, `sodium-native`는 네이티브 빌드 필요 (Dockerfile에 포함됨)

## 라이선스

MIT
