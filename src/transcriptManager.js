/**
 * 전사 결과 관리 및 디스코드 텍스트 채널 출력
 * - 실시간 전사 결과를 화자별로 정리
 * - 디스코드 텍스트 채널에 깔끔하게 출력
 * - 전체 전사 로그 보관 (요약용)
 */
export class TranscriptManager {
  constructor() {
    this.entries = [];        // 전체 전사 기록
    this.channelNames = {};   // channel → 표시 이름
    this.textChannel = null;  // 디스코드 텍스트 채널
    this.messageBuffer = [];  // 메시지 배치 전송용 버퍼
    this.flushTimer = null;
    this.startTime = null;
    this.partialCount = 0;    // 부분 전사 수신 횟수 (status용)
  }

  /**
   * 세션 시작
   */
  start(textChannel) {
    this.textChannel = textChannel;
    this.entries = [];
    this.messageBuffer = [];
    this.startTime = Date.now();
    this._startFlushTimer();
  }

  /**
   * 화자(채널) 이름 설정
   * @param {number} channel - 오디오 채널 번호
   * @param {string} name - 디스코드 유저 이름
   */
  setSpeakerName(channel, name) {
    this.channelNames[channel] = name;
  }

  /**
   * 전사 결과 추가
   */
  addTranscript({ text, channel, language, start, end, id }) {
    if (!text || text.trim().length === 0) return;

    const speakerName = this.channelNames[channel] || `화자 ${channel + 1}`;
    const timestamp = this._formatTimestamp(start);

    const entry = {
      id,
      speaker: speakerName,
      channel,
      text: text.trim(),
      language,
      start,
      end,
      timestamp,
      createdAt: new Date().toISOString(),
    };

    this.entries.push(entry);

    // 실시간 채팅 출력은 비활성화 (요약 + 회의록 파일에만 포함)
    // this.messageBuffer.push(`**${speakerName}** \`${timestamp}\`\n${text.trim()}`);

    console.log(`[Transcript] [${timestamp}] ${speakerName}: ${text.trim()}`);
  }

  /**
   * 메시지 배치 전송 타이머
   * 짧은 시간 동안 모인 메시지를 한 번에 전송 (스팸 방지)
   */
  _startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this._flush();
    }, 3000); // 3초마다 모인 메시지 전송
  }

  /**
   * 버퍼된 메시지를 디스코드로 전송
   */
  async _flush() {
    if (this.messageBuffer.length === 0 || !this.textChannel) return;

    const messages = this.messageBuffer.splice(0);
    const content = messages.join('\n\n');

    // 디스코드 메시지 길이 제한 (2000자)
    if (content.length <= 2000) {
      try {
        await this.textChannel.send(content);
      } catch (err) {
        console.error('[Transcript] 메시지 전송 실패:', err.message);
      }
    } else {
      // 길이 초과 시 분할 전송
      for (const msg of messages) {
        try {
          await this.textChannel.send(msg.substring(0, 2000));
        } catch (err) {
          console.error('[Transcript] 메시지 전송 실패:', err.message);
        }
      }
    }
  }

  /**
   * 초 → "MM:SS" 포맷
   */
  _formatTimestamp(seconds) {
    if (seconds == null) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * 전체 전사 텍스트 반환 (요약용)
   */
  getFullTranscript() {
    // start(경과 시간) 기준으로 시간순 정렬 후 반환
    const sorted = [...this.entries].sort((a, b) => (a.start || 0) - (b.start || 0));
    return sorted
      .map((e) => `[${e.timestamp}] ${e.speaker}: ${e.text}`)
      .join('\n');
  }

  /**
   * 부분 전사 수신 카운트 (status 표시용)
   */
  incrementPartial() {
    this.partialCount++;
  }

  /**
   * 전사 통계 반환
   */
  getStats() {
    const duration = this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0;
    const speakers = [...new Set(this.entries.map((e) => e.speaker))];
    const languages = [...new Set(this.entries.map((e) => e.language).filter(Boolean))];

    return {
      totalUtterances: this.entries.length,
      partialCount: this.partialCount,
      speakers,
      speakerCount: speakers.length,
      languages,
      durationSeconds: duration,
      durationFormatted: this._formatTimestamp(duration),
    };
  }

  /**
   * 리소스 정리
   */
  async destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // 남은 버퍼 전송 (완료 대기 후 textChannel 해제)
    await this._flush();
    this.textChannel = null;
  }
}
