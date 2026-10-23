#!/usr/bin/env node
// 把已有的 data/protocol.log 回填成结构化归档（data/responses/<日期>/<接口>.jsonl）。
//
//   node tools/archive-backfill.mjs --dry      只统计，不写盘
//   node tools/archive-backfill.mjs            增量回填（断点记在 data/responses/.backfill.json）
//   node tools/archive-backfill.mjs --reset    忽略断点，整份日志重导
//
// 老日志的入站 body 被截到 400 字符（server 的旧 trace 就是这么写的），所以：
// - 能 JSON.parse 的照原样收下；
// - 解析不了的（被切掉尾巴）也留着，标 partial:true 并把原文放进 raw —— 半条也比没有强，
//   但要能一眼看出它不是完整回包，别拿它当权威。
// 出站 body 结尾带「…」的是被 clipBody 截过的，同样标 partial。
//
// 主日志轮转过之后会有 protocol.log.1（上一代），这里先读 .1 再读主文件，
// 各存各的 offset —— 否则一次轮转就把上一代的数据永久漏掉了。

import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_ROOT, PROTOCOL_LOG, NOISE_FRAMES, record } from '../src/archive.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const reset = args.includes('--reset');
const fileArg = args.indexOf('--file');
const source = fileArg >= 0 ? path.resolve(args[fileArg + 1]) : PROTOCOL_LOG;
const STATE_PATH = path.join(ARCHIVE_ROOT, '.backfill.json');

const RE_OUT = /^(\S+) \[(\w+)\] -> \[(\w+)\] seq=(-?\d+) (\d+)B(?: (.*))?$/;
const RE_IN = /^(\S+) \[(\w+)\] \[(\w+)\] seq=(-?\d+) (.*)$/;

if (!fs.existsSync(ARCHIVE_ROOT)) fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });

function loadState() {
  if (reset || !fs.existsSync(STATE_PATH)) return { files: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (saved.files) return saved;
    // 老格式只有单个 file/offset，迁移一下
    if (saved.file) return { files: { [saved.file]: saved.offset ?? 0 } };
  } catch {
    /* 断点坏了就从头来 */
  }
  return { files: {} };
}

const state = loadState();
const targets = [];
if (fileArg < 0 && fs.existsSync(`${source}.1`)) targets.push(`${source}.1`);
targets.push(source);

const totals = { lines: 0, out: 0, in: 0, partial: 0, skipped: 0, bytes: 0, names: new Set(), spans: [] };

function backfillOne(file) {
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  let start = state.files[file] ?? 0;
  if (size < start) start = 0; // 文件被轮转/截断过
  if (start >= size) return;

  const buf = fs.readFileSync(file);
  const lastBreak = buf.lastIndexOf(0x0a);
  if (lastBreak < start) return;
  // 只吃到最后一个换行为止：末尾那行可能正在写，留给下次。
  const chunk = buf.subarray(start, lastBreak + 1).toString('utf8');

  let localIn = 0;
  let localOut = 0;
  let localPartial = 0;
  let localSkipped = 0;
  let localBytes = 0;
  const names = new Set();

  for (const raw of chunk.split('\n')) {
    if (!raw) continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // 两种行长得不一样（出站多一列字节数），不能共用一套解构：
    //   出站 -> [Name] seq=1 42B {json}
    //   入站     [Name] seq=1 {json}
    let dir = 'out';
    let iso;
    let tag;
    let name;
    let seq;
    let bodyText = '';
    const outMatch = RE_OUT.exec(line);
    if (outMatch) {
      [, iso, tag, name, seq, , bodyText = ''] = outMatch;
    } else {
      const inMatch = RE_IN.exec(line);
      if (!inMatch) {
        localSkipped += 1; // pong 行、旧格式、半截行
        continue;
      }
      dir = 'in';
      [, iso, tag, name, seq, bodyText = ''] = inMatch;
    }
    if (NOISE_FRAMES.has(name) || name === 'LoginRequest') {
      localSkipped += 1;
      continue;
    }

    const t = Date.parse(iso);
    if (!Number.isFinite(t)) {
      localSkipped += 1;
      continue;
    }

    let body;
    let partial = false;
    if (!bodyText) {
      body = {};
    } else if (dir === 'out') {
      const text = bodyText.endsWith('…') ? bodyText.slice(0, -1) : bodyText;
      try {
        body = JSON.parse(text);
        partial = text !== bodyText;
      } catch {
        body = { raw: text };
        partial = true;
      }
    } else {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = { raw: bodyText };
        partial = true;
      }
    }

    if (dir === 'out') localOut += 1;
    else localIn += 1;
    if (partial) localPartial += 1;
    localBytes += bodyText.length;
    names.add(name);

    if (!dry) record({ dir, name, seq: Number(seq) || 0, body, tag, t, partial, src: 'log' });
  }

  state.files[file] = lastBreak + 1;
  totals.lines += localIn + localOut;
  totals.in += localIn;
  totals.out += localOut;
  totals.partial += localPartial;
  totals.skipped += localSkipped;
  totals.bytes += localBytes;
  for (const name of names) totals.names.add(name);
  totals.spans.push(`${path.basename(file)} offset ${start} -> ${lastBreak + 1} / ${size}`);
}

for (const file of targets) backfillOne(file);

if (!dry) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify({ files: state.files, at: new Date().toISOString() }, null, 1)}\n`);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
if (!totals.lines) {
  console.log('没有新行可回填（断点已经在文件末尾）');
} else {
  console.log(`${dry ? '[dry] ' : ''}回填 ${totals.lines} 条（出站 ${totals.out} / 入站 ${totals.in}），其中不完整 ${totals.partial} 条；跳过 ${totals.skipped} 条噪音/无法解析行`);
  if (dry) console.log(`涉及 ${totals.names.size} 个接口，预计写入约 ${mb(totals.bytes)}`);
  else console.log(`已写入 ${ARCHIVE_ROOT}（按本地日期分目录）`);
}
for (const span of totals.spans) console.log(`  ${span}`);
