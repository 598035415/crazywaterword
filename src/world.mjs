// 海面世界的只读探测与计划器：收成品、竣工、建造新建筑、交居民订单、按订单缺口排产、余料升级建筑。
//
// 所有事实都来自客户端自身的调用点与配置表，没有推测：
// - buildingId 形如 "1食品厂" / "1A民居" / "1指标楼A"，即 <序号><可选字母><建筑类型>，
//   类型按最长后缀去比 BuildingCfg.buildingType（58 种）。
// - 人口不是协议字段，是客户端算出来的：Σ BuildingUpgradeCfg[建筑类型][当前等级].effect 里的
//   「人口增加」；人口上限 = GameParamCfg 初始人口上限 + Σ「人口上限」。所以升级前的人口校验
//   可以离线复算（WaterModel._refreshPopulation 同款规则）。
// - 工厂队列上限 = BuildingProduceParamCfg 制造位上限（6），成品存量上限 = GameParamCfg 产品存量初始上限（50）。
// - 加速只花「加速器」：SpeedUpCostParam{type:2, useNum}（SpeedUpCost.SPEED_UP_ITEM=2）。
//   type=1 是钻石、type=3 是广告，本模块永不使用。
//
// 交互原则与 tasks.mjs 一致：先只读探测，再算出计划，显式授权后才逐条执行；
// 没有配套 Response 的写请求走 client.sendWatch()。

import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './worlds.mjs';

export const SPEED_UP_ITEM = '加速器';
export const SPEED_UP_ITEM_TYPE = 2;

// 允许计划器自动消耗的自选包。SelectPackLibCfg 里一共 20 种包，另外 18 种（装备材料包、
// 宠物基因自选包、英雄万能碎片、赛季钥匙自选包…）都更稀有，绝不能因为「缺某个材料」就被自动烧掉。
// 原料自选包能换：鱼 / 塑料 / 木材 / 碎布 / 金属 / 玻璃 / 海藻；
// 工事材料自选包能换：耐火砖 / 高温合金 / 炮弹 / 压电陶瓷 / 碳纤维 / 液态金属。
export const AUTO_PACK_ALLOWLIST = ['原料自选包', '工事材料自选包'];
const STOCK_PARAM = '产品存量初始上限';
const SLOTS_PARAM = '制造位上限';
const POPULATION_PARAM = '初始人口上限';

// 客户端 Resource 枚举：1=EXP 3=GOLD 4=RUBY 5=ARENA_POINT 6=LEAGUE_POINT。
// AllResourceResponse.list[].res 是数字，配置表的消耗项写的是名字，两边靠这张表对齐。
const RESOURCE_NAMES = { 1: 'EXP', 3: 'GOLD', 4: 'RUBY', 5: 'ARENA_POINT', 6: 'LEAGUE_POINT' };

function rowsOf(config, name) {
  return config?.tables?.[name]?.data ?? [];
}

// 这些常量散在几张 param 表里（人口/存量在 GameParamCfg，制造位在 BuildingProduceParamCfg），
// 名字不重复，所以统一按名字查。
function paramOf(config, name) {
  for (const table of ['GameParamCfg', 'BuildingProduceParamCfg']) {
    const row = rowsOf(config, table).find((r) => r.paramName === name);
    if (row) return row.paramValue ?? 0;
  }
  return 0;
}

function indexBy(config, name, key) {
  const out = new Map();
  for (const row of rowsOf(config, name)) out.set(row[key], row);
  return out;
}

// effect 是一组 [名字, 数值]，人口与上限都从这里累加。
function sumEffect(effect, name) {
  let total = 0;
  for (const entry of effect ?? []) {
    if (entry?.[0] === name) total += Number(entry[1] ?? 0);
  }
  return total;
}

// <序号><可选字母><建筑类型> 里抠出类型：取能匹配上的最长后缀。
export function makeTypeResolver(config) {
  const types = [...new Set(rowsOf(config, 'BuildingCfg').map((r) => r.buildingType))]
    .sort((a, b) => b.length - a.length);
  return (buildingId) => types.find((type) => buildingId.endsWith(type)) ?? null;
}

export function upgradeRow(config, buildingType, level) {
  return rowsOf(config, 'BuildingUpgradeCfg').find((r) => r.buildingType === buildingType && r.level === level) ?? null;
}

export function topLevel(config, buildingType) {
  return rowsOf(config, 'BuildingUpgradeCfg')
    .filter((r) => r.buildingType === buildingType)
    .reduce((max, r) => Math.max(max, r.level), 0);
}

// 只读探测：一次拉齐海面状态、库存、资源田、舰队。
export async function surveyWorld(client, protocol, { config = null, player = null, timeout = 8000 } = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, {}, responseName, timeout));
    } catch {
      return null;
    }
  };

  const water = await get('OnWaterRequest');
  if (!water) throw new Error('拿不到 OnWaterResponse，无法探测海面');
  const [itemList, resourceList, resFields, fleets] = await Promise.all([
    get('AllItemRequest'),
    get('AllResourceRequest'),
    get('MyResFieldsRequest'),
    get('MyFleetsRequest'),
  ]);

  // 道具和资源合到一张库存表里，消耗项的 id 有的是道具名（木材）、有的是资源名（GOLD）。
  // 数量可能是数字，也可能是没转换干净的 {low, high} int64 —— 裸 Number() 会得到 NaN，
  // 一路污染下去就变成「用 NaN 个加速器」发出去，服务端回 invalid speed-up count。
  const stock = new Map();
  const addStock = (id, num) => {
    const n = assetCount(num);
    if (n) stock.set(id, (stock.get(id) ?? 0) + n);
  };
  for (const item of itemList?.items ?? []) addStock(item.itemId ?? item.id, item.num ?? item.count);
  for (const entry of resourceList?.list ?? []) addStock(RESOURCE_NAMES[entry.res] ?? String(entry.res), entry.amount);

  const resolveType = makeTypeResolver(config);
  const notes = [];

  // 人口 / 人口上限：客户端同款累加，只算已建成的（level > 0）。
  let population = 0;
  let maxPopulation = paramOf(config, POPULATION_PARAM);
  const buildings = [];
  for (const rawBuilding of water.building ?? []) {
    // 整条先 normalize：factoryQ[].finishTime 和 product.asset[].num 都是 protobuf int64，
    // 原样保留会让「finishTime - now」算成 NaN，加速器数量跟着变 NaN 发出去，
    // 服务端回 invalid speed-up count。
    const raw = normalize(rawBuilding);
    const buildingId = raw.buildingId;
    const type = resolveType(buildingId);
    const level = raw.level ?? 0;
    const current = upgradeRow(config, type, level);
    population += sumEffect(current?.effect, '人口增加');
    maxPopulation += sumEffect(current?.effect, '人口上限');
    if (!type) notes.push(`建筑 ${buildingId} 的类型没在 BuildingCfg 里匹配上，跳过`);
    buildings.push({
      buildingId,
      type,
      level,
      factory: raw.factory ?? null,
      product: (raw.product?.asset ?? []).map((a) => ({ id: a.id, num: Number(a.num ?? 0) })),
      buildStartTime: raw.buildStartTime ?? 0,
      buildFinishTime: raw.buildFinishTime ?? 0,
      auto: raw.auto === true,
      population: sumEffect(current?.effect, '人口增加'),
    });
  }

  const orderCfg = indexBy(config, 'WorkerOrderCfg', 'itemId');
  const specOrderCfg = indexBy(config, 'WorkerSpecOrderCfg', 'times');
  const have = (id) => stock.get(id) ?? 0;

  const orders = (water.workerOrder ?? []).map((raw) => {
    const requirements = (raw.requirements ?? []).map((r) => ({ id: r.id, num: Number(r.num ?? 0) }));
    const missing = requirements
      .map((r) => ({ id: r.id, num: Math.max(0, r.num - have(r.id)) }))
      .filter((r) => r.num > 0);
    // 订单经验：特殊订单看 WorkerSpecOrderCfg（times 就是 textId），普通订单按需求项累加。
    let rewardExp = null;
    if (raw.isSpecial) {
      const row = specOrderCfg.get(raw.textId) ?? specOrderCfg.get(String(raw.textId));
      rewardExp = Number((row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1] ?? 0) || null;
    } else {
      let total = 0;
      let known = requirements.length > 0;
      for (const r of requirements) {
        const row = orderCfg.get(r.id);
        const exp = (row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1];
        if (exp === undefined) known = false;
        else total += Number(exp) * r.num;
      }
      rewardExp = known ? total : null;
    }
    return {
      index: raw.index,
      workerId: raw.workerId,
      textId: raw.textId,
      isSpecial: raw.isSpecial === true,
      refreshTime: raw.refreshTime ?? 0,
      requirements,
      missing,
      rewardExp,
    };
  });

  const factories = buildings.filter((b) => b.factory);
  const resFieldInfo = resFields?.info ?? null;

  return {
    now: Math.floor(Date.now() / 1000),
    player,
    stock,
    have,
    buildings,
    factories,
    orders,
    orderOfTheDay: water.orderOfTheDay ?? { orderNum: 0, rewardedNum: 0 },
    autoProduceEndTime: water.autoProduceEndTime ?? 0,
    autoProduceForever: water.autoProduceForever === true,
    // 海面漂浮物 = 拾荒的目标。以前只留了个 count 把列表丢了，现在整条留下来给计划器用。
    floaters: normalize(water.floater ?? []),
    floaterCount: (water.floater ?? []).length,
    population,
    maxPopulation,
    stockCap: paramOf(config, STOCK_PARAM),
    factorySlots: paramOf(config, SLOTS_PARAM),
    resFields: resFieldInfo ? normalize(resFieldInfo) : null,
    fleets: normalize(fleets?.fleets ?? []),
    notes,
  };
}

// 计划：收成品 → 竣工 → 建造 → 交单 → 排产 → 余料升级 → 加速。每步都只排「客户端确实会发的请求」。
export function planWorld(survey, {
  config = null,
  allowSpeedUp = false,
  allowReroll = false,
  useSelectPack = true,
  allowPacks = null,
  maxPackPerRound = 20,
  pickUpFloaters = false,
  maxPickups = 50,
  minOrderExp = 0,
  maxUpgrades = 2,
  maxBuilds = 5,
} = {}) {
  const { now, have } = survey;
  const actions = [];
  const notes = [];
  const reserved = new Map();
  const reserve = (id, num) => reserved.set(id, (reserved.get(id) ?? 0) + Number(num ?? 0));

  // 自选包兜底：材料不齐时，用「原料自选包 / 工事材料自选包」兑出来。
  // 兑换关系在 SelectPackLibCfg：itemId = 包，selectItemId = 能换出的材料，num = 每包产出。
  // 协议是 SelectPackRequest { itemId, selectItemId, num }。
  // 只有表里列出的材料才兑得到 —— 缺「布匹」这种不在任何原料包里的东西时，这里查不到就直接跳过。
  // 一包只顶一个单位，所以它只能补零头（比如订单差 3 个木材），补不了「玻璃差 500」这种大缺口，
  // 因此每轮消耗上限由 maxPackPerRound 卡住，默认 20。
  const allowedPacks = new Set(allowPacks ?? AUTO_PACK_ALLOWLIST);
  const packForItem = new Map();
  const packRate = new Map();
  for (const row of rowsOf(config, 'SelectPackLibCfg')) {
    if (!row?.itemId || !row?.selectItemId) continue;
    if (!allowedPacks.has(row.itemId)) continue; // 稀有的装备/基因/碎片包不参与自动兜底
    if (packForItem.has(row.selectItemId)) continue; // 同一材料有多个包时取表里第一条
    packForItem.set(row.selectItemId, row.itemId);
    packRate.set(row.selectItemId, Number(row.num) || 1);
  }
  const covered = new Map();  // 靠包补到的量，乐观计入库存（兑换动作排在使用它的动作之前）
  const packLeft = new Map(); // 各包本轮还能用几个
  let packQuota = Math.max(0, Number(maxPackPerRound) || 0);

  // 可用量 = 库存 + 靠包补到的 - 已预留
  const free = (id) => have(id) + (covered.get(id) ?? 0) - (reserved.get(id) ?? 0);

  // 材料够了返回 true；不够就尽量用包补，补完够也返回 true。
  const cover = (needs, label) => {
    const gaps = needs
      .map((n) => ({ id: n.id, num: Number(n.num ?? 0) }))
      .filter((n) => n.num > 0 && free(n.id) < n.num)
      .map((n) => ({ id: n.id, gap: n.num - free(n.id) }));
    if (gaps.length === 0) return true;
    if (!useSelectPack || packQuota <= 0) return false;

    let enough = true;
    for (const g of gaps) {
      const pack = packForItem.get(g.id);
      if (!pack) {
        notes.push(`${label} 缺 ${g.id}，但没有能换它的自选包`);
        enough = false;
        continue;
      }
      if (!packLeft.has(pack)) packLeft.set(pack, Number(have(pack)));
      const budget = Math.min(packLeft.get(pack), packQuota);
      if (budget <= 0) {
        notes.push(`${label} 缺 ${g.id}，但 ${pack} 数量不够（库存 ${have(pack)}，本轮额度已用完）`);
        enough = false;
        continue;
      }

      const per = packRate.get(g.id) ?? 1;
      const packs = Math.min(Math.ceil(g.gap / per), budget);
      const gain = Math.min(packs * per, g.gap);
      if (gain <= 0) {
        enough = false;
        continue;
      }

      actions.push({
        kind: 'selectPack',
        request: 'SelectPackRequest',
        response: null,
        body: { itemId: pack, selectItemId: g.id, num: gain },
        label: `兑材料 ${g.id} ×${gain}（${label}，消耗${pack} ${packs} 个）`,
      });
      covered.set(g.id, (covered.get(g.id) ?? 0) + gain);
      packLeft.set(pack, packLeft.get(pack) - packs);
      packQuota -= packs;
      if (gain < g.gap) enough = false;
    }
    return enough;
  };

  // 0. 拾荒：海面上的漂浮物一次提交就能全捡 —— PickUpFloaterRequest.floaterId 是
  //    **repeated string**（客户端 encode 里是 `for (r < e.floaterId.length) uint32(18).string(...)`），
  //    传单个字符串会被按字符长度拆成 N 个单字 id，服务端一律回 invalid floater id。
  //    默认关闭 —— 网页勾「自动拾荒」、CLI 加 --pick 才做。
  if (pickUpFloaters) {
    const ids = (survey.floaters ?? [])
      .map((f) => f?.floaterId)
      .filter(Boolean)
      .slice(0, maxPickups);
    if (ids.length > 0) {
      actions.push({
        kind: 'pickUpFloater',
        request: 'PickUpFloaterRequest',
        response: 'PickUpFloaterResponse',
        body: { floaterId: ids },
        label: `拾荒 ${ids.length} 件漂浮物`,
      });
    }
    const total = (survey.floaters ?? []).length;
    if (total > maxPickups) {
      notes.push(`海面还有 ${total - maxPickups} 件漂浮物，本轮拾荒额度用完，下一轮继续`);
    }
  }

  // 1. 收成品：工厂走 GainFactoryProduce，非工厂建筑的囤积产物一次性批量收。
  for (const b of survey.factories) {
    if ((b.factory.finishedProducts ?? []).length > 0) {
      actions.push({
        kind: 'gainFactory',
        request: 'GainFactoryProduceRequest',
        response: 'GainFactoryProduceResponse',
        body: { buildingId: b.buildingId },
        label: `收成品 ${b.buildingId}`,
      });
    }
  }
  const collectible = survey.buildings.filter((b) => !b.factory && b.product.length > 0).map((b) => b.buildingId);
  if (collectible.length > 0) {
    actions.push({
      kind: 'collectProduct',
      request: 'CollectBuildingProductRequest',
      response: 'CollectBuildingProductResponse',
      body: { buildingId: collectible },
      label: `收建筑产物 ${collectible.join(',')}`,
    });
  }

  // 2. 竣工：建造时间已过的建筑先收尾，收尾后它才能继续升级。
  const finishing = new Set();
  for (const b of survey.buildings) {
    if (b.buildFinishTime > 0 && b.buildFinishTime <= now) {
      finishing.add(b.buildingId);
      actions.push({
        kind: 'finishUpgrade',
        request: 'FinishUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId },
        label: `竣工 ${b.buildingId}`,
      });
    }
  }

  // 3. 建造：OnWaterResponse 里 level=0 的建筑是空位——要么「已解锁但没盖」，要么正在盖。
  //    客户端的分支很明确（subpackages/main/game.js 的 _toBuildOrUpgradeRequest）：
  //    `0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`，所以建造这一条与升级不是同一个请求。
  //    判据是 BuildingUpgradeCfg 的 level 1 行（实测 49 种建筑这一行全是 costTime 0 / consume 空，
  //    只卡 playerLevel）。材料不齐时客户端会先用钻石买，本工具不这么做，直接跳过等下一轮。
  const builds = [];
  for (const b of survey.buildings) {
    if (!b.type || b.level !== 0) continue;
    // buildFinishTime 在将来 = 正在盖，重复发只会被拒；等它到了由上面的竣工步骤收尾。
    if (b.buildFinishTime > now) continue;
    // 本轮刚排了竣工的，收尾后它就是 level 1 了，同一轮再发建造必被拒。
    if (finishing.has(b.buildingId)) continue;
    const row = upgradeRow(config, b.type, 1);
    if (!row) continue;
    if ((row.condition ?? []).length > 0) {
      notes.push(`${b.buildingId} 建造有额外条件 ${JSON.stringify(row.condition)}，跳过`);
      continue;
    }
    if (row.playerLevel > (survey.player?.level ?? 1)) {
      notes.push(`${b.buildingId} 建造要等级 ${row.playerLevel}，当前 ${survey.player?.level ?? 1}，先推主线`);
      continue;
    }
    const consume = (row.consume ?? []).map(([id, n]) => ({ id, num: Number(n) }));
    if (!consume.every((c) => free(c.id) >= c.num) && !cover(consume, `建造 ${b.buildingId}`)) {
      const short = consume.filter((c) => free(c.id) < c.num).map((c) => `${c.id} ${free(c.id)}/${c.num}`).join(' ');
      notes.push(`${b.buildingId} 建造材料不足（${short}），不买材料，等下一轮`);
      continue;
    }
    builds.push({ building: b, row, consume });
  }
  builds.sort((a, b) => a.row.playerLevel - b.row.playerLevel || a.building.buildingId.localeCompare(b.building.buildingId));
  for (const u of builds.slice(0, maxBuilds)) {
    for (const c of u.consume) reserve(c.id, c.num);
    actions.push({
      kind: 'build',
      request: 'BuildBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      label: `建造 ${u.building.buildingId}（需等级 ${u.row.playerLevel}）`,
    });
  }
  for (const u of builds.slice(maxBuilds)) notes.push(`${u.building.buildingId} 本轮建造额度用完，下一轮再建`);

  // 4. 交居民订单：材料齐就交；不齐先试着用自选包补，补不上再按开关决定要不要拒绝重刷。
  for (const order of survey.orders) {
    // order.missing 的 num 是「还差多少」，cover 里再按 free() 扣掉本轮已补的量，不会重复兑。
    if (!order.missing.every((m) => free(m.id) >= m.num)) cover(order.missing, `订单 #${order.index}`);
    const buildable = order.missing.every((m) => free(m.id) >= m.num);
    if (buildable) {
      for (const r of order.requirements) reserve(r.id, r.num);
      actions.push({
        kind: 'finishOrder',
        request: 'FinishWorkerOrderRequest',
        response: 'FinishWorkerOrderResponse',
        body: { index: order.index },
        label: `交订单 #${order.index}（经验 ${order.rewardExp ?? '?'}）`,
      });
      continue;
    }
    const short = order.missing.map((m) => `${m.id} ${free(m.id)}/${m.num}`).join(' ');
    if (!allowReroll) {
      notes.push(`订单 #${order.index} 材料不足（${short}），未开 --reroll，保留`);
    } else if ((order.rewardExp ?? 0) < minOrderExp) {
      actions.push({
        kind: 'denyOrder',
        request: 'DenyOrderRequest',
        response: null,
        body: { index: order.index },
        label: `拒绝低价值订单 #${order.index}（经验 ${order.rewardExp ?? '?'} < ${minOrderExp}）`,
      });
    } else {
      notes.push(`订单 #${order.index} 材料不足（${short}），保留等待生产`);
    }
  }

  // 5. 排产：按订单缺口挑配方，缺得多的先产；已设自动生产的工厂不覆盖。
  const demand = new Map();
  for (const order of survey.orders) {
    for (const m of order.missing) demand.set(m.id, (demand.get(m.id) ?? 0) + m.num);
  }
  const produceRows = rowsOf(config, 'BuildingProduceCfg');
  for (const b of survey.factories) {
    if (b.factory.autoProductId) {
      notes.push(`${b.buildingId} 已设自动生产 ${b.factory.autoProductId}，不覆盖`);
      continue;
    }
    const queue = b.factory.factoryQ ?? [];
    if (queue.length >= survey.factorySlots) continue;
    const cand = produceRows
      .filter((row) => row.buildType === b.type && row.unlockLevel <= b.level)
      .filter((row) => !queue.some((job) => job.productId === row.itemId))
      .filter((row) => have(row.itemId) < survey.stockCap)
      .filter((row) => (row.costItem ?? []).every(([id, n]) => free(id) >= n));
    if (cand.length === 0) continue;
    // 订单缺口的先产，其余按产出时间短的先产（早点回本）。
    const score = (row) => (demand.get(row.itemId) ?? 0) * 1e6 - row.produceTime;
    const best = cand.sort((a, b2) => score(b2) - score(a))[0];
    for (const [id, n] of best.costItem ?? []) reserve(id, n);
    const need = demand.get(best.itemId) ?? 0;
    actions.push({
      kind: 'startProduce',
      request: 'StartFactoryProduceRequest',
      response: null,
      body: { buildingId: b.buildingId, productId: best.itemId },
      label: `排产 ${b.buildingId} -> ${best.itemId}（${best.produceTime}s${need ? `，订单缺 ${need}` : ''}）`,
    });
  }

  // 6. 余料升级建筑：把订单与排产占用的材料扣掉之后再比升级消耗，按人口需求升序（便宜的先生效）。
  const upgrades = [];
  for (const b of survey.buildings) {
    if (!b.type || b.level <= 0) continue;
    if (b.buildFinishTime > 0) continue;
    const next = b.level + 1;
    if (next > topLevel(config, b.type)) continue;
    const row = upgradeRow(config, b.type, next);
    if (!row) continue;
    if ((row.condition ?? []).length > 0) {
      notes.push(`${b.buildingId} 升级有额外条件 ${JSON.stringify(row.condition)}，跳过`);
      continue;
    }
    if (row.playerLevel > (survey.player?.level ?? 1)) continue;
    if (row.curPeople > survey.population) continue;
    const consume = (row.consume ?? []).map(([id, n]) => ({ id, num: Number(n) }));
    if (!consume.every((c) => free(c.id) >= c.num) && !cover(consume, `升级 ${b.buildingId}`)) continue;
    upgrades.push({ building: b, row, consume, costTime: row.costTime ?? 0 });
  }
  upgrades.sort((a, b) => a.row.curPeople - b.row.curPeople || a.costTime - b.costTime);
  const picked = upgrades.slice(0, maxUpgrades);
  for (const u of picked) {
    for (const c of u.consume) reserve(c.id, c.num);
    actions.push({
      kind: 'upgrade',
      request: 'UpgradeBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      label: `升级 ${u.building.buildingId} ${u.building.level}->${u.building.level + 1}（${u.costTime}s，人口 ${u.row.curPeople}）`,
    });
  }
  const held = upgrades.slice(maxUpgrades);
  for (const u of held) notes.push(`${u.building.buildingId} 本轮升级额度用完，下一轮再升`);

  // 7. 加速：只花「加速器」，而且只对真的在等的建造/生产用。
  //    每个数量都过 Number.isFinite，宁可这次不加速，也别把 NaN 当数量发出去。
  if (allowSpeedUp) {
    const speeders = Number(have(SPEED_UP_ITEM));
    let left = Number.isFinite(speeders) ? speeders : 0;
    for (const b of survey.buildings) {
      const finishTime = Number(b.buildFinishTime);
      if (!Number.isFinite(finishTime) || finishTime <= now || left <= 0) continue;
      const minutes = Math.ceil((finishTime - now) / 60);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      const useNum = Math.max(1, Math.min(minutes, left));
      if (!Number.isFinite(useNum) || useNum <= 0) continue;
      left -= useNum;
      actions.push({
        kind: 'speedUpUpgrade',
        request: 'SpeedUpUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
        label: `加速建造 ${b.buildingId} 用 ${useNum} 个${SPEED_UP_ITEM}`,
      });
    }
    for (const b of survey.factories) {
      for (const job of b.factory.factoryQ ?? []) {
        const finishTime = Number(job.finishTime);
        if (!Number.isFinite(finishTime) || finishTime <= now || left <= 0) continue;
        const minutes = Math.ceil((finishTime - now) / 60);
        if (!Number.isFinite(minutes) || minutes <= 0) continue;
        const useNum = Math.max(1, Math.min(minutes, left));
        if (!Number.isFinite(useNum) || useNum <= 0) continue;
        left -= useNum;
        actions.push({
          kind: 'speedUpProduce',
          request: 'SpeedUpFactoryProduceRequest',
          response: null,
          body: { buildingId: b.buildingId, index: job.idx, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
          label: `加速生产 ${b.buildingId} 用 ${useNum} 个${SPEED_UP_ITEM}`,
        });
      }
    }
    if (left === speeders) notes.push(`${SPEED_UP_ITEM} 有 ${speeders} 个，但没有等待中的建造或生产`);
  }

  return { actions, notes, reserved: [...reserved].filter(([, n]) => n > 0) };
}

export function stepKey(step) {
  // selectPack 的 body 里没有 buildingId/index，用 selectItemId（材料名，天然唯一）区分，
  // 否则多个兑换动作会撞成同一个 key，被 rejected 集合误伤。
  const target = step.body?.buildingId ?? step.body?.index ?? step.body?.selectItemId ?? '';
  return `${step.kind}:${Array.isArray(target) ? target.join('+') : target}`;
}

// 逐条执行。同类动作失败就跳过该类的剩余动作；被服务端拒过的具体动作记进 rejected，
// 循环模式下后续轮次不再重发（否则每轮都会骚扰一次同一个必败请求）。
export async function runWorld(client, protocol, plan, {
  allowMutate = false,
  window = 400,
  timeout = 15000,
  rejected = new Set(),
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('海面自动化会改变账号状态，需要 --yes');
  const results = [];
  const blocked = new Set();
  for (const step of plan.actions) {
    const key = stepKey(step);
    let entry;
    if (rejected.has(key)) entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
    else if (blocked.has(step.kind)) entry = { step, ok: false, skipped: true, error: `同类动作已失败，本轮不再尝试` };
    else if (!protocol[step.request]) entry = { step, ok: false, error: `协议表里没有 ${step.request}` };
    else {
      try {
        if (step.response && protocol[step.response]) {
          const body = await client.request(step.request, step.body, step.response, timeout);
          entry = { step, ok: true, body };
        } else {
          // 没有配套 Response：静默即成功，回包是 PromptResponse 就是被拒。
          const sent = await client.sendWatch(step.request, step.body, { window });
          entry = { step, ok: true, sent };
        }
      } catch (error) {
        rejected.add(key);
        blocked.add(step.kind);
        entry = { step, ok: false, error: error.message };
      }
    }
    results.push(entry);
    onStep?.(entry);
    if (entry.ok) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { results, rejected, blocked: [...blocked] };
}

// --- 拾荒所得统计 --------------------------------------------------------------
//
// PickUpFloaterResponse.reward 是 DisplayAssetPackage{asset: DisplayAsset[]}，
// 每个 DisplayAsset 是 {type, id, num}。num 是 protobuf int64：normalize 过的会是数字，
// 没 normalize 的会是 {low, high, unsigned} 对象，两种形状都得吃得下。
function assetCount(num) {
  if (typeof num === 'number') return Number.isFinite(num) ? num : 0;
  if (num && typeof num === 'object') return Number(num.low ?? 0) + Number(num.high ?? 0) * 2 ** 32;
  return Number(num ?? 0) || 0;
}

// 藏品碎片在奖励里是按编号分开的（藏品蓝10碎片、藏品蓝11碎片、藏品紫2碎片…），
// 一次拾荒能出几十条，单独列出来完全没法读。汇总时把编号抹掉，合并成「藏品蓝碎片 ×8」。
// 「藏品蓝碎片」本身没有数字，不会被这条规则误伤。
function lootKey(id) {
  const hit = /^(藏品\D+?)\d+碎片$/.exec(String(id ?? ''));
  return hit ? `${hit[1]}碎片` : id;
}

export function summarizeFloaters(results) {
  const loot = new Map();
  let submitted = 0;
  let denied = 0;
  let failed = 0;
  for (const entry of results ?? []) {
    if (entry?.step?.kind !== 'pickUpFloater') continue;
    if (entry.skipped) continue;
    // 件数看提交的 floaterId 有多少个 —— 一个请求可能装了 50 件，
    // 按「请求数」计会显示成「拾荒 1 件」，跟实际差了两个数量级。
    const ids = entry.step?.body?.floaterId ?? [];
    const count = Array.isArray(ids) ? ids.length : 0;
    if (!entry.ok) {
      failed += count;
      continue;
    }
    submitted += count;
    for (const a of entry.body?.reward?.asset ?? []) {
      if (!a?.id) continue;
      const n = assetCount(a.num);
      const key = lootKey(a.id);
      if (n > 0) loot.set(key, (loot.get(key) ?? 0) + n);
    }
    denied += (entry.body?.deniedFloaterIds ?? []).length;
  }
  const items = [...loot.entries()]
    .map(([id, num]) => ({ id, num }))
    .sort((a, b) => b.num - a.num || a.id.localeCompare(b.id));
  return {
    submitted,
    picked: Math.max(0, submitted - denied),
    denied,
    failed,
    items,
    total: submitted + failed,
  };
}

// 一次拾荒能出 30 种碎片，整行铺出来没法读，超过 12 种就折叠。
const LOOT_SHOW = 12;

export function formatFloaters(summary) {
  if (!summary || summary.total === 0) return '';
  const extras = [];
  if (summary.denied) extras.push(`被拒 ${summary.denied}`);
  if (summary.failed) extras.push(`失败 ${summary.failed}`);
  const head = `拾荒 ${summary.submitted + summary.failed} 件`
    + (extras.length ? `（${extras.join('，')}）` : '');
  if (!summary.items.length) return `${head}（没有回报）`;
  const shown = summary.items.slice(0, LOOT_SHOW).map((x) => `${x.id}×${x.num}`).join('  ');
  const more = summary.items.length > LOOT_SHOW ? `  等 ${summary.items.length} 种` : '';
  return `${head}：${shown}${more}`;
}

// --- 资源田 ------------------------------------------------------------------
//
// 「哪些 gridIdx 是田、是什么类型」不在协议里也不在 591 张配置表里，只在 CDN bundle world_map 的
// JsonAsset 里。跑 node tools/fetch-map.mjs 会按 settings.json 的 bundleVers 定位并下到 work/cdn/，
// 编码是 resType * 10000 + cityId。
// 占田（ChallengeResFieldRequest）要求「该田所属城是我方城 + 有闲置且 durability > 0 的舰队」，
// 账号没有舰队时这一步必然失败，所以本模块只做只读报告 + 显式手动占田/放弃，不做无人值守的自动占田。

export const MAP_DIR = path.resolve(import.meta.dirname, '../work/cdn');

export function mapPath(scenarioId) {
  return path.join(MAP_DIR, `world_map.world_map${scenarioId > 0 ? scenarioId : 1}.json`);
}

// 读地图 JsonAsset。没有下载过就返回 null（调用方降级成「不知道这块田在哪」）。
export function loadMapAsset(scenarioId) {
  const file = mapPath(scenarioId);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = raw?.[5]?.[0]?.[2];
  if (!data?.mapData) return null;
  const { mapInfo, cityInfo, mapData } = data;
  return {
    file,
    scenarioId: scenarioId > 0 ? scenarioId : 1,
    width: mapInfo?.width ?? 0,
    height: mapInfo?.height ?? 0,
    cityInfo,
    fieldCount: mapData.reduce((n, v) => n + (Math.floor(v / 10000) % 10 ? 1 : 0), 0),
    fieldAt(gridIdx) {
      const v = mapData[gridIdx];
      if (v === undefined) return null;
      const resType = Math.floor(v / 10000) % 10;
      if (!resType) return null;
      return { gridIdx, resType, cityId: v % 1000 };
    },
  };
}

// 舰队状态：1=IDLE 2=MOVING 3=BATTLING 4=REPAIRING 5=QUEUING（客户端 FleetState 枚举）。
export function idleFleets(survey) {
  return (survey.fleets ?? []).filter((f) => Number(f.state) === 1 && Number(f.durability) > 0);
}

export function formatFieldReport(survey, map) {
  const lines = [];
  const info = survey.resFields;
  const fields = info?.fields ?? [];
  lines.push(`已占资源田 ${fields.length}/${info?.maxNum ?? '?'}`);
  for (const f of fields) {
    const at = map?.fieldAt(f.gridIdx);
    lines.push(`  gridIdx=${f.gridIdx} cityId=${f.cityId} type=${f.type}${at ? ` (地图: 城 ${at.cityId} 类型 ${at.resType})` : ''}`);
  }
  const idle = idleFleets(survey);
  lines.push(`舰队 ${survey.fleets.length} 支，其中闲置可用 ${idle.length} 支${idle.length ? ` (${idle.map((f) => f.buildingId).join(',')})` : ''}`);
  if (map) {
    lines.push(`地图 ${path.basename(map.file)} ${map.width}x${map.height}，资源田 ${map.fieldCount} 块，城池 ${Object.keys(map.cityInfo ?? {}).length} 座`);
  } else {
    lines.push(`没有本地地图资源（${mapPath(1)}），先跑 node tools/fetch-map.mjs 才有 gridIdx → 城池/类型 的对照`);
  }
  if (survey.fleets.length === 0) lines.push('没有舰队，占田的前置条件（闲置且耐久>0 的舰队）不满足，只能放弃已占的田');
  return lines.join('\n');
}

// 手动占田：显式给 gridIdx，舰队要么点名要么自动挑闲置的；条件不满足就直接拒绝，不发请求。
export function planFieldOccupy(survey, gridIdx, { fleetBuildingIds = [] } = {}) {
  const info = survey.resFields;
  if (info && (info.fields ?? []).length >= (info.maxNum ?? 0)) {
    return { error: `已占 ${info.fields.length}/${info.maxNum} 块田，达到上限` };
  }
  const idle = idleFleets(survey);
  const picks = fleetBuildingIds.length > 0 ? fleetBuildingIds : idle.slice(0, 1).map((f) => f.buildingId);
  if (picks.length === 0) {
    return { error: '没有闲置且耐久>0 的舰队可派，占田会被服务端拒绝' };
  }
  const known = new Set((survey.fleets ?? []).map((f) => f.buildingId));
  const unknown = picks.filter((id) => !known.has(id));
  if (unknown.length > 0) return { error: `舰队 ${unknown.join(',')} 不在 MyFleetsResponse 里` };
  return {
    action: {
      kind: 'challengeField',
      request: 'ChallengeResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx), fleetBuildingIds: picks },
      label: `占田 gridIdx=${gridIdx} 派 ${picks.join(',')}`,
    },
  };
}

export function planFieldGiveUp(survey, gridIdx) {
  const owned = (survey.resFields?.fields ?? []).some((f) => Number(f.gridIdx) === Number(gridIdx));
  if (!owned) return { error: `gridIdx=${gridIdx} 不在我已占的田里` };
  return {
    action: {
      kind: 'giveUpField',
      request: 'GiveUpResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx) },
      label: `放弃资源田 gridIdx=${gridIdx}`,
    },
  };
}

export function formatWorldPlan(survey, plan) {
  const lines = [];
  lines.push(`人口 ${survey.population}/${survey.maxPopulation}  库存 ${survey.stock.size} 种  工厂 ${survey.factories.length} 栋  订单 ${survey.orders.length} 条`);
  if (survey.resFields) {
    const fields = survey.resFields.fields ?? [];
    lines.push(`资源田 ${fields.length}/${survey.resFields.maxNum ?? '?'}${fields.length ? `  已占 ${fields.map((f) => f.gridIdx).join(',')}` : ''}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of [...survey.notes, ...plan.notes]) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
