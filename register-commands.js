/**
 * 디스코드 슬래시 커맨드 등록 스크립트
 * 최초 1회 실행: node register-commands.js
 *
 * Discord 슬래시 커맨드 이름은 영문 소문자, 숫자, -, _ 만 허용됩니다.
 * 한글은 description에서 사용합니다.
 */
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('meeting-start')
    .setDescription('현재 음성 채널에서 회의 노트 기록을 시작합니다.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('meeting-stop')
    .setDescription('회의 노트 기록을 종료하고 요약을 생성합니다.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('meeting-status')
    .setDescription('현재 회의 기록 상태를 확인합니다.')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('슬래시 커맨드 등록 중...');

  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
    body: commands,
  });

  console.log('✅ 슬래시 커맨드 등록 완료!');
  console.log('   /meeting-start  - 회의 노트 기록 시작');
  console.log('   /meeting-stop   - 기록 종료 및 요약 생성');
  console.log('   /meeting-status - 현재 상태 확인');
} catch (error) {
  console.error('❌ 커맨드 등록 실패:', error);
}
