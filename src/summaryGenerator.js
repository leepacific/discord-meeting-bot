/**
 * 회의 종료 후 요약 생성 및 디스코드 출력
 * - 회의 통계 + LLM 요약을 하나의 임베드로 통합 표시
 * - 음성 전사 + 채팅 통합 전사록 파일 첨부
 */
import { EmbedBuilder } from 'discord.js';

// Discord 임베드 description 최대 길이
const EMBED_DESC_MAX = 4096;

export class SummaryGenerator {
  /**
   * 요약 결과를 디스코드 임베드로 변환하여 전송
   * 회의 정보 + LLM 요약을 하나의 임베드에 통합
   * @param {object} params
   * @param {string|null} params.summary - LLM 요약 텍스트 (마크다운)
   * @param {object} params.stats - 전사 통계
   * @param {string} params.fullTranscript - 전체 음성 전사 텍스트
   * @param {string} params.chatTranscript - 채팅 텍스트
   * @param {import('discord.js').TextChannel} params.textChannel - 출력할 텍스트 채널
   */
  static async send({ summary, stats, fullTranscript, chatTranscript, textChannel }) {
    if (!textChannel) return;

    // ── 회의 정보 헤더 조립 ──
    const infoParts = [
      `⏱️ **${stats.durationFormatted || '00:00'}**`,
      `👥 ${stats.speakers?.join(', ') || '알 수 없음'}`,
      `🗣️ 발언 ${stats.totalUtterances}건`,
    ];
    if (stats.chatMessageCount > 0) {
      infoParts.push(`💬 채팅 ${stats.chatMessageCount}건`);
    }
    if (stats.languages?.length > 0) {
      infoParts.push(`🌐 ${stats.languages.join(', ')}`);
    }
    const infoHeader = infoParts.join('  ·  ');

    // ── 통합 임베드 생성 ──
    const summaryEmbed = new EmbedBuilder()
      .setTitle('📋 회의 요약 노트')
      .setColor(0x5865F2)
      .setTimestamp();

    let overflow = null; // description에 못 넣은 나머지

    if (summary) {
      const fullDesc = `${infoHeader}\n\n───\n\n${summary}`;

      if (fullDesc.length <= EMBED_DESC_MAX) {
        // 전부 임베드에 넣기
        summaryEmbed.setDescription(fullDesc);
      } else {
        // 임베드에 넣을 수 있는 만큼 넣고 나머지는 별도 메시지
        // 헤더 + 구분선은 항상 포함, 요약은 가능한 만큼
        const prefix = `${infoHeader}\n\n───\n\n`;
        const availableLen = EMBED_DESC_MAX - prefix.length;

        // 줄바꿈 기준으로 자르기
        let cutIdx = summary.lastIndexOf('\n', availableLen);
        if (cutIdx <= 0) cutIdx = availableLen;

        summaryEmbed.setDescription(prefix + summary.substring(0, cutIdx));
        overflow = summary.substring(cutIdx).trimStart();
      }
    } else {
      // 요약 없음
      const noSummaryMsg = (stats.totalUtterances === 0 && (stats.chatMessageCount || 0) === 0)
        ? '_음성과 채팅이 감지되지 않아 요약을 생성할 수 없습니다._'
        : '_요약을 생성하지 못했습니다._';
      summaryEmbed.setDescription(`${infoHeader}\n\n───\n\n${noSummaryMsg}`);
    }

    try {
      await textChannel.send({ embeds: [summaryEmbed] });
    } catch (err) {
      console.error('[Summary] 요약 임베드 전송 실패:', err.message);
    }

    // ── 임베드에 못 넣은 나머지 요약 텍스트 전송 ──
    if (overflow && overflow.length > 0) {
      try {
        const chunks = SummaryGenerator._splitText(overflow, 2000);
        for (const chunk of chunks) {
          await textChannel.send(chunk);
        }
      } catch (err) {
        console.error('[Summary] 요약 오버플로우 전송 실패:', err.message);
      }
    }

    // ── 전체 기록 파일 전송 (음성 전사 + 채팅 통합) ──
    const hasVoice = fullTranscript && fullTranscript.length > 0;
    const hasChat = chatTranscript && chatTranscript.length > 0;

    if (hasVoice || hasChat) {
      try {
        let fileContent = '';

        if (hasVoice) {
          fileContent += '═══ 음성 전사 ═══\n\n';
          fileContent += fullTranscript;
          fileContent += '\n\n';
        }

        if (hasChat) {
          fileContent += '═══ 텍스트 채팅 ═══\n\n';
          fileContent += chatTranscript;
        }

        const buffer = Buffer.from(fileContent.trim(), 'utf-8');
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 5).replace(':', '');

        await textChannel.send({
          content: '📄 전체 회의 기록이 첨부되었습니다.',
          files: [
            {
              attachment: buffer,
              name: `회의록_${dateStr}_${timeStr}.txt`,
              description: '회의 전체 기록 (음성 전사 + 채팅)',
            },
          ],
        });
      } catch (err) {
        console.error('[Summary] 회의록 파일 전송 실패:', err.message);
      }
    }
  }

  /**
   * 텍스트를 maxLen 이하로 분할 (줄바꿈 기준)
   */
  static _splitText(text, maxLen) {
    const chunks = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      // 마지막 줄바꿈 위치에서 자르기
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx <= 0) splitIdx = maxLen;

      chunks.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }
}
