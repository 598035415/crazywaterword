// 本机 MITM 代理：解 TLS 后把游戏网关的 WebSocket 帧读出来，抓到 LoginRequest 就回调。
//
// 做成工厂是因为两个地方都要用它：命令行抓包工具（tools/capture-credentials.mjs）和
// 网页控制台（src/capture.mjs）。代理本身不碰文件、不碰注册表，只负责监听与解密；
// 「装证书、改系统代理、回滚」这些系统改动由调用方负责。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { leafFor, isInstalled } from './mitm-ca.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { createCodec } from '../src/codec.mjs';

// 与控制台默认端口分开：控制台 17321，代理 17322。
export const DEFAULT_PROXY_PORT = Number(process.env.CW_PROXY_PORT ?? 17322);
const codec = createCodec(loadProtocol());

export function decodeWsFrame(bytes) {
  if (bytes.length < 12) return null;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nameLength = view.getInt8(9);
    if (nameLength <= 0 || nameLength > 127 || 10 + nameLength + 1 > bytes.length) return null;
    return codec.decode(bytes);
  } catch {
    return null;
  }
}

function makeFrameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        onMessage({ opcode, payload });
        return;
      }
      if (opcode === 0x9 || opcode === 0xa) continue;
      fragments.push(payload);
      if (fin) {
        onMessage({ opcode: 1, payload: Buffer.concat(fragments) });
        fragments = [];
      }
    }
  };
}

// 判断 host 是否落在后缀白名单里（按域名边界匹配，避免 evilkhlgamen.com 被误判）。
export function matchesHostSuffix(host, suffixes) {
  const h = String(host).toLowerCase();
  return suffixes.some((suffix) => {
    const s = String(suffix).toLowerCase();
    return Boolean(s) && (h === s || h.endsWith(`.${s}`));
  });
}

// 启动时探一下上游代理到底通不通。不通就退回直连，别让用户的流量吊在死端口上。
export function probeUpstream(upstream, timeoutMs = 700) {
  if (!upstream) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = net.connect(upstream.port, upstream.host);
    let done = false;
    const settle = (ok) => {
      if (done) return;
      done = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok ? upstream : null);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

// onLogin 收到 { url, name, body, rawFrameHex }，只会在本次运行里触发一次。
// onFrame 可选，用来把下行帧也记下来（调试用）。
export function createProxy({
  port = DEFAULT_PROXY_PORT,
  onLogin,
  onFrame,
  log = () => {},
  interceptPorts,
  interceptHosts,
  upstream = null,
} = {}) {
  const intercept = new Set(interceptPorts ?? (process.env.CW_INTERCEPT_PORTS ?? '443').split(',').map((text) => Number(text.trim())));

  // 只解密游戏自己的域名。默认 443 全解会把整台机器的 HTTPS 都接管过来：
  // 任何一个域名签证书失败，用户那边的浏览器、微信、小程序就跟着一起废。
  // 其余流量一律走隧道透传，跟没装代理一样。
  const hostSuffixes = (interceptHosts ?? process.env.CW_INTERCEPT_HOSTS ?? 'khlgamen.com')
    .split(',')
    .map((text) => text.trim().toLowerCase())
    .filter(Boolean);
  const shouldIntercept = (host) => matchesHostSuffix(host, hostSuffixes);

  const tlsServers = new Map();
  const liveSockets = new Set();
  let captured = false;
  let started = false;

  const httpServer = http.createServer(onRequest);
  httpServer.on('upgrade', onUpgrade);
  httpServer.on('connect', onConnect);
  httpServer.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
  });

  function handleLogin(url, name, body, rawFrame) {
    if (captured) return;
    captured = true;
    try {
      onLogin?.({ url, name, body: JSON.parse(JSON.stringify(body)), rawFrameHex: Buffer.from(rawFrame).toString('hex') });
    } catch (error) {
      log('capture', `处理登录包失败: ${error.message}`);
    }
  }

  function attachWebSocketLogging(socket, direction, context) {
    const reader = makeFrameReader(({ opcode, payload }) => {
      if (opcode === 0x8) {
        log('ws', `${context} 连接关闭`);
        return;
      }
      const decoded = decodeWsFrame(payload);
      if (decoded && direction === 'up' && decoded.name === 'LoginRequest') handleLogin(context, decoded.name, decoded.body, payload);
      if (!decoded) return;
      if (direction === 'up') log('ws', `${context} 上行 ${decoded.name} seq=${decoded.seq}`);
      else log('ws', `${context} 下行 ${decoded.name} seq=${decoded.seq}`);
      onFrame?.({ direction, context, name: decoded.name, seq: decoded.seq, body: decoded.body });
    });
    socket.on('data', reader);
  }

  function tlsServerFor(host, targetPort) {
    const key = `${host}:${targetPort}`;
    if (tlsServers.has(key)) return tlsServers.get(key);
    // leafFor 返回的 key 是**文件路径**，keyPem 才是私钥内容。
    // 这里必须取 keyPem：早先写成 `key: keyPem` 把路径字符串当 PEM 内容传给了 createServer，
    // 结果每个 HTTPS 连接都在这一步报 error:1E08010C:DECODER routines::unsupported。
    const { cert, keyPem } = leafFor(host);
    const server = tls.createServer({ cert, key: keyPem }, (socket) => {
      socket._target = { host, port: targetPort };
      httpServer.emit('connection', socket);
    });
    server.on('tlsClientError', (error) => log('tls', `${key} 客户端错误: ${error.message}`));
    tlsServers.set(key, server);
    return server;
  }

  // 透传隧道。如果用户原本就挂着系统代理（Clash/v2ray 之类），现在被我们顶替了，
  // 隧道优先级联回它 —— 否则原本能出去的境外流量会全部变成直连。
  // 但上游随时可能没开（用户为了抓包把梯子关了，或者它本来就要手动启动），
  // 所以连不上 / 明确拒绝时一定要**回退直连**，不能让整台机器的流量吊死在一个死端口上。
  function openTunnel(host, targetPort, clientSocket, head) {
    const dst = `${host}:${targetPort}`;

    const bridge = (socket) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) socket.write(head);
      clientSocket.pipe(socket);
      socket.pipe(clientSocket);
    };

    const direct = () => {
      const socket = net.connect(targetPort, host, () => bridge(socket));
      socket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => socket.destroy());
    };

    if (!upstream) {
      direct();
      return;
    }

    const socket = net.connect(upstream.port, upstream.host, () => {
      socket.write(`CONNECT ${dst} HTTP/1.1\r\nHost: ${dst}\r\n\r\n`);
    });

    let buffered = Buffer.alloc(0);
    let settled = false;

    const giveUp = (why) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.destroy();
      log('tunnel', `上游代理 ${upstream.host}:${upstream.port} ${why}，${dst} 回退直连`);
      direct();
    };

    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;

      const headText = buffered.subarray(0, end).toString('latin1');
      const rest = buffered.subarray(end + 4);
      if (!/^HTTP\/1\.[01] 2\d\d/.test(headText)) {
        giveUp(`拒绝（${headText.split('\r\n')[0]}）`);
        return;
      }

      settled = true;
      socket.removeListener('data', onData);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) socket.write(head);
      if (rest.length) clientSocket.write(rest);
      clientSocket.pipe(socket);
      socket.pipe(clientSocket);
    }

    socket.on('data', onData);
    socket.on('error', () => {
      if (!settled) giveUp('连不上');
      else clientSocket.destroy();
    });
    socket.setTimeout(5000, () => {
      if (!settled) giveUp('握手超时');
    });
    clientSocket.on('close', () => {
      settled = true;
      socket.destroy();
    });
  }

  function onConnect(req, clientSocket, head) {
    const [host, portText] = req.url.split(':');
    const targetPort = Number(portText || 443);
    const key = `${host}:${targetPort}`;
    log('connect', key);
    clientSocket.on('error', () => {});

    // 端口不在名单里、或者域名不是游戏的，一律隧道透传，免得影响无关程序。
    if (!intercept.has(targetPort) || !shouldIntercept(host)) {
      openTunnel(host, targetPort, clientSocket, head);
      return;
    }

    // 先把叶证书签出来再回 200：签不出来（openssl 找不到、目录不可写）时，
    // 一个连接失败不该让整个挂机进程陪葬，回个 502 让它重连，代理继续服务别的请求。
    let tlsServer;
    try {
      tlsServer = tlsServerFor(host, targetPort);
    } catch (error) {
      log('error', `${key} 签发叶证书失败，本连接已放弃: ${error.message}`);
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.unshift(head);
    tlsServer.emit('connection', clientSocket);
  }

  function onRequest(req, res) {
    let target = req.socket._target;
    let requestPath = req.url;
    if (!target && /^https?:\/\//i.test(req.url)) {
      const url = new URL(req.url);
      target = { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
      requestPath = `${url.pathname}${url.search}`;
    }
    if (!target) {
      res.writeHead(502);
      res.end('proxy: no target');
      return;
    }
    const secure = target.port !== 80;
    const transport = secure ? https : http;
    log('http', `${req.method} ${secure ? 'https' : 'http'}://${target.host}:${target.port}${requestPath}`);

    // 注意：这里别用 upstream 当变量名，会把 createProxy 的 upstream（级联代理）参数遮蔽掉。
    const proxyReq = transport.request({
      host: target.host,
      port: target.port,
      path: requestPath,
      method: req.method,
      headers: req.headers,
      servername: target.host,
      rejectUnauthorized: false,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    proxyReq.on('error', (error) => {
      log('http', `上游出错: ${error.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyReq);
  }

  function onUpgrade(req, clientSocket, head) {
    const target = req.socket._target;
    if (!target) {
      clientSocket.destroy();
      return;
    }
    const secure = target.port !== 80;
    const transport = secure ? https : http;
    const scheme = secure ? 'wss' : 'ws';
    const context = `${scheme}://${target.host}:${target.port}${req.url}`;
    log('upgrade', context);

    // 同上：不要遮蔽外层的 upstream 参数。
    const proxyReq = transport.request({
      host: target.host,
      port: target.port,
      path: req.url,
      method: 'GET',
      headers: req.headers,
      servername: target.host,
      rejectUnauthorized: false,
    });
    proxyReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const headers = Object.entries(upstreamRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      if (head && head.length) upstreamSocket.write(head);
      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead);

      attachWebSocketLogging(upstreamSocket, 'down', context);
      attachWebSocketLogging(clientSocket, 'up', context);

      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => clientSocket.destroy());
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
    proxyReq.on('error', (error) => {
      log('upgrade', `上游出错: ${error.message}`);
      clientSocket.destroy();
    });
    proxyReq.end();
  }

  return {
    port,
    get captured() {
      return captured;
    },
    listen() {
      if (started) return Promise.resolve();
      started = true;
      if (!isInstalled()) log('warn', '当前用户根存储里没有本工具的 CA，请先安装再抓包');
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.removeListener('error', reject);
          log('start', `代理监听 127.0.0.1:${port}`);
          resolve();
        });
      });
    },
    // httpServer.close() 会等活连接自己结束，所以还要把连接都断掉。
    async stop() {
      if (!started) return;
      started = false;
      const closed = new Promise((resolve) => httpServer.close(() => resolve()));
      for (const socket of liveSockets) socket.destroy();
      liveSockets.clear();
      for (const server of tlsServers.values()) server.close();
      tlsServers.clear();
      await closed;
    },
  };
}

// 直接跑就起一个独立代理，把抓到的登录包写到 data/credentials.json。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const out = path.resolve(import.meta.dirname, '../data/credentials.json');
  const logFile = path.resolve(import.meta.dirname, '../data/capture.log');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = (kind, message) => {
    const line = `${new Date().toISOString()} [${kind}] ${message}`;
    console.log(line);
    stream.write(`${line}\n`);
  };
  const proxy = createProxy({
    log,
    onLogin: ({ url, body, rawFrameHex }) => {
      fs.writeFileSync(out, JSON.stringify({ url, login: body, loginFrameHex: rawFrameHex, source: 'mitm', capturedAt: new Date().toISOString() }, null, 2));
      log('capture', `已保存登录凭证 -> ${out}`);
    },
  });
  proxy.listen();
}
