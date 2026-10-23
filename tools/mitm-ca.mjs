import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CA_DIR = path.join(os.homedir(), '.cw-ca');
export const CA_KEY = path.join(CA_DIR, 'ca.key');
export const CA_CRT = path.join(CA_DIR, 'ca.crt');
const LEAF_KEY = path.join(CA_DIR, 'leaf.key');
const SERIAL = path.join(CA_DIR, 'ca.srl');

export const CA_CN = 'CrazyWaterWorld Local Test CA';

// 别指望 PATH 里有 openssl。
// 在 WorkBuddy 沙箱 / Git Bash 里跑时 PATH 带着 PortableGit\usr\bin，随手就能找到；
// 但用户在自己 cmd / PowerShell 里跑 node 时，PATH 里通常只有 Git\cmd，没有 usr\bin，
// execFileSync('openssl') 直接 ENOENT（Node 22 会以 spawnSync ENOENT 崩掉整个进程）。
// 所以这里主动解析一个绝对路径，优先 CW_OPENSSL，其次由 git 反推，最后试常见安装位置。
let opensslCache = null;

export function opensslPath() {
  if (opensslCache) return opensslCache;

  const candidates = [];
  if (process.env.CW_OPENSSL) candidates.push(process.env.CW_OPENSSL);
  candidates.push('openssl'); // 最后手段：交给 PATH

  // 由 git 反推。两种目录结构都要照顾：
  //   Git\cmd\git.exe | Git\bin\git.exe          -> Git\usr\bin\openssl.exe
  //   PortableGit\mingw64\bin\git.exe            -> PortableGit\usr\bin\openssl.exe
  // 所以从 git.exe 所在目录往上找三层，每层都试一遍。
  try {
    const found = execFileSync('where.exe', ['git'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const gitExe of found) {
      let dir = path.dirname(gitExe);
      for (let up = 0; up < 3; up++) {
        candidates.push(
          path.join(dir, 'usr', 'bin', 'openssl.exe'),
          path.join(dir, 'mingw64', 'bin', 'openssl.exe'),
        );
        dir = path.resolve(dir, '..');
      }
    }
  } catch {
    // git 不在 PATH 里也没关系，下面还有硬编码候选
  }

  const localAppData = process.env.LOCALAPPDATA ?? '';
  candidates.push(
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    localAppData && path.join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate !== 'openssl' && !fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      opensslCache = candidate;
      return candidate;
    } catch {
      // 这个候选跑不起来，继续试下一个
    }
  }

  throw new Error(
    '找不到可用的 openssl。请安装 Git for Windows（自带 openssl），'
    + '或把环境变量 CW_OPENSSL 指向 openssl.exe 的完整路径。',
  );
}

function run(args) {
  return execFileSync(opensslPath(), args, {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

// 半残的 CA 目录（只留了 ca.crt、leaf.key 被删）会让 leafFor 在 copyFileSync 上 ENOENT，
// 所以这里要求证书与私钥都在且非空，才算「已就绪」。
function caReady() {
  try {
    return fs.statSync(CA_CRT).size > 0 && fs.statSync(CA_KEY).size > 0;
  } catch {
    return false;
  }
}

export function initCa({ force = false } = {}) {
  fs.mkdirSync(CA_DIR, { recursive: true });
  if (caReady() && !force) {
    if (!fs.existsSync(LEAF_KEY)) run(['genrsa', '-out', LEAF_KEY, '2048']);
    return { created: false, path: CA_CRT };
  }
  run(['genrsa', '-out', CA_KEY, '2048']);
  run([
    'req', '-x509', '-new', '-key', CA_KEY, '-sha256', '-days', '3650',
    '-out', CA_CRT,
    '-subj', `/CN=${CA_CN}/O=${CA_CN}/C=CN`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run(['genrsa', '-out', LEAF_KEY, '2048']);
  return { created: true, path: CA_CRT };
}

// 读一对 leaf 证书。只要有一个为空或解析不了就当「没有缓存」。
// 之前只判断 existsSync，于是 openssl -out 失败时留下的空/残缺 crt 会被当成好缓存反复使用，
// 表现就是某个域名永远签不出证书，报 error:...:DECODER routines::unsupported。
function readPair(crtPath, keyPath) {
  try {
    const cert = fs.readFileSync(crtPath);
    const keyPem = fs.readFileSync(keyPath);
    if (cert.length === 0 || keyPem.length === 0) return null;
    new crypto.X509Certificate(cert); // 解析失败会抛，交给 catch
    return { cert, keyPem };
  } catch {
    return null;
  }
}

export function leafFor(host) {
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const key = path.join(CA_DIR, `leaf-${safe}.key`);
  const crt = path.join(CA_DIR, `leaf-${safe}.crt`);
  const csr = path.join(CA_DIR, `leaf-${safe}.csr`);
  const ext = path.join(CA_DIR, `leaf-${safe}.ext`);

  const cached = readPair(crt, key);
  if (cached) return { key, cert: cached.cert, keyPem: cached.keyPem, cached: true };

  // 走到这里说明缓存不存在、或者上次签发留下了残缺文件 —— 一律清掉重签。
  fs.rmSync(crt, { force: true });
  fs.rmSync(csr, { force: true });

  fs.copyFileSync(LEAF_KEY, key);
  fs.writeFileSync(ext, [
    `subjectAltName=DNS:${host}`,
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    '',
  ].join('\n'));
  try {
    run(['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${host}`]);
    run([
      'x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
      '-out', crt, '-days', '3650', '-sha256', '-extfile', ext,
    ]);
  } catch (error) {
    // 别把半成品留在磁盘上，否则下次会被当成好缓存。
    fs.rmSync(crt, { force: true });
    fs.rmSync(csr, { force: true });
    throw error;
  }

  const fresh = readPair(crt, key);
  if (!fresh) {
    fs.rmSync(crt, { force: true });
    fs.rmSync(csr, { force: true });
    throw new Error(`为 ${host} 签出的证书无法解析（openssl 输出异常），已清理缓存，下次连接会重试`);
  }
  return { key, cert: fresh.cert, keyPem: fresh.keyPem, cached: false };
}

// CA 还没生成（首次扫码、或用户删过 ~/.cw-ca）时返回 null，不要抛 openssl 的原始错误 ——
// 控制台的 GET /api/capture 每次都会问指纹，抛错会让「扫码添加」看起来像是坏了。
export function caFingerprint() {
  if (!fs.existsSync(CA_CRT)) return null;
  try {
    return run(['x509', '-in', CA_CRT, '-noout', '-fingerprint', '-sha256']).trim();
  } catch {
    return null;
  }
}

function userStore() {
  return execFileSync('certutil', ['-user', '-store', 'Root'], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString();
}

export function isInstalled() {
  try {
    return userStore().includes(CA_CN);
  } catch {
    return false;
  }
}

export function installCa() {
  execFileSync('certutil', ['-user', '-addstore', 'Root', CA_CRT], { stdio: 'inherit' });
  return isInstalled();
}

export function uninstallCa() {
  execFileSync('certutil', ['-user', '-delstore', 'Root', CA_CN], { stdio: 'inherit' });
  return isInstalled();
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'init') {
    console.log(initCa({ force: arg === '--force' }));
  } else if (cmd === 'leaf') {
    const result = leafFor(arg);
    console.log(`leaf for ${arg}: cached=${result.cached} ${result.key}`);
  } else if (cmd === 'install') {
    installCa();
    console.log(`installed=${isInstalled()}\n${caFingerprint()}`);
  } else if (cmd === 'uninstall') {
    uninstallCa();
    console.log(`installed=${isInstalled()}`);
  } else if (cmd === 'status') {
    console.log(`ca: ${CA_CRT} exists=${fs.existsSync(CA_CRT)}`);
    console.log(`trusted(current user): ${isInstalled()}`);
  } else {
    console.log('usage: mitm-ca.mjs init [--force] | leaf <host> | install | uninstall | status');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
