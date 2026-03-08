import 'dotenv/config';

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  discordClientId: process.env.DISCORD_CLIENT_ID,

  // Gladia
  gladiaApiKey: process.env.GLADIA_API_KEY,
  gladiaApiUrl: 'https://api.gladia.io/v2/live',

  // OpenRouter (LLM 요약)
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  openrouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-4.6',

  // Audio settings
  audio: {
    sampleRate: 16000,
    bitDepth: 16,
    channels: 1, // 동적으로 참가자 수에 따라 변경됨
    encoding: 'wav/pcm',
  },

  // Gladia 세션 설정
  gladia: {
    model: 'solaria-1',
    languageConfig: {
      languages: [],       // 빈 배열 = 자동 감지
      code_switching: true, // 다국어 회의 지원
    },
    realtimeProcessing: {
      custom_vocabulary: false,
      named_entity_recognition: false,
      sentiment_analysis: false,
    },
    postProcessing: {
      summarization: false,  // LLM 요약으로 대체 (Gladia 요약 비활성화)
      chapterization: false,
    },
    messagesConfig: {
      receive_partial_transcripts: false,  // 최종 전사만 수신 (채팅 스팸 방지)
      receive_final_transcripts: true,
      receive_speech_events: false,
      receive_pre_processing_events: false,
      receive_realtime_processing_events: true,
      receive_post_processing_events: true,
      receive_acknowledgments: false,
      receive_errors: true,
      receive_lifecycle_events: true,
    },
  },
};

// 필수 환경변수 검증
const required = ['discordToken', 'discordClientId', 'gladiaApiKey', 'openrouterApiKey'];
for (const key of required) {
  if (!config[key]) {
    console.error(`❌ 환경변수 누락: ${key}`);
    process.exit(1);
  }
}

export default config;
