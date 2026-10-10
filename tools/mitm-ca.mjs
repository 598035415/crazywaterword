import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CA_DIR = path.join(os.homedir(), '.cw-ca');
export const CA_KEY = path.join(CA_DIR, 'ca.key');
export const CA_CRT = path.join(CA_DIR, 'ca.crt');
const LEAF_KEY = path.join(CA_DIR, 'leaf.key');
const SERIAL = path.join(CA_DIR, 'ca.srl');

export const CA_CN = 'CrazyWaterWorld Local Test CA';

function run(args) {
  return execFileSync('openssl', args, {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

export function initCa({ force = false } = {}) {
  fs.mkdirSync(CA_DIR, { recursive: true });
  if (fs.existsSync(CA_CRT) && !force) return { created: false, path: CA_CRT };
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

export function leafFor(host) {
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const key = path.join(CA_DIR, `leaf-${safe}.key`);
  const crt = path.join(CA_DIR, `leaf-${safe}.crt`);
  if (fs.existsSync(crt) && fs.existsSync(key)) {
    return { key, cert: fs.readFileSync(crt), keyPem: fs.readFileSync(key), cached: true };
  }
  const csr = path.join(CA_DIR, `leaf-${safe}.csr`);
  const ext = path.join(CA_DIR, `leaf-${safe}.ext`);
  fs.copyFileSync(LEAF_KEY, key);
  fs.writeFileSync(ext, [
    `subjectAltName=DNS:${host}`,
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    '',
  ].join('\n'));
  run(['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${host}`]);
  run([
    'x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
    '-out', crt, '-days', '3650', '-sha256', '-extfile', ext,
  ]);
  return { key, cert: fs.readFileSync(crt), keyPem: fs.readFileSync(key), cached: false };
}

export function caFingerprint() {
  return run(['x509', '-in', CA_CRT, '-noout', '-fingerprint', '-sha256']).trim();
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
