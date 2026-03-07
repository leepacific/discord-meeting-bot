/**
 * Discord 라이브 회의 노트 테이킹 봇
 * ─────────────────────────────────────
 * Gladia 실시간 STT API를 활용한 디스코드 회의 자동 기록 봇
 *
 * 커맨드:
 *  /meeting-start  : 음성 채널 접속 + 실시간 전사 시작
 *  /meeting-stop   : 전사 중단 + 요약 노트 생성
 *  /meeting-status : 현재 세션 상태 확인
 */
import { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } from 'discord.js';
import config from './src/config.js';
import { VoiceHandler } from './src/voiceHandler.js';
import { GladiaClient } from './src/gladiaClient.js';
import { TranscriptManager } from './src/transcriptManager.js';
import { SummaryGenerator } from './src/summaryGenerator.js';

// ── Discord 클라이언트 초기화 ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── 서버(길드)별 활성 세션 관리 ──
const activeSessions = new Map(); // guildId → session

/**
 * 회의 세션 시작
 */
async function startMeeting(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // 이미 진행 중인 세션 확인
  if (activeSessions.has(guild.id)) {
    await interaction.reply({
      content: '⚠️ 이미 회의 기록이 진행 중입니다. `/meeting-stop`으로 먼저 종료해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 유저가 음성 채널에 있는지 확인
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ 먼저 음성 채널에 접속해주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // 전사 매니저 초기화
    const transcriptManager = new TranscriptManager();
    transcriptManager.start(interaction.channel);

    // Gladia 요약 결과를 저장할 변수
    let gladiaSummary = null;

    // Gladia 클라이언트 초기화
    const gladiaClient = new GladiaClient({
      onTranscript: (data) => {
        transcriptManager.addTranscript(data);
      },
      onSummary: (summary) => {
        console.log('[Main] 요약 결과 수신');
        gladiaSummary = summary;
      },
      onError: (err) => {
        console.error('[Main] Gladia 오류:', err.message);
      },
      onSessionEnd: (sessionId) => {
        console.log(`[Main] Gladia 세션 종료: ${sessionId}`);
      },
    });

    // Voice 핸들러 초기화
    const voiceHandler = new VoiceHandler({
      onAudioData: (audioBuffer) => {
        gladiaClient.sendAudio(audioBuffer);
      },
      onUserJoin: async (userId, channel) => {
        try {
          const user = await client.users.fetch(userId);
          const guildMember = guild.members.cache.get(userId);
          const displayName = guildMember?.displayName || user.username;
          transcriptManager.setSpeakerName(channel, displayName);
          console.log(`[Main] 화자 등록: ${displayName} (채널 ${channel})`);
        } catch (err) {
          console.error(`[Main] 유저 정보 조회 실패:`, err.message);
          transcriptManager.setSpeakerName(channel, `유저_${channel}`);
        }
      },
      onUserLeave: (userId) => {
        console.log(`[Main] 유저 퇴장: ${userId}`);
      },
    });

    // 1. 음성 채널 먼저 접속 (실패 가능성이 가장 높음)
    await voiceHandler.join(voiceChannel);

    // 2. 음성 접속 성공 후 Gladia 세션 시작
    await gladiaClient.initSession();
    gladiaClient.connect();

    // 세션 저장
    const session = {
      voiceHandler,
      gladiaClient,
      transcriptManager,
      voiceChannel,
      textChannel: interaction.channel,
      startedBy: member.user.tag,
      startedAt: new Date(),
      getSummary: () => gladiaSummary,
    };
    activeSessions.set(guild.id, session);

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
    // 실패 시 모든 리소스 정리 (activeSessions에 저장 전이라도)
    try { voiceHandler?.destroy(); } catch {}
    try { gladiaClient?.destroy(); } catch {}
    try { transcriptManager?.destroy(); } catch {}
    activeSessions.delete(guild.id);
    await interaction.editReply({
      content: `❌ 회의 시작 실패: ${err.message}`,
    });
  }
}

/**
 * 회의 세션 종료
 */
async function stopMeeting(interaction) {
  const guild = interaction.guild;
  const session = activeSessions.get(guild.id);

  if (!session) {
    await interaction.reply({
      content: '⚠️ 현재 진행 중인 회의가 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    await interaction.editReply('⏳ 회의를 종료하고 요약을 생성하는 중...');

    // 1. 먼저 Gladia에 stop_recording 전송 (후처리 트리거)
    //    이때 아직 voice는 살아있어서 마지막 버퍼가 전송될 수 있음
    await session.gladiaClient.stopRecording();

    // 2. 음성 스트림 중단
    session.voiceHandler.destroy();

    // 3. 잠시 대기 (요약 수신 여유)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 4. 통계 및 전사록 먼저 수집 (destroy 전에)
    const stats = session.transcriptManager.getStats();
    const fullTranscript = session.transcriptManager.getFullTranscript();
    const summary = session.getSummary();

    // 5. 전사 매니저 정리 (남은 버퍼 전송)
    session.transcriptManager.destroy();

    // 6. 요약 전송
    await SummaryGenerator.send({
      summary,
      stats,
      fullTranscript,
      textChannel: session.textChannel,
    });

    // 7. Gladia 정리
    session.gladiaClient.destroy();

    // 8. 세션 제거
    activeSessions.delete(guild.id);

    await interaction.editReply('✅ 회의 기록이 종료되었습니다. 아래 요약 노트를 확인하세요.');

  } catch (err) {
    console.error('[Main] 회의 종료 실패:', err);
    // 강제 정리
    try { session.voiceHandler?.destroy(); } catch {}
    try { session.gladiaClient?.destroy(); } catch {}
    try { session.transcriptManager?.destroy(); } catch {}
    activeSessions.delete(guild.id);

    await interaction.editReply(`❌ 종료 중 오류 발생: ${err.message}`);
  }
}

/**
 * 상태 확인
 */
async function checkStatus(interaction) {
  const guild = interaction.guild;
  const session = activeSessions.get(guild.id);

  if (!session) {
    await interaction.reply({
      content: '💤 현재 진행 중인 회의가 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
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

// ── 이벤트 핸들러 ──

client.once('ready', () => {
  console.log(`✅ 봇 로그인 완료: ${client.user.tag}`);
  console.log(`   서버 수: ${client.guilds.cache.size}`);
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

// ── 에러 핸들링 ──

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGINT', () => {
  console.log('종료 신호 수신, 정리 중...');
  for (const [, session] of activeSessions) {
    try { session.voiceHandler?.destroy(); } catch {}
    try { session.gladiaClient?.destroy(); } catch {}
    try { session.transcriptManager?.destroy(); } catch {}
  }
  activeSessions.clear();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM 수신, 정리 중...');
  for (const [, session] of activeSessions) {
    try { session.voiceHandler?.destroy(); } catch {}
    try { session.gladiaClient?.destroy(); } catch {}
    try { session.transcriptManager?.destroy(); } catch {}
  }
  activeSessions.clear();
  client.destroy();
  process.exit(0);
});

// ── 봇 시작 ──
client.login(config.discordToken);
