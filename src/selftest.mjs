import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadProtocol } from './proto.mjs';
import { createCodec, HEADER_PREFIX } from './codec.mjs';
import { compressBlock, decompressBlock, compressBound, makeHashTable } from './lz4.mjs';
import { GameClient, SECRET_FRAMES, clipBody } from './client.mjs';
import { gateDue, humanDuration, formatLoopRound, loopTotal, loopGap, MIN_LOOP_GAP_MS, tradeGainedReward } from './loop.mjs';
import {
  tradeParams,
  tradeWindow,
  nextRefreshAt,
  viewTradeKing,
  planTradeKing,
} from './tradeKing.mjs';
import {
  bigNum,
  gsParams,
  gsShipSpec,
  nextRefreshAt as gsNextRefreshAt,
  seekCheck,
  viewGuildShip,
  planGuildShip,
  summarizeGuildShip,
  formatGuildShipGain,
  formatGuildShipSummary,
  GS_STATE_MOVING,
  GS_STATE_PREPARED,
} from './guildShip.mjs';
import {
  guildIndex,
  rollWarWindow,
  phaseOf,
  nextWarStartAt,
  attackPetrolUnit,
  attackPetrolCost,
  cityDistance,
  planCityWar,
  formatCityWarSummary,
  claimWarOnlineReward,
  formatOnlineReward,
  warPollInterval,
  CW_STATE_IDLE,
} from './cityWar.mjs';
import { viewYoudu, planYoudu, formatYouduSummary, settleYouduEdict, runYouduActive, summarizeYoudu, isYouduClosed, YOUDU_ACTIVITY_ID } from './youdu.mjs';

const require = createRequire(import.meta.url);
const minimal = require('protobufjs/minimal');

const protocol = loadProtocol();
const codec = createCodec(protocol);

function referenceEncode(name, seq, body) {
  const nameLength = name.length;
  const headerLength = HEADER_PREFIX + nameLength + 1;
  const headerBuffer = new ArrayBuffer(142);
  new Uint8Array(headerBuffer, 0, headerLength).fill(0);
  const view = new DataView(headerBuffer);
  let cursor = 4;
  view.setInt8(cursor, 2); cursor += 1;
  view.setInt32(cursor, seq); cursor += 4;
  view.setInt8(cursor, nameLength); cursor += 1;
  for (let i = 0; i < nameLength; i += 1) view.setUint8(cursor + i, name.charCodeAt(i));
  view.setInt8(cursor + nameLength, 0);
  const writer = minimal.Writer.create();
  writer.bytes(new Uint8Array(headerBuffer, 0, headerLength));
  protocol[name].encode(body, writer);
  const raw = writer.finish();
  new DataView(raw.buffer).setInt32(raw.byteOffset + 1, raw.length - 1 - 4);
  return raw.buffer.slice(raw.byteOffset + 1, raw.byteOffset + raw.length);
}

const cases = [
  ['PingRequest', 0, { clientTimestamp: 1234567890123 }],
  ['PingResponse', 42, { clientTimestamp: 1234567890123, serverTimestamp: 1234567890999 }],
  ['Ack', 0, { seqNo: 7 }],
  ['LoginRequest', 1, { language: 'zh_CN', worldId: 1, eworldParams: { openId: 'oX', token: 'tk', timestamp: 1700000000, sign: 'sg' } }],
  ['LoginResponse', 2147483647, { result: 1, initSeqNo: 5, errorMessage: '', playerInfo: { playerId: 10001, nickname: 'tester', level: 3 } }],
];

let checked = 0;
for (const [name, seq, body] of cases) {
  const mine = codec.encode(name, seq, body);
  const ref = new Uint8Array(referenceEncode(name, seq, body));
  assert.deepEqual(Buffer.from(mine), Buffer.from(ref), `encode mismatch for ${name}`);

  const view = new DataView(mine.buffer, mine.byteOffset, mine.byteLength);
  assert.equal(view.getInt32(0), mine.byteLength - 4, `${name}: length field`);
  assert.equal(view.getInt8(4), 2, `${name}: version`);
  assert.equal(view.getInt32(5), seq, `${name}: seq`);
  assert.equal(view.getInt8(9), name.length, `${name}: name length`);

  const back = codec.decode(mine);
  assert.equal(back.seq, seq, `${name}: decoded seq`);
  assert.equal(back.name, name, `${name}: decoded name`);
  assert.equal(
    Buffer.from(protocol[name].encode(back.body, minimal.Writer.create()).finish()).toString('hex'),
    Buffer.from(protocol[name].encode(body, minimal.Writer.create()).finish()).toString('hex'),
    `${name}: body round-trip`,
  );
  checked += 1;
}

// Frames arrive as pooled Buffers / slices over a larger ArrayBuffer; decoding must
// respect the view's own bounds instead of reading to the end of the backing pool.
for (const [name, seq, body] of cases) {
  const frame = codec.encode(name, seq, body);
  const pooled = Buffer.from(frame);
  const sliced = Buffer.alloc(frame.length + 32, 0xaa).subarray(16, 16 + frame.length);
  sliced.set(frame);
  for (const [label, buffer] of [['pooled', pooled], ['sliced', sliced]]) {
    const back = codec.decode(buffer);
    assert.equal(back.name, name, `${name} (${label}): decoded name`);
    assert.equal(back.seq, seq, `${name} (${label}): decoded seq`);
    assert.deepEqual(
      JSON.parse(JSON.stringify(back.body)),
      JSON.parse(JSON.stringify(protocol[name].decode(
        minimal.Reader.create(protocol[name].encode(body, minimal.Writer.create()).finish()),
      ))),
      `${name} (${label}): body`,
    );
  }
  checked += 1;
}

// The decompressor must follow the LZ4 block spec, not merely agree with our own
// compressor. These blocks are written out by hand from the format definition.
function decompress(block, expectedLength) {
  const out = new Uint8Array(expectedLength);
  const written = decompressBlock(block, out, 0, block.length, 0);
  assert.equal(written, expectedLength, 'lz4 block: written length');
  return Buffer.from(out).toString('latin1');
}

// "abcd" then a match 4 bytes back of length 4, then trailing literals "xyz".
assert.equal(
  decompress(Buffer.from([0x40, 0x61, 0x62, 0x63, 0x64, 0x04, 0x00, 0x30, 0x78, 0x79, 0x7a]), 11),
  'abcdabcdxyz',
  'lz4 block: literal + short match',
);
// 20 literals (extended length: token nibble 15 + extra byte 5), then a match of 4 at offset 20.
assert.equal(
  decompress(Buffer.concat([Buffer.from([0xf0, 0x05]), Buffer.alloc(20, 0x41), Buffer.from([20, 0, 0x00])]), 24),
  'A'.repeat(24),
  'lz4 block: extended literal length and overlapping match',
);
// A long match (extended match length byte): 4 literals, then match offset 4 with
// match length 15 + 255 + 0 (+4) = 274, which copies from the literals themselves.
{
  const block = Buffer.from([0x4f, 0x41, 0x42, 0x43, 0x44, 0x04, 0x00, 0xff, 0x00]);
  assert.equal(decompress(block, 4 + 274), 'ABCD'.repeat(278).slice(0, 278), 'lz4 block: extended match length');
}

// Same bounds check for the compressed branch of the frame codec.
{
  const body = { result: 1, initSeqNo: 5, errorMessage: 'session expired '.repeat(40).trim() };
  const plain = codec.encode('LoginResponse', 5, body);
  const nameLength = 'LoginResponse'.length;
  const payload = plain.subarray(HEADER_PREFIX + nameLength + 1);
  const dst = new Uint8Array(compressBound(payload.length));
  const dstLength = compressBlock(payload, dst, 0, payload.length, makeHashTable());
  assert.ok(dstLength > 0 && dstLength < payload.length, 'lz4 frame: payload should compress');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeInt32BE(payload.length, 0);
  const lz4 = Buffer.concat([
    Buffer.from(plain.subarray(0, HEADER_PREFIX + nameLength)),
    Buffer.from([1]),
    lengthPrefix,
    Buffer.from(dst.subarray(0, dstLength)),
  ]);
  new DataView(lz4.buffer, lz4.byteOffset, lz4.byteLength).setInt32(0, lz4.byteLength - 4);
  const back = codec.decode(lz4);
  assert.equal(back.name, 'LoginResponse', 'lz4 frame: decoded name');
  assert.deepEqual(
    JSON.parse(JSON.stringify(back.body)),
    JSON.parse(JSON.stringify(codec.decode(plain).body)),
    'lz4 frame: body matches uncompressed frame',
  );
  checked += 1;
}

// Compressor round-trip. The hash table is caller-owned (as in the vendored code)
// and must start zeroed for each independent block.
function roundTrip(corpus, label) {
  const compressed = new Uint8Array(compressBound(corpus.length));
  const compressedLength = compressBlock(corpus, compressed, 0, corpus.length, makeHashTable());
  assert.ok(compressedLength > 0, `lz4 ${label}: block should compress`);
  assert.ok(compressedLength < corpus.length, `lz4 ${label}: compressed should be smaller`);
  const restored = new Uint8Array(corpus.length);
  const restoredLength = decompressBlock(compressed, restored, 0, compressedLength, 0);
  assert.equal(restoredLength, corpus.length, `lz4 ${label}: restored length`);
  assert.deepEqual(Buffer.from(restored), Buffer.from(corpus), `lz4 ${label}: round-trip bytes`);
}

roundTrip(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i % 97) + ((i * 7) % 13))), 'patterned');
roundTrip(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251)), 'mixed');
roundTrip(Buffer.alloc(4096), 'zeros');
roundTrip(Buffer.from('RequestResponse'.repeat(200)), 'text');

// Heartbeat matching. The server echoes our int64 timestamp back in long form, so a
// naive identity check never matches and every ping looks like a timeout.
{
  const { GameClient, toNumber, nextSeqNo, isSeqNoInRange, MAX_SEQ } = await import('./client.mjs');
  const client = new GameClient({ protocol });
  const sent = 1791350000123;
  const high = Math.floor(sent / 4294967296);
  const low = sent - high * 4294967296;

  assert.equal(toNumber({ low, high, unsigned: false }), sent, 'toNumber: long form');
  assert.equal(toNumber(sent), sent, 'toNumber: plain number');

  client.lastPingTimestamp = sent;
  assert.equal(
    client.tryHandlePong({ clientTimestamp: { low, high, unsigned: false }, serverTimestamp: { low, high, unsigned: false } }),
    true,
    'pong with long-form echo matches the outstanding ping',
  );
  assert.equal(client.lastPingTimestamp, 0, 'pong clears the outstanding ping');
  assert.ok(Number.isFinite(client.latencyMs) && client.latencyMs >= 0, 'pong yields a latency sample');

  client.lastPingTimestamp = sent;
  assert.equal(client.tryHandlePong({ clientTimestamp: sent + 1 }), false, 'mismatched echo is ignored');
  assert.equal(client.lastPingTimestamp, sent, 'mismatched echo leaves the ping outstanding');
  client.lastPingTimestamp = 0;
  assert.equal(client.tryHandlePong({ clientTimestamp: sent }), false, 'unsolicited pong is ignored');

  assert.equal(nextSeqNo(MAX_SEQ), 1, 'seq wraps to 1');
  assert.equal(nextSeqNo(5), 6, 'seq increments');
  assert.equal(isSeqNoInRange(5, 5), true, 'seq in range');
  assert.equal(isSeqNoInRange(MAX_SEQ, 1), true, 'seq wraps inside range');
  assert.equal(isSeqNoInRange(9, 5), false, 'seq out of range');

  // 断线 / 重连必须清掉心跳 interval：onClose 只把 socket 置空，interval 留着的活
  // 会变成孤儿（this.tickTimer 被新值覆盖后再也 clear 不到），两个 tick 交替发 ping。
  const broken = new GameClient({ protocol });
  let ticks = 0;
  broken.on('tick', () => { ticks += 1; });
  broken.tickTimer = setInterval(() => broken.tick(), 10);
  broken.onClose({ code: 1006, reason: 'gone' });
  assert.equal(broken.tickTimer, null, 'onClose 要清掉心跳定时器');
  const ticksAtClose = ticks;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ticks, ticksAtClose, '断开后不该再有 tick');
  assert.equal(broken.socket, null, 'onClose 要把 socket 置空');
  checked += 1;
}

// World listing helpers. The server reports a role's current world separately from the
// key the client asked for (a merged world resolves to its successor), so both must
// survive normalisation as plain numbers rather than int64 objects.
{
  const { normalize, describeRole, describeWorld } = await import('./worlds.mjs');
  const long = (value) => ({ low: value >>> 0, high: Math.floor(value / 4294967296), unsigned: false });

  assert.deepEqual(normalize({ a: long(2001001001), b: [long(7)], c: null }), { a: 2001001001, b: [7], c: null }, 'normalize: nested long forms');

  const role = describeRole({
    id: long(55059310000001),
    nickname: '示例玩家1001',
    level: 11,
    power: long(40889),
    worldId: long(2004001001),
    bornWorldId: long(2001001001),
  });
  assert.equal(role.id, 55059310000001);
  assert.equal(role.power, 40889);
  assert.equal(role.worldId, 2004001001, 'role worldId is where the role lives now');
  assert.equal(role.bornWorldId, 2001001001, 'bornWorldId is the world it was created in');
  assert.equal(role.newRole, undefined, 'absent flags stay absent');

  // PlayerInfo names the same identity fields differently; describeRole accepts both.
  assert.equal(describeRole({ playerId: long(34190310000001), newRole: false }).id, 34190310000001);
  assert.equal(describeRole({ playerId: long(5), newRole: false }).newRole, false);

  const world = describeWorld({ worldId: long(2001001001), tag: 2, roleInfo: { worldId: long(2004001001) } });
  assert.equal(world.worldId, 2001001001, 'the select-screen key is GameWorldInfo.worldId');
  assert.equal(world.role.worldId, 2004001001, 'the live world is roleInfo.worldId');
  checked += 1;
}

// The entry query set is transcribed from a capture of the real client. Every name in
// it must exist in the protocol table along with its response, or the whole burst turns
// into timeouts at runtime.
{
  const { ENTRY_QUERIES, ENTRY_SIGNALS, summarize, formatState } = await import('./game.mjs');

  for (const { name } of ENTRY_QUERIES) {
    assert.ok(protocol[name], `entry query has no protocol type: ${name}`);
    const response = `${name.slice(0, -'Request'.length)}Response`;
    assert.ok(protocol[response], `entry query has no response type: ${response}`);
  }
  for (const { name } of ENTRY_SIGNALS) assert.ok(protocol[name], `entry signal has no protocol type: ${name}`);

  // summarize must survive a completely empty state: a fresh account answers some of
  // these with nothing at all, and the CLI still has to print.
  const empty = summarize({ ok: {} });
  assert.equal(empty.items.kinds, 0);
  assert.equal(empty.heroes.power, 0);
  assert.equal(empty.afk, null);
  assert.equal(empty.buildings.length, 0);
  assert.ok(formatState(empty).includes('道具: 0 种'));

  const sample = summarize({
    ok: {
      AllResourceRequest: { list: [{ res: 3, amount: 10 }] },
      AllItemRequest: { items: [{ itemId: '加速器', num: 5 }, { itemId: '木材', num: 1 }] },
      AllHeroRequest: { heroes: [{ heroId: '杰森', level: 45, star: 2, power: 11658 }] },
      GetFormationRequest: { formation: { heroPositions: [{ heroId: '杰森', pos: { x: 4, y: 2 } }] } },
      AfkInfoRequest: { afkInfo: { level: 3, afkStartTime: 100, afkFinishTime: 200, rewardedLevel: 1 } },
      DailyTaskInfoRequest: {
        dailyTask: [
          { id: 1, progress: 1, targetProgress: 1, rewardClaimed: false },
          { id: 2, progress: 0, targetProgress: 2, rewardClaimed: false },
        ],
        dailyActivity: 5,
        weeklyActivity: 9,
        dailyResetTime: 300,
      },
      OnWaterRequest: { building: [{ buildingId: '1切鱼厂', level: 2, auto: true, factory: { finishedProducts: [{ type: 0, id: '生鱼片', num: 2 }] } }] },
    },
  }, { now: 250 });
  assert.equal(sample.items.total, 6);
  assert.equal(sample.items.top[0].itemId, '加速器', 'items sorted by count');
  assert.equal(sample.heroes.power, 11658);
  assert.equal(sample.heroes.formation[0].heroId, '杰森');
  assert.equal(sample.afk.capped, true, 'afk finish time is in the past');
  assert.equal(sample.afk.pendingLevels, 2, 'level 3 with level 1 rewarded');
  assert.equal(sample.daily.done, 1);
  assert.equal(sample.daily.claimable, 1, 'finished but unclaimed task counts');
  assert.equal(sample.daily.dailyActivity, 5);
  assert.equal(sample.buildings[0].auto, true);
  assert.equal(sample.buildings[0].factory.finished[0].id, '生鱼片');
  assert.ok(formatState(sample).includes('杰森 lv45 2星 战力11658'));
  checked += 1;
}

// The action catalog. Every request type must exist, every declared parameter must be
// produced by its own body builder, and the mutation gate must refuse by default.
{
  const { ACTIONS, listActions, buildBody, assertAllowed } = await import('./actions.mjs');

  for (const [id, action] of Object.entries(ACTIONS)) {
    assert.ok(protocol[action.request], `${id}: no protocol type for ${action.request}`);
    if (action.response) assert.ok(protocol[action.response], `${id}: no protocol type for ${action.response}`);
    const filled = Object.fromEntries((action.params ?? []).map((key) => [key, key === 'isOn' ? true : '1']));
    const body = buildBody(action, filled);
    assert.equal(typeof body, 'object', `${id}: body must be an object`);
    for (const key of action.params ?? []) {
      assert.ok(key in filled, `${id}: parameter ${key} is not buildable`);
      assert.ok(Object.keys(body).length > 0, `${id}: body is empty despite parameters`);
    }
    if ((action.params ?? []).length > 0) {
      assert.throws(() => buildBody(action, {}), /missing parameter/, `${id}: missing parameter is not caught`);
    }
  }

  assert.ok(listActions().length === Object.keys(ACTIONS).length);
  assert.throws(() => assertAllowed('afkDraw'), /changes account state/, 'mutation gate refuses by default');
  assert.throws(() => assertAllowed('nope'), /unknown action/);
  assert.equal(assertAllowed('afkDraw', { allowMutate: true }).request, 'DrawAfkRewardRequest');
  checked += 1;
}

// The console page is a JS template literal, so an escape sequence meant for the browser
// (a "\n" inside the inline script) is silently eaten at module load and leaves the page
// with a syntax error nothing else would catch. Parse the emitted script here.
{
  const vm = await import('node:vm');
  const { PAGE } = await import('./page.mjs');
  const start = PAGE.indexOf('<script>') + '<script>'.length;
  const end = PAGE.lastIndexOf('</script>');
  assert.ok(start > 0 && end > start, 'console page has an inline script');
  new vm.Script(PAGE.slice(start, end), { filename: 'page-inline.js' });

  // 单元格契约：putCell 的 cell 分支要的是 {icon, id} 资产对象，chip 分支要的是
  // {chip, text} 包装。之前把图标对象和 chip() 返回的 <span> 直接当 spec 传，
  // 名称列渲染成 undefined、状态列整列空白，而且不报错（静默），只能靠这条静态检查兜住。
  // 允许 `cell: null`（没有图标、只显示文字，走 fallback）和 `cell: { ... }`，
  // 不允许把图标对象本身直接塞进去 —— 那样 entry.icon / entry.id 都取不到，
  // 名字会渲染成 undefined 且不报错。
  const cellSpecs = [...PAGE.matchAll(/\{\s*cell:\s*([^{}\n]*)/g)].map((match) => match[1].trim());
  // 只关心「标识符或 xxx.yyy 后面直接跟逗号/花括号」这种真正把对象塞进去的写法；
  // 注释里的 `{ cell: 图标项 }` 说明文字不算。
  const badCells = cellSpecs.filter(
    (rest) => /^[A-Za-z_$][\w$.]*\s*[,}]/.test(rest) && !/^(null|undefined)\b/.test(rest),
  );
  assert.deepEqual(badCells, [], 'cell 不能直接传图标对象，要包成 { icon, id }');
  assert.equal(/\?\s*chip\(/.test(PAGE), false,
    'chip() 返回 DOM 节点，当单元格用要写成 { chip, text }');
  // 执行一轮海面的响应曾经缺 factories/orders/stock/resFields，renderWorld 直接抛 TypeError。
  assert.ok(/\(data\.factories \|\| \[\]\)\.length/.test(PAGE),
    'renderWorld 要容忍 /api/world/run 的响应缺字段');

  // DOM id 契约：`$('forge-on')` 这类引用如果 in HTML 里没有对应的 id，
  // 页面会在运行时抛 TypeError（或者对 null 取属性），而且只在点开那个页签时才炸。
  // 静态比对一遍最省事。
  const definedIds = new Set([...PAGE.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]));
  const usedIds = new Set([...PAGE.matchAll(/\$\('([\w-]+)'\)/g)].map((match) => match[1]));
  const missingIds = [...usedIds].filter((id) => !definedIds.has(id));
  assert.deepEqual(missingIds, [], '页面里 $() 引用的 id 必须在 HTML 里有定义');
  checked += 1;
}

// 服务端拒绝一个请求时不回 *Response，而是推一条 PromptResponse。若不当场结掉对应的
// pending，调用方要干等满超时。
{
  const { GameClient } = await import('./client.mjs');
  const client = new GameClient({ protocol });
  let rejected = null;
  const entry = { name: 'DrawAfkLevelRewardRequest', responseName: 'DrawAfkLevelRewardResponse', resolve: () => {}, reject: (error) => { rejected = error; }, timer: setTimeout(() => {}, 1000) };
  client.pending.push(entry);
  client.onMessage(codec.encode('PromptResponse', 5, { style: 1, prompt: 5, args: ['no claimable afk reward'] }));
  assert.ok(rejected, 'prompt rejects the pending request');
  assert.match(rejected.message, /no claimable afk reward/);
  assert.equal(client.pending.length, 0, 'prompt clears the pending entry');
  clearTimeout(entry.timer);

  // 没有待处理请求时，push 过来的提示不该抛错。
  client.onMessage(codec.encode('PromptResponse', 6, { style: 1, prompt: 5, args: ['notice'] }));
  checked += 1;
}

// 服务端新增了本地 proto 表里没有的消息（2026-10-28 的 FarmHarvestResponse）时，这一帧必须能
// 跳过并继续：recvSeqNo 照常推进、照常 ack。旧实现在 decode 抛错处直接 return，坏帧永远不 ack，
// 之后每帧都判 gap → Nack → 服务端重发同一帧 → ResendFailed，整条下行流卡死了 6 小时 17 分。
{
  const { GameClient } = await import('./client.mjs');

  // codec.encode 走严格 typeOf（发包写错名字要立刻炸），所以未知帧只能手工拼。
  function rawFrame(name, seq, payload = new Uint8Array(0)) {
    const headerLength = HEADER_PREFIX + name.length + 1;
    const frame = new Uint8Array(headerLength + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setInt32(0, frame.byteLength - 4);
    view.setInt8(4, 2);
    view.setInt32(5, seq);
    view.setInt8(9, name.length);
    for (let i = 0; i < name.length; i += 1) view.setUint8(10 + i, name.charCodeAt(i));
    view.setInt8(HEADER_PREFIX + name.length, 0);
    frame.set(payload, headerLength);
    return frame;
  }

  const client = new GameClient({ protocol });
  client.sendNoSeq = () => {};
  client.recvSeqNo = 100;
  const unknown = [];
  let dropped = 0;
  client.on('unknown', (info) => unknown.push(info));
  client.on('drop', () => { dropped += 1; });

  // 名字必须挑「协议表里一定没有」的：2026-10-29 游戏大版本更新后 FarmHarvestResponse
  // 已经进了 proto 表（之前正是靠它复现的死循环），再用它就测不到 unknown 分支了。
  const ghostName = 'FarmHarvestResponseXyz';
  client.onMessage(rawFrame(ghostName, 101, new Uint8Array([8, 1])));
  assert.equal(client.recvSeqNo, 101, '未知消息帧要照常推进 recvSeqNo');
  assert.equal(unknown.length, 1, '未知消息帧发一次 unknown 事件');
  assert.match(unknown[0].error, new RegExp(`Unknown message type: ${ghostName}`));

  client.onMessage(codec.encode('OkResponse', 102, {}));
  assert.equal(dropped, 0, '未知帧之后的正常帧不能被判成 gap');
  assert.equal(client.recvSeqNo, 102, '未知帧之后 seq 继续推进');
  if (client.ackTimer !== null) clearTimeout(client.ackTimer);
  checked += 1;
}

// 配置表来自 CDN 的 config_cn bundle，本地是微信缓存或 work/cdn 的快照。缺了就跳过，
// 但在快照存在时必须能解出表并完成资源名映射。
{
  const { findConfigPack, loadConfig, RESOURCE } = await import('./config.mjs');
  const file = findConfigPack();
  if (file) {
    const config = loadConfig({ file });
    assert.ok(config.names.length > 500, `config should expose many tables, got ${config.names.length}`);
    assert.ok(Array.isArray(config.tables.OfflineCfg.data), 'OfflineCfg has rows');
    assert.equal(RESOURCE[3], 'GOLD', 'resource enum maps 3 to GOLD');
    assert.equal(config.resourceName(3), '金币', 'GOLD renders as 金币');
    assert.equal(config.resourceName(4), '钻石', 'RUBY renders as 钻石');
    assert.equal(config.resourceName('RUBY'), '钻石');
    assert.equal(config.afkMaxLevel(1), 1, 'mainline stage 1 caps afk level at 1');
    assert.equal(config.nextAfkRewardLevel(0), 2, 'level 1 has no reward, next is 2');
    assert.equal(config.nextAfkRewardLevel(2), 5, 'after level 2 the next rewarded level is 5');
    // 活跃度宝箱的两套门槛：日表低、周表高。表名或门槛写错都会在这里当场炸。
    const chest = await import('./dailies.mjs');
    assert.deepEqual(chest.chestTiers(config, { kind: 'daily', activity: 80 }).map((t) => t.id), [1, 2, 3, 4], '日 80 活跃够 1-4 档');
    assert.deepEqual(chest.chestTiers(config, { kind: 'weekly', activity: 80 }).map((t) => t.id), [], '周 80 活跃一档都不够');
    assert.deepEqual(chest.chestTiers(config, { kind: 'weekly', activity: 480 }).map((t) => t.id), [1, 2, 3, 4], '周 480 活跃够 1-4 档');
  } else {
    console.log('selftest: config pack not found, skipping config checks');
  }
  checked += 1;
}

// 英雄养成计划：判定条件照抄客户端红点逻辑，用合成配置跑，不依赖 CDN 快照。
{
  const { planHeroes, maxHeroLevelFor } = await import('./heroes.mjs');
  const config = {
    tables: {
      HeroUpgradeCfg: { data: [
        { level: 1, exp: 0, reqPlayerLv: 1 },
        { level: 2, exp: 100, reqPlayerLv: 1 },
        { level: 3, exp: 200, reqPlayerLv: 5 },
      ] },
      HeroStarCfg: { data: [
        { star: 1, starNum: 1, consumeBlue: 1, consumePur: 1, consumeOra: 1, consumeRed: 1, maxSkillLevel: [1] },
        { star: 2, starNum: 1, consumeBlue: 1, consumePur: 1, consumeOra: 1, consumeRed: 1, maxSkillLevel: [2, 2] },
      ] },
      HeroCfg: { data: [{ id: 'A', quality: 'ORANGE', universalItemId: '万能' }] },
      HeroSkillUpCfg: { data: [{ quality: 'ORANGE', level: 2, costArr: [['橙技能书', 10], ['橙技能书', 10]] }] },
    },
  };
  assert.equal(maxHeroLevelFor(1, config), 2, 'player level 1 caps hero level at 2');
  assert.equal(maxHeroLevelFor(9, config), 3, 'player level 9 unlocks level 3');

  const items = new Map([['英雄经验', 500], ['万能', 5], ['橙技能书', 10]]);
  const hero = { heroId: 'A', level: 1, star: 0, power: 1, skillLevels: [0] };
  const plan = planHeroes({ config, heroes: [hero], itemNum: (id) => items.get(id) ?? 0, playerLevel: 1 });
  const levelStep = plan.steps.find((step) => step.kind === 'level');
  assert.equal(levelStep.count, 1, 'only one level fits under the player-level cap');
  assert.equal(levelStep.exp, 100, 'level 2 costs 100 exp');
  // HeroStarUpRequest 一次只涨一星，所以每颗星单独一条请求，执行时一颗一颗发。
  const starSteps = plan.steps.filter((step) => step.kind === 'star');
  assert.deepEqual(starSteps.map((step) => step.to), [1, 2], 'each star level is its own request');
  assert.deepEqual(starSteps.map((step) => step.from), [0, 1]);
  assert.equal(starSteps[0].fragments, 1, 'star 1 costs one fragment');
  assert.ok(starSteps.every((step) => step.universal), 'universal fragments are reported');

  // 技能：星级不到面板要求就不排，星级够且书够才排一条。
  const skillHero = { heroId: 'A', level: 1, star: 2, power: 1, skillLevels: [1, 0] };
  const skillPlan = planHeroes({ config, heroes: [skillHero], itemNum: (id) => items.get(id) ?? 0, playerLevel: 9 });
  const skillStep = skillPlan.steps.find((step) => step.kind === 'skill');
  assert.ok(skillStep, 'skill upgrade is planned when the star cap and books allow it');
  assert.equal(skillStep.slot, 0, 'skillIdx is 1-based on the wire, 0-based in the slot');

  // 技能要求 2 星（heroStarBySkillLv(0, 2)），碎片又不够升到 2 星时，面板点不动，计划里也不该有。
  const lowStar = { heroId: 'A', level: 1, star: 1, power: 1, skillLevels: [1, 0] };
  const broke = new Map([['英雄经验', 0], ['橙技能书', 10]]);
  const lowPlan = planHeroes({ config, heroes: [lowStar], itemNum: (id) => broke.get(id) ?? 0, playerLevel: 9 });
  assert.equal(lowPlan.steps.filter((step) => step.kind === 'skill').length, 0, 'the star gate blocks the skill plan');
  assert.ok(lowPlan.notes.some((note) => note.includes('需要 2 星')), 'the blocked skill says why');
  checked += 1;
}

// 主战英雄养成（勋章 + 装备）：上限、预算共享、替换方向都拿合成回包钉住。
// 这一组要覆盖的是「发出去的请求是不是客户端也会发的」，不是服务端会不会接受。
{
  const { surveyHeroGrowth, planHeroGrowth } = await import('./heroGrow.mjs');
  const config = { tables: {
    HeroCfg: { data: [{ id: 'A', career: '法师', quality: 'BLUE', qualityIndex: 1 }] },
    HeroBadgeCfg: { data: [{ id: '蓝法师徽章', career: '法师', quality: 'BLUE', qualityIndex: 1 }] },
    // 上限只由「徽章 id + 星级」决定：1 星最高 3 级。
    HeroBadgeAttrCfg: { data: [{ id: '蓝法师徽章', star: 1, maxLevel: 3, exp: 1 }, { id: '蓝法师徽章', star: 2, maxLevel: 4, exp: 1 }] },
    HeroBadgeLevelCfg: { data: [
      { level: 1, exp: 0, goldExpRadio: 0 },
      { level: 2, exp: 10, goldExpRadio: 5 },
      { level: 3, exp: 10, goldExpRadio: 5 },
      { level: 4, exp: 10, goldExpRadio: 5 },
    ] },
    HeroBadgeStarCfg: { data: [{ star: 1, upBadgeNum: 1, equalBadgeNum: 2, consume: ['GOLD', 100] }] },
    HeroBadgeUnlockCfg: { data: [{ pos: 1, level: 1 }, { pos: 2, level: 70 }] },
    EquipCfg: { data: [{ id: '蓝武器1', type: '武器', quality: 'BLUE', qualityIndex: 1 }] },
    EquipAttrCfg: { data: [{ id: '蓝武器1', star: '0', maxLv: 3, maxRefineLv: 2 }] },
    EquipUpDecomposeCfg: { data: [{ level: 1, upgradeCost: 0 }, { level: 2, upgradeCost: 100 }, { level: 3, upgradeCost: 100 }] },
    EquipRefineCfg: { data: [{ level: 1, costItem1: 50, costItem2: 1 }, { level: 2, costItem1: 50, costItem2: 1 }] },
    EquipUpStarCfg: { data: [{ star: 1, upCosts: [['装备升星石', 1], ['精铁', 10]] }] },
  } };
  const responses = {
    AllHeroResponse: { heroes: [
      {
        heroId: 'A', level: 50, star: 1, power: { low: 100, high: 0 }, skillLevels: [],
        // 身上的勋章是 1 星 1 级，背包装着 2 星 2 级 —— 应当替换，且 downUid=新的那件。
        badges: [{ pos: 1, uid: 11, badgeId: '蓝法师徽章', level: 1, exp: 0, star: 1 }],
        equips: [{ uid: 21, equipId: '蓝武器1', level: 1, star: 0, refineLv: 0 }],
      },
      {
        // B 不在出战阵容里：默认计划不该碰它，勾「含未上阵」才轮到。
        heroId: 'B', level: 50, star: 1, power: { low: 100, high: 0 }, skillLevels: [],
        badges: [{ pos: 1, uid: 12, badgeId: '蓝法师徽章', level: 1, exp: 0, star: 1 }],
        equips: [{ uid: 22, equipId: '蓝武器1', level: 1, star: 0, refineLv: 0 }],
      },
    ] },
    // 主战阵容（FormationModule.MAINLINE=1）只有 A。
    GetFormationResponse: { formation: { heroPositions: [{ heroId: 'A', pos: { x: 1, y: 1 } }], presetId: 11 } },
    BadgesResponse: { badge: [
      { uid: 11, badgeId: '蓝法师徽章', level: 1, exp: 0, star: 1 },
      { uid: 12, badgeId: '蓝法师徽章', level: 1, exp: 0, star: 1 },
      { uid: 99, badgeId: '蓝法师徽章', level: 2, exp: 0, star: 2 },
    ] },
    EquipsResponse: { equip: [] },
    AllItemResponse: { items: [
      { itemId: '徽章经验', num: { low: 100, high: 0 } },
      { itemId: '精铁', num: { low: 300, high: 0 } },
      { itemId: '精炼石', num: { low: 5, high: 0 } },
    ] },
    AllResourceResponse: { list: [{ res: 3, amount: { low: 10000, high: 0 } }] },
  };
  const fake = { request: async (name, body, response) => responses[response] };
  const protocol = Object.fromEntries(Object.keys(responses).map((name) => [name, 1]).concat(['AllHeroRequest', 'BadgesRequest', 'EquipsRequest', 'AllItemRequest', 'AllResourceRequest', 'GetFormationRequest'].map((name) => [name, 1])));

  const survey = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 60 });
  assert.equal(survey.heroes.length, 2);
  assert.deepEqual(survey.formation.heroIds, ['A'], 'formation tells which heroes are on the mainline team');
  assert.equal(survey.heroes.find((hero) => hero.heroId === 'A').front, true);
  assert.equal(survey.heroes.find((hero) => hero.heroId === 'B').front, false);
  assert.equal(survey.stock.get('GOLD'), 10000, 'GOLD comes from AllResourceResponse, not AllItemResponse');
  assert.equal(survey.badgeBag.filter((one) => one.worn).length, 2, 'the worn badges are flagged');

  const plan = planHeroGrowth(survey);
  // 主战英雄之外的一律不碰：材料优先给出战的那几个。
  assert.deepEqual(plan.heroes.map((one) => one.heroId), ['A'], 'only the mainline team is groomed by default');
  const bench = planHeroGrowth(survey, { onlyFront: false });
  assert.deepEqual(bench.heroes.map((one) => one.heroId).sort(), ['A', 'B'], 'includeBench covers the whole roster');

  const first = plan.actions[0];
  assert.equal(first.kind, 'badgeReplace', 'replace happens before enhance: the materials should land on the better badge');
  assert.equal(first.body.downUid, 99, 'downUid is the badge being put on');
  assert.equal(first.body.upUid, 11, 'upUid is the badge being taken off');
  assert.equal(first.request, 'BadgeReplaceRequest');

  // 替换后身上是 2 星 2 级（上限 4），强化到 4 级要 2 级 × 10 点经验。
  const enhance = plan.actions.find((one) => one.kind === 'badgeEnhance');
  assert.ok(enhance, 'the replaced badge can still be enhanced');
  assert.equal(enhance.body.uid, 99, 'enhance targets the badge that is now worn');
  assert.equal(enhance.body.expItemNum, 20, 'two levels at 10 exp each');
  assert.deepEqual(enhance.body.decomposeUid, [], 'never decompose badges');

  // 装备：升级 1→3 花 200 精铁，剩下 100 够 2 级精炼（50 精铁 + 1 精炼石/级）。
  const levels = plan.actions.filter((one) => one.kind === 'equipLevel');
  assert.equal(levels.length, 2, 'one request per equipment level');
  assert.equal(levels[0].request, 'EnhanceEquipRequest', 'equipment level-up is EnhanceEquipRequest');
  const refined = plan.actions.filter((one) => one.kind === 'equipRefine');
  assert.equal(refined.length, 2, 'refine is capped by maxRefineLv, not by material alone');
  assert.equal(refined[0].request, 'EquipRefineRequest');
  // 升星要 10 精铁 + 1 装备升星石，材料表里没有升星石 —— 一条都不该排。
  assert.equal(plan.actions.filter((one) => one.kind === 'equipStar').length, 0, 'missing star stone blocks equipment star-up');

  // 预算共享：精铁只够一件装备升一级时，第二个英雄不该再排升级（不能各自按满库存算）。
  const thin = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 60 });
  thin.stock.set('精铁', 100);
  thin.heroes = [
    { ...survey.heroes[0], heroId: 'A', front: true, equips: [] },
    { ...survey.heroes[0], heroId: 'B', front: false, equips: [] },
  ];
  thin.equipBag = [{ ...describeThinEquip(), uid: 31 }, { ...describeThinEquip(), uid: 32 }];
  const thinPlan = planHeroGrowth(thin, { onlyFront: false, switches: { badgeReplace: false, badgeEnhance: false, equipRefine: false, equipStar: false, equipReplace: true } });
  assert.equal(thinPlan.actions.filter((one) => one.kind === 'equipLevel').length, 1, 'a shared iron budget is spent once, not per hero');

  // 失败隔离粒度：同一个英雄的两件装备必须是两个 group。
  // group 是 runWorld 的「同类失败就跳过」单位 —— 曾经按「英雄+类型」分组，实测一件装备
  // 被瞬时拒（prompt=74）就把同英雄另外两件装备的 18 条动作一起废掉了。
  {
    const two = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 60 });
    two.stock.set('精铁', 5000);
    two.heroes = [{
      ...two.heroes[0], front: true, badges: [], equips: [
        { uid: 41, equipId: '蓝武器1', type: '武器', quality: 'BLUE', qualityName: '蓝', qualityIndex: 1, level: 1, star: 0, refineLv: 0, score: 1 },
        { uid: 42, equipId: '蓝武器1', type: '武器', quality: 'BLUE', qualityName: '蓝', qualityIndex: 1, level: 1, star: 0, refineLv: 0, score: 1 },
      ],
    }];
    two.equipBag = [];
    const twoPlan = planHeroGrowth(two, {
      onlyFront: false,
      switches: { badgeReplace: false, badgeEnhance: false, equipRefine: false, equipStar: false, equipReplace: false, exclusiveLevel: false, exclusiveStar: false },
    });
    const uidGroups = new Set(twoPlan.actions.filter((one) => one.kind === 'equipLevel').map((one) => one.group));
    assert.equal(uidGroups.size, 2, 'two equips on the same hero get two isolation groups');

    // 瞬时拒绝（忙 / 太快 / 活动切换）不该封锁整组：每一条都该真的发出去。
    const { runWorld } = await import('./world.mjs');
    const steps = [1, 2, 3].map((n) => ({
      kind: 'equipLevel', request: 'EnhanceEquipRequest', response: null, body: { uid: 41 },
      key: `equipLevel:41:${n}`, group: 'hero:A:equipLevel:41', transient: true, label: `lv${n}`,
    }));
    const prompt = (id) => {
      throw Object.assign(new Error(`server prompt: prompt=${id}`), { prompt: { prompt: id } });
    };
    const busy = await runWorld({ sendWatch: async () => prompt(74) }, { EnhanceEquipRequest: 1 }, { actions: steps }, {
      allowMutate: true, window: 0, timeout: 100,
    });
    assert.equal(busy.results.filter((one) => one.skipped).length, 0, 'a transient prompt does not block the rest of the group');

    // 资源不足（36）就该停掉这件装备剩下的级数：下一级只会更贵。
    const broke = await runWorld({ sendWatch: async () => prompt(36) }, { EnhanceEquipRequest: 1 }, { actions: steps }, {
      allowMutate: true, window: 0, timeout: 100,
    });
    assert.equal(broke.results.filter((one) => one.skipped).length, 2, 'out-of-material blocks the rest of that equipment');
  }

  function describeThinEquip() {
    return { uid: 0, equipId: '蓝武器1', type: '武器', quality: 'BLUE', qualityName: '蓝', qualityIndex: 1, level: 1, star: 0, refineLv: 0, score: 10000 };
  }
  checked += 1;
}

// 勋章升星（BadgeStarRequest）：只有 RED 能升、星石不够才拆闲置红徽章、
// 拆的时候不碰佩戴中的/更强的/非红的，凑不齐就整级不做。这一组把这些边界全钉住。
{
  const { surveyHeroGrowth, planHeroGrowth, badgeStarEquivalent } = await import('./heroGrow.mjs');
  const config = { tables: {
    HeroCfg: { data: [{ id: 'A', career: '法师', quality: 'RED', qualityIndex: 5 }] },
    HeroBadgeCfg: { data: [
      { id: '红法师徽章', career: '法师', quality: 'RED', qualityIndex: 5 },
      { id: '蓝法师徽章', career: '法师', quality: 'BLUE', qualityIndex: 1 },
    ] },
    HeroBadgeAttrCfg: { data: [
      { id: '红法师徽章', star: 4, maxLevel: 10 },
      { id: '红法师徽章', star: 5, maxLevel: 20 },
    ] },
    HeroBadgeLevelCfg: { data: [{ level: 1, exp: 0, goldExpRadio: 0 }, { level: 2, exp: 10, goldExpRadio: 1 }] },
    HeroBadgeStarCfg: { data: [
      // 只有「4 星 → 5 星」这一行：升满就是客户端写死的 `_maxStar = 5`，再往上没有配置。
      { star: 5, upBadgeNum: 2, equalBadgeNum: 2, consume: ['GOLD', 100] },
    ] },
    HeroBadgeUnlockCfg: { data: [{ pos: 1, level: 1 }] },
    EquipCfg: { data: [] }, EquipAttrCfg: { data: [] }, EquipUpDecomposeCfg: { data: [] },
    EquipRefineCfg: { data: [] }, EquipUpStarCfg: { data: [] },
    ExclusiveWeaponCfg: { data: [] }, ExclusiveUpgradeCfg: { data: [] }, ExclusiveStarCfg: { data: [] },
  } };
  const responses = {
    AllHeroResponse: { heroes: [{
      heroId: 'A', level: 99, star: 5, power: { low: 100, high: 0 }, skillLevels: [], equips: [],
      // 身上这枚是 4 星 5 级（score = 品质 5e6 + 4 星 4e4 + 5 级 500），背包里没有比它更强的 → 不会替换。
      badges: [{ pos: 1, uid: 11, badgeId: '红法师徽章', level: 5, exp: 0, star: 4 }],
    }] },
    GetFormationResponse: { formation: { heroPositions: [{ heroId: 'A', pos: { x: 1, y: 1 } }], presetId: 1 } },
    BadgesResponse: { badge: [
      { uid: 11, badgeId: '红法师徽章', level: 5, exp: 0, star: 4 },   // 佩戴中 —— 永不拆
      { uid: 21, badgeId: '红法师徽章', level: 1, exp: 0, star: 0 },   // 更差，当量 1
      { uid: 22, badgeId: '红法师徽章', level: 2, exp: 0, star: 0 },   // 更差，当量 1
      { uid: 23, badgeId: '红法师徽章', level: 9, exp: 0, star: 1 },   // 更差但更贵（当量 2），够用了就不该动它
      { uid: 24, badgeId: '蓝法师徽章', level: 1, exp: 0, star: 0 },   // 非红 —— 顶不了当量
    ] },
    // 只有 1 个星石：升 5 星要 2 个，必须靠拆 1 枚闲置红徽章补差。
    AllItemResponse: { items: [
      { itemId: '徽章升星石', num: { low: 1, high: 0 } },
      { itemId: '徽章经验', num: { low: 100, high: 0 } },
    ] },
    AllResourceResponse: { list: [{ res: 3, amount: { low: 100000, high: 0 } }] },
  };
  const fake = { request: async (name, body, response) => responses[response] };
  const protocol = Object.fromEntries(
    Object.keys(responses)
      .map((name) => [name, 1])
      .concat(['AllHeroRequest', 'BadgesRequest', 'EquipsRequest', 'AllItemRequest', 'AllResourceRequest', 'GetFormationRequest'].map((name) => [name, 1])),
  );

  // 当量折算照客户端 `idleRedBadgeStarNum`：0 星 1 个，n 星 equalBadgeNum。
  const index = { badgeStar: new Map([[1, { equalBadgeNum: 2 }], [2, { equalBadgeNum: 4 }]]) };
  assert.equal(badgeStarEquivalent(index, 0), 1, 'a 0-star badge is worth 1 star stone');
  assert.equal(badgeStarEquivalent(index, 2), 4, 'a 2-star badge is worth equalBadgeNum stones');

  const survey = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 99 });
  const plan = planHeroGrowth(survey, { switches: { exclusiveLevel: false, exclusiveStar: false } });
  const star = plan.actions.filter((one) => one.kind === 'badgeStar');
  assert.equal(star.length, 1, 'a 4-star red badge gets exactly one request: 4 → 5, then the hard cap stops it');
  const first = star[0];
  assert.equal(first.request, 'BadgeStarRequest');
  assert.equal(first.body.uid, 11, 'the star up targets the worn red badge');
  assert.equal(first.body.starItemNum, 1, 'starItemNum is the stones actually spent (1 of the 2 needed)');
  assert.deepEqual(first.body.decomposeUid, [21], 'the cheapest idle red badge covers the 1-stone gap');
  assert.ok(!first.body.decomposeUid.includes(23), 'a pricier idle badge (2 equivalents) is not touched once the gap is filled');
  assert.ok(!first.body.decomposeUid.includes(24), 'a non-red badge cannot pay for a red star up');
  assert.ok(!first.body.decomposeUid.includes(11), 'the badge being starred up is not used as fuel');
  assert.equal(plan.heroes[0].badges.find((one) => one.pos === 1).star, 5, 'the planned star is reflected in the hero row');

  // 升星必须排在强化之前：升星抬高 maxLevel 档位，先强到旧上限就白花经验。
  const starAt = plan.actions.findIndex((one) => one.kind === 'badgeStar');
  const enhanceAt = plan.actions.findIndex((one) => one.kind === 'badgeEnhance');
  assert.ok(starAt >= 0 && (enhanceAt < 0 || starAt < enhanceAt), 'star up runs before enhance');

  // 星石够用时一条都不拆（decomposeUid 恒空数组，不可逆操作最小化）。
  const rich = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 99 });
  rich.stock.set('徽章升星石', 20);
  rich.stock.set('GOLD', 100000);
  const richPlan = planHeroGrowth(rich, { switches: { badgeEnhance: false, exclusiveLevel: false, exclusiveStar: false } });
  const richStars = richPlan.actions.filter((one) => one.kind === 'badgeStar');
  assert.equal(richStars.length, 1, 'the only configured star row is 4 → 5');
  assert.ok(richStars.every((one) => one.body.decomposeUid.length === 0), 'plenty of stones means zero decomposition');

  // 星石为 0 且没有「更差」的闲置红徽章可拆时：整级不做，也不能拆佩戴中的那枚。
  const empty = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 99 });
  empty.stock.set('徽章升星石', 0);
  empty.badgeBag = empty.badgeBag.filter((one) => one.worn);
  const emptyPlan = planHeroGrowth(empty, { switches: { exclusiveLevel: false, exclusiveStar: false } });
  assert.equal(emptyPlan.actions.filter((one) => one.kind === 'badgeStar').length, 0, 'no stones and no fuel means no request at all');

  // 金币不够时一枚都升不了，而且要给出一句能看懂的原因。
  const poor = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 99 });
  poor.stock.set('GOLD', 0);
  const poorPlan = planHeroGrowth(poor, { switches: { exclusiveLevel: false, exclusiveStar: false } });
  assert.equal(poorPlan.actions.filter((one) => one.kind === 'badgeStar').length, 0, 'no gold, no star up');
  assert.ok(poorPlan.notes.some((note) => note.includes('红徽章还有 1 枚没升星')), 'the blocked red badge explains itself');
  checked += 1;
}

// 专武（英雄专属武器）：数据在 heroes[].exclusive、材料按品质二选一、等级被星级封顶。
// 这一组钉三件事：① 橙/红各自取 cost[0]/cost[1]；② 0 星封顶就升不动、先升星才放开；
// ③ universal 恒 false（不拿万能碎片垫英雄碎片）。
{
  const { surveyHeroGrowth, planHeroGrowth, exclusiveCostOf } = await import('./heroGrow.mjs');

  // 客户端红点 `heroExcluseiveUpgradeRedDot` 里的 `s`：RED 取 1，其它取 0；star0 的 cost 是空数组。
  assert.deepEqual(exclusiveCostOf({ cost: [['橙专武升星石', 5], ['红专武升星石', 7]] }, 'ORANGE'), ['橙专武升星石', 5]);
  assert.deepEqual(exclusiveCostOf({ cost: [['橙专武升星石', 5], ['红专武升星石', 7]] }, 'RED'), ['红专武升星石', 7]);
  assert.equal(exclusiveCostOf({ cost: [] }, 'ORANGE'), null, 'star 0 has no cost and must not crash');

  const config = { tables: {
    HeroCfg: { data: [
      { id: 'A', career: '法师', quality: 'ORANGE', qualityIndex: 3 },
      { id: 'B', career: '法师', quality: 'RED', qualityIndex: 4 },
      { id: 'C', career: '法师', quality: 'ORANGE', qualityIndex: 3 },
    ] },
    // 只有 A/B 有专武系统（ExclusiveWeaponCfg 里存在 heroId_1）；C 没有 → 一条动作都不该排。
    ExclusiveWeaponCfg: { data: [{ heroId: 'A', skillLv: 1 }, { heroId: 'B', skillLv: 1 }, { heroId: 'A', skillLv: 2 }] },
    ExclusiveUpgradeCfg: { data: [1, 2, 3, 4, 5, 6].map((level) => ({
      level, heroStar: 15, cost: [['初级专武材料', 10], ['中级专武材料', 40]],
    })) },
    // 上限比真表小：0 星封顶 2 级、1 星 4 级，测的就是「先升星放开上限、再升级」这条链。
    ExclusiveStarCfg: { data: [
      { star: 0, heroStar: 0, piece: 0, unlockLv: 2, cost: [] },
      { star: 1, heroStar: 25, piece: 5, unlockLv: 4, cost: [['橙专武升星石', 2], ['红专武升星石', 9]] },
      { star: 2, heroStar: 25, piece: 5, unlockLv: 6, cost: [['橙专武升星石', 2], ['红专武升星石', 9]] },
    ] },
  } };
  const responses = {
    AllHeroResponse: { heroes: [
      { heroId: 'A', level: 100, star: 15, power: { low: 300, high: 0 }, skillLevels: [], badges: [], equips: [] },
      // B 已有 2 级专武，0 星 —— 先升星才有 4 级的上限。
      { heroId: 'B', level: 100, star: 25, power: { low: 200, high: 0 }, skillLevels: [], badges: [], equips: [], exclusive: { level: 2, star: 0 } },
      { heroId: 'C', level: 100, star: 25, power: { low: 100, high: 0 }, skillLevels: [], badges: [], equips: [] },
    ] },
    GetFormationResponse: { formation: { heroPositions: [
      { heroId: 'A', pos: { x: 1, y: 1 } }, { heroId: 'B', pos: { x: 2, y: 1 } }, { heroId: 'C', pos: { x: 3, y: 1 } },
    ], presetId: 11 } },
    BadgesResponse: { badge: [] },
    EquipsResponse: { equip: [] },
    AllItemResponse: { items: [
      { itemId: '初级专武材料', num: { low: 100, high: 0 } },
      { itemId: '中级专武材料', num: { low: 200, high: 0 } },
      { itemId: '橙专武升星石', num: { low: 10, high: 0 } },
      { itemId: '红专武升星石', num: { low: 10, high: 0 } },
      { itemId: 'B碎片', num: { low: 5, high: 0 } },
    ] },
    AllResourceResponse: { list: [] },
  };
  const fake = { request: async (name, body, response) => responses[response] };
  // protocol 里必须同时有请求名和响应名：surveyHeroGrowth 的 get() 两端都查，缺一个就当这个探针不可用。
  const protocol = Object.fromEntries(
    Object.keys(responses)
      .concat(['AllHeroRequest', 'BadgesRequest', 'EquipsRequest', 'AllItemRequest', 'AllResourceRequest', 'GetFormationRequest'])
      .map((name) => [name, 1]),
  );

  const survey = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 100 });
  const heroA = survey.heroes.find((hero) => hero.heroId === 'A');
  assert.equal(heroA.hasExclusive, true, 'A has an exclusive-weapon config');
  assert.equal(heroA.exclusive.level, 0, 'protobuf drops the field at level 0: that means 0, not "no weapon"');
  assert.equal(survey.heroes.find((hero) => hero.heroId === 'C').hasExclusive, false, 'C has no exclusive config');

  const plan = planHeroGrowth(survey, { onlyFront: false });
  const aLevels = plan.actions.filter((one) => one.kind === 'exclusiveLevel' && one.body.heroId === 'A');
  assert.equal(aLevels.length, 2, '0-star caps the weapon at level 2');
  assert.equal(aLevels[0].request, 'HeroExclusiveLevelUpRequest');
  assert.deepEqual(aLevels[0].body, { heroId: 'A' }, 'level-up only carries the hero id');
  assert.notEqual(aLevels[0].key, aLevels[1].key, 'one key per level, or level 2 gets deduped away');

  // B：先升 1 星（B碎片 ×5 + 红石 ×9），上限从 2 级放开到 4 级，再把 2→4 级升满（中级 ×40/级）。
  const bStar = plan.actions.filter((one) => one.kind === 'exclusiveStar');
  assert.equal(bStar.length, 1, 'a 25-star hero can star up the weapon');
  assert.equal(bStar[0].request, 'HeroExclusiveStarUpRequest');
  assert.deepEqual(bStar[0].body, { heroId: 'B', universal: false }, 'universal stays false: never spend universal shards here');
  const bLevels = plan.actions.filter((one) => one.kind === 'exclusiveLevel' && one.body.heroId === 'B');
  assert.equal(bLevels.length, 2, 'the new star raises the level cap from 2 to 4');
  assert.equal(plan.heroes.find((hero) => hero.heroId === 'B').exclusive.star, 1, 'the planned star is written back');

  // C 没专武系统：一条动作都不能有（不能因为「有英雄」就排专武）。
  assert.equal(plan.actions.filter((one) => one.kind.startsWith('exclusive') && one.body.heroId === 'C').length, 0);

  // 英雄星级不够 15 时一级都不升，并且 note 说清原因（多个英雄卡住时合成一条）。
  const low = await surveyHeroGrowth(fake, protocol, { config, playerLevel: 100 });
  low.heroes = low.heroes.map((hero) => ({ ...hero, star: 14 }));
  const lowPlan = planHeroGrowth(low, { onlyFront: false });
  assert.equal(lowPlan.actions.filter((one) => one.kind.startsWith('exclusive')).length, 0, '15 hero stars is a hard gate');
  assert.ok(lowPlan.notes.some((note) => note.includes('15 星')), 'the blocked exclusive says why');

  // 两个新开关关掉后一条都不排（页面勾选走的同一个 switches）。
  const offPlan = planHeroGrowth(survey, { onlyFront: false, switches: { exclusiveLevel: false, exclusiveStar: false } });
  assert.equal(offPlan.actions.filter((one) => one.kind.startsWith('exclusive')).length, 0, 'the two switches really turn it off');
  checked += 1;
}

// 日常驱动：免费/付费点金的分支、以及地图没野怪时不给动作。
{
  const { DAILY_DRIVERS, TASK_TITLES } = await import('./dailies.mjs');
  const { typeNames } = await import('../tools/describe.mjs');
  const names = new Set(typeNames());
  for (const driver of Object.values(DAILY_DRIVERS)) {
    assert.ok(TASK_TITLES[driver.id], 'driver ' + driver.id + ' has a title');
    for (const [name] of driver.probes ?? []) assert.ok(names.has(name), driver.id + ': probe ' + name + ' is a real protocol type');
  }

  const config = { tables: { OfflineParamCfg: { data: [
    { paramName: '免费点金次数', paramValue: 3 },
    { paramName: '点金价格', paramValue: 50 },
  ] } } };
  const task = { id: 1006, progress: 0, targetProgress: 3 };
  const probe = (name) => (name === 'ClickGoldInfoRequest' ? { info: { freeTimes: 0, paidTimes: 0, maxPaidTimes: 7 } } : null);

  const free = DAILY_DRIVERS[1006].evaluate({ task, probe, config, items: new Map(), ruby: 0, now: 0 });
  assert.equal(free.status, 'ready', 'free clicks are preferred');
  assert.deepEqual(free.actions.map((a) => a.body), [{ times: 1, free: true }, { times: 1, free: true }, { times: 1, free: true }]);

  const paidProbe = (name) => (name === 'ClickGoldInfoRequest' ? { info: { freeTimes: 3, paidTimes: 0, maxPaidTimes: 7 } } : null);
  const paid = DAILY_DRIVERS[1006].evaluate({ task, probe: paidProbe, config, items: new Map(), ruby: 200, now: 0 });
  assert.equal(paid.status, 'paid', 'paid clicks are flagged, never silently run');
  assert.equal(paid.actions[0].body.free, false);

  const broke = DAILY_DRIVERS[1006].evaluate({ task, probe: paidProbe, config, items: new Map(), ruby: 10, now: 0 });
  assert.equal(broke.status, 'blocked', 'not enough diamonds blocks paid clicking');

  const noPirates = DAILY_DRIVERS[1010].evaluate({ task: { id: 1010, progress: 0, targetProgress: 5 }, probe: () => ({ pirates: [] }), items: new Map(), ruby: 0, now: 0, config });
  assert.equal(noPirates.status, 'blocked', 'an empty pirate map plans nothing');
  assert.equal(noPirates.actions, undefined);

  // ⚠️ `AllPirateResponse.sweepTimes` 是今天**已经用掉**的扫荡次数（0 = 一次没用 = 满次数可用），
  // 不是剩余次数。这条曾经写反过（把 0 当成「用完」），结果每天 10 次免战扫荡一次都没扫。
  // 证据：客户端 `WarPirateModel.initDate` 直接 `pirateSweepTimes = e.sweepTimes`，
  // 判剩余用 `maxSweepTimes() - pirateSweepTimes`，每日重置把 pirateSweepTimes 归 0；
  // 2026-10-28 全天 3930 条回包该字段恒为 0，而那天一次扫荡都没发过（若是剩余应为 10）。
  const pirateProbe = (uids, sweepUsed) => () => ({ pirates: uids.map((uid) => ({ uid, cityId: 9 })), sweepTimes: sweepUsed });
  const freshDay = DAILY_DRIVERS[1010].evaluate({ task: { id: 1010, progress: 1, targetProgress: 5 }, probe: pirateProbe([1, 2, 3, 4], 0), items: new Map(), ruby: 0, now: 0, config });
  assert.equal(freshDay.status, 'ready', 'sweepTimes=0 表示一次没用过（满次数），必须能扫');
  assert.equal(freshDay.actions.length, 4, '任务还差 4 次，就发 4 条（上限 10 次不用担心）');

  const outOfSweeps = DAILY_DRIVERS[1010].evaluate({ task: { id: 1010, progress: 1, targetProgress: 5 }, probe: pirateProbe([1, 2], 10), items: new Map(), ruby: 0, now: 0, config });
  assert.equal(outOfSweeps.status, 'blocked', '已用满 10 次时不能再发 PirateSweepRequest');
  assert.equal(outOfSweeps.actions, undefined);
  assert.ok(outOfSweeps.reason.includes('扫荡次数已用完'), `原因要说清是次数用完，实际：${outOfSweeps.reason}`);
  assert.ok(outOfSweeps.reason.includes('10/10'), `原因要带「已用/上限」，实际：${outOfSweeps.reason}`);

  const fewSweeps = DAILY_DRIVERS[1010].evaluate({ task: { id: 1010, progress: 1, targetProgress: 5 }, probe: pirateProbe([1, 2, 3], 8), items: new Map(), ruby: 0, now: 0, config });
  assert.equal(fewSweeps.actions.length, 2, '已用 8 / 上限 10 → 只剩 2 次，剩下的留到明天');

  const enoughSweeps = DAILY_DRIVERS[1010].evaluate({ task: { id: 1010, progress: 3, targetProgress: 5 }, probe: pirateProbe([1, 2, 3], 1), items: new Map(), ruby: 0, now: 0, config });
  assert.equal(enoughSweeps.actions.length, 2, '次数够时按「还差几次」发，不把地图上的海盗全扫一遍');

  const stage = DAILY_DRIVERS[1003].evaluate({ task: { id: 1003, progress: 0, targetProgress: 1 }, probe: () => null, items: new Map(), ruby: 0, now: 0, config, player: { mainlineStage: 41, level: 11 } });
  assert.equal(stage.actions[0].body.stage, 41, 'mainline battle targets PlayerInfo.mainlineStage');

  // 试炼副本的阶段号来自 TrialRaidStageCfg.stageId，并且要先过 openLevel 这一关。
  const raidConfig = { tables: { TrialRaidStageCfg: { data: [
    { raidId: 1, stageId: 1001, stageLevel: 1, openLevel: 14 },
    { raidId: 1, stageId: 1002, stageLevel: 2, openLevel: 14 },
  ] } } };
  const raidTask = { id: 1009, progress: 0, targetProgress: 1 };
  const raidProbe = () => ({ raid: { raidId: 1, passedStage: 0 } });
  const locked = DAILY_DRIVERS[1009].evaluate({ task: raidTask, probe: raidProbe, config: raidConfig, items: new Map(), ruby: 0, now: 0, player: { level: 11 } });
  assert.equal(locked.status, 'blocked', 'trial raid openLevel gates the plan');
  const open = DAILY_DRIVERS[1009].evaluate({ task: raidTask, probe: raidProbe, config: raidConfig, items: new Map(), ruby: 0, now: 0, player: { level: 14 } });
  assert.equal(open.actions[0].body.stageId, 1001, 'the first uncleared stageId is used, not passedStage+1');
  checked += 1;
}

// 折扣商店必须和点金一样被 allowPaid 拦住。
// 客户端 _onBtnBuyDiscountItem 是 `checkResAndShowNotice(Resource.RUBY, floor(price*discount))`
// 之后才发 DiscountShopBuyRequest —— 付的是**钻石**。2026-10-25 的归档里
// `DiscountShopBuyRequest{id:5}` 紧跟在三条 free 点金之后，RUBY 9742→9730，就是这条漏网。
{
  const { DAILY_DRIVERS, needsPaid, runDailies } = await import('./dailies.mjs');
  const bought = DAILY_DRIVERS[1007].evaluate({
    task: { id: 1007, progress: 0, targetProgress: 1 },
    probe: (name) => (name === 'DiscountShopRequest'
      ? { shopItem: [{ id: 5, price: 150, discount: 0.4, isBuy: false }] }
      : null),
    ruby: 9999,
  });
  assert.equal(bought.status, 'paid', '折扣店是花钻石的动作，不能标成 ready');
  assert.equal(bought.actions[0].paid, true, '动作本身也要带 paid 标记');
  assert.equal(bought.actions[0].body.id, 5, '买的是最便宜那件');
  assert.equal(needsPaid(bought), true);

  const runWith = async (allowPaid, actions = bought.actions) => {
    const sent = [];
    const client = {
      request: async () => ({ dailyTask: [], dailyActivity: 0, weeklyActivity: 0, dailyRewardClaimed: [], weeklyRewardClaimed: [] }),
      sendWatch: async (name) => { sent.push(name); },
    };
    const results = await runDailies(client, { DiscountShopBuyRequest: {} }, {
      tasks: [{ task: { id: 1007, title: '折扣商店购买' }, status: 'paid', actions }],
      chests: { actions: [] },
      gift: null,
    }, { allowMutate: true, allowPaid, claimRewards: false });
    return { sent, results };
  };

  const unpaid = await runWith(false);
  assert.deepEqual(unpaid.sent, [], 'allowPaid=false 时折扣店一条请求都不许发');
  assert.equal(unpaid.results[0].skipped, true);

  const paid = await runWith(true);
  assert.deepEqual(paid.sent, ['DiscountShopBuyRequest'], '开了 allowPaid 才允许买');

  // 旧驱动（status 写成 ready、只有 cost 文案）也能被兜住：门控不能只认 status。
  const legacy = await runWith(false, [{ request: 'DiscountShopBuyRequest', body: { id: 1 }, response: null, cost: '钻石 x60' }]);
  assert.deepEqual(legacy.sent, [], 'cost 里写着钻石的旧动作同样要拦住');
  checked += 1;
}

// PromptResponse 不带我们发出去的 seq，只能按发送顺序认领。英雄升级这类没有配套 Response
// 的请求靠 sendWatch 守着 prompt；若归属错了，一条和英雄无关的 prompt 会拒掉当时在飞的
// AllHeroRequest，整个养成运行就变成 400。
{
  const client = new GameClient({ url: 'wss://example.invalid/ws', protocol });
  const fake = (name, order) => {
    const state = { name, order, timer: null, settled: null, error: null };
    const settle = (kind) => (value) => { state.settled = kind; state.error = kind === 'reject' ? value : null; };
    return { state, entry: { name, responseName: `${name.slice(0, -7)}Response`, order, timer: null, resolve: settle('resolve'), reject: settle('reject') } };
  };

  // 先发的是被观察的升级请求，后发的是在飞的查询：prompt 归升级请求，查询必须活着。
  const watch = fake('HeroSkillLevelUpRequest', 0);
  const query = fake('AllHeroRequest', 1);
  client.watchers.push(watch.entry);
  client.pending.push(query.entry);
  client.attributePrompt({ style: 1, prompt: 5, args: ['upgrade condition unmet'] });
  assert.equal(watch.state.settled, 'reject', 'a prompt belongs to the watched send');
  assert.equal(watch.state.error.request, 'HeroSkillLevelUpRequest');
  assert.equal(query.state.settled, null, 'an unrelated in-flight request must not be rejected');
  assert.equal(client.pending.length, 1, 'the in-flight request stays pending');

  // 没有观察者时，prompt 落到**最早**那条在飞请求上（docs/gameplay.md 11.3 的规则）。
  client.pending.length = 0;
  const only = fake('ArenaChallengeRequest', 2);
  client.pending.push(only.entry);
  client.attributePrompt({ args: ['no chance left'] });
  assert.equal(only.state.settled, 'reject', 'without a watcher the oldest pending entry takes the prompt');
  assert.equal(client.pending.length, 0);

  // 两条在飞时必须是**最早**那条认领：取最新那条会把无关请求拒掉、真正被拒的干等满 timeout。
  // 并发场景真实存在 —— collectState 一次发 48 条只读请求。
  client.pending.length = 0;
  const first = fake('AllItemRequest', 5);
  const second = fake('AllResourceRequest', 6);
  client.pending.push(first.entry, second.entry);
  client.attributePrompt({ args: ['feature locked'] });
  assert.equal(first.state.settled, 'reject', 'the oldest in-flight request takes the prompt');
  assert.equal(second.state.settled, null, '新的那条必须继续等自己的回包');
  assert.deepEqual(client.pending.map((entry) => entry.name), ['AllResourceRequest'], '只摘掉被认领的那一条');

  // 在飞请求比观察者发得更早时，它就比观察者更该认领这条 prompt。
  client.pending.length = 0;
  client.watchers.length = 0;
  const older = fake('DrawAfkRewardRequest', 3);
  const later = fake('HeroLevelUpRequest', 4);
  client.pending.push(older.entry);
  client.watchers.push(later.entry);
  client.attributePrompt({ args: ['too early'] });
  assert.equal(older.state.settled, 'reject', 'the oldest outstanding send wins');
  assert.equal(later.state.settled, null, 'the newer watcher keeps waiting');
  checked += 1;
}

// 任务目标值推导：主线/支线只有 params，没有 targetProgress，取法必须和客户端一致；
// 取不出来的返回 null，调用方据此跳过，绝不能猜一个数出来当目标。
{
  const { taskTarget, nextOrderTier } = await import('./tasks.mjs');
  assert.equal(taskTarget({ type: '关卡进度', params: [30] }), 30, 'plain targets read params[0]');
  assert.equal(taskTarget({ type: '获取资源', params: ['淡水', 20] }), 20, 'resource targets read params[1]');
  assert.equal(taskTarget({ type: '击败野怪', params: ['海盗', '5'] }), 5, 'string numbers are parsed');
  assert.equal(taskTarget({ type: '升级建筑', params: ['民居', '1|1'] }), 1, 'upgrade targets take the part before the bar');
  assert.equal(taskTarget({ type: '试炼挑战', params: ['x'] }), 1, 'trial challenge is hardcoded to 1');
  assert.equal(taskTarget({ type: '未知类型' }), null, 'a missing params array yields null, never a guess');
  assert.equal(taskTarget({ type: '获取资源', params: ['淡水'] }), null, 'a short params array yields null');

  const orderCfg = { tables: { OrderDailyRewardCfg: { data: [
    { reqNum: 18, reward: [] }, { reqNum: 6, reward: [] }, { reqNum: 12, reward: [] },
  ] } } };
  const tier = nextOrderTier(orderCfg, { orderNum: 7, rewardedNum: 6 });
  assert.equal(tier.tier, 12, 'the next tier is the first reqNum above the rewarded one');
  assert.equal(tier.claimable, false, '7 orders is not enough for the 12-order tier');
  assert.equal(nextOrderTier(orderCfg, { orderNum: 12, rewardedNum: 6 }).claimable, true);
  assert.equal(nextOrderTier(orderCfg, { orderNum: 99, rewardedNum: 18 }).tier, null, 'the last tier claims nothing');
  checked += 1;
}

// 任务领取的 rejected 必须由调用方传进来 —— 以前它是 runTasks 里的局部 Set，
// 每个 (kind,id) 一轮只出现一次，等于这行永远不命中；循环里 rejected.tasks 初始化后
// 从未被使用，于是「必被拒」的领取请求每轮都重发一次（loop.mjs 头部注释承诺的跨轮去重是失效的）。
{
  const { runTasks } = await import('./tasks.mjs');
  const survey = {
    plan: [{ kind: 'achievement', id: 7, request: 'GotAchievementRewardRequest', body: { id: 7 }, label: '成就 7' }],
  };
  const protocol = { GotAchievementRewardRequest: {} };
  const rejected = new Set();

  const failing = { sendWatch: async () => { throw new Error('server prompt: already claimed'); } };
  const first = await runTasks(failing, protocol, survey, { allowMutate: true, rejected, window: 0 });
  assert.equal(first[0].ok, false, '第一次真的发了请求并失败');
  assert.equal(rejected.has('achievement:7'), true, '被拒的动作要记进调用方传进来的 Set（跨轮才有意义）');

  let calls = 0;
  const healthy = { sendWatch: async () => { calls += 1; } };
  const second = await runTasks(healthy, protocol, survey, { allowMutate: true, rejected, window: 0 });
  assert.equal(calls, 0, '同一份 rejected 的第二轮必须直接跳过，不再骚扰服务端');
  assert.equal(second[0].skipped, true);

  // 不传 rejected 时保持旧行为：单次运行自建临时 Set，不影响别的调用方。
  let calls2 = 0;
  const fresh = { sendWatch: async () => { calls2 += 1; } };
  await runTasks(fresh, protocol, survey, { allowMutate: true, window: 0 });
  assert.equal(calls2, 1, '不传 rejected 时照旧发一次');
  checked += 1;
}

// 订单优先的资源分配：订单材料与排产耗料先扣，剩下的才轮到升级。所以同样的库存，
// 少 8 个木材就该从「能升级」翻成「不能升级」，而这条分界线只能来自预留而不是随机。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '民居' }, { buildingType: '材料厂' }] },
    BuildingProduceCfg: { data: [
      { buildType: '材料厂', itemId: '布匹', produceTime: 300, unlockLevel: 1, costItem: [['木材', 5]] },
    ] },
    BuildingUpgradeCfg: { data: [
      { buildingType: '民居', level: 1, playerLevel: 1, curPeople: 1, costTime: 30, consume: [['木材', 50]], condition: [] },
      { buildingType: '民居', level: 2, playerLevel: 1, curPeople: 5, costTime: 60, consume: [['木材', 50]], condition: [] },
    ] },
  } };
  const stockOf = (wood) => new Map([['木材', wood], ['布匹', 0]]);
  const surveyFor = (wood) => {
    const stock = stockOf(wood);
    const factory = { buildingId: '1材料厂', type: '材料厂', level: 1, product: [],
      factory: { factoryQ: [], finishedProducts: [], autoProductId: '' } };
    return {
      now: 1000, player: { level: 11 }, population: 30, maxPopulation: 40, stockCap: 50, factorySlots: 6,
      have: (id) => stock.get(id) ?? 0,
      stock,
      buildings: [
        { buildingId: '1A民居', type: '民居', level: 1, product: [], buildFinishTime: 0, factory: null },
        factory,
      ],
      factories: [factory],
      orders: [{ index: 1, requirements: [{ id: '布匹', num: 2 }], missing: [{ id: '布匹', num: 2 }], rewardExp: 100 }],
    };
  };

  const tight = planWorld(surveyFor(52), { config });
  const produce = tight.actions.find((a) => a.kind === 'startProduce');
  assert.equal(produce.body.productId, '布匹', 'the order gap decides what gets produced');
  assert.equal(tight.actions.some((a) => a.kind === 'upgrade'), false,
    '52 wood minus the 5 reserved for production leaves too little to upgrade');
  assert.deepEqual(tight.reserved, [['木材', 5]], 'the reservation is reported, not hidden');

  const loose = planWorld(surveyFor(60), { config });
  const upgrade = loose.actions.find((a) => a.kind === 'upgrade');
  assert.ok(upgrade, 'with 60 wood the leftover 55 covers the 50-wood upgrade');
  assert.equal(upgrade.body.buildingId, '1A民居');
  assert.deepEqual(loose.reserved, [['木材', 55]], 'production and the upgrade both hold their share');

  // 交得起的订单要排在升级前面：它只花材料不动人口，而且能立刻换来经验。
  const payable = surveyFor(60);
  payable.stock.set('布匹', 9);
  payable.orders[0].missing = [];
  const ordered = planWorld(payable, { config });
  const kinds = ordered.actions.map((a) => a.kind);
  assert.ok(kinds.indexOf('finishOrder') < kinds.indexOf('upgrade'), 'the order is submitted before the upgrade');

  // 没开 --reroll 时材料不足的订单只写进 notes，绝不偷偷拒单。
  const held = planWorld(surveyFor(0), { config });
  assert.equal(held.actions.some((a) => a.kind === 'denyOrder'), false, 'a short order is kept unless reroll is on');
  assert.ok(held.notes.some((note) => note.includes('材料不足')), 'the kept order says why');
  const rerolled = planWorld(surveyFor(0), { config, allowReroll: true, minOrderExp: 500 });
  assert.equal(rerolled.actions.find((a) => a.kind === 'denyOrder')?.body.index, 1, 'low-value orders are denied when asked');

  // 交单判据是**全量需求**（requirements），不是探测时算出来的缺口（missing）。
  // 库存 3 / 需求 5 时 missing=2，拿 free()=3 去跟 2 比会误判成「材料齐」，
  // 请求发出去必被服务端拒，而且会把预留抬到虚高、连累后面的建造与升级。
  const partial = surveyFor(0);
  partial.stock.set('布匹', 3);
  partial.orders = [{
    index: 1,
    requirements: [{ id: '布匹', num: 5 }],
    missing: [{ id: '布匹', num: 2 }],
    rewardExp: 100,
  }];
  const shortOrder = planWorld(partial, { config });
  assert.equal(shortOrder.actions.some((a) => a.kind === 'finishOrder'), false,
    'have=3 / need=5 不能当成材料齐（缺口不是需求）');
  assert.ok(shortOrder.notes.some((note) => note.includes('布匹 3/5')),
    '提示要写 have/need，而不是 have/gap');

  // 库存刚好等于需求：交得掉，且只预留需求那一份（不重复扣）。
  const exact = surveyFor(0);
  exact.stock.set('布匹', 5);
  exact.orders = [{
    index: 2,
    requirements: [{ id: '布匹', num: 5 }],
    missing: [],
    rewardExp: 100,
  }];
  const exactPlan = planWorld(exact, { config });
  assert.equal(exactPlan.actions.some((a) => a.kind === 'finishOrder'), true, 'have=5 / need=5 可以交');
  assert.deepEqual(exactPlan.reserved, [['布匹', 5]], '只预留需求那一份，不重复扣');
  checked += 1;
}

// 生产时间减免与「瞬成排满」：客户端 produceFinalTime = ceil(max(0, 原时长 - 减免) / (1 + 提速))。
// 减免的大头是英雄委任（AppointEffectCfg「生产时间」按品质档 + 每星加成），
// 实测 3 个橙色 9 星 = 258×3 = 774 秒，于是 300 秒的鱼/淡水/布匹排下去就是 0 秒完成 ——
// 这种配方一轮要把制造位排满，否则低级物品永远得靠缩短循环间隔来续产。
{
  const { appointProduceReduce, produceFinalTime, planWorld, runWorld } = await import('./world.mjs');
  const config = { tables: {
    AppointPosCfg: { data: [
      { posId: 1, effectId: '生产时间', playerLevel: 4 },
      { posId: 2, effectId: '生产时间', playerLevel: 8 },
      { posId: 3, effectId: '生产时间', playerLevel: 15 },
      { posId: 4, effectId: '建造速度', playerLevel: 6 },
    ] },
    // 建造速度是百分比（viewType=百分比），绝不能当成秒数和生产时间混在一起加。
    AppointEffectCfg: { data: [
      { effectId: '生产时间', viewType: '数值', heroAdd: [8, 20, 60, 80], starAdd: [2, 8, 22, 28] },
      { effectId: '建造速度', viewType: '百分比', heroAdd: [0.0017, 0.0042, 0.0125, 0.0167], starAdd: [0.0006, 0.0015, 0.0045, 0.006] },
    ] },
    HeroCfg: { data: [
      { id: '杰森', qualityIndex: 3 },
      { id: '霍金', qualityIndex: 3 },
      { id: '巨石强森', qualityIndex: 3 },
      { id: '小布', qualityIndex: 1 },
    ] },
    BuildingCfg: { data: [{ buildingType: '切鱼厂' }] },
    BuildingProduceCfg: { data: [
      { buildType: '切鱼厂', itemId: '鱼', produceTime: 300, unlockLevel: 1, costItem: [['海藻', 1]] },
      { buildType: '切鱼厂', itemId: '烤鱼', produceTime: 1800, unlockLevel: 1, costItem: [['鱼', 2]] },
    ] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
  } };
  const appointed = [
    { heroId: '杰森', posId: 1 },
    { heroId: '霍金', posId: 2 },
    { heroId: '巨石强森', posId: 3 },
    { heroId: '小布', posId: 4 },
  ];
  const heroes = appointed.map((slot) => ({ heroId: slot.heroId, star: 9 }));
  const reduce = appointProduceReduce(config, { appointed, heroes });
  assert.equal(reduce, 774, '3 个橙色 9 星委任生产 = (80 + 28×9) × 3 = 774 秒');
  assert.equal(produceFinalTime(300, reduce), 0, '300 秒的配方在 774 秒减免下瞬成');
  assert.equal(produceFinalTime(1800, reduce), 1026, '1800 - 774 = 1026 秒，非瞬成');
  assert.equal(produceFinalTime(1800, 0), 1800, '没有减免时就是原时长');
  // 缺表时必须是 0，不能算出一个假的减免把队列排满。
  assert.equal(appointProduceReduce({ tables: {} }, { appointed, heroes }), 0, 'no effect table means no reduction');

  const surveyFor = ({ seaweed = 9, queue = [], finished = 0, slots = 6, cap = 50, reduce: forceReduce = reduce } = {}) => {
    const stock = new Map([['海藻', seaweed], ['鱼', 0], ['烤鱼', 0]]);
    const factory = {
      buildingId: '1切鱼厂', type: '切鱼厂', level: 1, product: [],
      factory: {
        factoryQ: queue,
        finishedProducts: finished > 0 ? [{ type: 'product', id: '鱼', num: finished }] : [],
        autoProductId: '',
      },
    };
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: cap, factorySlots: slots,
      buildings: [factory], factories: [factory], orders: [],
      produce: { reduce: forceReduce, observed: 0, source: 'appoint' },
    };
  };
  const producesOf = (plan) => plan.actions.filter((action) => action.kind === 'startProduce');

  // 瞬成 → 空制造位一次排满；但排 6 个就是 6 份料，预留也要是 6 份。
  const full = planWorld(surveyFor({ seaweed: 9 }), { config });
  assert.equal(producesOf(full).length, 6, 'an instant recipe fills all six slots in one round');
  assert.ok(producesOf(full).every((action) => action.body.productId === '鱼'), 'only the instant recipe is batched');
  assert.deepEqual(full.reserved, [['海藻', 6]], 'six batches burn six units of material, all reserved');
  assert.equal(new Set(producesOf(full).map((action) => action.key)).size, 6, 'batched actions need distinct keys');

  // 料不够就排到够为止，别排出花不掉的假动作。
  const short = planWorld(surveyFor({ seaweed: 3 }), { config });
  assert.equal(producesOf(short).length, 3, 'material shortage caps the batch');
  assert.ok(short.notes.some((note) => note.includes('材料不够')), 'the shortfall is explained');

  // 存量上限：仓库 + 待收 + 队列一起算，已到上限就一个都别排。
  const capped = planWorld(surveyFor({ seaweed: 9, finished: 48, cap: 50 }), { config });
  assert.equal(producesOf(capped).length, 2, 'the stock cap (48/50) leaves room for exactly two');
  const noRoom = planWorld(surveyFor({ seaweed: 9, finished: 50, cap: 50 }), { config });
  assert.equal(producesOf(noRoom).length, 0, 'a full stock means no production at all');

  // 非瞬成配方仍然一轮只排 1 个：队列是串行的，多排只是提前烧料。
  const slow = planWorld(surveyFor({ seaweed: 9, reduce: 0 }), { config });
  assert.equal(producesOf(slow).length, 1, 'a non-instant recipe is still queued one at a time');
  assert.equal(producesOf(slow)[0].body.productId, '鱼', 'the shorter recipe is still preferred');
  // 队列非空但**没满**：瞬成配方把剩余空位排满，长配方不往里塞。
  // 队列是**串行**的：只有队首真的在产，第 2 项及以后只是排队（服务端连 finishTime 都不编码）。
  // 2026-10-30 改：队首还在跑时**瞬成照样排满剩余空位** —— 排队不增加任何时间成本
  // （瓶颈是队首那个长物品），长物品一结束它们会在同一个 tick 里全部落地、下一轮一起收。
  // 旧逻辑「队首在跑只排 1 个」的后果是长物品占 30 分钟、5 个制造位干等、瞬成零产出。
  const busyQueue = [{ idx: 1, productId: '烤鱼', finishTime: 5000 }, { idx: 2, productId: '烤鱼', finishTime: 0 }];
  const busy = planWorld(surveyFor({ seaweed: 9, queue: busyQueue }), { config });
  assert.equal(producesOf(busy).length, 4, '队列 2/6 → 剩下的 4 个空位全排瞬成（排队等队首跑完）');
  assert.equal(producesOf(busy)[0].body.productId, '鱼', '没需求时排时间最短的（鱼 300s）');
  // 队首已经完成（finishTime <= now）：视同空闲，瞬成把剩余空位排满。
  const doneQueue = [{ idx: 1, productId: '烤鱼', finishTime: 500 }];
  const headDone = planWorld(surveyFor({ seaweed: 9, queue: doneQueue }), { config });
  assert.equal(producesOf(headDone).length, 5, '队首已完成 → 剩下 5 个空位排满瞬成');
  assert.ok(producesOf(headDone).every((action) => action.body.productId === '鱼'), '排的是瞬成的鱼');
  // 队首 finishTime = 0 = 服务端还没给这条队列排上时间（刚排完没结算），也当「在跑」。
  const queuedHead = [{ idx: 1, productId: '烤鱼', finishTime: 0 }];
  const zeroHead = planWorld(surveyFor({ seaweed: 9, queue: queuedHead }), { config });
  assert.equal(producesOf(zeroHead).length, 5, '队首 finishTime=0 也算占位，瞬成只填剩下的 5 个空位');

  // 有明确需求的配方（订单 / 货船缺口）在队首还在跑时也要排进去 —— 但**队列里已经有长物品时不再往上堆**
  // （2026-10-30 加 maxLongQueue）：串行队列一次只跑一个，堆第 2 个不提升任何产能，
  // 却会把制造位吃光（实测 1家具厂 6/6 = 橱柜+躺椅×5、1服装厂 6/6 = 鱼皮鞋×5+渔夫帽，
  // 0 秒的瞬成配方布匹/淡水连排队资格都没有）。下面这条队列已经排了 2 个烤鱼 → 本轮改排瞬成的鱼。
  const busyDemandSurvey = surveyFor({ seaweed: 9, queue: busyQueue });
  busyDemandSurvey.stock.set('鱼', 4);
  // 队列里已经有 2 个烤鱼，所以需求得给到 4 才算「还没填满」。
  const busyDemand = planWorld(busyDemandSurvey, { config, cargoDemand: new Map([['烤鱼', 4]]) });
  assert.equal(producesOf(busyDemand).length, 4, '队列 2/6 → 4 个空位全排瞬成');
  assert.equal(producesOf(busyDemand)[0].body.productId, '鱼',
    '队列里已有长物品 → 不再堆烤鱼，改排瞬成的鱼（长物品一跑完它立刻落地）');
  // 队列里只有 1 个长物品（正在跑）时同理：那一个是必要的，但第 2 个不再追加。
  const oneLong = planWorld(
    surveyFor({ seaweed: 9, queue: [{ idx: 1, productId: '烤鱼', finishTime: 5000 }] }),
    { config, cargoDemand: new Map([['烤鱼', 3]]) },
  );
  assert.ok(producesOf(oneLong).length > 0 && producesOf(oneLong).every((a) => a.body.productId === '鱼'),
    '队列里已有 1 个长物品在跑 → 本轮只排瞬成（maxLongQueue 默认 1）');
  // 队列空 + 有需求：长物品照样排，不然它永远轮不上（瞬成的分更高时会一直霸占）。
  // 烤鱼要「鱼×2」当料，这里先给够，否则它连 affordable 都过不了、根本进不了比较。
  const emptyLongSurvey = surveyFor({ seaweed: 9 });
  emptyLongSurvey.stock.set('鱼', 4);
  const emptyLong = planWorld(emptyLongSurvey, { config, cargoDemand: new Map([['烤鱼', 2]]) });
  assert.equal(producesOf(emptyLong)[0].body.productId, '烤鱼', '队列空 + 有需求 → 长物品排最前');
  assert.equal(producesOf(emptyLong).length, 1, '长物品一轮只排 1 个');
  // 想退回旧行为（能把队列重新堆满长物品）就传 Infinity。
  const legacySurvey = surveyFor({ seaweed: 9, queue: busyQueue });
  legacySurvey.stock.set('鱼', 4);
  const legacyQueue = planWorld(legacySurvey,
    { config, maxLongQueue: Infinity, cargoDemand: new Map([['烤鱼', 4]]) });
  assert.equal(producesOf(legacyQueue)[0].body.productId, '烤鱼', 'maxLongQueue = Infinity 时退回「继续堆长物品」');
  // 排产动作要带「是不是瞬成」和「这座厂队列里几个长物品」两个标记 —— 挂机的瞬成补产循环靠它
  // 判断「排完等 6 秒能不能收到」（队列里有长物品时瞬成只能排队，收不到）。
  assert.equal(producesOf(emptyLong)[0].instant, false, '长物品的排产动作不带瞬成标记');
  assert.equal(producesOf(emptyLong)[0].queueLong, 0, '空队列的 queueLong = 0');
  const instantMark = planWorld(surveyFor({ seaweed: 9 }), { config });
  assert.equal(producesOf(instantMark)[0].instant, true, '瞬成配方的排产动作带 instant 标记');
  assert.equal(producesOf(instantMark)[0].queueLong, 0, '空队列的瞬成动作 queueLong = 0');
  const queuedMark = planWorld(surveyFor({ seaweed: 9, queue: [{ idx: 1, productId: '烤鱼', finishTime: 5000 }] }), { config });
  assert.equal(producesOf(queuedMark)[0].queueLong, 1, '队列里 1 个长物品 → queueLong = 1（补产循环会跳过它）');
  // 队列空 + 有需求 + 瞬成配方：按缺口排，不排满空位（货船要 2 个就产 2 个，多产的既占库存也占材料）。
  const gapSurvey = surveyFor({ seaweed: 9 });
  const gapPlan = planWorld(gapSurvey, { config, cargoDemand: new Map([['鱼', 2]]) });
  assert.equal(producesOf(gapPlan).length, 2, '货船要 2 个 → 瞬成也只排 2 个（不排满 6 个空位）');
  assert.ok(producesOf(gapPlan).every((action) => action.body.productId === '鱼'), '排的是货船要的那条');
  // finishedProducts 的 num 是 protobuf int64：可能是 {low,high} 对象。裸 Number() 会 NaN，
  // 然后 heldOf 一路 NaN、`held < stockCap` 恒 false → 整座工厂的配方全被过滤掉（排不了产）。
  const int64Survey = surveyFor({ seaweed: 9 });
  const int64Factory = { ...int64Survey.factories[0].factory, finishedProducts: [{ type: 'product', id: '鱼', num: { low: 50, high: 0 } }] };
  int64Survey.factories[0].factory = int64Factory;
  int64Survey.buildings[0].factory = int64Factory;
  const int64Plan = planWorld(int64Survey, { config });
  assert.equal(producesOf(int64Plan).length, 0, 'int64 形状的待收量要算进持有量（50/50 已到上限）');

  // 存量上限是**全局限**：同一件物品可能好几座工厂都能产。
  // 只算本厂的话，A 厂待收 48 个、B 厂完全看不见，照样再排 6 个 → 服务端回 storage full。
  const crossSurvey = surveyFor({ seaweed: 9 });
  crossSurvey.factories[0].factory.finishedProducts = [{ type: 'product', id: '鱼', num: 48 }];
  const twin = {
    ...crossSurvey.factories[0],
    buildingId: '2切鱼厂',
    factory: { factoryQ: [], finishedProducts: [], autoProductId: '' },
  };
  crossSurvey.factories.push(twin);
  crossSurvey.buildings.push(twin);
  const crossPlan = planWorld(crossSurvey, { config });
  assert.equal(producesOf(crossPlan).length, 2,
    '两座工厂合计只能再排 2 个（48/50），不是各排一批');
  // 需求已经被「在产」的那批填上时不再重复排（demand 是缺口，队列/待收要算进去）。
  const coveredSurvey = surveyFor({ seaweed: 9, queue: busyQueue });
  coveredSurvey.stock.set('鱼', 4);
  const covered = planWorld(coveredSurvey, { config, cargoDemand: new Map([['烤鱼', 2]]) });
  assert.equal(producesOf(covered).some((action) => action.body.productId === '烤鱼'), false,
    '队列里已经排了 2 个烤鱼 → 缺口填满，不再重复排');

  // 贸易港口的货船缺口并进排产需求（cargoDemand）：工厂先产「货船要的」，而不是「时间最短的」。
  // 没有这条路时，货船缺的东西只能干等工厂哪天顺手排到它，船就一直不走。
  const cargoStock = () => surveyFor({ seaweed: 9, reduce: 0 });
  const baselineSurvey = cargoStock();
  baselineSurvey.stock.set('鱼', 4);
  const baseline = planWorld(baselineSurvey, { config });
  assert.equal(producesOf(baseline)[0].body.productId, '鱼', '没有额外需求时先排时间最短的（鱼 300s）');
  const wantedSurvey = cargoStock();
  wantedSurvey.stock.set('鱼', 4);
  const wanted = planWorld(wantedSurvey, { config, cargoDemand: new Map([['烤鱼', 2]]) });
  assert.equal(wanted.actions.find((a) => a.kind === 'startProduce').body.productId, '烤鱼',
    '货船要烤鱼时先排烤鱼（缺口 ×1e6 压过时间差）');
  const zeroSurvey = cargoStock();
  zeroSurvey.stock.set('鱼', 4);
  const zeroDemand = planWorld(zeroSurvey, { config, cargoDemand: new Map([['烤鱼', 0]]) });
  assert.equal(zeroDemand.actions.find((a) => a.kind === 'startProduce').body.productId, '鱼',
    '缺口 0 不参与排序（不能靠列一条 0 需求把某个配方顶上来）');
  // 不传 / 传空表 = 旧行为，不能再有别的副作用。
  const noDemand = planWorld(cargoStock(), { config, cargoDemand: null });
  assert.equal(producesOf(noDemand).length, 1, 'cargoDemand 不传时行为不变');
  const busySlow = planWorld(surveyFor({ seaweed: 9, reduce: 0, queue: busyQueue }), { config });
  assert.equal(producesOf(busySlow).length, 1, '队首在跑 + 没有瞬成配方：也只排 1 个（不当成空闲批量排）');
  const busyFull = planWorld(surveyFor({
    seaweed: 9,
    queue: Array.from({ length: 6 }, (_, i) => ({ idx: i + 1, productId: '烤鱼', finishTime: 5000 })),
  }), { config });
  assert.equal(producesOf(busyFull).length, 0, '队列排满 = 没位置，一个都不排');
  // 所有产品都到上限 → 空闲是正常状态，notes 里要说明原因（候选被过滤 / 循环里被 held 卡住都算）。
  assert.ok(noRoom.notes.some((note) => note.includes('空闲') || note.includes('上限')),
    'an idle factory says why');

  // 批量排产中途被拒：只停这座工厂剩下的几条，别的工厂照排，
  // 而且不能写进 rejected —— 队列满/库存满都是瞬时状态，记一辈子就再也不排了。
  {
    let tried = 0;
    const client = {
      sendWatch: async (name, body) => {
        if (body.buildingId === '1切鱼厂') {
          tried += 1;
          // 第 2 条才失败：模拟「前一条排进去后队列/库存刚好满了」。
          if (tried === 2) throw new Error('storage full');
        }
        return null;
      },
    };
    const survey = surveyFor({ seaweed: 12, slots: 6 });
    const second = { ...survey.factories[0], buildingId: '2切鱼厂' };
    survey.factories = [survey.factories[0], second];
    survey.buildings = survey.factories;
    const plan = planWorld(survey, { config });
    assert.equal(producesOf(plan).length, 12, 'two factories, six slots each');
    const { results, rejected } = await runWorld(client, { StartFactoryProduceRequest: {} }, plan, {
      allowMutate: true, window: 0, rejected: new Set(),
    });
    assert.equal(rejected.size, 0, 'a transient produce failure is not remembered forever');
    const firstFactory = results.filter((entry) => entry.step.body.buildingId === '1切鱼厂');
    const secondFactory = results.filter((entry) => entry.step.body.buildingId === '2切鱼厂');
    assert.equal(firstFactory.filter((entry) => entry.ok).length, 1, 'the first slot goes through');
    assert.equal(firstFactory.filter((entry) => entry.skipped).length, 4, 'the rest of that factory stops');
    assert.equal(secondFactory.filter((entry) => entry.ok).length, 6, 'the other factory is untouched');
  }

  // 最优先的配方已经到上限时，要跳过它去排下一条，而不是让整座工厂空转。
  // 之前候选过滤只看仓库（have）、上限判定看 held：仓库 0 但工厂囤了 50 个时，
  // 第一条配方能通过过滤，随后在循环里被 break 掉，planned=0，后面能排的配方永远轮不到。
  {
    const fallbackConfig = { tables: {
      BuildingCfg: { data: [{ buildingType: '食品厂' }] },
      BuildingProduceCfg: { data: [
        { buildType: '食品厂', itemId: '鱼肠线', produceTime: 100, unlockLevel: 1, costItem: [['海藻', 1]] },
        { buildType: '食品厂', itemId: '鱼丸', produceTime: 900, unlockLevel: 1, costItem: [['海藻', 1]] },
      ] },
      BuildingUpgradeCfg: { data: [] },
      SelectPackLibCfg: { data: [] },
    } };
    const stock = new Map([['海藻', 9], ['鱼肠线', 0], ['鱼丸', 0]]);
    const factory = {
      buildingId: '1食品厂',
      type: '食品厂',
      level: 1,
      product: [],
      factory: { factoryQ: [], finishedProducts: [{ type: 'product', id: '鱼肠线', num: 50 }], autoProductId: '' },
    };
    const survey = {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: 50, factorySlots: 6,
      buildings: [factory], factories: [factory], orders: [],
    };
    const plan = planWorld(survey, { config: fallbackConfig });
    const produced = plan.actions.filter((action) => action.kind === 'startProduce');
    assert.equal(produced.length, 1, '囤满的配方被过滤后还要继续排下一条，不能整座空转');
    assert.equal(produced[0].body.productId, '鱼丸', '跳过已到上限的鱼肠线');
  }
  checked += 1;
}

// 农田：成熟的批量收、空出来的批量播。
// 两个请求都是 repeated（FarmHarvestRequest.buildingId / FarmPlantRequest.args），一轮各一条就够；
// 种子在 FarmlandPlantCfg.material = [种子名, 份数]（**一对**，不是列表），要按库存扣。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '农田' }] },
    BuildingProduceCfg: { data: [] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    FarmlandPlantCfg: { data: [
      { id: '小麦', time: 1800, produceNum: 5, material: ['小麦种子', 1] },
      { id: '玉米', time: 1800, produceNum: 5, material: ['玉米种子', 1] },
      { id: '南瓜', time: 4800, produceNum: 5, material: ['南瓜种子', 1] },
    ] },
  } };
  const surveyFor = ({ plots, seeds = {}, orders = [], autoFarming = false } = {}) => {
    const stock = new Map(Object.entries(seeds));
    const buildings = plots.map((plot, i) => ({
      buildingId: `${i + 1}农田`,
      type: '农田',
      level: 1,
      product: [],
      buildFinishTime: 0,
      factory: null,
      farm: plot,
    }));
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: 50, factorySlots: 6,
      autoFarming, buildings, factories: [], orders,
      produce: { reduce: 0, instant: [] },
    };
  };
  const of = (plan, kind) => plan.actions.filter((a) => a.kind === kind);
  const ripe = { productId: '玉米', ripeAt: 900, plantAt: 100 };
  const idle = { productId: '', ripeAt: 0, plantAt: 0 };
  const growing = { productId: '玉米', ripeAt: 5000, plantAt: 990 };

  // 熟的一次收完（多块装一条请求），空的一块紧接着种。
  const basic = planWorld(surveyFor({ plots: [ripe, idle, growing], seeds: { 小麦种子: 10 } }), { config });
  assert.equal(of(basic, 'farmHarvest').length, 1, 'all ripe plots go in one harvest request');
  assert.deepEqual(of(basic, 'farmHarvest')[0].body.buildingId, ['1农田'], 'only the ripe plot is harvested');
  assert.equal(of(basic, 'farmPlant').length, 1, 'planting is one batched request');
  // 刚收的那块地收完就是空的，同一轮直接种上；生长中的那块不动。
  assert.deepEqual(of(basic, 'farmPlant')[0].body.args,
    [{ buildingId: '1农田', productId: '小麦' }, { buildingId: '2农田', productId: '小麦' }],
    'the harvested plot is replanted in the same round, the growing one is left alone');
  assert.deepEqual(basic.reserved, [['小麦种子', 2]], 'both seeds are reserved, not silently spent');
  assert.equal(of(basic, 'farmHarvest')[0].response, null, 'FarmHarvestRequest has no paired response');
  assert.equal(of(basic, 'farmPlant')[0].response, null, 'FarmPlantRequest has no paired response');

  // 播种顺序：价值高的先种（配置里没有价格字段，用成熟时间当代价），同一时长内订单缺的优先。
  const valuable = planWorld(surveyFor({ plots: [idle, idle, idle], seeds: { 小麦种子: 10, 南瓜种子: 10 } }), { config });
  assert.equal(of(valuable, 'farmPlant')[0].body.args.every((arg) => arg.productId === '南瓜'), true,
    'the most valuable seed (longest grow time) is planted first');
  const wanted = planWorld(surveyFor({
    plots: [idle, idle, idle],
    seeds: { 小麦种子: 10, 玉米种子: 10 },
    orders: [{ index: 1, requirements: [{ id: '玉米', num: 5 }], missing: [{ id: '玉米', num: 5 }], rewardExp: 10 }],
  }), { config });
  assert.equal(of(wanted, 'farmPlant')[0].body.args.every((arg) => arg.productId === '玉米'), true,
    'between equally long crops the one an order is short of wins');

  // 种子只够一块：种一块，剩下的写成 notes 说清楚。
  const short = planWorld(surveyFor({ plots: [idle, idle, idle], seeds: { 小麦种子: 1 } }), { config });
  assert.equal(of(short, 'farmPlant')[0].body.args.length, 1, 'only as many plots as the seeds can cover');
  assert.ok(short.notes.some((note) => note.includes('没有种子')), 'the unplanted plots are explained');

  // 游戏内「自动种植」开着：服务端自己播，计划里只许收、不许播。
  const auto = planWorld(surveyFor({ plots: [ripe, idle], seeds: { 小麦种子: 10 }, autoFarming: true }), { config });
  assert.equal(of(auto, 'farmHarvest').length, 1, 'auto farming still needs the harvest');
  assert.equal(of(auto, 'farmPlant').length, 0, 'auto farming means the server plants, we must not');
  assert.ok(auto.notes.some((note) => note.includes('自动种植')), 'it says why it did not plant');

  // 开关关掉就完全不碰农田（连收都不收）—— 循环按自己的间隔传 farm:false。
  const off = planWorld(surveyFor({ plots: [ripe, idle], seeds: { 小麦种子: 10 } }), { config, farm: false });
  assert.equal(of(off, 'farmHarvest').length + of(off, 'farmPlant').length, 0, 'farm:false touches nothing');
  checked += 1;
}

// 用「过剩的作物」驱动排产（2026-10-28）：农田产出远大于工厂消耗时（实测一天 400+ 个
// vs 食品厂只吃掉 39 个小麦），作物会一路堆到单种上限 250，然后农田永久停摆。
// 修法：把「超出安全水位」的那部分作物折成成品需求注入 demand，
// 让 180~300 分钟的长配方（平时永远排在淡水/布匹这些瞬成配方后面）也能排上。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '食品厂' }] },
    BuildingProduceCfg: { data: [
      // 长配方：只有它吃小麦（另外还要鱼，用来测「料不齐不加需求」）
      { buildType: '食品厂', itemId: '面包', produceTime: 5400, unlockLevel: 1, costItem: [['小麦', 5], ['鱼', 5]] },
      // 短配方：不吃作物。无需求时它会因为「产出时间短」一直赢，正好用来验证需求有没有生效
      { buildType: '食品厂', itemId: '鱼汤', produceTime: 600, unlockLevel: 1, costItem: [['鱼', 5]] },
    ] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    FarmlandPlantCfg: { data: [{ id: '小麦', time: 1800, produceNum: 5, material: ['小麦种子', 1] }] },
  } };
  const surveyFor = (stockObj) => {
    const stock = new Map(Object.entries(stockObj));
    const shop = {
      buildingId: '1食品厂', type: '食品厂', level: 1, product: [], buildFinishTime: 0,
      factory: { autoProductId: '', factoryQ: [], finishedProducts: [] }, farm: null,
    };
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: 50, factorySlots: 6, autoFarming: false,
      buildings: [shop], factories: [shop], orders: [], produce: { reduce: 0, instant: [] },
    };
  };
  const made = (plan) => plan.actions.filter((a) => a.kind === 'startProduce').map((a) => a.items[0][0]);

  // 小麦只有 3 个（远低于水位 40）→ 不算过剩，不加需求 → 短配方鱼汤照旧赢。
  const lean = planWorld(surveyFor({ 小麦: 3, 鱼: 99 }), { config });
  assert.deepEqual(made(lean), ['鱼汤'], 'a crop below its waterline does not get fed to the factory');

  // 小麦 200（水位 40）→ 过剩 160 个能折 32 份面包，但有上限 3 份 → 面包顶到鱼汤前面。
  const fat = planWorld(surveyFor({ 小麦: 200, 鱼: 99 }), { config });
  assert.deepEqual(made(fat), ['面包'], 'surplus crops pull their long recipe ahead of the short one');
  assert.ok(fat.notes.some((note) => note.includes('用过剩作物排产')), 'it says which crops are being burned');

  // 料不齐时**不加需求** —— 加了需求工厂就会拿自选包去兑，而「无需求不烧包」是硬规则。
  const noMat = planWorld(surveyFor({ 小麦: 200 }), { config });
  assert.equal(made(noMat).includes('面包'), false, 'a recipe missing materials never gets a demand boost');
  checked += 1;
}

// 种子厂留余量（2026-10-28）：种子一炉只出 1 个，堆到上限就是纯浪费 ——
// 实测小麦种子 45/50 还被连排 4 个（6 个队列位占掉 4 个、一占 2 小时），
// 而真正缺的番茄种子（0 个）只排上 1 个。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '种子厂' }] },
    BuildingProduceCfg: { data: [
      { buildType: '种子厂', itemId: '小麦种子', produceTime: 1800, unlockLevel: 1, costItem: [['种子', 100]] },
      { buildType: '种子厂', itemId: '番茄种子', produceTime: 2400, unlockLevel: 4, costItem: [['种子', 100]] },
    ] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    // 空的作物表：只测 out pool 的上限过滤，不让「农田缺种子」那段需求插进来
    FarmlandPlantCfg: { data: [] },
  } };
  const surveyFor = (stockObj) => {
    const stock = new Map(Object.entries(stockObj));
    const factory = {
      buildingId: '1种子厂', type: '种子厂', level: 4, product: [], buildFinishTime: 0,
      factory: { autoProductId: '', factoryQ: [], finishedProducts: [] }, farm: null,
    };
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: 50, factorySlots: 6, autoFarming: false,
      buildings: [factory], factories: [factory], orders: [], produce: { reduce: 0, instant: [] },
    };
  };
  const made = (plan) => plan.actions.filter((a) => a.kind === 'startProduce').map((a) => a.items[0][0]);

  // 小麦种子 45，离上限只差 5（余量线 = 50 - 5 = 45）→ 不排它；番茄种子 0 → 排番茄。
  const nearCap = planWorld(surveyFor({ 种子: 9999, 小麦种子: 45, 番茄种子: 0 }), { config });
  assert.deepEqual(made(nearCap), ['番茄种子'],
    'a seed sitting on the cap margin is skipped so the scarce one gets the queue slot');

  // 对照组：小麦种子只有 40（余量线以下）→ 仍按「产出时间短的先」排小麦。
  const under = planWorld(surveyFor({ 种子: 9999, 小麦种子: 40 }), { config });
  assert.deepEqual(made(under), ['小麦种子'], 'seeds below the margin still get produced');
  checked += 1;
}

// 地块识别（farmOf）：服务端**只在有作物时才编码 building.farm**，空地那条建筑里压根没有 farm 字段。
// 旧实现按「有没有 farm 字段」判断是不是农田 → 空地全部变成 null → farms.length === 0 →
// 整段农田逻辑静默跳过，播种永远不发生（2026-10-27 真实事故：3 块地空了一整天）。
{
  const { farmOf } = await import('./world.mjs');
  const empty = { buildingId: '3农田', level: 1, product: { asset: [] }, skinId: 0 };
  const planted = { buildingId: '1农田', level: 1, farm: { productId: '小麦', plantTime: 100, ripeTime: 1900 } };
  const building = { buildingId: '4农田', level: 0, buildStartTime: 90, buildFinishTime: 5000 };

  assert.deepEqual(farmOf(empty, '农田', 1), { productId: '', plantAt: 0, ripeAt: 0 },
    'a farm plot with no farm field in the payload is an EMPTY plot, not a non-farm building');
  assert.deepEqual(farmOf(planted, '农田', 1), { productId: '小麦', plantAt: 100, ripeAt: 1900 },
    'a planted plot keeps productId / plantAt / ripeAt');
  assert.equal(farmOf(building, '农田', 0), null, 'a farm still under construction is not a plantable plot');
  assert.equal(farmOf(empty, '食品厂', 1), null, 'other building types are never plots');
  checked += 1;
}

// 播种的两道「别撞墙」保护（2026-10-27 事故：土豆堆到 265，服务端每轮回
// `item limit reached`，4 块地空了一个多小时、日志每轮刷一条失败）：
//   ① 单种库存到上限 → 换别的种子种；
//   ② 被拒过的作物在解禁前不种；
//   ③ 一种作物一条请求 —— 土豆被拒不会连累小麦。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '农田' }] },
    BuildingProduceCfg: { data: [] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    FarmlandPlantCfg: { data: [
      { id: '土豆', time: 2400, produceNum: 5, material: ['土豆种子', 1] },
      { id: '小麦', time: 1800, produceNum: 5, material: ['小麦种子', 1] },
      { id: '玉米', time: 1800, produceNum: 5, material: ['玉米种子', 1] },
      { id: '番茄', time: 2400, produceNum: 5, material: ['番茄种子', 1] },
    ] },
  } };
  const surveyFor = (stockObj, plots = 2) => {
    const stock = new Map(Object.entries(stockObj));
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: 50, factorySlots: 6, autoFarming: false,
      buildings: Array.from({ length: plots }, (_, i) => ({
        buildingId: `${i + 1}农田`, type: '农田', level: 1, product: [], buildFinishTime: 0,
        factory: null, farm: { productId: '', plantAt: 0, ripeAt: 0 },
      })),
      factories: [], orders: [], produce: { reduce: 0, instant: [] },
    };
  };
  const plants = (plan) => plan.actions.filter((a) => a.kind === 'farmPlant');

  // 土豆 265（实测 245 能种、260 起被拒）→ 跳过土豆，改种小麦。
  const capped = planWorld(surveyFor({ 土豆: 265, 小麦: 12, 土豆种子: 9, 小麦种子: 9 }), { config });
  assert.equal(plants(capped).length, 1, 'the capped crop is skipped, the other one still gets planted');
  assert.deepEqual(plants(capped)[0].body.args.map((a) => a.productId), ['小麦', '小麦'],
    'crops at their stock cap are never planted again');
  assert.ok(capped.notes.some((note) => note.includes('土豆') && note.includes('上限')),
    'it explains why the crop was skipped');

  // cap 传 0 就关掉这条保护（回到「能种就种」）。
  const noCap = planWorld(surveyFor({ 土豆: 265, 土豆种子: 9 }), { config, farmCropCap: 0 });
  assert.equal(plants(noCap).length, 1, 'farmCropCap:0 disables the stock-cap guard');
  assert.equal(plants(noCap)[0].body.args[0].productId, '土豆', 'without the guard the valuable crop wins');

  // 库存少的先种：土豆 210、小麦 12 → 先种小麦（不再只看「时长长的更值钱」）。
  const lowFirst = planWorld(surveyFor({ 土豆: 210, 小麦: 12, 土豆种子: 9, 小麦种子: 9 }), { config });
  assert.equal(plants(lowFirst)[0].body.args[0].productId, '小麦',
    'the crop with less stock is planted first');

  // **分散铺开 + 目标水位**（2026-10-28 策略）：4 块地 + 3 种种子 → 先每种各占一块，
  // 多出来的那块给「离水位最远」的那种；同一种作物不能一口吃光所有地。
  // 三种作物库存都低于水位（测试配置里没有成品配方 → 水位退回 40），所以都能种。
  const spread = planWorld(
    surveyFor({ 土豆: 30, 小麦: 20, 玉米: 5, 土豆种子: 9, 小麦种子: 9, 玉米种子: 9 }, 4),
    { config },
  );
  const spreadCrops = plants(spread).flatMap((a) => a.body.args.map((arg) => arg.productId));
  assert.equal(spreadCrops.length, 4, 'all four plots get planted');
  assert.deepEqual([...new Set(spreadCrops)].sort(), ['土豆', '小麦', '玉米'].sort(),
    'every crop with seeds gets a plot before one of them takes a second plot');
  assert.equal(spreadCrops.filter((c) => c === '玉米').length, 2,
    'the leftover plot goes to the crop furthest below its waterline');
  // 番茄没有种子 → 不种，也不该把地浪费在它身上。
  assert.equal(spreadCrops.includes('番茄'), false, 'crops without seeds are never planted');

  // **目标水位**：库存到水位的作物不再种（否则 13 种会一起堆到单种上限 250，
  // 然后上限过滤把每一种都剔掉 —— 地块永久空着，这是死局）。
  const atLine = planWorld(
    surveyFor({ 土豆: 60, 小麦: 40, 玉米: 5, 土豆种子: 9, 小麦种子: 9, 玉米种子: 9 }, 4),
    { config },
  );
  const atLineCrops = plants(atLine).flatMap((a) => a.body.args.map((arg) => arg.productId));
  assert.deepEqual([...new Set(atLineCrops)], ['玉米'],
    'crops already at their waterline give way to the one still short');

  // 全部到水位：一块都不种，并且说清「是等工厂消化，不是没种子」。
  const allFull = planWorld(
    surveyFor({
      土豆: 60, 小麦: 45, 玉米: 45, 番茄: 45,
      土豆种子: 9, 小麦种子: 9, 玉米种子: 9, 番茄种子: 9,
    }, 2),
    { config },
  );
  assert.equal(plants(allFull).length, 0, 'nothing is planted once every crop reaches its waterline');
  assert.ok(allFull.notes.some((note) => note.includes('安全水位')),
    'when everything is at the waterline the empty plots are explained');

  // 两种作物各一条请求：group 不同，失败隔离才能生效。
  const mixed = planWorld(surveyFor({ 土豆种子: 1, 小麦种子: 1 }), { config });
  assert.equal(plants(mixed).length, 2, 'one FarmPlantRequest per crop');
  assert.deepEqual(plants(mixed).map((a) => a.group).sort(), ['farmPlant:土豆', 'farmPlant:小麦'],
    'each crop gets its own group so one rejection cannot block the other');

  // 刚被拒过（还没解禁）的作物一律不种，哪怕库存很低。
  const blocked = planWorld(surveyFor({ 土豆种子: 5 }), {
    config,
    farmBlocked: new Map([['土豆', 1000 * 1000 + 60_000]]),
  });
  assert.equal(plants(blocked).length, 0, 'a crop rejected by the server is skipped until it expires');
  assert.ok(blocked.notes.some((note) => note.includes('刚被服务端拒过')),
    'the loop explains the temporary skip');
  checked += 1;
}

// 联盟订单：一天一单，交齐 3 种物品换功勋。
// 硬约束（配置 + 客户端 proto 双向确认）：`FinishGuildOrderRequest` **只有 cityId 一个字段** ——
// 不能顺手把物品清单/货币塞进去，否则就是把「不花额外资源」这条边界搞丢了。
{
  const { surveyGuildOrder: _survey, viewGuildOrder, planGuildOrder, maxOrderPerDay, orderQuota } = await import('./guildOrder.mjs');
  const config = { tables: {
    GuildOrderNumCfg: { data: [
      { season: 1, playerLevel: 1, maxNum: -1 },
      { season: 3, playerLevel: 1, maxNum: 10 },
      { season: 3, playerLevel: 30, maxNum: 30 },
    ] },
    GuildOrderCfg: { data: [{ itemId: '日用品', guildExp: 20, reward: ['功勋', 35] }] },
  } };
  const surveyFor = ({ stock = {}, city = { cityId: 49, recommended: true }, doneToday = 0, maxNum = -1 } = {}) => ({
    requirements: [{ id: '日用品', num: 4 }, { id: '海藻汁', num: 6 }],
    nextRefreshTime: 1793203200,
    city,
    cities: city ? [city] : [],
    doneToday,
    maxNum,
    quota: orderQuota(maxNum, doneToday),
    stock: new Map(Object.entries(stock)),
  });

  // 料齐 → 一条动作，body 里**只有 cityId**。
  const ok = planGuildOrder(viewGuildOrder(surveyFor({ stock: { 日用品: 50, 海藻汁: 47 } })), { config });
  assert.equal(ok.actions.length, 1, 'enough stock means exactly one finish request');
  assert.deepEqual(ok.actions[0].body, { cityId: 49 },
    'FinishGuildOrderRequest carries cityId only — no item list, no currency');
  assert.equal(ok.actions[0].request, 'FinishGuildOrderRequest');
  assert.equal(ok.actions[0].transient, true, 'a failed order must not be remembered forever');
  assert.deepEqual(ok.actions[0].items, [['日用品', 4], ['海藻汁', 6]], 'the log shows what was handed in');

  // 料不齐 → 不发请求，说明缺什么（而且绝不走「去商店买」那条路）。
  const short = planGuildOrder(viewGuildOrder(surveyFor({ stock: { 日用品: 50, 海藻汁: 2 } })), { config });
  assert.equal(short.actions.length, 0, 'missing stock means no request at all');
  assert.ok(short.notes.some((note) => note.includes('海藻汁 2/6')), 'it says exactly what is short');

  // 今日已达上限 → 不交。
  const capped = planGuildOrder(viewGuildOrder(surveyFor({
    stock: { 日用品: 50, 海藻汁: 47 }, doneToday: 10, maxNum: 10,
  })), { config });
  assert.equal(capped.actions.length, 0, 'daily quota reached means no request');
  assert.ok(capped.notes.some((note) => note.includes('上限')), 'it says the daily cap was hit');

  // 没读到联盟城市 → 交单需要 cityId，跳过。
  const noCity = planGuildOrder(viewGuildOrder(surveyFor({ stock: { 日用品: 50, 海藻汁: 47 }, city: null })), { config });
  assert.equal(noCity.actions.length, 0, 'without a guild city there is no cityId to send');

  // -1 = 不限次数；配额算法本身也要对。
  assert.equal(maxOrderPerDay(config, 25), -1, 'maxNum:-1 means unlimited');
  assert.equal(orderQuota(-1, 5), Number.POSITIVE_INFINITY, 'unlimited quota stays unlimited');
  assert.equal(orderQuota(10, 3), 7, 'finite quota subtracts what was already done');
  checked += 1;
}

// 农田缺口 → 种子厂排产需求（2026-10-28）：
// 「分散铺开」要的是那些库存为 0 的作物有种子，而种子厂按 pool 顺序慢慢轮要好几天。
// 所以把农田的缺口当需求喂进 demand，让种子厂先产真正缺的那种。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '农田' }, { buildingType: '种子厂' }] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    BuildingProduceCfg: { data: [
      { buildType: '种子厂', itemId: '小麦种子', unlockLevel: 1, produceTime: 1800, costItem: [['种子', 1700]] },
      { buildType: '种子厂', itemId: '番茄种子', unlockLevel: 4, produceTime: 2400, costItem: [['种子', 2700]] },
    ] },
    FarmlandPlantCfg: { data: [
      { id: '小麦', time: 1800, produceNum: 5, material: ['小麦种子', 1] },
      { id: '番茄', time: 2400, produceNum: 5, material: ['番茄种子', 1] },
    ] },
  } };
  const surveyFor = ({ stock: stockObj = {}, seedLevel = 4, queued = [] } = {}) => {
    const stock = new Map(Object.entries(stockObj));
    const seedFactory = {
      buildingId: '1种子厂', type: '种子厂', level: seedLevel, product: [], buildFinishTime: 0,
      farm: null,
      factory: { factoryQ: queued.map((id, i) => ({ idx: i + 1, productId: id, finishTime: 0 })), finishedProducts: [] },
    };
    const farm = {
      buildingId: '1农田', type: '农田', level: 1, product: [], buildFinishTime: 0, factory: null,
      farm: { productId: '', plantAt: 0, ripeAt: 0 },
    };
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock, have: (id) => stock.get(id) ?? 0, stockCap: 50, factorySlots: 6, autoFarming: false,
      buildings: [seedFactory, farm], factories: [seedFactory],
      orders: [], produce: { reduce: 0, instant: [] },
    };
  };
  // 小麦堆到 208（不需要种子）、番茄 0（缺）→ 种子厂该产番茄种子。
  const made = planWorld(surveyFor({ stock: { 小麦: 208, 小麦种子: 50, 番茄: 0, 番茄种子: 0, 种子: 100000 } }), { config });
  const seeds = made.actions.filter((a) => a.kind === 'startProduce');
  assert.equal(seeds.length, 1, 'exactly one seed order this round');
  assert.ok(seeds[0].label.includes('番茄种子'),
    'the crop the farm is short of drives the seed factory, not the one already piling up');
  assert.equal(seeds[0].label.includes('小麦种子'), false, 'the piled-up crop does not pull more seeds');
  assert.ok(made.notes.some((note) => note.includes('番茄') && note.includes('加需求')),
    'the log says which crop pulled the seed order');

  // 作物库存够（≥40）就不该再加种子需求，种子厂回到 pool 顺序（这里小麦种子时间短，先排小麦）。
  const full = planWorld(surveyFor({ stock: { 小麦: 60, 小麦种子: 0, 番茄: 60, 番茄种子: 0, 种子: 100000 } }), { config });
  assert.equal(full.actions.some((a) => a.label.includes('番茄种子')), false,
    'a crop that is comfortably stocked must not pull extra seeds');

  // 种子厂等级不够（Lv3 < 番茄种子 Lv4）→ 不许提这个需求，否则等于给排产下假需求。
  const lowLevel = planWorld(surveyFor({ stock: { 番茄: 0, 番茄种子: 0, 种子: 100000 }, seedLevel: 3 }), { config });
  assert.equal(lowLevel.actions.some((a) => a.label.includes('番茄种子')), false,
    'a seed recipe above the factory level is never demanded');
  checked += 1;
}

// 联盟情报：按舰队战力筛事件，先领奖再把每艘空闲船各派一个事件。
// 战力比是安全线 —— 战败掉舰船耐久，宁可少打一个也别拿船去赌。
{
  const { viewRadar, planRadar, uidKey, formatRadarPlan } = await import('./radar.mjs');
  const config = { tables: {
    WorldPirateCfg: { data: [
      { type: 1, level: 1, power: 100000, showName: '海盗先锋' },
      { type: 2, level: 1, power: 900000, showName: '海盗精锐' },
    ] },
    RadarRandEventCfg: { data: [
      { eventId: 10001, type: '击退海盗', eventName: '击退{0}', eventNameParams: ['海盗'] },
      { eventId: 20001, type: '城战试探', eventName: '探查敌城', eventNameParams: [] },
      { eventId: 50001, type: '打捞宝箱', eventName: '打捞宝箱', eventNameParams: [] },
    ] },
    RadarFixedEventCfg: { data: [
      { eventId: 2, eventName: '路易斯的行踪·{0}', eventNameParams: ['2'], power: 500000 },
    ] },
    // 派兵要烧汽油（本服 500/艘）—— 维修预算必须先把这笔扣掉，否则会排出超支计划。
    WorldParamCfg: { data: [{ paramName: '情报事件消耗汽油', paramValue: 500 }] },
  } };

  const event = (over) => ({
    uid: 1, key: 'uid-1', eventId: 10001, color: 2, gridIdx: 1, state: 1,
    pirate: { type: 1, level: 1 }, refugee: null, fixed: false,
    reward: [{ id: 'GOLD', num: 100 }],
    ...over,
  });
  const surveyFor = ({ events = [], fleets = [], stock = new Map(), petrol = 1000, repairParams = new Map(), repairBelow = 0.8 } = {}) => ({
    now: 1000, level: 3, exp: 10, storedNum: 1, nextRefreshTime: 0,
    petrol, stock, events, fleets, repairParams, repairBelow,
  });
  const fleet = (over) => ({ buildingId: '1远征船', state: 1, power: 500000, durability: 2000, maxDurability: 2000, ...over });

  // 战力不够：100000 × 1.2 = 120000 > 90000，不派。
  const weak = viewRadar(surveyFor({
    events: [event({ key: 'a', uid: 11 })],
    fleets: [fleet({ power: 90000 })],
  }), { config });
  assert.equal(weak.events[0].fits, false, 'a 1.2x power margin is required before dispatching');
  assert.equal(planRadar(weak).actions.length, 0, 'no dispatch when the fleet is too weak');
  assert.ok(planRadar(weak).notes.some((note) => note.includes('打不了') || note.includes('打不过')), 'it explains why nothing was dispatched');

  // 战力够：130000 ≥ 120000，派。
  const strong = viewRadar(surveyFor({
    events: [event({ key: 'a', uid: 11 })],
    fleets: [fleet({ power: 130000 })],
  }), { config });
  const strongPlan = planRadar(strong);
  assert.equal(strongPlan.actions.length, 1, 'a strong enough fleet dispatches');
  assert.equal(strongPlan.actions[0].request, 'RadarSendFleetsRequest');
  assert.deepEqual(strongPlan.actions[0].body, { uid: 11, fleetBuildingIds: ['1远征船'] }, 'the event uid is sent back verbatim');

  // 只有 IDLE(1) 能派；修理中的船不派，但奖励照领。
  const repairing = viewRadar(surveyFor({
    events: [event({ key: 'a', uid: 11 }), event({ key: 'b', uid: 12, state: 4 })],
    fleets: [fleet({ state: 4 })],
  }), { config });
  const repairingPlan = planRadar(repairing);
  assert.equal(repairingPlan.actions.filter((a) => a.kind === 'radarDispatch').length, 0, 'a repairing fleet cannot be dispatched');
  assert.equal(repairingPlan.actions.filter((a) => a.kind === 'radarReward').length, 1, 'finished events are collected anyway');
  assert.equal(repairingPlan.actions[0].request, 'RadarGetAllRewardsRequest', 'one request collects every finished event');
  assert.equal(repairingPlan.actions[0].body && Object.keys(repairingPlan.actions[0].body).length, 0, 'the collect-all request has an empty body');

  // ---- 修船（2026-10-27）:耐久低于阈值 -> 不派兵、留在港里修满 ----
  // 事实口径全部来自客户端：RepairFleetRequest{buildingId} 无 Response、只有 IDLE 能修、
  // 花费 = ceil(缺口 × unitRepairCost) 汽油（服务端下发，不硬编码）。
  const repairParams = new Map([
    ['1远征船', { unitRepairTime: 0.2, unitRepairCost: 0.006 }],
    ['2远征船', { unitRepairTime: 0.2, unitRepairCost: 0.006 }],
  ]);
  const damaged = viewRadar(surveyFor({
    events: [event({ key: 'a', uid: 71 })],
    fleets: [
      fleet({ buildingId: '1远征船', durability: 0, maxDurability: 2000 }),
      fleet({ buildingId: '2远征船', durability: 2000, maxDurability: 2000 }),
    ],
    petrol: 100000,
    repairParams,
  }), { config, repairBelow: 0.8 });
  assert.equal(damaged.fleets[0].needRepair, true, '耐久 0/2000 低于 80%，要修');
  assert.equal(damaged.fleets[0].duraPct, 0);
  assert.equal(damaged.fleets[1].needRepair, false, '满耐久不修');
  // 2000 点缺口 × 0.006 = 12 汽油；0.2 秒/点 = 400 秒。
  assert.equal(damaged.fleets[0].repairCost, 12, '花费 = ceil(缺口 × unitRepairCost)');
  assert.equal(damaged.fleets[0].repairSeconds, 400, '时长 = 缺口 × unitRepairTime');

  const damagedPlan = planRadar(damaged, { repairBelow: 0.8 });
  const damagedDispatch = damagedPlan.actions.filter((a) => a.kind === 'radarDispatch');
  assert.equal(damagedDispatch.length, 1, '只有耐久达标的那艘去派兵');
  assert.deepEqual(damagedDispatch[0].body.fleetBuildingIds, ['2远征船'], '低耐久的船留在港里，不出去打');
  const repairAction = damagedPlan.actions.find((a) => a.kind === 'radarRepair');
  assert.ok(repairAction, '耐久低于阈值的空闲船要发维修请求');
  assert.equal(repairAction.request, 'RepairFleetRequest');
  assert.deepEqual(repairAction.body, { buildingId: '1远征船' }, '维修请求只有 buildingId（客户端同款）');
  assert.equal(repairAction.response, null, 'RepairFleetRequest 没有 Response');
  assert.equal(repairAction.transient, true, '维修失败多是汽油不足这类可恢复状态，不能被永久 rejected');
  assert.ok(String(repairAction.group).includes('1远征船'), '维修按船隔离，一条失败不连累别的船');
  assert.ok(damagedPlan.actions.indexOf(repairAction) > damagedPlan.actions.indexOf(damagedDispatch[0]),
    '派兵排在维修前面（先派，再修留下的船）');

  // 汽油不够修满就不发请求（服务端会不会「部分修」没验证过，不拿必失败请求去骚扰）。
  const poor = viewRadar(surveyFor({
    fleets: [fleet({ buildingId: '1远征船', durability: 0, maxDurability: 2000 })],
    petrol: 5,
    repairParams,
  }), { config, repairBelow: 0.8 });
  const poorPlan = planRadar(poor, { repairBelow: 0.8 });
  assert.equal(poorPlan.actions.filter((a) => a.kind === 'radarRepair').length, 0, '汽油不够修满就先不修');
  assert.ok(poorPlan.notes.some((note) => note.includes('汽油')), '要说明是汽油不够');

  // 拿不到 unitRepairCost（FleetRepairParamRequest 失败）就不修，也不瞎算花费。
  const noParam = viewRadar(surveyFor({
    fleets: [fleet({ buildingId: '1远征船', durability: 0 })],
    petrol: 100000,
  }), { config, repairBelow: 0.8 });
  const noParamPlan = planRadar(noParam, { repairBelow: 0.8 });
  assert.equal(noParamPlan.actions.filter((a) => a.kind === 'radarRepair').length, 0, '没参数不修');
  assert.ok(noParamPlan.notes.some((note) => note.includes('维修参数')), '要说明拿不到维修参数');

  // 只有 IDLE 能修：航行/战斗中修不了（客户端 _onBtnAmend 的 state == IDLE 判定）。
  const moving = viewRadar(surveyFor({
    fleets: [fleet({ buildingId: '1远征船', durability: 0, state: 2 })],
    repairParams,
  }), { config, repairBelow: 0.8 });
  assert.equal(moving.fleets[0].needRepair, true);
  assert.equal(moving.fleets[0].repairable, false, '航行中的船修不了');
  const movingPlan = planRadar(moving, { repairBelow: 0.8 });
  assert.equal(movingPlan.actions.filter((a) => a.kind === 'radarRepair').length, 0);
  assert.ok(movingPlan.notes.some((note) => note.includes('暂时修不了')), '要说明为什么没修');

  // 已经在修（repairing 有值 / state=4）的船不能重复发维修请求。
  const underRepair = viewRadar(surveyFor({
    fleets: [fleet({ buildingId: '1远征船', durability: 0, state: 4, repairing: { startTs: 1000, endTs: 1600, endDura: 2000 } })],
    repairParams,
  }), { config, repairBelow: 0.8 });
  assert.equal(underRepair.fleets[0].repairable, false, '正在修的船不重复修');
  assert.equal(planRadar(underRepair, { repairBelow: 0.8 }).actions.filter((a) => a.kind === 'radarRepair').length, 0);

  // 阈值 0 = 关掉修船（也放开了「按耐久拦派兵」，回到旧行为）。
  const repairOff = viewRadar(surveyFor({
    events: [event({ key: 'off', uid: 72 })],
    fleets: [fleet({ buildingId: '1远征船', durability: 0 })],
    petrol: 100000,
    repairParams,
  }), { config, repairBelow: 0 });
  assert.equal(repairOff.fleets[0].needRepair, false, '阈值 0 时不做耐久判断');
  const repairOffPlan = planRadar(repairOff, { repairBelow: 0 });
  assert.equal(repairOffPlan.actions.filter((a) => a.kind === 'radarRepair').length, 0, '阈值 0 = 不修船');
  assert.equal(repairOffPlan.actions.filter((a) => a.kind === 'radarDispatch').length, 1, '关掉修船后耐久低也照派（旧行为）');

  // 文本视图要把耐久与维修动作写出来，否则「这轮为什么没派兵」看不出来。
  const damagedText = formatRadarPlan(damaged, damagedPlan);
  assert.ok(damagedText.includes('舰队耐久'), '计划文本要列出每艘船的耐久');
  assert.ok(damagedText.includes('维修 1远征船'), '计划文本要有维修动作');

  // 一艘空闲船都没有时（全在航行/修理），判定要说「没空闲船」而不是「战力不够」：
  // 修船那 5 分钟里每轮都写「战力不够」看起来像配置过期了。
  const noIdle = viewRadar(surveyFor({
    events: [event({ key: 'noIdle', uid: 74 })],
    fleets: [fleet({ buildingId: '1远征船', state: 4, durability: 0, repairing: { startTs: 1, endTs: 999999, endDura: 2000 } })],
  }), { config });
  assert.equal(noIdle.events[0].verdict, '没空闲船', '没空闲船不能说成战力不够');
  assert.equal(noIdle.events[0].verdictChip, 'waiting', '船会回来的：用等待色，不是阻塞色');

  // 派兵烧的汽油要从维修预算里扣掉：汽油刚好够派兵时，维修不能照着满池汽油去排。
  assert.equal(damaged.dispatchFuel, 500, '派一艘兵烧 500 汽油（WorldParamCfg.情报事件消耗汽油）');
  const squeezed = viewRadar(surveyFor({
    events: [event({ key: 's', uid: 73 })],
    fleets: [
      fleet({ buildingId: '1远征船', durability: 2000, maxDurability: 2000 }),
      fleet({ buildingId: '2远征船', durability: 0, maxDurability: 2000 }),
    ],
    petrol: 400, // 连派兵那 500 都不够，扣完维修预算就是 0
    repairParams,
  }), { config, repairBelow: 0.8 });
  const squeezedPlan = planRadar(squeezed, { repairBelow: 0.8 });
  assert.equal(squeezedPlan.actions.filter((a) => a.kind === 'radarDispatch').length, 1, '耐久达标的船照派');
  assert.equal(squeezedPlan.actions.filter((a) => a.kind === 'radarRepair').length, 0,
    '汽油被派兵占掉后不够修满，就不能排维修');
  assert.ok(squeezedPlan.notes.some((note) => note.includes('扣掉派兵')), 'note 要说明汽油被派兵占了一部分');

  // 排序：颜色高的优先（紫 4 > 蓝 3 > 绿 2）；同色才看战力需求。
  const mixed = viewRadar(surveyFor({
    events: [
      event({ key: 'green', uid: 21, color: 2 }),
      event({ key: 'purple', uid: 22, color: 4 }),
    ],
    fleets: [fleet({ power: 500000 })],
  }), { config });
  assert.equal(planRadar(mixed).actions[0].body.uid, 22, 'the purple event outranks the green one');

  // 固定事件（eventId < 10000）派兵时不带 uid，战力查 RadarFixedEventCfg。
  const fixedView = viewRadar(surveyFor({
    events: [event({ key: 'fixed', uid: 31, eventId: 2, fixed: true, pirate: null })],
    fleets: [fleet({ power: 700000 })],
  }), { config });
  assert.equal(fixedView.events[0].enemyPower, 500000, 'a fixed event reads its power from RadarFixedEventCfg');
  assert.deepEqual(planRadar(fixedView).actions[0].body, { fleetBuildingIds: ['1远征船'] }, 'fixed events are dispatched without a uid');

  // 编码层再确认一次：不带 uid 时 payload 不能出现 field 1（tag 0x08）。
  // 如果哪天有人给固定事件的 body 补个 uid:0，服务端会把它当「uid=0 的事件」而不是当前固定事件。
  const payloadOf = (body) => {
    const frame = codec.encode('RadarSendFleetsRequest', 1, body);
    const headerLen = HEADER_PREFIX + 'RadarSendFleetsRequest'.length + 1;
    return Buffer.from(frame.slice(headerLen)).toString('hex');
  };
  assert.equal(payloadOf({ fleetBuildingIds: ['1远征船'] }).startsWith('08'), false,
    '固定事件派兵不能带 uid 字段');
  assert.equal(payloadOf({ uid: 141943664636524, fleetBuildingIds: ['1远征船'] }).startsWith('08'), true,
    '随机事件派兵必须带 uid 字段');

  // 难民事件要材料：材料不齐就不派（派了也只会被判失败）。
  const refugee = viewRadar(surveyFor({
    events: [event({
      key: 'refugee', uid: 41, eventId: 60001, pirate: null,
      refugee: { requirements: [{ id: '生鱼片', num: 2 }] },
    })],
    fleets: [fleet({ power: 500000 })],
    stock: new Map([['生鱼片', 1]]),
  }), { config });
  assert.equal(refugee.events[0].dispatchable, false, 'a refugee event waits until the goods are in stock');

  // 多艘空闲船：每艘各派一个事件，不重复派同一个，强船先挑（难的留给它）。
  const twoFleets = viewRadar(surveyFor({
    events: [
      event({ key: 'easy', uid: 51, color: 2 }), // 敌方 100000 → 需 120000
      event({ key: 'hard', uid: 52, color: 4, pirate: { type: 2, level: 1 } }), // 敌方 900000 → 需 1080000
      event({ key: 'mid', uid: 53, color: 3 }),
    ],
    fleets: [
      fleet({ buildingId: '1远征船', power: 2000000 }),
      fleet({ buildingId: '2远征船', power: 300000 }),
    ],
  }), { config });
  const dispatches = planRadar(twoFleets).actions.filter((a) => a.kind === 'radarDispatch');
  assert.equal(dispatches.length, 2, 'two idle fleets => two dispatches');
  assert.deepEqual(dispatches.map((a) => a.body.fleetBuildingIds[0]), ['1远征船', '2远征船'],
    'the strongest fleet picks first');
  assert.deepEqual(dispatches.map((a) => a.body.uid), [52, 53],
    'the strong fleet takes the hardest event, the weak one the next it can win');
  assert.equal(new Set(dispatches.map((a) => a.group)).size, 2, 'each fleet gets its own failure group');
  assert.equal(planRadar(twoFleets, { maxDispatch: 1 }).actions.filter((a) => a.kind === 'radarDispatch').length, 1,
    'maxDispatch still caps how many fleets go out');

  // 船比事件多：只派事件数那么多，并说明剩下的船为什么没派。
  const moreFleets = viewRadar(surveyFor({
    events: [event({ key: 'only', uid: 61 })],
    fleets: [fleet({ buildingId: '1远征船', power: 500000 }), fleet({ buildingId: '2远征船', power: 400000 })],
  }), { config });
  assert.equal(planRadar(moreFleets).actions.filter((a) => a.kind === 'radarDispatch').length, 1,
    'one event can only take one fleet');
  assert.ok(planRadar(moreFleets).notes.length > 0, 'leftover fleets are explained in notes');

  // uid 的 int64 形状：{low, high} 与数字必须归一到同一个 key，否则去重会失效。
  assert.equal(uidKey({ low: -709528980, high: 33048 }), uidKey(141943664636524), 'int64 uid keys must match the numeric form');

  // 固定事件排在随机事件前面：它没有 color（恒 0），按颜色排会永远垫底；
  // 空闲船少于事件数时垫底 = 永远轮不到（实测「路易斯的行踪」一次都没被打过）。
  const orderFixed = viewRadar(surveyFor({
    events: [
      event({ key: 'purple', uid: 71, color: 4 }),
      event({ key: 'boss', uid: undefined, eventId: 2, fixed: true, pirate: null }),
    ],
    fleets: [fleet({ power: 700000 })],
  }), { config });
  const orderPlan = planRadar(orderFixed).actions.filter((a) => a.kind === 'radarDispatch');
  assert.equal(orderPlan.length, 1, 'one idle fleet => one dispatch');
  assert.deepEqual(orderPlan[0].body, { fleetBuildingIds: ['1远征船'] },
    '固定事件优先于颜色更高的随机事件（不带 uid 派兵 = 选中固定事件）');

  // ---- 事件打光后「睡到刷新」：这段时间一次请求都不发 ----
  // radarIdleUntil 返回 0 = 按常规间隔（60 秒）再来；返回时间戳 = 到那时才值得再探。
  // 只有「确实无事可做」才敢睡，任何一件事能做都必须回来 —— 否则挂机会一直睡着不干活。
  const { radarIdleUntil } = await import('./radar.mjs');
  const NOW = 1000 * 1000; // 毫秒
  const refreshIn = (sec) => Math.floor(NOW / 1000) + sec;
  const idleView = (over = {}) => viewRadar(surveyFor({
    events: [], fleets: [fleet()], ...over,
  }), { config });
  assert.equal(radarIdleUntil(idleView({ events: [] }), { nowMs: NOW }), 0,
    'nextRefreshTime 没给（0）就不敢睡，只能照常轮询');

  const quiet = { ...idleView({ events: [] }), nextRefreshTime: refreshIn(6 * 3600) };
  const sleepAt = radarIdleUntil(quiet, { nowMs: NOW });
  assert.ok(sleepAt > NOW, '事件打光 + 船全在港 → 睡到刷新点');
  assert.equal(sleepAt, refreshIn(6 * 3600) * 1000 + 5000, '刷新时刻 + 5 秒余量（早探只会白拿空列表）');

  // 有 state=1 的事件（哪怕战力不够打不了）就不能睡：材料是工厂现产、战力会变。
  const hasEvent = { ...quiet, events: viewRadar(surveyFor({
    events: [event({ key: 'a', uid: 11 })],
    fleets: [fleet({ power: 90000 })], // 打不过，但事件还挂着
  }), { config }).events };
  assert.equal(radarIdleUntil(hasEvent, { nowMs: NOW }), 0, '还有打不了的事件挂着，不能睡到刷新');

  // 待领奖也不能睡：奖励不领不会自己进包。
  const hasReward = { ...quiet, rewards: [{ key: 'r' }] };
  assert.equal(radarIdleUntil(hasReward, { nowMs: NOW }), 0, '有奖没领就得回来');

  // 船在外面（航行/战斗/修理）也不能睡：回来就能接着打。
  for (const state of [2, 3, 4, 5]) {
    const out = viewRadar(surveyFor({ events: [], fleets: [fleet({ state })] }), { config });
    assert.equal(radarIdleUntil({ ...out, nextRefreshTime: refreshIn(3600) }, { nowMs: NOW }), 0,
      `fleet state ${state} 的船在外面，回来要接着派，不能睡`);
  }

  // 有船该修却没修（汽油不够）也不能睡：可能下一轮汽油就够了。
  const needFix = viewRadar(surveyFor({
    events: [],
    fleets: [fleet({ durability: 0, maxDurability: 2000 })],
    petrol: 5,
    repairParams,
  }), { config, repairBelow: 0.8 });
  assert.equal(radarIdleUntil({ ...needFix, nextRefreshTime: refreshIn(3600) }, { nowMs: NOW }), 0,
    '有船等着修，不能睡');

  // 刷新时刻已经过点（服务端已刷 / 时钟偏差）也不睡，正常探测。
  assert.equal(radarIdleUntil({ ...quiet, nextRefreshTime: Math.floor(NOW / 1000) - 1 }, { nowMs: NOW }), 0,
    '刷新时间已过 → 立刻探一次');
  checked += 1;
}

// 固定事件在第 6 个字段 fixedEvent，不在 events 里 —— 只遍历 events 会把它整条丢掉。
// 这是「情报联盟不执行路易斯的行踪」的根因，必须有断言钉住。
{
  const { surveyRadar, viewRadar: view, planRadar: plan, formatRadarPlan } = await import('./radar.mjs');
  const config = { tables: {
    WorldPirateCfg: { data: [] },
    RadarRandEventCfg: { data: [
      { eventId: 10001, type: '击退海盗', eventName: '击退{0}', eventNameParams: ['海盗'] },
    ] },
    // RadarFixedEventCfg.reward 是 [[id, num]] 对子，不是回包的 {asset:[{id,num}]} 形状。
    RadarFixedEventCfg: { data: [
      { eventId: 11, eventName: '路易斯的行踪·{0}', eventNameParams: [11], power: 371500,
        reward: [['波雅碎片', 3], ['汽油', 1400]] },
      { eventId: 12, eventName: '路易斯的行踪·{0}', eventNameParams: [12], power: 400000,
        reward: [['汽油', 100]] },
    ] },
  } };

  const protocol = {
    RadarInfoRequest: {}, RadarInfoResponse: {},
    MyFleetsRequest: {}, MyFleetsResponse: {},
  };
  const mockClient = (fixedEvent, extraEvents = []) => ({
    request: async (name) => (name === 'RadarInfoRequest'
      ? { radarInfo: {
        level: 5, exp: 0, storedNum: 0, nextRefreshTime: 0,
        events: extraEvents, fixedEvent,
      } }
      : { fleets: [{ buildingId: '1远征船', state: 1, power: 681875 }] }),
  });

  const survey = await surveyRadar(
    mockClient({ eventId: 11, gridIdx: 93979, state: 1 }),
    protocol,
    { config, stock: new Map([['汽油', 5000]]) },
  );
  assert.equal(survey.events.length, 1, 'fixedEvent 必须被并进 events（否则整条看不见）');
  assert.equal(survey.events[0].eventId, 11);
  assert.equal(survey.events[0].fixed, true, '来自 fixedEvent 字段的事件必须标 fixed');
  assert.equal(survey.events[0].key, 'fixed:11:93979', '固定事件没有 uid，key 用 eventId+格位兜底');
  assert.deepEqual(survey.events[0].reward, [{ id: '波雅碎片', num: 3 }, { id: '汽油', num: 1400 }],
    '固定事件回包不带奖励，从 RadarFixedEventCfg 的 [[id,num]] 补');

  const fixedView = view(survey, { config });
  assert.equal(fixedView.events[0].name, '路易斯的行踪·11', '名字按固定事件表渲染');
  assert.equal(fixedView.events[0].type, '固定事件');
  assert.equal(fixedView.events[0].enemyPower, 371500, '战力查 RadarFixedEventCfg');
  assert.equal(fixedView.events[0].fits, true, '681875 >= 371500 × 1.2');
  assert.equal(fixedView.events[0].dispatchable, true);

  const fixedPlan = plan(fixedView);
  assert.deepEqual(fixedPlan.actions[0].body, { fleetBuildingIds: ['1远征船'] },
    '固定事件派兵不带 uid（客户端 isFixed() 分支）');

  // 固定事件换了一个 eventId（不同难度）时 key 必须跟着变，否则新事件会被当成旧的跳过。
  const other = await surveyRadar(
    mockClient({ eventId: 12, gridIdx: 93979, state: 1 }),
    protocol,
    { config, stock: new Map([['汽油', 5000]]) },
  );
  assert.notEqual(other.events[0].key, survey.events[0].key, '不同固定事件不能共用同一个 key');

  // events 与 fixedEvent 同时存在时两者都要在，固定事件排在最后（只影响列表顺序，不影响计划优先级）。
  const both = await surveyRadar(
    mockClient({ eventId: 11, gridIdx: 93979, state: 1 }, [{ uid: 90001, eventId: 10001, color: 2, gridIdx: 5, state: 1 }]),
    protocol,
    { config, stock: new Map([['汽油', 5000]]) },
  );
  assert.equal(both.events.length, 2, '随机事件与固定事件要同时出现');
  assert.equal(both.events.filter((one) => one.fixed).length, 1, '只有一个固定事件');

  // 没有 fixedEvent（刷新期/未开放）时不能凭空造一个 state=1 的假事件去派兵。
  const noFixed = await surveyRadar(mockClient(null), protocol, { config, stock: new Map() });
  assert.equal(noFixed.events.length, 0, 'fixedEvent 缺失时不补假事件');

  // eventId 缺省的畸形条目（protobuf 默认 0）必须被丢掉：`0 < 10000` 会把它当固定事件，
  // 而固定事件派兵不带 uid，等于拿一条空数据去打。
  const junk = await surveyRadar(
    mockClient(null, [{ eventId: 0, state: 1 }]),
    protocol,
    { config, stock: new Map() },
  );
  assert.equal(junk.events.length, 0, 'eventId<=0 的畸形事件要被过滤掉');

  // 固定事件已经派出去时不能再派：除了 state 变 3，客户端还有 startTime>0 这个信号
  // （isBatting() = startTime>0 && (isPirate || isFixed)）。state 推送有延迟时靠它兜住。
  const batting = await surveyRadar(
    mockClient({ eventId: 11, gridIdx: 93979, state: 1, startTime: 1761360000 }),
    protocol,
    { config, stock: new Map() },
  );
  const battingView = view(batting, { config });
  assert.equal(battingView.events[0].state, 1, 'state 还没更新');
  assert.equal(battingView.events[0].dispatchable, false, 'startTime>0 表示我方已在打，不能再派一艘');
  assert.equal(plan(battingView).actions.filter((a) => a.kind === 'radarDispatch').length, 0,
    'startTime>0 的固定事件不会被重复派兵');
  assert.ok(formatRadarPlan(battingView, plan(battingView)).includes('[已派兵]'),
    '已派出去的固定事件要显示「已派兵」，不能写成「材料不齐」');
  assert.ok(!plan(battingView).notes.some((note) => note.includes('打不了') || note.includes('打不过')),
    '它不该混进「打不了」的清单');
  assert.ok(plan(battingView).notes.some((note) => note.includes('已经派舰队去打')), '要说清它在打');

  // 配置表没跟上游戏版本（固定事件 eventId 查不到）时不能按「无需战斗」放行：
  // power=0 会让 need=0、fits 恒真，等于闭着眼派船去打，输了要修船。
  const unknownCfg = await surveyRadar(
    mockClient({ eventId: 99, gridIdx: 12345, state: 1 }),
    protocol,
    { config, stock: new Map() },
  );
  const unknownView = view(unknownCfg, { config });
  assert.equal(unknownView.events[0].powerUnknown, true, '配置里查不到战力要标出来');
  assert.equal(unknownView.events[0].dispatchable, false, '查不到战力就不能派');
  assert.equal(plan(unknownView).actions.filter((a) => a.kind === 'radarDispatch').length, 0,
    '不会盲派一个战力未知的固定事件');
  assert.ok(plan(unknownView).notes.some((note) => note.includes('配置里查不到战力')), '要说明原因');
  assert.ok(formatRadarPlan(unknownView, plan(unknownView)).includes('[配置过期]'), '状态行写「配置过期」');

  // 固定事件打成 state=4 时走一键全领（固定事件没有 uid，领单条用不了）。
  const done = await surveyRadar(
    mockClient({ eventId: 11, gridIdx: 93979, state: 4 }),
    protocol,
    { config, stock: new Map() },
  );
  const donePlan = plan(view(done, { config }));
  assert.equal(donePlan.actions[0].request, 'RadarGetAllRewardsRequest', '固定事件完成后靠一键全领收奖励');
  assert.equal(donePlan.actions.filter((a) => a.kind === 'radarDispatch').length, 0, 'state=4 不再派兵');
  checked += 1;
}

// 装备厂（锻造）：造好了先收，收完按部位件数最少的排下一件。
// 英雄每个部位只能穿一件，所以三个部位的「可分配库存」（背包 + 打造中）必须成套。
{
  const { planEquip, pickRecipe, countByType } = await import('./equip.mjs');
  const config = { tables: {
    EquipCfg: { data: [
      { id: '蓝武器1', type: '武器', qualityIndex: 2, qualityName: '蓝' },
      { id: '蓝武器2', type: '武器', qualityIndex: 2, qualityName: '蓝' },
      { id: '紫武器1', type: '武器', qualityIndex: 3, qualityName: '紫' },
      { id: '蓝防具1', type: '防具', qualityIndex: 2, qualityName: '蓝' },
      { id: '蓝饰品1', type: '饰品', qualityIndex: 2, qualityName: '蓝' },
    ] },
    EquipMakeLibCfg: { data: [
      { libId: 1001, equipId: '蓝武器1', rate: 100 },
      { libId: 1001, equipId: '蓝武器2', rate: 100 },
      { libId: 1002, equipId: '紫武器1', rate: 100 },
      { libId: 2001, equipId: '蓝防具1', rate: 100 },
      { libId: 3001, equipId: '蓝饰品1', rate: 100 },
    ] },
    BuildingEquipMakeCfg: { data: [
      { makeId: 1001, type: '武器', libId: 1001, seconds: 1800, season: 1, costItem: [['蓝武器材料', 40], ['GOLD', 2000]] },
      { makeId: 1002, type: '武器', libId: 1002, seconds: 7200, season: 1, costItem: [['紫武器材料', 160], ['GOLD', 10000]] },
      { makeId: 2001, type: '防具', libId: 2001, seconds: 1800, season: 1, costItem: [['蓝防具材料', 40], ['GOLD', 2000]] },
      { makeId: 3001, type: '饰品', libId: 3001, seconds: 1800, season: 1, costItem: [['蓝饰品材料', 40], ['GOLD', 2000]] },
    ] },
  } };
  const equipIndex = new Map(config.tables.EquipCfg.data.map((equip) => [equip.id, equip]));
  const rich = new Map([
    ['蓝武器材料', 400], ['紫武器材料', 160], ['蓝防具材料', 400], ['蓝饰品材料', 400], ['GOLD', 100_000],
  ]);
  const surveyFor = (over = {}) => ({
    now: 1000,
    building: { buildingId: '1装备厂', level: 1 },
    making: null,
    bag: [],
    counts: { 武器: 0, 防具: 0, 饰品: 0 },
    stock: rich,
    ...over,
  });

  // 没有装备厂（新号没造）时不能乱发请求。
  const none = planEquip({ building: null, making: null, bag: [], counts: {}, stock: rich }, { config });
  assert.equal(none.actions.length, 0, '没有装备厂就不锻造');
  assert.ok(none.notes.some((note) => note.includes('没有装备厂')));

  // 同一时间只能造一件：还在造就只提示，不排第二件（客户端也是这一步直接弹「正在锻造」）。
  const busy = planEquip(surveyFor({
    making: { makeId: 3001, equipId: '蓝饰品1', star: 0, finishTime: 2000, remainSeconds: 1000, done: false },
  }), { config });
  assert.equal(busy.actions.length, 0, '正在锻造时不再排产');
  assert.ok(busy.notes.some((note) => note.includes('还在锻造')), '要说清它还在造');

  // 造好了：先收取，再排下一件。两个动作同一轮做，共用一个失败隔离组。
  const done = planEquip(surveyFor({
    making: { makeId: 3001, equipId: '蓝饰品1', star: 0, finishTime: 500, remainSeconds: 0, done: true },
    counts: { 武器: 0, 防具: 0, 饰品: 1 },
  }), { config });
  assert.equal(done.actions.length, 2, '收取 + 排产两条动作');
  assert.equal(done.actions[0].kind, 'equipPick');
  assert.equal(done.actions[0].request, 'PickMadeEquipRequest');
  assert.equal(done.actions[0].response, 'PickMadeEquipResponse', '收取有配套回包');
  assert.deepEqual(done.actions[0].body, { buildingId: '1装备厂' }, '收取只要 buildingId');
  assert.equal(done.actions[1].kind, 'equipMake');
  assert.equal(done.actions[1].request, 'MakeEquipRequest');
  assert.equal(done.actions[1].response, null, '锻造没有配套回包，走 sendWatch');
  assert.equal(done.actions[1].body.universal, false, '不自动兑换材料（universal 恒 false）');
  assert.equal(done.actions[0].group, done.actions[1].group, '收取失败要能停掉同一轮的排产');

  // 部位均衡：武器 10 件、防具 3 件、饰品 5 件 → 补防具。
  const lopsided = planEquip(surveyFor({ counts: { 武器: 10, 防具: 3, 饰品: 5 } }), { config });
  assert.equal(lopsided.actions.find((action) => action.kind === 'equipMake').body.makeId, 2001,
    '件数最少的部位优先（防具）');

  // 件数相同时按固定顺序轮转（武器 → 防具 → 饰品），这样造完一件就自然轮到下一个部位。
  // 同为武器时再看品质：紫材料够就造紫装，所以这里是 1002 而不是 1001。
  const even = planEquip(surveyFor({ counts: { 武器: 3, 防具: 3, 饰品: 3 } }), { config });
  const evenMake = even.actions.find((action) => action.kind === 'equipMake');
  assert.equal(evenMake.body.makeId >= 1001 && evenMake.body.makeId < 2000, true,
    '件数一样时先武器部位（部位内紫装优先，所以是 1002）');

  // 部位内先试品质高的：紫材料够就造紫装，不够才降到蓝装。
  const purple = planEquip(surveyFor({ counts: { 武器: 0, 防具: 5, 饰品: 5 } }), { config });
  assert.equal(purple.actions.find((action) => action.kind === 'equipMake').body.makeId, 1002,
    '材料够时先造品质高的配方');
  const noPurple = planEquip(surveyFor({
    counts: { 武器: 0, 防具: 5, 饰品: 5 },
    stock: new Map([['蓝武器材料', 40], ['GOLD', 2000]]),
  }), { config });
  assert.equal(noPurple.actions.find((action) => action.kind === 'equipMake').body.makeId, 1001,
    '紫材料不够就降到蓝装');

  // 三个部位都没材料：不排产，但把原因说清楚（造好的那件仍然要收）。
  const broke = planEquip(surveyFor({
    making: { makeId: 3001, equipId: '蓝饰品1', star: 0, finishTime: 500, remainSeconds: 0, done: true },
    stock: new Map([['GOLD', 10]]),
  }), { config });
  assert.equal(broke.actions.filter((action) => action.kind === 'equipMake').length, 0, '没材料就不排产');
  assert.equal(broke.actions.filter((action) => action.kind === 'equipPick').length, 1, '但造好的照样收');
  assert.ok(broke.notes.some((note) => note.includes('材料够造下一件')), '要说明为什么没排产');

  // 计件口径：背包 + 打造中。打造中的那件已经算进去了，否则会同一部位连造两件。
  const counts = countByType(
    equipIndex,
    [{ equipId: '蓝武器1' }, { equipId: '蓝武器2' }, { equipId: '蓝防具1' }],
    { equipId: '蓝饰品1' },
  );
  assert.deepEqual(counts, { 武器: 2, 防具: 1, 饰品: 1 }, '背包 + 打造中一起算');

  // 金币不够时不能造（GOLD 在资源表里，跟材料合并成一张 stock 才查得到）。
  const noGold = pickRecipe(config, { 武器: 0, 防具: 9, 饰品: 9 }, new Map([
    ['蓝武器材料', 400], ['GOLD', 100],
  ]));
  assert.equal(noGold, null, '材料够但金币不够也不造');
  checked += 1;
}

// 海兽培育室：成熟的一次领走，队列空位按「材料够的里面品质最高」排满。
// 三条判据都照客户端 PetBreedView._onBtnBreed：队列位为空 + 基因够 + 金币够。
{
  const { planPet, pickRecipes, breedBuildingsOf, recipesOf, petSpeedSeconds } = await import('./pet.mjs');
  const config = { tables: {
    // 材料加速一次减多少秒：客户端 PetUtil.breedSpeedSeconds() 读的就是这一行。
    PetParamCfg: { data: [{ paramName: '投喂减少培育时间', paramValue: 14400 }] },
    PetSpeciesCfg: { data: [{ spId: 1, name: '声波海豚' }, { spId: 2, name: '铁炮鲨鱼' }] },
    PetBreedCfg: { data: [
      { petId: '蓝宠物1', spId: 1, quality: 'BLUE', qualityIndex: 1, breedTime: 14400, season: 1, cost: [['宠物1蓝基因', 80], ['GOLD', 4000]] },
      { petId: '紫宠物1', spId: 1, quality: 'PURPLE', qualityIndex: 2, breedTime: 43200, season: 1, cost: [['宠物1紫基因', 400], ['GOLD', 20000]] },
      { petId: '橙宠物1', spId: 1, quality: 'ORANGE', qualityIndex: 3, breedTime: 129600, season: 1, cost: [['宠物1橙基因', 800], ['GOLD', 250000]] },
      { petId: '蓝宠物2', spId: 2, quality: 'BLUE', qualityIndex: 1, breedTime: 14400, season: 1, cost: [['宠物2蓝基因', 80], ['GOLD', 4000]] },
      { petId: '红宠物1', spId: 1, quality: 'RED', qualityIndex: 4, breedTime: 259200, season: 2, cost: [['宠物1红基因', 1200], ['GOLD', 1000000]] },
    ] },
    BuildingCfg: { data: [{ buildingType: '宠物培育室' }, { buildingType: '装备厂' }] },
  } };
  const recipes = recipesOf(config);
  const building = (over = {}) => ({ buildingId: '1宠物培育室', level: 2, maxQ: 2, jobs: [], mature: [], ...over });
  const surveyFor = (over = {}) => ({
    now: 1000,
    buildings: [building()],
    recipes,
    mature: [],
    jobs: [],
    maxQ: 2,
    stock: new Map([
      ['宠物1蓝基因', 800], ['宠物1紫基因', 400], ['宠物2蓝基因', 800],
      ['宠物1橙基因', 800], ['宠物1红基因', 1200], ['GOLD', 100_000],
    ]),
    config,
    ...over,
  });

  // 没有培育室（新号还没造）时不能乱发请求。
  const none = planPet({ buildings: [], recipes, mature: [], jobs: [], maxQ: 0, stock: new Map() }, { config });
  assert.equal(none.actions.length, 0, '没有培育室就不排产');
  assert.ok(none.notes.some((note) => note.includes('宠物培育室')), '要说清缺的是什么建筑');

  // maxQLength=0 = 队列还没开（建筑没建成），这时排产必然被拒，所以只写原因。
  const locked = planPet(surveyFor({ buildings: [building({ maxQ: 0, level: 0 })], maxQ: 0 }), { config });
  assert.equal(locked.actions.length, 0, '队列没开就不发培育请求');
  assert.ok(locked.notes.some((note) => note.includes('maxQLength=0')), '要说明是队列没开');

  // 成熟的先领：GetMaturePetRequest 没有 body，一次领全部。
  const mature = planPet(surveyFor({
    mature: [{ petId: '蓝宠物1', star: 2, buildingId: '1宠物培育室' }],
  }), { config });
  const pick = mature.actions.find((action) => action.kind === 'petPick');
  assert.ok(pick, '有成熟海兽就要收');
  assert.equal(pick.request, 'GetMaturePetRequest');
  assert.equal(pick.response, null, '领取没有配套回包，走 sendWatch');
  assert.deepEqual(pick.body, {}, '空体请求：一次领走全部成熟海兽');
  assert.equal(pick.items[0][0], '蓝声波海豚', 'items 用中文名，日志里能直接读');

  // 队列空位排产：品质从高到低。金币 10 万 → 橙要 25 万排不了，紫够 → 排紫。
  const breed = planPet(surveyFor(), { config });
  const made = breed.actions.filter((action) => action.kind === 'petBreed');
  assert.equal(made.length, 2, 'maxQ=2 且材料够 → 一次排满两个空位');
  assert.equal(made[0].body.petId, '紫宠物1', '有紫基因就先排紫（品质从高到低）');
  assert.equal(made[0].body.universal, false, '不自动用万能基因兑换（universal 恒 false）');
  assert.equal(made[0].request, 'PetBreedRequest');
  assert.equal(made[0].response, null, '培育没有配套回包，走 sendWatch');
  assert.notEqual(made[0].key, made[1].key, '同一批多条动作的 key 不能退化成同一个');
  assert.equal(made[1].body.petId, '蓝宠物1', '第二个空位排下一个够材料的（同品质按 spId 升序）');

  // 品质上限把红挡在外面：红要 season 2 + 100 万金币，默认不碰。
  const richStock = () => new Map([['宠物1橙基因', 800], ['宠物1红基因', 1200], ['GOLD', 2_500_000]]);
  const capped = pickRecipes(config, { stock: richStock(), limit: 1 });
  assert.equal(capped[0].petId, '橙宠物1', '默认上限是橙，红不排');
  const redAllowed = pickRecipes(config, { stock: richStock(), limit: 1, maxQuality: 'RED' });
  assert.equal(redAllowed[0].petId, '红宠物1', '显式放开上限才会排红');

  // 扣减要生效：同一批里不能把同一批基因算两遍（800 蓝基因只够 10 个蓝，但金币只够 1 个紫）。
  const tight = pickRecipes(config, {
    stock: new Map([['宠物1紫基因', 400], ['宠物1蓝基因', 100], ['GOLD', 20_000]]),
    limit: 2,
  });
  assert.equal(tight.length, 1, '紫排完之后金币见底，第二个空位排不了');
  assert.equal(tight[0].petId, '紫宠物1');

  // 队列满 + 已排队的不重复排。
  const full = planPet(surveyFor({
    buildings: [building({ maxQ: 1, jobs: [{ idx: 1, petId: '蓝宠物2', star: 0, finishTime: 9999, remainSeconds: 8999, done: false, feed: [] }] })],
    jobs: [{ idx: 1, petId: '蓝宠物2', star: 0, finishTime: 9999, remainSeconds: 8999, buildingId: '1宠物培育室' }],
    maxQ: 1,
  }), { config });
  assert.equal(full.actions.length, 0, '队列满就不排');
  assert.ok(full.notes.some((note) => note.includes('队列满')), '要说清是队列满不是材料不够');

  // 建筑识别：只有「宠物培育室」算培育室，装备厂和其它建筑都不算。
  const picked = breedBuildingsOf([
    { buildingId: '1装备厂', type: '装备厂', level: 3, petBreed: { breedQ: [], maturePets: [], maxQLength: 0 } },
    { buildingId: '1宠物培育室', type: '宠物培育室', level: 2, petBreed: { breedQ: [], maturePets: [{ petId: '蓝宠物1', star: 1 }], maxQLength: 3 } },
  ], config, { now: 1000 });
  assert.equal(picked.length, 1, '只挑培育室');
  assert.equal(picked[0].maxQ, 3, 'maxQLength 以服务端给的为准，不按等级猜');
  assert.deepEqual(picked[0].mature, [{ petId: '蓝宠物1', star: 1 }]);

  // 材料加速（投喂，2026-10-26 新增，页面勾选默认开）：
  // `PetFeedRequest{jobIdx}` 消耗该队列位的 feedRequirements，把剩余时间往前推
  // PetParamCfg「投喂减少培育时间」（本服 14400 = 4 小时）。判据照客户端 `_onBtnFood`。
  assert.equal(petSpeedSeconds(config), 14400, '加速秒数从 PetParamCfg 读');
  assert.equal(petSpeedSeconds({ tables: {} }), 14400, '配置缺失时回兜底的 4 小时');
  const feeding = (over = {}) => ({
    idx: 1, petId: '蓝宠物1', star: 0, finishTime: 9000, remainSeconds: 8000, done: false,
    feed: [{ id: '烤鱼', num: 40 }, { id: '粗铁', num: 4 }],
    ...over,
  });
  const feedSurvey = (job, extra = {}) => surveyFor({
    buildings: [building({ maxQ: 3, jobs: [job] })],
    jobs: [{ ...job, buildingId: '1宠物培育室' }],
    maxQ: 3,
    stock: new Map([['烤鱼', 100], ['粗铁', 100], ['宠物1蓝基因', 800], ['GOLD', 100_000]]),
    ...extra,
  });
  const feedActions = (plan) => plan.actions.filter((action) => action.kind === 'petFeed');
  const fed = planPet(feedSurvey(feeding()), { config });
  const feedAction = feedActions(fed)[0];
  assert.ok(feedAction, '默认就带材料加速（勾选默认开）');
  assert.equal(feedAction.request, 'PetFeedRequest');
  assert.equal(feedAction.response, null, '投喂没有配套回包，走 sendWatch');
  assert.deepEqual(feedAction.body, { jobIdx: 1 }, '按队列位 idx 投喂');
  assert.equal(feedAction.transient, true, '投喂失败多是瞬时状态，不能记进 rejected 永远跳过');
  // 剩余比一次的减免还短 → 一次就完工（别写成「减 4 小时」让人以为多扣了）。
  assert.ok(feedAction.label.includes('一次就完工'), `剩 8000 秒（<4 小时）应写「一次就完工」，实际：${feedAction.label}`);
  const longJob = feedActions(planPet(feedSurvey(feeding({ remainSeconds: 40000, finishTime: 41000 })), { config }))[0];
  assert.ok(longJob.label.includes('减 4.0 小时'), `剩 11 小时时要写清减多少，实际：${longJob.label}`);
  // key 必须随 finishTime 变，否则同一个队列位喂第二次会被上一次的失败记录挡住。
  const fedAgain = feedActions(planPet(feedSurvey(feeding({ finishTime: 7000 })), { config }))[0];
  assert.notEqual(fedAgain.key, feedAction.key, 'key 带 finishTime，喂完再来一次是新 key');
  // 勾掉就一个投喂动作都没有（页面「材料加速」不勾的情况）。
  assert.equal(feedActions(planPet(feedSurvey(feeding()), { config, allowFeed: false })).length, 0,
    '关掉材料加速就不投喂');
  // 材料不齐：跳过并说明缺什么（客户端那里会弹「购买补齐」，我们不买）。
  const poor = planPet(feedSurvey(feeding(), {
    stock: new Map([['烤鱼', 10], ['粗铁', 4], ['宠物1蓝基因', 800], ['GOLD', 100_000]]),
  }), { config });
  assert.equal(feedActions(poor).length, 0, '材料不够不投喂');
  assert.ok(poor.notes.some((note) => note.includes('材料不够加速') && note.includes('烤鱼×30')),
    `要说清缺什么，实际：${poor.notes.join(' / ')}`);
  // 剩不到 5 分钟不喂：材料是真花掉的，下一轮本来就收了。
  assert.equal(feedActions(planPet(feedSurvey(feeding({ remainSeconds: 120 })), { config })).length, 0,
    '剩 2 分钟不喂');
  // 已经到点的先收，不喂。
  assert.equal(feedActions(planPet(feedSurvey(feeding({ remainSeconds: 0, done: true, finishTime: 999 })), { config })).length, 0,
    '到点了不喂，等 GetMaturePet 收');
  // 余额跨队列位共享：两个位各要 40 烤鱼但只有 40 → 只喂一个，不能各算一遍。
  const twoJobs = [feeding({ idx: 1 }), feeding({ idx: 2, finishTime: 9500 })];
  const shared = planPet(surveyFor({
    buildings: [building({ maxQ: 3, jobs: twoJobs })],
    jobs: twoJobs.map((job) => ({ ...job, buildingId: '1宠物培育室' })),
    maxQ: 3,
    stock: new Map([['烤鱼', 40], ['粗铁', 8], ['宠物1蓝基因', 800], ['GOLD', 100_000]]),
  }), { config });
  assert.equal(feedActions(shared).length, 1, '同一批材料不能给两个队列位各算一遍');
  checked += 1;
}

// 材料不齐时用自选包兜底：SelectPackRequest 的 num 是「要换到的数量」，
// 兑换动作必须排在用到它的动作之前，且不能把包一次性烧光。
{
  const { planWorld, stepKey } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [] },
    BuildingProduceCfg: { data: [] },
    BuildingUpgradeCfg: { data: [] },
    // SelectPackLibCfg 的形状是 (itemId = 包, selectItemId = 能换出的材料, num = 每包产出)。
    // 「蓝装材料自选包」是故意放进来当反例的：它能换布匹，但属于稀有包，计划器不许碰。
    SelectPackLibCfg: { data: [
      { itemId: '原料自选包', selectItemId: '木材', type: '道具', num: 1, season: 1 },
      { itemId: '原料自选包', selectItemId: '玻璃', type: '道具', num: 1, season: 1 },
      { itemId: '原料自选包', selectItemId: '海藻', type: '道具', num: 1, season: 1 },
      { itemId: '工事材料自选包', selectItemId: '工事建材', type: '道具', num: 1, season: 1 },
      { itemId: '蓝装材料自选包', selectItemId: '布匹', type: '道具', num: 1, season: 1 },
      { itemId: '橙宠基因自选包', selectItemId: '基因碎片', type: '道具', num: 1, season: 1 },
    ] },
  } };

  const surveyFor = ({ packs = 0, packName = '原料自选包', material = '木材', have = 0, need = 5, orders = 1 } = {}) => {
    const stock = new Map([[material, have], [packName, packs]]);
    return {
      now: 1000, player: { level: 50 }, population: 10, maxPopulation: 99,
      stockCap: 9999, factorySlots: 2, stock,
      have: (id) => stock.get(id) ?? 0,
      buildings: [], factories: [],
      orders: Array.from({ length: orders }, (_, i) => ({
        index: i + 1,
        requirements: [{ id: material, num: need }],
        missing: [{ id: material, num: Math.max(0, need - have) }],
        rewardExp: 100,
      })),
    };
  };
  const packsOf = (plan) => plan.actions.filter((a) => a.kind === 'selectPack');

  // 包够：兑换补齐 → 订单可交，而且兑换排在交单前面。
  const enough = planWorld(surveyFor({ packs: 5 }), { config });
  const enoughKinds = enough.actions.map((a) => a.kind);
  assert.equal(packsOf(enough).length, 1, 'one shortage produces exactly one exchange');
  assert.equal(packsOf(enough)[0].body.selectItemId, '木材', 'the exchange names the material');
  assert.equal(packsOf(enough)[0].body.itemId, '原料自选包', 'the exchange names the pack');
  assert.equal(packsOf(enough)[0].body.num, 5, 'the exchange covers the whole gap');
  assert.ok(enoughKinds.includes('finishOrder'), 'with the gap covered the order goes through');
  assert.ok(enoughKinds.indexOf('selectPack') < enoughKinds.indexOf('finishOrder'),
    'the exchange must run before the order that needs it');

  // 包不够：只兑得出这么多，订单保留并说明原因，绝不半真半假地交单。
  const short = planWorld(surveyFor({ packs: 3 }), { config });
  assert.equal(packsOf(short)[0].body.num, 3, 'only as many as the packs can cover');
  assert.equal(short.actions.some((a) => a.kind === 'finishOrder'), false, 'still 2 short, so no order');
  assert.ok(short.notes.some((note) => note.includes('材料不足')), 'the kept order says why');

  // 关掉开关就完全不碰包。
  const off = planWorld(surveyFor({ packs: 5 }), { config, useSelectPack: false });
  assert.equal(off.actions.some((a) => a.kind === 'selectPack'), false, '--no-pack must never consume packs');

  // 每轮上限：包再多也不许一轮烧完。
  const capped = planWorld(surveyFor({ packs: 10, need: 8 }), { config, maxPackPerRound: 2 });
  assert.equal(packsOf(capped)[0].body.num, 2, 'the per-round cap wins over the actual surplus');

  // 库存本来就够，一个包都不该动。
  const stocked = planWorld(surveyFor({ packs: 5, have: 9 }), { config });
  assert.equal(stocked.actions.some((a) => a.kind === 'selectPack'), false, 'no exchange when the stock already covers it');

  // 稀有包不参与自动兜底：「布匹」只存在于蓝装材料自选包里，缺它也不许碰那个包。
  const rare = planWorld(surveyFor({ packs: 99, packName: '蓝装材料自选包', material: '布匹' }), { config });
  assert.equal(rare.actions.some((a) => a.kind === 'selectPack'), false,
    'rare packs (equip/gene/fragment) must never be spent by the planner');
  assert.ok(rare.notes.some((note) => note.includes('没有能换它的自选包')),
    'and the reason is recorded, not silently swallowed');

  // 工事材料自选包在白名单里，缺工事建材时可以兑。
  const fort = planWorld(surveyFor({ packs: 4, packName: '工事材料自选包', material: '工事建材' }), { config });
  assert.equal(packsOf(fort)[0]?.body.itemId, '工事材料自选包', 'the fort-material pack is allowed');
  assert.equal(packsOf(fort)[0]?.body.num, 4, 'and capped by how many you own');

  // 白名单可收窄：只留原料包时，缺工事建材就不兑了。
  const narrow = planWorld(surveyFor({ packs: 4, packName: '工事材料自选包', material: '工事建材' }), {
    config, allowPacks: ['原料自选包'],
  });
  assert.equal(narrow.actions.some((a) => a.kind === 'selectPack'), false,
    'allowPacks narrows what may be spent');

  // 材料不在任何自选包的覆盖范围里：不兑、并记下原因（原料包换不了工事建材之外的怪材料）。
  const uncovered = planWorld(surveyFor({ packs: 5 }), {
    config: { tables: { ...config.tables, SelectPackLibCfg: { data: [] } } },
  });
  assert.equal(uncovered.actions.some((a) => a.kind === 'selectPack'), false, 'nothing to exchange with an empty lib');
  assert.ok(uncovered.notes.some((note) => note.includes('没有能换它的自选包')), 'and it says so');

  // 两条订单抢同一批木材：各自的缺口都要补，总数正好是两条合计。
  const two = planWorld(surveyFor({ packs: 10, orders: 2 }), { config });
  assert.equal(packsOf(two).reduce((n, a) => n + a.body.num, 0), 10, 'both orders get their share');
  assert.equal(two.actions.filter((a) => a.kind === 'finishOrder').length, 2, 'and both go through');

  // 兑换动作靠材料名区分，否则多个兑换会撞成一个 key 被「刚被拒过」误伤。
  assert.equal(stepKey({ kind: 'selectPack', body: { selectItemId: '玻璃' } }), 'selectPack:玻璃');
  assert.notEqual(
    stepKey({ kind: 'selectPack', body: { selectItemId: '木材' } }),
    stepKey({ kind: 'selectPack', body: { selectItemId: '玻璃' } }),
  );
  checked += 1;
}

// 排产也要能用自选包补料。以前兜底只接在建造 / 交单 / 升级三处，
// 工厂缺料就整座空转（实测：切鱼厂 鱼油 要 鱼×50，仓库只有 7，而原料自选包有 25 万个）。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '切鱼厂' }] },
    BuildingProduceCfg: { data: [
      { buildType: '切鱼厂', itemId: '鱼油', produceTime: 1380, unlockLevel: 3, costItem: [['鱼', 50], ['玻璃', 30]] },
      { buildType: '切鱼厂', itemId: '鱼皮', produceTime: 2700, unlockLevel: 4, costItem: [['鱼', 120], ['布匹', 80]] },
    ] },
    BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [
      { itemId: '原料自选包', selectItemId: '鱼', type: '道具', num: 1, season: 1 },
      { itemId: '原料自选包', selectItemId: '玻璃', type: '道具', num: 1, season: 1 },
      { itemId: '蓝装材料自选包', selectItemId: '布匹', type: '道具', num: 1, season: 1 },
    ] },
  } };
  const surveyFor = ({ stock = {}, level = 3 } = {}) => {
    const map = new Map(Object.entries(stock));
    const factory = {
      buildingId: '1切鱼厂', type: '切鱼厂', level, product: [],
      factory: { factoryQ: [], finishedProducts: [], autoProductId: '' },
    };
    return {
      now: 1000, player: { level: 30 }, population: 10, maxPopulation: 99,
      stock: map, have: (id) => map.get(id) ?? 0, stockCap: 9999, factorySlots: 6,
      buildings: [factory], factories: [factory], orders: [],
      produce: { reduce: 0, instant: [], source: 'none' },
    };
  };
  const packsOf = (plan) => plan.actions.filter((a) => a.kind === 'selectPack');
  const producesOf = (plan) => plan.actions.filter((a) => a.kind === 'startProduce');
  const rich = { 鱼: 7, 玻璃: 1886, 原料自选包: 253_516 };

  // 额度不够一轮补满（缺口 43 > 每轮 20）：只兑 20、本轮不排，但**必须落账**（下轮接着补）。
  // 不落账的话 43 的缺口永远兑不出，鱼油这条配方就再也排不上了。
  // 有需求才值得烧包：这是「贸易港口货船在等鱼油」的场景。
  const wantsOil = { cargoDemand: new Map([['鱼油', 999]]) };
  const partial = planWorld(surveyFor({ stock: rich }), { config, maxPackPerRound: 20, ...wantsOil });
  assert.equal(packsOf(partial).length, 1, '缺口能兑时排产会先兑料');
  assert.equal(packsOf(partial)[0].body.selectItemId, '鱼', '兑的是缺的那个材料');
  assert.equal(packsOf(partial)[0].body.num, 20, '每轮额度 20 卡住，不会一次兑 43');
  assert.equal(producesOf(partial).length, 0, '料还没凑齐就先不排');
  assert.ok(partial.notes.some((n) => n.includes('下一轮继续')), '要说明这是分轮补，不是不干了');

  // 额度够 → 兑 43 补齐再排，且兑换排在排产前面（数组顺序即执行顺序）。
  const full = planWorld(surveyFor({ stock: rich }), { config, maxPackPerRound: 100, ...wantsOil });
  assert.equal(packsOf(full)[0].body.num, 43, '缺 43 就兑 43');
  assert.ok(full.actions.findIndex((a) => a.kind === 'selectPack') < full.actions.findIndex((a) => a.kind === 'startProduce'),
    '兑换必须排在排产之前');
  assert.equal(producesOf(full)[0].body.productId, '鱼油', '补齐后排的就是这条配方');
  assert.ok(full.notes.some((n) => n.includes('用自选包补齐后开排')), '日志要说清料是兑出来的');

  // 分轮累积的最后一轮：只剩 3 个缺口 → 兑 3 个就能排。
  const nearly = planWorld(surveyFor({ stock: { ...rich, 鱼: 47 } }), { config, maxPackPerRound: 20, ...wantsOil });
  assert.equal(packsOf(nearly)[0].body.num, 3, '只补剩下的缺口');
  assert.equal(producesOf(nearly).length, 1, '这一轮就能排上了');

  // 关掉开关：一个包都不碰，只写原因。
  const off = planWorld(surveyFor({ stock: rich }), { config, useSelectPack: false });
  assert.equal(packsOf(off).length, 0, '--no-pack 时排产也不许烧包');
  assert.equal(producesOf(off).length, 0, '否则不该排');
  assert.ok(off.notes.some((n) => n.includes('料不够')), '要写清为什么空着');

  // 有缺口换不出来（布匹只存在稀有的蓝装材料包里）：连别的料也不兑，直接空着。
  // 否则会白兑 20 个鱼，配方照样排不上。
  const blockedConfig = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    { buildType: '切鱼厂', itemId: '鱼皮', produceTime: 2700, unlockLevel: 1, costItem: [['鱼', 120], ['布匹', 80]] },
  ] } } };
  const blocked = planWorld(surveyFor({ stock: { 鱼: 7, 布匹: 0, 原料自选包: 253_516 } }),
    { config: blockedConfig, cargoDemand: new Map([['鱼皮', 999]]) });
  assert.equal(packsOf(blocked).length, 0, '有换不出来的材料就不兑（免得白烧包）');
  assert.equal(producesOf(blocked).length, 0, '也不排');
  assert.ok(blocked.notes.some((n) => n.includes('没有自选包可换')), '原因要写清楚（缺的是布匹，没有包能换）');

  // 料够的配方优先，不为高档配方烧包：鱼 7 够生鱼片(6) 时不该动 50 的鱼油。
  const cheapFirst = planWorld(surveyFor({ stock: rich, level: 3 }), {
    config: { tables: { ...config.tables, BuildingProduceCfg: { data: [
      { buildType: '切鱼厂', itemId: '鱼油', produceTime: 1380, unlockLevel: 1, costItem: [['鱼', 50], ['玻璃', 30]] },
      { buildType: '切鱼厂', itemId: '生鱼片', produceTime: 90, unlockLevel: 1, costItem: [['鱼', 6]] },
    ] } } },
  });
  assert.equal(packsOf(cheapFirst).length, 0, '能免费排的配方先排，不为它兑料');
  assert.equal(producesOf(cheapFirst)[0].body.productId, '生鱼片', '优先排料够的那条');

  // 缺口大的配方不许挡住缺口小的：鱼皮（鱼×120，缺口 120 > 每轮 20）排在生鱼片（鱼×6）前面时，
  // 以前在鱼皮上就 break 了 —— 兑 20 个鱼、本轮不排、下一轮又兑 20，生鱼片永远轮不上。
  // 现在先扫一遍找「本轮能兑齐」的，鱼皮跳过，直接排生鱼片。
  const bigFirst = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    { buildType: '切鱼厂', itemId: '鱼皮', produceTime: 60, unlockLevel: 1, costItem: [['鱼', 120]] },
    { buildType: '切鱼厂', itemId: '生鱼片', produceTime: 90, unlockLevel: 1, costItem: [['鱼', 6]] },
  ] } } };
  const skipBig = planWorld(surveyFor({ stock: { 鱼: 0, 原料自选包: 500 } }), {
    config: bigFirst, maxPackPerRound: 20,
    cargoDemand: new Map([['鱼皮', 1], ['生鱼片', 1]]),
  });
  assert.equal(producesOf(skipBig)[0]?.body.productId, '生鱼片', '兑不齐的大配方要跳过，先排本轮能兑齐的');
  assert.equal(packsOf(skipBig).length, 1, '只为真正要排的那条兑料');
  assert.equal(packsOf(skipBig)[0].body.num, 6, '兑的是生鱼片的 6 个鱼，不是鱼皮的 120');
  assert.ok(!packsOf(skipBig).some((action) => action.body.num > 20), '不会给排不上的大配方兑一堆料');

  // 瞬成排满时每一份都要能继续补料：以前只判一次「这条配方料够不够」，
  // 于是 鱼 7 + 6 个制造位 = 只排得动 1 个（剩下的直接 break），空位白空着。
  const refillSurvey = surveyFor({ stock: { 鱼: 7, 原料自选包: 500 } });
  // 774 秒减免 → 90 秒的生鱼片是瞬成配方，才会走「排满 6 个」那条路。
  refillSurvey.produce = { reduce: 774, instant: [], source: 'appoint' };
  const refill = planWorld(refillSurvey, {
    config: { tables: { ...config.tables, BuildingProduceCfg: { data: [
      { buildType: '切鱼厂', itemId: '生鱼片', produceTime: 90, unlockLevel: 1, costItem: [['鱼', 6]] },
    ] } } },
    maxPackPerRound: 100,
    // 有需求才补料：没需求的配方不烧自选包（见 planWorld 里那条规则）。
    cargoDemand: new Map([['生鱼片', 999]]),
  });
  assert.equal(producesOf(refill).length, 6, '瞬成配方要把 6 个制造位排满（料不够的那几份拿包补）');
  // 第 1 份用库存里的 6 个鱼，第 2 份只缺 5（还剩 1 个），后面 4 份各缺 6 → 5 + 6×4 = 29 个包。
  assert.equal(packsOf(refill).reduce((n, action) => n + action.body.num, 0), 29,
    '缺多少补多少：第 2 份缺 5，其余 4 份各缺 6');
  // 兑换动作必须夹在「用它之前那次排产」和「它支撑的那次排产」之间（数组顺序即执行顺序）。
  const firstProduce = refill.actions.findIndex((action) => action.kind === 'startProduce');
  const secondProduce = refill.actions.findIndex((action, i) => action.kind === 'startProduce' && i > firstProduce);
  const firstPack = refill.actions.findIndex((action) => action.kind === 'selectPack');
  assert.ok(firstPack > firstProduce && firstPack < secondProduce,
    `补料要排在它支撑的那次排产之前（produce#${firstProduce} < pack#${firstPack} < produce#${secondProduce}）`);

  // 额度默认 500，但**不能超过仓库里真实的包数**：包只有 20 个时，本轮最多烧 20 个，
  // 日志里也要写真实值（每轮上限 20 个包），不能写着 500 骗人。
  const stockBound = planWorld(surveyFor({ stock: { 鱼: 0, 玻璃: 0, 原料自选包: 20 } }), { config, ...wantsOil });
  assert.ok(stockBound.notes.some((n) => n.includes('每轮上限 20 个包')), '额度会被实际库存压下来');
  // 瞬成排满时每一份都补料，也不能把包兑超额（兑出仓库里没有的包 = 服务端直接拒）。
  const limitedSurvey = surveyFor({ stock: { 鱼: 0, 原料自选包: 20 } });
  limitedSurvey.produce = { reduce: 774, instant: [], source: 'appoint' };
  const limited = planWorld(limitedSurvey, {
    config: { tables: { ...config.tables, BuildingProduceCfg: { data: [
      { buildType: '切鱼厂', itemId: '生鱼片', produceTime: 90, unlockLevel: 1, costItem: [['鱼', 6]] },
    ] } } },
    cargoDemand: new Map([['生鱼片', 999]]),
  });
  assert.equal(packsOf(limited).reduce((n, action) => n + action.body.num, 0), 20,
    '包只有 20 个：一份 6 个 → 兑齐 3 份用掉 18，第 4 份只剩 2，总数正好 20');
  assert.equal(producesOf(limited).length, 3, '料兑完就停，不排出假动作');

  // **没有需求的配方不烧包**（2026-10-27 加）：否则一整夜每轮都往没人要的产品上砸几百个包
  // （实测 1金属厂 为产没人要的铜锭兑 玻璃×60、1服装厂 兑 塑料×30…25 万个包撑不了几十小时）。
  // 后来这个规则被 packGapMax 开了口子，默认值 = 500（与每轮额度同量级）：缺口在一轮额度内
  // 兑得齐就放行。所以默认参数下 鱼油（鱼×50 + 玻璃×30 = 80 个包）会兑 —— 真正的刹车是
  // 「每轮 500 额度 + 只排 1 个 + 产物到上限 50」这三条，不是门槛本身。
  const noWant = planWorld(surveyFor({ stock: { 鱼: 0, 玻璃: 0, 原料自选包: 253_516 } }), { config });
  assert.equal(packsOf(noWant).length, 2, '默认 500：缺口 80 个包在一轮额度内 → 破例兑（鱼 50 + 玻璃 30）');
  assert.equal(producesOf(noWant).length, 1, '破例只排 1 个，不排满');

  // 想收紧就传小值：20 = 只补零头，80 个包的鱼油回到「等需求」。
  const tight = planWorld(surveyFor({ stock: { 鱼: 0, 玻璃: 0, 原料自选包: 253_516 } }),
    { config, packGapMax: 20 });
  assert.equal(packsOf(tight).length, 0, 'packGapMax:20 时缺口 80 个包 > 上限 → 不兑');
  assert.equal(producesOf(tight).length, 0, '也不排');
  assert.ok(tight.notes.some((n) => n.includes('小额兜底上限 20')), '要写清「缺口 80 > 上限 20」，别只说补不上');

  // 小额兜底口子（2026-10-27 加，packGapMax）：差一点点就让工厂空一整天太蠢。
  // 实测场景：1海水厂 lv4 的淡水/海藻泥都到存量上限 50，剩黏土要 玻璃×60、仓库只有 54 —— 差 6 个包，
  // 而仓库里躺着 26 万个原料自选包，工厂从早空到晚。
  const seaConfig = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    { buildType: '切鱼厂', itemId: '黏土', produceTime: 1800, unlockLevel: 1, costItem: [['海藻', 60], ['玻璃', 60]] },
  ] } } };
  const smallGap = planWorld(surveyFor({ stock: { 海藻: 3131, 玻璃: 54, 原料自选包: 261_600 } }), { config: seaConfig });
  assert.equal(packsOf(smallGap).length, 1, '无需求但缺口只有 6 个包 → 破例兑');
  assert.equal(packsOf(smallGap)[0].body.selectItemId, '玻璃', '兑的是缺的那个材料');
  assert.equal(packsOf(smallGap)[0].body.num, 6, '缺 6 就兑 6，不多兑');
  assert.equal(producesOf(smallGap).length, 1, '补齐后开排 1 个');
  assert.ok(smallGap.notes.some((n) => n.includes('小额兜底')), '日志要说明这是破例，不是「有需求」');

  // packGapMax: 0 = 彻底关掉口子，退回「无需求绝不烧包」。
  const closed = planWorld(surveyFor({ stock: { 海藻: 3131, 玻璃: 54, 原料自选包: 261_600 } }),
    { config: seaConfig, packGapMax: 0 });
  assert.equal(packsOf(closed).length, 0, 'packGapMax:0 时一个包都不兑');
  assert.equal(producesOf(closed).length, 0, '也不排');
  assert.ok(closed.notes.some((n) => n.includes('小额兜底已关闭')), '关掉后要说清原因');

  // 默认 packGapMax = Infinity（产品策略「无时无刻都在制造」）：缺口再大也兑，
  // 兑不齐就分轮攒 —— 不靠外部需求驱动，靠「每轮 500 额度 + 只排 1 个 + 产物到上限」刹车。
  const hugeConfig = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    { buildType: '切鱼厂', itemId: '海藻霉菌', produceTime: 13500, unlockLevel: 1, costItem: [['鱼', 600], ['玻璃', 600]] },
  ] } } };
  const hugeSurvey = () => surveyFor({ stock: { 鱼: 0, 玻璃: 0, 原料自选包: 261_600 } });
  const hugeDefault = planWorld(hugeSurvey(), { config: hugeConfig, maxPackPerRound: 5000 });
  assert.equal(packsOf(hugeDefault).length, 2, '默认不设门槛：缺口 1200 也兑');
  assert.equal(producesOf(hugeDefault).length, 1, '兑齐就排 1 个');

  // 收紧到 500 时同样的配方就该等需求（缺口 1200 > 500）。
  const stillBig = planWorld(hugeSurvey(), { config: hugeConfig, packGapMax: 500, maxPackPerRound: 5000 });
  assert.equal(packsOf(stillBig).length, 0, 'packGapMax:500 时缺口 1200 > 上限 → 不兑');
  assert.ok(stillBig.notes.some((n) => n.includes('小额兜底上限 500')), '要写清「缺口 1200 > 上限 500」，别只说补不上');

  // 兑不齐时挑**缺口最小**的那条攒，别让巨无霸每轮吃掉全部额度。
  // 鱼皮 缺口 120、鱼油 缺口 43，哪条排在前面都该先攒 43 的那条（挑小不挑顺序）。
  const mixConfig = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    { buildType: '切鱼厂', itemId: '鱼皮', produceTime: 60, unlockLevel: 1, costItem: [['鱼', 120]] },
    { buildType: '切鱼厂', itemId: '鱼油', produceTime: 1380, unlockLevel: 1, costItem: [['鱼', 43]] },
  ] } } };
  const smallest = planWorld(surveyFor({ stock: { 鱼: 0, 原料自选包: 500 } }), { config: mixConfig, maxPackPerRound: 100 });
  assert.equal(packsOf(smallest).length, 1, '只兑一条配方的料');
  assert.equal(packsOf(smallest)[0].body.num, 43, '缺口 43 兑 43 就够（额度 100 用不完）');
  assert.equal(producesOf(smallest).length, 1, '43 的缺口兑齐 → 直接开排，不用等下一轮');
  assert.equal(producesOf(smallest)[0].body.productId, '鱼油', '挑缺口小的先攒，不是按排序第一的鱼皮（120）');

  // 瞬成配方破例时也不许「排满」：料是拿包换的，排满 = 把包按 N 倍烧。
  const instantSurvey = surveyFor({ stock: { 鱼: 0, 原料自选包: 500 } });
  instantSurvey.produce = { reduce: 774, instant: [], source: 'appoint' };
  const instantConfig = { tables: { ...config.tables, BuildingProduceCfg: { data: [
    { buildType: '切鱼厂', itemId: '生鱼片', produceTime: 90, unlockLevel: 1, costItem: [['鱼', 6]] },
  ] } } };
  const instantSmall = planWorld(instantSurvey, { config: instantConfig });
  assert.equal(packsOf(instantSmall).length, 1, '瞬成配方也只为 1 个兑料');
  assert.equal(producesOf(instantSmall).length, 1, '小额兜底只排 1 个，不排满 6 个（否则包按 6 倍烧）');
  checked += 1;
}

// 拾荒：默认不做，勾了才把海面漂浮物逐件捡起来；所得按 DisplayAsset 汇总。
// 难点在 num —— 它是 protobuf int64，normalize 过的会是数字，没 normalize 的是 {low, high}。
{
  const { planWorld, summarizeFloaters, formatFloaters } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [] }, BuildingProduceCfg: { data: [] }, BuildingUpgradeCfg: { data: [] },
  } };
  const surveyWithFloaters = (n) => ({
    now: 1000, player: { level: 50 }, population: 10, maxPopulation: 99,
    stockCap: 9999, factorySlots: 2, stock: new Map(),
    have: () => 0,
    buildings: [], factories: [], orders: [],
    floaters: Array.from({ length: n }, (_, i) => ({ floaterId: `f${i + 1}`, num: 1 })),
  });

  const off = planWorld(surveyWithFloaters(3), { config });
  assert.equal(off.actions.some((a) => a.kind === 'pickUpFloater'), false, '拾荒默认关闭，不勾就不捡');

  const on = planWorld(surveyWithFloaters(3), { config, pickUpFloaters: true });
  const picks = on.actions.filter((a) => a.kind === 'pickUpFloater');
  assert.equal(picks.length, 1, '一次请求就能提交全部漂浮物（floaterId 是 repeated string）');
  assert.deepEqual(picks[0].body, { floaterId: ['f1', 'f2', 'f3'] },
    'id 必须打包成数组：传字符串会被按字符拆成 N 个单字 id，服务端回 invalid floater id');
  assert.equal(picks[0].response, 'PickUpFloaterResponse', '拾荒要拿回报，必须走带响应的 request 而不是 sendWatch');

  const capped = planWorld(surveyWithFloaters(5), { config, pickUpFloaters: true, maxPickups: 2 });
  assert.deepEqual(capped.actions.find((a) => a.kind === 'pickUpFloater')?.body.floaterId, ['f1', 'f2'],
    '每轮上限只截前 N 件');
  assert.ok(capped.notes.some((note) => note.includes('额度用完')), '超出上限的部分要说明');

  const results = [
    // 一次提交 3 件，全成功
    { step: { kind: 'pickUpFloater', body: { floaterId: ['a', 'b', 'c'] } }, ok: true,
      body: { reward: { asset: [{ id: '木材', num: 3 }, { id: '淡水', num: 1 }] } } },
    // 一次提交 2 件，其中 1 件被服务端拒绝（木材用没转换的 {low,high} 形状）
    { step: { kind: 'pickUpFloater', body: { floaterId: ['d', 'e'] } }, ok: true,
      body: { reward: { asset: [{ id: '木材', num: { low: 2, high: 0, unsigned: false } }] }, deniedFloaterIds: ['e'] } },
    // 一次提交 1 件，整个请求失败
    { step: { kind: 'pickUpFloater', body: { floaterId: ['f'] } }, ok: false, error: '被拒' },
    // 别的动作，绝不能被算进拾荒所得
    { step: { kind: 'gainFactory', body: {} }, ok: true, body: { reward: { asset: [{ id: '不该计入', num: 99 }] } } },
  ];
  const loot = summarizeFloaters(results);
  assert.equal(loot.submitted, 5, '成功的请求一共提交了 5 件');
  assert.equal(loot.denied, 1, '服务端拒了其中 1 件');
  assert.equal(loot.picked, 4, '实际到手 4 件 = 提交 5 - 被拒 1');
  // 这条是用户实际踩到的坑：件数按「请求数」算的话，一个请求装 50 件会被显示成「拾荒 1 件」。
  assert.notEqual(loot.picked, 2, '件数要按 floaterId 的个数算，不是按请求条数算');
  assert.equal(loot.failed, 1, '失败的请求涉及 1 件');
  assert.equal(loot.total, 6, '提交 5 件 + 失败 1 件');
  assert.deepEqual(loot.items, [{ id: '木材', num: 5 }, { id: '淡水', num: 1 }],
    '同物品累加，且不把别的动作算进拾荒所得');
  assert.ok(formatFloaters(loot).includes('拾荒 6 件'), '汇总行要能直接读');
  assert.equal(formatFloaters(summarizeFloaters([])), '', '没拾荒就别打印空行');

  // 一次拾荒能出几十种碎片，整行铺出来没法读，超过 12 种要折叠。
  const many = summarizeFloaters([{
    step: { kind: 'pickUpFloater', body: { floaterId: Array.from({ length: 20 }, (_, i) => `x${i}`) } },
    ok: true,
    body: { reward: { asset: Array.from({ length: 20 }, (_, i) => ({ id: `物${i}`, num: 1 })) } },
  }]);
  assert.ok(formatFloaters(many).includes('等 20 种'), '物品太多要折叠成「等 N 种」');

  // 藏品碎片按品质合并：奖励里是「藏品蓝10碎片 / 藏品蓝11碎片 / 藏品紫2碎片」这种按编号分的，
  // 不合并的话一次拾荒能铺出几十条，完全没法读。
  const frag = summarizeFloaters([{
    step: { kind: 'pickUpFloater', body: { floaterId: ['a', 'b', 'c', 'd'] } },
    ok: true,
    body: { reward: { asset: [
      { id: '藏品蓝10碎片', num: 1 },
      { id: '藏品蓝11碎片', num: 1 },
      { id: '藏品紫2碎片', num: 1 },
      { id: '木材', num: 3 },
    ] } },
  }]);
  assert.deepEqual(frag.items, [
    { id: '木材', num: 3 },
    { id: '藏品蓝碎片', num: 2 },
    { id: '藏品紫碎片', num: 1 },
  ], '藏品碎片要抹掉编号、按品质合并');
  assert.ok(formatFloaters(frag).includes('藏品蓝碎片×2'), '合并结果要出现在汇总行里');
  checked += 1;
}

// 加速：数量必须是有限数字。库存算成 NaN 时宁可这次不加速，也不能把 NaN 当数量发出去
// —— 服务端会回 invalid speed-up count，而 55 条同类动作会跟着被 blocked 掉。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [] }, BuildingProduceCfg: { data: [] }, BuildingUpgradeCfg: { data: [] },
  } };
  const surveyWithSpeeders = (speeders) => ({
    now: 1000, player: { level: 50 }, population: 10, maxPopulation: 99,
    stockCap: 9999, factorySlots: 2,
    stock: new Map([['加速器', speeders]]),
    have: (id) => (id === '加速器' ? speeders : 0),
    buildings: [{ buildingId: '1A', type: '民居', level: 1, product: [], buildFinishTime: 1600, factory: null }],
    factories: [], orders: [], floaters: [],
  });

  const step = planWorld(surveyWithSpeeders(10), { config, allowSpeedUp: true })
    .actions.find((a) => a.kind === 'speedUpUpgrade');
  assert.ok(step, '有加速器又在建造中，应该排一条加速');
  assert.ok(Number.isFinite(step.body.speedUp.useNum) && step.body.speedUp.useNum > 0,
    '加速数量必须是有限正数（历史上这里出过 NaN）');
  assert.equal(step.body.speedUp.useNum, 10, '10 分钟路程用 10 个加速器');

  const nan = planWorld(surveyWithSpeeders(NaN), { config, allowSpeedUp: true });
  assert.equal(nan.actions.some((a) => a.kind === 'speedUpUpgrade'), false,
    '库存是 NaN 时不许发加速请求');
  checked += 1;
}

// 仓库材料清单：总览页那一栏的内容。分类全部来自配置，不硬编码名字。
{
  const { materialGroups } = await import('./world.mjs');
  const config = { tables: {
    ItemCfg: { data: [
      { id: '鱼', type: '原料' },
      { id: '木材', type: '原料' },
      { id: '鱼', type: '原料' }, // 重复项要合并
      { id: '小麦', type: '农产品' },
      { id: '玉米', type: '农产品' },
      { id: '耐火砖', type: '加工品' },
      { id: '液态金属', type: '加工品' },
      { id: '生鱼片', type: '加工品' }, // 工厂产品
      { id: '铜锭', type: '加工品' },   // 工厂产品
    ] },
    SelectPackLibCfg: { data: [
      { itemId: '工事材料自选包', selectItemId: '耐火砖', num: 1 },
      { itemId: '工事材料自选包', selectItemId: '液态金属', num: 1 },
      { itemId: '原料自选包', selectItemId: '鱼', num: 1 }, // 原料靠 type 取，不靠包
      { itemId: '橙装材料自选包', selectItemId: '橙武器材料', num: 1 }, // 别的包不许混进来
    ] },
  } };
  const groups = materialGroups(config);
  assert.deepEqual(groups.map((g) => g.key), ['raw', 'works', 'farm', 'made'],
    '四组顺序固定：原料 / 工事材料 / 农产品 / 工厂产品');
  assert.deepEqual(groups.map((g) => g.name), ['原料', '工事材料', '农产品', '工厂产品']);
  assert.deepEqual(groups[0].items, ['鱼', '木材'], '原料按 ItemCfg.type 取，重复项要去重');
  assert.deepEqual(groups[1].items, ['耐火砖', '液态金属'], '工事材料从「工事材料自选包」反查，别的包不混进来');
  assert.deepEqual(groups[2].items, ['小麦', '玉米'], '农产品按 type 取');
  assert.deepEqual(groups[3].items, ['生鱼片', '铜锭'],
    '工厂产品 = 加工品扣掉工事材料（耐火砖/液态金属 已经在上一组，不能重复出现）');
  assert.equal(groups[3].onlyOwned, true, '工厂产品 158 种太多，交给调用方只留仓库里有的');
  assert.equal(groups[0].onlyOwned, undefined, '其余三组要全列（数量 0 也要显示，才知道缺什么）');
  assert.deepEqual(materialGroups({ tables: {} }), [], '配置缺表时返回空数组，交给前端降级');
  checked += 1;
}

// ★ 防回归：潜水 / 打捞**永远不许**被排进计划。
//
// 两者都不是「发个请求就完事」的玩法：DivingRequest.reward.asset 与
// EndSalvageRequest.pickedFloaters 都是「你这一局实际捡到了什么」的上报体，
// 客户端是在小游戏里产生战利品之后才填进去发给服务端的（空手时客户端根本不发）。
// 纯协议发空体 = 上报「一件没捡到」，服务端如实回空奖励（实测 {"reward":{"asset":[]}}）；
// 想拿到东西只能伪造清单，属于谎报战利品。项目边界明确不做，详见 docs/gameplay.md。
//
// 这组断言的作用是**拦住以后的自己**：谁要是又给 planWorld 加个 diving 参数，
// 这里会直接红。别改这组断言，要改先读 docs/gameplay.md。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [] }, BuildingProduceCfg: { data: [] }, BuildingUpgradeCfg: { data: [] },
  } };
  const survey = () => ({
    now: 1000, player: { level: 50 }, population: 10, maxPopulation: 99,
    stockCap: 9999, factorySlots: 2, stock: new Map(), have: () => 0,
    buildings: [], factories: [], orders: [], floaters: [{ floaterId: 'f1', num: 1 }],
  });
  // 把「历史上曾经存在的开关」都塞进去，模拟有人按老代码调用。
  const plan = planWorld(survey(), {
    config, pickUpFloaters: true, diving: true, maxDivings: 3, allowSpeedUp: true, allowReroll: true,
  });
  const banned = plan.actions.filter((a) => a.kind === 'diving' || a.request === 'DivingRequest'
    || a.request === 'BeginSalvageRequest' || a.request === 'EndSalvageRequest');
  assert.deepEqual(banned, [], '潜水/打捞永远不许进计划：它们的请求体要上报真实战利品，伪造即谎报');
  assert.equal(plan.actions.some((a) => a.kind === 'pickUpFloater'), true, '拾荒不受影响，该排还是要排');
  checked += 1;
}

// 建造：OnWaterResponse 里 level=0 的建筑是已解锁未建的空位，走 BuildBuildingRequest，
// 判据是 BuildingUpgradeCfg 的 level 1 行（实测 49 种建筑这一行全是 costTime 0 / consume 空）。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '日用品厂' }, { buildingType: '军工厂' }, { buildingType: '硅矿厂' }, { buildingType: '玩具厂' }] },
    BuildingProduceCfg: { data: [] },
    BuildingUpgradeCfg: { data: [
      { buildingType: '日用品厂', level: 1, playerLevel: 10, curPeople: 0, costTime: 0, consume: [], condition: [] },
      { buildingType: '军工厂', level: 1, playerLevel: 51, curPeople: 0, costTime: 0, consume: [], condition: [] },
      { buildingType: '硅矿厂', level: 1, playerLevel: 51, curPeople: 0, costTime: 0, consume: [], condition: ['先修好码头'] },
      { buildingType: '玩具厂', level: 1, playerLevel: 18, curPeople: 0, costTime: 0, consume: [['木材', 10]], condition: [] },
    ] },
  } };
  const survey = {
    now: 1000, player: { level: 21 }, population: 30, maxPopulation: 40, stockCap: 50, factorySlots: 6,
    have: () => 0, stock: new Map(),
    buildings: [
      // 够等级、没在施工 -> 该建
      { buildingId: '1日用品厂', type: '日用品厂', level: 0, product: [], buildFinishTime: 0, factory: null },
      // 等级不够
      { buildingId: '1军工厂', type: '军工厂', level: 0, product: [], buildFinishTime: 0, factory: null },
      // 有额外条件
      { buildingId: '1硅矿厂', type: '硅矿厂', level: 0, product: [], buildFinishTime: 0, factory: null },
      // 已经在盖了，不能重发
      { buildingId: '2日用品厂', type: '日用品厂', level: 0, product: [], buildFinishTime: 2000, factory: null },
      // 要材料而库存是 0：客户端会拿钻石买，本工具不买，只记一笔
      { buildingId: '1玩具厂', type: '玩具厂', level: 0, product: [], buildFinishTime: 0, factory: null },
    ],
    factories: [], orders: [],
  };
  const plan = planWorld(survey, { config });
  const builds = plan.actions.filter((a) => a.kind === 'build');
  assert.equal(builds.length, 1, '只有够等级、没在施工、没额外条件、材料也够的空位被排进计划');
  assert.equal(builds[0].request, 'BuildBuildingRequest', '建造用的是 BuildBuildingRequest，不是升级那条');
  assert.equal(builds[0].body.buildingId, '1日用品厂');
  assert.equal(builds[0].response, null, 'BuildBuildingRequest 没有配套 Response，必须走 sendWatch');
  assert.ok(plan.notes.some((note) => note.includes('额外条件')), '有条件的空位要说明跳过原因');
  assert.ok(plan.notes.some((note) => note.includes('木材 0/10')), '材料不够时宁可等，也不替玩家花钻石买');
  assert.ok(plan.notes.some((note) => note.includes('建造要等级 51')), '等级不够也要说清楚差多少，不能静默丢掉');

  // 额度：一次最多建 maxBuilds 个，剩下的写进 notes 而不是静默丢掉。
  const many = { ...survey, buildings: ['1日用品厂', '2日用品厂', '3日用品厂', '4日用品厂'].map((buildingId) => (
    { buildingId, type: '日用品厂', level: 0, product: [], buildFinishTime: 0, factory: null }
  )) };
  const capped = planWorld(many, { config, maxBuilds: 2 });
  assert.equal(capped.actions.filter((a) => a.kind === 'build').length, 2, 'maxBuilds 生效');
  assert.equal(capped.notes.filter((note) => note.includes('建造额度')).length, 2, '被压住的两个要进 notes');

  // 盖完了的那一栋：这一轮只发竣工，不能再顺手发一次建造——竣工后它已经是 level 1，
  // 建造会被服务端拒，界面上就成了一条假的失败。
  const done = planWorld({ ...survey, buildings: [
    { buildingId: '1日用品厂', type: '日用品厂', level: 0, product: [], buildFinishTime: 900, factory: null },
  ] }, { config });
  assert.deepEqual(done.actions.map((a) => a.kind), ['finishUpgrade'], '正在收尾的楼同一轮不该再排建造');
  assert.equal(done.actions[0].request, 'FinishUpgradeBuildingRequest');
  checked += 1;
}

// 同类型多座建筑抢同一批材料：候选是一次性扫出来的，每条看到的 free() 都是同一份快照，
// 所以必须在真正入列时按当前可用量再核一次。不核的话后一条请求必被服务端拒，
// 而 build / upgrade 不是 transient，被拒的 buildingId 会被 rejected 带到整场挂机结束。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: 'A民居' }] },
    BuildingProduceCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    BuildingUpgradeCfg: { data: [
      { buildingType: 'A民居', level: 1, playerLevel: 1, curPeople: 0, costTime: 0, consume: [], condition: [], effect: [] },
      { buildingType: 'A民居', level: 2, playerLevel: 1, curPeople: 0, costTime: 100, consume: [['木材', 10]], condition: [], effect: [['人口增加', 5]] },
    ] },
  } };
  const surveyWith = (wood) => {
    const stock = new Map([['木材', wood]]);
    const block = (buildingId) => ({ buildingId, type: 'A民居', level: 1, product: [], buildFinishTime: 0, factory: null, farm: null });
    return {
      now: 1000, player: { level: 9 }, population: 50, maxPopulation: 99, stockCap: 99, factorySlots: 6,
      stock, have: (id) => stock.get(id) ?? 0,
      buildings: [block('1A民居'), block('2A民居')], factories: [], orders: [],
    };
  };

  // 12 个木材只够升一座（每座 10）：多排的那一座必被拒，且会被永久记住。
  const one = planWorld(surveyWith(12), { config, maxUpgrades: 2 });
  assert.equal(one.actions.filter((a) => a.kind === 'upgrade').length, 1, '只够升一座时不能排两座');
  assert.ok(one.notes.some((note) => note.includes('被本轮其它动作占用')), '被压住的那座要说明原因');

  // 材料够两座时照旧排两座（别把正常情况也拦掉）。
  const two = planWorld(surveyWith(40), { config, maxUpgrades: 2 });
  assert.equal(two.actions.filter((a) => a.kind === 'upgrade').length, 2, '材料够就还是两座都升');
  checked += 1;
}

// 常量 stepKey 的动作必须标 transient：runWorld 会把「非 transient 的失败」写进跨轮 rejected，
// 而拾荒 / 收农田 / 播种的 body 里没有 buildingId 单值或 index，key 退化成常量 ——
// 一次「已过期 / 种子不足」的 prompt 就会让整场挂机不再拾荒、不再种地。
{
  const { planWorld } = await import('./world.mjs');
  const config = { tables: {
    BuildingCfg: { data: [] }, BuildingProduceCfg: { data: [] }, BuildingUpgradeCfg: { data: [] },
    SelectPackLibCfg: { data: [] },
    FarmlandPlantCfg: { data: [{ id: '玉米', time: 100, material: ['玉米种子', 1] }] },
  } };
  const stock = new Map([['玉米种子', 5]]);
  const plot = (buildingId, productId, ripeAt) => ({
    buildingId, type: '农田', level: 1, product: [], buildFinishTime: 0, factory: null,
    farm: { productId, plantAt: 0, ripeAt },
  });
  const survey = {
    now: 1000, player: { level: 9 }, population: 9, maxPopulation: 9, stockCap: 99, factorySlots: 6,
    stock, have: (id) => stock.get(id) ?? 0,
    buildings: [plot('1农田', '玉米', 900), plot('2农田', '', 0)],
    factories: [], orders: [], autoFarming: false,
    floaters: [{ floaterId: 'f1', num: 1 }],
  };
  const plan = planWorld(survey, { config, pickUpFloaters: true, farm: true });
  for (const kind of ['farmHarvest', 'farmPlant', 'pickUpFloater']) {
    const hit = plan.actions.filter((action) => action.kind === kind);
    assert.equal(hit.length, 1, `${kind} 应该排进计划`);
    assert.equal(hit[0].transient, true, `${kind} 的 key 是常量，必须 transient 才不会被永久拉黑`);
  }
  checked += 1;
}

// 活跃度宝箱：日、周是两张表两套门槛，混用会把周宝箱算多。
// 门槛取自线上配置表（Daily 20/40/60/80/100，Weekly 120/240/360/480/600），
// 这里写死成缩样是为了断言「周走的是 WeeklyActivityRewardCfg」这一点不被改回去。
{
  const { planChests, chestTiers, CHEST_TABLE, formatSurvey } = await import('./dailies.mjs');
  const tiers = (base) => [1, 2, 3, 4, 5].map((id) => ({ season: 1, id, activity: base * id, reward: ['奖励', id] }));
  const config = { tables: {
    DailyActivityRewardCfg: { data: [...tiers(20), { season: 2, id: 1, activity: 20, reward: ['加速器', 120] }] },
    WeeklyActivityRewardCfg: { data: tiers(120) },
  } };
  assert.equal(CHEST_TABLE.weekly, 'WeeklyActivityRewardCfg', '周宝箱必须走周表');

  // 测试账号上线时的真实状态：日 4/4 已领、85 活跃度两边都不够下一档。
  const real = planChests({ dailyActivity: 85, dailyRewardClaimed: [1, 2, 3, 4], weeklyActivity: 85, weeklyRewardClaimed: [] }, config);
  assert.deepEqual(real.daily.tiers.map((tier) => tier.id), [], '日宝箱 1-4 已领，第 5 档要 100 活跃度，还不能领');
  assert.equal(real.daily.nextAt, 100, '差多少要说出来：下一档 100');
  assert.deepEqual(real.weekly.tiers.map((tier) => tier.id), [], '周一档都没领，但 85 活跃度连第 1 档 120 都不到');
  assert.equal(real.weekly.nextAt, 120, '周门槛是 120 不是 20，这就是被服务端拒过的那一条');
  assert.equal(real.actions.length, 0, '两边都没得领，不该发出任何请求');

  // 周活跃度真的够了才发：240 够周 1、2 档。
  const weekly = planChests({ dailyActivity: 85, dailyRewardClaimed: [1, 2, 3, 4], weeklyActivity: 240, weeklyRewardClaimed: [1] }, config);
  assert.deepEqual(weekly.actions.map((action) => action.request), ['DrawWeeklyRewardRequest'], '日那边没得领，就只发周那一条');
  assert.deepEqual(weekly.actions[0].body.index, [2], 'index 是 repeated int32，必须发数组，且只补没领的档');
  assert.equal(weekly.actions[0].response, null, '这条请求在协议表里没有配套 Response');

  // 两档之间：跨过 40 之后 2 档可领，1 档已领过不再重复发。
  const between = planChests({ dailyActivity: 45, dailyRewardClaimed: [1], weeklyActivity: 0, weeklyRewardClaimed: [] }, config);
  assert.deepEqual(between.daily.tiers.map((tier) => tier.id), [2], '只补没领的那一档');
  assert.equal(between.daily.nextAt, 60);
  // 跨季节去重：同一个 id 在多季都有一行，只能算一次。
  assert.deepEqual(chestTiers(config, { activity: 20, claimed: [] }).map((tier) => tier.id), [1], '同 id 跨季节要去重');

  const survey = { tasks: [], chests: real };
  assert.ok(formatSurvey(survey).includes('第 100 档'), '没得领的原因是「差多少」，不是「已领」');
  checked += 1;
}

// 每日精选的免费赠礼：packId 是客户端硬编码的字面量，可领性只看 drawnPack 里有没有它。
{
  const { planDailyGift, formatSurvey } = await import('./dailies.mjs');
  const { FREE_DAILY_PACK_ID } = await import('./actions.mjs');
  assert.equal(FREE_DAILY_PACK_ID, '赠礼', 'packId 必须与客户端 DailyPackBuyPanel.freePackId 一致');

  const unclaimed = planDailyGift({ drawnPack: [], resetTime: 1791648000, heroId: '马斯克' });
  assert.equal(unclaimed.freeAvailable, true, 'drawnPack 空 = 今天还没领');
  assert.deepEqual(unclaimed.actions.map((a) => a.request), ['GotFreeDailyPackRequest']);
  assert.equal(unclaimed.actions[0].body.packId, FREE_DAILY_PACK_ID);
  assert.equal(unclaimed.actions[0].response, null, '协议表里没有 GotFreeDailyPackResponse，只能靠重新查 drawnPack 确认');

  const done = planDailyGift({ drawnPack: ['赠礼'], resetTime: 1791648000, heroId: '马斯克' });
  assert.equal(done.freeAvailable, false, 'drawnPack 里有赠礼 = 领过了');
  assert.equal(done.actions.length, 0, '领过了就不该再发请求');

  // 买了礼包1 但没领赠礼时也还是要领——两者互不影响。
  const mixed = planDailyGift({ drawnPack: ['礼包1'], resetTime: 0, heroId: '马斯克' });
  assert.equal(mixed.freeAvailable, true, '买过付费礼包不等于领了免费那档');

  const text = formatSurvey({ tasks: [], chests: null, gift: unclaimed });
  assert.ok(text.includes('每日赠礼 未领'), '调查报告要能看出每日赠礼欠着');
  checked += 1;
}

// 静默请求：协议表里没有 *Response 的写请求，服务端成功时一声不吭、被拒时只推 PromptResponse。
// 它们必须走 sendWatch（守窗口），发成裸 request 就会挂到超时并且分不清成功与否。
{
  const { ACTIONS, runAction } = await import('./actions.mjs');
  // docs/gameplay.md 第 11.3 节列的静默请求。写死在这里是有意为之：新增动作时若把某个
  // 没有 Response 的请求写成有 Response，下面的集合比对会直接失败，而不是发出去等到超时。
  const SILENT = new Set([
    'DrawMainTaskRewardRequest', 'GotBranchTaskRewardRequest', 'GotAchievementRewardRequest',
    'GetNextOrderOTDRewardRequest', 'StartFactoryProduceRequest', 'SetFactoryAutoProduceRequest',
    'FinishUpgradeBuildingRequest', 'SpeedUpUpgradeBuildingRequest', 'UpgradeBuildingRequest',
    'BuildBuildingRequest', 'GotFreeDailyPackRequest',
    'DenyOrderRequest', 'SpeedUpFactoryProduceRequest', 'SetBuildingAutoWorkRequest',
    'QuickGotReadEmailRequest', 'DrawDailyRewardRequest', 'DrawWeeklyRewardRequest', 'MonthCardDailyRewardRequest',
    'ChallengeResFieldRequest', 'GiveUpResFieldRequest', 'SelectPackRequest',
    'GotGiftCodeRequest',
  ]);
  const sent = [];
  const client = {
    request: async (name) => { sent.push({ via: 'request', name }); return {}; },
    sendWatch: async (name) => { sent.push({ via: 'watch', name }); },
  };
  for (const [id, action] of Object.entries(ACTIONS)) {
    assert.ok(protocol[action.request], `${id} names a request the protocol does not have`);
    if (action.response) {
      assert.ok(protocol[action.response], `${id} declares a response type the protocol does not have`);
      assert.equal(SILENT.has(action.request), false, `${id} declares a response for a request that has none`);
    } else {
      assert.ok(SILENT.has(action.request), `${id} has no response but is not on the documented silent list`);
    }
    if (!action.mutate) continue;
    sent.length = 0;
    await runAction(client, protocol, id, { buildingId: 'x', productId: 'y', taskId: 1, index: 1, gridIdx: 1, useNum: 1, level: 1, isOn: true, id: 1, itemId: '原料自选包', selectItemId: '木材', num: 1, floaterId: 'f1', giftCode: 'VIP666' }, { allowMutate: true });
    assert.equal(sent.length, 1, `${id} sends exactly one message`);
    assert.equal(sent[0].via, action.response ? 'request' : 'watch', `${id} must go through ${action.response ? 'request' : 'watch'}`);
  }
  checked += 1;
}

// 账号仓库：迁移、按 id/昵称/序号选中、同账号换凭证时就地替换但保留备注。
{
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-accounts-'));
  // 账号仓库与自检都在同一个进程里跑，靠环境变量把它指到临时目录 + 换 query 重新加载，
  // 免得不小心写到真的 data/accounts.json。
  process.env.CW_DATA_DIR = dir;
  const reload = () => import(`${pathToFileURL(path.resolve('src/accounts.mjs')).href}?case=${Math.random()}`);
  const mod = await reload();
  const credential = (openId, token) => ({
    url: 'wss://example/ws',
    login: { eworldParams: { openId, token, sign: 'sg', timestamp: 1 } },
    loginFrameHex: 'aabb',
    source: 'mitm',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
  const TOKEN_1 = 'tk-open-1-0123456789';
  const TOKEN_2 = 'tk-open-2-9876543210';

  const store = { version: 1, activeId: null, accounts: [] };
  const first = mod.upsertAccount(store, credential('open-1', TOKEN_1));
  assert.equal(first.created, true, '首次入库要标记为新建');
  assert.equal(store.activeId, 'open-1', '第一个账号自动成为当前账号');
  mod.upsertAccount(store, credential('open-2', TOKEN_2));
  store.accounts[1].label = '小号';
  assert.equal(mod.pickAccount(store, '小号').id, 'open-2', '按备注选账号');
  assert.equal(mod.pickAccount(store, '2').id, 'open-2', '按序号选账号');
  assert.equal(mod.pickAccount(store, 'open-1').id, 'open-1', '按 id 选账号');
  assert.throws(() => mod.pickAccount(store, 'open'), /匹配到多个/, '前缀撞车要报错而不是随便挑一个');

  // 同一个账号重新抓包 → 凭证换新，备注与 lastSeen 保留
  const seen = { nickname: '老船长', level: 11, power: 900, worldId: 7 };
  mod.rememberSeen(store.accounts[1], seen);
  const refreshed = 'tk-open-2-refreshed-0001';
  const again = mod.upsertAccount(store, credential('open-2', refreshed));
  assert.equal(again.created, false, '同账号不算新建');
  assert.equal(again.account.label, '小号', '重新抓包不该丢掉备注');
  assert.equal(again.account.login.eworldParams.token, refreshed, '凭证要换成新的');
  assert.equal(again.account.lastSeen.nickname, '老船长', 'lastSeen 保留');
  assert.equal(store.accounts.length, 2, '不会因为重复抓包多出一条');

  assert.equal(mod.accountId(credential('open-9', 'x')), 'open-9', '账号身份取自 openId');
  assert.equal(mod.accountId({ login: {} }), null, '没有 openId 就不是一份可用凭证');

  // 默认打码：头尾各 4 位；8 位以内整串打掉；要点一次「显示凭证」才给全文
  const first0 = mod.describeAccount(store.accounts[0]);
  assert.equal(first0.masked.token, `${TOKEN_1.slice(0, 4)}********${TOKEN_1.slice(-4)}`, '默认打码只露头尾');
  assert.equal(mod.describeAccount(store.accounts[0]).masked.token, first0.masked.token, '打码结果稳定');
  assert.equal(first0.hasFrame, true, '有原始帧要标出来');
  const tiny = mod.describeAccount({ id: 'x', url: 'wss://x', login: { eworldParams: { openId: 'ab', token: 'tk', sign: 'sg' } } });
  assert.equal(tiny.masked.token, '**', '8 位以内整串打掉');
  assert.equal(mod.revealAccount(store.accounts[0]).raw.token, TOKEN_1, '显示凭证才给全文');
  assert.equal(mod.revealAccount(store.accounts[0]).loginFrameHex, 'aabb', '显示凭证也带原始帧');

  mod.saveStore(store);
  const reloaded = mod.loadStore();
  assert.equal(reloaded.accounts.length, 2, '写盘后能读回来');
  assert.equal(reloaded.activeId, 'open-1', '当前账号也一起存了');
  assert.equal(reloaded.accounts[1].login.eworldParams.token, refreshed, '重新抓包后的新凭证也落了盘');
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json.tmp')), false, '落盘要先写临时文件再改名，不留残渣');
  mod.removeAccount(reloaded, 'open-1');
  assert.equal(reloaded.activeId, 'open-2', '删掉当前账号后自动切到剩下的');

  // 迁移：早期版本只有 credentials.json，第一次读到时要能就地合成一个账号，并且不写盘
  fs.rmSync(path.join(dir, 'accounts.json'), { force: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
    url: 'wss://legacy/ws',
    login: { eworldParams: { openId: 'open-old', token: 'legacy-token-0001', sign: 'sg', timestamp: 2 } },
    loginFrameHex: 'ccdd',
    source: 'mitm',
    capturedAt: '2025-12-31T00:00:00.000Z',
  }));
  const legacy = (await reload()).loadStore();
  assert.equal(legacy.accounts.length, 1, '老凭证要能合成出账号');
  assert.equal(legacy.activeId, 'open-old', '合成出来的账号就是当前账号');
  assert.equal(legacy.accounts[0].login.eworldParams.token, 'legacy-token-0001', '凭证本体原样带过来');
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), false, '只是读，不该悄悄落盘');
  fs.rmSync(dir, { recursive: true, force: true });
  checked += 1;
}

// 素材索引：图标矩形得真的落在自己那张图集页里（拿 PNG 的 IHDR 对账），
// 实体到图标名的映射要有足够覆盖率，查不到的时候老实返回 null 而不是编一个。
{
  const { iconIndex, iconOf, atlasFile, iconEntry, iconCoverage, itemIcon, buildingIcon, heroIcon } = await import('./art.mjs');
  const { pngSize } = await import('./fgui.mjs');
  const index = iconIndex();
  if (!Object.keys(index.icons).length) {
    console.log('跳过素材检查：还没跑过 node tools/sync-art.mjs');
  } else {
    const sizes = new Map();
    const dims = (bundle, page) => {
      const key = `${bundle}/${page}`;
      if (!sizes.has(key)) sizes.set(key, pngSize(atlasFile(bundle, page)));
      return sizes.get(key);
    };
    let outOfRange = 0;
    for (const [name, icon] of Object.entries(index.icons)) {
      const size = dims(icon.bundle, icon.page);
      if (!size) continue;
      // 旋转打包的贴图在图集里占的是 h 宽、w 高 —— 这条是从游戏自己的引擎代码里核出来的
      // （SpriteFrame._calculateUV 里旋转分支用 (x+rect.height)/texWidth 算右边界），
      // 也用 work/tmp/crop-icon.mjs 裁出来肉眼确认过。显示尺寸仍是矩形本身的 w×h。
      // 所以量「图集占位」时要把两个数换过来。
      const spanW = icon.rotated ? icon.h : icon.w;
      const spanH = icon.rotated ? icon.w : icon.h;
      const inside = icon.x >= 0 && icon.y >= 0 && icon.x + spanW <= size.width && icon.y + spanH <= size.height;
      if (!inside && outOfRange++ === 0) console.log(`  越界的图标: ${name} ${JSON.stringify(icon)} 图集 ${size.width}x${size.height}`);
    }
    assert.equal(outOfRange, 0, '所有图标矩形都必须落在自己的图集页里');
    assert.ok(Object.values(index.icons).some((icon) => icon.rotated), '索引里应有旋转打包的贴图，界面必须把这类转回来');

    const [page] = index.pages;
    assert.ok(atlasFile(page.split('/')[0], page.split('/')[1]), '图集页要能真的读到，这是路由的正常路径');
    assert.equal(atlasFile('..', 'accounts.json'), null, '图集路由不接受 ..');
    assert.equal(atlasFile('ui_iconlib', '../index.json'), null, '图集路由不接受带斜杠的文件名');
    assert.equal(atlasFile('ui_iconlib', '不存在.png'), null, '图集路由只给真实存在的文件');

    const fish = itemIcon('生鱼片');
    assert.ok(fish && fish.url.startsWith('/api/art/atlas/') && fish.w > 0 && fish.h > 0, '道具「生鱼片」要有能直接裁的图标入口');
    assert.ok(buildingIcon('食品厂'), '建筑「食品厂」应该有图标（resPath 末段 Kitchen）');
    assert.equal(iconOf('绝对不存在的图标名'), null, '查不到就返回 null，不编造');
    assert.equal(iconEntry('绝对不存在的图标名'), null, '没有图标就没有入口');

    const coverage = Object.fromEntries(iconCoverage().map((line) => [line.label, line]));
    assert.equal(coverage['资源'].missing, 0, `资源图标必须齐全: ${JSON.stringify(coverage['资源'])}`);
    assert.ok(coverage['道具'].hit / coverage['道具'].total > 0.9, `道具图标覆盖率偏低: ${JSON.stringify(coverage['道具'])}`);
    assert.ok(coverage['英雄头像'].hit >= 40, `有头像的英雄太少: ${JSON.stringify(coverage['英雄头像'])}`);
    assert.ok(heroIcon('小布'), '英雄「小布」应该有头像（英雄碎片物品的图兜底）');
    checked += 1;
  }
}

// 二维码：编码 → 把矩阵读回来 → 反掩码、反交错、校验证验码、还原出原文。
// 等于自己实现一遍解码器来对，扫不扫得动还得靠手机，但结构错了这里就过不去。
{
  const QR = await import('./vendor/qrcode.mjs');
  const text = 'https://servicewechat.com/wxascheme/jump_wxa?url=weixin%3A%2F%2Fdl%2Fbusiness%2F%3Fappid%3Dwx2ea52a972ea18e5e%26env_version%3Drelease';
  const matrix = QR.encodeMatrix(text);

  // 版本 8 / 纠错等级 M 的规格：4 块（38,38,39,39），每块 22 个纠错码字。照标准抄的。
  const dataLens = [38, 38, 39, 39];
  const ecLen = 22;
  const size = matrix.size;
  const bytesLen = Buffer.byteLength(text);
  assert.ok(bytesLen > 122 && bytesLen <= 152, `这段链接应落在版本 8 的容量里（当前 ${bytesLen} 字节）`);
  assert.equal(matrix.version, 8, '应自动选到版本 8');
  assert.equal(size, 49, '版本 8 的模块边长是 49');

  // 定位图形与定时图形
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) assert.equal(matrix.modules[cy + dy][cx + dx], true, '定位图形中心 3x3 必须是深色');
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(matrix.modules[6][i], i % 2 === 0, `横向定时图形第 ${i} 格`);
    assert.equal(matrix.modules[i][6], i % 2 === 0, `纵向定时图形第 ${i} 格`);
  }

  // 格式信息：两份必须一致，BCH 余数为 0，解出来的掩码与编码时选的相等
  const readFormat = (spots) => spots.reduce((acc, [col, row], i) => acc | (matrix.modules[row][col] ? 1 << i : 0), 0);
  const first = readFormat([[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]);
  const second = readFormat([[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [size - 8, 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]]);
  assert.equal(first, second, '两份格式信息必须一致');
  const raw = first ^ 0x5412;
  let remainder = raw;
  for (let i = 14; i >= 10; i -= 1) if ((remainder >> i) & 1) remainder ^= 0x537 << (i - 10);
  assert.equal(remainder, 0, '格式信息的 BCH 校验位必须自洽');
  assert.equal(raw >> 13, 0b00, '纠错等级应为 M');
  assert.equal((raw >> 10) & 7, matrix.mask, '格式信息里的掩码必须和实际选的一致');

  // 反掩码 + 按同样的蛇形顺序把数据位读回来
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const isFunction = (x, y) => {
    if (x < 9 && y < 9) return true;                            // 左上定位图形、分隔带、格式信息
    if (x > size - 9 && y < 9) return true;                     // 右上定位图形
    if (x < 9 && y > size - 9) return true;                     // 左下定位图形
    if (x === 6 || y === 6) return true;                        // 定时图形
    if ((y < 6 && x >= size - 11 && x <= size - 9) || (x < 6 && y >= size - 11 && y <= size - 9)) return true; // 版本信息
    const centers = [6, 24, 42];                                // 版本 8 的校正图形中心
    for (const cy of centers) {
      for (const cx of centers) {
        if (Math.abs(x - cx) > 2 || Math.abs(y - cy) > 2) continue;
        const nearFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
        if (!nearFinder) return true;
      }
    }
    return false;
  };
  // 按编码时同样的蛇形顺序回读：从右下角起两列一组，跳过第 6 列，方向交替。
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction(x, y)) continue;
        bits.push(matrix.modules[y][x] !== maskFn[matrix.mask](x, y) ? 1 : 0);
      }
    }
  }
  assert.equal(bits.length, 242 * 8, '版本 8 的数据区正好放 242 个码字');
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // 反交错：先逐列取各块的数据码字，再逐列取各块的纠错码字
  const data = dataLens.map(() => []);
  const ecc = dataLens.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...dataLens); i += 1) {
    for (let b = 0; b < dataLens.length; b += 1) if (i < dataLens[b]) data[b].push(codewords[at++]);
  }
  for (let i = 0; i < ecLen; i += 1) for (let b = 0; b < dataLens.length; b += 1) ecc[b].push(codewords[at++]);
  assert.equal(at, codewords.length, '交错后的码字要正好用完');

  // 纠错码校验：把每块当作多项式，在 α^0..α^{ecLen-1} 处求值，应该全为 0
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  {
    let x = 1;
    for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  }
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  for (let b = 0; b < dataLens.length; b += 1) {
    const poly = data[b].concat(ecc[b]);
    for (let i = 0; i < ecLen; i += 1) {
      let value = 0;
      for (const coef of poly) value = mul(value, EXP[i]) ^ coef;
      assert.equal(value, 0, `第 ${b} 块在 α^${i} 处的校验值应为 0`);
    }
  }

  // 数据位：模式 0100 + 8 位长度 + UTF-8 正文。正文跨块，得把各块的数据码字按顺序接回来。
  const dataBits = [];
  for (const block of data) for (const byte of block) for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >> i) & 1);
  const take = (from, count) => dataBits.slice(from, from + count).reduce((acc, bit) => (acc << 1) | bit, 0);
  assert.equal(take(0, 4), 0b0100, '模式指示符应为字节模式');
  const length = take(4, 8);
  assert.equal(length, Buffer.byteLength(text), '长度字段应等于正文的字节数');
  const decoded = [];
  for (let i = 0; i < length; i += 1) decoded.push(take(12 + i * 8, 8));
  assert.equal(Buffer.from(decoded).toString('utf8'), text, '解出来的正文应与原文一致');

  // SVG 里深色模块的数量要对得上，且带静区
  const svg = QR.qrSvg(text, { scale: 4 });
  const dark = matrix.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/M\d+ \d+h1v1h-1z/g) || []).length, dark, 'SVG 里的方块数应等于深色模块数');
  assert.ok(svg.includes(`viewBox="0 0 ${size + 8} ${size + 8}"`), 'SVG 应带 4 格静区');
  checked += 1;
}

// --- 自动循环里的拾荒间隔 ------------------------------------------------------
// 拾荒比循环慢得多，靠「上次执行时间 + 间隔」节流；判定必须是纯函数才好测。
// （潜水/打捞没有这种开关，因为它们根本不做 —— 见上面那组禁令断言。）
{
  const every = 5 * 60_000;
  assert.equal(gateDue(0, every, 1_000_000), true, '没执行过（lastAt=0）时首次立刻执行');
  // 容差：轮首时刻与「真的执行时刻」天然差几秒，所以差 1ms 也算到点（否则间隔=轮间隔的
  // 模块会永远差那几秒，变成两轮才跑一次）。容差是 every 的 10%，最多 2 秒。
  assert.equal(gateDue(1_000_000, every, 1_000_000 + every - 1), true, '差 1ms 到间隔时算已到（容差内）');
  assert.equal(gateDue(1_000_000, every, 1_000_000 + every), true, '刚好到间隔就该发');
  assert.equal(gateDue(1_000_000, every, 1_000_000 + every - 2001), false, '离间隔还差 2 秒以上仍然不发');
  assert.equal(gateDue(1_000_000, 60_000, 1_000_000 + 59_000), true, '60 秒的间隔容差 2 秒，59 秒时就可以跑');
  assert.equal(gateDue(1_000_000, 60_000, 1_000_000 + 57_000), false, '57 秒还没到，别提前打');
  assert.equal(gateDue(1_000_000, 0, 1_000_001), true, '间隔 0 = 不限制，每轮都试');
  assert.equal(gateDue(1_000_000, -5000, 1_000_001), true, '负数间隔也按不限制处理');

  assert.equal(humanDuration(40), '40 秒');
  assert.equal(humanDuration(320), '5 分 20 秒');
  assert.equal(humanDuration(1800), '30 分');
  assert.equal(humanDuration(3780), '1 小时 3 分');

  // 轮数 / 间隔的非法输入必须回退，不能静默变成「永久挂机」或 1ms 间隔。
  assert.equal(loopTotal('abc'), 1, '非法轮数回退 1 轮，不能变成永久挂机');
  assert.equal(loopTotal(undefined), 1, '缺省轮数同样回退 1');
  assert.equal(loopTotal(3), 3, '正常轮数原样透传');
  assert.equal(loopTotal(0), Infinity, '0 仍然是「一直跑」');
  assert.equal(loopTotal(-1), Infinity, '负数仍然是「一直跑」');
  assert.equal(loopGap('abc'), 60_000, '非法间隔回退 60 秒，不能退化成 1ms');
  assert.equal(loopGap(-5), 60_000, '负数间隔回退 60 秒');
  // 主循环的 0 和别的 gate 不一样：别的填 0 是「每轮最多一次」，主循环填 0 是「上一轮结束立刻
  // 开下一轮」—— 一小时几千次探测。所以给一个下限，不能退化成不等待。
  assert.equal(loopGap(0), MIN_LOOP_GAP_MS, '主循环间隔填 0 必须钳到下限，否则高频轰炸网关');
  assert.equal(loopGap(1500), MIN_LOOP_GAP_MS, '小于下限的间隔同样钳到下限');
  assert.equal(loopGap(1500), 5000, '下限就是 5 秒');
  assert.equal(loopGap(60_000), 60_000, '正常间隔原样透传');
  checked += 1;
}

// 自动循环的三个「手感」问题（2026-10-26 修）：
//   ① 改完设置必须停掉重开 —— 现在 live() 每轮重读，下一轮就生效；
//   ② 点停止要等整轮跑完 —— 现在段级检查，当前这一段结束就退出；
//   ③ 周期 = 间隔 + 本轮耗时（越跑越漂）—— 现在按「轮首 + 间隔」对齐。
{
  const { runLoop } = await import('./loop.mjs');
  // 所有探测都失败：每段各自 catch，正好让一轮又短又稳定，方便断言等待时长。
  const client = {
    connected: true,
    request: async () => { throw new Error('mock 探测失败'); },
    sendWatch: async () => { throw new Error('mock 探测失败'); },
  };
  // 虚拟时钟：sleep 直接把时间推过去，不用真的等一分钟。
  let clockA = 1_000_000;
  const waitsA = [];
  const sleepA = async (ms) => { waitsA.push(ms); clockA += ms; };

  // ① 间隔按「轮首 → 下一轮轮首」对齐：live 恒定 60 秒 → 两轮之间正好等 60 秒
  //    （旧实现是「本轮结束再等 60 秒」，所以总周期一定大于 60 秒）。
  const flat = { everyMs: 60_000 };
  const a = await runLoop(client, {}, {
    rounds: 2, everyMs: 60_000, allowMutate: true,
    now: () => clockA, sleep: sleepA, live: () => flat,
  });
  assert.ok(waitsA.every((ms) => ms <= 1_000),
    `等待必须分段（每段 ≤ 1 秒），否则点停止/改间隔都要等满整个间隔，实际 ${waitsA.slice(0, 3)}`);
  assert.equal(waitsA.reduce((sum, ms) => sum + ms, 0), 60_000, '等待 = 间隔（本轮几乎瞬间），不是「间隔 + 耗时」');
  assert.equal(a.history[0].everyMs, 60_000, '第 1 轮用启动时的间隔');
  assert.equal(a.history[0].elapsedMs, 0, '每轮要记耗时，页面据此显示「上一轮耗时」');

  // ② 热更新：第 1 轮执行期间把间隔改成 30 秒 —— 这一轮的等待立刻缩短，下一轮也用新值。
  const live2 = { everyMs: 60_000 };
  let clockB = 1_000_000;
  const waitsB = [];
  const hotClient = {
    connected: true,
    request: async () => { live2.everyMs = 30_000; throw new Error('mock'); },
    sendWatch: async () => { throw new Error('mock'); },
  };
  const b = await runLoop(hotClient, {}, {
    rounds: 2, everyMs: 60_000, allowMutate: true,
    now: () => clockB, sleep: async (ms) => { waitsB.push(ms); clockB += ms; }, live: () => live2,
  });
  assert.equal(waitsB.reduce((sum, ms) => sum + ms, 0), 30_000, '间隔被改小后不用等旧的 60 秒');
  assert.equal(b.history[0].everyMs, 60_000, '改之前的那一轮仍按旧值');
  assert.equal(b.history[1].everyMs, 30_000, 'live 改过之后下一轮立刻生效，不用停掉重开');

  // 段级停止：第 1 段发出请求时就点停止，后面 7 段一律不开。
  let clock2 = 1_000_000;
  const stop = { aborted: false };
  let calls = 0;
  const stopClient = {
    connected: true,
    request: async () => { calls += 1; stop.aborted = true; throw new Error('mock'); },
    sendWatch: async () => { throw new Error('mock'); },
  };
  const stopped = await runLoop(stopClient, {}, {
    rounds: 3, everyMs: 60_000, allowMutate: true, stop,
    now: () => clock2, sleep: async (ms) => { clock2 += ms; },
  });
  assert.equal(stopped.history.length, 1, '停止后不再进入下一轮');
  assert.equal(stopped.history[0].stopped, true, '这一轮要标成「被停止打断」');
  assert.equal(calls, 1, '只发了第 1 段的 1 个请求，剩下的段落没再发');
  assert.ok(formatLoopRound(stopped.history[0]).includes('已按要求停止'),
    `日志要说清是主动停止，不是故障，实际：\n${formatLoopRound(stopped.history[0])}`);
  // 停止时 summary 的各段必须都在（缺段会让格式化函数撞 null）。
  for (const key of ['tasks', 'dailies', 'world', 'idle', 'treasure', 'radar', 'forge', 'pet']) {
    assert.ok(stopped.history[0][key], `停止的那一轮也要有 ${key} 段，不能是 null`);
  }

  // 轮间等待时点停止：立刻退出，不用等满整个间隔（分段等待的意义）。
  let clock3 = 1_000_000;
  const midStop = { aborted: false };
  const midWaits = [];
  const mid = await runLoop(client, {}, {
    rounds: 3, everyMs: 60_000, allowMutate: true, stop: midStop,
    now: () => clock3,
    sleep: async (ms) => { midWaits.push(ms); clock3 += ms; midStop.aborted = true; },
  });
  assert.equal(midWaits.length, 1, '第一段等待里就收到停止 → 不再继续等');
  assert.equal(mid.history.length, 1, '等待期间被停止，也不会再开下一轮');
  checked += 1;
}

// 段参数解析的「自引用 TDZ」红线（2026-10-28 踩过，整轮挂机直接死）。
// 段里写 `const cityWarRepairBelow = pickAt(conf, 'cityWarRepairBelow', cityWarRepairBelow)`：
// 局部 const 遮蔽了同名参数 → 右边读到自己 → 执行到这一行就抛
// 「Cannot access 'x' before initialization」，页面只显示这一句，一轮都不跑。
// ⚠ 这种错 runLoop 冒烟抓不到（那些用例为了快，前几段就 halt 了，走不到第 13 段），
// 所以在这里做静态扫描 —— 宁可多一条源码级检查，也不要再让「自测全绿但挂机起不来」发生。
{
  const fs = await import('node:fs');
  const url = new URL('./loop.mjs', import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  // 只认 `const X = … pickAt(<conf>, '<key>', X)` 这一种形状，避免把 `const a = obj.a` 误判。
  const selfRef = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*pickAt\(\s*[^,()]+,\s*['"][^'"]*['"]\s*,\s*\1\s*\)/g;
  const hits = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    // 注释里会引用这条错误写法当反面例子，不能算命中。
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    selfRef.lastIndex = 0;
    const m = selfRef.exec(line);
    if (m) hits.push(`${m[1]} → ${trimmed.slice(0, 110)}`);
  }
  assert.deepEqual(hits, [],
    `段参数不能用「和同名参数一样的局部变量名」接 pickAt（TDZ 会让整轮挂机一开始就抛错）：\n${hits.join('\n')}`);
  checked += 1;
}

// 被间隔挡住的轮次要能在日志里看出来，否则像「勾了没反应」。
{
  const summary = {
    round: 3,
    startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: { planned: 0, results: [], notes: [], population: '10/20', floaterLoot: null },
    gates: {
      pick: { enabled: true, everyMs: 300_000, lastAt: 1_700_000_000, waitSeconds: 200, throttled: true },
    },
  };
  const text = formatLoopRound(summary);
  assert.ok(text.includes('拾荒 间隔未到，还差 3 分 20 秒（每 5 分一次）'), `应显示拾荒节流提示，实际：\n${text}`);

  // 断线整轮跳过的那一轮必须有一句人话，否则「计划 0 / 0 / 0」看起来像所有模块都挂了。
  const offline = formatLoopRound({
    ...summary,
    link: '连接已断开，重连失败：login rejected: result=3；本轮跳过',
    gates: undefined,
  });
  assert.ok(offline.includes('重连失败：login rejected: result=3'), `断线轮次要带原因，实际：\n${offline}`);
  assert.ok(!offline.includes('undefined'), `占位字段不能漏成 undefined，实际：\n${offline}`);

  // 情报同样受间隔约束（默认 60 秒）：被挡住的那轮要说清楚还差多久。
  const radarGated = formatLoopRound({
    ...summary,
    radar: { planned: 0, results: [], notes: [] },
    gates: { radar: { enabled: true, everyMs: 60_000, lastAt: 1_700_000_000, waitSeconds: 42, throttled: true } },
  });
  assert.ok(radarGated.includes('情报 间隔未到，还差 42 秒（每 1 分一次）'), `应显示情报节流提示，实际：\n${radarGated}`);

  // 锻造：探测过就要印出来（哪怕是「还在锻造、还剩多久」），被间隔挡住的那轮也要说清楚。
  const forgeRound = formatLoopRound({
    ...summary,
    forge: { planned: 1, results: [], notes: ['「蓝防具1」还在锻造，还剩 6 分钟'], summary: '1装备厂 lv1 · 打造中「蓝防具1」还剩 6 分钟 · 武器 6/防具 5/饰品 5' },
    gates: { forge: { enabled: true, everyMs: 180_000, lastAt: 1_700_000_000, waitSeconds: 90, throttled: true } },
  });
  assert.ok(forgeRound.includes('锻造 计划 1'), `锻造要有一行概览，实际：\n${forgeRound}`);
  assert.ok(forgeRound.includes('打造中「蓝防具1」'), '概览要带上装备厂状态');
  assert.ok(forgeRound.includes('锻造 间隔未到，还差 1 分 30 秒（每 3 分一次）'), `要有锻造节流提示，实际：\n${forgeRound}`);

  // 老 history（没有 gates 字段）不能炸。
  const legacy = formatLoopRound({ ...summary, gates: undefined });
  assert.ok(legacy.startsWith('第 3 轮'), '缺 gates 的旧轮次记录也要能正常格式化');
  checked += 1;
}

// 循环日志的成功行必须带**具体物品**（收成品 淡水×2、排产 木板×3）。
// 只报「收成品×3」看不出收了什么，等于没记 —— 这条断言钉住的是「别再退回纯计数」。
{
  const { itemText, planWorld } = await import('./world.mjs');

  // 合并重复 id、丢掉 0 / 负数 / 空 id，超量时补「另有 N 种」。
  assert.equal(itemText([['淡水', 2], ['木板', 1], ['淡水', 3]]), '淡水×5、木板×1', '同 id 要合并');
  assert.equal(itemText([['淡水', 0], ['木板', -2], [null, 3], ['鱼', 1]]), '鱼×1', '0/负数/空 id 都不该出现');
  assert.equal(itemText([['小麦', 4]], { unit: '块' }), '小麦×4块', '单位要能加后缀');
  assert.equal(itemText([]), '', '空数组返回空串');
  assert.equal(itemText([['a', 1], ['b', 1], ['c', 1]], { limit: 2 }), 'a×1、b×1、另有 1 种', '超量要说明还有几种');

  // 收成品 / 排产这两类动作必须带 items，日志才能汇总出物品。
  const stock = new Map([['木材', 9]]);
  const factory = {
    buildingId: '1工厂', type: '材料厂', level: 1, product: [],
    factory: {
      factoryQ: [],
      finishedProducts: [{ id: '淡水', num: 2 }, { id: '木板', num: 1 }],
      autoProductId: '',
    },
  };
  const survey = {
    now: 1000, player: { level: 1 }, population: 1, maxPopulation: 2, stockCap: 0, factorySlots: 6,
    have: (id) => stock.get(id) ?? 0, stock,
    buildings: [factory], factories: [factory], orders: [],
  };
  const config = { tables: {
    BuildingProduceCfg: { data: [
      { buildType: '材料厂', itemId: '木板', produceTime: 300, unlockLevel: 1, costItem: [['木材', 2]] },
    ] },
  } };
  const plan = planWorld(survey, { config });
  const gain = plan.actions.find((action) => action.kind === 'gainFactory');
  assert.deepEqual(gain.items, [['淡水', 2], ['木板', 1]], '收成品要记录收到哪几样、各多少');
  assert.ok(gain.label.includes('淡水×2'), `收成品的 label 要写明物品，实际：${gain.label}`);
  const produce = plan.actions.find((action) => action.kind === 'startProduce');
  assert.deepEqual(produce.items, [['木板', 1]], '排产要记录产出哪一样');

  // 汇总：两类动作同一行印出来（瞬成排 2 个就累加成 木板×2）。
  const round = formatLoopRound({
    round: 1, startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: {
      planned: 2, notes: [], population: '1/2', floaterLoot: null,
      results: [
        { step: gain, ok: true },
        { step: { kind: 'startProduce', items: [['木板', 1]], label: '排产 1工厂 -> 木板' }, ok: true },
        { step: { kind: 'startProduce', items: [['木板', 1]], label: '排产 1工厂 -> 木板' }, ok: true },
        // 失败/跳过的动作不能把物品算进成功行。
        { step: { kind: 'startProduce', items: [['木板', 1]], label: '排产 1工厂 -> 木板' }, ok: false, error: 'queue full' },
      ],
    },
    gates: {},
  });
  assert.ok(round.includes('成功 收成品 淡水×2、木板×1'), `成功行要带收成品物品，实际：\n${round}`);
  assert.ok(round.includes('排产 木板×2'), `排产要按物品累加（失败的那条不算），实际：\n${round}`);
  checked += 1;
}

// 工厂页：读出队列倒计时与「这个等级能造什么」。判定只看 BuildingProduceCfg，
// 所以用合成配置就能跑，不依赖 CDN 快照。
{
  const { factoryRecipes, viewFactories, packCoverPlan } = await import('./factories.mjs');
  const config = {
    tables: {
      BuildingProduceCfg: { data: [
        { buildType: '食品厂', itemId: '烤鱼', limitType: '', unlockLevel: 1, produceTime: 300, costItem: [['鱼', 1], ['木材', 5]] },
        { buildType: '食品厂', itemId: '刺身拼盘', limitType: '', unlockLevel: 3, produceTime: 600, costItem: [['生鱼片', 6]] },
        { buildType: '食品厂', itemId: '海藻酒', limitType: '', unlockLevel: 9, produceTime: 1200, costItem: [['海藻', 6]] },
        { buildType: '食品厂B', itemId: '酒精', limitType: '', unlockLevel: 1, produceTime: 3600, costItem: [['小麦', 3]] },
        { buildType: '军工厂', itemId: '耐火砖', limitType: '', unlockLevel: 1, produceTime: 7200, costItem: [['工事建材', 1]] },
      ] },
    },
  };

  // 「食品厂B」不能因为前缀是「食品厂」就串到食品厂的配方 —— 跟 buildingId 解析同一套最长后缀规则。
  assert.deepEqual(factoryRecipes(config, '食品厂').map((row) => row.itemId), ['烤鱼', '刺身拼盘', '海藻酒']);
  assert.deepEqual(factoryRecipes(config, '食品厂B').map((row) => row.itemId), ['酒精']);
  assert.deepEqual(factoryRecipes(config, '装备厂'), [], '没有配方的工厂返回空数组，不是 undefined');
  assert.deepEqual(factoryRecipes(config, null), [], '认不出类型时也不能炸');

  const now = 1_700_000_000;
  const survey = {
    now,
    stock: new Map([['鱼', 9], ['木材', 3], ['生鱼片', 10]]),
    factorySlots: 2,
    stockCap: 50,
    factories: [
      // 队列已满（2/2），而且队列里已经有一个烤鱼；待收 5 个
      {
        buildingId: '1食品厂', type: '食品厂', level: 3,
        queue: [
          { idx: 1, productId: '烤鱼', finishAt: now + 125 },
          { idx: 2, productId: '刺身拼盘', finishAt: 0 },
        ],
        finished: [{ id: '烤鱼', num: 5 }],
        autoProductId: null,
      },
      { buildingId: '1A食品厂B', type: '食品厂B', level: 1, queue: [], finished: [], autoProductId: '' },
    ],
  };
  const view = viewFactories(survey, { config });
  const [main, second] = view.factories;

  assert.equal(main.full, true, '2 个队列项 + 上限 2 = 满');
  assert.equal(main.finishedTotal, 5, '待收成品数量要累加');
  assert.equal(main.queue[0].produceTime, 300, '队列项要从配方表补上 produceTime，进度条才有分母');
  assert.equal(main.queue[0].pending, false, '有 finishTime 的是队首，正在做');
  assert.equal(main.queue[1].pending, true, 'finishTime 为 0 的是排队项，不能显示成可收取');
  assert.equal(main.queue[1].remain, 0, '排队项 remain 夹到 0，不出负数倒计时');

  // 队首做完但还没被收：finishAt 已经过去 → 仍在做（不是排队），remain 夹到 0 显示「可收取」。
  const done = viewFactories({
    ...survey,
    factories: [{ ...survey.factories[0], queue: [{ idx: 1, productId: '烤鱼', finishAt: now - 5 }] }],
  }, { config });
  assert.equal(done.factories[0].queue[0].pending, false, '已到点的队首不是排队项');
  assert.equal(done.factories[0].queue[0].remain, 0, '已到点的队首不做负数倒计时');

  const baked = main.recipes.find((row) => row.itemId === '烤鱼');
  assert.equal(baked.unlocked, true, 'lv1 的配方在 lv3 已解锁');
  assert.equal(baked.queuedCount, 1, '队列里有 1 个烤鱼：只标注数量，不阻止继续排');
  assert.equal(baked.enough, false, '木材 3 < 5，材料不够');
  assert.deepEqual(baked.costs.map((row) => [row.id, row.have, row.num]), [['鱼', 9, 1], ['木材', 3, 5]]);

  const locked = main.recipes.find((row) => row.itemId === '海藻酒');
  assert.equal(locked.unlocked, false, 'lv9 的配方在 lv3 未解锁');
  assert.equal(locked.enough, false, '海藻是 0 个');

  const only = second.recipes.find((row) => row.itemId === '酒精');
  assert.equal(second.recipes.length, 1, '食品厂B 只认自己的配方');
  assert.equal(only.enough, false, '小麦 0 < 3');

  // 仓库到上限时即使材料够也不能再造：atCap 是前端禁用的依据之一。
  const capped = viewFactories({ ...survey, stock: new Map([['烤鱼', 50], ['鱼', 99], ['木材', 99]]), stockCap: 50 }, { config });
  assert.equal(capped.factories[0].recipes.find((row) => row.itemId === '烤鱼').atCap, true, '产品到存量上限要标 atCap');
  assert.equal(capped.factories[0].recipes.find((row) => row.itemId === '烤鱼').enough, true, 'atCap 与材料够不够是两件事');

  // 持有量要算「仓库 + 工厂待收 + 队列在造」，只算仓库会漏掉待收那部分而误放行。
  // 这个工厂：待收 烤鱼×5 + 队列里 1 个烤鱼 = 6，所以仓库 44 就已经顶到 50。
  const edge = viewFactories({ ...survey, stock: new Map([['烤鱼', 44], ['鱼', 99], ['木材', 99]]), stockCap: 50 }, { config });
  const edgeFish = edge.factories[0].recipes.find((row) => row.itemId === '烤鱼');
  assert.equal(edgeFish.inStock, 44, 'inStock 只算仓库');
  assert.equal(edgeFish.inFactory, 6, 'inFactory = 待收 5 + 队列 1');
  assert.equal(edgeFish.held, 50, 'held 是三者之和');
  assert.equal(edgeFish.atCap, true, '仓库 44 + 工厂 6 = 50，恰好到上限就该判满');
  const under = viewFactories({ ...survey, stock: new Map([['烤鱼', 43], ['鱼', 99], ['木材', 99]]), stockCap: 50 }, { config });
  assert.equal(under.factories[0].recipes.find((row) => row.itemId === '烤鱼').atCap, false, '差 1 个时不算满');
  assert.equal(edgeFish.capKind, 'total', '两边都没单独到上限、合计到了 → total');

  // capKind 用来决定提示给什么建议：工厂囤满该「收成」，仓库满则收成没用（只会更满）。
  const factoryFull = viewFactories({
    ...survey,
    stock: new Map([['鱼', 99], ['木材', 99]]),
    factories: [{ ...survey.factories[0], queue: [], finished: [{ id: '烤鱼', num: 50 }] }],
  }, { config });
  assert.equal(factoryFull.factories[0].recipes.find((row) => row.itemId === '烤鱼').capKind, 'factory', '工厂囤满 50 → capKind=factory');
  const stockFull = viewFactories({
    ...survey,
    stock: new Map([['烤鱼', 50], ['鱼', 99], ['木材', 99]]),
    factories: [{ ...survey.factories[0], queue: [], finished: [] }],
  }, { config });
  assert.equal(stockFull.factories[0].recipes.find((row) => row.itemId === '烤鱼').capKind, 'stock', '仓库满 50 → capKind=stock');

  // 缺料时页面要能说清「差多少、花几个包」。配置里没有自选包表 → 换不出来，packable 必须是 false，
  // 否则页面会给出一个点了必然失败的「兑料并制造」按钮。
  const noLib = main.recipes.find((row) => row.itemId === '烤鱼');
  assert.equal(noLib.packable, false, '没有自选包表就补不了');
  assert.deepEqual(noLib.unpackable, ['木材'], '要指名哪个材料换不出来');

  // 有原料自选包：缺口能被补齐 → packable + 明确的消耗文案（一包换一个单位）。
  const packConfig = { tables: { ...config.tables, SelectPackLibCfg: { data: [
    { itemId: '原料自选包', selectItemId: '木材', type: '道具', num: 1, season: 1 },
    { itemId: '原料自选包', selectItemId: '鱼', type: '道具', num: 1, season: 1 },
  ] } } };
  const withPacks = viewFactories(
    { ...survey, stock: new Map([['鱼', 9], ['木材', 3], ['原料自选包', 20]]) },
    { config: packConfig },
  );
  const payByPack = withPacks.factories[0].recipes.find((row) => row.itemId === '烤鱼');
  assert.equal(payByPack.enough, false, 'enough 只反映库存，不因为能兑就变成 true');
  assert.equal(payByPack.packable, true, '原料自选包够 → 可以兑料补齐');
  assert.equal(payByPack.packText, '原料自选包×2', '缺 2 个木材 = 2 个包，文案要写明花几个');
  assert.deepEqual(payByPack.packNeeds, [{ pack: '原料自选包', num: 2 }], '按包合并成一份消耗');

  // 包不够补齐 → 不许给按钮（点了也白点）。
  const poorPacks = viewFactories(
    { ...survey, stock: new Map([['鱼', 9], ['木材', 3], ['原料自选包', 1]]) },
    { config: packConfig },
  );
  assert.equal(poorPacks.factories[0].recipes.find((row) => row.itemId === '烤鱼').packable, false,
    '只有 1 个包，补不齐 2 个木材');

  // 一包换多个单位时按 ceil(缺口 / per) 算，不能一律当成一包一个。
  const bulkConfig = { tables: { ...config.tables, SelectPackLibCfg: { data: [
    { itemId: '原料自选包', selectItemId: '木材', type: '道具', num: 5, season: 1 },
  ] } } };
  const bulk = packCoverPlan(bulkConfig, { costs: [{ id: '木材', num: 12 }], stock: new Map([['木材', 2], ['原料自选包', 9]]) });
  assert.equal(bulk.ok, true, '缺 10 个、一包给 5 个 → 2 个包够了');
  assert.equal(bulk.needs[0].num, 2, 'ceil(10 / 5) = 2 个包');

  // 稀有包不参与：「布匹」只存在蓝装材料包里，工厂页绝不能提议烧它。
  const rareConfig = { tables: { ...config.tables, SelectPackLibCfg: { data: [
    { itemId: '蓝装材料自选包', selectItemId: '木材', type: '道具', num: 1, season: 1 },
  ] } } };
  const rare = packCoverPlan(rareConfig, { costs: [{ id: '木材', num: 5 }], stock: new Map([['木材', 0], ['蓝装材料自选包', 99]]) });
  assert.equal(rare.ok, false, '稀有包不算「能补」');
  assert.deepEqual(rare.unpackable.map((gap) => gap.id), ['木材'], '并且指名换不出来');
  checked += 1;
}

// 协议日志会记出站 body（查「这一轮排了什么」靠它），但 LoginRequest 的 body 里是
// openId / token / sign。这组断言是防回归的锁：谁把 LoginRequest 从 SECRET_FRAMES 拿掉，
// 凭证就会开始往 data/protocol.log 里写。
{
  assert.ok(SECRET_FRAMES.has('LoginRequest'), 'LoginRequest 必须留在 SECRET_FRAMES 里，否则 token/sign 会落盘');
  assert.ok(!SECRET_FRAMES.has('StartFactoryProduceRequest'), '普通业务请求要能记录 body，否则查不出排产了什么');

  assert.equal(clipBody({ buildingId: '1食品厂', productId: '烤鱼' }), '{"buildingId":"1食品厂","productId":"烤鱼"}');
  assert.equal(clipBody({}), '{}');
  assert.equal(clipBody(null), '');
  const long = clipBody({ text: 'x'.repeat(1000) }, 20);
  assert.equal(long.length, 21, `截断后应保留 20 字符 + 省略号，实际 ${long.length}`);
  assert.ok(long.endsWith('…'));
  checked += 1;
}

// 回包归档：落盘必须是同步的（CLI 连一次就退出，异步缓冲会丢尾巴），
// 目录按本地日期切，噪音帧不写，文件名不允许逃出目录。
{
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const archive = await import('./archive.mjs');

  assert.equal(archive.clipBody({ a: 1 }), clipBody({ a: 1 }), 'clipBody 只有 archive 一份实现，client 是转出去的');
  assert.ok(archive.SECRET_FRAMES.has('LoginRequest'), '凭证帧要在 archive 的排除表里');

  assert.ok(archive.NOISE_FRAMES.has('PingRequest'), '心跳不该进日志与归档');
  assert.ok(archive.NOISE_FRAMES.has('Ack'), '序号确认不该进日志与归档');
  assert.equal(archive.NOISE_FRAMES.has('AllItemResponse'), false, '业务回包要留');

  assert.equal(archive.safeName('a/b c'), 'a_b_c', '文件名不能带路径分隔符');
  assert.equal(archive.safeName('..'), '..', '点号本身允许，但外面还有一层日期目录兜着');

  const noon = new Date(2026, 9, 23, 12, 0, 0).getTime();
  assert.equal(archive.dayOf(noon), '2026-10-23', '按本地日期切目录，不是 UTC');
  // 日志时间戳也必须用本地时间：用 toISOString() 的话东八区下比目录日期早 8 小时，
  // 事后再按「今天这一轮」对日志和归档目录就对不上。
  // 格式固定 `YYYY-MM-DD HH:mm:ss.SSS`：不带 ISO 的 `T` 和 `+08:00`（全机东八区，偏移没信息量）。
  const stamp = archive.stamp(noon);
  assert.match(stamp, /^2026-10-23 12:00:00\.000$/, '日志时间戳是本地时间，空格分隔且不带时区后缀');
  assert.equal(stamp.slice(0, 10), archive.dayOf(noon), '日志日期与归档目录日期必须是同一天');
  assert.equal(archive.archivePath('AllItemResponse', noon, '/tmp/r'), path.join('/tmp/r', '2026-10-23', 'AllItemResponse.jsonl'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-archive-'));
  const file = path.join(dir, 'x.jsonl');
  archive.appendLine(file, 'a\n');
  archive.appendLine(file, 'b\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n', '同步写：函数返回时字节已经在磁盘上');
  archive.appendLine(file, 'cccc\n', { rotateAt: 4 });
  assert.equal(fs.existsSync(`${file}.1`), true, '超过上限要轮转，不能让单个日志无限涨');
  assert.equal(fs.readFileSync(file, 'utf8'), 'cccc\n', '轮转后新文件从头写');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'a\nb\n', '旧内容整段留在 .1');

  // 网页运行记录（人话日志）：以前只存在内存的 400 条里，刷新或重启就没了。
  // 现在一条一行落到 data/console/<本地日期>.log，格式要和 protocol.log 对得上。
  assert.equal(archive.consoleLogPath(noon), path.join(archive.CONSOLE_ROOT, '2026-10-23.log'), '运行记录同样按本地日期切文件');
  const oneLine = archive.formatConsoleLine({ t: noon, level: 'warn', message: '心跳超时\n连接可能断了', account: 'c06ad6ea-1111-2222-3333', extra: { detail: 'x' } });
  assert.equal(
    oneLine,
    `${stamp} [c06ad6ea] [warn] 心跳超时 ⏎ 连接可能断了 {"detail":"x"}`,
    '一条日志必须落成一行：多行消息要折叠，账号只留前 8 位，跟 protocol.log 的 tag 一致',
  );
  assert.equal(
    archive.formatConsoleLine({ t: noon, level: 'info', message: '已进入游戏' }),
    `${stamp} [info] 已进入游戏`,
    '没有账号和 extra 时不留多余空格',
  );
  const consoleFile = path.join(dir, 'console.log');
  archive.appendConsole({ t: noon, level: 'info', message: '第一行' }, { file: consoleFile });
  archive.appendConsole({ t: noon + 1000, level: 'error', message: '第二行', account: 'c06ad6ea' }, { file: consoleFile });
  assert.equal(
    fs.readFileSync(consoleFile, 'utf8'),
    `${stamp} [info] 第一行\n${archive.stamp(noon + 1000)} [c06ad6ea] [error] 第二行\n`,
    '同步追加：函数返回时两条都已经在磁盘上',
  );
  assert.ok(archive.listConsoleDays(dir).length === 0, 'listConsoleDays 只认 <日期>.log，临时文件名不该被当成日期');
  fs.rmSync(dir, { recursive: true, force: true });
  checked += 1;
}

// 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级）：三条判据全部照抄客户端，
// 最要紧的是「升级会重置本段计时」这条不变量 —— 它决定了几时能升、以及升级必须等收益领到手。
{
  const { afkMaxLevel, nextLevelReward, planAfkUpgrade, planIdle, formatIdleSummary, runIdle, AFK_LV_ITEM } = await import('./idle.mjs');

  const offline = (level, stage, cost = 1) => ({ level, stage, consume: [AFK_LV_ITEM, cost] });
  const config = {
    tables: {
      // 主线关卡 = stage + 1。所以 stage 0/5/10 分别对应第 1/6/11 关解锁。
      OfflineCfg: { data: [offline(1, 0), offline(2, 5), offline(3, 10), offline(4, 15)] },
      OfflineLvRewardCfg: { data: [
        { level: 1, reward: [] },
        { level: 2, reward: [['英雄经验', 6000]] },
        { level: 3, reward: [['抽卡券', 1]] },
      ] },
    },
  };

  // 上限由主线关卡决定：maxLevel = OfflineCfg 里 stage <= 主线关卡-1 的最大 level。
  assert.equal(afkMaxLevel(config, 6), 2, '主线第 6 关（stage<=5）只能升到 2 级');
  assert.equal(afkMaxLevel(config, 11), 3, '主线第 11 关才能到 3 级');
  assert.equal(afkMaxLevel(config, null), null, '拿不到主线关卡时返回 null，不能当成「无上限」');

  // reward 为空的行不产出，跳过去找下一个有奖的。
  assert.equal(nextLevelReward(config, 0), 2, '1 级 reward 为空，下一个有奖的是 2 级');
  assert.equal(nextLevelReward(config, 2), 3, '已领到 2 级，下一个是 3 级');
  assert.equal(nextLevelReward(config, 3), null, '都领完了返回 null');

  // 一次能连升 10 / 5 / 1 级，取最高的那档（客户端 _refreshLevelUpBtn 同款）。
  const wide = { tables: { OfflineCfg: { data: Array.from({ length: 12 }, (_, i) => offline(i + 1, 0)) } } };
  assert.equal(planAfkUpgrade(wide, { level: 1, have: 10, maxLevel: 12 }).jump, 10, '徽章够 10 个就一次升 10 级');
  assert.equal(planAfkUpgrade(wide, { level: 1, have: 5, maxLevel: 12 }).jump, 5, '够 5 个就一次升 5 级');
  assert.equal(planAfkUpgrade(wide, { level: 1, have: 4, maxLevel: 12 }).jump, 1, '只够 1 级就升 1 级');
  const poor = planAfkUpgrade(wide, { level: 1, have: 0, maxLevel: 12 });
  assert.equal(poor.jump, 0, '一个徽章都没有就不能升');
  assert.ok(poor.reason.includes(AFK_LV_ITEM), `说明里要点明缺哪个道具，实际：${poor.reason}`);
  const capped = planAfkUpgrade(config, { level: 2, have: 99, maxLevel: 2 });
  assert.equal(capped.jump, 0, '到上限就不能升');
  assert.ok(capped.reason.includes('第 11 关'), `到上限要说清卡在哪一关，实际：${capped.reason}`);

  // 计划顺序：邮件 → 本段收益 → 等级奖励 → 升级（升级挂 after，等本段收益真的领到）。
  const richSurvey = {
    now: 1_000_000,
    // 挂机 3 级、已领到 0 级：2 级的奖励此刻可领（1 级 reward 为空，2 级才有）。
    afk: { level: 3, rewardedLevel: 0, afkStartTime: 900_000, afkFinishTime: 999_000, remainSeconds: 0, ready: true, fresh: false },
    mail: { total: 3, fetched: 3, newCount: 1, ungotCount: 1, claimable: true },

    upgrade: { level: 1, maxLevel: 40, have: 10, need: 10, jump: 10, safe: true, claimable: true, reason: null },
    notes: [],
  };
  const plan = planIdle(richSurvey, { now: 1_000_000, config });
  assert.deepEqual(plan.actions.map((step) => step.kind), ['mailQuickGet', 'afkDraw', 'afkLevelDraw', 'afkUpgrade'], `顺序不对：${plan.actions.map((s) => s.kind)}`);
  const upgradeStep = plan.actions.find((step) => step.kind === 'afkUpgrade');
  assert.equal(upgradeStep.after, 'afkDraw', '升级必须等本段收益领到（升级会重置本段计时）');
  assert.equal(upgradeStep.afterSatisfied, false, '本段不是刚开的，就必须等领取动作');
  assert.deepEqual(upgradeStep.body, { level: 10 }, 'body.level 是「升几级」，不是目标等级');

  // 本段刚开（2 分钟内）时可以不等领取动作直接升 —— 此刻升级损失的是几分钟的收益。
  const freshSurvey = {
    ...richSurvey,
    afk: { ...richSurvey.afk, ready: false, afkStartTime: 999_950, afkFinishTime: 1_028_750, remainSeconds: 28_750, fresh: true },
  };
  const freshPlan = planIdle(freshSurvey, { now: 1_000_000, config });
  assert.equal(freshPlan.actions.some((step) => step.kind === 'afkDraw'), false, '没到封顶就不该领本段收益');
  const freshUpgrade = freshPlan.actions.find((step) => step.kind === 'afkUpgrade');
  assert.ok(freshUpgrade, '本段刚开时也要能升级');
  assert.equal(freshUpgrade.afterSatisfied, true, '本段刚开就不用等领取动作');

  // 概览一行要能看出等级、本段剩余、徽章、邮件。
  const text = formatIdleSummary({ ...freshSurvey, upgrade: { ...freshSurvey.upgrade, need: 1, have: 2, maxLevel: 40 } });
  assert.ok(text.includes('挂机 Lv3'), `概览要有挂机等级，实际：${text}`);
  assert.ok(text.includes('本段还剩'), `概览要有本段剩余时间，实际：${text}`);
  assert.ok(text.includes(AFK_LV_ITEM), `概览要有徽章数量，实际：${text}`);
  assert.ok(text.includes('邮件'), `概览要有邮件状态，实际：${text}`);

  // 执行的硬约束：领本段收益失败了，升级就必须跳过 —— 否则会把累积 7 小时的收益重置掉。
  const fakeProtocol = {
    QuickGotReadEmailRequest: {},
    DrawAfkRewardRequest: {},
    DrawAfkRewardResponse: {},
    UpgradeAfkLevelRequest: {},
    UpgradeAfkLevelResponse: {},
  };
  const sent = [];
  const failingClient = {
    async request(name) {
      sent.push(name);
      throw new Error('server said no');
    },
    async sendWatch(name) { sent.push(name); },
  };
  const depPlan = { actions: [
    { kind: 'afkDraw', request: 'DrawAfkRewardRequest', response: 'DrawAfkRewardResponse', body: {}, label: '本段收益' },
    { kind: 'afkUpgrade', request: 'UpgradeAfkLevelRequest', response: 'UpgradeAfkLevelResponse', body: { level: 1 }, label: '升级', after: 'afkDraw' },
  ] };
  const depRun = await runIdle(failingClient, fakeProtocol, depPlan, { allowMutate: true });
  assert.equal(depRun.results[0].ok, false, '第一条要如实失败');
  assert.equal(depRun.results[1].skipped, true, '收益没领到，升级必须跳过');
  assert.ok(!sent.includes('UpgradeAfkLevelRequest'), '跳过时一个字节都不该发出去');

  // 收益领到之后升级才放行，并且奖励物品要挂回 step（循环日志靠它印「成功 挂机收益 金币×800」）。
  const okClient = {
    async request(name) {
      sent.push(name);
      if (name === 'DrawAfkRewardRequest') return { reward: { assetPackage: { asset: [{ id: 'GOLD', num: 800 }, { id: '加速器', num: 8 }] } } };
      return { level: 2 };
    },
    async sendWatch(name) { sent.push(name); },
  };
  const okPlan = { actions: [
    { kind: 'afkDraw', request: 'DrawAfkRewardRequest', response: 'DrawAfkRewardResponse', body: {}, label: '本段收益' },
    { kind: 'afkUpgrade', request: 'UpgradeAfkLevelRequest', response: 'UpgradeAfkLevelResponse', body: { level: 1 }, label: '升级', after: 'afkDraw' },
  ] };
  const okRun = await runIdle(okClient, fakeProtocol, okPlan, { allowMutate: true });
  assert.equal(okRun.results[1].ok, true, '收益领到后升级要放行');
  assert.deepEqual(okPlan.actions[0].items, [['GOLD', 800], ['加速器', 8]], '奖励物品要挂回 step，日志才印得出具体收益');

  // 循环日志：探测过就印一行概览，被间隔挡住也要说清楚。
  const idleRound = formatLoopRound({
    round: 5, startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: { planned: 0, results: [], notes: [], population: '10/20', floaterLoot: null },
    idle: {
      planned: 1, notes: [], summary: '挂机 Lv1（已领到 0） · 本段已封顶 · 邮件 1 新',
      results: [{ step: { kind: 'afkDraw', items: [['GOLD', 800]], label: '挂机本段收益' }, ok: true }],
    },
    gates: { idle: { enabled: true, everyMs: 300_000, lastAt: 1_700_000_000, waitSeconds: 120, throttled: true } },
  });
  assert.ok(idleRound.includes('挂机领取 计划 1'), `要有挂机领取概览行，实际：\n${idleRound}`);
  assert.ok(idleRound.includes('成功 挂机收益 GOLD×800'), `成功行要带具体收益，实际：\n${idleRound}`);
  assert.ok(idleRound.includes('挂机领取 间隔未到，还差 2 分'), `要有节流提示，实际：\n${idleRound}`);
  checked += 1;
}

// 搁浅的货轮（世界宝藏）：等级多选（默认只抢万吨），一天 3 次奖励封顶，一次压一个货轮。
// 判据全部对齐客户端：state IDLE 且 treasureLootUid = 0 才能派；被占领的也派（排在无人后面）。
{
  const {
    viewTreasure, planTreasure, qualityOf, dailyLimitOf, formatTreasureSummary,
    seasonWindowOf, seasonDaysOf, MAX_GUILD_FLEETS, SEASON_CLOSE_GUARD_SECONDS,
    DEFAULT_COLORS, colorsOf, colorsText, skipUntilOf, rewardCountText, SKIP_MAX_MS,
  } = await import('./treasure.mjs');
  // 耐久口径本身也钉一下：三个玩法共用这一套，写错边界会全段一起错。
  const { fleetDuraPct, fleetDuraOk, DURABILITY_WARN_RATIO } = await import('./world.mjs');
  assert.equal(DURABILITY_WARN_RATIO, 0.8, '官方提示线 1600 / 2000 = 80%');
  assert.equal(fleetDuraPct({ durability: 1600, maxDurability: 2000 }), 0.8);
  assert.equal(fleetDuraPct({ durability: 0, maxDurability: 0 }), 1, '拿不到上限就当满耐久（否则整块玩法被关掉）');
  // 严格小于：官方提示是「低于 1600 才降输出」，所以 1600 本身仍可派、1599 才修。
  assert.equal(fleetDuraOk({ durability: 1600, maxDurability: 2000 }, 0.8), true, '刚好 1600 可以用');
  assert.equal(fleetDuraOk({ durability: 1599, maxDurability: 2000 }, 0.8), false, '1599 < 1600 要修');
  assert.equal(fleetDuraOk({ durability: 0, maxDurability: 2000 }, 0), true, 'floor=0 表示不拦');
  const config = { tables: {
    TreasureLootCfg: { data: [
      { quality: 'BLUE', qualityIndex: 1, name: '小型货轮', score: 900 },
      { quality: 'PURPLE', qualityIndex: 2, name: '中型货轮', score: 1500 },
      { quality: 'ORANGE', qualityIndex: 3, name: '万吨货轮', score: 3000 },
    ] },
    TreasureLootParamCfg: { data: [{ paramName: '每日宝藏奖励次数', paramValue: 3 }] },
    WorldParamCfg: { data: [{ paramName: '进攻宝藏消耗汽油', paramValue: 500 }] },
  } };

  // 协议 color 是全局品质枚举（3 蓝 / 4 紫 / 5 橙），货轮表用 qualityIndex = color - 2。
  // 抓包实测：color 3 给「蓝装材料自选包」，color 4 给「紫装材料自选包」—— 这个偏移是硬事实。
  assert.equal(qualityOf(config, 3).name, '小型货轮', 'color 3 → 小型货轮');
  assert.equal(qualityOf(config, 4).name, '中型货轮', 'color 4 → 中型货轮');
  assert.equal(qualityOf(config, 5).name, '万吨货轮', 'color 5 → 万吨货轮');
  assert.equal(qualityOf(config, 9).name, '货轮（品质 9）', '配置缺档时要降级，不能把货轮丢掉');
  // 等级多选：默认只抢万吨（用户口里的「大货轮」），输入归一成升序去重。
  assert.deepEqual(DEFAULT_COLORS, [5], '默认只抢万吨货轮');
  assert.deepEqual(colorsOf(undefined), [5], '不传等级 → 默认只抢万吨');
  assert.deepEqual(colorsOf([5, 3, 3, 4]), [3, 4, 5], '多选去重并按等级升序');
  assert.deepEqual(colorsOf(4), [4], '单个数字也认');
  assert.deepEqual(colorsOf([]), [], '显式空数组 = 一个都不抢（不能偷偷回退默认）');
  assert.deepEqual(colorsOf([1, 2, 'x', null, 4.7]), [4], '脏值丢掉、小数取整');
  assert.equal(colorsText(config, [5]), '万吨货轮', '文案取配置表名字');
  assert.equal(colorsText(config, [3, 5]), '小型货轮、万吨货轮');
  assert.equal(colorsText(config, []), '未选等级');
  // 上限以服务端为准（TreasureLootStatsResponse.totalRewardTimes），拿不到才回配置表。
  assert.equal(dailyLimitOf(config, { totalRewardTimes: 4 }), 4, '服务端给的上限优先');
  assert.equal(dailyLimitOf(config, null), 3, '服务端没给时回配置表');

  // 活动有效期 = 赛季窗口。世界宝藏没有独立的活动时间字段（SCAllActivity 里没有它），
  // 边界就是赛季结束：赛季一收世界重置、货轮清空；新赛季前 1 小时连船都派不了。
  // 实测 S1：worldOpenTime 1792469292（10-20 00:00）+ 24 天 → 1794499170（11-12 23:59:30），
  // 与 SeasonRankInfoResponse.endTime **完全相等（差 0 秒）**，所以两个来源互为兜底。
  const seasonCfg = { tables: {
    SeasonTaskCfg: { data: [
      { season: 1, stage: 1, lastDay: 2 },
      { season: 1, stage: 12, lastDay: 24 },
      { season: 4, stage: 12, lastDay: 45 },
    ] },
  } };
  assert.equal(seasonDaysOf(seasonCfg, 1), 24, 'S1 赛季 24 天');
  assert.equal(seasonDaysOf(seasonCfg, 4), 45, 'S4 起 45 天');
  assert.equal(seasonDaysOf(seasonCfg, 9), 24, '配置里没有的赛季回退 24 天');
  assert.equal(SEASON_CLOSE_GUARD_SECONDS, 3600, '新赛季前 1 小时封盘（游戏内合服说明）');
  // 服务端给了 endTime 就直接用，不再自己算。
  assert.deepEqual(
    seasonWindowOf(seasonCfg, { worldId: 2001014410, endTimeFromServer: 1794499170 }),
    { season: 1, endAt: 1794499170, source: 'server' },
    '服务端 endTime 优先',
  );
  // 兜底复算：只断言「落在开放日之后的第 24 天 23:59:30」，这样与时区无关
  // （本机 UTC+8 时它就是 1794499170，与上面的服务端值一模一样）。
  const fallback = seasonWindowOf(seasonCfg, { worldId: 2001014410, worldOpenTime: 1792469292 });
  assert.equal(fallback.source, 'config', '没服务端值就走配置复算');
  assert.equal(fallback.season, 1, 'worldId 2001014410 → S1（floor(worldId/1e6%1000)）');
  const fallbackDate = new Date(fallback.endAt * 1000);
  assert.equal(
    fallbackDate.getHours() * 3600 + fallbackDate.getMinutes() * 60 + fallbackDate.getSeconds(),
    23 * 3600 + 59 * 60 + 30,
    '赛季末必须落在当天 23:59:30（服务端给的就是这个秒数）',
  );
  const openDay0 = new Date(1792469292 * 1000);
  openDay0.setHours(0, 0, 0, 0);
  const endDay0 = new Date(fallback.endAt * 1000);
  endDay0.setHours(0, 0, 0, 0);
  assert.equal(Math.round((endDay0 - openDay0) / 86400000), 23, '第 24 天的零点 = 开放日 + 23 天');
  // 两个来源都没有 → endAt = 0，此时必须按「未结束」处理（算不出来不等于活动结束了）。
  assert.equal(seasonWindowOf(seasonCfg, { worldId: 0 }).source, null, '算不出来时 source 为 null');

  const treasure = (over) => ({
    uid: 1, color: 3, name: '小型货轮', quality: 'BLUE', score: 900,
    ownerGuildIdx: 0, ownerFleetNum: 0, progress: 0, gridIdx: 1,
    reward: [{ type: 0, id: '蓝装材料自选包', num: 130 }],
    itemScore: 130, resourceScore: 0, rewardText: '蓝装材料自选包×130',
    ...over,
  });  const fleet = (over) => ({
    buildingId: '1远征船', state: 1, power: 500000, durability: 2000,
    maxDurability: 2000, treasureLootUid: 0, targetGridIdx: 0, ...over,
  });
  const NOW = Math.floor(Date.now() / 1000);
  const surveyFor = (over) => ({
    now: 1000, statsAvailable: true, dailyLimit: 3, todayRewardTimes: 1,
    nextRefreshTime: 0, counts: [], petrol: 5000, petrolCost: 500,
    // 默认给一个「还在有效期内」的赛季窗口，免得每条断言都被「有效期未知」的 note 干扰。
    season: { season: 1, endAt: NOW + 30 * 86400, stopAt: NOW + 30 * 86400 - 3600, source: 'server' },
    treasures: [], fleets: [], ...over,
  });

  // 基本盘：两个无人货轮 + 两艘空闲船 → 一条请求带两艘船，打品质最高的那个。
  // 显式勾上三个等级（默认只勾万吨，这里要测「等级怎么挑」之外的逻辑）。
  const ALL = { config, colors: [3, 4, 5] };
  const pick = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 10 }), treasure({ uid: 11, color: 4, name: '中型货轮', itemScore: 200 })],
    fleets: [fleet({}), fleet({ buildingId: '2远征船', power: 400000 })],
  }), ALL);
  const pickPlan = planTreasure(pick, {});
  assert.equal(pickPlan.actions.length, 1, '一次只排一个动作（一条请求带多艘船）');
  assert.equal(pickPlan.actions[0].request, 'TreasureLootSendFleetsRequest');
  assert.deepEqual(pickPlan.actions[0].body, { uid: 11, fleetBuildingIds: ['1远征船', '2远征船'] },
    '打品质最高的货轮，强船在前，uid 原样回传');
  assert.equal(pickPlan.actions[0].transient, true, '派兵失败多是瞬时状态，不能记进 rejected 永远跳过');

  // 默认配置（不传 colors）只抢万吨：列表里全是小型/中型时一个都不派，并说明是等级没勾。
  const defaultOnly = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 12 }), treasure({ uid: 13, color: 4, name: '中型货轮', itemScore: 900 })],
    fleets: [fleet({})],
  }), { config });
  assert.equal(defaultOnly.targets.length, 0, '默认只抢万吨，小型/中型不碰');
  assert.ok(planTreasure(defaultOnly, {}).notes.some((note) => note.includes('不是勾选的等级')),
    `要说清楚是等级没勾，实际：${planTreasure(defaultOnly, {}).notes.join(' / ')}`);
  // 有万吨时默认配置就只打万吨（哪怕中型物品更多）。
  const defaultBig = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 14, itemScore: 900 }), treasure({ uid: 15, color: 5, name: '万吨货轮', itemScore: 90 })],
    fleets: [fleet({})],
  }), { config });
  assert.deepEqual(defaultBig.targets.map((one) => one.uid), [15], '默认配置只有万吨进候选');
  assert.ok(formatTreasureSummary(defaultBig).includes('抢 万吨货轮'), '概览要印当前抢哪些');

  // 一个等级都不勾 = 明确不抢（不能悄悄回退成默认的万吨）。
  const noneChosen = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 26, color: 5, name: '万吨货轮' })],
    fleets: [fleet({})],
  }), { config, colors: [] });
  assert.equal(noneChosen.targets.length, 0, '等级全不勾就不派');
  assert.ok(noneChosen.notes.some((note) => note.includes('都没勾')), '要说清楚是一个都没勾');
  assert.equal(planTreasure(noneChosen, {}).actions.length, 0, '空选择不派任何船');

  // 有人占领也派（2026-10-26 起）：**等级优先**，同等级里无人占领的先派。
  // 等级排在「有没有人占」前面是刻意的：让"无人占领的中型"盖过"被占的万吨"就等于
  // 「宁愿捡小的也不去抢大的」，与需求相反。
  const occupied = viewTreasure(surveyFor({
    treasures: [
      treasure({ uid: 20, color: 5, name: '万吨货轮', ownerGuildIdx: 2, ownerFleetNum: 3, progress: 40 }),
      treasure({ uid: 21, color: 5, name: '万吨货轮' }),
      treasure({ uid: 27, color: 4, name: '中型货轮', itemScore: 900 }),
    ],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(occupied.targets.length, 3, '无人占领 + 被占着的都算可抢');
  assert.deepEqual(occupied.targets.map((one) => one.uid), [21, 20, 27], '等级优先，同等级里无人占领的在前');
  assert.equal(planTreasure(occupied, {}).actions[0].body.uid, 21, '同等级优先进无人占领的');
  const bigContested = viewTreasure(surveyFor({
    treasures: [
      treasure({ uid: 28, color: 5, name: '万吨货轮', ownerGuildIdx: 2, ownerFleetNum: 3 }),
      treasure({ uid: 29, color: 4, name: '中型货轮', itemScore: 900 }),
    ],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(planTreasure(bigContested, {}).actions[0].body.uid, 28, '被占的万吨优先于无人占领的中型');

  // 只剩被占着的：照样派，label 里写明要打守军。
  const contested = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 22, color: 5, name: '万吨货轮', ownerGuildIdx: 2, ownerFleetNum: 4, progress: 40 })],
    fleets: [fleet({})],
  }), { config });
  const contestedPlan = planTreasure(contested, {});
  assert.equal(contestedPlan.actions.length, 1, '被别人占着也派舰队');
  assert.equal(contestedPlan.actions[0].body.uid, 22, 'uid 就是被占的那个');
  assert.ok(contestedPlan.actions[0].label.includes('守军'),
    `label 要写明打守军，实际：${contestedPlan.actions[0].label}`);

  // 名额只能按**我方**舰队数算：ownerFleetNum 是占领方联盟的船数，别人占满 10 支不代表我们没名额。
  const othersFull = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 23, color: 5, name: '万吨货轮', ownerGuildIdx: 3, ownerFleetNum: MAX_GUILD_FLEETS, progress: 30 })],
    fleets: [fleet({})],
  }), { config });
  assert.equal(othersFull.targets[0].slotsLeft, MAX_GUILD_FLEETS, '别人占满 10 支仍算我方 10 个名额');
  assert.equal(planTreasure(othersFull, {}).actions.length, 1, '别人占满也要派');
  // 我方自己已经 10 支压在上面才该停手。
  const weFull = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 24, color: 5, name: '万吨货轮', ownerGuildIdx: 3, progress: 30 })],
    fleets: Array.from({ length: MAX_GUILD_FLEETS }, (_, index) => fleet({ buildingId: `${index + 1}远征船`, state: 2, treasureLootUid: 24 })),
  }), { config });
  assert.equal(weFull.targets.length, 0, '我方已占满 10 支就不再派');

  // 我方在抢的货轮要看得出来：treasureLootUid 在**航行途中就有值**（实测派兵后立刻回 uid，船还是 MOVING），
  // 所以「货轮列表里 ownerGuildIdx 还是 0」不代表没派 —— 只靠货轮列表会以为没派过，反复派同一批船。
  const ours = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 25 })],
    fleets: [fleet({ state: 2, treasureLootUid: 25 }), fleet({ buildingId: '2远征船', state: 2, treasureLootUid: 25 })],
  }), ALL);
  assert.equal(ours.treasures[0].ourFleets, 2, '按 treasureLootUid 数出我方在抢的舰队');
  assert.ok(formatTreasureSummary(ours).includes('我方 2 支在抢'), '概览要写明我方在抢');

  // 耐久闸（2026-10-27）：配置表 LoadingTipsCfg 的原话是「耐久低于 1600 会降低输出、增加受到的伤害」，
  // 本账号 maxDura 2000 → 1600/2000 = 80%。抢被占的货轮要打守军，耐久不够就先留在港里修。
  const lowDura = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 40, color: 5, name: '万吨货轮' })],
    fleets: [fleet({ durability: 0 }), fleet({ buildingId: '2远征船', durability: 1600 })],
  }), { ...ALL, duraFloor: 0.8 });
  assert.equal(lowDura.groundedFleets.length, 1, '0/2000 的船被耐久闸留下');
  assert.equal(lowDura.groundedFleets[0].buildingId, '1远征船');
  assert.deepEqual(lowDura.idleFleets.map((one) => one.buildingId), ['2远征船'], '1600/2000 刚好 80%，可以派');
  const lowDuraPlan = planTreasure(lowDura, {});
  assert.deepEqual(lowDuraPlan.actions[0].body.fleetBuildingIds, ['2远征船'], '只派耐久达标的船');
  assert.ok(lowDuraPlan.notes.some((note) => note.includes('耐久低于 80%')), '要说明有一艘被耐久闸留下');

  // 全被耐久闸留下：不派船，且原因要写成「先修再抢」（不能静默成「没有空闲舰队」）。
  const allLow = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 41, color: 5, name: '万吨货轮' })],
    fleets: [fleet({ durability: 200 })],
  }), { ...ALL, duraFloor: 0.8 });
  assert.equal(planTreasure(allLow, {}).actions.length, 0, '耐久不够就不派');
  assert.ok(planTreasure(allLow, {}).notes.some((note) => note.includes('先修再抢')), '说明是先修再抢');

  // duraFloor = 0 = 不拦（旧行为）—— 保证这个闸真能关掉。
  const noFloor = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 42, color: 5, name: '万吨货轮' })],
    fleets: [fleet({ durability: 0 })],
  }), { ...ALL, duraFloor: 0 });
  assert.deepEqual(planTreasure(noFloor, {}).actions[0].body.fleetBuildingIds, ['1远征船'],
    'floor=0 时 0 耐久也照派（旧行为）');

  // 每天 3 次奖励：满了就不派（再派等于白烧 500 汽油/船）。
  const full = viewTreasure(surveyFor({
    todayRewardTimes: 3,
    treasures: [treasure({ uid: 30 })],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(full.dailyFull, true, 'todayRewardTimes >= 上限就是满');
  assert.equal(planTreasure(full, {}).actions.length, 0, '奖励次数满了不派');
  assert.ok(planTreasure(full, {}).notes.some((note) => note.includes('今日货轮奖励已满')), '要说清楚是次数满了');

  // 拿不到 Stats 不能猜：上限未知时派出去可能白烧汽油。
  const noStats = viewTreasure(surveyFor({
    statsAvailable: false, todayRewardTimes: null,
    treasures: [treasure({ uid: 31 })], fleets: [fleet({})],
  }), ALL);
  assert.equal(planTreasure(noStats, {}).actions.length, 0, '不知道次数上限就不派');

  // 活动过期就彻底停手 —— 这是给「活动下线后把整块删掉」留的闸门，日志必须说清楚。
  const expired = viewTreasure(surveyFor({
    season: { season: 1, endAt: NOW - 7200, stopAt: NOW - 10800, source: 'server' },
    treasures: [treasure({ uid: 70 })],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(expired.activity.expired, true, 'stopAt 已过就是过期');
  assert.equal(planTreasure(expired, {}).actions.length, 0, '活动过期不再派船');
  assert.ok(planTreasure(expired, {}).notes.some((note) => note.includes('活动已结束')), '要说清楚是活动结束了');
  const expiredText = formatTreasureSummary(expired);
  assert.ok(expiredText.includes('活动已结束') && expiredText.includes('可以删了'),
    `过期后日志要提示「可以删了」，实际：${expiredText}`);

  // 没过期：概览里要印「有效至」+ 还剩多久（用户要的就是"日志里能看见还有多久到期"）。
  const live = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 71 })],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(live.activity.expired, false, '默认窗口是未来 30 天，不算过期');
  assert.ok(formatTreasureSummary(live).includes('有效至'), '正常时概览要印有效期');
  // 有效期为未知时不能因为「算不出来」就停掉功能。
  const unknownSeason = viewTreasure(surveyFor({
    season: { season: 0, endAt: 0, stopAt: 0, source: null },
    treasures: [treasure({ uid: 72 })],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(unknownSeason.activity.unknown, true, '算不出有效期');
  assert.equal(planTreasure(unknownSeason, {}).actions.length, 1, '算不出有效期时照常派（不能因此停功能）');
  assert.ok(planTreasure(unknownSeason, {}).notes.some((note) => note.includes('算不出活动有效期')), '要把未知说出来');

  // 每日奖励次数的显示口径：页面、CLI、日志都用这一句话，别各写一套。
  assert.equal(rewardCountText(full), '已领 3/3（已满，明天 0 点重置）', '满了要说满并交代重置时间');
  const partly = viewTreasure(surveyFor({ todayRewardTimes: 1, treasures: [treasure({ uid: 32 })], fleets: [fleet({})] }), ALL);
  assert.equal(rewardCountText(partly), '已领 1/3（还能领 2 次）', '没满要说还能领几次');
  assert.ok(rewardCountText(noStats).includes('拿不到次数'), '读不到次数也要能显示，不能写成 0');

  // 「今日没机会了」→ 给一个静默窗，循环里连探测都不发（省掉 Stats + List + MyFleets + 赛季四个请求）。
  // 用固定时刻算，才能断言到「次日 0 点」这个具体时间。
  const at1000 = new Date(2026, 9, 26, 10, 0, 0).getTime();
  const fullSkip = skipUntilOf(full, { now: at1000 });
  assert.equal(fullSkip.forever, false, '奖励满了只是等到明天，不是永久停');
  assert.equal(new Date(fullSkip.until).getHours(), 0, '静默到次日 0 点');
  assert.equal(new Date(fullSkip.until).getDate(), 27, '要跨到第二天');
  assert.ok(new Date(fullSkip.until).getTime() > at1000, '静默窗必须在未来');
  assert.ok(fullSkip.reason.includes('今日奖励已满'), `原因要说清是次数满了，实际：${fullSkip.reason}`);
  // 活动结束 → 本季都不用再问。
  assert.equal(skipUntilOf(expired, { now: at1000 }).forever, true, '活动结束是永久静默（不再发探测）');

  // 勾选等级里一个可抢的都没有 → 静默到服务端给的下一个整点刷新。
  const nothingWanted = viewTreasure(surveyFor({
    nextRefreshTime: Math.floor(at1000 / 1000) + 1800,
    treasures: [treasure({ uid: 33, color: 3, name: '小型货轮' })],
    fleets: [fleet({})],
  }), { config });
  assert.equal(nothingWanted.targets.length, 0, '只抢万吨时小型不在候选里');
  assert.equal(skipUntilOf(nothingWanted, { now: at1000 }).until, (Math.floor(at1000 / 1000) + 1800) * 1000,
    '静默到下一个整点刷新');
  // 服务端给了个离谱的刷新时间也不能把挂机静默掉太久。
  const farRefresh = viewTreasure(surveyFor({
    nextRefreshTime: Math.floor(at1000 / 1000) + 40 * 3600,
    treasures: [], fleets: [fleet({})],
  }), { config });
  assert.ok(skipUntilOf(farRefresh, { now: at1000 }).until <= at1000 + SKIP_MAX_MS, '静默窗封顶 12 小时');
  // 只是没空闲船 / 船还在航行：几分钟内自己会变，绝不能静默（否则回来也不派）。
  const noIdle = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 34 })],
    fleets: [fleet({ state: 2 })],
  }), { config });
  assert.equal(skipUntilOf(noIdle, { now: at1000 }).until, 0, '没空闲船不静默（船会回来）');
  assert.equal(skipUntilOf(live, { now: at1000 }).until, 0, '有可抢的货轮就不静默');
  // 读不到次数（statsAvailable false）→ 下一轮还要重试，不能静默。
  assert.equal(skipUntilOf(noStats, { now: at1000 }).until, 0, '读不到次数时不静默，下一轮重试');

  // 舰队筛选：只有 IDLE(1) 且 treasureLootUid = 0 才能派（客户端同款判据）。
  const busy = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 40 })],
    fleets: [
      fleet({ buildingId: '1远征船', state: 2 }),
      fleet({ buildingId: '2远征船', state: 4 }),
      fleet({ buildingId: '3远征船', treasureLootUid: 40 }),
    ],
  }), ALL);
  assert.equal(busy.idleFleets.length, 0, '航行/修理/已经在抢货轮的船都不算空闲');
  const busyPlan = planTreasure(busy, {});
  assert.equal(busyPlan.actions.length, 0, '没有空闲船就不派');
  assert.ok(busyPlan.notes.some((note) => note.includes('没有空闲舰队')), '要说清楚船都去哪了');

  // 条数上限与汽油：maxFleets 截断、汽油不够少派（派到一半卡住比不派更糟）。
  const many = viewTreasure(surveyFor({
    treasures: [treasure({ uid: 50 })],
    fleets: [fleet({}), fleet({ buildingId: '2远征船' }), fleet({ buildingId: '3远征船' })],
  }), ALL);
  assert.equal(planTreasure(many, { maxFleets: 2 }).actions[0].body.fleetBuildingIds.length, 2, 'maxFleets 要截断');
  const poor = viewTreasure(surveyFor({
    petrol: 1200,
    treasures: [treasure({ uid: 51 })],
    fleets: [fleet({}), fleet({ buildingId: '2远征船' }), fleet({ buildingId: '3远征船' })],
  }), ALL);
  assert.equal(planTreasure(poor, {}).actions[0].body.fleetBuildingIds.length, 2, '汽油只够 2 支就只派 2 支');
  assert.ok(planTreasure(poor, {}).notes.some((note) => note.includes('汽油')), '要说清楚是汽油不够');

  // 排序：同品质比**物品件数**，资源（GOLD/RUBY，type 1）只做次级比较。
  // 不这么排的话「GOLD×8300 的金币货轮」会永远排第一 —— radar 里那个打捞宝箱的坑。
  const gold = viewTreasure(surveyFor({
    treasures: [
      treasure({ uid: 60, itemScore: 130, resourceScore: 8300 }),
      treasure({ uid: 61, itemScore: 950, resourceScore: 65 }),
    ],
    fleets: [fleet({})],
  }), ALL);
  assert.equal(planTreasure(gold, {}).actions[0].body.uid, 61, '物品多的优先，金币数量大不顶用');

  // 编码层：uid 是 field 1（tag 0x08），必须真的进帧 —— 少了服务端会当 uid=0 处理。
  const payloadOf = (body) => {
    const frame = codec.encode('TreasureLootSendFleetsRequest', 1, body);
    const headerLen = HEADER_PREFIX + 'TreasureLootSendFleetsRequest'.length + 1;
    return Buffer.from(frame.slice(headerLen)).toString('hex');
  };
  assert.ok(payloadOf({ uid: 57, fleetBuildingIds: ['1远征船'] }).startsWith('08'), '派兵必须带 uid');
  assert.equal(MAX_GUILD_FLEETS, 10, '同联盟最多 10 支占同一个货轮（游戏内说明）');

  // 循环日志：探测过就印一行概览，被间隔挡住也要说清楚。
  const treasureRound = formatLoopRound({
    round: 6, startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: { planned: 0, results: [], notes: [], population: '10/20', floaterLoot: null },
    treasure: {
      planned: 1, notes: [], summary: '今日奖励 1/3（还能领 2 次） · 货轮 7 个（无人 6） · 空闲舰队 2/2',
      results: [{ step: { kind: 'treasureDispatch', label: '派 1远征船 抢「小型货轮」' }, ok: true }],
    },
    gates: { treasure: { enabled: true, everyMs: 60_000, lastAt: 1_700_000_000, waitSeconds: 40, throttled: true } },
  });
  assert.ok(treasureRound.includes('货轮 计划 1'), `要有货轮概览行，实际：\n${treasureRound}`);
  assert.ok(treasureRound.includes('成功 抢货轮'), `成功行要标出抢货轮，实际：\n${treasureRound}`);
  assert.ok(treasureRound.includes('货轮 间隔未到，还差 40 秒'), `要有节流提示，实际：\n${treasureRound}`);

  // 过期那一轮：日志要能一眼看到「活动已结束、这段可以删了」，否则用户不知道该什么时候收手。
  const closedRound = formatLoopRound({
    round: 7, startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: { planned: 0, results: [], notes: [], population: '10/20', floaterLoot: null },
    treasure: {
      planned: 0,
      notes: planTreasure(expired, {}).notes,
      summary: formatTreasureSummary(expired),
      results: [],
    },
  });
  assert.ok(closedRound.includes('货轮 计划 0'), `过期那轮也要有货轮行，实际：\n${closedRound}`);
  assert.ok(closedRound.includes('活动已结束') && closedRound.includes('可以删了'),
    `过期那轮要打印「可以删了」，实际：\n${closedRound}`);
  checked += 1;
}

// 贸易港口（建筑「货轮港口」）：采购中的船逐格交货（cargoIndex 从 1 开始）、航行的船不碰、
// 返航的船领奖。这里钉死的都是「错了不报错、只会白丢物品或被服务端拒」的地方。
{
  const { viewCargo, planCargo, formatCargoSummary, summarizeCargo, secondsOf } = await import('./tradePort.mjs');
  // arriveTime 是**秒**，now 是毫秒 —— 这两个混用是这套协议最容易踩的坑，先钉死。
  const NOW_MS = 1_700_000_000_000;
  assert.equal(secondsOf(NOW_MS), 1_700_000_000, 'arriveTime 是秒，别拿毫秒直接比');
  const NOW_SEC = secondsOf(NOW_MS);
  const slot = (id, num, filled = false) => ({
    asset: { type: 0, id, num },
    filled,
    reward: { asset: [{ type: 1, id: 'EXP', num: 100 }, { type: 1, id: 'GOLD', num: 500 }] },
  });
  const ship = (index, over = {}) => ({ index, status: 0, orderItem: [], arriveTime: 0, reward: [], ...over });

  // 三艘船：1 号采购中且料齐；2 号航行中；3 号已返航可领奖。
  const survey = {
    now: NOW_MS,
    stock: new Map([['铜锭', 11], ['鱼皮风筝', 2], ['淡水', 50], ['吊床', 46]]),
    ships: [
      ship(1, { orderItem: [slot('铜锭', 3), slot('鱼皮风筝', 2), slot('淡水', 4), slot('吊床', 2)] }),
      ship(2, { status: 1, arriveTime: NOW_SEC + 3600, orderItem: [slot('粗纸', 3, true), slot('淡水', 4, true)] }),
      ship(3, { status: 2, arriveTime: NOW_SEC - 60, orderItem: [slot('救生衣', 3, true)] }),
    ],
  };
  const view = viewCargo(survey);
  assert.equal(view.order.length, 1, '1 号船在采购中');
  assert.equal(view.sailing.length, 1, '2 号船在航行');
  assert.equal(view.arrived.length, 1, '3 号船已返航');
  assert.equal(view.nextArriveLeftSeconds, 3600, '最近返航时间按秒算，别多出三位');
  assert.equal(ship(1).status, 0, 'status 0 = 采购中');

  const plan = planCargo(view);
  const fill = plan.actions.find((action) => action.kind === 'cargoFill');
  assert.ok(fill, '料齐的采购船要交货');
  assert.equal(fill.request, 'FillCargoShipRequest');
  assert.equal(fill.response, 'FillCargoShipResponse', '交货有回包，走 request 而不是 sendWatch');
  assert.deepEqual(fill.body, { shipIndex: 1, cargoIndex: [1, 2, 3, 4] }, 'cargoIndex 从 1 开始，一次交满 4 格');
  assert.equal(fill.transient, true, '交货失败多是瞬时状态，不能进跨轮 rejected');
  assert.equal(fill.key, 'cargoFill:1', 'stepKey 取不到 shipIndex，必须显式给 key');
  assert.equal(fill.group, 'cargo:1', '一条船失败不能连累另外两艘');

  const reward = plan.actions.find((action) => action.kind === 'cargoReward');
  assert.ok(reward, '返航的船要领奖');
  assert.equal(reward.request, 'DrawShipRewardRequest');
  assert.deepEqual(reward.body, { index: 3 }, '领奖按船号');
  assert.notEqual(reward.key, fill.key, '领奖与交货的 key 不能撞');
  assert.equal(plan.actions.length, 2, '航行中的 2 号船一个请求都不该发');
  assert.ok(plan.notes.some((note) => note.includes('航行中')), '要说清 2 号船在航行');

  // 缺料：只交够的那几格，缺的只报缺口，绝不替玩家买货。
  const short = viewCargo({
    now: NOW_MS,
    stock: new Map([['铜锭', 3], ['淡水', 1]]),
    ships: [ship(1, { orderItem: [slot('铜锭', 3), slot('鱼皮风筝', 2), slot('淡水', 4), slot('吊床', 2)] })],
  });
  assert.equal(short.order[0].short.length, 3, '三格缺料');
  const shortPlan = planCargo(short);
  assert.deepEqual(shortPlan.actions[0].body.cargoIndex, [1], '只交库存够的第 1 格');
  assert.equal(shortPlan.actions[0].items.length, 1, 'items 只记真正交出去的');
  assert.ok(shortPlan.notes.some((note) => note.includes('淡水 1/4')), '缺口要写清 有/需');

  // 同一件物品被两艘船同时采购（实探里 1 号和 2 号船都要淡水×4）：按船号扣减，不能超卖。
  const clash = viewCargo({
    now: NOW_MS,
    stock: new Map([['淡水', 5]]),
    ships: [
      ship(1, { orderItem: [slot('淡水', 4)] }),
      ship(2, { orderItem: [slot('淡水', 4)] }),
    ],
  });
  const clashPlan = planCargo(clash);
  assert.equal(clashPlan.actions.length, 1, '只有一艘船的淡水够（5 个不够两家各 4 个）');
  assert.equal(clashPlan.actions[0].body.shipIndex, 1, '按船号顺序，先到先得');
  assert.ok(clashPlan.notes.some((note) => note.includes('货船#2')), '被抢空的那艘要有说明');

  // 库存传不进来（探测时没给 stock）时宁可一单不发，也不能按「无限库存」发货。
  const noStock = planCargo(viewCargo({ now: NOW_MS, ships: survey.ships }));
  assert.equal(noStock.actions.filter((action) => action.kind === 'cargoFill').length, 0, '没有库存表就不交货');
  assert.equal(noStock.actions.filter((action) => action.kind === 'cargoReward').length, 1, '领奖不依赖库存');

  // 概览文案 + 收益统计。
  assert.ok(formatCargoSummary(view).includes('货船 3 艘'), '概览要有船数');
  assert.ok(formatCargoSummary({ ships: [], order: [], sailing: [], arrived: [], mismatch: [], nextArriveLeftSeconds: 0 }).includes('没有货船'));
  const gain = summarizeCargo([
    { ok: true, step: { kind: 'cargoFill' }, body: { reward: { asset: [{ id: 'EXP', num: 1563 }, { id: 'GOLD', num: 7391 }] } } },
    { ok: true, step: { kind: 'cargoReward' }, body: { reward: { asset: [{ id: '藏品大师经验', num: 2 }, { id: 'GOLD', num: 100 }] } } },
    { ok: false, step: { kind: 'cargoFill' }, body: null },
  ]);
  assert.deepEqual(gain, [{ id: 'EXP', num: 1563 }, { id: 'GOLD', num: 7491 }, { id: '藏品大师经验', num: 2 }],
    '同一资源要合并，失败的不计');

  // 货船缺口 → 工厂排产需求：只算「采购中」的船、只算「未交且不够」的格子。
  const { cargoDemandOf } = await import('./tradePort.mjs');
  const demandView = viewCargo({
    now: NOW_MS,
    stock: new Map([['铜锭', 1], ['淡水', 50], ['粗纸', 0]]),
    ships: [
      // 采购中：铜锭缺 2（3-1）、淡水够（不出需求）、鱼皮风筝缺 0 库存 2 缺 2。
      ship(1, { orderItem: [slot('铜锭', 3), slot('淡水', 4), slot('鱼皮风筝', 2)] }),
      // 已交的格子不出需求。
      ship(2, { orderItem: [slot('吊床', 2, true)] }),
      // 航行中的船不采购，给它补货纯属占仓库。
      ship(3, { status: 1, arriveTime: NOW_SEC + 3600, orderItem: [slot('粗纸', 3)] }),
    ],
  });
  const demand = cargoDemandOf(demandView);
  assert.equal(demand.get('铜锭'), 2, '缺口 = 需 - 有');
  assert.equal(demand.get('鱼皮风筝'), 2, '库存 0 时缺口就是全额');
  assert.equal(demand.get('淡水'), undefined, '库存够的格子不出需求');
  assert.equal(demand.get('吊床'), undefined, '已交的格子不出需求');
  assert.equal(demand.get('粗纸'), undefined, '航行中的船不出需求');
  assert.equal(cargoDemandOf({ order: [] }).size, 0, '没有采购中的船就是空表');
  checked += 1;
}

// 海盗讨伐（世界地图真出战）：战力必须按赛季查、默认只打首杀等级、一船一海盗。
// 这里钉死的都是「错了不会报错、只会白烧汽油」的地方，所以每条都要有断言。
{
  const { pirateOf, petrolCostOf, seasonOf, viewPirates, planPirates, formatPirateSummary, sweepMaxOf,
    giveUpUntilOf, sweepCountText, POWER_RECHECK_MS } = await import('./pirate.mjs');
  const config = { tables: {
    // 「打野怪消耗汽油」在 WorldParamCfg，不在 PirateParamCfg（后者只有「每日野怪扫荡次数」）。
    WorldParamCfg: { data: [{ paramName: '打野怪消耗汽油', paramValue: 300 }] },
    WorldPirateCfg: { data: [
      // 同 type + level 三个赛季并存：战力差 17 倍。只按 type+level find 会永远命中 S1 那行。
      { season: '1', type: 1, level: 7, power: 458000, showName: '海盗先锋', fixedReward: [['GOLD', 250]] },
      { season: '1', type: 1, level: 8, power: 551000, showName: '海盗先锋', firstKillReward: [['蓝武器材料', 40]], fixedReward: [['GOLD', 250]] },
      { season: '2', type: 1, level: 8, power: 1830000, showName: '海盗先锋', firstKillReward: [['紫武器材料', 40]], fixedReward: [['GOLD', 250]] },
      { season: '10', type: 1, level: 8, power: 9530000, showName: '海盗先锋' },
      { season: '1', type: 3, level: 6, power: 383000, showName: '海盗头目' },
    ] },
  } };

  // 赛季必须参与查表（客户端 WorldIdRule.getSeason = floor(worldId / 1e6 % 1000)）。
  assert.equal(seasonOf({ worldId: 2001014410 }), 1, 'worldId 2001014410 属于 S1');
  assert.equal(seasonOf(null), 0, '拿不到 player 就是赛季未知');
  assert.equal(pirateOf(config, { season: 1, type: 1, level: 8 }).power, 551000, 'S1 用 S1 那一行');
  assert.equal(pirateOf(config, { season: 2, type: 1, level: 8 }).power, 1830000, 'S2 必须用 S2 那一行，不能命中 S1');
  assert.equal(pirateOf(config, { season: 2, type: 1, level: 8 }).exact, true, '命中要标 exact');
  // 赛季未知不能低估（低估 = 派出打不过的船，白烧 300 汽油）；取各赛季最高是保守方向。
  assert.equal(pirateOf(config, { season: 0, type: 1, level: 8 }).power, 9530000, '赛季未知取各赛季最大战力');
  assert.equal(pirateOf(config, { season: 0, type: 1, level: 8 }).exact, false, '不精确命中要能看出来');
  // 表里没有 = 配置过期（返回 null），不能退化成 0 战力 —— 0 会让「需要战力」恒真。
  assert.equal(pirateOf(config, { season: 1, type: 9, level: 1 }), null, '查不到就是 null');
  assert.equal(petrolCostOf(config), 300, '打一次 300 汽油（WorldParamCfg）');
  assert.equal(petrolCostOf({ tables: {} }), 300, '配置读不到时用兜底 300，不能变 0（0 等于无限次）');

  const fleet = (over) => ({ buildingId: '1远征船', state: 1, power: 3000000, durability: 2000, maxDurability: 2000, ...over });
  const survey = ({ pirates = [], killed = new Map(), fleets = [], petrol = 5000, season = 1,
    sweepUsed = 0, sweepMax = 10, sweepLeft = 0 } = {}) => ({
    // sweepTimes 是「已用」次数（服务端原义），sweepLeft 是派生出来的剩余；默认 0 剩余 = 旧行为。
    now: 1000, season, petrol, sweepTimes: sweepUsed, sweepUsed, sweepMax, sweepLeft,
    stock: new Map(), pirates, killed, fleets,
  });
  const pirate = (over) => ({ uid: 1, type: 1, level: 8, gridIdx: 100, cityId: 9, ...over });

  // 默认只打「已击杀最高等级 + 1」（客户端自动讨伐同款）：地图上的 Lv7 已通关，不该再打。
  const noRepeat = viewPirates(survey({
    pirates: [pirate({ uid: 1, level: 7 }), pirate({ uid: 2, level: 8 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
  }), { config });
  assert.equal(noRepeat.targets.length, 1, '只把 Lv8 当目标');
  assert.equal(noRepeat.targets[0].level, 8, '目标是下一个未击杀等级');
  assert.equal(noRepeat.targets[0].firstKill, true, '标成首杀（有 firstKillReward）');
  assert.ok(noRepeat.types[0].reason === '', '有目标时不该给「打不了」的理由');

  // 打开 repeat 才把已通关等级也算进来（只剩固定掉落）。
  const repeated = viewPirates(survey({
    pirates: [pirate({ uid: 1, level: 7 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
  }), { config, repeat: true });
  assert.equal(viewPirates(survey({
    pirates: [pirate({ uid: 1, level: 7 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
  }), { config }).targets.length, 0, '默认不刷已通关等级');
  assert.equal(repeated.targets.length, 1, 'repeat 才把 Lv7 算进来');
  assert.equal(repeated.targets[0].firstKill, false, '重复刷的不是首杀');

  // 同 type 同级的首杀目标只留一个：两艘船同时打两个 Lv8，第二单打完已是「已通关」，白烧 300 汽油。
  const twoLevels = viewPirates(survey({
    pirates: [pirate({ uid: 1 }), pirate({ uid: 2 }), pirate({ uid: 3, type: 3, level: 6 })],
    killed: new Map([[1, 7], [3, 5]]),
    fleets: [fleet({ buildingId: '1远征船' }), fleet({ buildingId: '2远征船', power: 2000000 })],
  }), { config });
  assert.equal(twoLevels.targets.length, 2, '同 type 同级只留一个首杀目标');

  const plan = planPirates(twoLevels);
  assert.equal(plan.actions.length, 2, '两艘空闲船各打一个');
  assert.equal(plan.actions[0].request, 'ChallengePirateRequest', '真出战的请求名（不是 PirateFightRequest）');
  assert.deepEqual(plan.actions[0].body.fleetBuildingIds, ['1远征船'], '一艘船打一个海盗');
  assert.equal(plan.actions[0].body.uid, 1, '最强的那艘先挑等级最高的');
  assert.equal(plan.actions[0].body.cityId, 9, '必须带 cityId');
  assert.equal(plan.actions[0].transient, true, '派兵失败是瞬时状态，不能进跨轮 rejected');
  assert.equal(plan.actions[0].group, 'pirateChallenge:1远征船', '按船隔离失败，别一条失败全废');
  assert.ok(plan.actions[0].label.includes('首杀'), `首杀要说出来，实际：${plan.actions[0].label}`);

  // 战力不够就不派，并且要说清是「战力不够」而不是「没目标了」。
  const weak = planPirates(viewPirates(survey({
    pirates: [pirate({ uid: 1 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet({ power: 500000 })],
  }), { config }));
  assert.equal(weak.actions.length, 0, '500000 < 551000×1.2，不能派');
  assert.ok(weak.notes.some((note) => note.includes('最强空闲船只有')), `要说明战力不够，实际：${weak.notes.join(' / ')}`);

  // 汽油按「这次要烧的量」累计判断：只够一次就只能派一艘。
  const thirsty = planPirates(viewPirates(survey({
    pirates: [pirate({ uid: 1 }), pirate({ uid: 3, type: 3, level: 6 })],
    killed: new Map([[1, 7], [3, 5]]),
    fleets: [fleet({ buildingId: '1远征船' }), fleet({ buildingId: '2远征船', power: 2000000 })],
    petrol: 300,
  }), { config }));
  assert.equal(thirsty.actions.length, 1, '只有 300 汽油就只派一艘');
  assert.ok(thirsty.notes.some((note) => note.includes('汽油只够')), '要说清汽油只够几次');

  const dry = planPirates(viewPirates(survey({
    pirates: [pirate({ uid: 1 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
    petrol: 100,
  }), { config }));
  assert.equal(dry.actions.length, 0, '汽油不够一次就不派');

  // 耐久闸（2026-10-27）：打野怪本身「消耗耐久 = 0」（WorldParamCfg），但耐久 <80% 会
  // 「降低输出、增加受到的伤害」（LoadingTipsCfg），也就是更容易打输、白烧 300 汽油 → 先修再打。
  const lowDura = viewPirates(survey({
    pirates: [pirate({ uid: 1 }), pirate({ uid: 2, type: 3, level: 6 })],
    killed: new Map([[1, 7], [3, 5]]),
    fleets: [fleet({ buildingId: '1远征船', durability: 200 }), fleet({ buildingId: '2远征船', durability: 2000 })],
  }), { config, duraFloor: 0.8 });
  assert.equal(lowDura.groundedFleets.length, 1, '200/2000 = 10% 的船被耐久闸留下');
  assert.equal(lowDura.groundedFleets[0].buildingId, '1远征船');
  assert.deepEqual(lowDura.idleFleets.map((one) => one.buildingId), ['2远征船'], '只有耐久达标的船算空闲');
  assert.equal(lowDura.bestIdlePower, 3000000, '最强空闲船要排除被留下的船（否则误判「打得起」）');
  const lowDuraPlan = planPirates(lowDura);
  assert.equal(lowDuraPlan.actions.length, 1, '只派耐久达标的那艘');
  assert.deepEqual(lowDuraPlan.actions[0].body.fleetBuildingIds, ['2远征船']);

  // 全被耐久闸留下：不派，并且说明是「先去修」，不能说成「没有空闲舰队」。
  const allLow = viewPirates(survey({
    pirates: [pirate({ uid: 1 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet({ durability: 0 })],
  }), { config, duraFloor: 0.8 });
  const allLowPlan = planPirates(allLow);
  assert.equal(allLowPlan.actions.length, 0, '耐久不够就不出战');
  assert.ok(allLowPlan.notes.some((note) => note.includes('先去修')), `要说清是先去修，实际：${allLowPlan.notes.join(' / ')}`);

  // ---- 免战扫荡（2026-10-28 加）----
  // 只能扫「已通关等级」（客户端 PiratePop 的 case 2 条件就是 level <= maxKilledLevel），
  // 次数按「已用 / 上限」算，扫荡不依赖舰队也不烧汽油。
  const sweepConfig = { tables: { ...config.tables, PirateParamCfg: { data: [{ paramName: '每日野怪扫荡次数', paramValue: 10 }] } } };
  assert.equal(sweepMaxOf(sweepConfig), 10, '上限来自 PirateParamCfg.每日野怪扫荡次数');
  assert.equal(sweepMaxOf(config), 10, '配置缺行时兜底 10');

  const sweepView = viewPirates(survey({
    pirates: [
      pirate({ uid: 1, type: 1, level: 7 }),
      pirate({ uid: 2, type: 1, level: 6 }),
      pirate({ uid: 3, type: 2, level: 11 }),
      pirate({ uid: 4, type: 1, level: 20 }), // 没通关过，不能扫
      pirate({ uid: 5, type: 1, level: 8 }), // 下一个首杀等级，真出战用
    ],
    killed: new Map([[1, 7], [2, 11]]),
    fleets: [fleet()],
    sweepUsed: 7,
    sweepMax: 10,
    sweepLeft: 3,
  }), { config: sweepConfig });
  assert.deepEqual(sweepView.sweepTargets.map((one) => one.uid), [3, 1, 2],
    '只有「已通关等级」能扫，等级高的先扫（精锐 Lv11 → 先锋 Lv7 → 先锋 Lv6）');
  assert.equal(sweepView.sweepLeft, 3, '剩余 = 上限 10 − 已用 7');

  const sweepPlan = planPirates(sweepView);
  const sweeps = sweepPlan.actions.filter((a) => a.kind === 'pirateSweep');
  assert.equal(sweeps.length, 3, '剩 3 次就排 3 条');
  assert.equal(sweeps[0].request, 'PirateSweepRequest');
  assert.deepEqual(sweeps[0].body, { uid: 3, cityId: 9 }, 'body 是 uid + cityId（客户端同款）');
  assert.equal(sweeps[0].response, null, '协议表里没有 PirateSweepResponse → 走 sendWatch');
  assert.equal(sweeps[0].transient, true, '次数用完/目标没了都是临时状态，不能进跨轮 rejected');
  assert.equal(sweeps[0].group, 'pirateSweep', '同一 group：一条被拒就停掉剩下的，不会连发十条刷屏');
  assert.equal(new Set(sweeps.map((action) => action.key)).size, 3, 'key 带序号，重复扫同一个 uid 也不撞 key');
  assert.ok(sweeps[0].label.includes('第 8/10 次'), `label 要写第几次，实际：${sweeps[0].label}`);
  assert.ok(sweepPlan.actions.indexOf(sweeps[0]) < sweepPlan.actions.findIndex((a) => a.kind === 'pirateChallenge'),
    '扫荡排在真出战前面（免费的先做）');

  // 一艘空闲船都没有也要扫荡 —— 它不动舰队。
  const noFleetSweep = planPirates(viewPirates(survey({
    pirates: [pirate({ uid: 1, type: 1, level: 7 })],
    killed: new Map([[1, 7]]),
    fleets: [],
    sweepLeft: 2,
  }), { config: sweepConfig }));
  assert.equal(noFleetSweep.actions.filter((a) => a.kind === 'pirateSweep').length, 2, '扫荡不依赖舰队');
  assert.equal(noFleetSweep.actions.filter((a) => a.kind === 'pirateChallenge').length, 0);

  // 默认 sweepLeft = 0（旧行为）不扫；有次数但没「已通关等级」要说清原因。
  assert.equal(planPirates(viewPirates(survey({
    pirates: [pirate({ uid: 1, type: 1, level: 7 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
  }), { config: sweepConfig })).actions.filter((a) => a.kind === 'pirateSweep').length, 0,
  'sweepLeft=0 时一条扫荡都不排');

  const nothingToSweep = planPirates(viewPirates(survey({
    pirates: [pirate({ uid: 1, type: 1, level: 20 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
    sweepLeft: 5,
  }), { config: sweepConfig }));
  assert.equal(nothingToSweep.actions.filter((a) => a.kind === 'pirateSweep').length, 0, '没通关过的等级不能扫');
  assert.ok(nothingToSweep.notes.some((note) => note.includes('已通关等级')),
    `要说明没有可扫目标，实际：${nothingToSweep.notes.join(' / ')}`);

  // 概览行要带「剩 x/上限」，别把已用次数当剩余。
  const sweepSummary = formatPirateSummary(viewPirates(survey({
    pirates: [pirate({ uid: 1, type: 1, level: 7 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet()],
    sweepUsed: 7,
    sweepLeft: 3,
  }), { config: sweepConfig }));
  assert.ok(sweepSummary.includes('免战扫荡剩 3/10'), `概览要写剩余次数，实际：${sweepSummary}`);

  // 概览行：赛季、汽油单价、空闲船、三种 type 的击杀进度都要能看见。
  const summaryText = formatPirateSummary(noRepeat);
  assert.ok(summaryText.includes('S1') && summaryText.includes('每次 300') && summaryText.includes('击杀'),
    `概览要带赛季/汽油/进度，实际：${summaryText}`);

  // 循环日志：这一轮真的探测过就印一行「海盗」（否则看起来像开关没生效）。
  const pirateRound = formatLoopRound({
    round: 7, startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: { planned: 0, results: [], notes: [], population: '10/20', floaterLoot: null },
    pirate: {
      planned: 1, notes: [], summary: 'S1 · 汽油 5000（每次 300） · 空闲船 1/2（最强 300.0万） · 击杀 先锋 7 / 精锐 0 / 头目 0',
      results: [{ step: { kind: 'pirateChallenge', label: '派 1远征船 打 海盗先锋 Lv8' }, ok: true }],
    },
    gates: { pirate: { enabled: true, everyMs: 60_000, lastAt: 1_700_000_000, waitSeconds: 40, throttled: true } },
  });
  assert.ok(pirateRound.includes('海盗 计划 1'), `要有海盗概览行，实际：\n${pirateRound}`);
  assert.ok(pirateRound.includes('成功 讨伐海盗'), `成功行要标出讨伐海盗，实际：\n${pirateRound}`);
  assert.ok(pirateRound.includes('海盗 间隔未到，还差 40 秒'), `要有节流提示，实际：\n${pirateRound}`);

  // ---- 战力不够就先不打（2026-10-30 加）----
  // 用户要求：不是「锁到今天结束」，而是「战力不够之前一直不打」——
  // 暂停到一个复查点（默认 30 分钟），到点看战力，够打了当轮立刻恢复 60 秒节奏。
  const nowMs = 1_700_000_000_000;
  const weakView = viewPirates(survey({
    pirates: [pirate({ uid: 1 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet({ power: 500000 })],
  }), { config });
  const paused = giveUpUntilOf(weakView, { now: nowMs });
  assert.equal(paused.until, nowMs + POWER_RECHECK_MS, '战力不够 → 暂停到下次复查（30 分钟），不是锁到明天 0 点');
  assert.ok(paused.reason.includes('战力不够'), `原因要说人话（战力不够 + 差多少），实际：${paused.reason}`);

  // 战力够 / 关掉开关 → 一秒都不停（旧的 60 秒节奏）。
  assert.equal(giveUpUntilOf(noRepeat, { now: nowMs }).until, 0, '战力够就不暂停');
  assert.equal(giveUpUntilOf(weakView, { now: nowMs, enabled: false }).until, 0, '开关关掉就照旧按间隔重试');

  // 最强的船只是出海了（在航）= 临时状态，等它回来 —— 不能因为「空闲船不够」暂停。
  const busyStrong = viewPirates(survey({
    pirates: [pirate({ uid: 1 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet({ power: 500000 }), fleet({ buildingId: '2远征船', state: 2, power: 3000000 })],
  }), { config });
  assert.equal(busyStrong.bestPowerAll, 3000000, 'bestPowerAll 要算上在航的船');
  assert.equal(giveUpUntilOf(busyStrong, { now: nowMs }).until, 0, '强的船在航不能暂停（几十分钟就回来）');

  // 一艘空闲船都没有（全在海上/在修）也不暂停。
  const noIdle = viewPirates(survey({
    pirates: [pirate({ uid: 1 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet({ state: 2, power: 500000 })],
  }), { config });
  assert.equal(giveUpUntilOf(noIdle, { now: nowMs }).until, 0, '没有空闲船不暂停');

  // 还有免战扫荡次数没用完 → 不暂停（扫荡不动舰队、不烧汽油，跟战力无关，暂停就白丢次数）。
  const withSweep = viewPirates(survey({
    pirates: [pirate({ uid: 1 }), pirate({ uid: 2, level: 7 })],
    killed: new Map([[1, 7]]),
    fleets: [fleet({ power: 500000 })],
    sweepLeft: 4,
  }), { config: sweepConfig });
  assert.equal(withSweep.targets.length, 1, '前提：确实有打不过的目标');
  assert.equal(giveUpUntilOf(withSweep, { now: nowMs }).until, 0, '还有扫荡次数时不能暂停');

  // 扫荡次数的页面文案：已用 / 剩余 两个数都要有（sweepTimes 是「已用」，别写反）。
  assert.equal(sweepCountText(sweepView), '已用 7/10，还剩 3 次', '扫荡文案 = 已用 + 剩余');
  assert.ok(sweepCountText(viewPirates(survey({
    fleets: [fleet()], sweepUsed: 12, sweepMax: 12, sweepLeft: 0,
  }), { config: sweepConfig })).includes('用完了'), '次数用完要说清今天没了');
  checked += 1;
}


// --- 海商王（活动 Trade） --------------------------------------------------
// 判据全部来自实盘：city91 特产布匹 44（基准 50）、紧缺海鲜披萨 316（基准 280）；
// city64 特产海洋球 681（基准 800）、紧缺布匹 56（基准 50）→ 91 买 → 64 卖。
{
  const cfg = {
    tables: {
      ActivityTradeCfg: { data: [
        { key: '海商王行驶时间', value: '120' },
        { key: '海商王加速时长', value: '30' },
        { key: '海商王加速日购买上限', value: '50' },
        { key: '海商王初始货币', value: '10000' },
        { key: '海商王贸易时间', value: '10-22' },
        { key: '海商王刷新时间', value: '10,12,14,16,18,20' },
      ] },
      TradeShipCfg: { data: [
        { lv: 1, profitMargin: 300, capacity: 1000, upMoney: 0, upCost: [] },
        { lv: 2, profitMargin: 600, capacity: 3000, upMoney: 10000, upCost: ['RUBY', 300] },
      ] },
      TradeGoodsCfg: { data: [
        { goodsId: 1005, lv: 1, itemId: '布匹', itemName: '布匹', qualityIndex: 1, unitPrice: 50, maxCount: 60000, capacity: 1 },
        { goodsId: 2007, lv: 2, itemId: '面包', itemName: '面包', qualityIndex: 2, unitPrice: 120, maxCount: 30000, capacity: 2 },
        { goodsId: 3003, lv: 3, itemId: '海鲜披萨', itemName: '海鲜披萨', qualityIndex: 3, unitPrice: 280, maxCount: 15000, capacity: 4 },
        { goodsId: 4010, lv: 4, itemId: '海洋球', itemName: '海洋球', qualityIndex: 4, unitPrice: 800, maxCount: 7000, capacity: 10 },
      ] },
      TradeAchieveRewardCfg: { data: [
        { id: 1001, rewardId: 1, target: 5000, rewards: [['GOLD', 50000]] },
        { id: 1001, rewardId: 2, target: 10000, rewards: [['抽卡券', 10]] },
      ] },
      TradeGuildTaskCfg: { data: [
        { id: 1, day: 1, taskType: 0, tragetCount: 50000, rewards: [['海商王加速', 2]] },
        { id: 4, day: 1, taskType: 1, tragetCount: 50, rewards: [['海商王加速', 2]] },
      ] },
      TradeDayRewardCfg: { data: [{ id: 1, roleNum: 5, rewards: [['海商王加速', 2]] }] },
      // 战令免费档：reqScore 就是累计利润，1 利润 = 1 积分（客户端 tips 原文）。
      TradePassCfg: { data: [
        { period: 1001, rwdId: 1, reqScore: 1000, freeReward: [['海商王加速', 1]], payReward: [] },
        { period: 1001, rwdId: 2, reqScore: 3300, freeReward: [['RUBY', 100]], payReward: [] },
        { period: 1001, rwdId: 3, reqScore: 7800, freeReward: [['海商王加速', 1]], payReward: [] },
      ] },
    },
  };
  // 雷达是一张配对表：91 特产布匹 → 64 的紧缺是布匹；64 特产海洋球 → 97 的紧缺是海洋球。
  const radar = { radar: [
    { cityId: 91, specGoodsId: 1005, rareGoodsId: 3003, reportName: '我' },
    { cityId: 64, specGoodsId: 4010, rareGoodsId: 1005, reportName: '甲' },
    { cityId: 97, specGoodsId: 3003, rareGoodsId: 4010, reportName: '乙' },
  ] };
  const shelf = [
    { goodsId: 4010, stock: 7, price: 752 },
    { goodsId: 1005, stock: 1292, price: 44 },
    { goodsId: 3003, stock: 0, price: 316 },
    { goodsId: 2007, stock: 0, price: 115 },
  ];
  const dockSurvey = (over = {}) => ({
    now: new Date(2026, 9, 27, 10, 30, 0).getTime(),
    period: 1001,
    docked: true,
    radar,
    city: { goods: shelf, specGoodsId: 1005, rareGoodsId: 3003, isReport: false },
    speedItems: 0,
    info: {
      period: 1001,
      player: { coins: 10000, maxCoins: 10000, profit: 0, goods: [], buySpeedTimes: 0 },
      cargo: { cargoLv: 1, cityId: 91, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 },
      gotAchieveRwdId: 0,
      gotReportRwdId: 0,
      guildReportNum: 0,
      guildTask: { profit: 60000, tradeTimes: 10, gotTaskId: [] },
      ...over,
    },
  });

  // 1. 时间闸门：10~22 点开市，下一次开市 / 下一次刷新价都要算对。
  const params = tradeParams(cfg);
  assert.equal(params.sailMinutes, 120, '行驶时间 120 是**分钟**');
  assert.equal(params.speedMinutes, 30, '指针 30 分钟');
  const openNow = tradeWindow(new Date(2026, 9, 27, 10, 30, 0).getTime(), params);
  assert.equal(openNow.open, true, '10:30 应该开市');
  const early = tradeWindow(new Date(2026, 9, 27, 9, 30, 0).getTime(), params);
  assert.equal(early.open, false, '9:30 未开市');
  assert.equal(new Date(early.startAt * 1000).getHours(), 10, '未开市时给出今天 10 点');
  const late = tradeWindow(new Date(2026, 9, 27, 22, 10, 0).getTime(), params);
  assert.equal(late.open, false, '22:10 已收市');
  assert.equal(new Date(late.startAt * 1000).getDate(), 28, '收市后给出明天 10 点');
  assert.equal(new Date(nextRefreshAt(new Date(2026, 9, 27, 10, 30, 0).getTime(), params) * 1000).getHours(), 12,
    '10:30 之后的下一个刷新点是 12 点');

  // 2. 视图：系数 / 可买量 / 配对 / 特产卖点。
  const dock = viewTradeKing(dockSurvey(), { config: cfg });
  assert.equal(dock.cargo.phase, 'dock', '停港时 phase=dock');
  const cloth = dock.shelf.find((row) => row.goodsId === 1005);
  assert.ok(Math.abs(cloth.ratio - 0.88) < 1e-9, `布匹系数应是 0.88，实际 ${cloth.ratio}`);
  assert.equal(cloth.avail, 60000 - 1292, '可买量 = maxCount − 已卖出的 stock');
  assert.equal(dock.specSellCity, 64, '91 的特产布匹要卖到 64');
  assert.equal(dock.rareCityOf[4010], 97, '海洋球的紧缺港口是 97');
  // 紧缺货 3003 的配对港口就是本港（91）→ 不能算可买（货物不能在买入港出售）。
  const pizza = dock.candidates.find((row) => row.goodsId === 3003);
  assert.ok(pizza === undefined || pizza.sure === false, '本港紧缺的货不算「有确切卖点」');

  // 3. 计划（在港、开市）：共享商情 + 买特产 + 起航 64。
  const plan = planTradeKing(dock, { config: cfg });
  const kinds = plan.actions.map((a) => a.kind);
  assert.ok(kinds.includes('tradeShare'), '未共享过的港口要共享商情');
  const buy = plan.actions.find((a) => a.kind === 'tradeBuy');
  assert.ok(buy, '开市时应该买货');
  assert.equal(buy.body.goodsId, 1005, '买本港特产布匹');
  // 10000 商会币 / 44 = 227 件；舱位 1000（每件占 1）也不挡 → 227。
  assert.equal(buy.body.buyNum, 227, `应该买满 227 件，实际 ${buy.body.buyNum}`);
  assert.equal(plan.actions.find((a) => a.kind === 'tradeSail').body.mvToCityId, 64, '起航去 64 卖布匹');
  assert.ok(!kinds.includes('tradeSpeed'), '没有指针就不发加速');

  // 4. 10 点前：只领奖，买卖与起航都不发（实盘 09:3x 买入返回 `not trade time`）。
  const preopen = viewTradeKing({ ...dockSurvey(), now: new Date(2026, 9, 27, 9, 30, 0).getTime() }, { config: cfg });
  const prePlan = planTradeKing(preopen, { config: cfg });
  assert.ok(prePlan.actions.every((a) => a.kind !== 'tradeBuy' && a.kind !== 'tradeSail' && a.kind !== 'tradeSell'),
    '10 点前不发买卖/起航');
  assert.ok(prePlan.notes.some((note) => note.includes('不在贸易时间')), '要说明不在贸易时间');

  // 5. 卖货：客户端同款算法 ceil(buyPrice*n + ceil((price-buyPrice)*n*(1+margin/1e4)))。
  // 到港后的货架：布匹 56（64 的紧缺货）、海洋球 681（64 的特产）、海鲜披萨 253。
  const arriveSurvey = () => ({
    now: new Date(2026, 9, 27, 12, 30, 0).getTime(),
    period: 1001,
    docked: true,
    radar,
    city: {
      goods: [
        { goodsId: 1005, stock: 0, price: 56 },
        { goodsId: 4010, stock: 0, price: 681 },
        { goodsId: 3003, stock: 0, price: 253 },
      ],
      specGoodsId: 4010,
      rareGoodsId: 1005,
      isReport: true,
    },
    speedItems: 8,
    info: {
      period: 1001,
      player: {
        coins: 3200, maxCoins: 10000, profit: 0, buySpeedTimes: 0,
        goods: [{ pid: 7, goodsId: 1005, num: 100, buyPrice: 44, cityId: 91 }],
      },
      cargo: { cargoLv: 1, cityId: 64, moveStartTime: 1, moveEndTime: 0, moveToCityId: 0 },
      gotAchieveRwdId: 0,
      gotReportRwdId: 0,
      guildReportNum: 0,
      guildTask: { profit: 0, tradeTimes: 0, gotTaskId: [] },
    },
  });
  const holding = viewTradeKing(arriveSurvey(), { config: cfg });
  const sellPlan = planTradeKing(viewTradeKing(arriveSurvey(), { config: cfg }), { config: cfg });
  const sell = sellPlan.actions.find((a) => a.kind === 'tradeSell');
  assert.ok(sell, '有盈利持仓时要卖');
  assert.equal(sell.body.pid, 7, '卖货要带 pid');
  assert.equal(sell.body.sellNum, 100, '一次全卖');
  // 100 × (56−44) × 1.03 = 1236 利润；收入 = 4400 + 1236 = 5636。
  const soldRow = holding.sellable[0];
  assert.equal(soldRow.profit, 1236, `利润应是 1236，实际 ${soldRow.profit}`);
  assert.equal(soldRow.revenue, 5636, `收入应是 5636，实际 ${soldRow.revenue}`);
  // 卖完的商会币 3200+5636=8836 → 买 64 的特产海洋球 681/件 = 12 件（舱位 120）。
  const rebuy = sellPlan.actions.find((a) => a.kind === 'tradeBuy');
  assert.ok(rebuy, '卖完要接着买');
  assert.equal(rebuy.body.goodsId, 4010, '在 64 买特产海洋球');
  assert.equal(rebuy.body.buyNum, 12, `8836 / 681 应买 12 件，实际 ${rebuy.body.buyNum}`);
  assert.equal(sellPlan.actions.find((a) => a.kind === 'tradeSail').body.mvToCityId, 97, '海洋球要卖到 97');
  // 8 个指针 → 4 个把 2 小时航程直接抹平。
  const speed = sellPlan.actions.find((a) => a.kind === 'tradeSpeed');
  assert.ok(speed && speed.body.useNum === 4, '指针够就一次用满 4 个（客户端滑块上限就是 4）');

  // 6. 亏本不卖：本港只卖 30，低于买入价 44 → 留着，不发 TradeSellRequest。
  const losing = viewTradeKing({
    ...dockSurvey({
      player: {
        coins: 100, maxCoins: 10000, profit: 0, buySpeedTimes: 0,
        goods: [{ pid: 9, goodsId: 1005, num: 10, buyPrice: 44, cityId: 91 }],
      },
      cargo: { cargoLv: 1, cityId: 64, moveStartTime: 1, moveEndTime: 0, moveToCityId: 0 },
    }),
    // 64 这一天布匹只卖 30（低于买入价 44）→ 亏本，留着等贵的港口。
    city: { goods: [{ goodsId: 1005, stock: 0, price: 30 }, { goodsId: 4010, stock: 0, price: 681 }], specGoodsId: 4010, rareGoodsId: 1005, isReport: true },
  }, { config: cfg });
  assert.equal(losing.sellable[0].profitable, false, '低于买入价不算可卖');
  const losingPlan = planTradeKing(losing, { config: cfg });
  assert.ok(!losingPlan.actions.some((a) => a.kind === 'tradeSell'), '亏本不卖');
  assert.ok(losingPlan.notes.some((note) => note.includes('留着')), '要说清为什么留着');

  // 7. 在航：只发加速，不发买卖/起航。
  const sailing = viewTradeKing({
    now: new Date(2026, 9, 27, 13, 0, 0).getTime(),
    period: 1001,
    docked: false,
    radar,
    city: null,
    speedItems: 3,
    info: {
      period: 1001,
      player: { coins: 500, maxCoins: 10000, profit: 0, goods: [], buySpeedTimes: 0 },
      // moveEndTime 是**秒级**；这里取「现在 + 1 小时」，保证判成在航。
      cargo: {
        cargoLv: 1,
        cityId: 64,
        moveStartTime: Math.floor(new Date(2026, 9, 27, 13, 0, 0).getTime() / 1000) - 60,
        moveEndTime: Math.floor(new Date(2026, 9, 27, 13, 0, 0).getTime() / 1000) + 3600,
        moveToCityId: 97,
      },
      gotAchieveRwdId: 0,
      gotReportRwdId: 0,
      guildReportNum: 0,
      guildTask: { profit: 0, tradeTimes: 0, gotTaskId: [] },
    },
  }, { config: cfg });
  const sailPlan = planTradeKing(sailing, { config: cfg });
  assert.equal(sailPlan.actions.filter((a) => a.kind === 'tradeSpeed').length, 1, '在航只发加速');
  assert.ok(!sailPlan.actions.some((a) => a.kind === 'tradeBuy' || a.kind === 'tradeSail'), '在航不买卖不起航');

  // 8. 领奖：成就（profit > target 才领，客户端同款严格大于）/ 联盟任务 / 商情奖励。
  const richPlan = planTradeKing(viewTradeKing(dockSurvey({
    player: { coins: 5000, maxCoins: 60000, profit: 12000, goods: [], buySpeedTimes: 0 },
    guildReportNum: 6,
  }), { config: cfg }), { config: cfg });
  assert.ok(richPlan.actions.some((a) => a.kind === 'tradeAchieve'), '利润过线要领成就');
  assert.ok(richPlan.actions.some((a) => a.kind === 'tradeTask' && a.body.taskId === 1), '联盟利润过线要领任务 1');
  assert.ok(richPlan.actions.some((a) => a.kind === 'tradeReportReward'), '商情共享 6/5 要领奖励');

  // 8.5 紧缺货每天 10 点重置：没被共享过的港口 rare=0 = **不知道**，不能当「没有卖点」也不能瞎猜。
  // 实盘 10:00 重置后 17 个港只剩 3 个有 rare，若不区分就会把「不知道」当成「没有」→ 一单都不敢做，
  // 或者按昨天的配对瞎买 → 货砸手里。
  const sparseRadar = { radar: [
    { cityId: 91, specGoodsId: 1005, rareGoodsId: 0, reportName: '' },
    { cityId: 64, specGoodsId: 4010, rareGoodsId: 1005, reportName: '我' },
    { cityId: 97, specGoodsId: 3003, rareGoodsId: 0, reportName: '' },
  ] };
  const sparse = viewTradeKing({
    ...dockSurvey(),
    radar: sparseRadar,
    city: { goods: shelf, specGoodsId: 1005, rareGoodsId: 0, isReport: false },
    info: {
      ...dockSurvey().info,
      cargo: { cargoLv: 1, cityId: 91, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 },
    },
  }, { config: cfg });
  assert.equal(sparse.knownCount, 1, '只有 1 个港口的紧缺是已知的');
  assert.equal(sparse.unknownCities.length, 2, '另外 2 个是「未知」，不是「没有」');
  assert.equal(sparse.routes.length, 1, '已知航线只有 1 条（64 买布匹）');
  assert.equal(sparse.routes[0].sellCity, 64, '布匹的买家是 64');
  assert.equal(sparse.routes[0].buyCity, 91, '布匹在 91 买（本港）');
  // 本港 91 正是布匹的买入港 → 应该买布匹、开去 64 卖。
  const sparsePlan = planTradeKing(sparse, { config: cfg });
  assert.equal(sparsePlan.actions.find((a) => a.kind === 'tradeBuy')?.body.goodsId, 1005, '稀疏雷达下也要敢买已知航线上的货');
  assert.equal(sparsePlan.actions.find((a) => a.kind === 'tradeSail')?.body.mvToCityId, 64, '开去买家 64');
  // 手上有一件「买家未知」的货 → 不能瞎起航。
  const orphan = viewTradeKing({
    ...dockSurvey(),
    radar: { radar: [
      { cityId: 91, specGoodsId: 1005, rareGoodsId: 0, reportName: '' },
      { cityId: 64, specGoodsId: 4010, rareGoodsId: 0, reportName: '' },
    ] },
    city: { goods: [{ goodsId: 2007, stock: 0, price: 110 }], specGoodsId: 2007, rareGoodsId: 0, isReport: true },
    info: {
      ...dockSurvey().info,
      player: {
        coins: 500, maxCoins: 10500, profit: 500, buySpeedTimes: 0,
        goods: [{ pid: 3, goodsId: 1005, num: 50, buyPrice: 44, cityId: 91 }],
      },
      cargo: { cargoLv: 1, cityId: 64, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 },
    },
  }, { config: cfg });
  const orphanPlan = planTradeKing(orphan, { config: cfg });
  // 买家不明时**不能瞎猜一个买家**（昨天的配对今天就变了），但也不能干等着：
  // 去一个「紧缺未知」的港口探路 —— 到了共享一次就把那个港点亮，顺路看看能不能把货出掉。
  const orphanSail = orphanPlan.actions.find((a) => a.kind === 'tradeSail');
  assert.ok(orphanSail, '买家不明也要动起来（去探路）');
  assert.ok([91, 64].includes(orphanSail.body.mvToCityId) || orphanSail.body.mvToCityId !== 0, '目的地必须是个真实港口');
  assert.ok(!orphanPlan.actions.some((a) => a.kind === 'tradeBuy'), '买家不明的货一件都不买（宁可不买也不砸手里）');

  // 8.6 战令 key 必须带「可达档位数」。积分是边赚边涨的（= 累计利润），所以一天里会反复够到新档；
  // 若 key 只带日期：领完手上这几档后服务端回 prompt=35，这个失败进跨轮 rejected →
  // **当天后面所有新解锁的档位都领不到**（实盘 10:03 领到 2 档，13:35 已到 4 档却全被挡住）。
  const passAt = (profit) => planTradeKing(viewTradeKing(dockSurvey({
    player: { coins: 500, maxCoins: 20000, profit, goods: [], buySpeedTimes: 0 },
  }), { config: cfg }), { config: cfg });
  const passKey2 = passAt(4000).actions.find((a) => a.kind === 'tradePass')?.key;
  const passKey3 = passAt(12000).actions.find((a) => a.kind === 'tradePass')?.key;
  assert.ok(passKey2 && passKey2.endsWith(':2'), `积分 4000 够 2 档，key 应带 2，实际 ${passKey2}`);
  assert.ok(passKey3 && passKey3.endsWith(':3'), `积分 12000 够 3 档，key 应带 3，实际 ${passKey3}`);
  assert.ok(passKey2 !== passKey3, '档位数一变 key 就得变，否则新解锁的档位会被当天的失败记录挡住');
  // 积分还不够第一档（1000）→ 一个请求都不发。
  assert.ok(!passAt(500).actions.some((a) => a.kind === 'tradePass'), '0 分/不够档时不该问战令（必被拒）');

  // 8.7 联盟任务的文案要把配置模板的 {0} 换成 tragetCount，日志里不能出现裸占位符。
  const taskPlan = planTradeKing(viewTradeKing(dockSurvey({
    player: { coins: 500, maxCoins: 60000, profit: 12000, goods: [], buySpeedTimes: 0 },
    guildTask: { profit: 60000, tradeTimes: 10, gotTaskId: [] },
  }), { config: cfg }), { config: cfg });
  const taskLabel = taskPlan.actions.find((a) => a.kind === 'tradeTask')?.label ?? '';
  assert.ok(!taskLabel.includes('{0}'), `联盟任务文案不能留占位符，实际：${taskLabel}`);

  // 8.8 领奖会带回「海商王加速」（商会指针），但探测时的 speed.owned 是旧快照。
  // 若直接拿旧快照判「在航且没指针 → 静默到靠港」，刚领到的指针会白等 2 小时
  // （实盘 13:45：一次领到 6 档含 2 个指针，船却仍挂着 119 分钟）。
  // 所以「本轮成功领过奖」要把静默窗推迟一轮。
  assert.equal(tradeGainedReward([
    { step: { kind: 'tradePass' }, ok: true },
    { step: { kind: 'tradeSpeed' }, ok: true },
  ]), true, '领奖成功 → 要推迟静默（下一轮重探，指针数已更新）');
  assert.equal(tradeGainedReward([
    { step: { kind: 'tradeBuy' }, ok: true },
    { step: { kind: 'tradeSail' }, ok: true },
  ]), false, '只有买卖起航 → 没有新指针，照常静默到靠港');
  assert.equal(tradeGainedReward([
    { step: { kind: 'tradePass' }, ok: false, error: 'server prompt: prompt=35' },
  ]), false, '领奖被拒（已领完）不算，不能因此每轮重探');
  assert.equal(tradeGainedReward([
    { step: { kind: 'tradeTask' }, ok: false, skipped: true, error: '刚被服务端拒过，跳过' },
  ]), false, '跳过的动作不算领到奖');
  assert.equal(tradeGainedReward(undefined), false, '没有结果不能崩');

  // 9. 循环日志：这一段真的探测过就印一行「海商王」，被静默时印原因。
  const tradeRound = formatLoopRound({
    round: 9, startedAt: 0,
    tasks: { planned: 0, results: [] },
    dailies: { planned: 0, results: [] },
    world: { planned: 0, results: [], notes: [], population: '10/20', floaterLoot: null },
    trade: {
      planned: 1,
      notes: [],
      summary: '利润 12000 · 商会币 5000/60000 · 船 lv1（舱位 1000，+3%） · 停在城市 91 · 下一站 城市 64',
      results: [{
        step: { kind: 'tradeBuy', label: '买 布匹×227 @44（→ 城市 64 卖出，预计利润 2497）', items: [['布匹', 227]] },
        ok: true,
      }],
    },
    gates: { trade: { enabled: true, everyMs: 60_000, lastAt: 1_700_000_000, waitSeconds: 0, throttled: false, skipped: true, skipReason: '航行中（剩 100 分钟）', skipLeftSeconds: 6000, skipNotice: true } },
  });
  assert.ok(tradeRound.includes('海商王 计划 1'), `要有海商王概览行，实际：\n${tradeRound}`);
  assert.ok(tradeRound.includes('成功 海商王买货 布匹×227'), `成功行要带具体货物，实际：\n${tradeRound}`);
  assert.ok(tradeRound.includes('海商王 暂停探测：航行中'), `静默要说明原因，实际：\n${tradeRound}`);

  checked += 1;
}

// 今日收益统计：数据全是从归档回包重算的（stats.mjs），口径错页面上就是错的数字，
// 而且难得有第二处能交叉验证 —— 所以这里造一份"一天的回包"，逐项卡住：
// 只算 in 不算 out、int64 要能读、另一个账号的不能混进来、邮件只算今天且已领取。
{
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const stats = await import('./stats.mjs');
  const { dayOf } = await import('./archive.mjs');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-stats-'));
  const day = dayOf();
  const dir = path.join(root, day);
  fs.mkdirSync(dir, { recursive: true });
  const ACC = 'c06ad6ea';
  const OTHER = 'bbbbbbbb';
  const now = Date.now();
  const i64 = (n) => ({ low: n, high: 0, unsigned: false });
  const write = (name, entries) => fs.writeFileSync(
    path.join(dir, `${name}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  const inFrame = (name, body, acc = ACC, t = now) => ({ t, dir: 'in', seq: 1, acc, body });
  const outFrame = (name, body, acc = ACC, t = now) => ({ t, dir: 'out', seq: 2, acc, body });

  // 制造：三条回包（淡水 6 + 4、粗铁 1），另有一条别的账号、一条 out 都不该算。
  write('GainFactoryProduceResponse', [
    inFrame('GainFactoryProduceResponse', { products: { asset: [{ type: 0, id: '淡水', num: i64(6) }] } }),
    inFrame('GainFactoryProduceResponse', { products: { asset: [{ type: 0, id: '粗铁', num: i64(1) }] } }),
    inFrame('GainFactoryProduceResponse', { products: { asset: [{ type: 0, id: '淡水', num: i64(4) }] } }),
    inFrame('GainFactoryProduceResponse', { products: { asset: [{ type: 0, id: '淡水', num: i64(99) }] } }, OTHER),
    outFrame('GainFactoryProduceResponse', { products: { asset: [{ type: 0, id: '淡水', num: i64(50) }] } }),
  ]);
  // 建筑产出：reward 数组里嵌一层 product.asset。
  write('CollectBuildingProductResponse', [
    inFrame('CollectBuildingProductResponse', {
      reward: [
        { buildingId: '1训练营', product: { asset: [{ type: 0, id: '英雄经验', num: i64(469) }] } },
        { buildingId: '1精铁厂', product: { asset: [{ type: 0, id: '精铁', num: i64(5) }] } },
      ],
    }),
  ]);
  // 货轮港口：reward.asset 是返航奖励；同一条回包里的 ship.orderItem[].reward 是**下一单预览**，
  // 不能算成收益（这层最容易写错，所以专门卡一条）。
  write('DrawShipRewardResponse', [
    inFrame('DrawShipRewardResponse', {
      reward: { asset: [{ type: 0, id: '藏品大师经验', num: i64(3) }] },
      ship: { orderItem: [{ asset: { id: '香煎鱼排', num: i64(4) }, filled: false, reward: { asset: [{ id: 'GOLD', num: i64(3332) }] } }] },
    }),
  ]);

  // 活动次数：只数 out；in 混一条进来也不该被计。
  write('GainFactoryProduceRequest', [outFrame('GainFactoryProduceRequest', { buildingId: '1海水厂' }), outFrame('GainFactoryProduceRequest', { buildingId: '1材料厂' }), inFrame('GainFactoryProduceRequest', {})]);

  // 邮件：**靠快照里 got 由 false 变 true 判断领取时刻**（服务端不给领取时间）。
  // 四行快照依次是：两封未领 → 第 1 封领了 + 塞进一封"早就领过"的 → 第 2 封也领了
  // → 第 1 封的 got 回滚成 false（服务端会重复推全量快照，不能因此重算）。
  const mailOf = (id, got, gold) => ({
    emailId: { low: id, high: 0, unsigned: false },
    got,
    attachment: { assets: { asset: [{ type: 1, id: 'GOLD', num: i64(gold) }] } },
  });
  write('EmailBoxResponse', [
    inFrame('EmailBoxResponse', { email: [mailOf(1, false, 15000), mailOf(2, false, 500)] }),
    inFrame('EmailBoxResponse', { email: [mailOf(1, true, 15000), mailOf(2, false, 500), mailOf(3, true, 700)] }),
    inFrame('EmailBoxResponse', { email: [mailOf(1, true, 15000), mailOf(2, true, 500)] }),
    inFrame('EmailBoxResponse', { email: [mailOf(1, false, 15000), mailOf(2, true, 500)] }),
  ]);

  const view = stats.collectStats({ day, acc: ACC, root });
  assert.equal(view.kpi.made, 11, '制造只算本账号的 in 回包（6+1+4），out 与别的账号都不算');
  assert.equal(view.kpi.madeKinds, 2, '制造是 2 种产品');
  const factory = view.sources.find((entry) => entry.key === 'factory');
  assert.equal(factory.count, 3, '制造批次 = 回包条数');
  assert.deepEqual(factory.items, [{ id: '淡水', num: 10 }, { id: '粗铁', num: 1 }], '同类要合并，并按数量降序');
  assert.equal(factory.hours.reduce((sum, n) => sum + n, 0), 11, '小时分布的总和要等于件数');

  assert.equal(view.kpi.produced, 474, '建筑产出要把 reward[].product.asset 全部摊平（469+5）');
  const ship = view.sources.find((entry) => entry.key === 'ship');
  assert.equal(ship.total, 3, '货轮港口只算 reward.asset，ship.orderItem[].reward 是下一单预览，算进来就是凭空多出 3332 金币');
  assert.equal(ship.items[0].id, '藏品大师经验');
  assert.equal(view.kpi.mails, 2, '邮件要按「未领 → 已领」的变化记两封（第一次见就是已领的不算，回滚也不重算）');
  const mail = view.sources.find((entry) => entry.key === 'mail');
  assert.deepEqual(mail.items, [{ id: 'GOLD', num: 15500 }], '两封的附件要合并（15000+500）');

  const gain = view.activity.find((entry) => entry.key === 'gain');
  assert.equal(gain.count, 2, '活动次数只数请求（out），不受回包影响');
  assert.equal(view.kpi.acts, 2, '示例里只有收成品这一类活动');

  // 跨天：历史日期不该有「邮件奖励」这一栏（邮件快照永远是当前状态，反推不了昨天）。
  const pastDay = dayOf(Date.now() - 86400000);
  const past = stats.collectStats({ day: pastDay, acc: ACC, root });
  assert.equal(past.isToday, false);
  assert.equal(past.sources.find((entry) => entry.key === 'mail').count, 0, '历史日期同样能算邮件，只是那天没有归档就是 0');
  assert.equal(past.kpi.made, 0, '那天没有归档就是 0，不能借当天的数');
  assert.equal(past.trend.length, 7, '趋势固定 7 根柱子');

  // 趋势：今天这一格必须是刚才造的数（走的是同一条聚合路径）。
  const tail = view.trend[view.trend.length - 1];
  assert.equal(tail.day, day);
  assert.equal(tail.total, 11, `趋势最后一天要等于今天的制造量，实际 ${tail.total}`);

  // 查一个不存在的账号：不能因为"聚合里有别人"就把别人的数画到自己头上（趋势图以前会串号）。
  const ghost = stats.collectStats({ day, acc: 'zzzzzzzz', root });
  assert.equal(ghost.kpi.made, 0, '查不存在的账号不能拿到别人的制造数');
  assert.equal(ghost.trend[ghost.trend.length - 1].total, 0, '趋势图按 acc 查不到就是 0，不能兜底成第一个账号');

  fs.rmSync(root, { recursive: true, force: true });
  checked += 1;
}

// --- 联盟商船（活动 GuildShip） --------------------------------------------
// 判据来自客户端 TipsDescCfg 原文 + 反编译 GuildShipModel/GuildShipLeaderPop/GuildShipCargoPop
// + 协议表 + 2026-10-28 12:36 实盘（4 艘船 + 一次被拒的补货）。
{
  const cfg = {
    tables: {
      GuildShipParamCfg: { data: [{ shipNum: 2, duration: 30, time: [8, 11, 14, 17, 20, 23] }] },
      GuildShipCfg: { data: [
        { shipId: 1, quality: 'PURPLE', num: 2, time: 150 },
        { shipId: 2, quality: 'ORANGE', num: 4, time: 300 },
        { shipId: 3, quality: 'RED', num: 6, time: 540 },
      ] },
    },
  };
  // 实盘我的 playerId 是 34191176546778（int64，low 是有符号负数）。
  const ME = 34191176546778;
  const NOW = new Date(2026, 9, 28, 12, 36, 0).getTime();
  const NOW_S = Math.floor(NOW / 1000);

  // 1. int64：low 是有符号 int32，直接 low + high*2^32 会算出负数，
  //    导致「我是不是这艘船的船长」判错 → 计划器让船长补自己的船（必被 prompt 拒）。
  assert.equal(bigNum({ low: -1058096678, high: 7960 }), ME, 'int64 用无符号 low 拼回来要等于原值');
  assert.equal(bigNum(ME), ME, 'number 原样返回');
  assert.equal(bigNum(undefined), 0, 'undefined → 0');
  assert.equal(bigNum(null), 0, 'null → 0');

  // 2. 参数与刷新点。
  const params = gsParams(cfg);
  assert.equal(params.maxShips, 2, '同时最多登 2 艘（GuildShipParamCfg.shipNum）');
  assert.equal(params.prepareMinutes, 30, '补货窗口 30 分钟');
  assert.equal(gsNextRefreshAt(NOW, params), new Date(2026, 9, 28, 14, 0, 0).getTime() / 1000,
    '12:36 之后的下一个刷新点是 14:00');
  assert.equal(gsNextRefreshAt(new Date(2026, 9, 28, 23, 30, 0).getTime(), params),
    new Date(2026, 9, 29, 8, 0, 0).getTime() / 1000, '23:30 之后是次日 8 点');
  const spec = gsShipSpec(cfg, 2);
  assert.equal(spec.qualityName, '传说', 'ORANGE = 传说');
  assert.equal(spec.minutes, 300, '传说航行 5 小时 = 300 分钟');
  assert.equal(spec.cabins, 4, '传说是 4 个货舱');

  // 3. 应聘条件：每一条 leaderCond 都要 `英雄星 + 专武星 >= star + exStar`。
  const conds = [{ heroId: '机器警察', star: 10, exStar: 0 }, { heroId: '瑞文', star: 10, exStar: 0 }];
  assert.equal(seekCheck(conds, new Map([['机器警察', { star: 11, exStar: 0 }], ['瑞文', { star: 9, exStar: 0 }]])).ok,
    false, '瑞文 9 星 < 10 星 → 不能应聘');
  assert.equal(seekCheck(conds, new Map([['机器警察', { star: 11, exStar: 0 }], ['瑞文', { star: 9, exStar: 1 }]])).ok,
    true, '专武星也算：9+1=10 星刚好够');
  assert.equal(seekCheck([{ heroId: '马斯克', star: 5, exStar: 0 }], new Map()).ok, false, '没有这个英雄 → 不能应聘');
  assert.equal(seekCheck([], new Map()).ok, true, '没有条件 → 谁都能当');

  // 4. 视图：名额、船长不能补货、无船长不能补货、缺料要拦。
  const stock = new Map([['鱼皮风筝', 3], ['睡袋', 3], ['冲浪板', 2], ['吊床', 50], ['预制板', 39], ['煎锅', 0]]);
  const heroes = new Map([['机器警察', { star: 11, exStar: 0 }], ['瑞文', { star: 9, exStar: 0 }]]);
  const ship24 = {
    shipId: 24, type: 1, state: GS_STATE_PREPARED, pos: 0,
    leaderCond: [{ heroId: '弓箭手', star: 10, exStar: 0 }],
    leader: { playerId: { low: -1058096678, high: 7960 }, nickname: '我' },
    cabin: [
      { crewId: 1, order: [{ type: 0, id: '吊床', num: 7 }, { type: 0, id: '预制板', num: 4 }], player: { playerId: 111, nickname: '队友' } },
      { crewId: 2, order: [{ type: 0, id: '鱼皮风筝', num: 3 }, { type: 0, id: '睡袋', num: 2 }] },
    ],
    reward: { asset: [{ type: 0, id: '水姆币', num: 25 }, { type: 1, id: 'GOLD', num: 7500 }] },
    preparedEndTime: NOW_S + 15 * 60,
  };
  const ship29 = {
    shipId: 29, type: 1, state: GS_STATE_PREPARED, pos: 1,
    leaderCond: conds,
    cabin: [
      { crewId: 1, order: [{ type: 0, id: '冲浪板', num: 2 }, { type: 0, id: '吊床', num: 7 }] },
      { crewId: 2, order: [{ type: 0, id: '煎锅', num: 2 }, { type: 0, id: '吊床', num: 7 }] },
    ],
    reward: { asset: [{ type: 0, id: '水姆币', num: 10 }] },
    preparedEndTime: 0,
  };
  const survey = { now: NOW, period: 10001, ships: [ship24, ship29], ownRun: [] };
  const view = viewGuildShip(survey, { config: cfg, stock, heroes, playerId: ME, now: NOW });
  assert.equal(view.open, true, 'period > 0 就是开着');
  assert.equal(view.myShips.length, 1, '名额要认出「我是 #24 的船长」');
  assert.equal(view.myShips[0].role, 'leader', '#24 的身份是船长');
  assert.equal(view.slotsLeft, 1, '2 个名额用了 1 个');
  const v24 = view.ships.find((r) => r.shipId === 24);
  const v29 = view.ships.find((r) => r.shipId === 29);
  assert.equal(v24.mineLeader, true, '#24 的船长是我');
  assert.equal(v24.fillable.length, 0, '船长不能给自己那条船补货（实盘 captain cannot resupply）');
  assert.equal(v24.blocked.length, 0, '船长不做补货判断，别报缺料');
  assert.equal(v29.fillable.length, 0, '没有船长的船还没开启补货，不能补');
  // 舱1 材料齐、舱2 缺煎锅 —— 缺料要如实列出来（有船长之后才看这个）。
  assert.equal(v29.cabins.find((c) => c.crewId === 2).short[0].id, '煎锅', '缺料要指名道姓');
  assert.equal(view.seekable.length, 0, '瑞文 9 星不够 → 不能应聘 #29');
  // 船长条件满足时才进 seekable。
  const heroes2 = new Map([['机器警察', { star: 11, exStar: 0 }], ['瑞文', { star: 10, exStar: 0 }]]);
  const view2 = viewGuildShip(survey, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  assert.equal(view2.seekable.length, 1, '瑞文补到 10 星就能应聘 #29');
  assert.equal(view2.seekable[0].shipId, 29, '能应聘的是 #29');

  // 5. 计划：名额满了就一条都不发（哪怕有空舱、有缺料也别动）。
  const fullSurvey = {
    now: NOW,
    period: 10001,
    ships: [ship24, { ...ship24, shipId: 30, leader: { playerId: 222, nickname: '别人' } }],
    ownRun: [],
  };
  // #24 我当船长、#30 我补过舱 → 2 个名额都占了。
  const crew30 = {
    ...ship24,
    shipId: 30,
    leader: { playerId: 222, nickname: '别人' },
    cabin: [
      { crewId: 4, order: [{ type: 0, id: '吊床', num: 7 }], player: { playerId: { low: -1058096678, high: 7960 }, nickname: '我' } },
      { crewId: 1, order: [{ type: 0, id: '睡袋', num: 2 }] },
    ],
  };
  const fullView = viewGuildShip({ ...fullSurvey, ships: [ship24, crew30] }, {
    config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW,
  });
  assert.equal(fullView.myShips.length, 2, '#24 船长 + #30 船员 = 2 艘');
  assert.equal(fullView.slotsLeft, 0, '名额用满');
  const fullPlan = planGuildShip(fullView, { config: cfg });
  assert.equal(fullPlan.actions.length, 0, '名额满了就一条都不发');
  assert.ok(fullPlan.notes.some((n) => n.includes('已占满')), '要说清是名额满了');

  // 6. 计划：名额够 → 先补货（挑空舱少 = 快启航的）→ 剩余名额才当船长。
  const emptyMine = viewGuildShip({
    now: NOW,
    period: 10001,
    ships: [
      { ...ship24, shipId: 40, leader: { playerId: 333, nickname: '甲' },
        cabin: [
          { crewId: 1, order: [{ type: 0, id: '睡袋', num: 2 }] },
          { crewId: 2, order: [{ type: 0, id: '吊床', num: 7 }] },
        ] },
      { ...ship24, shipId: 41, leader: { playerId: 444, nickname: '乙' },
        cabin: [
          { crewId: 1, order: [{ type: 0, id: '睡袋', num: 2 }] },
          { crewId: 2, order: [{ type: 0, id: '吊床', num: 7 }] },
          { crewId: 3, order: [{ type: 0, id: '吊床', num: 7 }] },
          { crewId: 4, order: [{ type: 0, id: '吊床', num: 7 }] },
        ] },
    ],
    ownRun: [],
  }, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  const emptyPlan = planGuildShip(emptyMine, { config: cfg });
  const orderActions = emptyPlan.actions.filter((a) => a.kind === 'guildShipOrder');
  assert.equal(orderActions.length, 2, '2 个名额都拿去补货（船员是稳赚的）');
  assert.equal(orderActions[0].body.shipId, 40, '空舱少的 #40 排在前面（越快启航，名额释放越快）');
  assert.equal(orderActions[0].request, 'GuildShipOrderRequest', '补货走 GuildShipOrderRequest');
  // 补货动作的 key 要按 shipId+crewId 区分，否则多条动作会被 rejected 集合当成同一条。
  assert.ok(orderActions.every((a) => a.key.startsWith('guildShipOrder:') && a.key.split(':').length === 3),
    'key 必须按船+舱区分');
  assert.ok(orderActions.every((a) => a.transient === true), '舱位是动态的 → transient（失败不该跨轮拉黑）');

  // 7. 剩余名额当船长：1 个名额去补货，另 1 个去应聘没人当的船。
  const mixed = viewGuildShip({
    now: NOW,
    period: 10001,
    ships: [
      { ...ship24, shipId: 40, leader: { playerId: 333, nickname: '甲' },
        cabin: [
          { crewId: 1, order: [{ type: 0, id: '睡袋', num: 2 }] },
          { crewId: 2, order: [{ type: 0, id: '吊床', num: 7 }] },
        ] },
      { ...ship29, shipId: 50 },
    ],
    ownRun: [],
  }, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  const mixedPlan = planGuildShip(mixed, { config: cfg });
  assert.equal(mixedPlan.actions.filter((a) => a.kind === 'guildShipOrder').length, 1, '先拿 1 个名额补货');
  const seekAction = mixedPlan.actions.find((a) => a.kind === 'guildShipSeek');
  assert.ok(seekAction, '剩下的名额去当船长');
  assert.equal(seekAction.body.shipId, 50, '应聘的是没人当船长的 #50');
  assert.equal(seekAction.request, 'GuildShipSeekRequest', '应聘走 GuildShipSeekRequest');
  // 关掉「应聘船长」就只剩补货。
  const noSeek = planGuildShip(mixed, { config: cfg, allowSeek: false });
  assert.ok(!noSeek.actions.some((a) => a.kind === 'guildShipSeek'), 'allowSeek=false 时不当船长');

  // 8. 在航的船不能补货、也不能应聘（state=2）。
  const sailing = viewGuildShip({
    now: NOW,
    period: 10001,
    ships: [{ ...ship24, shipId: 60, state: GS_STATE_MOVING,
      leader: { playerId: 555, nickname: '丙' },
      cabin: [{ crewId: 1, order: [{ type: 0, id: '睡袋', num: 2 }] }] }],
    ownRun: [{ shipId: 60, type: 1, state: GS_STATE_MOVING, mvEndTime: NOW_S + 3600 }],
  }, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  assert.equal(planGuildShip(sailing, { config: cfg }).actions.length, 0, '航行中的船什么都不做');
  assert.equal(sailing.ownRun[0].moveEndAt, NOW_S + 3600, '在航信息要透出来（名额什么时候释放）');

  // 9. 本期没开：一条都不发，说明原因。
  const closed = viewGuildShip({ now: NOW, period: 0, ships: [ship24], ownRun: [] },
    { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  assert.equal(closed.open, false, 'period=0 = 本期没开');
  const closedPlan = planGuildShip(closed, { config: cfg });
  assert.equal(closedPlan.actions.length, 0, '没开就一条都不发');
  assert.ok(closedPlan.notes.some((n) => n.includes('未开启')), '要说清本期未开启');

  // 10. 结算文案。
  const gain = formatGuildShipGain(summarizeGuildShip([
    { step: { kind: 'guildShipOrder', label: '补货' }, ok: true },
    { step: { kind: 'guildShipSeek', label: '应聘' }, ok: true },
    { step: { kind: 'guildShipOrder', label: '补货失败' }, ok: false, error: 'x' },
    { step: { kind: 'guildShipOrder', label: '跳过' }, ok: false, skipped: true },
  ]));
  assert.ok(gain.includes('补货 1 舱'), `要统计补了几舱，实际：${gain}`);
  assert.ok(gain.includes('当船长 1 艘'), `要统计当了几艘船长，实际：${gain}`);
  assert.ok(gain.includes('失败 1'), `失败要单独计数（跳过不算失败），实际：${gain}`);

  // 11. ⚠ 名额必须把**在航的船**算进去：它们还没到港，一样锁着名额。
  // 实盘 2026-10-28 14:41：码头 0 艘是我的、ownRun 里 2 艘在航 → 旧算法 slotsLeft=2，
  // 补货与应聘**双双**被 `server prompt: ship slot limit` 拒掉（日志：计划 2 / 成功 0 / 失败 2）。
  const dockOthers = () => [
    { ...ship24, shipId: 40, leader: { playerId: 333, nickname: '甲' },
      cabin: [
        { crewId: 1, order: [{ type: 0, id: '睡袋', num: 2 }] },
        { crewId: 2, order: [{ type: 0, id: '吊床', num: 7 }] },
      ] },
    { ...ship29, shipId: 50 },
  ];
  const busy = viewGuildShip({
    now: NOW,
    period: 10001,
    ships: dockOthers(),
    ownRun: [
      { shipId: 24, type: 1, state: GS_STATE_MOVING, mvEndTime: NOW_S + 1800 },
      { shipId: 30, type: 2, state: GS_STATE_MOVING, mvEndTime: NOW_S + 9000 },
    ],
  }, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  assert.equal(busy.myShips.length, 0, '码头上的船没有一艘是我的');
  assert.equal(busy.runningMine.length, 2, '在航的 2 艘都是我的');
  assert.equal(busy.slotsUsed, 2, '名额占用 = 码头我的 + 在航我的');
  assert.equal(busy.slotsLeft, 0, '在航的船照样占名额（旧算法在这里错成 2）');
  const busyPlan = planGuildShip(busy, { config: cfg });
  assert.equal(busyPlan.actions.length, 0, '名额占满时一条都不发（否则必被 ship slot limit 拒）');
  assert.ok(busyPlan.notes.some((n) => n.includes('在航')), `要说清名额被在航的船占着，实际：${busyPlan.notes.join(' | ')}`);
  assert.ok(busyPlan.notes.some((n) => n.includes('已占满')), '要说清是占满了');

  // 只占一半（在航 1 艘）→ 还剩 1 个名额，可以补 1 个舱。
  const half = viewGuildShip({
    now: NOW,
    period: 10001,
    ships: dockOthers(),
    ownRun: [{ shipId: 24, type: 1, state: GS_STATE_MOVING, mvEndTime: NOW_S + 1800 }],
  }, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  assert.equal(half.slotsLeft, 1, '在航 1 艘只占 1 个名额');
  const halfPlan = planGuildShip(half, { config: cfg });
  assert.equal(halfPlan.actions.filter((a) => a.kind === 'guildShipOrder').length, 1, '还剩 1 个名额拿去做船员');
  assert.ok(!halfPlan.actions.some((a) => a.kind === 'guildShipSeek'), '名额只有 1 个时不再去应聘船长');

  // 同一艘船既在码头又在 ownRun（理论上不会）→ 不能重复计名额。
  const dup = viewGuildShip({
    now: NOW,
    period: 10001,
    ships: [{ ...ship24, shipId: 24 }],
    ownRun: [{ shipId: 24, type: 1, state: GS_STATE_MOVING, mvEndTime: NOW_S + 600 }],
  }, { config: cfg, stock, heroes: heroes2, playerId: ME, now: NOW });
  assert.equal(dup.slotsUsed, 1, '同一艘船不能算两次名额');

  // 概览文案也要把在航的船算进「我的名额」。
  assert.ok(formatGuildShipSummary(busy).includes('我的名额 2/2'), `概览要显示 2/2，实际：${formatGuildShipSummary(busy)}`);
  assert.ok(formatGuildShipSummary(busy).includes('在航'), '概览要标出在航');

  checked += 1;
}

// --- 国战（联盟攻城 CityWar） ----------------------------------------------
// 判据来自客户端反编译（guildIndex = guildId % 1000、coordToPosition、getAttackCityPetrolCostUnit、
// isDeclare 只认盟主/副盟主）+ 配置表 AttackCityConsumeCfg / CityCfg + 2026-10-28 实盘
// （19:52 派 1 艘船到城 73，20:00 到达，21:48 仍 IDLE 驻守，联盟 3 城全占）。
{
  const cfg = {
    tables: {
      AttackCityConsumeCfg: { data: [
        { dist: 1, cost: 0.4 },
        { dist: 6000, cost: 0.5 },
        { dist: 8400, cost: 0.6 },
        { dist: 10800, cost: 0.7 },
      ] },
      CityCfg: { data: [
        { id: 91, name: '水之都', guildIndex: 3 },
        { id: 73, name: '堡垒H7', guildIndex: 0 },
      ] },
    },
  };

  // 1. 联盟身份是 idx 不是 guildId：客户端 guildIndex(e)=e%1e3。
  //    实测 guildId 2001014410003 → 3，宣战列表里 attackGuildIdx===3 的才是我们联盟的战场。
  assert.equal(guildIndex(2001014410003), 3, 'guildId → 联盟下标（%1000）');
  // guildId 在回包里是 int64（low 是有符号 int32），必须走 bigNum 才能算对：
  // 2001014410003 = 465 * 2^32 + 3854617363，而 3854617363 作有符号是 -440349933。
  assert.equal(guildIndex({ low: -440349933, high: 465 }), 3, 'int64 形式的 guildId 也要算出 3');
  assert.equal(guildIndex(0), 0, '没有联盟 → 0');

  // 2. 汽油单价分档：客户端从第一档开始，dist < row.dist 就 break。
  assert.equal(attackPetrolUnit(cfg, 0), 0.4, '<1 像素仍是第一档 0.4');
  assert.equal(attackPetrolUnit(cfg, 5999), 0.4, '<6000 是 0.4');
  assert.equal(attackPetrolUnit(cfg, 6000), 0.5, '>=6000 进第二档 0.5');
  assert.equal(attackPetrolUnit(cfg, 8400), 0.6, '>=8400 进第三档 0.6');
  assert.equal(attackPetrolUnit(cfg, 99999), 0.7, '超出最后一档沿用最大单价');

  // 3. 距离 = 两座城格子中心的像素欧氏距离（coordToPosition）。
  //    gridIdx 0 → col0/row0 → (50, -75)；gridIdx 10 → col10/row0 → (1050, -75) → 1000 像素。
  const map = { width: 100, tileWidth: 100, tileHeight: 75, cityInfo: { 1: { gridIdx: 0 }, 2: { gridIdx: 10 } } };
  assert.equal(Math.round(cityDistance(map, 1, 2)), 1000, '同一行相距 10 格 = 1000 像素');
  assert.equal(cityDistance(map, 1, 999), null, '地图上没有这座城 → null（调用方降级，不能当成 0）');
  assert.equal(attackPetrolCost(cfg, map, 1, 2), 400, '1000 像素 × 0.4 = 400 汽油');
  assert.equal(attackPetrolCost(cfg, null, 1, 2), null, '没有地图 → 算不出来就返回 null，不能编一个数');

  // 4. 战期按整日滚动。服务端回包会「停在上一场」（10/28 22:40 实测：战期还是当天 20:00–21:00，
  //    但宣战列表已经是新一场的城 86）。不滚动的话明天 19:50 会被判成「今日已结束」→ 睡一整天。
  const day1Start = Math.floor(new Date(2026, 9, 28, 20, 0, 0).getTime() / 1000);
  const day1End = day1Start + 3600;
  const lateToday = Math.floor(new Date(2026, 9, 28, 22, 40, 0).getTime() / 1000);
  const rolled = rollWarWindow(day1Start, day1End, lateToday);
  assert.equal(rolled.days, 1, '22:40 看的还是今天那场 → 滚到明天');
  assert.equal(rolled.startAt, day1Start + 86400, '滚动后是次日 20:00');
  assert.equal(nextWarStartAt(day1Start, day1End, lateToday), day1Start + 86400, '下一场开始时刻 = 次日 20:00');

  const liveNow = day1Start + 600; // 20:10
  assert.equal(rollWarWindow(day1Start, day1End, liveNow).days, 0, '战中不滚动');
  assert.equal(phaseOf(day1Start, day1End, liveNow), 'live', '20:10 是战中');
  assert.equal(phaseOf(day1Start, day1End, day1Start - 300), 'prep', '战前 5 分钟 = 布署窗');
  assert.equal(phaseOf(day1Start, day1End, day1Start - 3600), 'waiting', '战前 1 小时还没到布署');
  assert.equal(phaseOf(0, 0, liveNow), 'unknown', '没有战期 → unknown');

  // 5. 计划器：只派到我们联盟宣的城、优先守军最弱的那座、已在目标城的船不动。
  const nowSec = day1Start - 300; // 布署窗内
  const view = {
    phase: 'prep',
    startAt: day1Start,
    endAt: day1End,
    petrol: 700_000,
    petrolReserve: 20_000,
    minPowerRatio: 0,
    mapKnown: true,
    repairParams: new Map(),
    repairBelow: 0.8,
    targets: [
      { cityId: 68, name: '堡垒G7', kind: 'attack', defencePower: 900_000, defenceKnown: true, petrolCost: 5_200 },
      { cityId: 73, name: '堡垒H7', kind: 'attack', defencePower: 490_000, defenceKnown: true, petrolCost: 1_200 },
    ],
    fleets: [
      { buildingId: '1远征船', state: CW_STATE_IDLE, cityId: 72, targetCityId: 0, power: 2_615_152, durability: 1800, maxDurability: 2000, duraPct: 0.9, repairing: null, autoFight: false, needsRepair: false },
      { buildingId: '2远征船', state: CW_STATE_IDLE, cityId: 73, targetCityId: 0, power: 1_343_307, durability: 1800, maxDurability: 2000, duraPct: 0.9, repairing: null, autoFight: false, needsRepair: false },
    ],
  };
  view.idleFleets = view.fleets;

  const plan = planCityWar(view, {});
  assert.equal(plan.actions.length, 1, '2 号船已经在城 73 → 只派 1 号船');
  assert.equal(plan.actions[0].request, 'MoveFleetsToCityRequest', '派兵走 MoveFleetsToCityRequest');
  assert.deepEqual(plan.actions[0].body, { buildingId: ['1远征船'], cityId: 73 }, '挑守军最弱的城 73，且 buildingId 是数组');
  assert.equal(plan.actions[0].transient, true, '派兵是瞬时动作（舰队状态每轮在变，不能永久拉黑）');
  assert.ok(plan.actions[0].label.includes('490000'), `说明里要带守军战力，实际：${plan.actions[0].label}`);

  // 6. 非战期一格动作都不发（白天不能每小时多打请求，更不能不宣战就派兵）。
  assert.equal(planCityWar({ ...view, phase: 'waiting' }, {}).actions.length, 0, '未到布署窗不发派兵');
  assert.equal(planCityWar({ ...view, phase: 'live' }, {}).actions.length, 1, '战中也允许补派');

  // 7. 汽油不够（留 2 万备用后付不起单程）→ 不派，且要说明原因。
  const poor = planCityWar({ ...view, petrol: 21_000 }, {});
  assert.equal(poor.actions.length, 0, '汽油只够 1000 时不派（单程 1200）');
  assert.ok(poor.notes.some((n) => n.includes('汽油')), `要说清是汽油不够，实际：${poor.notes.join(' | ')}`);

  // 8. 耐久低于 80% → 先修；同一轮不能再派它（修船会把它置成 REPAIRING，派了必被拒）。
  const needFix = {
    ...view,
    repairParams: new Map([['1远征船', { unitRepairCost: 5.76, unitRepairTime: 0.3 }]]),
    fleets: [{ ...view.fleets[0], durability: 1400, duraPct: 0.7, needsRepair: true }, view.fleets[1]],
  };
  const fixPlan = planCityWar(needFix, {});
  assert.equal(fixPlan.actions.length, 1, '只排维修，不排派兵');
  assert.equal(fixPlan.actions[0].request, 'RepairFleetRequest', '维修走 RepairFleetRequest（无 Response）');
  assert.deepEqual(fixPlan.actions[0].body, { buildingId: '1远征船' }, '维修的 buildingId 是单个字符串，不是数组');
  assert.ok(fixPlan.actions[0].label.includes('3456'), `600 点 × 5.76 = 3456 汽油，实际：${fixPlan.actions[0].label}`);

  // 9. 开了舰队委任（VIP3+）的船由服务端托管，脚本不抢。
  const appointed = planCityWar({
    ...view,
    fleets: [{ ...view.fleets[0], autoFight: true }, view.fleets[1]],
  }, {});
  assert.equal(appointed.actions.length, 0, '委任中的船不派');

  // 10. 联盟今天没宣战 → 一条都不发，并说清原因（脚本不代宣：那是盟主/副盟主的权限）。
  const noWar = planCityWar({ ...view, targets: [] }, {});
  assert.equal(noWar.actions.length, 0, '没有宣战城就不派');
  assert.ok(noWar.notes.some((n) => n.includes('宣战')), '要说明「联盟今天没有宣战城市」');

  // 11. 概览要点出战期与空闲船数，否则日志里看不出这一段在干什么。
  const summary = formatCityWarSummary({ ...view, fleets: view.fleets, idleFleets: view.fleets });
  assert.ok(summary.includes('20:00') && summary.includes('2 攻'), `概览要带战期和攻守城数，实际：${summary}`);
  assert.ok(summary.includes('舰队 2/2'), `概览要带空闲船数，实际：${summary}`);

  // 12. 战期节奏：战期内 60 秒（一波打完要立刻再派），战期外仍是 180 秒。
  //     判据：10/29 实测一完整波 = 派 → 交战 → 回后方城 → 修满 → 再派 ≈ 9–10 分钟，
  //     3 分钟间隔下每波白等最多 3 分钟，一场只 1 小时 ≈ 6 波，等于少打一整波。
  const warCycle = [day1Start, day1End]; // day1Start = 10/28 20:00
  const w = { startAt: warCycle[0], endAt: warCycle[1] };
  assert.equal(warPollInterval(180_000, 60_000, w, day1Start + 600), 60_000, '战期内切 60 秒');
  assert.equal(warPollInterval(180_000, 60_000, w, day1Start - 600), 180_000, '布署窗（还没开战）仍 180 秒');
  assert.equal(warPollInterval(180_000, 60_000, w, day1End + 60), 180_000, '战期结束后回到 180 秒');
  assert.equal(warPollInterval(180_000, 60_000, null, day1Start + 600), 180_000, '窗口未知 → 不加速（宁可慢也别乱发）');
  assert.equal(warPollInterval(30_000, 60_000, w, day1Start + 600), 30_000, '常规间隔更短时取 min，不被拖长');
  assert.equal(warPollInterval(180_000, 1_000, w, day1Start + 600), 30_000, '战期节奏有 30 秒下限（别把服务端打烦）');
  assert.equal(warPollInterval(0, 60_000, w, day1Start + 600), 60_000, '常规=0（每轮都跑）时战期内也是 60 秒');

  // 13. 城战在线奖励：请求是空消息，服务端满足一档回一条 GotRewardResponse，没得领就回 prompt。
  //     客户端 WarOnlineReward 是自动发的，无头客户端必须自己补 —— 2026-10-29 实测整场 7 档全漏
  //     （`grep -c GotWorldOnlineRwd data/protocol.log` = 0）。
  const onlineProtocol = { GotWorldOnlineRwdRequest: () => {}, GotRewardResponse: () => {} };
  const fakeClient = (queue) => {
    let i = 0;
    return {
      sent: 0,
      async request() {
        this.sent += 1;
        const next = queue[Math.min(i, queue.length - 1)];
        i += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  const gift = (id, n) => ({ reward: { asset: [{ type: 0, id, num: { low: n, high: 0, unsigned: false } }] } });

  // 领到两档后第三档还没解锁（服务端回 prompt）→ 收手，别继续打。
  const c1 = fakeClient([gift('汽油', 7000), gift('RUBY', 30), new Error('server prompt: no claimable reward')]);
  const r1 = await claimWarOnlineReward(c1, onlineProtocol, { maxTries: 4, timeout: 50 });
  assert.equal(r1.rounds, 2, '领到两档就停（第三档被拒）');
  assert.equal(r1.stoppedBy, 'rejected', '被 prompt 拒 → 收手信号是 rejected');
  assert.deepEqual(r1.gifts.map((g) => `${g.id}x${g.num}`), ['汽油x7000', 'RUBYx30'], '奖励要按条收集');
  assert.equal(c1.sent, 3, '被拒后不再多发（3 次就停）');

  // 空包裹 → empty 收手（这一档是空的 / 已经领过）。
  const r2 = await claimWarOnlineReward(fakeClient([{ reward: { asset: [] } }]), onlineProtocol, { timeout: 50 });
  assert.equal(r2.stoppedBy, 'empty', '空包裹不该继续打');
  assert.equal(r2.gifts.length, 0, '空包裹没有奖励');

  // 一直成功 → 打到 maxTries 为止，不会无限循环。
  const c3 = fakeClient([gift('汽油', 100)]);
  const r3 = await claimWarOnlineReward(c3, onlineProtocol, { maxTries: 3, timeout: 50 });
  assert.equal(r3.stoppedBy, 'maxTries', '全成功就到 maxTries 停');
  assert.equal(c3.sent, 3, 'maxTries=3 就只发 3 次');

  // 协议表里没有这两个消息 → 不支持，一个请求都不发（老版本 bundle 别崩）。
  const r4 = await claimWarOnlineReward(fakeClient([gift('汽油', 1)]), {}, {});
  assert.equal(r4.supported, false, '没有协议 → supported=false');
  assert.equal(r4.gifts.length, 0, '不支持时没有奖励');

  // 同名奖励合并成一行，日志才读得下去。
  assert.equal(
    formatOnlineReward({ gifts: [{ id: '汽油', num: 7000 }, { id: '汽油', num: 7500 }, { id: 'RUBY', num: 30 }] }),
    '在线奖励 汽油×14500 + RUBY×30',
    '同名奖励要合并',
  );
  assert.equal(formatOnlineReward({ gifts: [] }), '', '没领到就返回空串（概览行不该多出「在线奖励」）');

  checked += 1;
}


// --- 酆都诡事（捞尸人联动）---------------------------------------------------
// 判据来自反编译 LSRFengDuFaZhiPop / LSRFaZhiGuessItem / CompassWheelPop / EvilExpelPop
// + 协议表 + 2026-10-29 实盘 3 轮（杀 6 只邪祟、1 局法旨、3 次罗盘、签到 2 条收工）。
{
  const cfg = {
    tables: {
      LinkageLSREvilExpelTotalRewardCfg: { data: [
        { id: 1, totalCount: 5, rewards: [] },
        { id: 2, totalCount: 10, rewards: [] },
        { id: 3, totalCount: 15, rewards: [] },
      ] },
      LinkageLSRCompassWheelScoreRewardCfg: { data: [
        { id: 1, score: 30 },
        { id: 2, score: 200 },
        { id: 3, score: 800 },
      ] },
      LinkageLSREdictPatienceCfg: { data: [{ patienceTotal: 100, askCost: 5, receiveCost: 10 }] },
      LinkageLSREdictRewardCfg: { data: [
        { id: 1, patience: 70, battlePassScore: 10, rewards: [['活动26捞尸人_货币', 20]] },
        { id: 2, patience: 30, battlePassScore: 20, rewards: [] },
        { id: 3, patience: 1, battlePassScore: 30, rewards: [] },
      ] },
      LinkageLSRActiveRewardCfg: { data: Array.from({ length: 6 }, (_, i) => ({ rewardId: i + 1, score: 80 * (i + 1) })) },
      LinkageLSRCompassWheelCfg: { data: [
        { rewardId: 1, ring: 1, isDragon: '', minDraw: 0, mustDraw: 0 },
        { rewardId: 8, ring: 1, isDragon: '是', minDraw: 20, mustDraw: 70 },
      ] },
    },
  };
  const stock = () => new Map([
    ['活动26捞尸人_入场券', 1],
    ['活动26捞尸人_抽奖券', 3],
    ['活动26捞尸人_货币', 70],
  ]);
  const base = () => ({
    open: true,
    activityId: YOUDU_ACTIVITY_ID,
    evil: { killTotal: 6, claimed: 5, todayKill: 6, alive: 4 },
    wheel: { score: 113, claimedId: 1, times: 2, pity: 68, minScore: 30, maxScore: 50, outerGot: [], cost: { id: '活动26捞尸人_抽奖券', num: 1 } },
    edict: { cost: { id: '活动26捞尸人_入场券', num: 1 }, session: null },
    stock: stock(),
  });

  // 1. 活动 id：不是活动上线日 20261029（那个一律 prompt 74 = ACTIVE_END）。
  assert.equal(YOUDU_ACTIVITY_ID, 20261001, '活动 id 是大版本容器 20261001');

  // 2. `claimed` 是「已领档位的累计杀数」而不是档位 id：
  //    实盘累计 6 只、领完第 1 档后 claimed=5（第 1 档 totalCount 就是 5）。
  //    按 id 比的话会把 claimed=5 当成「已领到第 5 档」，之后 5/10/15 全被跳过。
  const v1 = viewYoudu(base(), { config: cfg });
  assert.equal(v1.evil.claimed, 5, 'claimed 原样保留');
  assert.deepEqual(v1.evil.claimable.map((r) => r.id), [], '累计 6 只还差 4 只到第 2 档 → 当前没有可领档位');
  assert.equal(v1.evil.next.totalCount, 10, '下一档是累计 10 只');

  // 3. 邪祟：alive 几只就排几条 kill，且可领档位按「杀完之后」的累计数算。
  const p1 = planYoudu(v1, { config: cfg });
  const kills = p1.actions.filter((a) => a.kind === 'youduKill');
  assert.equal(kills.length, 4, '基地 4 只 → 4 条 EvilExpelKillRequest');
  assert.equal(kills[0].body.activityId, YOUDU_ACTIVITY_ID, 'kill 请求体带 activityId');
  // 6 + 4 = 10 → 第 2 档（10 只）刚好达标，这一轮就该领，不用等下一轮。
  assert.equal(p1.actions.filter((a) => a.kind === 'youduEvilClaim').length, 1, '杀完 10 只这一轮就能领第 2 档');

  // 4. 罗盘：券 3 张、单抽 1 张 → 一次请求抽 3 发；积分 113 只够第 1 档（30 分），已领过 → 不重复领。
  assert.equal(v1.wheel.spins, 3, '3 张券 / 单抽 1 → 能转 3 次');
  assert.equal(v1.wheel.dragonIn, 68, 'pity 68 → 保底还剩 68 抽（不是 70-68=2，pity 本身就是剩余数）');
  assert.equal(v1.wheel.dragonMustDraw, 70, '保底抽数从 LinkageLSRCompassWheelCfg 的 isDragon 行读 mustDraw');
  assert.equal(v1.wheel.dragonMinDraw, 20, '龙纹最早第 20 抽才可能出（minDraw）');
  // 服务端没下发 pity 时退回 70 - times，不至于显示成 0。
  const noPity = viewYoudu({ ...base(), wheel: { ...base().wheel, pity: 0, times: 5 } }, { config: cfg });
  assert.equal(noPity.wheel.dragonIn, 65, 'pity 缺失 → 按 70-5 兜底');
  const spins = p1.actions.filter((a) => a.kind === 'youduSpin');
  assert.equal(spins.length, 1, '一次请求抽 3 发（不拆成 3 条）');
  assert.equal(spins[0].body.num, 3, 'body.num = 发数');
  assert.equal(p1.actions.filter((a) => a.kind === 'youduWheelClaim').length, 0, '积分档位已领过就不重复领');

  // 5. 法旨：服务端把答案放在 session.rune 里（客户端拿它渲染符纸图案），
  //    所以有 4 位 rune 就直接提交、一次都不显化（显化 -5 耐心、猜错 -10）。
  const withSession = viewYoudu({
    ...base(),
    edict: { cost: { id: '活动26捞尸人_入场券', num: 1 }, session: { rune: [2, 1, 6, 4], shown: [0, 0, 0, 0], patience: 100 } },
  }, { config: cfg });
  const p2 = planYoudu(withSession, { config: cfg });
  const guesses = p2.actions.filter((a) => a.kind === 'youduEdictGuess');
  assert.equal(guesses.length, 1, '有 session 就提交答案');
  assert.deepEqual(guesses[0].body.guess, [2, 1, 6, 4], 'guess 直接就是 session.rune');
  assert.equal(p2.actions.filter((a) => a.kind === 'youduEdictAsk').length, 0, '一次显化都不发');
  assert.equal(p2.actions.filter((a) => a.kind === 'youduEdictStart').length, 0, '已经有局就不再开局');

  // 6. 没有 session、有入场券 → 先开局；没有入场券 → 只提示、不发请求。
  const p3 = planYoudu(v1, { config: cfg });
  assert.equal(p3.actions.filter((a) => a.kind === 'youduEdictStart').length, 1, '有入场券就开一局');
  const noTicket = viewYoudu({
    ...base(),
    stock: new Map([['活动26捞尸人_抽奖券', 0]]),
  }, { config: cfg });
  const p4 = planYoudu(noTicket, { config: cfg });
  assert.equal(p4.actions.filter((a) => a.kind === 'youduEdictStart').length, 0, '没入场券不开局');
  assert.ok(p4.notes.some((n) => n.includes('入场券')), '要在 notes 里说清为什么没开局');

  // 7. 活动没开（服务端回 ACTIVE_END/74）→ 一条动作都不排，只留说明。
  const closed = viewYoudu({ open: false, reason: 'server prompt: prompt=74' }, { config: cfg });
  const p5 = planYoudu(closed, { config: cfg });
  assert.equal(p5.actions.length, 0, '活动没开就不发请求');
  assert.ok(formatYouduSummary(closed).includes('未开启'), '摘要里要说未开启');

  // 8. 签到不放进静态计划：它得按回包推进（already checked in / not time yet），
  //    否则每天白打 13 条必被拒的请求。
  assert.equal(p1.actions.filter((a) => a.kind === 'youduSign').length, 0, '签到由 runYouduSigns 单独处理');

  // 9. 两个 claim 必须 transient：可领档位是「按杀完之后 / 按当前积分」投影算的，
  //    上一轮的 kill / spin 万一失败，这条 claim 一定被拒；不标 transient 就会被写进
  //    跨轮 rejected 集合，那一档之后永远不再尝试（要重启进程才发现漏领）。
  for (const kind of ['youduEvilClaim', 'youduWheelClaim']) {
    const rows = [...p1.actions, ...planYoudu(viewYoudu({
      ...base(),
      wheel: { ...base().wheel, score: 800, claimedId: 1 },
    }, { config: cfg }), { config: cfg }).actions].filter((a) => a.kind === kind);
    assert.ok(rows.length > 0, `${kind} 应当被排出来（夹具要能覆盖到）`);
    assert.ok(rows.every((a) => a.transient === true), `${kind} 必须标 transient，否则一次失败就永久拉黑该档`);
  }

  // 10. 法旨开局当轮直交：`EdictStartResponse.session.rune` 就是答案，不用等下一轮探测。
  const calls = [];
  const fake = { request: async (name, body) => { calls.push({ name, body }); return { success: true, reward: { asset: [] } }; } };
  const starts = [{ step: { kind: 'youduEdictStart' }, ok: true, body: { session: { rune: [2, 1, 6, 4], shown: [0, 0, 0, 0], patience: 100 } } }];
  const settled = await settleYouduEdict(fake, starts, { allowMutate: true });
  assert.equal(calls.length, 1, '开局成功后立刻补一条 EdictGuessRequest');
  assert.equal(calls[0].name, 'EdictGuessRequest', '补的是猜答案请求');
  assert.deepEqual(calls[0].body.guess, [2, 1, 6, 4], 'guess 取自 EdictStartResponse 的 session.rune');
  assert.equal(settled.results[0].ok, true, '直交结果记进 results');
  calls.length = 0;
  await settleYouduEdict(fake, starts, { allowMutate: false });
  assert.equal(calls.length, 0, '没有 allowMutate 时一条都不发');
  const noRune = await settleYouduEdict(fake, [{ step: { kind: 'youduEdictStart' }, ok: true, body: { session: { rune: [] } } }], { allowMutate: true });
  assert.equal(calls.length, 0, '开局回包没 rune 就不猜（猜错扣 10 耐心）');
  assert.ok(noRune.notes.length > 0, '要说明为什么没交');
  calls.length = 0;
  const notStarted = await settleYouduEdict(fake, [{ step: { kind: 'youduKill' }, ok: true, body: {} }], { allowMutate: true });
  assert.equal(calls.length, 0, '本轮没开局就不发 guess');
  assert.equal(notStarted.results.length, 0, '没开局也不产生结果');

  // 11. 活跃度不进静态计划（改成按回包推进的 runYouduActive）：
  //     没分可领时一轮只发 1 条，有积压时一轮连领到被拒为止。
  assert.equal(p1.actions.filter((a) => a.kind === 'youduActive').length, 0, '活跃度由 runYouduActive 单独处理');
  const claimCalls = [];
  const activeClient = (refuseAt) => ({
    request: async (name) => {
      claimCalls.push(name);
      if (claimCalls.length >= refuseAt) throw new Error('server prompt: no claimable reward');
      return { claimedId: claimCalls.length, reward: { asset: [{ id: '打雪仗体力', num: 20 }] } };
    },
  });
  claimCalls.length = 0;
  const drained = await runYouduActive(activeClient(4), { max: 8 });
  assert.equal(claimCalls.length, 4, '连领到被拒为止：3 档成功 + 第 4 次确认到头');
  assert.equal(drained.results.length, 3, '3 次成功进 results，被拒那次不算结果');
  assert.equal(drained.notes.length, 0, '领到头是正常结束，不用报说明');
  claimCalls.length = 0;
  const nothing = await runYouduActive(activeClient(1));
  assert.equal(claimCalls.length, 1, '没分可领时只发 1 条（不像静态排 5 条那样刷「跳过」）');
  assert.equal(nothing.notes.length, 1, '第一发就被拒要留一句说明');
  claimCalls.length = 0;
  await runYouduActive(activeClient(99), { max: 3 });
  assert.equal(claimCalls.length, 3, 'max 是硬上限（防止配置异常时无限连领）');
  const sum = summarizeYoudu([
    { step: { kind: 'youduActive' }, ok: false, error: 'server prompt: no claimable reward' },
    { step: { kind: 'youduActive' }, ok: false, skipped: true, error: '同类动作已失败，本轮不再尝试' },
    { step: { kind: 'youduKill' }, ok: true, body: { reward: { asset: [{ id: '活动26捞尸人_货币', num: 15 }] } } },
  ]);
  assert.equal(sum.fail, 0, '「领到头」与「同类已失败」都不算失败');
  assert.equal(sum.kill, 1, '成功的 kill 计数');
  assert.deepEqual(sum.rewards, [['活动26捞尸人_货币', 15]], '奖励明细要能解析出 id+数量');

  // 12. 法旨答案的边界：席位全 0 / 位数不对 → 不交（扣耐心不值）；但含 0 的合法 4 位要照交
  //     （别用 filter(v>0) 洗，洗了就把 4 位洗成 3 位、这一局永远交不出去）。
  const withRunes = (rune) => viewYoudu({
    ...base(),
    edict: { cost: { id: '活动26捞尸人_入场券', num: 1 }, session: { rune, shown: [0, 0, 0, 0], patience: 100 } },
  }, { config: cfg });
  const guessOf = (rune) => planYoudu(withRunes(rune), { config: cfg }).actions.filter((a) => a.kind === 'youduEdictGuess');
  assert.equal(guessOf([0, 0, 0, 0]).length, 0, '全 0 的 rune 不算答案');
  assert.equal(guessOf([1, 2, 3]).length, 0, '只有 3 位的 rune 不交');
  assert.deepEqual(guessOf([0, 3, 1, 6])[0]?.body.guess, [0, 3, 1, 6], '含 0 的合法答案要原样提交');
  // 开局这条也必须 transient（入场券是签到给的，今天没有明天可能有）。
  const startAction = p3.actions.find((a) => a.kind === 'youduEdictStart');
  assert.ok(startAction?.transient === true, 'youduEdictStart 必须 transient，否则没券那天会把它拉黑到进程结束');

  // 13. 「活动关闭」≠「网络断了」：三个 info 全挂时都是 open=false，但只有服务端明确
  //     回 prompt（74=ACTIVE_END）才算活动下线、退避 1 小时；掉线必须下一轮立刻重试。
  assert.equal(isYouduClosed('server prompt: prompt=74'), true, 'prompt 74 = 活动已关闭');
  assert.equal(isYouduClosed('prompt=ACTIVE_END'), true, 'ACTIVE_END 也算关闭');
  assert.equal(isYouduClosed('not connected'), false, '掉线不能当活动关闭（会白停 1 小时）');
  assert.equal(isYouduClosed('拿不到 EvilExpelInfoResponse，读不了活动'), false, '单条失败不算关闭');
  assert.equal(isYouduClosed(undefined), false, '没原因时按「没通」处理，下一轮重试');
  checked += 1;
}

console.log(`selftest ok: ${checked} 组检查通过（协议帧 / lz4 / 账号仓库 / 素材索引 / 二维码 / 海面计划 / 工厂视图 / 页面单元格契约 / 拾荒间隔与潜水禁令 / 活跃度宝箱 / 每日赠礼 / 循环日志物品明细 / 挂机领取 / 搁浅的货轮 / 海兽培育 / 贸易港口 / 海商王 / 联盟商船 / 国战攻城 / 酆都诡事 / 海盗讨伐 / 英雄养成 / 勋章升星 / 专武 / 日志脱敏与回包归档 / 今日收益统计）`);
