import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CA_CRT, CA_CN, caFingerprint, initCa, installCa, isInstalled, uninstallCa } from './mitm-ca.mjs';
import { chainedUpstream, isProxyOn, readCurrent, restore, setProxy } from './proxy-settings.mjs';
import { createProxy, DEFAULT_PROXY_PORT, probeUpstream } from './mitm-proxy.mjs';

const PORT = DEFAULT_PROXY_PORT;
const HOST = '127.0.0.1';
const OUT = path.resolve(import.meta.dirname, '../data/credentials.json');
const POLL_MS = 1000;
const WAIT_MS = Number(process.env.CW_WAIT_MS ?? 300000);

let proxy = null;
let proxied = false;
let installed = false;
let rolledBack = false;

function rollback(reason) {
  if (rolledBack) return;
  rolledBack = true;
  if (!proxied && !installed) return;
  console.log(`\n回滚（${reason}）...`);
  try {
    proxy?.stop();
  } catch {
    /* 没什么可关的 */
  }
  if (proxied) {
    try {
      restore();
      console.log('  代理注册表已还原:', JSON.stringify(readCurrent()));
    } catch (error) {
      console.error('  代理注册表还原失败，请手动执行 node tools/proxy-settings.mjs restore :', error.message);
    }
  }
  if (installed) {
    try {
      uninstallCa();
      console.log(`  根证书已移除，仍存在本次 CA: ${isInstalled()}`);
    } catch (error) {
      console.error(`  根证书移除失败，请手动执行 certutil -user -delstore Root "${CA_CN}" :`, error.message);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    rollback(signal);
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  console.error(error);
  rollback('未捕获异常');
  process.exit(1);
});

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  initCa();

  const before = readCurrent();
  console.log('本次将做两处「仅当前用户」的改动，两者都会在结束时自动还原：\n');
  console.log('  1. 安装本地测试根证书到「当前用户」根存储（不是机器级）');
  console.log(`     证书: ${CA_CRT}`);
  console.log(`     主体: CN=${CA_CN}`);
  console.log(`     ${caFingerprint()}`);
  console.log('     命令: certutil -user -addstore Root <ca.crt>');
  console.log(`     还原: certutil -user -delstore Root "${CA_CN}"\n`);
  console.log(`  2. 打开「当前用户」的 WinINET 代理，指向本机 ${HOST}:${PORT}`);
  console.log('     注册表: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings');
  console.log(`     原值备份: ProxyEnable=${before.ProxyEnable ?? '(无)'}`);
  console.log(`               ProxyServer=${before.ProxyServer ?? '(无)'}`);
  console.log(`               ProxyOverride=${before.ProxyOverride ?? '(无)'}`);
  console.log(`     写入: ProxyEnable=1 ProxyServer=${HOST}:${PORT} ProxyOverride=<local>`);
  console.log('     还原: 逐项写回上面的原值，原本不存在的项会被删除\n');
  console.log('  结束时校验：代理三项注册表与备份一致、根存储中已无本次 CA。');
  console.log('  Ctrl+C 同样会触发回滚。\n');

  if (!(await confirm('确认执行？[y/N] '))) {
    console.log('已取消，未做任何改动。');
    return;
  }

  installCa();
  installed = isInstalled();
  if (!installed) throw new Error('证书安装后未能在当前用户根存储中找到，中止');
  console.log('\n[1/3] 证书已安装（当前用户）。');

  setProxy(HOST, PORT);
  proxied = isProxyOn();
  if (!proxied) throw new Error('代理未能打开，中止');
  const candidate = chainedUpstream(PORT);
  const upstream = await probeUpstream(candidate);
  if (upstream) {
    console.log(`[2/3] 代理已打开 -> ${HOST}:${PORT}（非游戏流量级联到原代理 ${upstream.host}:${upstream.port}）`);
  } else if (candidate) {
    console.log(`[2/3] 代理已打开 -> ${HOST}:${PORT}（原代理 ${candidate.host}:${candidate.port} 没在监听，非游戏流量直连）`);
  } else {
    console.log(`[2/3] 代理已打开 -> ${HOST}:${PORT}（非游戏流量直连）`);
  }

  fs.rmSync(OUT, { force: true });
  proxy = createProxy({
    port: PORT,
    upstream,
    log: (kind, message) => console.log(`${new Date().toISOString()} [${kind}] ${message}`),
    onLogin: ({ url, body, rawFrameHex }) => {
      fs.writeFileSync(OUT, JSON.stringify({
        url,
        login: body,
        loginFrameHex: rawFrameHex,
        source: 'mitm',
        capturedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`\n已保存登录凭证 -> ${OUT}`);
    },
  });
  await proxy.listen();
  console.log('[3/3] 抓包代理已就绪。\n');
  console.log('请现在启动《疯狂水世界》小游戏。');
  console.log('游戏若已在运行，需要完全退出后重新进入，否则不会重新发送登录包。');
  console.log(`等待捕获 LoginRequest，最长 ${Math.round(WAIT_MS / 1000)} 秒...\n`);

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !fs.existsSync(OUT)) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (!fs.existsSync(OUT)) {
    console.log('\n超时，没有捕获到 LoginRequest。');
    console.log('常见原因：游戏未重新启动、TLS 证书固定、或游戏未走系统代理。');
    console.log('排查线索见 data/capture.log。');
    return;
  }

  const captured = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const params = captured.login?.eworldParams ?? {};
  const mask = (value) => (typeof value === 'string' && value.length > 8
    ? `${value.slice(0, 4)}...${value.slice(-4)} (len=${value.length})`
    : String(value));
  console.log('\n已捕获登录凭证：');
  console.log(`  url:       ${captured.url}`);
  console.log(`  openId:    ${mask(params.openId)}`);
  console.log(`  token:     ${mask(params.token)}`);
  console.log(`  timestamp: ${params.timestamp?.low ?? params.timestamp}`);
  console.log(`  sign:      ${mask(params.sign)}`);
  console.log(`  保存于:    ${OUT}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rollback('完成'));
