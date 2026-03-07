/**
 * 회의 종료 후 요약 생성 및 디스코드 출력
 * - Gladia post_processing summarization 결과 활용
 * - 디스코드 임베드 형태로 깔끔하게 출력
 */
import { EmbedBuilder } from 'discord.js';

export class SummaryGenerator {
  /**
   * Gladia 요약 결과를 디스코드 임베드로 변환하여 전송
   * @param {object} params
   * @param {object} params.summary - Gladia summarization 결과
   * @param {object} params.stats - 전사 통계 (TranscriptManager.getStats())
   * @param {string} params.fullTranscript - 전체 전사 텍스트
   * @param {import('discord.js').TextChannel} params.textChannel - 출력할 텍스트 채널
   */
  static async send({ summary, stats, fullTranscript, textChannel }) {
    if (!textChannel) return;

    // ── 요약 임베드 ──
    const summaryEmbed = new EmbedBuilder()
      .setTitle('📋 회의 요약 노트')
      .setColor(0x5865F2)
      .setTimestamp();

    // 회의 정보 필드
    summaryEmbed.addFields(
      {
        name: '⏱️ 회의 시간',
        value: stats.durationFormatted || '알 수 없음',
        inline: true,
      },
      {
        name: '👥 참가자',
        value: stats.speakers?.join(', ') || '알 수 없음',
        inline: true,
      },
      {
        name: '🗣️ 발언 수',
        value: `${stats.totalUtterances}건`,
        inline: true,
      }
    );

    // 감지된 언어
    if (stats.languages?.length > 0) {
      summaryEmbed.addFields({
        name: '🌐 감지된 언어',
        value: stats.languages.join(', '),
        inline: true,
      });
    }

    // Gladia 요약 결과
    if (summary?.results) {
      const summaryText = typeof summary.results === 'string'
        ? summary.results
        : JSON.stringify(summary.results, null, 2);

      // 1024자 제한 (임베드 필드 제한)
      const truncated = summaryText.length > 1024
        ? summaryText.substring(0, 1021) + '...'
        : summaryText;

      summaryEmbed.addFields({
        name: '📝 요약',
        value: truncated,
        inline: false,
      });
    } else if (summary) {
      // summary 가 직접 문자열인 경우
      const summaryText = typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2);
      const truncated = summaryText.length > 1024
        ? summaryText.substring(0, 1021) + '...'
        : summaryText;

      summaryEmbed.addFields({
        name: '📝 요약',
        value: truncated,
        inline: false,
      });
    } else {
      summaryEmbed.addFields({
        name: '📝 요약',
        value: '_요약을 생성하지 못했습니다._',
        inline: false,
      });
    }

    try {
      await textChannel.send({ embeds: [summaryEmbed] });
    } catch (err) {
      console.error('[Summary] 요약 임베드 전송 실패:', err.message);
    }

    // ── 전체 전사록 전송 (파일 첨부) ──
    if (fullTranscript && fullTranscript.length > 0) {
      try {
        const buffer = Buffer.from(fullTranscript, 'utf-8');
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 5).replace(':', '');

        await textChannel.send({
          content: '📄 전체 전사록이 첨부되었습니다.',
          files: [
            {
              attachment: buffer,
              name: `회의록_${dateStr}_${timeStr}.txt`,
              description: '회의 전체 전사록',
            },
          ],
        });
      } catch (err) {
        console.error('[Summary] 전사록 파일 전송 실패:', err.message);
      }
    }
  }
}
