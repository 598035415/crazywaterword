#!/usr/bin/env node
// 网页「运行记录」的只读查看器。屏幕上那些中文日志（哪轮做了什么、哪一步失败、
// 钻石变了多少）现在按天落在 data/console/<日期>.log，一行一条。
//
//   node tools/console-log.mjs days                 有记录的日期（条数 + 体积）
//   node tools/console-log.mjs tail [n] [day]       最后 n 条（默认 40，默认今天）
//   node tools/console-log.mjs grep <关键字> [day]  含关键字的行（最多 100 条）
//   node tools/console-log.mjs path [day]           打印文件路径（配合 grep / less）
//
// 跟协议流水是两份东西：protocol.log 是帧级取证（发什么、回什么），
// 这份是决策级记录（为什么跳过、为什么失败）。排查挂机「没干活」先看这里。

import fs from 'node:fs';
import { CONSOLE_ROOT, consoleLogPath, dayOf, listConsoleDays } from '../src/archive.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const GREP_LIMIT = 100;

const bytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`);

function lines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function printDays() {
  const days = listConsoleDays();
  if (!days.length) {
    console.log(`还没有运行记录（${CONSOLE_ROOT}）—— 先跑起来 node src/app.mjs，页面上的日志会自动落盘`);
    return;
  }
  for (const day of days) {
    const file = consoleLogPath(new Date(`${day}T12:00:00`).getTime());
    const rows = lines(file);
    const size = fs.statSync(file).size;
    console.log(`${day}  ${String(rows.length).padStart(6)} 条  ${bytes(size).padStart(7)}`);
  }
}

function resolveDay(day) {
  if (!day) return dayOf();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`日期要写成 2026-10-26，收到的是 ${day}`);
  return day;
}

function tail(count, day) {
  const file = consoleLogPath(new Date(`${resolveDay(day)}T12:00:00`).getTime());
  const rows = lines(file);
  if (!rows.length) {
    console.log(`${file} 里还没有内容，试试 node tools/console-log.mjs days`);
    return;
  }
  const picked = rows.slice(-count);
  console.log(`${file}  共 ${rows.length} 条，末尾 ${picked.length} 条：\n`);
  for (const row of picked) console.log(row);
}

function grep(keyword, day) {
  const file = consoleLogPath(new Date(`${resolveDay(day)}T12:00:00`).getTime());
  const needle = keyword.toLowerCase();
  const hits = lines(file).filter((row) => row.toLowerCase().includes(needle));
  if (!hits.length) {
    console.log(`${file} 里没有匹配「${keyword}」的行`);
    return;
  }
  for (const row of hits.slice(-GREP_LIMIT)) console.log(row);
  if (hits.length > GREP_LIMIT) console.log(`\n…共命中 ${hits.length} 条，只显示最后 ${GREP_LIMIT} 条（缩小关键字或用 path + grep 自己筛）`);
}

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log(`用法：
  node tools/console-log.mjs days                 有记录的日期
  node tools/console-log.mjs tail [n] [day]       最后 n 条（默认 40 / 今天）
  node tools/console-log.mjs grep <关键字> [day]  含关键字的行（最多 100 条）
  node tools/console-log.mjs path [day]           打印文件路径

样例：
  node tools/console-log.mjs tail 60
  node tools/console-log.mjs grep 失败
  node tools/console-log.mjs grep 钻石 2026-10-25`);
} else if (cmd === 'days') {
  printDays();
} else if (cmd === 'tail') {
  // 两个位置参数都可能是数字或日期，按形状认，省得记顺序。
  const args = rest.filter(Boolean);
  const count = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 40);
  const day = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
  tail(count, day);
} else if (cmd === 'grep') {
  if (!rest[0]) throw new Error('要给关键字，例如 失败');
  grep(rest[0], rest[1]);
} else if (cmd === 'path') {
  console.log(consoleLogPath(new Date(`${resolveDay(rest[0])}T12:00:00`).getTime()));
} else {
  console.log(`不认识的子命令：${cmd}（跑 node tools/console-log.mjs help）`);
  process.exitCode = 1;
}
