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
  constructor({ onTranscript, onError, onSessionEnd }) {
    this.onTranscript = onTranscript || (() => {});
    this.onError = onError || (() => {});
    this.onSessionEnd = onSessionEnd || (() => {});
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.destroyed = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.keepAliveTimer = null;
    this.lastAudioSent = 0;
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
    });

    // 한국어 고정 설정이 있으면 추가
    if (config.elevenlabs.languageCode) {
      params.set('language_code', config.elevenlabs.languageCode);
    }

    this.wsUrl = `${config.elevenlabs.wsUrl}?${params.toString()}`;
    this.sessionId = `el-${Date.now()}`;

    console.log(`[ElevenLabs] 세션 준비 완료: ${this.sessionId}`);
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

    console.log('[ElevenLabs] WebSocket 연결 중...');
    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        'xi-api-key': config.elevenlabsApiKey,
      },
    });

    this.ws.on('open', () => {
      console.log('[ElevenLabs] WebSocket 연결 완료');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this._startKeepAlive();
    });

    this.ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        this._handleMessage(message);
      } catch (err) {
        console.error('[ElevenLabs] 메시지 파싱 오류:', err.message);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[ElevenLabs] WebSocket 오류:', err.message);
      this.onError(err);
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`[ElevenLabs] WebSocket 종료 (code: ${code}${reasonStr ? ', reason: ' + reasonStr : ''})`);
      this.isConnected = false;
      this._stopKeepAlive();

      if (this.destroyed) return;

      // 비정상 종료 시 재연결 시도
      if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(5000 * this.reconnectAttempts, 30000);
        console.log(`[ElevenLabs] ${delay / 1000}초 후 재연결 시도 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        this.reconnectTimer = setTimeout(() => this._reconnect(), delay);
      } else if (code !== 1000) {
        console.error(`[ElevenLabs] 재연결 최대 횟수 초과 (code: ${code})`);
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
      if (this.ws) {
        try { this.ws.close(1000); } catch {}
        this.ws = null;
      }

      console.log('[ElevenLabs] 재연결 시도...');
      await this.initSession();
      this.connect();
      console.log('[ElevenLabs] 재연결 성공');
    } catch (err) {
      console.error('[ElevenLabs] 재연결 실패:', err.message);
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
        console.log(`[ElevenLabs] 세션 시작 확인: ${JSON.stringify(message)}`);
        break;
      }

      case 'partial_transcript': {
        // 부분 전사 — 로그 (디버깅용)
        if (message.text && message.text.trim().length > 0) {
          console.log(`[ElevenLabs] 부분 전사: "${message.text.trim()}"`);
        }
        break;
      }

      case 'committed_transcript': {
        const text = message.text;
        if (!text || text.trim().length === 0) break;

        this.onTranscript({
          text: text.trim(),
          channel: 0,        // ElevenLabs는 단일 채널
          speaker: null,     // 화자 구분은 voiceHandler의 SSRC 매핑으로 처리
          language: config.elevenlabs.languageCode || null,
          start: null,
          end: null,
          id: `el-${Date.now()}`,
        });
        break;
      }

      case 'committed_transcript_with_timestamps': {
        // 타임스탬프 포함 전사 (include_timestamps=true 시)
        const text = message.text;
        if (!text || text.trim().length === 0) break;

        this.onTranscript({
          text: text.trim(),
          channel: 0,
          speaker: null,
          language: message.language_code || config.elevenlabs.languageCode || null,
          start: null,
          end: null,
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
        console.error(`[ElevenLabs] 서버 오류 (${type}):`, errorMsg);
        this.onError(new Error(`ElevenLabs ${type}: ${errorMsg}`));
        break;
      }

      case 'session_time_limit_exceeded': {
        console.warn('[ElevenLabs] 세션 시간 제한 초과, 새 세션으로 재연결...');
        this.onError(new Error('ElevenLabs 세션 시간 초과'));
        // 자동 재연결
        if (!this.destroyed) {
          this._reconnect();
        }
        break;
      }

      default:
        console.log(`[ElevenLabs] 알 수 없는 메시지 타입: ${type}`, JSON.stringify(message).slice(0, 300));
        break;
    }
  }

  /**
   * PCM 오디오 데이터를 ElevenLabs로 전송
   * @param {Buffer} audioBuffer - PCM 16-bit LE 모노 오디오 데이터
   */
  sendAudio(audioBuffer) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // 오디오 전송 통계 (처음 10회만 로그)
    if (!this._sendCount) this._sendCount = 0;
    this._sendCount++;
    if (this._sendCount <= 10 || this._sendCount % 100 === 0) {
      console.log(`[ElevenLabs] 오디오 전송 #${this._sendCount}: ${audioBuffer.length} bytes`);
    }

    // ElevenLabs는 JSON 메시지로 base64 인코딩된 오디오를 전송
    this.ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: audioBuffer.toString('base64'),
    }));
    this.lastAudioSent = Date.now();
  }

  /**
   * 녹음 중단 — WebSocket을 정상 종료
   * ElevenLabs는 별도 stop_recording 메시지가 없으므로 WS close로 처리
   */
  stopRecording() {
    this._stopKeepAlive();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[ElevenLabs] WebSocket이 열려있지 않습니다.');
      return Promise.resolve({ sessionId: this.sessionId });
    }

    console.log('[ElevenLabs] 녹음 중단 (WebSocket 종료)...');

    return new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve({ sessionId: this.sessionId });
      };

      if (this.ws) {
        this.ws.on('close', () => {
          console.log('[ElevenLabs] WS 종료됨');
          done();
        });
      }

      // 정상 종료 요청
      try {
        this.ws.close(1000);
      } catch {}

      // 타임아웃 안전장치 (10초)
      setTimeout(() => {
        if (!resolved) {
          console.warn('[ElevenLabs] stopRecording 타임아웃 (10초)');
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
    console.log('[ElevenLabs] 클라이언트 정리 완료');
  }
}
