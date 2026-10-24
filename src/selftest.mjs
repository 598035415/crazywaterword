import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadProtocol } from './proto.mjs';
import { createCodec, HEADER_PREFIX } from './codec.mjs';
import { compressBlock, decompressBlock, compressBound, makeHashTable } from './lz4.mjs';
import { GameClient, SECRET_FRAMES, clipBody } from './client.mjs';
import { gateDue, humanDuration, formatLoopRound } from './loop.mjs';

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

  // 没有观察者时，prompt 仍然按老办法落到最后一条在飞请求上。
  client.pending.length = 0;
  const only = fake('ArenaChallengeRequest', 2);
  client.pending.push(only.entry);
  client.attributePrompt({ args: ['no chance left'] });
  assert.equal(only.state.settled, 'reject', 'without a watcher the newest pending entry takes the prompt');
  assert.equal(client.pending.length, 0);

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
  // 队列已占 2 格时，瞬成只补剩下的 4 格。
  const partial = planWorld(surveyFor({ seaweed: 9, queue: [{ idx: 1, productId: '烤鱼', finishTime: 5000 }, { idx: 2, productId: '烤鱼', finishTime: 0 }] }), { config });
  assert.equal(producesOf(partial).length, 4, 'an occupied queue only fills the free slots');

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
  assert.ok(short.notes.some((note) => note.includes('没种子可种')), 'the unplanted plots are explained');

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
    await runAction(client, protocol, id, { buildingId: 'x', productId: 'y', taskId: 1, index: 1, gridIdx: 1, useNum: 1, level: 1, isOn: true, id: 1, itemId: '原料自选包', selectItemId: '木材', num: 1, floaterId: 'f1' }, { allowMutate: true });
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
  assert.equal(gateDue(1_000_000, every, 1_000_000 + every - 1), false, '差 1ms 到间隔就还是不发');
  assert.equal(gateDue(1_000_000, every, 1_000_000 + every), true, '刚好到间隔就该发');
  assert.equal(gateDue(1_000_000, 0, 1_000_001), true, '间隔 0 = 不限制，每轮都试');
  assert.equal(gateDue(1_000_000, -5000, 1_000_001), true, '负数间隔也按不限制处理');

  assert.equal(humanDuration(40), '40 秒');
  assert.equal(humanDuration(320), '5 分 20 秒');
  assert.equal(humanDuration(1800), '30 分');
  assert.equal(humanDuration(3780), '1 小时 3 分');
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

  // 老 history（没有 gates 字段）不能炸。
  const legacy = formatLoopRound({ ...summary, gates: undefined });
  assert.ok(legacy.startsWith('第 3 轮'), '缺 gates 的旧轮次记录也要能正常格式化');
  checked += 1;
}

// 工厂页：读出队列倒计时与「这个等级能造什么」。判定只看 BuildingProduceCfg，
// 所以用合成配置就能跑，不依赖 CDN 快照。
{
  const { factoryRecipes, viewFactories } = await import('./factories.mjs');
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
  fs.rmSync(dir, { recursive: true, force: true });
  checked += 1;
}

console.log(`selftest ok: ${checked} 组检查通过（协议帧 / lz4 / 账号仓库 / 素材索引 / 二维码 / 海面计划 / 工厂视图 / 拾荒间隔与潜水禁令 / 活跃度宝箱 / 每日赠礼 / 日志脱敏与回包归档）`);
