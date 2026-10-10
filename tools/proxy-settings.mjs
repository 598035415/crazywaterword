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

function reg(args) {
  try {
    return execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (error) {
    return error.stdout?.toString() ?? '';
  }
}

export function readCurrent() {
  const out = reg(['query', KEY]);
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function backup() {
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  const values = readCurrent();
  fs.writeFileSync(BACKUP, JSON.stringify({ key: KEY, values, savedAt: new Date().toISOString() }, null, 2));
  return values;
}

export function setProxy(host, port) {
  backup();
  reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  reg(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`, '/f']);
  reg(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
  return readCurrent();
}

export function restore() {
  if (!fs.existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP}`);
  const saved = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  for (const name of VALUES) {
    const original = saved.values[name];
    if (original === undefined) {
      reg(['delete', KEY, '/v', name, '/f']);
    } else {
      const type = name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ';
      reg(['add', KEY, '/v', name, '/t', type, '/d', original, '/f']);
    }
  }
  return readCurrent();
}

export function isProxyOn() {
  return readCurrent().ProxyEnable === '0x1';
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
