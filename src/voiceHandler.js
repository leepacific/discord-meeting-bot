import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} from '@discordjs/voice';
import { Transform } from 'stream';
import prism from 'prism-media';

/**
 * 디스코드 음성 채널 핸들러
 * - 음성 채널 접속/퇴장
 * - 유저별 오디오 스트림 수신 (Opus → PCM 변환)
 * - 모노 믹스다운 후 Gladia 로 단일 채널 전송
 *   (Gladia 내장 diarization 이 화자 구분 담당)
 */
export class VoiceHandler {
  constructor({ onAudioData, onUserJoin, onUserLeave }) {
    this.onAudioData = onAudioData || (() => {});
    this.onUserJoin = onUserJoin || (() => {});
    this.onUserLeave = onUserLeave || (() => {});

    this.connection = null;
    this.activeStreams = new Map();   // userId → { opusStream, decoder, cleanup }
    this.userChannelMap = new Map();  // userId → channel index (화자 구분용)
    this.nextChannel = 0;
    this.mixInterval = null;
    this.userBuffers = new Map();     // userId → [PCM 16kHz mono chunks]
    this.destroyed = false;
  }

  /**
   * 음성 채널 접속
   */
  async join(voiceChannel) {
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,  // 봇이 오디오를 수신해야 하므로 deaf 해제
      selfMute: true,   // 봇은 말하지 않음
    });

    // 연결 완료 대기
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      console.log(`[Voice] 음성 채널 접속 완료: ${voiceChannel.name}`);
    } catch (err) {
      this.connection.destroy();
      this.connection = null;
      throw new Error(`음성 채널 연결 실패: ${err.message}`);
    }

    // 연결 상태 모니터링
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed) return;
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.destroyed) this.destroy();
      }
    });

    // 유저 스피킹 이벤트 감지 → 오디오 구독 시작
    this.connection.receiver.speaking.on('start', (userId) => {
      if (!this.activeStreams.has(userId) && !this.destroyed) {
        this._subscribeUser(userId);
      }
    });

    // 주기적으로 오디오 믹싱 및 전송
    this._startMixing();

    return this.connection;
  }

  /**
   * 유저의 오디오 스트림 구독
   * prism-media 의 opus.Decoder 를 사용 (opusscript 를 자동 감지)
   */
  _subscribeUser(userId) {
    if (!this.connection) return;

    // 채널 번호 할당 (화자 구분 표시용)
    if (!this.userChannelMap.has(userId)) {
      this.userChannelMap.set(userId, this.nextChannel++);
      this.onUserJoin(userId, this.userChannelMap.get(userId));
    }

    // 이미 버퍼가 없으면 생성
    if (!this.userBuffers.has(userId)) {
      this.userBuffers.set(userId, []);
    }

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterInactivity,
        duration: 1000,
      },
    });

    // prism-media Opus 디코더: Opus → PCM 48kHz stereo
    // prism-media는 @discordjs/opus 또는 opusscript 를 자동으로 감지하여 사용
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
        if (buf) buf.push(pcm16kMono);
      } catch (err) {
        // 변환 실패 무시
      }
    });

    const cleanup = () => {
      this.activeStreams.delete(userId);
    };

    opusStream.on('end', cleanup);
    opusStream.on('error', (err) => {
      console.error(`[Voice] 유저 ${userId} 스트림 오류:`, err.message);
      cleanup();
    });
    decoder.on('error', (err) => {
      console.error(`[Voice] 유저 ${userId} 디코더 오류:`, err.message);
    });

    this.activeStreams.set(userId, { opusStream, decoder, cleanup });
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
   * 주기적 오디오 믹싱 및 전송
   * 모든 유저의 오디오를 모노로 믹스다운하여 단일 채널로 전송
   */
  _startMixing() {
    const MIX_INTERVAL_MS = 100; // 100ms 단위로 전송

    this.mixInterval = setInterval(() => {
      if (this.destroyed) return;

      const allChunks = [];
      for (const [, chunks] of this.userBuffers) {
        if (chunks.length > 0) {
          allChunks.push(...chunks.splice(0));
        }
      }

      if (allChunks.length === 0) return;

      const combined = Buffer.concat(allChunks);
      if (combined.length > 0) {
        this.onAudioData(combined);
      }
    }, MIX_INTERVAL_MS);
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

    if (this.mixInterval) {
      clearInterval(this.mixInterval);
      this.mixInterval = null;
    }

    for (const [, { cleanup }] of this.activeStreams) {
      try { cleanup(); } catch {}
    }
    this.activeStreams.clear();
    this.userBuffers.clear();

    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }

    console.log('[Voice] 음성 핸들러 정리 완료');
  }
}
