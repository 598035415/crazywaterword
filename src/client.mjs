import { EventEmitter } from 'node:events';
import { createCodec } from './codec.mjs';

export const MAX_SEQ = 2147483647;
const HALF_SEQ = (MAX_SEQ - 1) / 2;

export const TICK_INTERVAL_MS = 1000;
export const PING_TIMEOUT_MS = 1000;
export const LOGIN_TIMEOUT_MS = 15000;
export const ACK_DELAY_MS = 1000;
export const HEARTBEAT_DEADLINE_MS = 604800000 + TICK_INTERVAL_MS;

export const DEFAULT_GATEWAY = 'wss://dhyaoj-gate.khlgamen.com/ws';

export function nextSeqNo(seq) {
  return seq === MAX_SEQ ? 1 : seq + 1;
}

// protobufjs decodes int64 into { low, high, unsigned } when no Long library is
// installed, so values echoed back by the server need converting before compare.
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    return value.high * 4294967296 + (value.low >>> 0);
  }
  return Number(value);
}

export function isSeqNoInRange(seq, right) {
  if (!(right > 0 && right <= MAX_SEQ)) throw new RangeError(`Invalid seqNoRight=${right}`);
  const left = right - HALF_SEQ;
  if (left > 0) return seq >= left && seq <= right;
  return (seq >= 1 && seq <= right) || (seq >= MAX_SEQ + left && seq <= MAX_SEQ);
}

export class GameClient extends EventEmitter {
  constructor({ url = DEFAULT_GATEWAY, protocol, login = null } = {}) {
    super();
    this.url = url;
    this.login = login;
    this.codec = createCodec(protocol);
    this.state = 'IDLE';
    this.socket = null;
    this.sendSeqNo = Math.floor(1000 * Math.random()) + 1;
    this.recvSeqNo = null;
    this.nextAckSeqNo = null;
    this.ackTimer = null;
    this.tickTimer = null;
    this.lastPingTimestamp = 0;
    this.lastResponseAt = 0;
    this.latencyMs = 0;
    this.serverClockOffsetMs = 0;
    this.pending = [];
    this.watchers = [];
    this.sendOrder = 0;
    this.stopping = false;
  }

  get connected() {
    return this.socket !== null && this.socket.readyState === 1;
  }

  setState(state, detail) {
    this.state = state;
    this.emit('state', { state, detail });
  }

  async connect(loginBody = this.login, { timeout = LOGIN_TIMEOUT_MS } = {}) {
    if (this.connected) throw new Error('already connected');
    this.stopping = false;
    this.setState('CONNECTING', this.url);

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    const frame = this.codec.encode('LoginRequest', this.bumpSeqNo(), loginBody || {});

    const body = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('login timeout'));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.onmessage = null;
      };
      socket.onopen = () => {
        this.emit('frame', { dir: 'out', name: 'LoginRequest', seq: this.sendSeqNo, bytes: frame });
        socket.send(frame);
      };
      socket.onerror = () => {
        cleanup();
        reject(new Error('socket error during login'));
      };
      socket.onclose = (event) => {
        cleanup();
        reject(new Error(`socket closed during login: ${event.code} ${event.reason || ''}`));
      };
      socket.onmessage = (event) => {
        let decoded;
        try {
          decoded = this.codec.decode(event.data);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        cleanup();
        if (decoded.name !== 'LoginResponse') {
          reject(new Error(`unexpected auth reply: ${decoded.name}`));
          return;
        }
        resolve(decoded.body);
      };
    }).catch((error) => {
      this.socket = null;
      this.setState('FAILED', error.message);
      throw error;
    });

    if (body.result !== 0) {
      this.socket = null;
      this.setState('REJECTED', `result=${body.result} ${body.errorMessage || ''}`);
      const error = new Error(`login rejected: result=${body.result} ${body.errorMessage || ''}`);
      error.loginResponse = body;
      throw error;
    }

    this.sendSeqNo = body.initSeqNo ?? 0;
    this.recvSeqNo = null;
    this.nextAckSeqNo = null;

    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = (event) => this.onClose(event);
    socket.onerror = () => this.emit('error', new Error('socket error'));

    this.setState('READY', `player=${body.playerInfo?.nickname ?? ''} initSeqNo=${body.initSeqNo}`);
    this.lastPingTimestamp = 0;
    this.sendPing(Date.now());
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.emit('login', body);
    return body;
  }

  bumpSeqNo() {
    this.sendSeqNo = nextSeqNo(this.sendSeqNo);
    return this.sendSeqNo;
  }

  send(name, body) {
    if (!this.connected) throw new Error('not connected');
    const seq = this.bumpSeqNo();
    const frame = this.codec.encode(name, seq, body || {});
    this.emit('frame', { dir: 'out', name, seq, bytes: frame, body });
    this.socket.send(frame);
    return seq;
  }

  sendNoSeq(name, body) {
    if (!this.connected) return false;
    const frame = this.codec.encode(name, 0, body || {});
    this.emit('frame', { dir: 'out', name, seq: 0, bytes: frame, body });
    this.socket.send(frame);
    return true;
  }

  request(name, body, responseName = `${name.slice(0, -7)}Response`, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const entry = { name, responseName, resolve, reject, timer: null, order: this.sendOrder };
      entry.timer = setTimeout(() => {
        this.pending = this.pending.filter((item) => item !== entry);
        reject(new Error(`timeout waiting for ${responseName} (sent ${name})`));
      }, timeout);
      this.pending.push(entry);
      this.sendOrder += 1;
      try {
        this.send(name, body);
      } catch (error) {
        clearTimeout(entry.timer);
        this.pending = this.pending.filter((item) => item !== entry);
        reject(error);
      }
    });
  }

  // 有一部分请求服务端没有配套的 *Response，成功时静默，失败时只推一条 PromptResponse。
  // 这类请求用 sendWatch：发送后守着 prompt 一小段时间，守到了就是被拒，没守到就当作成功。
  sendWatch(name, body, { window = 350 } = {}) {
    const order = this.sendOrder;
    this.sendOrder += 1;
    const seq = this.send(name, body);
    return new Promise((resolve, reject) => {
      const watcher = { name, order, resolve, reject, timer: null };
      watcher.timer = setTimeout(() => {
        this.watchers = this.watchers.filter((item) => item !== watcher);
        resolve({ sent: seq, name });
      }, window);
      this.watchers.push(watcher);
    });
  }

  // PromptResponse 不带我们发出去的 seq，只能按顺序认领：服务端按请求到达顺序应答，
  // 所以一条 prompt 属于「最早那条还没被应答的发送」。若那条刚好是 sendWatch 发出的，
  // 就归它；否则才是某个在飞的 request()。
  attributePrompt(body) {
    const reason = (body?.args ?? []).join(' ') || `prompt=${body?.prompt}`;
    const error = new Error(`server prompt: ${reason}`);
    error.prompt = body;
    const pendingEntry = this.pending.length ? this.pending[this.pending.length - 1] : null;
    const watcher = this.watchers.length && (!pendingEntry || this.watchers[0].order < pendingEntry.order) ? this.watchers[0] : null;
    if (watcher) {
      this.watchers = this.watchers.filter((item) => item !== watcher);
      clearTimeout(watcher.timer);
      error.request = watcher.name;
      watcher.reject(error);
      return;
    }
    if (pendingEntry) {
      this.pending.splice(this.pending.length - 1, 1);
      clearTimeout(pendingEntry.timer);
      error.request = pendingEntry.name;
      pendingEntry.reject(error);
    }
  }

  sendPing(timestamp) {
    this.lastPingTimestamp = timestamp;
    this.sendNoSeq('PingRequest', { clientTimestamp: timestamp });
  }

  tryHandlePong(body) {
    if (!this.lastPingTimestamp) return false;
    // The server echoes our timestamp back as an int64, which decodes to the
    // long-form { low, high } object when no Long library is installed.
    const echoed = toNumber(body?.clientTimestamp);
    if (echoed !== this.lastPingTimestamp) return false;
    const now = Date.now();
    this.lastPingTimestamp = 0;
    const sample = 0.4 * (now - echoed) + 0.6 * this.latencyMs;
    this.latencyMs = Math.round(Math.max(sample, 0));
    this.serverClockOffsetMs = Math.round(toNumber(body.serverTimestamp) - now + sample / 2);
    this.emit('pong', { latencyMs: this.latencyMs, offsetMs: this.serverClockOffsetMs });
    return true;
  }

  onMessage(data) {
    let decoded;
    try {
      decoded = this.codec.decode(data);
    } catch (error) {
      this.emit('error', new Error(`decode failed: ${error.message}`));
      return;
    }
    this.lastResponseAt = Date.now();
    const { seq, name, body } = decoded;
    if (name === 'PingResponse' && this.tryHandlePong(body)) return;

    if (!this.handleSeqNo(seq, name)) return;
    this.emit('message', { seq, name, body });

    if (name === 'ResendFailed') {
      this.emit('fatal', { reason: 'ResendFailed', seqNo: body.seqNo });
      return;
    }
    if (name === 'SCChannelExpired') {
      this.emit('fatal', { reason: 'SCChannelExpired', detail: body.reason });
      return;
    }
    // 业务拦截：服务端拒绝一个请求时不回 *Response，而是推一条 PromptResponse。
    // 不处理的话每次被拒都要干等满超时。
    if (name === 'PromptResponse') {
      this.emit('prompt', body);
      this.attributePrompt(body);
      return;
    }
    const index = this.pending.findIndex((item) => item.responseName === name);
    if (index >= 0) {
      const [entry] = this.pending.splice(index, 1);
      clearTimeout(entry.timer);
      entry.resolve(body);
    }
  }

  handleSeqNo(seq, name) {
    if (seq > 0 && seq <= MAX_SEQ) {
      if (this.recvSeqNo === null) {
        this.recvSeqNo = seq;
      } else if (seq !== nextSeqNo(this.recvSeqNo)) {
        if (isSeqNoInRange(seq, this.recvSeqNo)) {
          this.ack(this.recvSeqNo);
          this.emit('drop', { reason: 'duplicate', name, seq, recvSeqNo: this.recvSeqNo });
        } else {
          this.sendNack(this.recvSeqNo);
          this.emit('drop', { reason: 'gap', name, seq, recvSeqNo: this.recvSeqNo });
        }
        return false;
      } else {
        this.recvSeqNo = seq;
        this.ack(seq);
      }
    }
    return true;
  }

  ack(seq) {
    if (this.nextAckSeqNo === null) {
      this.nextAckSeqNo = seq;
    } else if (!isSeqNoInRange(seq, this.nextAckSeqNo)) {
      this.nextAckSeqNo = seq;
    }
    if (this.ackTimer === null) {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        if (this.nextAckSeqNo !== null) {
          this.sendNoSeq('Ack', { seqNo: this.nextAckSeqNo });
          this.nextAckSeqNo = null;
        }
      }, ACK_DELAY_MS);
    }
  }

  sendNack(seqNo) {
    this.sendNoSeq('Nack', { seqNo });
  }

  tick() {
    if (!this.stopping) {
      const now = Date.now();
      if (this.connected) {
        if (this.lastPingTimestamp > 0) {
          if (now - this.lastPingTimestamp > PING_TIMEOUT_MS) {
            this.emit('warn', 'ping timeout');
            this.lastPingTimestamp = 0;
            this.discardSocket('pingTimeout');
          }
        } else {
          this.sendPing(now);
        }
      }
    }
    this.emit('tick', this.snapshot());
  }

  snapshot() {
    return {
      state: this.state,
      url: this.url,
      connected: this.connected,
      latencyMs: this.latencyMs,
      offsetMs: this.serverClockOffsetMs,
      sendSeqNo: this.sendSeqNo,
      recvSeqNo: this.recvSeqNo,
      lastResponseAt: this.lastResponseAt,
    };
  }

  discardSocket(reason) {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onopen = null;
    try {
      socket.close(4001, reason);
    } catch {
      /* already closing */
    }
  }

  onClose(event) {
    this.socket = null;
    this.emit('close', { code: event?.code, reason: event?.reason });
    if (!this.stopping) this.setState('CLOSED', `code=${event?.code ?? ''}`);
  }

  stop() {
    this.stopping = true;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.tickTimer = null;
    this.ackTimer = null;
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(new Error('client stopped'));
    }
    for (const watcher of this.watchers.splice(0)) {
      clearTimeout(watcher.timer);
      watcher.reject(new Error('client stopped'));
    }
    this.discardSocket('stop');
    this.setState('STOPPED');
  }
}
