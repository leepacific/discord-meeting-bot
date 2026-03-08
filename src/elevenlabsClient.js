import WebSocket from 'ws';
import config from './config.js';

/**
 * ElevenLabs Scribe v2 Realtime STT WebSocket 클라이언트
 * - wss://api.elevenlabs.io/v1/speech-to-text/realtime 으로 직접 연결
 * - PCM 오디오를 base64로 인코딩하여 전송
 * - VAD 기반 자동 커밋으로 전사 결과 수신
 *
 * GladiaClient와 동일한 인터페이스를 유지하여 index.js 변경 최소화:
 *   initSession(), connect(), sendAudio(), stopRecording(), destroy()
 */
export class ElevenLabsClient {
  /**
   * @param {object} opts
   * @param {Function} opts.onTranscript - 전사 결과 콜백
   * @param {Function} opts.onError - 오류 콜백
   * @param {Function} opts.onSessionEnd - 세션 종료 콜백
   * @param {string}   [opts.label] - 로그 식별자 (예: 유저 이름)
   */
  constructor({ onTranscript, onError, onSessionEnd, label, meetingStartTime }) {
    this.onTranscript = onTranscript || (() => {});
    this.onError = onError || (() => {});
    this.onSessionEnd = onSessionEnd || (() => {});
    this.label = label || 'default';
    // 회의 시작 시점 (모든 유저가 동일한 기준점 사용)
    this.meetingStartTime = meetingStartTime || Date.now();
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.destroyed = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.keepAliveTimer = null;
    this.lastAudioSent = 0;

    // 재연결 시 컨텍스트 유지용 (previous_text)
    this.lastCommittedText = '';
    this.needsPreviousText = false;  // 재연결 후 첫 오디오에 previous_text 전송 플래그

    // 연결 끊김 감지용 (연속 send 실패 카운터)
    this.consecutiveSendFailures = 0;
    this.maxConsecutiveSendFailures = 50;  // 50회 연속 실패 시 재연결
  }

  /**
   * 세션 초기화 (ElevenLabs는 별도 HTTP 초기화 불필요)
   * GladiaClient 인터페이스 호환을 위해 유지
   */
  async initSession() {
    if (!config.elevenlabsApiKey) {
      throw new Error('ELEVENLABS_API_KEY가 설정되지 않았습니다.');
    }

    // WebSocket URL 조합
    const params = new URLSearchParams({
      model_id: config.elevenlabs.modelId,
      audio_format: config.audio.encoding,
      commit_strategy: config.elevenlabs.commitStrategy,
      vad_silence_threshold_secs: String(config.elevenlabs.vadSilenceThresholdSecs),
      vad_threshold: String(config.elevenlabs.vadThreshold),
      include_timestamps: 'true',  // 단어별 타임스탬프 활성화 (정확한 발화 시점 기록용)
    });

    // VAD 안정화 파라미터 (잡음/짧은 소리 오인식 방지)
    if (config.elevenlabs.minSpeechDurationMs) {
      params.set('min_speech_duration_ms', String(config.elevenlabs.minSpeechDurationMs));
    }
    if (config.elevenlabs.minSilenceDurationMs) {
      params.set('min_silence_duration_ms', String(config.elevenlabs.minSilenceDurationMs));
    }

    // 한국어 고정 설정이 있으면 추가
    if (config.elevenlabs.languageCode) {
      params.set('language_code', config.elevenlabs.languageCode);
    }

    this.wsUrl = `${config.elevenlabs.wsUrl}?${params.toString()}`;
    this.sessionId = `el-${Date.now()}`;

    console.log(`[ElevenLabs:${this.label}] 세션 준비 완료: ${this.sessionId}`);
    return { sessionId: this.sessionId, wsUrl: this.wsUrl };
  }

  /**
   * WebSocket 연결 및 이벤트 핸들링
   */
  connect() {
    if (!this.wsUrl) {
      throw new Error('세션이 초기화되지 않았습니다. initSession()을 먼저 호출하세요.');
    }
    if (this.destroyed) return;

    console.log(`[ElevenLabs:${this.label}] WebSocket 연결 중...`);
    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        'xi-api-key': config.elevenlabsApiKey,
      },
    });

    this.ws.on('open', () => {
      console.log(`[ElevenLabs:${this.label}] WebSocket 연결 완료`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      // STT 세션 연결 시점 기록 (words[].start는 이 시점 기준 경과 시간)
      this.sttConnectedAt = Date.now();
      this._startKeepAlive();
    });

    this.ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        this._handleMessage(message);
      } catch (err) {
        console.error(`[ElevenLabs:${this.label}] 메시지 파싱 오류:`, err.message);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[ElevenLabs:${this.label}] WebSocket 오류:`, err.message);
      this.onError(err);
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`[ElevenLabs:${this.label}] WebSocket 종료 (code: ${code}${reasonStr ? ', reason: ' + reasonStr : ''})`);
      this.isConnected = false;
      this._stopKeepAlive();

      if (this.destroyed) return;

      // 비정상 종료 시 재연결 시도
      if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        console.log(`[ElevenLabs:${this.label}] ${delay / 1000}초 후 재연결 시도 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        this.reconnectTimer = setTimeout(() => this._reconnect(), delay);
      } else if (code !== 1000) {
        console.error(`[ElevenLabs:${this.label}] 재연결 최대 횟수 초과 (code: ${code})`);
        this.onError(new Error(`ElevenLabs WebSocket 재연결 실패 (code: ${code})`));
      }
    });
  }

  /**
   * 재연결 (새 세션으로)
   */
  async _reconnect() {
    if (this.destroyed) return;

    try {
      // 기존 WS 정리 (리스너 포함)
      if (this.ws) {
        this.ws.removeAllListeners();
        try { this.ws.close(1000); } catch {}
        this.ws = null;
      }
      this.isConnected = false;
      this.consecutiveSendFailures = 0;

      // 재연결 시 첫 오디오 청크에 previous_text 전송 플래그 설정
      if (this.lastCommittedText) {
        this.needsPreviousText = true;
        console.log(`[ElevenLabs:${this.label}] 재연결 시 previous_text 전송 예정: "${this.lastCommittedText}"`);
      }

      console.log(`[ElevenLabs:${this.label}] 재연결 시도...`);
      await this.initSession();
      this.connect();
      // 실제 연결 완료는 ws 'open' 이벤트에서 로그됨
    } catch (err) {
      console.error(`[ElevenLabs:${this.label}] 재연결 실패:`, err.message);
      this.onError(err);
    }
  }

  /**
   * Keep-alive: 무음 구간에서 WebSocket 연결 유지
   * ElevenLabs는 insufficient_audio_activity 에러로 연결을 끊을 수 있음
   * 25초마다 무음 패킷 전송
   */
  _startKeepAlive() {
    this._stopKeepAlive();
    // 16kHz, 16-bit, mono 기준 20ms 무음 = 640 bytes
    const SILENCE_20MS = Buffer.alloc(640, 0);
    const SILENCE_BASE64 = SILENCE_20MS.toString('base64');

    this.keepAliveTimer = setInterval(() => {
      if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // 마지막 오디오 전송 후 25초 이상 경과한 경우만 무음 전송
      if (Date.now() - this.lastAudioSent > 25000) {
        this.ws.send(JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: SILENCE_BASE64,
          sample_rate: 16000,
        }));
      }
    }, 25000);
  }

  _stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /**
   * ElevenLabs 서버 메시지 처리
   */
  _handleMessage(message) {
    // ElevenLabs는 message_type 필드를 사용
    const type = message.message_type || message.type;

    switch (type) {
      case 'session_started': {
        console.log(`[ElevenLabs:${this.label}] 세션 시작 확인: ${JSON.stringify(message)}`);
        break;
      }

      case 'partial_transcript': {
        // 부분 전사 — 로그 (디버깅용)
        if (message.text && message.text.trim().length > 0) {
          console.log(`[ElevenLabs:${this.label}] 부분 전사: "${message.text.trim()}"`);
        }
        break;
      }

      case 'committed_transcript': {
        // include_timestamps=true일 때 committed_transcript_with_timestamps가 별도로 도착하므로
        // committed_transcript는 폴백으로만 처리 (committed_transcript_with_timestamps 미도착 시 대비)
        const text = message.text;
        if (!text || text.trim().length === 0) break;

        this.lastCommittedText = text.trim().slice(-50);

        // committed_transcript_with_timestamps가 도착하지 않을 경우에만 전송 (500ms 대기)
        // 도착하면 _lastTimestampedId로 중복 방지
        const fallbackId = `el-${Date.now()}`;
        this._pendingCommit = { text: text.trim(), id: fallbackId };

        setTimeout(() => {
          if (this._pendingCommit && this._pendingCommit.id === fallbackId) {
            // committed_transcript_with_timestamps가 500ms 이내 도착하지 않음 → 폴백 전송
            const elapsedSec = (Date.now() - this.meetingStartTime) / 1000;
            this.onTranscript({
              text: this._pendingCommit.text,
              channel: 0,
              speaker: null,
              language: config.elevenlabs.languageCode || null,
              start: elapsedSec,
              end: elapsedSec,
              id: fallbackId,
            });
            this._pendingCommit = null;
          }
        }, 500);
        break;
      }

      case 'committed_transcript_with_timestamps': {
        // 단어별 타임스탬프 포함 전사 (include_timestamps=true)
        // words[0].start로 실제 발화 시점을 정확히 기록
        const text2 = message.text;
        if (!text2 || text2.trim().length === 0) break;

        this.lastCommittedText = text2.trim().slice(-50);

        // pending commit 클리어 (중복 전송 방지)
        this._pendingCommit = null;

        // words[0].start = STT 세션 내 오디오 스트림 기준 발화 시작 시점(초)
        // 회의 기준 경과 시간 = (sttConnectedAt - meetingStartTime)/1000 + words[0].start
        const words = message.words || [];
        const firstWordStart = words.length > 0 ? (words[0].start || 0) : 0;
        const lastWordEnd = words.length > 0 ? (words[words.length - 1].end || firstWordStart) : firstWordStart;

        // STT 세션 연결 시점부터 회의 시작까지의 오프셋(초)
        const sttOffsetSec = ((this.sttConnectedAt || this.meetingStartTime) - this.meetingStartTime) / 1000;

        const startSec = sttOffsetSec + firstWordStart;
        const endSec = sttOffsetSec + lastWordEnd;

        console.log(`[ElevenLabs:${this.label}] 타임스탬프 전사: words[0].start=${firstWordStart.toFixed(2)}s, sttOffset=${sttOffsetSec.toFixed(2)}s, 회의기준=${startSec.toFixed(2)}s`);

        this.onTranscript({
          text: text2.trim(),
          channel: 0,
          speaker: null,
          language: message.language_code || config.elevenlabs.languageCode || null,
          start: startSec,
          end: endSec,
          id: `el-${Date.now()}`,
        });
        break;
      }

      // 에러 이벤트들
      case 'auth_error':
      case 'quota_exceeded':
      case 'error':
      case 'input_error':
      case 'transcriber_error':
      case 'rate_limited':
      case 'queue_overflow':
      case 'resource_exhausted':
      case 'chunk_size_exceeded':
      case 'insufficient_audio_activity':
      case 'unaccepted_terms':
      case 'commit_throttled': {
        const errorMsg = message.error || message.message || type;
        console.error(`[ElevenLabs:${this.label}] 서버 오류 (${type}):`, errorMsg);
        this.onError(new Error(`ElevenLabs ${type}: ${errorMsg}`));
        break;
      }

      case 'session_time_limit_exceeded': {
        console.warn(`[ElevenLabs:${this.label}] 세션 시간 제한 초과, 새 세션으로 재연결...`);
        this.onError(new Error('ElevenLabs 세션 시간 초과'));
        // close 이벤트에 의한 중복 재연결 방지: 기존 WS 리스너를 먼저 제거
        if (!this.destroyed) {
          if (this.ws) {
            this.ws.removeAllListeners();
          }
          this._reconnect();
        }
        break;
      }

      default:
        console.log(`[ElevenLabs:${this.label}] 알 수 없는 메시지 타입: ${type}`, JSON.stringify(message).slice(0, 300));
        break;
    }
  }

  /**
   * PCM 오디오 데이터를 ElevenLabs로 전송
   * @param {Buffer} audioBuffer - PCM 16-bit LE 모노 오디오 데이터
   */
  sendAudio(audioBuffer) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 연결이 끊긴 상태에서 연속 실패 감지 → 명시적 재연결
      this.consecutiveSendFailures++;
      if (this.consecutiveSendFailures === this.maxConsecutiveSendFailures) {
        console.warn(`[ElevenLabs:${this.label}] 연속 ${this.consecutiveSendFailures}회 send 실패, 재연결 시도...`);
        this._reconnect();
      }
      return;
    }
    this.consecutiveSendFailures = 0;

    // 오디오 전송 통계 (처음 5회 + 주기적 로그)
    if (!this._sendCount) this._sendCount = 0;
    this._sendCount++;
    if (this._sendCount <= 5 || this._sendCount % 200 === 0) {
      console.log(`[ElevenLabs:${this.label}] 오디오 전송 #${this._sendCount}: ${audioBuffer.length} bytes`);
    }

    // ElevenLabs는 JSON 메시지로 base64 인코딩된 오디오를 전송
    // sample_rate를 명시적으로 포함 (공식 SDK 및 문서 권장사항)
    const message = {
      message_type: 'input_audio_chunk',
      audio_base_64: audioBuffer.toString('base64'),
      sample_rate: 16000,
    };

    // 재연결 후 첫 오디오 청크에 previous_text 전송 (컨텍스트 연속성 유지)
    if (this.needsPreviousText && this.lastCommittedText) {
      message.previous_text = this.lastCommittedText;
      this.needsPreviousText = false;
      console.log(`[ElevenLabs:${this.label}] previous_text 전송: "${this.lastCommittedText}"`);
    }

    this.ws.send(JSON.stringify(message));
    this.lastAudioSent = Date.now();
  }

  /**
   * 녹음 중단 — WebSocket을 정상 종료
   * ElevenLabs는 별도 stop_recording 메시지가 없으므로 WS close로 처리
   */
  stopRecording() {
    this._stopKeepAlive();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[ElevenLabs:${this.label}] WebSocket이 열려있지 않습니다.`);
      return Promise.resolve({ sessionId: this.sessionId });
    }

    console.log(`[ElevenLabs:${this.label}] 녹음 중단: 마지막 세그먼트 커밋 후 종료...`);

    return new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve({ sessionId: this.sessionId });
      };

      if (this.ws) {
        this.ws.once('close', () => {
          console.log(`[ElevenLabs:${this.label}] WS 종료됨`);
          done();
        });
      }

      // 종료 전 마지막 세그먼트 수동 커밋 (flush)
      try {
        this.ws.send(JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: Buffer.alloc(640, 0).toString('base64'),
          sample_rate: 16000,
          commit: true,
        }));
        console.log(`[ElevenLabs:${this.label}] 마지막 커밋 전송 완료`);
      } catch (err) {
        console.warn(`[ElevenLabs:${this.label}] 커밋 전송 실패:`, err.message);
      }

      // 커밋 응답 대기 후 종료 (2초 대기)
      const wsRef = this.ws;
      setTimeout(() => {
        try {
          wsRef.close(1000);
        } catch {}
        // stopRecording 완료 후 ws 참조 정리 (destroy 이중 close 방지)
        if (this.ws === wsRef) {
          this.ws = null;
          this.isConnected = false;
        }
      }, 2000);

      // 타임아웃 안전장치 (10초)
      setTimeout(() => {
        if (!resolved) {
          console.warn(`[ElevenLabs:${this.label}] stopRecording 타임아웃 (10초)`);
          done();
        }
      }, 10000);
    });
  }

  /**
   * 리소스 정리
   */
  destroy() {
    this.destroyed = true;
    this._stopKeepAlive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.wsUrl = null;
      try { this.ws.close(1000); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    console.log(`[ElevenLabs:${this.label}] 클라이언트 정리 완료`);
  }
}
