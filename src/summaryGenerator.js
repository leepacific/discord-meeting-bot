/**
 * 회의 종료 후 요약 생성 및 디스코드 출력
 * - LLM 요약 결과 (마크다운 문자열) 표시
 * - 음성 전사 + 채팅 통합 전사록 파일 첨부
 */
import { EmbedBuilder } from 'discord.js';

export class SummaryGenerator {
  /**
   * 요약 결과를 디스코드 임베드로 변환하여 전송
   * @param {object} params
   * @param {string|null} params.summary - LLM 요약 텍스트 (마크다운)
   * @param {object} params.stats - 전사 통계
   * @param {string} params.fullTranscript - 전체 음성 전사 텍스트
   * @param {string} params.chatTranscript - 채팅 텍스트
   * @param {import('discord.js').TextChannel} params.textChannel - 출력할 텍스트 채널
   */
  static async send({ summary, stats, fullTranscript, chatTranscript, textChannel }) {
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

    // 채팅 메시지 수
    if (stats.chatMessageCount > 0) {
      summaryEmbed.addFields({
        name: '💬 채팅',
        value: `${stats.chatMessageCount}건`,
        inline: true,
      });
    }

    // 감지된 언어
    if (stats.languages?.length > 0) {
      summaryEmbed.addFields({
        name: '🌐 감지된 언어',
        value: stats.languages.join(', '),
        inline: true,
      });
    }

    try {
      await textChannel.send({ embeds: [summaryEmbed] });
    } catch (err) {
      console.error('[Summary] 요약 임베드 전송 실패:', err.message);
    }

    // ── LLM 요약 텍스트 전송 ──
    if (summary) {
      // 마크다운 요약을 일반 메시지로 전송 (임베드 필드 1024자 제한 회피)
      try {
        // Discord 메시지 2000자 제한 처리
        if (summary.length <= 2000) {
          await textChannel.send(summary);
        } else {
          // 2000자 초과 시 분할 전송
          const chunks = SummaryGenerator._splitText(summary, 2000);
          for (const chunk of chunks) {
            await textChannel.send(chunk);
          }
        }
      } catch (err) {
        console.error('[Summary] 요약 텍스트 전송 실패:', err.message);
      }
    } else {
      // 요약 생성 실패
      const noSummaryMsg = (stats.totalUtterances === 0 && (stats.chatMessageCount || 0) === 0)
        ? '_음성과 채팅이 감지되지 않아 요약을 생성할 수 없습니다._'
        : '_요약을 생성하지 못했습니다._';
      try {
        await textChannel.send(noSummaryMsg);
      } catch (err) {
        console.error('[Summary] 요약 없음 메시지 전송 실패:', err.message);
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
