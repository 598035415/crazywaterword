#!/usr/bin/env node
// 回包归档的只读查看器：不用打开几万个文件的目录，直接看「今天哪些接口回了多少、多大」。
//
//   node tools/archive.mjs days                  有归档的日期
//   node tools/archive.mjs list [day]            某天每个接口的条数/体积（默认今天）
//   node tools/archive.mjs tail <Name> [n]       某接口最后 n 条完整回包（默认 3）
//   node tools/archive.mjs path <Name> [day]     打印文件路径（配合 grep / jq 用）

import fs from 'node:fs';
import { ARCHIVE_ROOT, dayOf, listDays, summarizeDay, archivePath } from '../src/archive.mjs';

const [cmd, ...rest] = process.argv.slice(2);

const bytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`);

function printDays() {
  const days = listDays();
  if (!days.length) {
    console.log(`还没有归档（${ARCHIVE_ROOT}）`);
    return;
  }
  for (const day of days) {
    const rows = summarizeDay(ARCHIVE_ROOT, day);
    const total = rows.reduce((sum, row) => sum + row.size, 0);
    const lines = rows.reduce((sum, row) => sum + row.lines, 0);
    console.log(`${day}  ${String(rows.length).padStart(3)} 个接口  ${String(lines).padStart(7)} 条  ${bytes(total)}`);
  }
}

function printList(day) {
  const rows = summarizeDay(ARCHIVE_ROOT, day);
  if (!rows.length) {
    console.log(`${day} 没有归档，试试 node tools/archive.mjs days`);
    return;
  }
  const nameWidth = Math.max(6, ...rows.map((row) => row.name.length));
  console.log(`${'接口'.padEnd(nameWidth)}  ${'入站'.padStart(7)} ${'出站'.padStart(7)} ${'条数'.padStart(7)} ${'体积'.padStart(8)}`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)}  ${String(row.inbound).padStart(7)} ${String(row.outbound).padStart(7)} ${String(row.lines).padStart(7)} ${bytes(row.size).padStart(8)}`);
  }
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  console.log(`\n${day}  合计 ${rows.reduce((sum, row) => sum + row.lines, 0)} 条 ${bytes(total)}  ->  ${ARCHIVE_ROOT}`);
}

function tail(name, count) {
  const file = archivePath(name);
  if (!fs.existsSync(file)) {
    console.log(`今天没有 ${name} 的归档（${file}）`);
    return;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const picked = lines.slice(-count);
  console.log(`${file}  共 ${lines.length} 条，末尾 ${picked.length} 条：\n`);
  for (const line of picked) {
    try {
      const entry = JSON.parse(line);
      const at = new Date(entry.t).toLocaleString('zh-CN', { hour12: false });
      console.log(`--- ${at} ${entry.dir === 'in' ? '<-' : '->'} seq=${entry.seq}${entry.acc ? ` acc=${entry.acc}` : ''}${entry.partial ? ' [截断的历史行]' : ''}`);
      console.log(JSON.stringify(entry.body, null, 1));
    } catch {
      console.log(`[坏行] ${line.slice(0, 200)}`);
    }
  }
}

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log(`用法：
  node tools/archive.mjs days                  有归档的日期
  node tools/archive.mjs list [day]            某天每个接口的条数/体积（默认今天）
  node tools/archive.mjs tail <Name> [n]       某接口最后 n 条完整回包（默认 3）
  node tools/archive.mjs path <Name> [day]     打印文件路径

样例：
  node tools/archive.mjs list
  node tools/archive.mjs tail AllItemResponse 1`);
} else if (cmd === 'days') {
  printDays();
} else if (cmd === 'list') {
  printList(rest[0] || dayOf());
} else if (cmd === 'tail') {
  if (!rest[0]) throw new Error('要给接口名，例如 AllItemResponse');
  tail(rest[0], Number(rest[1] ?? 3));
} else if (cmd === 'path') {
  if (!rest[0]) throw new Error('要给接口名，例如 AllItemResponse');
  console.log(rest[1] ? archivePath(rest[0], new Date(`${rest[1]}T12:00:00`).getTime()) : archivePath(rest[0]));
} else {
  console.log(`不认识的子命令：${cmd}（跑 node tools/archive.mjs help）`);
  process.exitCode = 1;
}
