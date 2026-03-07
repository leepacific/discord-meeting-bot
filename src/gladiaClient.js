import WebSocket from 'ws';
import config from './config.js';

/**
 * Gladia 실시간 STT WebSocket 클라이언트
 * - POST /v2/live 로 세션 초기화
 * - WebSocket 으로 PCM 오디오 스트리밍
 * - 전사 결과 및 후처리(요약) 결과 수신
 */
export class GladiaClient {
  constructor({ onTranscript, onSummary, onError, onSessionEnd }) {
    this.onTranscript = onTranscript || (() => {});
    this.onSummary = onSummary || (() => {});
    this.onError = onError || (() => {});
    this.onSessionEnd = onSessionEnd || (() => {});
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.wsUrl = null;
  }

  /**
   * Gladia 라이브 세션 초기화 (POST /v2/live)
   * 단일 채널(모노)로 초기화. Gladia 내장 diarization이 화자 구분.
   */
  async initSession() {
    const body = {
      encoding: config.audio.encoding,
      sample_rate: config.audio.sampleRate,
      bit_depth: config.audio.bitDepth,
      channels: 1, // 단일 채널 (모노 믹스다운)
      model: config.gladia.model,
      language_config: config.gladia.languageConfig,
      realtime_processing: config.gladia.realtimeProcessing,
      post_processing: config.gladia.postProcessing,
      messages_config: config.gladia.messagesConfig,
    };

    console.log('[Gladia] 세션 초기화 중...');

    const response = await fetch(config.gladiaApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gladia-key': config.gladiaApiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gladia 세션 초기화 실패 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    this.sessionId = data.id;
    this.wsUrl = data.url;

    console.log(`[Gladia] 세션 생성 완료: ${this.sessionId}`);
    return { sessionId: this.sessionId, wsUrl: this.wsUrl };
  }

  /**
   * WebSocket 연결 및 이벤트 핸들링
   */
  connect() {
    if (!this.wsUrl) {
      throw new Error('세션이 초기화되지 않았습니다. initSession()을 먼저 호출하세요.');
    }

    console.log('[Gladia] WebSocket 연결 중...');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('[Gladia] WebSocket 연결 완료');
      this.isConnected = true;
    });

    this.ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        this._handleMessage(message);
      } catch (err) {
        console.error('[Gladia] 메시지 파싱 오류:', err.message);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Gladia] WebSocket 오류:', err.message);
      this.onError(err);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[Gladia] WebSocket 종료 (code: ${code})`);
      this.isConnected = false;

      // 정상 종료 (1000) 가 아닌 경우 재연결 시도
      if (code !== 1000 && this.wsUrl) {
        console.log('[Gladia] 5초 후 재연결 시도...');
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });
  }

  /**
   * Gladia 서버 메시지 처리
   */
  _handleMessage(message) {
    const { type } = message;

    switch (type) {
      case 'transcript': {
        const { data } = message;
        if (!data?.utterance) break;

        const utterance = data.utterance;

        if (utterance.is_final !== false) {
          this.onTranscript({
            text: utterance.text,
            channel: utterance.channel ?? 0,
            speaker: utterance.speaker ?? null,
            language: utterance.language,
            start: utterance.start,
            end: utterance.end,
            id: data.id,
          });
        }
        break;
      }

      case 'post_processing': {
        if (message.data?.summarization) {
          console.log('[Gladia] 요약 결과 수신');
          this.onSummary(message.data.summarization);
        }
        break;
      }

      case 'lifecycle': {
        console.log(`[Gladia] 라이프사이클: ${message.data?.status || JSON.stringify(message.data)}`);
        if (message.data?.status === 'done') {
          this.onSessionEnd(this.sessionId);
        }
        break;
      }

      case 'error': {
        console.error('[Gladia] 서버 오류:', message.data);
        this.onError(new Error(message.data?.message || 'Gladia server error'));
        break;
      }

      default:
        break;
    }
  }

  /**
   * PCM 오디오 데이터를 Gladia로 전송
   * @param {Buffer} audioBuffer - PCM 16-bit LE 모노 오디오 데이터
   */
  sendAudio(audioBuffer) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(audioBuffer);
  }

  /**
   * 녹음 중단 요청 → 후처리(요약) 트리거
   * stop_recording 을 보내면 Gladia가 후처리를 시작하고,
   * 완료되면 WebSocket을 code 1000 으로 닫는다.
   */
  stopRecording() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Gladia] WebSocket이 열려있지 않습니다.');
      return Promise.resolve(this.sessionId);
    }

    console.log('[Gladia] 녹음 중단 요청 전송...');
    this.ws.send(JSON.stringify({ type: 'stop_recording' }));

    return new Promise((resolve) => {
      const originalOnEnd = this.onSessionEnd;
      this.onSessionEnd = (sessionId) => {
        originalOnEnd(sessionId);
        resolve(sessionId);
      };

      // 안전장치: WebSocket close 이벤트로도 resolve
      const origClose = this.ws?.onclose;
      if (this.ws) {
        const ws = this.ws;
        const origListeners = ws.listeners('close');
        ws.on('close', () => resolve(this.sessionId));
      }

      // 타임아웃 안전장치 (60초)
      setTimeout(() => resolve(this.sessionId), 60000);
    });
  }

  /**
   * 세션 결과 조회 (GET /v2/live/:sessionId)
   */
  async getSessionResults() {
    if (!this.sessionId) return null;

    const response = await fetch(`${config.gladiaApiUrl}/${this.sessionId}`, {
      headers: { 'x-gladia-key': config.gladiaApiKey },
    });

    if (!response.ok) {
      console.error(`[Gladia] 결과 조회 실패: ${response.status}`);
      return null;
    }

    return response.json();
  }

  /**
   * 리소스 정리
   */
  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.wsUrl = null; // 재연결 방지
      try { this.ws.close(1000); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    console.log('[Gladia] 클라이언트 정리 완료');
  }
}
