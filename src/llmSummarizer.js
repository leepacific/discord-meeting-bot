/**
 * OpenRouter LLM 기반 회의 요약 생성기
 * - 음성 전사 + 텍스트 채팅을 통합하여 요약
 * - OpenRouter API (OpenAI 호환) 사용
 */
import config from './config.js';

const SYSTEM_PROMPT = `당신은 회의록 요약 전문가입니다. 아래에 음성 전사 내용과 텍스트 채팅 내용이 제공됩니다.

다음 형식으로 한국어 회의 요약을 작성하세요:

**📌 핵심 요약**
회의의 핵심 내용을 2~3문장으로 요약

**📋 주요 논의 사항**
- 논의된 주요 주제별로 정리

**✅ 결정 사항 / 액션 아이템**
- 결정된 사항이나 후속 조치가 있으면 정리
- 없으면 이 섹션 생략

규칙:
- 간결하고 핵심만 포함
- 음성 전사와 채팅 내용을 통합하여 요약 (별도 구분 불필요)
- 채팅에서 공유된 링크, 파일명, 중요 정보도 포함
- 전사 내용이 짧거나 단순 인사만 있으면 그에 맞게 간단히 요약
- 응답은 마크다운 형식으로 작성`;

export class LlmSummarizer {
  /**
   * 음성 전사 + 채팅을 통합하여 요약 생성
   * @param {object} params
   * @param {string} params.voiceTranscript - 음성 전사 텍스트 ([MM:SS] 화자: 내용)
   * @param {string} params.chatTranscript - 채팅 텍스트 ([HH:MM] 이름: 내용)
   * @param {object} params.stats - 회의 통계
   * @returns {Promise<string|null>} 요약 텍스트 또는 null
   */
  static async summarize({ voiceTranscript, chatTranscript, stats }) {
    if (!config.openrouterApiKey) {
      console.error('[LLM] OpenRouter API 키가 설정되지 않았습니다.');
      return null;
    }

    // 요약할 내용이 없으면 스킵
    const hasVoice = voiceTranscript && voiceTranscript.trim().length > 0;
    const hasChat = chatTranscript && chatTranscript.trim().length > 0;

    if (!hasVoice && !hasChat) {
      console.log('[LLM] 전사/채팅 내용 없음, 요약 스킵');
      return null;
    }

    // 사용자 메시지 조립
    let userMessage = '';

    if (hasVoice) {
      userMessage += `## 음성 전사 내용\n${voiceTranscript}\n\n`;
    }

    if (hasChat) {
      userMessage += `## 텍스트 채팅 내용\n${chatTranscript}\n\n`;
    }

    userMessage += `## 회의 정보\n`;
    userMessage += `- 회의 시간: ${stats.durationFormatted || '알 수 없음'}\n`;
    userMessage += `- 참가자: ${stats.speakers?.join(', ') || '알 수 없음'}\n`;
    userMessage += `- 음성 발언: ${stats.totalUtterances}건\n`;
    if (stats.chatMessageCount > 0) {
      userMessage += `- 텍스트 채팅: ${stats.chatMessageCount}건\n`;
    }

    // 토큰 제한 방지: 너무 긴 경우 잘라내기 (약 100K 문자 ≈ 25K 토큰)
    if (userMessage.length > 100000) {
      userMessage = userMessage.substring(0, 100000) + '\n\n...(이하 생략)';
    }

    try {
      console.log('[LLM] OpenRouter 요약 요청 중...');
      const startTime = Date.now();

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openrouterApiKey}`,
        },
        body: JSON.stringify({
          model: config.openrouterModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 2000,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LLM] OpenRouter 요청 실패 (${response.status}):`, errorText);
        return null;
      }

      const data = await response.json();
      const summary = data.choices?.[0]?.message?.content?.trim();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (summary) {
        console.log(`[LLM] 요약 생성 완료 (${elapsed}초, ${summary.length}자)`);
        return summary;
      }

      console.warn('[LLM] 응답에 요약 내용 없음');
      return null;
    } catch (err) {
      console.error('[LLM] 요약 생성 오류:', err.message);
      return null;
    }
  }
}
