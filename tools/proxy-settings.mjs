import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const KEY = process.env.CW_REG_KEY
  ?? 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
export const BACKUP = process.env.CW_PROXY_BACKUP
  ?? path.join(os.homedir(), '.cw-ca', 'proxy-backup.json');
const VALUES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

// reg.exe 被拦（安全策略黑名单）和「键里本来就没这几个值」是两件事，但都会让 out 为空。
// 所以这里把退出状态一起带出来，读写分开处理：
//   读 —— 宽容，查不到就当没配过；
//   写 / 备份 —— 严格，失败必须让上层知道，否则会把「注册表根本没动」误报成「代理开关没生效」。
function regRun(args) {
  try {
    return { ok: true, out: execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(), err: '' };
  } catch (error) {
    return {
      ok: false,
      out: error.stdout?.toString() ?? '',
      err: (error.stderr?.toString() ?? '').trim(),
      code: error.status,
    };
  }
}

function regFail(action, r) {
  const detail = r.err
    ? r.err.split(/\r?\n/).filter(Boolean)[0]
    : 'reg.exe 无法启动（可能被安全策略 / 程序黑名单拦截），或当前用户无权改 Internet Settings';
  return new Error(`${action} 失败：${detail}`);
}

function parseValues(out) {
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function readCurrent() {
  return parseValues(regRun(['query', KEY]).out);
}

export function backup() {
  // 读不到就别写备份：空备份会让 restore() 把用户原有的代理配置当成「本不存在」而删掉。
  const r = regRun(['query', KEY]);
  if (!r.ok) throw regFail('读取当前代理设置', r);
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  const values = parseValues(r.out);
  fs.writeFileSync(BACKUP, JSON.stringify({ key: KEY, values, savedAt: new Date().toISOString() }, null, 2));
  return values;
}

export function setProxy(host, port) {
  const mine = `${host}:${port}`;
  const current = readCurrent();

  // 上次没还原干净（进程崩了、或用户直接重启了服务）时，注册表里的 ProxyServer 还是「我们自己」。
  // 这时候如果照常 backup()，备份下来的是被工具改过的值，用户真正的原始代理配置就永久丢了。
  // 所以：当前已指向本工具、且磁盘上还有备份时，保留旧备份不动。
  const pointsAtUs = current.ProxyServer === mine || current.ProxyServer === `http://${mine}`;
  if (!pointsAtUs || !fs.existsSync(BACKUP)) backup();

  for (const args of [
    ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'],
    ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', mine, '/f'],
    ['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f'],
  ]) {
    const r = regRun(args);
    if (!r.ok) throw regFail(`打开系统代理（reg add ${args[3]}）`, r);
  }
  return readCurrent();
}

export function restore() {
  if (!fs.existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP}`);
  const saved = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  for (const name of VALUES) {
    const original = saved.values[name];
    const r = original === undefined
      ? regRun(['delete', KEY, '/v', name, '/f'])
      : regRun(['add', KEY, '/v', name, '/t', name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ', '/d', original, '/f']);
    if (!r.ok) throw regFail(`还原代理设置（${name}）`, r);
  }
  return readCurrent();
}

export function isProxyOn() {
  return readCurrent().ProxyEnable === '0x1';
}

// 备份文件里存的是「开代理之前用户自己的代理」，也就是本工具要级联回去的上游。
export function savedProxy() {
  try {
    const saved = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    return saved.values?.ProxyServer ?? null;
  } catch {
    return null;
  }
}

// ProxyServer 可能是 "127.0.0.1:12334"、"http://127.0.0.1:12334"，
// 也可能是 "http=host:port;https=host:port" 这种分协议写法，取第一个能解析的。
export function parseProxyUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const first = value.split(';')[0].trim();
  const withScheme = first.includes('://') ? first : `http://${first.split('=').pop()}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

// 级联目标：用户原来的代理，但不能是自己（否则会自环）。
export function chainedUpstream(selfPort) {
  const parsed = parseProxyUrl(savedProxy());
  if (!parsed) return null;
  const isSelf = ['127.0.0.1', 'localhost', '::1'].includes(parsed.host) && parsed.port === selfPort;
  return isSelf ? null : parsed;
}

function main() {
  const [cmd, host = '127.0.0.1', port = '17321'] = process.argv.slice(2);
  if (cmd === 'show') {
    console.log(readCurrent());
  } else if (cmd === 'backup') {
    console.log('backed up:', backup());
  } else if (cmd === 'set') {
    console.log('now:', setProxy(host, Number(port)));
  } else if (cmd === 'restore') {
    console.log('restored:', restore());
  } else {
    console.log('usage: proxy-settings.mjs show | backup | set [host] [port] | restore');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
