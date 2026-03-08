import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'stream';

/**
 * 디스코드 음성 채널 핸들러
 * - 음성 채널 접속/퇴장
 * - 유저별 오디오 스트림 수신 (Opus → PCM 변환)
 * - 모노 믹스다운 후 STT 엔진으로 단일 채널 전송
 *   (SSRC 기반 화자 구분 담당)
 *
 * NOTE: Discord DAVE (E2EE) 프로토콜 지원 (2026.03.02 이후 필수)
 *       @snazzah/davey 패키지가 node_modules에 있으면 자동으로 DAVE 활성화됨
 */
export class VoiceHandler {
  constructor({ onUserAudioData, onUserJoin, onUserLeave, onForceDisconnect }) {
    this.onUserAudioData = onUserAudioData || (() => {});  // (userId, buffer)
    this.onUserJoin = onUserJoin || (() => {});
    this.onUserLeave = onUserLeave || (() => {});
    this.onForceDisconnect = onForceDisconnect || (() => {});

    this.connection = null;
    this.activeStreams = new Map();   // userId → { opusStream, decoder, cleanup }
    this.userChannelMap = new Map();  // userId → channel index (화자 구분용)
    this.nextChannel = 0;
    this.mixInterval = null;
    this.userBuffers = new Map();     // userId → [PCM 16kHz mono chunks]
    this.destroyed = false;

    // 무음 재생용 AudioPlayer (오디오 수신 활성화에 필요)
    this.silencePlayer = null;

    // DAVE 핸드셰이크 완료 대기: speaking 이벤트 구독 지연
    this.daveReady = false;
    this.pendingSpeakers = new Set(); // DAVE 준비 전 speaking 감지된 유저

    // 메모리 관리: 비활성 유저 스트림 정리 타이머
    this.inactivityCleanupInterval = null;
    this.userLastActive = new Map();  // userId → timestamp
  }

  /**
   * 음성 채널 접속
   * DAVE E2EE 프로토콜 활성화 (2026.03.02 이후 Discord 필수 요구사항)
   */
  async join(voiceChannel) {
    console.log(`[Voice] 음성 채널 접속 시도: ${voiceChannel.name} (${voiceChannel.id})`);

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,  // 봇이 오디오를 수신해야 하므로 deaf 해제
      selfMute: true,   // 봇은 말하지 않음
      // DAVE E2EE 활성화 (@snazzah/davey가 자동으로 핸드셰이크 처리)
      daveEncryption: true,
      // 복호화 실패 허용 횟수 - DAVE 키 전환(rotation) 중 일시적 실패 대비
      decryptionFailureTolerance: 500,
      // debug 플래그 유지 (오디오 수신 안정성에 필요)
      debug: true,
    });

    // 디버그 로그 (에러/경고만 출력, DAVE 복호화 실패는 10회 이상 연속 시에만)
    let consecutiveDecryptFails = 0;
    this.connection.on('debug', (msg) => {
      if (msg.includes('Failed to decrypt')) {
        consecutiveDecryptFails++;
        if (consecutiveDecryptFails === 10 || consecutiveDecryptFails % 50 === 0) {
          console.warn(`[Voice:DAVE] 복호화 실패 ${consecutiveDecryptFails}회 연속`);
        }
      } else {
        if (consecutiveDecryptFails > 0) consecutiveDecryptFails = 0;
        if (msg.includes('error') || msg.includes('Error')) {
          console.log(`[Voice:debug] ${msg.substring(0, 300)}`);
        }
      }
    });

    // 연결 상태 변화 로그 (핵심 상태만)
    this.connection.on('stateChange', (oldState, newState) => {
      console.log(`[Voice] 연결 상태: ${oldState.status} → ${newState.status}`);

      // 봇이 외부 요인(킥, 서버 이동 등)으로 Destroyed 상태가 되면 콜백 호출
      if (newState.status === VoiceConnectionStatus.Destroyed && !this.destroyed) {
        console.log('[Voice] 외부 요인으로 연결 종료됨, 세션 정리 요청');
        this.destroyed = true;
        this._cleanupTimers();
        this._cleanupAllStreams();
        this.onForceDisconnect();
      }
    });

    // 연결 에러 로깅
    this.connection.on('error', (err) => {
      console.error('[Voice] 연결 오류:', err.message);
    });

    // 연결 완료 대기 (45초 타임아웃 - DAVE 핸드셰이크 포함)
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 45_000);
      console.log(`[Voice] 음성 채널 접속 완료: ${voiceChannel.name}`);
    } catch (err) {
      console.error(`[Voice] 연결 실패:`, err.message);
      this.connection?.destroy();
      this.connection = null;
      throw new Error(`음성 채널 연결 실패: ${err.message}`);
    }

    // 연결 끊김 감지 → 재연결 시도
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed) return;
      console.log('[Voice] 연결 끊김 감지, 재연결 대기...');

      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('[Voice] 재연결 진행 중...');
        await entersState(this.connection, VoiceConnectionStatus.Ready, 45_000);
        console.log('[Voice] 재연결 성공');
      } catch {
        console.log('[Voice] 재연결 실패, 정리 중...');
        if (!this.destroyed) this.destroy();
      }
    });

    // UDP 패킷 수신 모니터링 (기능 유지에 필요, 로그 주기만 60초로)
    this._monitorUdpPackets();

    // 무음 재생 시작 — Discord에서 오디오 수신을 활성화하려면
    // 봇이 무엇이라도 재생해야 오디오 수신 파이프라인이 열림
    this._startSilencePlayer();

    // DAVE 핸드셰이크 완료 대기 (5초)
    // 선행 구독을 제거하고, DAVE 키 교환이 완료된 후에만 유저를 구독
    console.log('[Voice] DAVE 핸드셰이크 완료 대기 (5초)...');
    this.daveReady = false;
    this.daveReadyTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.daveReady = true;
      console.log(`[Voice] DAVE 준비 완료, 대기 중인 유저 ${this.pendingSpeakers.size}명 구독 시작`);
      // DAVE 준비 전에 speaking을 감지한 유저들 구독
      for (const userId of this.pendingSpeakers) {
        if (!this.activeStreams.has(userId) && !this.destroyed) {
          this._subscribeUser(userId);
        }
      }
      this.pendingSpeakers.clear();
    }, 5000);

    // 유저 스피킹 이벤트 감지 → DAVE 준비되면 즉시 구독, 아니면 대기 목록에 추가
    this.connection.receiver.speaking.on('start', (userId) => {
      if (this.destroyed) return;
      if (this.activeStreams.has(userId)) return;

      if (this.daveReady) {
        this._subscribeUser(userId);
      } else {
        // DAVE 키 교환 완료 전이면 대기 목록에 추가
        this.pendingSpeakers.add(userId);
        console.log(`[Voice] DAVE 대기 중 — 유저 ${userId} 구독 지연`);
      }
    });

    // 주기적으로 오디오 믹싱 및 전송
    this._startMixing();

    // 비활성 유저 스트림 정리 타이머 (메모리 누수 방지)
    this._startInactivityCleanup();

    return this.connection;
  }

  /**
   * 무음 재생 — Discord의 오디오 수신 파이프라인 활성화
   * Discord는 봇이 무엇이라도 재생해야 오디오 수신이 정상 동작함
   * 0.25초마다 무음 Opus 프레임을 생성하는 스트림을 재생
   */
  _startSilencePlayer() {
    if (!this.connection) return;

    try {
      this.silencePlayer = createAudioPlayer();

      // 무음 Opus 프레임 (0xF8, 0xFF, 0xFE = Opus silence frame)
      const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

      // 무한 무음 스트림 생성
      const silenceStream = new Readable({
        read() {
          // 250ms마다 무음 프레임 푸시 (배터리 절약)
          setTimeout(() => {
            this.push(SILENCE_FRAME);
          }, 250);
        },
      });

      const resource = createAudioResource(silenceStream, {
        inputType: StreamType.Opus,
      });

      this.silencePlayer.play(resource);
      this.connection.subscribe(this.silencePlayer);

      console.log('[Voice] 무음 재생 시작 (오디오 수신 활성화)');
    } catch (err) {
      console.warn('[Voice] 무음 재생 실패 (무시):', err.message);
    }
  }

  /**
   * UDP 패킷 수신 모니터링
   * 기능 동작에 필요 — 로그만 60초 주기로 축소
   */
  _monitorUdpPackets() {
    let udpCount = 0;
    let lastLog = Date.now();
    let monitorAttached = false;

    const tryAttach = () => {
      if (monitorAttached || this.destroyed || !this.connection) return;

      const state = this.connection.state;
      if (state.status === 'ready' && state.networking) {
        const netState = state.networking.state;
        if (netState.code >= 2 && netState.udp) {
          try {
            const udpSocket = netState.udp;
            if (udpSocket && udpSocket.socket) {
              udpSocket.socket.on('message', () => {
                udpCount++;
                const now = Date.now();
                if (now - lastLog > 60000) { // 60초마다 로그
                  console.log(`[Voice] UDP 상태: ${udpCount}개/60초, 스트림: ${this.activeStreams.size}`);
                  udpCount = 0;
                  lastLog = now;
                }
              });
              monitorAttached = true;
            }
          } catch (e) {
            console.log('[Voice] UDP 모니터링 실패:', e.message);
          }
        }
      }
    };

    this.connection.on('stateChange', () => tryAttach());
    tryAttach();
  }

  /**
   * 유저의 오디오 스트림 구독
   * prism-media 의 opus.Decoder 를 사용 (opusscript 를 자동 감지)
   */
  _subscribeUser(userId) {
    if (!this.connection) return;

    // 기존 스트림이 있으면 명시적으로 정리 (메모리 누수 방지)
    if (this.activeStreams.has(userId)) {
      this._cleanupUserStream(userId);
    }

    // 채널 번호 할당 (화자 구분 표시용)
    if (!this.userChannelMap.has(userId)) {
      this.userChannelMap.set(userId, this.nextChannel++);
      this.onUserJoin(userId, this.userChannelMap.get(userId));
    }

    // 버퍼 초기화
    if (!this.userBuffers.has(userId)) {
      this.userBuffers.set(userId, []);
    }
    this.userLastActive.set(userId, Date.now());

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterInactivity,
        duration: 1000,
      },
    });

    // prism-media Opus 디코더: Opus → PCM 48kHz stereo
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    opusStream.pipe(decoder);

    decoder.on('data', (pcm48kStereo) => {
      try {
        // 48kHz stereo → 16kHz mono 다운샘플링
        const pcm16kMono = this._downsample(pcm48kStereo, 48000, 2, 16000);
        const buf = this.userBuffers.get(userId);
        if (buf) {
          buf.push(pcm16kMono);
          this.userLastActive.set(userId, Date.now());
        }
      } catch {
        // 변환 실패 무시
      }
    });

    opusStream.on('end', () => {
      // 스트림 종료 시 activeStreams에서 제거 (다음 speaking에서 재구독됨)
      this._cleanupUserStream(userId);
    });

    opusStream.on('error', (err) => {
      console.error(`[Voice] 유저 ${userId} 스트림 오류:`, err.message);
      this._cleanupUserStream(userId);
    });

    decoder.on('error', (err) => {
      console.error(`[Voice] 유저 ${userId} 디코더 오류:`, err.message);
    });

    this.activeStreams.set(userId, { opusStream, decoder });
  }

  /**
   * 개별 유저 스트림 정리 (메모리 누수 방지)
   */
  _cleanupUserStream(userId) {
    const stream = this.activeStreams.get(userId);
    if (!stream) return;

    try { stream.opusStream.unpipe(stream.decoder); } catch {}
    try { stream.opusStream.destroy(); } catch {}
    try { stream.decoder.destroy(); } catch {}
    this.activeStreams.delete(userId);
  }

  /**
   * 모든 유저 스트림 일괄 정리
   */
  _cleanupAllStreams() {
    const userIds = [...this.activeStreams.keys()];
    for (const userId of userIds) {
      this._cleanupUserStream(userId);
    }
    this.activeStreams.clear();
    this.userBuffers.clear();
    this.userLastActive.clear();
  }

  /**
   * 타이머 일괄 정리
   */
  _cleanupTimers() {
    if (this.mixInterval) {
      clearInterval(this.mixInterval);
      this.mixInterval = null;
    }
    if (this.inactivityCleanupInterval) {
      clearInterval(this.inactivityCleanupInterval);
      this.inactivityCleanupInterval = null;
    }
    if (this.daveReadyTimer) {
      clearTimeout(this.daveReadyTimer);
      this.daveReadyTimer = null;
    }
  }

  /**
   * 48kHz stereo PCM → 16kHz mono PCM 다운샘플링
   */
  _downsample(inputBuffer, inputRate, inputChannels, outputRate) {
    const bytesPerSample = 2; // 16-bit
    const inputFrames = inputBuffer.length / (bytesPerSample * inputChannels);
    const ratio = inputRate / outputRate; // 3
    const outputFrames = Math.floor(inputFrames / ratio);
    const output = Buffer.alloc(outputFrames * bytesPerSample);

    for (let i = 0; i < outputFrames; i++) {
      const srcFrame = Math.floor(i * ratio);
      // 스테레오 → 모노: 좌/우 채널 평균
      let sample = 0;
      for (let ch = 0; ch < inputChannels; ch++) {
        const offset = (srcFrame * inputChannels + ch) * bytesPerSample;
        if (offset + 1 < inputBuffer.length) {
          sample += inputBuffer.readInt16LE(offset);
        }
      }
      sample = Math.round(sample / inputChannels);
      sample = Math.max(-32768, Math.min(32767, sample));
      output.writeInt16LE(sample, i * bytesPerSample);
    }

    return output;
  }

  /**
   * 주기적 유저별 오디오 전송
   * 각 유저의 오디오를 개별적으로 콜백 전달 (믹스다운 하지 않음)
   */
  _startMixing() {
    const FLUSH_INTERVAL_MS = 100; // 100ms 단위로 전송

    this.mixInterval = setInterval(() => {
      if (this.destroyed) return;

      for (const [userId, chunks] of this.userBuffers) {
        if (chunks.length === 0) continue;

        const userChunks = chunks.splice(0);
        const combined = Buffer.concat(userChunks);
        if (combined.length > 0) {
          this.onUserAudioData(userId, combined);
        }
      }
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * 비활성 유저 스트림 정리 (메모리 누수 방지)
   * 5분 이상 오디오 데이터가 없는 유저의 버퍼를 정리
   */
  _startInactivityCleanup() {
    const CLEANUP_INTERVAL_MS = 60_000;       // 1분마다 체크
    const INACTIVITY_THRESHOLD_MS = 300_000;  // 5분 비활성

    this.inactivityCleanupInterval = setInterval(() => {
      if (this.destroyed) return;
      const now = Date.now();

      for (const [userId, lastActive] of this.userLastActive) {
        if (now - lastActive > INACTIVITY_THRESHOLD_MS) {
          this._cleanupUserStream(userId);
          this.userBuffers.delete(userId);
          this.userLastActive.delete(userId);
          console.log(`[Voice] 비활성 유저 정리: ${userId}`);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * 현재 참가 유저 수
   */
  get userCount() {
    return this.userChannelMap.size;
  }

  /**
   * 리소스 정리 및 퇴장
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    this._cleanupTimers();
    this._cleanupAllStreams();

    // 무음 재생기 정리
    if (this.silencePlayer) {
      try { this.silencePlayer.stop(true); } catch {}
      this.silencePlayer = null;
    }

    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }

    console.log('[Voice] 음성 핸들러 정리 완료');
  }
}
