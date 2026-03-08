/**
 * 텍스트 채널 채팅 수집기
 * - 회의 중 텍스트 채널에 올라온 사람 메시지를 수집
 * - 봇 메시지는 제외
 * - 종료 시 시간순 채팅 텍스트 반환
 */
export class ChatCollector {
  /**
   * @param {import('discord.js').Client} client - Discord 클라이언트
   */
  constructor(client) {
    this.client = client;
    this.textChannelId = null;
    this.messages = [];       // { timestamp, author, content }
    this.startTime = null;
    this._onMessage = null;   // 이벤트 리스너 참조 (해제용)
  }

  /**
   * 수집 시작
   * @param {import('discord.js').TextChannel} textChannel - 수집 대상 텍스트 채널
   */
  start(textChannel) {
    this.textChannelId = textChannel.id;
    this.messages = [];
    this.startTime = Date.now();

    this._onMessage = (message) => {
      // 해당 채널만
      if (message.channelId !== this.textChannelId) return;
      // 봇 메시지 제외
      if (message.author.bot) return;
      // 빈 메시지 제외
      if (!message.content || message.content.trim().length === 0) return;

      this.messages.push({
        timestamp: message.createdAt,
        author: message.member?.displayName || message.author.username,
        content: message.content.trim(),
      });
    };

    this.client.on('messageCreate', this._onMessage);
    console.log(`[ChatCollector] 채팅 수집 시작: 채널 ${this.textChannelId}`);
  }

  /**
   * 수집된 메시지 배열 반환
   */
  getMessages() {
    return [...this.messages];
  }

  /**
   * 수집된 메시지 수
   */
  get messageCount() {
    return this.messages.length;
  }

  /**
   * 채팅 텍스트 반환 (시간순)
   * 형식: [HH:MM] 이름: 내용
   */
  getChatTranscript() {
    return this.messages
      .map((m) => {
        const time = m.timestamp instanceof Date
          ? m.timestamp.toTimeString().slice(0, 5)
          : new Date(m.timestamp).toTimeString().slice(0, 5);
        return `[${time}] ${m.author}: ${m.content}`;
      })
      .join('\n');
  }

  /**
   * 리소스 정리 — 이벤트 리스너 해제
   */
  destroy() {
    if (this._onMessage) {
      this.client.removeListener('messageCreate', this._onMessage);
      this._onMessage = null;
    }
    console.log(`[ChatCollector] 정리 완료 (수집된 메시지: ${this.messages.length}건)`);
  }
}
