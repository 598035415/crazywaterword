// 网页控制台里的「一键扫码抓包」。
//
// 这是 tools/capture-credentials.mjs 那套流程的库化版本：装 CA、开 WinINET 代理、起代理、抓登录包。
// 区别只在两个地方：
//   1. 进度通过回调报给页面，不再只打终端；
//   2. 系统改动全部记在 module 级的 state 里，stop() 幂等，进程退出钩子会把没回滚的补上。
// 安全边界不变：只改当前用户（certutil -user 与 HKCU），只绑 127.0.0.1，随时可完整回滚。
import { initCa, installCa, isInstalled, uninstallCa, CA_CN, CA_CRT, caFingerprint } from '../tools/mitm-ca.mjs';
import { isProxyOn, readCurrent, restore, setProxy } from '../tools/proxy-settings.mjs';
import { createProxy, DEFAULT_PROXY_PORT } from '../tools/mitm-proxy.mjs';

const state = {
  running: false,
  phase: 'idle',
  error: null,
  port: DEFAULT_PROXY_PORT,
  caInstalled: false,
  proxy: null,
  capturedAt: null,
  accountId: null,
  startedAt: null,
  log: [],
};

let proxy = null;
let hookInstalled = false;

function note(line) {
  state.log.push({ t: new Date().toISOString(), line });
  if (state.log.length > 200) state.log.shift();
  state.onLog?.(line);
}

export function captureState() {
  return {
    running: state.running,
    phase: state.phase,
    error: state.error,
    port: state.port,
    caInstalled: isInstalled(),
    proxy: readCurrent(),
    proxyOn: isProxyOn(),
    accountId: state.accountId,
    capturedAt: state.capturedAt,
    startedAt: state.startedAt,
    log: state.log.slice(-40).map((entry) => entry.line),
    ca: { cn: CA_CN, crt: CA_CRT, fingerprint: caFingerprint() },
  };
}

// 回滚：关代理进程 -> 还原注册表 -> 移除本次 CA。每一步都容错，尽力做完。
export async function stopCapture(reason = '停止') {
  if (!state.running && !proxy) {
    state.phase = 'idle';
    return captureState();
  }
  state.phase = 'stopping';
  note(`停止抓包（${reason}）`);
  try {
    await proxy?.stop();
  } catch (error) {
    note(`代理关闭失败: ${error.message}`);
  }
  proxy = null;

  if (state.proxy) {
    try {
      const after = restore();
      const clean = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'].every((name) => (after[name] ?? '') === (state.proxy[name] ?? ''));
      note(clean ? '系统代理已还原' : `系统代理还原后与备份不一致: ${JSON.stringify(after)}`);
    } catch (error) {
      note(`系统代理还原失败，请手动执行 node tools/proxy-settings.mjs restore（${error.message}）`);
    }
  }
  if (state.caInstalled && !state.keepCa) {
    try {
      uninstallCa();
      note(isInstalled() ? '根证书移除后仍能查到，请手动执行 certutil -user -delstore Root' : '根证书已移除');
    } catch (error) {
      note(`根证书移除失败，请手动执行 certutil -user -delstore Root "${CA_CN}"（${error.message}）`);
    }
  }
  state.running = false;
  state.caInstalled = false;
  state.proxy = null;
  state.phase = 'idle';
  return captureState();
}

// 起抓包。调用方（网页）必须先做那套「勾选 + 倒计时」确认。
export async function startCapture({ onLogin, onLog, port = DEFAULT_PROXY_PORT, keepCa = false } = {}) {
  if (state.running) return captureState();
  state.onLog = onLog;
  state.keepCa = keepCa;
  state.error = null;
  state.port = port;
  state.accountId = null;
  state.capturedAt = null;
  state.log = [];
  state.startedAt = new Date().toISOString();
  state.running = true;

  try {
    state.phase = 'ca';
    initCa();
    installCa();
    state.caInstalled = isInstalled();
    if (!state.caInstalled) throw new Error('证书安装后未能在当前用户根存储中找到');
    note(`本地 CA 已装进当前用户根存储（${caFingerprint()}）`);

    state.phase = 'proxy';
    setProxy('127.0.0.1', port);
    if (!isProxyOn()) throw new Error('系统代理未能打开');
    state.proxy = readCurrent();
    note(`系统代理已指向 127.0.0.1:${port}`);

    state.phase = 'listening';
    proxy = createProxy({
      port,
      log: (kind, message) => {
        if (kind === 'upgrade' || kind === 'capture') note(message);
      },
      onLogin: async (record) => {
        state.capturedAt = new Date().toISOString();
        state.phase = 'captured';
        note('抓到登录包');
        try {
          const result = await onLogin?.(record);
          state.accountId = result?.id ?? null;
        } catch (error) {
          state.error = error.message;
          note(`入库失败: ${error.message}`);
        }
      },
    });
    await proxy.listen();
    state.phase = 'waiting';
    note(`等待游戏登录，请现在在电脑上打开《疯狂水世界》`);

    if (!hookInstalled) {
      hookInstalled = true;
      const cleanup = () => {
        if (state.running) {
          try {
            restore();
          } catch { /* 备份可能已不存在 */ }
          try {
            if (state.caInstalled) uninstallCa();
          } catch { /* 同上 */ }
        }
      };
      process.on('exit', cleanup);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
          cleanup();
          process.exit(130);
        });
      }
    }
  } catch (error) {
    state.error = error.message;
    note(`启动失败: ${error.message}`);
    await stopCapture('启动失败');
    state.error = error.message;
  }
  return captureState();
}

export { DEFAULT_PROXY_PORT };
