/**
 * Discord 라이브 회의 노트 테이킹 봇
 * ─────────────────────────────────────
 * ElevenLabs Scribe v2 Realtime STT 를 활용한 디스코드 회의 자동 기록 봇
 *
 * 커맨드:
 *  /meeting-start  : 음성 채널 접속 + 실시간 전사 시작
 *  /meeting-stop   : 전사 중단 + 요약 노트 생성
 *  /meeting-status : 현재 세션 상태 확인
 */
import { Client, GatewayIntentBits, EmbedBuilder, MessageFlags, Events } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import config from './src/config.js';
import { VoiceHandler } from './src/voiceHandler.js';
import { ElevenLabsClient } from './src/elevenlabsClient.js';
import { TranscriptManager } from './src/transcriptManager.js';
import { ChatCollector } from './src/chatCollector.js';
import { LlmSummarizer } from './src/llmSummarizer.js';
import { SummaryGenerator } from './src/summaryGenerator.js';

// ── Discord 클라이언트 초기화 ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,  // 채팅 내용 수집용
  ],
});

// ── 채널별 활성 세션 관리 (서버 내 다중 채널 동시 지원) ──
const activeSessions = new Map(); // channelId → session

// ── 자동 종료 타이머 관리 ──
const autoStopTimers = new Map(); // channelId → timer

/**
 * 회의 세션 시작
 */
async function startMeeting(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // 유저가 음성 채널에 있는지 확인
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ 먼저 음성 채널에 접속해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 해당 채널에서 이미 진행 중인 세션 확인
  if (activeSessions.has(voiceChannel.id)) {
    await interaction.reply({
      content: '⚠️ 이 음성 채널에서 이미 회의 기록이 진행 중입니다. `/meeting-stop`으로 먼저 종료해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 같은 서버(길드) 내 다른 음성 채널에서 이미 세션이 진행 중인지 확인
  // Discord 제한: 봇 1개는 길드당 음성 채널 1개에만 접속 가능
  const existingGuildSession = getGuildSessions(guild.id);
  if (existingGuildSession.length > 0) {
    const existingChannelName = existingGuildSession[0].voiceChannel.name;
    await interaction.reply({
      content: `⚠️ 이 서버에서 이미 **${existingChannelName}** 채널에서 회의가 진행 중입니다.\n봇은 서버당 하나의 음성 채널에만 접속할 수 있습니다. 먼저 \`/meeting-stop\`으로 기존 회의를 종료해주세요.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  // try 블록 밖에 선언하여 catch에서도 접근 가능하도록 함
  let voiceHandler = null;
  let sttClients = new Map(); // userId → ElevenLabsClient
  let transcriptManager = null;
  let chatCollector = null;

  // 회의 시작 시점 (모든 STT 세션의 타임스탬프 기준점, 클로저로 참조)
  const meetingStartMs = Date.now();

  try {
    // 전사 매니저 초기화
    transcriptManager = new TranscriptManager();
    transcriptManager.start(interaction.channel);

    // 채팅 수집기 초기화
    chatCollector = new ChatCollector(client);
    chatCollector.start(interaction.channel);

    // Voice 핸들러 초기화 (유저별 오디오 콜백)
    voiceHandler = new VoiceHandler({
      onUserAudioData: (userId, audioBuffer) => {
        const userStt = sttClients.get(userId);
        if (userStt) {
          userStt.sendAudio(audioBuffer);
        }
      },
      onUserJoin: async (userId, channel) => {
        try {
          const user = await client.users.fetch(userId);
          const guildMember = guild.members.cache.get(userId);
          const displayName = guildMember?.displayName || user.username;
          transcriptManager.setSpeakerName(channel, displayName);
          console.log(`[Main] 화자 등록: ${displayName} (채널 ${channel})`);

          // 해당 유저 전용 ElevenLabs STT 세션 생성
          if (!sttClients.has(userId)) {
            const userStt = new ElevenLabsClient({
              label: displayName,
              meetingStartTime: meetingStartMs,
              onTranscript: (data) => {
                // 해당 유저의 채널 번호로 화자 구분
                transcriptManager.addTranscript({ ...data, channel });
              },
              onError: (err) => {
                console.error(`[Main] STT 오류 (${displayName}):`, err.message);
              },
              onSessionEnd: (sessionId) => {
                console.log(`[Main] STT 세션 종료 (${displayName}): ${sessionId}`);
              },
            });

            try {
              await userStt.initSession();
              userStt.connect();
              sttClients.set(userId, userStt);
              console.log(`[Main] STT 세션 생성 완료: ${displayName} (userId: ${userId})`);
            } catch (err) {
              console.error(`[Main] STT 세션 생성 실패 (${displayName}):`, err.message);
              try { userStt.destroy(); } catch {}
            }
          }
        } catch (err) {
          console.error(`[Main] 유저 정보 조회 실패:`, err.message);
          transcriptManager.setSpeakerName(channel, `유저_${channel}`);
        }
      },
      onUserLeave: (userId) => {
        console.log(`[Main] 유저 퇴장: ${userId}`);
        // 퇴장한 유저의 STT 세션은 유지 (재입장 대비, 종료 시 일괄 정리)
      },
      onForceDisconnect: () => {
        // 봇이 킥/강제퇴장된 경우 세션 정리
        handleForceDisconnect(voiceChannel.id);
      },
    });

    // 음성 채널 접속 (유저 입장 시 동적으로 STT 세션 생성됨)
    try {
      await voiceHandler.join(voiceChannel);
    } catch (err) {
      throw new Error(`음성 채널 접속 실패: ${err.message}`);
    }

    // 세션 저장
    const session = {
      voiceHandler,
      sttClients,
      transcriptManager,
      chatCollector,
      voiceChannel,
      textChannel: interaction.channel,
      startedBy: member.user.tag,
      startedAt: new Date(meetingStartMs),
      meetingStartMs,
    };
    activeSessions.set(voiceChannel.id, session);

    // 시작 알림 임베드
    const startEmbed = new EmbedBuilder()
      .setTitle('🎙️ 회의 기록 시작')
      .setColor(0x57F287)
      .addFields(
        { name: '음성 채널', value: voiceChannel.name, inline: true },
        { name: '시작자', value: member.user.tag, inline: true },
        { name: '텍스트 채널', value: `<#${interaction.channel.id}>`, inline: true }
      )
      .setDescription('회의 내용이 실시간으로 전사됩니다.\n종료하려면 `/meeting-stop`을 입력하세요.')
      .setTimestamp();

    await interaction.editReply({ embeds: [startEmbed] });

  } catch (err) {
    console.error('[Main] 회의 시작 실패:', err);
    // 실패 시 모든 리소스 정리
    try { voiceHandler?.destroy(); } catch {}
    for (const [, userStt] of sttClients) {
      try { userStt.destroy(); } catch {}
    }
    sttClients.clear();
    try { transcriptManager?.destroy(); } catch {}
    try { chatCollector?.destroy(); } catch {}
    activeSessions.delete(voiceChannel.id);
    await interaction.editReply({
      content: `❌ 회의 시작 실패: ${err.message}`,
    });
  }
}

/**
 * 봇이 킥/강제퇴장된 경우 세션 정리
 */
function handleForceDisconnect(channelId) {
  const session = activeSessions.get(channelId);
  if (!session) return;

  console.log(`[Main] 강제 퇴장 감지, 세션 정리: ${channelId}`);

  // 자동 종료 타이머가 있으면 제거
  clearAutoStopTimer(channelId);

  // STT 정리 (모든 유저별 세션)
  if (session.sttClients) {
    for (const [, userStt] of session.sttClients) {
      try { userStt.destroy(); } catch {}
    }
    session.sttClients.clear();
  }

  // 전사 매니저 정리 (남은 버퍼 전송)
  try { session.transcriptManager?.destroy(); } catch {}

  // 채팅 수집기 정리
  try { session.chatCollector?.destroy(); } catch {}

  // 세션 제거
  activeSessions.delete(channelId);

  // 텍스트 채널에 알림
  try {
    session.textChannel?.send('⚠️ 봇이 음성 채널에서 제거되어 회의 기록이 중단되었습니다.');
  } catch {}
}

/**
 * 회의 세션 종료
 */
async function stopMeeting(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // 유저가 접속한 음성 채널의 세션을 찾거나, 서버 내 세션 검색
  const session = findSession(member, guild);

  if (!session) {
    await interaction.reply({
      content: '⚠️ 현재 진행 중인 회의가 없습니다. 음성 채널에 접속한 상태에서 실행해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  // 자동 종료 타이머 제거
  clearAutoStopTimer(session.voiceChannel.id);

  try {
    await interaction.editReply('⏳ 회의를 종료하고 요약을 생성하는 중...');

    // 공통 종료 로직 호출
    await performStopMeeting(session);

    await interaction.editReply('✅ 회의 기록이 종료되었습니다. 아래 요약 노트를 확인하세요.');

  } catch (err) {
    console.error('[Main] 회의 종료 실패:', err);
    // 강제 정리
    try { session.voiceHandler?.destroy(); } catch {}
    if (session.sttClients) {
      for (const [, userStt] of session.sttClients) {
        try { userStt.destroy(); } catch {}
      }
    }
    try { session.transcriptManager?.destroy(); } catch {}
    try { session.chatCollector?.destroy(); } catch {}
    activeSessions.delete(session.voiceChannel.id);

    await interaction.editReply(`❌ 종료 중 오류 발생: ${err.message}`);
  }
}

/**
 * 공통 회의 종료 로직 (수동 종료 + 자동 종료에서 공유)
 */
async function performStopMeeting(session) {
  // 0. 먼저 세션을 맵에서 제거하여 중복 종료 및 voiceStateUpdate 간섭 방지
  activeSessions.delete(session.voiceChannel.id);

  // 1. 모든 유저별 STT 녹음 중단 (병렬)
  const stopPromises = [];
  for (const [, userStt] of session.sttClients) {
    stopPromises.push(userStt.stopRecording().catch((err) => {
      console.error('[Main] STT stopRecording 오류:', err.message);
    }));
  }
  await Promise.all(stopPromises);

  // 2. 음성 스트림 중단
  session.voiceHandler.destroy();

  // 3. 통계 및 전사록 수집 (destroy 전에)
  const stats = session.transcriptManager.getStats();
  const fullTranscript = session.transcriptManager.getFullTranscript();

  // 4. 채팅 내용 수집
  const chatTranscript = session.chatCollector.getChatTranscript();
  stats.chatMessageCount = session.chatCollector.messageCount;

  // 5. 전사 매니저 및 채팅 수집기 정리
  await session.transcriptManager.destroy();
  session.chatCollector.destroy();

  // 6. LLM 통합 요약 생성 (음성 전사 + 채팅)
  let summary = null;
  try {
    summary = await LlmSummarizer.summarize({
      voiceTranscript: fullTranscript,
      chatTranscript,
      stats,
    });
  } catch (err) {
    console.error('[Main] LLM 요약 생성 실패:', err.message);
  }

  // 7. 요약 전송
  await SummaryGenerator.send({
    summary,
    stats,
    fullTranscript,
    chatTranscript,
    textChannel: session.textChannel,
  });

  // 8. 모든 유저별 STT 정리
  for (const [, userStt] of session.sttClients) {
    try { userStt.destroy(); } catch {}
  }
  session.sttClients.clear();

  // 9. 세션 제거 (이미 0단계에서 제거됨, 안전을 위한 중복 호출)
  activeSessions.delete(session.voiceChannel.id);
}

/**
 * 상태 확인
 */
async function checkStatus(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // 유저가 접속한 음성 채널의 세션을 찾거나, 서버 내 세션 검색
  const session = findSession(member, guild);

  if (!session) {
    // 서버 내 모든 활성 세션 목록 표시
    const guildSessions = getGuildSessions(guild.id);
    if (guildSessions.length > 0) {
      const list = guildSessions
        .map((s) => `• **${s.voiceChannel.name}** (${s.stats.durationFormatted}, 발언 ${s.stats.totalUtterances}건)`)
        .join('\n');
      await interaction.reply({
        content: `📊 현재 서버에서 진행 중인 회의:\n${list}`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: '💤 현재 진행 중인 회의가 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  const stats = session.transcriptManager.getStats();
  const embed = new EmbedBuilder()
    .setTitle('📊 회의 기록 상태')
    .setColor(0x5865F2)
    .addFields(
      { name: '🎙️ 음성 채널', value: session.voiceChannel.name, inline: true },
      { name: '👤 시작자', value: session.startedBy, inline: true },
      { name: '⏱️ 경과 시간', value: stats.durationFormatted, inline: true },
      { name: '🗣️ 발언 수', value: `${stats.totalUtterances}건`, inline: true },
      { name: '👥 감지된 화자', value: stats.speakers.join(', ') || '없음', inline: true },
      { name: '🌐 언어', value: stats.languages.join(', ') || '감지 전', inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * 유저의 음성 채널 세션 찾기
 * 1순위: 유저가 접속한 음성 채널의 세션
 * 2순위: 서버에 세션이 1개뿐이면 그 세션
 */
function findSession(member, guild) {
  // 유저가 음성 채널에 있으면 해당 채널 세션 반환
  const voiceChannel = member.voice?.channel;
  if (voiceChannel && activeSessions.has(voiceChannel.id)) {
    return activeSessions.get(voiceChannel.id);
  }

  // 서버 내 활성 세션이 1개뿐이면 그 세션 반환
  const guildSessions = getGuildSessions(guild.id);
  if (guildSessions.length === 1) {
    return guildSessions[0];
  }

  return null;
}

/**
 * 서버(길드) 내 모든 활성 세션 조회
 */
function getGuildSessions(guildId) {
  const sessions = [];
  for (const [, session] of activeSessions) {
    if (session.voiceChannel.guild.id === guildId) {
      const stats = session.transcriptManager.getStats();
      sessions.push({ ...session, stats });
    }
  }
  return sessions;
}

// ── 자동 종료: 봇만 남으면 2분 후 자동 종료 ──

/**
 * 자동 종료 타이머 설정
 */
function setAutoStopTimer(channelId) {
  // 기존 타이머 제거
  clearAutoStopTimer(channelId);

  const AUTO_STOP_DELAY_MS = 120_000; // 2분

  const timer = setTimeout(async () => {
    autoStopTimers.delete(channelId);
    const session = activeSessions.get(channelId);
    if (!session) return;

    console.log(`[Main] 자동 종료 실행: ${channelId}`);
    try {
      await session.textChannel?.send('⏹️ 음성 채널에 참가자가 없어 회의 기록을 자동 종료합니다.');
      await performStopMeeting(session);
    } catch (err) {
      console.error('[Main] 자동 종료 실패:', err);
      // 강제 정리
      try { session.voiceHandler?.destroy(); } catch {}
      if (session.sttClients) {
        for (const [, userStt] of session.sttClients) {
          try { userStt.destroy(); } catch {}
        }
      }
      try { session.transcriptManager?.destroy(); } catch {}
      try { session.chatCollector?.destroy(); } catch {}
      activeSessions.delete(channelId);
    }
  }, AUTO_STOP_DELAY_MS);

  autoStopTimers.set(channelId, timer);
  console.log(`[Main] 자동 종료 타이머 설정 (2분): ${channelId}`);
}

/**
 * 자동 종료 타이머 해제
 */
function clearAutoStopTimer(channelId) {
  const timer = autoStopTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    autoStopTimers.delete(channelId);
    console.log(`[Main] 자동 종료 타이머 해제: ${channelId}`);
  }
}

// ── 이벤트 핸들러 ──

client.once(Events.ClientReady, () => {
  console.log(`✅ 봇 로그인 완료: ${client.user.tag}`);
  console.log(`   서버 수: ${client.guilds.cache.size}`);
  console.log(`   Node.js: ${process.version}`);
  // 의존성 보고서 출력
  console.log('[Dependencies]\n' + generateDependencyReport());
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'meeting-start':
        await startMeeting(interaction);
        break;
      case 'meeting-stop':
        await stopMeeting(interaction);
        break;
      case 'meeting-status':
        await checkStatus(interaction);
        break;
      default:
        await interaction.reply({ content: '알 수 없는 명령입니다.', flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error(`[Main] 커맨드 처리 오류 (${commandName}):`, err);
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply.bind(interaction)
      : interaction.reply.bind(interaction);
    try {
      await reply({ content: `❌ 오류 발생: ${err.message}`, flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

// ── 음성 상태 변경 감지 (자동 종료용) ──
client.on('voiceStateUpdate', (oldState, newState) => {
  // 봇 자신의 이벤트는 무시 (destroy 시 voiceStateUpdate 발생 방지)
  const userId = oldState.id || newState.id;
  if (userId === client.user?.id) return;

  const leftChannelId = oldState.channelId;
  const joinedChannelId = newState.channelId;

  // 채널을 나간 경우: 자동 종료 채크
  if (leftChannelId && leftChannelId !== joinedChannelId) {
    if (activeSessions.has(leftChannelId)) {
      const channel = oldState.guild.channels.cache.get(leftChannelId);
      if (channel) {
        const humanMembers = channel.members.filter(m => !m.user.bot);
        if (humanMembers.size === 0) {
          // 봇만 남음 → 자동 종료 타이머 시작
          setAutoStopTimer(leftChannelId);
        }
      }
    }
  }

  // 채널에 (재)입장한 경우: 자동 종료 타이머 취소
  if (joinedChannelId && joinedChannelId !== leftChannelId) {
    if (autoStopTimers.has(joinedChannelId)) {
      console.log(`[Main] 참가자 입장으로 자동 종료 취소: ${joinedChannelId}`);
      clearAutoStopTimer(joinedChannelId);
    }
  }
});

// ── 에러 핸들링 ──

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

async function gracefulShutdown(signal) {
  console.log(`${signal} 수신, 정리 중...`);
  for (const [channelId, session] of activeSessions) {
    clearAutoStopTimer(channelId);

    // STT 녹음 중단 (마지막 전사 결과 flush, 최대 5초 대기)
    if (session.sttClients) {
      const stopPromises = [];
      for (const [, userStt] of session.sttClients) {
        stopPromises.push(
          userStt.stopRecording()
            .catch((err) => console.error('[Shutdown] STT stop 오류:', err.message))
        );
      }
      try {
        await Promise.race([
          Promise.all(stopPromises),
          new Promise((resolve) => setTimeout(resolve, 5000)), // 5초 타임아웃
        ]);
      } catch {}
      // destroy는 stopRecording 후 호출
      for (const [, userStt] of session.sttClients) {
        try { userStt.destroy(); } catch {}
      }
    }

    try { session.voiceHandler?.destroy(); } catch {}
    try { session.transcriptManager?.destroy(); } catch {}
    try { session.chatCollector?.destroy(); } catch {}
  }
  activeSessions.clear();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ── 봇 시작 ──
client.login(config.discordToken);
