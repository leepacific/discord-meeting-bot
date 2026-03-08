import 'dotenv/config';

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,

  // ElevenLabs (Scribe v2 Realtime STT)
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,

  // OpenRouter (LLM 요약)
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.6',

  // Audio settings
  audio: {
    sampleRate: 16000,
    bitDepth: 16,
    channels: 1,
    encoding: 'pcm_16000',  // ElevenLabs 포맷
  },

  // ElevenLabs Scribe 세션 설정
  elevenlabs: {
    wsUrl: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
    modelId: 'scribe_v2_realtime',
    languageCode: 'ko',           // 한국어 고정 (자동 감지 원하면 제거)
    commitStrategy: 'vad',         // 자동 음성 구간 감지
    vadSilenceThresholdSecs: 1.5,  // 1.5초 무음 시 커밋 (기본값, 1.0은 너무 짧아 commit_throttled 위험)
    vadThreshold: 0.4,             // VAD 감도
    minSpeechDurationMs: 150,      // 최소 발화 길이 (잡음 오인식 방지, 기본 100)
    minSilenceDurationMs: 200,     // 최소 무음 길이 (문장 중간 끊김 방지, 기본 100)
  },
};

// 필수 환경변수 검증
const required = ['discordToken', 'discordClientId', 'elevenlabsApiKey', 'openrouterApiKey'];
for (const key of required) {
  if (!config[key]) {
    console.error(`❌ 환경변수 누락: ${key}`);
    process.exit(1);
  }
}

export default config;
