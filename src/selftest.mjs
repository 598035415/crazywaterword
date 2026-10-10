import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadProtocol } from './proto.mjs';
import { createCodec, HEADER_PREFIX } from './codec.mjs';
import { compressBlock, decompressBlock, compressBound, makeHashTable } from './lz4.mjs';
import { GameClient } from './client.mjs';

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
    'ChallengeResFieldRequest', 'GiveUpResFieldRequest',
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
    await runAction(client, protocol, id, { buildingId: 'x', productId: 'y', taskId: 1, index: 1, gridIdx: 1, useNum: 1, level: 1, isOn: true, id: 1 }, { allowMutate: true });
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

console.log(`selftest ok: ${checked} 组检查通过（协议帧 / lz4 / 账号仓库 / 素材索引 / 二维码 / 海面计划 / 活跃度宝箱 / 每日赠礼）`);
