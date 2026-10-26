import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './accounts.mjs';

// 协议数据的落盘层，分三套，各管一件事：
//
//   data/protocol.log                  按时序的取证流水：一轮里「先发什么、后回什么」看它。
//                                      一行一眼能看完，所以 body 仍然截断、心跳类噪音不写、按大小轮转。
//   data/responses/<日期>/<消息名>.jsonl  原始回包档案：全量、不截断、按接口分文件。
//                                      重建背包/海面/任务快照这类离线分析从这里读。
//   data/console/<日期>.log             网页「运行记录」：屏幕上那些人话日志（哪轮做了什么、
//                                      哪一步失败、钻石变了多少）。协议层看不出「为什么跳过」，
//                                      只能靠它；以前只在内存里留 400 条，刷新/重启就没了。
//
// 三边都是**同步写**（openSync + writeSync，不留异步缓冲）：CLI 里 `state` 这种命令
// 连一次、打几条就退出，用 createWriteStream 会丢掉尾巴上那几条 —— 而那几条往往正是
// 你最想看的那条回包。

export const DATA_DIR_RESOLVED = DATA_DIR;
export const ARCHIVE_ROOT = path.join(DATA_DIR, 'responses');
export const PROTOCOL_LOG = path.join(DATA_DIR, 'protocol.log');
export const CONSOLE_ROOT = path.join(DATA_DIR, 'console');

// 心跳与序号确认：量大、无业务信息。既不该刷 protocol.log，也没有归档价值。
export const NOISE_FRAMES = new Set(['PingRequest', 'PingResponse', 'Ack', 'Nack']);

// 出站帧的 body 会被写进协议日志与回包归档 —— 这是事后查「这一轮到底排了什么产品」的
// 唯一取证点。但 LoginRequest 的 body 里带着 openId / token / sign，属于凭证，
// **任何情况下都不许落盘或打到终端**。需要排除新帧时往这里加，不要在调用点各写一份判断。
export const SECRET_FRAMES = new Set(['LoginRequest']);

// 日志用的简短 JSON：截断到 n 字符，避免一条 OnWaterResponse 把日志刷爆。
// 截断一定带省略号 —— 没有标记的半截 JSON 会让人误以为是完整回包。
export function clipBody(body, n = 400) {
  if (body === null || body === undefined) return '';
  let text;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    return '[unserializable]';
  }
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

// CW_ARCHIVE=0 可整体关掉落盘（自检、跑一次性探针时用）。
export function archiveEnabled() {
  return process.env.CW_ARCHIVE !== '0';
}

const TRACE_MAX_BYTES = Number(process.env.CW_TRACE_MAX ?? 32 * 1024 * 1024);
const MAX_ENTRY_CHARS = Number(process.env.CW_ARCHIVE_MAX ?? 16 * 1024 * 1024);
const MAX_HANDLES = 256;

// fd 缓存：同一文件反复 open/write/close 在长时间挂机里是纯浪费，但也不能无限开。
// Map 的插入顺序当 LRU：命中就删了重插，满了就关最旧的那个。
const handles = new Map();

function openHandle(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* 新文件 */
  }
  const handle = { fd: fs.openSync(file, 'a'), size };
  handles.set(file, handle);
  if (handles.size > MAX_HANDLES) {
    const [oldest, old] = handles.entries().next().value;
    handles.delete(oldest);
    try {
      fs.closeSync(old.fd);
    } catch {
      /* 已经关了 */
    }
  }
  return handle;
}

// 同步追加一行。写不进去就算了 —— 归档是旁路，不能因为它把主流程搞挂。
export function appendLine(file, text, { rotateAt = null } = {}) {
  const buf = Buffer.from(text, 'utf8');
  try {
    let handle = handles.get(file);
    if (handle) {
      handles.delete(file);
      handles.set(file, handle);
    } else {
      handle = openHandle(file);
    }
    const limit = rotateAt !== null ? rotateAt : file === PROTOCOL_LOG ? TRACE_MAX_BYTES : 0;
    if (limit > 0 && handle.size + buf.length > limit) {
      try {
        fs.closeSync(handle.fd);
      } catch {
        /* ignore */
      }
      handles.delete(file);
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        /* 轮转失败就继续往原文件写，总比丢了强 */
      }
      handle = openHandle(file);
    }
    fs.writeSync(handle.fd, buf);
    handle.size += buf.length;
    return true;
  } catch {
    return false;
  }
}

// 文件名只允许标识符安全的字符：消息名本来都是 ASCII，但别让一个奇怪的名字逃出目录。
export function safeName(name) {
  return String(name).replace(/[^\w.-]/g, '_') || 'unnamed';
}

// 目录按**本地**日期切：翻天后自动换目录，删旧档案就是删一个日期目录。
export function dayOf(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function archivePath(name, ms = Date.now(), root = ARCHIVE_ROOT) {
  return path.join(root, dayOf(ms), `${safeName(name)}.jsonl`);
}

function autoTag(client) {
  const openId = client?.login?.eworldParams?.openId;
  return typeof openId === 'string' && openId ? openId.slice(0, 8) : null;
}

// 一条记录 = 一次完整收发。name 已经体现在文件名里，不再重复存；
// body 直接拼字符串（只 stringify 一次），超大包只留元信息，不为一条推送把内存撑爆。
export function record({ dir, name, seq, body, tag = null, t = Date.now(), partial = false, src = null }) {
  if (!archiveEnabled()) return false;
  if (!name || NOISE_FRAMES.has(name)) return false;
  if (dir === 'out' && SECRET_FRAMES.has(name)) return false;

  let text;
  try {
    text = JSON.stringify(body ?? null);
  } catch {
    text = null;
  }
  if (text === null) return false;

  const fields = [`"t":${t}`, `"dir":"${dir}"`, `"seq":${Number(seq) || 0}`];
  if (tag) fields.push(`"acc":"${tag}"`);
  if (src) fields.push(`"src":"${src}"`);
  if (partial) fields.push('"partial":true');

  let line;
  if (text.length > MAX_ENTRY_CHARS) {
    fields.push('"oversized":true', `"bytes":${text.length}`, '"body":null');
    line = `{${fields.join(',')}}\n`;
  } else {
    line = `{${fields.join(',')},"body":${text}}\n`;
  }
  return appendLine(archivePath(name, t), line);
}

// 日志时间戳用**本地时间 + 时区偏移**，跟 dayOf() 按本地日期切目录保持一致。
// 之前用 toISOString()（UTC），东八区下日志时间比目录日期早 8 小时 ——
// 事后按「今天这一轮」对日志和归档目录时两边对不上。
export function stamp(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// 时序流水。tag 是账号前缀，CW_DEBUG=1 时同时打到终端。
export function traceLine(tag, line, { t = Date.now() } = {}) {
  if (!archiveEnabled()) return;
  const text = `${stamp(t)}${tag ? ` [${tag}]` : ''} ${line}\n`;
  if (process.env.CW_DEBUG === '1') process.stdout.write(text);
  appendLine(PROTOCOL_LOG, text);
}

// ---- 网页运行记录（人话日志）-----------------------------------------------
// 按**本地日期**切文件，不按大小轮转：一天几千条、几 MB，日期本身就把体积管住了，
// 清旧记录就是删一个 .log。extra 截 300 —— 它是给人看的补充信息，不该让一条推送撑爆一行。

const CONSOLE_EXTRA_CHARS = 300;

export function consoleLogPath(ms = Date.now()) {
  return path.join(CONSOLE_ROOT, `${dayOf(ms)}.log`);
}

// 一条日志 = 磁盘上的一行。换行一律折成「 ⏎ 」：多行摘要（比如一轮挂机的汇总）
// 落盘后如果真占多行，tail / grep 出来的东西会被切碎，事后根本没法按轮对齐。
export function formatConsoleLine({ t = Date.now(), level = 'info', message = '', account = null, extra = null } = {}) {
  const tag = account ? ` [${String(account).slice(0, 8)}]` : '';
  const text = String(message ?? '').replace(/\r?\n/g, ' ⏎ ').trim();
  const tail = clipBody(extra, CONSOLE_EXTRA_CHARS);
  return `${stamp(t)}${tag} [${level}]${text ? ` ${text}` : ''}${tail ? ` ${tail}` : ''}`;
}

// 页面日志落盘。file 只给自检用（写临时文件），运行时一律按日期挑。
export function appendConsole(entry = {}, { file = null } = {}) {
  if (!archiveEnabled()) return false;
  return appendLine(file ?? consoleLogPath(entry.t ?? Date.now()), `${formatConsoleLine(entry)}\n`);
}

// 把一份连接挂到归档上：出站帧、入站回包都落盘，心跳噪音跳过。
// 幂等 —— server 先挂（带 session 前缀），client.connect 里再挂一次也不会重复记。
export function attach(client, { tag = null, log = true } = {}) {
  if (!client) return null;
  if (client.__archiveState) return client.__archiveState;
  const state = { tag: tag ?? autoTag(client), log };
  client.__archiveState = state;

  const label = () => (client.login ? state.tag ?? autoTag(client) : state.tag);

  client.on('frame', ({ dir, name, seq, bytes, body }) => {
    if (!archiveEnabled() || NOISE_FRAMES.has(name)) return;
    // 出站：frame 事件带 body（LoginRequest 除外，它连 connect 里的 emit 都不带 body）
    if (body !== undefined && body !== null) record({ dir: 'out', name, seq, body, tag: label() });
    if (!state.log) return;
    const size = bytes?.byteLength ?? 0;
    const head = `-> [${name}] seq=${seq} ${size}B`;
    const text = body === undefined || body === null || SECRET_FRAMES.has(name) ? '' : clipBody(body);
    traceLine(state.tag, text ? `${head} ${text}` : head);
  });

  client.on('message', ({ seq, name, body }) => {
    if (!archiveEnabled() || NOISE_FRAMES.has(name)) return;
    record({ dir: 'in', name, seq, body, tag: label() });
    if (state.log) traceLine(state.tag, `[${name}] seq=${seq} ${clipBody(body)}`);
  });

  return state;
}

// 下面两个是给 tools/archive.mjs 用的只读视图，不参与运行时。
export function listDays(root = ARCHIVE_ROOT) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function summarizeDay(root = ARCHIVE_ROOT, day = dayOf()) {
  const dir = path.join(root, day);
  let names;
  try {
    names = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return names
    .map((file) => {
      const full = path.join(dir, file);
      const size = fs.statSync(full).size;
      let lines = 0;
      let inbound = 0;
      try {
        const text = fs.readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          lines += 1;
          if (line.includes('"dir":"in"')) inbound += 1;
        }
      } catch {
        /* 读不了就只报大小 */
      }
      return { name: file.replace(/\.jsonl$/, ''), file: full, size, lines, inbound, outbound: lines - inbound };
    })
    .sort((a, b) => b.size - a.size);
}

// 页面运行记录按天一个 .log，跟 responses/<日期>/ 的日期口径一致（都用 dayOf 的本地日期）。
export function listConsoleDays(root = CONSOLE_ROOT) {
  try {
    return fs
      .readdirSync(root)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.log$/.test(file))
      .map((file) => file.replace(/\.log$/, ''))
      .sort();
  } catch {
    return [];
  }
}
