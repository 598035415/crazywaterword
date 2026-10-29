// 海面世界的只读探测与计划器：收成品、竣工、建造新建筑、交居民订单、按需求缺口排产、余料升级建筑。
// 「需求缺口」= 居民订单缺的 + 外部传进来的（贸易港口的货船缺口，见 cargoDemand）。
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
// 工事材料在 ItemCfg 里的 type 是「加工品」（跟 158 种中间产物混在一起），认不出来，
// 所以从「用哪个包能换到它」反查 —— SelectPackLibCfg 本来就是这张对应表。
export const WORK_MATERIAL_PACK = '工事材料自选包';
// 工厂页（factories.mjs）也要按同样的表查这两项常量，导出出去免得两套口径。
export const STOCK_PARAM = '产品存量初始上限';
export const SLOTS_PARAM = '制造位上限';
const POPULATION_PARAM = '初始人口上限';
// BuildingCfg.buildingType 里的农田名（UI 名同款）。农田只能靠它认，
// 因为服务端只在有作物时才编码 building.farm，空地回包里没有这个字段。
export const FARM_TYPE = '农田';
// 农田产物「单种库存上限」（实测推断，2026-10-27）：
//   土豆 245 时播种成功（13:28 OkResponse），260 起一律 `item limit reached`（13:58 起每轮被拒）。
//   说明线落在 245~260 之间，取 250 保守值。注意**收获不校验上限** ——
//   4 块地同时收会把库存顶过线（245 → 260），顶过去就再也种不上，所以播种前必须自己卡住。
// 传 0 关闭这条保护（想回到「不管库存、能种就种」时用）。
export const FARM_CROP_CAP = 250;
// 农田「想种什么」反馈给种子厂的两个阈值（见 planWorld 里那段 farmSeed 需求）：
//   FARM_SEED_RESERVE 每种作物至少备几个种子 —— 8 = 两轮（4 块地 × 2）。
//     种子厂一炉 1800~7200 秒只出 **1 个**，而 4 块地 1800 秒就要吃掉 4 个（4 倍缺口），
//     只备 4 个的话第二轮就断种。种子能存到 50，多备几个是免费的缓冲。
//   FARM_CROP_COMFORT 作物库存低于它就当「缺」，才值得为它专门产种子（40 远低于上限 250，
//     不会给正在爆仓的土豆/小麦再加需求）；同时也是「安全水位」的地板值。
export const FARM_SEED_RESERVE = 8;
export const FARM_CROP_COMFORT = 40;
// 种子厂的「别排到上限」余量（2026-10-28）：种子一炉只出 1 个，堆到 50 就是纯浪费 ——
// 实测小麦种子 45/50 还被排了 4 个（6 个队列位占了 4 个），而真正缺的番茄种子（0 个）只排上 1 个。
// 留 5 个余量后，接近上限的种子不进 pool，队列位自然让给缺的那种。
export const SEED_STOCK_MARGIN = 5;
// 作物「安全水位」的最高档（分档见 planWorld 里的 waterlineOf）。
// 高于水位的库存算「过剩」：工厂该去吃它，农田暂时不用再种 ——
// 否则 13 种作物会一起被推到单种上限 250，然后上限过滤把每一种都剔掉，
// 地块永久空着（死局），而仓库里全是工厂吃不掉的存货。
//   6 条配方（小麦/番茄）200 · 5 条（橡胶）180 · 4 条（胡萝卜）150
//   3 条（大豆/可可豆）120 · 2 条（玉米/土豆/卷心菜/辣椒/花菜）80 · 1 条（南瓜/茄子）40
// 配方表里查不到的作物退回 FARM_CROP_COMFORT(40)，绝不让它变成 0（那会让农田全面停摆）。
export const FARM_CROP_WATERLINE_MAX = 200;
// 「用过剩作物排产」时每种成品最多加几份需求。216 个小麦能折成 36 份海鲜披萨（226 分钟），
// 不限的话 6 个制造位全被它钉死，真正缺料的配方反而排不进来。
export const FARM_FEED_MAX = 3;

// 生产时间的公式是**减免后**的，不是 BuildingProduceCfg.produceTime 原值：
//   BuildingProduceUtil.produceFinalTime = ceil( max(0, produceTime - reduce) / (1 + speedUp) )
//   reduce  = GameEffectId.PRODUCE_TIME_REDUCTION（「生产时间减少」，单位秒）
//   speedUp = GameEffectId.PRODUCE_SPEED_UP（按百分比提速，只由服务端 effect 推送，配置表里没有）
// reduce 的大头是英雄委任：AppointPosCfg 里 posId 1/2/3 三条效果都是「生产时间」，
// 单个英雄的贡献 = AppointEffectCfg.heroAdd[品质档-1] + starAdd[品质档-1] × 星级
// （客户端 getAppointEffect 同款公式，品质档取 HeroCfg.qualityIndex）。
// 实测本账号三个橙色 9 星 = 258×3 = 774 秒，所以 300 秒的低级配方是 0 秒完成 —— 瞬成。
export const PRODUCE_TIME_EFFECT = '生产时间';

// 仓库材料清单：建造 / 升级 / 交订单 / 排产真正会消耗掉的那些东西，总览页单独列一栏。
// 分类不硬编码，全部从配置读：
//   原料、农产品、加工品 —— ItemCfg.type 就是这个分类（7 / 13 / 158 种）；
//   工事材料           —— ItemCfg 里它们也是「加工品」，认不出来，改从 SelectPackLibCfg 的
//                        「工事材料自选包」反查（这张表本来就是「用包能换到什么材料」）。
// 缺表时对应分组为空，前端就不渲染它。
//
// `onlyOwned` = 这一组种类太多（工厂产品 158 种），全部列出来会把页面铺满，
// 由调用方只保留仓库里数量 > 0 的。
export function materialGroups(config) {
  const ofType = (type) => rowsOf(config, 'ItemCfg')
    .filter((row) => row?.type === type)
    .map((row) => row.id);
  const works = rowsOf(config, 'SelectPackLibCfg')
    .filter((row) => row?.itemId === WORK_MATERIAL_PACK)
    .map((row) => row.selectItemId);
  const groups = [
    { key: 'raw', name: '原料', items: ofType('原料') },
    { key: 'works', name: '工事材料', items: works },
    { key: 'farm', name: '农产品', items: ofType('农产品') },
    // 工厂/生产线造出来的东西（生鱼片、罐头、铜锭、瓷砖…）。
    // 扣除工事材料那 6 种，否则会在两组里重复出现。
    {
      key: 'made',
      name: '工厂产品',
      items: ofType('加工品').filter((id) => !works.includes(id)),
      onlyOwned: true,
    },
  ];
  return groups
    .map((group) => ({ ...group, items: [...new Set(group.items.filter(Boolean))] }))
    .filter((group) => group.items.length > 0);
}

// 客户端 Resource 枚举：1=EXP 3=GOLD 4=RUBY 5=ARENA_POINT 6=LEAGUE_POINT。
// AllResourceResponse.list[].res 是数字，配置表的消耗项写的是名字，两边靠这张表对齐。
export const RESOURCE_NAMES = { 1: 'EXP', 3: 'GOLD', 4: 'RUBY', 5: 'ARENA_POINT', 6: 'LEAGUE_POINT' };

export function rowsOf(config, name) {
  return config?.tables?.[name]?.data ?? [];
}

// 材料 → 「用哪个自选包换 + 一包换几个」。挂机计划器、工厂页、手动排产共用一个口径，
// 免得出现「挂机会兑、页面却说没有包」的两套说法。
// 只收白名单里的包：SelectPackLibCfg 里另外 18 种（装备材料包、宠物基因包、英雄碎片…）
// 更稀有，绝不能因为「缺某个材料」被顺手烧掉。
export function packIndex(config, { allowPacks = null } = {}) {
  const allowed = new Set(allowPacks ?? AUTO_PACK_ALLOWLIST);
  const map = new Map();
  for (const row of rowsOf(config, 'SelectPackLibCfg')) {
    if (!row?.itemId || !row?.selectItemId) continue;
    if (!allowed.has(row.itemId)) continue;
    if (map.has(row.selectItemId)) continue; // 同一材料有多个包时取表里第一条
    map.set(row.selectItemId, { pack: row.itemId, per: Number(row.num) || 1 });
  }
  return map;
}

// 这些常量散在几张 param 表里（人口/存量在 GameParamCfg，制造位在 BuildingProduceParamCfg），
// 名字不重复，所以统一按名字查。
export function paramOf(config, name) {
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

// 一块建筑的农田状态：是地块 → {productId, plantAt, ripeAt}（空地三者全 0）；不是 → null。
//
// ⚠️ 别用「回包里有没有 farm 字段」判断这是不是农田（2026-10-27 实测）：
//   服务端**只在有作物时**才编码 farm，空地整条回包里压根没有这个字段 ——
//   空地长这样：`{"buildingId":"3农田","level":1,"product":{"asset":[]},"skinId":0,...}`。
//   按字段判断的后果是空地全部变成 farm: null，planWorld 里 farms.length === 0，
//   整段农田逻辑被静默跳过（连「没种子可种」的 note 都打不出来），地一直空着、
//   播种永远不发生。所以这里只认 buildingType（'1农田'.endsWith('农田')）。
//
// 另外要求已建成：建造中的农田是 level=0 + buildFinishTime，
// 那种地块不能当空地拿去播种（服务端会拒，白刷一条失败）。
export function farmOf(raw, type, level) {
  if (type !== FARM_TYPE || !(Number(level) > 0)) return null;
  return {
    productId: raw?.farm?.productId || '',
    plantAt: Number(raw?.farm?.plantTime ?? 0) || 0,
    ripeAt: Number(raw?.farm?.ripeTime ?? 0) || 0,
  };
}

// --- 生产时间减免 ----------------------------------------------------------------
//
// 一条委任英雄对某个效果的贡献：客户端 AppointUtil.getAppointEffect 就是这两个数组相加，
// 档位是英雄品质（HeroCfg.qualityIndex，1=蓝 2=紫 3=橙 4=红）。
// 「生产时间」「贸易时间」「种田时间」「锻造时间」是秒数（viewType=数值），
// 「建造速度」「训练产量」「宠物培育速度」是比率（viewType=百分比），别混用。
export function appointEffectValue(effect, heroCfg, star) {
  if (!effect || !heroCfg) return 0;
  const slot = Number(heroCfg.qualityIndex) - 1;
  if (!(slot >= 0)) return 0;
  const base = Number(effect.heroAdd?.[slot] ?? 0);
  const perStar = Number(effect.starAdd?.[slot] ?? 0);
  const value = base + perStar * (Number(star) || 0);
  return Number.isFinite(value) ? value : 0;
}

// 委任带来的「生产时间减少」总和（秒）。只看 posId 归属「生产时间」的那几个位置。
// 缺任何一张表都返回 0 —— 算不出来时排产退回「一轮排 1 个」的老行为，不会乱排。
export function appointProduceReduce(config, { appointed = [], heroes = [] } = {}) {
  const effect = rowsOf(config, 'AppointEffectCfg').find((row) => row?.effectId === PRODUCE_TIME_EFFECT);
  if (!effect) return 0;
  const posEffect = new Map(rowsOf(config, 'AppointPosCfg').map((row) => [Number(row?.posId), row?.effectId]));
  const heroCfg = new Map(rowsOf(config, 'HeroCfg').map((row) => [row?.id, row]));
  const starOf = new Map(heroes.map((hero) => [hero?.heroId, hero?.star]));
  let total = 0;
  for (const slot of appointed) {
    if (posEffect.get(Number(slot?.posId)) !== PRODUCE_TIME_EFFECT) continue;
    const cfg = heroCfg.get(slot?.heroId);
    if (!cfg) continue;
    total += appointEffectValue(effect, cfg, starOf.get(slot.heroId));
  }
  return total;
}

// 生产时间的实际秒数（客户端 produceFinalTime 同款）。减免够大就是 0 = 瞬成。
export function produceFinalTime(produceTime, reduce = 0, speedUp = 0) {
  const left = Math.max(0, Number(produceTime || 0) - (Number(reduce) || 0));
  const rate = Number(speedUp) > 0 ? Number(speedUp) : 0;
  return Math.ceil(left / (1 + rate));
}

// 观测兜底：瞬成的项排下去就完成，正常情况下根本看不到它在队列里；
// 偶尔能抓到队首「还剩 0~2 秒」的那种，就是服务端 tick 还没把它收走的瞬成项。
// 它只能给**单条配方**打「瞬成」标记，绝不能拿「原时长 - 剩余」反推减免秒数 ——
// 那个差值里混着已经过去的时间（实测 13500 秒的配方做到一半，反推出来是 12500，
// 直接把 780 秒的配方也判成瞬成）。所以这里只出标记，不出数字。
export const INSTANT_HINT_SECONDS = 2;

export function observedInstantRecipes(now, factories, produceRows = []) {
  const raw = new Map(produceRows.map((row) => [`${row?.buildType}\u0000${row?.itemId}`, Number(row?.produceTime) || 0]));
  const hints = new Set();
  for (const building of factories ?? []) {
    // 两种形状都吃：world.mjs 的 factories 挂原始 factory.factoryQ（finishTime），
    // factories.mjs 的工厂页视图已经拍平成 queue（finishAt）。
    const queue = building?.factory?.factoryQ ?? building?.queue ?? [];
    for (const job of queue) {
      const finishAt = Number(job?.finishTime ?? job?.finishAt ?? 0);
      if (!(finishAt > 0)) continue; // 排队中的项 finishTime 为 0，没得看
      const seconds = raw.get(`${building.type}\u0000${job.productId}`) ?? 0;
      // 本身就短于 2 秒的配方天然瞬成，不算「观测到的减免」。
      if (seconds <= INSTANT_HINT_SECONDS) continue;
      // 只认「刚好快到了」的那一小段：已经过期很久的项是完成了没被收走，
      // 拿它当瞬成证据会冤枉长配方（实测归档数据里 2700 秒的吊床就这么被误判成瞬成）。
      const left = finishAt - now;
      if (!(left >= 0 && left <= INSTANT_HINT_SECONDS)) continue;
      hints.add(`${building.type}\u0000${job.productId}`);
    }
  }
  return hints;
}

// 这个 survey 实际该用多少秒减免：只有配置算出来的那一份。
// planWorld 的 produceReduceSec 参数可以强行覆盖（比如没连上游戏、想先看计划）。
export function produceReduceOf(survey) {
  const reduce = Number(survey?.produce?.reduce ?? survey?.produceReduce ?? 0);
  return Number.isFinite(reduce) && reduce > 0 ? reduce : 0;
}

// 某个配方是不是瞬成：减免压到 0，或者观测到它本来就秒出。
export function isInstantRecipe({ finalSeconds, hint }) {
  return (Number(finalSeconds) || 0) <= 0 || hint === true;
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
  // AppointInfo + AllHero 只为算「生产时间减少」：委任列表给 posId/heroId，英雄表给星级。
  // 两条都是只读轻请求，缺任意一条就按 0 处理，排产退回「一轮排 1 个」。
  const [itemList, resourceList, resFields, fleets, appointInfo, allHero] = await Promise.all([
    get('AllItemRequest'),
    get('AllResourceRequest'),
    get('MyResFieldsRequest'),
    get('MyFleetsRequest'),
    get('AppointInfoRequest'),
    get('AllHeroRequest'),
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
      factory: raw.factory
        ? {
            ...raw.factory,
            // 队列项的 finishTime 语义（2026-10-26 实测，别想当然）：
            //   队列是**串行**的，只有**队首**有真实 finishTime（跑着的>now / 已完成的<=now），
            //   第 2 项及以后服务端根本不编码这个字段（protobuf 默认 0，省略不写）。
            //   normalize 成普通对象时原型上的默认 0 丢了 → undefined，
            //   于是「排队中」和「已完成」分不开。统一补成 0：0 = 还没轮到它。
            factoryQ: (raw.factory.factoryQ ?? []).map((job) => ({
              ...job,
              idx: Number(job.idx ?? 0) || 0,
              productId: job.productId ?? '',
              finishTime: Number(job.finishTime) || 0,
            })),
          }
        : null,
      // 农田挂在 building.farm 上：{productId, plantTime, ripeTime}。
      // 空地和「已种下」靠 productId 有无区分，成熟靠 ripeTime <= now。
      // 注意 product.asset 对农田恒为空 —— 作物收获后直接进仓库，不走建筑产物。
      // 「这块地是不是农田」的判断全在 farmOf() 里（别用「有没有 farm 字段」，见那里的注释）。
      farm: farmOf(raw, type, level),
      product: (raw.product?.asset ?? []).map((a) => ({ id: a.id, num: Number(a.num ?? 0) })),
      // 装备厂（锻造）挂在 building.equipMaking 上：{ makeId, equipId, star, finishTime }。
      // 它**没有 factory 字段**，所以不走 BuildingProduce 那套排产 —— planWorld 完全不碰它，
      // 锻造由 equip.mjs 单独算（同一时间只能造一件，造好不收就等于停产）。
      equipMaking: raw.equipMaking && Number(raw.equipMaking.makeId) > 0
        ? {
            makeId: Number(raw.equipMaking.makeId) || 0,
            equipId: raw.equipMaking.equipId || '',
            star: Number(raw.equipMaking.star) || 0,
            finishTime: Number(raw.equipMaking.finishTime) || 0,
          }
        : null,
      buildStartTime: raw.buildStartTime ?? 0,
      buildFinishTime: raw.buildFinishTime ?? 0,
      auto: raw.auto === true,
      // 海兽培育室挂在 building.petBreed 上：{breedQ, maturePets, maxQLength}。
      // 跟装备厂一样**没有 factory 字段**，所以不走排产，培育由 pet.mjs 单独算。
      // 每个建筑都带这个字段（空的时候 maxQLength=0），只在有内容时才留，省得铺满 null。
      petBreed: raw.petBreed ? {
        breedQ: (raw.petBreed.breedQ ?? []).map((job) => ({
          idx: Number(job.idx ?? 0) || 0,
          petId: job.petId ?? '',
          star: Number(job.star ?? 0) || 0,
          finishTime: Number(job.finishTime ?? 0) || 0,
          feedRequirements: (job.feedRequirements ?? []).map((need) => ({ id: need.id, num: assetCount(need.num) })),
        })),
        maturePets: (raw.petBreed.maturePets ?? []).map((pet) => ({
          petId: pet.petId ?? '',
          star: Number(pet.star ?? 0) || 0,
        })),
        maxQLength: Number(raw.petBreed.maxQLength ?? 0) || 0,
      } : null,
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
  const now = Math.floor(Date.now() / 1000);

  // 生产时间减免：委任列表 + 英雄星级按 AppointEffectCfg 算，算不出就是 0。
  // instant 是观测到的瞬成配方（只在委任算不出来时才用），两个都拿不到就按原时长。
  const reduce = config
    ? appointProduceReduce(config, { appointed: appointInfo?.heroes ?? [], heroes: allHero?.heroes ?? [] })
    : 0;
  const instant = reduce > 0 ? [] : [...observedInstantRecipes(now, factories, rowsOf(config, 'BuildingProduceCfg'))];

  return {
    now,
    player,
    stock,
    have,
    buildings,
    factories,
    orders,
    // 生产侧的两个加速口径，planWorld 与工厂页共用：
    // reduce = 英雄委任的「生产时间减少」秒数（实测 774），instant = 观测到的瞬成配方 key。
    produce: {
      reduce,
      instant,
      source: reduce > 0 ? 'appoint' : instant.length > 0 ? 'observed' : 'none',
    },
    orderOfTheDay: water.orderOfTheDay ?? { orderNum: 0, rewardedNum: 0 },
    autoProduceEndTime: water.autoProduceEndTime ?? 0,
    autoProduceForever: water.autoProduceForever === true,
    // 游戏内「自动种植」开关：开着时服务端自己播种，计划器就只收不种。
    autoFarming: water.autoFarming === true,
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
  maxPackPerRound = 500,
  // 无需求时要不要用自选包把料补上 —— **默认不设门槛（Infinity）**。
  // 产品策略（2026-10-27 定）：工厂要**无时无刻都在制造**，而不是「缺东西了才制造」。
  //   ① 有需求（居民订单 / 货船 / 下游缺口）的配方绝对优先（scoreFor 里 ×1e6 的权重）；
  //   ② 都没需求时，按 pool 顺序一条条往下排，直到该工厂每个产品的存量都顶到上限 50。
  // 想让 ② 落地，「料不够就不兑」这条必须放开：玻璃这类原料没有任何工厂能产，只能靠包换，
  // 卡住兑料 = 卡住整条链（1海水厂 lv4 就是这样空了一整天，仓库里躺着 26 万个原料自选包）。
  //
  // 所以门槛默认取消，真正的刹车改由这三条守：
  //   ① 每轮全局 packQuota（maxPackPerRound，默认 500）—— 一轮最多烧 500 个包，永远封顶；
  //   ② 无需求破例时只排 1 个（packSmallGap → wanted = 1），不拿包把 6 个制造位灌满；
  //   ③ 产物到存量上限 50 就进不了 pool —— 每个产品最多堆 50 个，烧包有天花板，
  //      下游一吃就又空出位置，形成自循环，不需要外部需求驱动。
  // 想收紧：传数字（500 = 一轮额度内兑得齐才兑，20 = 只补零头），0 = 退回「无需求绝不烧包」。
  packGapMax = Infinity,
  pickUpFloaters = false,
  maxPickups = 50,
  minOrderExp = 0,
  maxUpgrades = 2,
  maxBuilds = 5,
  // 生产时间减免（秒）。默认用 survey.produce 算出来的值，这里只是强行覆盖的出口
  // （没连上游戏、或者想按「如果我换一套委任会怎样」试算时用）。
  produceReduceSec = null,
  // 瞬成配方的排满策略：减免把生产时间压到 0 的配方，一次把空制造位排满；
  // 关掉就退回「一轮每座工厂只排 1 个」。
  fillInstantQueue = true,
  // 农田开关：收成熟作物 + 补种空地。跟拾荒一样由调用方按自己的间隔门控
  // （循环默认 2 分钟看一次），关掉就完全不碰农田。
  farm = true,
  // 被服务端拒过的作物 → 解禁时间戳(ms)。由 loop 学习后回传：同一种作物撞了
  // `item limit reached` 就别每轮再来一次，换别的种子顶上。
  farmBlocked = null,
  // 单种库存上限（0 = 不判断）。默认 FARM_CROP_CAP，见那里的实测说明。
  farmCropCap = FARM_CROP_CAP,
  // 外部需求（Map<itemId, 数量>）：居民订单之外还有谁在等这批货 —— 目前是贸易港口的货船缺口。
  // 并进排产需求的同一张表（见下面的 demand），所以工厂会优先产它，而不是拿空位去产别的。
  // 纯函数：不传/传空 Map 就等于旧行为（只认订单缺口）。
  cargoDemand = null,
} = {}) {
  const { now, have } = survey;
  const produceReduce = produceReduceSec === null || produceReduceSec === undefined
    ? produceReduceOf(survey)
    : Math.max(0, Number(produceReduceSec) || 0);
  const actions = [];
  const notes = [];
  const reserved = new Map();
  const reserve = (id, num) => reserved.set(id, (reserved.get(id) ?? 0) + Number(num ?? 0));

  // 自选包兜底：材料不齐时，用「原料自选包 / 工事材料自选包」兑出来。
  // 兑换关系在 SelectPackLibCfg：itemId = 包，selectItemId = 能换出的材料，num = 每包产出。
  // 协议是 SelectPackRequest { itemId, selectItemId, num }。
  // 只有表里列出的材料才兑得到 —— 缺「布匹」这种不在任何原料包里的东西时，这里查不到就直接跳过。
  // 每轮消耗上限由 maxPackPerRound 卡住（默认 500：本账号原料自选包 25 万+，
  // 只给 20 个的话「鱼×120」这种配方要攒 6 轮才兑得齐，工厂干等着）。
  // 注意额度**只是上限**：真正能兑多少还由各包的实际库存卡住（见下面的 left），
  // 额度 500 但仓库只有 3 个包时，这一轮就只兑 3 个，绝不会兑出仓库里没有的东西。
  const packs = packIndex(config, { allowPacks });
  const packForItem = new Map([...packs].map(([itemId, entry]) => [itemId, entry.pack]));
  const packRate = new Map([...packs].map(([itemId, entry]) => [itemId, entry.per]));
  const covered = new Map();  // 靠包补到的量，乐观计入库存（兑换动作排在使用它的动作之前）
  const packLeft = new Map(); // 各包本轮还能用几个
  // 白名单里所有包的实际持有总量：额度不可能花得比这更多，先取 min 免得日志里
  // 写着「每轮上限 500 个包」而仓库里只有 3 个。
  const packStockTotal = [...new Set([...packs.values()].map((entry) => entry.pack))]
    .reduce((sum, pack) => sum + Number(have(pack) ?? 0), 0);
  let packQuota = Math.max(0, Number(maxPackPerRound) || 0);
  if (packStockTotal > 0) packQuota = Math.min(packQuota, packStockTotal);
  const packBudgetPerRound = packQuota;

  // 可用量 = 库存 + 靠包补到的 - 已预留
  const free = (id) => have(id) + (covered.get(id) ?? 0) - (reserved.get(id) ?? 0);

  // 兑换**试算**：只算「缺什么、用哪个包、兑多少」，一律不改账本。
  // 排产要用它先试算 —— 试算失败的配方不该留下任何兑换动作，
  // 否则会出现「为了排 A 兑了料、A 最终没排、料白兑」的情况。
  const planPacks = (needs, label) => {
    const gaps = needs
      .map((n) => ({ id: n.id, num: Number(n.num ?? 0) }))
      .filter((n) => n.num > 0 && free(n.id) < n.num)
      .map((n) => ({ id: n.id, gap: n.num - free(n.id) }));
    const plan = { ok: true, blocked: false, entries: [], notes: [], gaps };
    if (gaps.length === 0) return plan;
    // 关掉开关 / 额度用完：保持沉默（调用方自己会写「材料不足」），别每轮刷一句废话。
    if (!useSelectPack || packQuota <= 0) return { ...plan, ok: false };

    // 额度与包余额用**副本**推进：一个计划里可能两个缺口抢同一个包。
    let quota = packQuota;
    const left = new Map();
    for (const g of gaps) {
      const pack = packForItem.get(g.id);
      if (!pack) {
        plan.notes.push(`${label} 缺 ${g.id}，但没有能换它的自选包`);
        plan.ok = false;
        plan.blocked = true;
        continue;
      }
      // 余额从「本轮还剩多少」起算：同一轮里可能已经为别的配方兑过这个包
      // （典型：瞬成配方排满，每一份都单独补一次料），直接读 have(pack) 会把已花掉的
      // 份额重新算一遍 → 兑超额、被服务端拒。packLeft 由 applyPacks 维护。
      if (!left.has(pack)) {
        left.set(pack, packLeft.has(pack) ? packLeft.get(pack) : Number(have(pack)));
      }
      const budget = Math.min(left.get(pack), quota);
      if (budget <= 0) {
        plan.notes.push(`${label} 缺 ${g.id}，但 ${pack} 数量不够（剩 ${left.get(pack)}，额度剩 ${quota}）`);
        plan.ok = false;
        continue;
      }

      const per = packRate.get(g.id) ?? 1;
      const usePacks = Math.min(Math.ceil(g.gap / per), budget);
      const gain = Math.min(usePacks * per, g.gap);
      if (gain <= 0) {
        plan.ok = false;
        continue;
      }

      plan.entries.push({ pack, itemId: g.id, gain, packs: usePacks });
      left.set(pack, left.get(pack) - usePacks);
      quota -= usePacks;
      if (gain < g.gap) plan.ok = false;
    }
    return plan;
  };

  // 把试算结果落成动作 + 记账，返回是否补齐。
  const applyPacks = (plan, label) => {
    for (const entry of plan.entries) {
      actions.push({
        kind: 'selectPack',
        request: 'SelectPackRequest',
        response: null,
        body: { itemId: entry.pack, selectItemId: entry.itemId, num: entry.gain },
        // transient：兑换失败几乎都是瞬时/数据过期（包数记错了、这个材料突然不能换了），
        // 记进 rejected 会让同一个材料整场挂机都不再兑。
        transient: true,
        label: `兑材料 ${entry.itemId} ×${entry.gain}（${label}，消耗${entry.pack} ${entry.packs} 个）`,
      });
      covered.set(entry.itemId, (covered.get(entry.itemId) ?? 0) + entry.gain);
      packLeft.set(entry.pack, (packLeft.get(entry.pack) ?? Number(have(entry.pack))) - entry.packs);
      packQuota -= entry.packs;
    }
    for (const note of plan.notes) notes.push(note);
    return plan.ok;
  };

  // 材料够了返回 true；不够就尽量用包补，补完够也返回 true。
  // 注意：补不上时**已经兑的那部分仍会落账** —— 建造/交单/升级的调用方会自己判够不够，
  // 兑出来的料留着下一轮用，不会白烧（包换出来的材料不会退）。
  const cover = (needs, label) => applyPacks(planPacks(needs, label), label);

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
        // transient：这条的 stepKey 里没有 buildingId/index，退化成常量 'pickUpFloater:'。
        // 不标的话，一次「floater 已过期」的 prompt 会让 picked 集合记住它，整个挂机会话都不再拾荒。
        transient: true,
        label: `拾荒 ${ids.length} 件漂浮物`,
      });
    }
    const total = (survey.floaters ?? []).length;
    if (total > maxPickups) {
      notes.push(`海面还有 ${total - maxPickups} 件漂浮物，本轮拾荒额度用完，下一轮继续`);
    }
  }

  // 潜水（DivingRequest）不在这里规划，也不该被自动化：它的 body 是
  // reward.asset —— 客户端 `finishDive()` 把「这一局水下捡到的东西」(_getResourceMap)
  // 塞进请求体上报，服务端据此入库；空手时客户端**根本不发请求**。
  // 所以纯协议发空体只会拿回空奖励（实测 {"reward":{"asset":[]}}），
  // 想要产出只能伪造战利品清单，跟打捞的 EndSalvageRequest.pickedFloaters 一样属于谎报，
  // 本项目明确不做。详见 docs/gameplay.md「潜水为什么不能自动化」。

  // 1. 收成品：工厂走 GainFactoryProduce，非工厂建筑的囤积产物一次性批量收。
  //    items 是「这一条动作到底收进了什么」，日志按它汇总成「收成品 淡水×2、木板×1」，
  //    而不是只报「收成品×3」—— 后者看不出收了什么，等于没记。
  for (const b of survey.factories) {
    const finished = b.factory.finishedProducts ?? [];
    if (finished.length > 0) {
      const items = finished.map((asset) => [asset.id, assetCount(asset.num)]);
      actions.push({
        kind: 'gainFactory',
        request: 'GainFactoryProduceRequest',
        response: 'GainFactoryProduceResponse',
        body: { buildingId: b.buildingId },
        items,
        label: `收成品 ${b.buildingId}（${itemText(items)}）`,
      });
    }
  }
  const collectible = survey.buildings.filter((b) => !b.factory && b.product.length > 0);
  if (collectible.length > 0) {
    const items = collectible.flatMap((b) => b.product.map((asset) => [asset.id, assetCount(asset.num)]));
    actions.push({
      kind: 'collectProduct',
      request: 'CollectBuildingProductRequest',
      response: 'CollectBuildingProductResponse',
      body: { buildingId: collectible.map((b) => b.buildingId) },
      items,
      label: `收建筑产物 ${collectible.map((b) => b.buildingId).join(',')}（${itemText(items)}）`,
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
  // 额度与库存都要在**这里**再核一次：候选是上面一次性扫出来的，每条看到的 free() 都是同一份快照。
  // 线上 level 1 那 49 条 consume 目前全是空的（建造不耗材料），所以现在恒过；
  // 一旦版本更新给建造加了消耗，同类型多座会在同轮里抢同一批材料 —— 后一条必被服务端拒，
  // 而 build 不是 transient，被拒的 buildingId 会被 rejected 带到整场挂机结束。
  let built = 0;
  for (const u of builds) {
    if (built >= maxBuilds) {
      notes.push(`${u.building.buildingId} 本轮建造额度用完，下一轮再建`);
      continue;
    }
    const short = u.consume.find((c) => free(c.id) < c.num);
    if (short) {
      notes.push(`${u.building.buildingId} 建造材料被本轮其它动作占用（${short.id} ${free(short.id)}/${short.num}），下一轮再建`);
      continue;
    }
    for (const c of u.consume) reserve(c.id, c.num);
    built += 1;
    actions.push({
      kind: 'build',
      request: 'BuildBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      label: `建造 ${u.building.buildingId}（需等级 ${u.row.playerLevel}）`,
    });
  }

  // 4. 交居民订单：材料齐就交；不齐先试着用自选包补，补不上再按开关决定要不要拒绝重刷。
  for (const order of survey.orders) {
    // 判「能不能交」必须拿**全量需求**（requirements）跟可用量比。
    // order.missing 是 `max(0, 需求 - 探测时库存)`，是缺口；而 free() 返回的是绝对可用量。
    // 拿缺口去跟绝对量比等于把库存扣两次：库存 3、需求 5 时 missing=2，free=3 >= 2 会被
    // 误判成「材料齐」，请求发出去必被服务端拒，还会把 reserved 抬到虚高、
    // 把后面的建造/升级判断一起打成负数。missing 只留给排产优先级（demand）和提示文案。
    const needs = (order.requirements ?? []).map((r) => ({ id: r.id, num: Number(r.num ?? 0) }));
    if (!needs.every((n) => free(n.id) >= n.num)) cover(needs, `订单 #${order.index}`);
    const buildable = needs.every((n) => free(n.id) >= n.num);
    if (buildable) {
      for (const n of needs) reserve(n.id, n.num);
      actions.push({
        kind: 'finishOrder',
        request: 'FinishWorkerOrderRequest',
        response: 'FinishWorkerOrderResponse',
        body: { index: order.index },
        label: `交订单 #${order.index}（经验 ${order.rewardExp ?? '?'}）`,
      });
      continue;
    }
    const short = needs.filter((n) => free(n.id) < n.num).map((n) => `${n.id} ${free(n.id)}/${n.num}`).join(' ');
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

  // 5. 排产：**只补「完全空闲」的工厂**。
  //
  //    判据是 factoryQ 为空 —— 队列里还有东西在造就一个都不排（提前排只会把料先烧掉，
  //    也容易把用户在游戏里手动排的队顶掉）。空闲时才从「第一个能造的产品」开始排：
  //    订单缺口优先、其余按生产时间短的先排；已到存量上限 / 料不够 / 等级没到的会被过滤，
  //    所以「排到哪个」天然就是「第一个还没满的产品」。
  //    当这座工厂下所有产品都满了（pool 为空）→ 就让它空着，这是正常状态。
  //
  //    料不够时先试「自选包能不能补齐」，只补**挑中的那一条**配方（见下面的 planPacks），
  //    补得齐才落兑换动作；补不齐就整座空着，并在 notes 里写清缺哪个材料。
  //    每轮能烧几个包仍由 maxPackPerRound 卡（默认 20，与建造/订单/升级共用同一份额度）。
  //
  //    生产时间是**减免后**的（produceFinalTime 先减 reduce 再提速）：减免 840 秒时
  //    300 秒的鱼/淡水/布匹就是 0 秒，这类「瞬成」配方一次占满制造位，不然低级物品
  //    每分钟都得回来补一次。
  const demand = new Map();
  for (const order of survey.orders) {
    for (const m of order.missing) demand.set(m.id, (demand.get(m.id) ?? 0) + m.num);
  }
  // 贸易港口的货船缺口也并进来。**不额外加权**：两边的诉求是一样的（「仓库里这个东西不够，
  // 赶紧产」），缺口大的自然排前面。区别只在后果 —— 订单交不出去会掉档，货船交不满不开船，
  // 但货船常驻、订单会刷新，所以没必要人为压一方。
  for (const [id, num] of cargoDemand ?? []) {
    const gap = Math.max(0, Number(num) || 0);
    if (gap > 0) demand.set(id, (demand.get(id) ?? 0) + gap);
  }
  // 日志里要看得到这条链路：否则「工厂为什么突然产这个」只能靠猜。
  const cargoWants = [...(cargoDemand ?? [])].filter(([, num]) => Number(num) > 0);
  if (cargoWants.length > 0) {
    notes.push(`货船需求已并入排产：${cargoWants.map(([id, num]) => `${id}×${num}`).join(' ')}`);
  }
  const produceRows = rowsOf(config, 'BuildingProduceCfg');
  // 作物 → 被几条成品配方用到（决定它的安全水位，见下面的 waterlineOf）。
  // 只从 FarmlandPlantCfg 取「哪些是作物」，配方表里查不到用途的作物也进表（计 0 次）。
  const cropIds = new Set(rowsOf(config, 'FarmlandPlantCfg').map((row) => row?.id).filter(Boolean));
  const cropUses = new Map([...cropIds].map((crop) => [crop, 0]));
  for (const row of produceRows) {
    for (const [id] of row.costItem ?? []) {
      if (cropUses.has(id)) cropUses.set(id, cropUses.get(id) + 1);
    }
  }
  // 农田的「安全水位」：库存到这个数就认为够用了，农田不再为它种、工厂该去吃它。
  // 用途越广越值得囤（小麦/番茄各 6 条配方 → 200，南瓜/茄子只有 1 条 → 40）。
  // farmCropCap = 0 表示「关掉一切库存保护、能种就种」，水位跟着变 Infinity。
  // 水位永远排在单种上限之下，否则「到水位」和「到上限」同时触发，跳过原因会说不清。
  const waterlineOf = (crop) => {
    const cap = Number(farmCropCap) || 0;
    if (cap <= 0) return Number.POSITIVE_INFINITY;
    const uses = cropUses.get(crop) ?? 0;
    const byUses = uses >= 6 ? FARM_CROP_WATERLINE_MAX
      : uses === 5 ? 180
        : uses === 4 ? 150
          : uses === 3 ? 120
            : uses === 2 ? 80
              : FARM_CROP_COMFORT;
    return Math.min(byUses, Math.max(FARM_CROP_COMFORT, cap - 1));
  };
  // 农田缺的作物 → 给种子厂加需求（2026-10-28）。
  // 为什么需要这段：种子厂按 pool 顺序「慢慢轮」（产完小麦产玉米…），13 种种子要好几轮才轮到；
  // 而农田这边「分散铺开」恰恰需要那些库存为 0 的作物有种子。把农田的缺口当成需求喂进去，
  // 种子厂的 scoreFor 就会被顶到前面（×1e6），先产真正缺的那几种。
  // 三道过滤，缺一不可：
  //   ① 该种子的配方，种子厂等级得够（unlockLevel ≤ 种子厂等级）—— 够不上别加需求，
  //      加了也没人能做，只会让别的工厂误判（其实只影响种子厂，但保持口径干净）；
  //   ② 作物库存 ≥ 它的**安全水位**（waterlineOf，见上面）的不补 —— 土豆 241、小麦 226 这种正在爆仓的别再加；
  //   ③ 种子已有 FARM_SEED_RESERVE(8) 个的不补 —— 够种两轮了（种子厂一炉只出 1 个，得提前囤）。
  // 需求值 = 「种子缺几个」+ 0.9×饥荒度：整数部分决定产几个（种子厂一炉只出 1 个、
  // 非瞬成配方一次只排 1 个，靠它决定排到几时停），小数部分只当排序权重（作物库存 0 的靠前），
  // 副作用是多产 1 个，可以忽略。
  const farmSeedWants = [];
  const seedPlots = (survey.buildings ?? []).filter((b) => b.farm).length;
  const seedFactory = (survey.buildings ?? [])
    .find((b) => b.type === '种子厂' && !(Number(b.buildFinishTime) > 0));
  const seedLevel = Number(seedFactory?.level ?? 0);
  if (seedPlots > 0 && seedLevel > 0) {
    for (const row of rowsOf(config, 'FarmlandPlantCfg')) {
      const crop = row?.id;
      const seedId = Array.isArray(row?.material) && row.material.length >= 2 ? row.material[0] : null;
      if (!crop || !seedId) continue;
      const recipe = produceRows.find((r) => r.buildType === '种子厂' && r.itemId === seedId);
      if (!recipe || Number(recipe.unlockLevel) > seedLevel) continue;
      const cropHeld = free(crop);
      const seedHeld = free(seedId);
      // 判据跟**播种**用同一个口径（waterlineOf），不能再拿 FARM_CROP_COMFORT 顶：
      // 小麦水位 200、舒适线 40，降到 150 时农田已经在种它了，但按 40 判就永远不催种子，
      // 结果是「地要种它、种子却没人产」。farmCropCap=0（关掉库存保护）时退回 40。
      const line = waterlineOf(crop);
      const cropLine = Number.isFinite(line) ? line : FARM_CROP_COMFORT;
      if (cropHeld >= cropLine || seedHeld >= FARM_SEED_RESERVE) continue;
      const urgency = Math.min(0.9, (Math.max(0, cropLine - cropHeld) / Math.max(1, cropLine)) * 0.9);
      demand.set(seedId, (demand.get(seedId) ?? 0) + (FARM_SEED_RESERVE - seedHeld) + urgency);
      farmSeedWants.push(`${crop}（库存 ${cropHeld}、种子 ${seedHeld}）`);
    }
  }
  if (farmSeedWants.length > 0) {
    notes.push(`农田缺 ${farmSeedWants.join('、')}，已给种子厂加需求`);
  }
  // 农田过剩的作物 → 成品需求（2026-10-28）。
  // 为什么需要：工厂没有外部需求时按「产出时间短的先排」，食品厂/食品厂B 那 22 条配方要
  // 180~300 分钟（减免后仍 2~4 小时），永远排在淡水（0 秒）、布匹这些瞬成配方后面。
  // 实测一整天（2026-10-28）：食品厂只排了 16 次、食品厂B 13 次，含农产品的配方只有
  // 「酒精」13 次（= 39 个小麦），而农田一天产 400+ 个 —— 216 小麦 / 241 土豆全烂在仓库，
  // 最后一起堆到单种上限 250，反倒把农田自己堵死。
  // 做法：把「库存超过安全水位」的那部分作物，折成「这条配方还能做几份」注入 demand，
  // 让 scoreFor 里的 ×1e6 权重把它们顶到食品厂队列前面。
  // 三条约束（缺一条都会出事）：
  //   ① 只用**料已经齐**的配方 —— 料不齐又给需求，工厂会拿自选包去兑，
  //      而「无需求不烧包」是硬规则（2026-10-27 一夜烧掉几万个包的教训）；
  //   ② 每种成品最多加 FARM_FEED_MAX(3) 份 —— 见那个常量的注释；
  //   ③ 作物库存不高于水位的不算过剩（那是农田该补的，不是工厂该吃的）。
  const feedWants = [];
  for (const row of produceRows) {
    const crops = (row.costItem ?? []).filter(([id]) => cropIds.has(id));
    if (crops.length === 0) continue;
    // **全部材料都要齐**，不是只齐作物 —— 配方还要鱼/木材时，只齐作物也给他加需求，
    // 工厂就会拿自选包去兑那些缺的料，等于绕过「无需求不烧包」这条硬规则。
    if (!(row.costItem ?? []).every(([id, num]) => free(id) >= Number(num))) continue;
    // 能产几份 = 所有作物「超出水位的余量 ÷ 单耗」里最小的那个
    let fits = Number.POSITIVE_INFINITY;
    for (const [id, num] of crops) {
      const surplus = free(id) - waterlineOf(id);
      fits = Math.min(fits, Math.floor(surplus / Math.max(1, Number(num))));
    }
    if (!Number.isFinite(fits) || fits <= 0) continue;
    const want = Math.min(FARM_FEED_MAX, fits);
    // 只往上加，不覆盖订单/货船给出的更大需求。
    if (want <= (demand.get(row.itemId) ?? 0)) continue;
    demand.set(row.itemId, want);
    feedWants.push(`${row.itemId}×${want}`);
  }
  if (feedWants.length > 0) {
    notes.push(`用过剩作物排产：${feedWants.slice(0, 4).join(' ')}${feedWants.length > 4 ? ' …' : ''}`);
  }
  const instantHints = new Set(survey.produce?.instant ?? []);
  // **全局在产量**：所有工厂的「待收 + 队列」里这件物品一共有几个。
  // 存量上限是全局限，不是单厂限 —— 同一件物品可能好几座工厂都能产（配方表按 buildType 分，
  // 布匹这类材料就不止一座能出）。只算本厂的话，A 厂排了 40 个、B 厂完全看不见，
  // 照样再排一批，第二个必被服务端 `storage full` 拒。
  // finishedProducts[].num 是 protobuf int64（可能是 {low,high} 对象），必须走 assetCount，
  // 裸 Number() 会得到 NaN，然后 heldOf 一路 NaN、`held < stockCap` 恒 false → 配方全被过滤掉。
  const globalPending = new Map();
  for (const other of survey.factories ?? []) {
    for (const asset of other.factory?.finishedProducts ?? []) {
      globalPending.set(asset.id, (globalPending.get(asset.id) ?? 0) + assetCount(asset.num));
    }
    for (const job of other.factory?.factoryQ ?? []) {
      globalPending.set(job.productId, (globalPending.get(job.productId) ?? 0) + 1);
    }
  }
  const pendingOf = (itemId) => globalPending.get(itemId) ?? 0;
  // 持有量 = 仓库 + 全球在产（跟服务端判 storage full 的口径一致）。
  const globalHeldOf = (itemId) => have(itemId) + pendingOf(itemId);
  // 需求的排序权重在每座工厂里现算（要扣掉这座工厂「已经在产」的量，见下面的 scoreFor）——
  // 同一个物品在 A 厂已经排了 2 个、在 B 厂一个没排，两边的优先级不该一样。
  for (const b of survey.factories) {
    if (b.factory.autoProductId) {
      notes.push(`${b.buildingId} 已设自动生产 ${b.factory.autoProductId}，不覆盖`);
      continue;
    }
    const slots = Math.max(0, Number(survey.factorySlots) || 0);
    if (slots === 0) continue;
    const queue = b.factory.factoryQ ?? [];
    // 队列是**串行**的：只有队首真的在产，第 2 项及以后都只是排着队（服务端连 finishTime 都不给）。
    // 所以「队列里有没有活」不能看 queue.length，要看**队首**：
    //   队首在跑 / 未排上时间 —— 这一轮新排的东西只会排到它后面等，排瞬成也一样等
    //                            （实测 2026-10-26：1服装厂 队首是 45 分钟的鱼皮鞋，
    //                             后面堆了 4 个瞬成，全都得等它跑完才逐个落地）
    //   队首已完成 / 空队列    —— 瞬成才是真的「排下去就出货」，一次排满剩余空位
    const head = queue[0] ?? null;
    const headFinish = head ? Number(head.finishTime) || 0 : 0;
    // `> now` = 还在跑，`<= now` = 已完成（服务端会自己搬进待收）。
    // `finishTime = 0` 是「这条队列还没被服务端排上时间」（刚排完还没结算），也按忙处理。
    const headRunning = head ? (headFinish === 0 || headFinish > now) : false;
    const openSlots = Math.max(0, slots - queue.length);
    if (openSlots === 0) continue;
    // 持有量 / 在产量统一走全局口径（见上面 globalHeldOf / pendingOf）：
    // 单厂视角会让两座都能产同一件物品的工厂各排一批，服务端直接回 `storage full`。
    const heldOf = globalHeldOf;
    const queueHeldOf = pendingOf;
    // 排序权重：**有效需求**（缺口 - 这座工厂已经在产的量）优先，其余按产出时间短的先排（早点回本）。
    // 扣掉在产的量很关键：货船要 2 个淡水、1海水厂 队列里已经排了 2 个，这时「淡水」不该
    // 还压着别的配方排第一 —— 那样每轮都会再排一个，直接干到存量上限。
    const scoreFor = (row) => Math.max(0, (demand.get(row.itemId) ?? 0) - queueHeldOf(row.itemId)) * 1e6
      - Number(row.produceTime || 0);
    // pool = 等级够 + 未到存量上限的配方，**不看料**，按优先级排好。
    // 之后再分成两条路：料够的直接排（老行为）；一条都不够时，按优先级逐条试算「自选包能不能补齐」，
    // 只给**真正要排的那一条**兑料 —— 不能给整池子都兑，那会把包烧在没有意义的配方上。
    // 存量上限的口径：默认就是 stockCap，**种子厂要留余量**（2026-10-28）。
    // 种子一炉只出 1 个，堆到 50 就是纯浪费 —— 实测小麦种子 45/50 还被连排 4 个
    // （6 个队列位占了 4 个，一占就是 2 小时），而真正缺的番茄种子（0 个）只排上 1 个。
    // 留 SEED_STOCK_MARGIN 之后，接近上限的种子进不了 pool，队列位自然让给缺的那种。
    const capOf = (itemId) => {
      if (!(survey.stockCap > 0)) return Number.POSITIVE_INFINITY;
      return b.type === '种子厂'
        ? Math.max(1, Number(survey.stockCap) - SEED_STOCK_MARGIN)
        : Number(survey.stockCap);
    };
    const pool = produceRows
      .filter((row) => row.buildType === b.type && row.unlockLevel <= b.level)
      .filter((row) => heldOf(row.itemId) < capOf(row.itemId))
      .sort((a, b2) => scoreFor(b2) - scoreFor(a));
    const costOf = (row) => (row.costItem ?? []).map(([id, n]) => ({ id, num: Number(n) || 0 }));
    const affordable = (row) => costOf(row).every((cost) => free(cost.id) >= cost.num);
    // 这条配方的缺口折算成「要烧几个自选包」。只给「无需求破例」这条路做判据，不进账本。
    // 有材料根本没有包能换（比如布匹）时返回 blocked —— 那条配方连破例资格都没有。
    const gapPacksOf = (row) => {
      let packs = 0;
      for (const cost of costOf(row)) {
        const gap = cost.num - free(cost.id);
        if (gap <= 0) continue;
        const pack = packForItem.get(cost.id);
        if (!pack) return { packs: Infinity, blocked: true, id: cost.id };
        packs += Math.ceil(gap / (packRate.get(cost.id) ?? 1));
      }
      return { packs, blocked: false, id: null };
    };
    // 料不够又没排上时，把「为什么没兑包」说清楚。以前这里无条件写「自选包也补不上」，
    // 结果仓库里躺着 26 万个原料自选包也这么写，看日志的人只能去翻代码
    // （2026-10-27 1海水厂 空转一整天的日志就是这个）。
    const whyNoPack = (row) => {
      if (!useSelectPack) return '，自选包补料已关闭';
      const lacks = [];
      for (const cost of costOf(row)) {
        if (free(cost.id) >= cost.num) continue;
        const pack = packForItem.get(cost.id);
        // 余额从「本轮还剩多少」起算，跟 planPacks 同一个口径。
        const left = pack ? (packLeft.has(pack) ? packLeft.get(pack) : Number(have(pack))) : 0;
        lacks.push({ id: cost.id, pack, left });
      }
      const noPack = lacks.filter((l) => !l.pack).map((l) => l.id);
      if (noPack.length > 0) return `，${noPack.join('、')} 没有自选包可换`;
      const empty = lacks.filter((l) => l.left <= 0).map((l) => l.pack);
      if (empty.length > 0) return `，${empty[0]} 数量不够`;
      const want = Math.max(0, (demand.get(row.itemId) ?? 0) - queueHeldOf(row.itemId));
      if (want <= 0) {
        if (packGapMax <= 0) return '，无需求（小额兜底已关闭）';
        const gap = gapPacksOf(row);
        if (gap.blocked) return `，${gap.id} 没有自选包可换`;
        // 默认 packGapMax = Infinity（不设门槛），此时「缺口大过上限」这条根本不成立，
        // 走不到就是额度被本轮别的配方吃光了（planPacks 的 quota）。
        if (packGapMax !== Infinity && gap.packs > packGapMax) {
          return `，无需求且缺口 ${gap.packs} 个包 > 小额兜底上限 ${packGapMax}`;
        }
        return packBudgetPerRound <= 0 ? '，本轮自选包额度已用完' : '，自选包也补不上';
      }
      if (packBudgetPerRound <= 0) return '，本轮自选包额度已用完';
      return '，自选包也补不上';
    };
    // 瞬成判断用减免后的秒数；0 = 排下去就完成，可以放心排满。
    // 委任数据拉不到时退到观测标记（队列里抓到过「还剩 0~2 秒」的队首）。
    const instantOf = (row) => isInstantRecipe({
      finalSeconds: produceFinalTime(row.produceTime, produceReduce),
      hint: instantHints.has(`${b.type}\u0000${row.itemId}`),
    });
    // 队首还在跑的时候也可以排，但**只排 1 个**（见下面的 wanted）：
    // 空位闲着才是真浪费，而排 1 个只占 1/6 容量，不会像「排满」那样把 5 个位全堆成排队项
    // （实测 2026-10-26：1服装厂 队首 45 分钟的鱼皮鞋后面堆了 4 个瞬成，全得等它跑完）。
    // 有需求的配方靠 scoreFor 里的需求加权自然排在最前面，不用在这儿过滤。
    const candidates = pool;

    let best = candidates.find((row) => affordable(row)) ?? null;
    let packPlanUsed = null;
    let packTarget = null;
    // 这次兑换是走「无需求 + 小额缺口」的破例口子进来的：只允许排 1 个。
    // 瞬成配方一次排满会把刚兑来的料连着烧掉 N 份（N 份 = N 倍包），
    // 破例的本意是「别让工厂空着」，不是「拿包把制造位灌满」。
    let packSmallGap = false;
    if (!best && useSelectPack) {
      // 一条都排不了：按优先级逐条试「自选包能不能补齐」，**先找本轮就能兑齐的那一条**。
      // 以前是在第一条有缺口的配方上就 break：缺口 96 的鱼皮（鱼×120）会挡死缺口 6 的生鱼片（鱼×6），
      // 工厂被排在最前面的大配方钉死，永远等料。现在兑不齐的先记着，继续往后找能兑齐的。
      //
      // **没有需求的配方不烧包**（2026-10-27 加）：工厂空着不损失任何东西，包是真金白银攒出来的。
      // 实测一整夜（每轮都在排、每轮都兑）—— 1金属厂 为产「没人要的铜锭」兑 玻璃×60、
      // 1切鱼厂 兑 鱼×20+碎布×4、1服装厂 兑 塑料×30…一轮上百个包，25 万个也撑不了几十小时。
      // 有需求（居民订单 / 贸易港口货船）时缺口是确定会兑现的，那时候才值得拿包换。
      //
      // **产品策略改成「无时无刻都在制造」后（2026-10-27 第二次改）**：上面这条只在
      // `packGapMax` 收紧时才生效，默认 Infinity = 不拦。此时无需求配方和缺料配方一视同仁，
      // 靠「每轮 500 额度 + 只排 1 个 + 产物到上限 50」三道刹车兜住。
      let partial = null;
      for (const row of candidates) {
        const wantOfRow = Math.max(0, (demand.get(row.itemId) ?? 0) - queueHeldOf(row.itemId));
        // 缺口折算成包数：既做「无需求破例」的判据，也做 partial 的排序依据。
        const gapCost = packGapMax > 0 ? gapPacksOf(row) : null;
        let smallGap = false;
        if (wantOfRow <= 0) {
          if (!gapCost || gapCost.blocked || gapCost.packs > packGapMax) continue;
          smallGap = true;
        }
        const plan = planPacks(costOf(row), `排产 ${b.buildingId} ${row.itemId}`);
        // blocked = 有缺口根本没有包能换（比如布匹），给它兑别的料是白烧，直接跳过这条配方。
        if (plan.blocked || plan.entries.length === 0) continue;
        if (plan.ok) {
          packTarget = row;
          packPlanUsed = plan;
          packSmallGap = smallGap;
          break;
        }
        // 一条都兑不齐时**挑缺口最小的那条攒**，而不是排序第一的那条：
        // 否则缺口 1200 的巨无霸每轮吃掉全部 500 额度，后面缺口 60 的配方永远轮不上，
        // 「一个个排到都满」就变成了「只喂一条大配方」。缺口越小越先攒够开排。
        const cost = gapCost && !gapCost.blocked ? gapCost.packs : Infinity;
        if (!partial || cost < partial.cost) partial = { row, plan, smallGap, cost };
      }
      // 一条都兑不齐 → 退回第一条能部分兑的，把料攒起来（兑出来的料不会退，下轮接着补）。
      if (!packPlanUsed && partial) {
        packTarget = partial.row;
        packPlanUsed = partial.plan;
        packSmallGap = partial.smallGap;
      }
    }
    if (packPlanUsed) {
      applyPacks(packPlanUsed, `排产 ${b.buildingId} ${packTarget.itemId}`);
      const gained = packPlanUsed.entries.map((entry) => `${entry.itemId}×${entry.gain}`).join('、');
      if (packPlanUsed.ok) {
        best = packTarget;
        notes.push(`${b.buildingId} ${best.itemId} 缺料，用自选包补齐后开排（${gained}）`
          + `${packSmallGap ? `（无需求，但缺口 ≤ ${packGapMax} 个包，按小额兜底只排 1 个）` : ''}`);
      } else {
        notes.push(`${b.buildingId} ${packTarget.itemId} 缺料，本轮先用自选包补 ${gained}`
          + `，还不够，下一轮继续（每轮上限 ${packBudgetPerRound} 个包）`);
      }
    }
    if (!best) {
      // 空闲是正常状态，但原因要分开写：全到上限 / 料不够补不上 —— 否则用户看不出该做什么。
      if (candidates.length === 0) {
        notes.push(`${b.buildingId} 空闲：没有能排的配方（产品到存量上限 ${survey.stockCap} / 等级不够）`);
      } else {
        const shortRow = candidates.find((row) => costOf(row).some((cost) => free(cost.id) < cost.num))
          ?? candidates[0];
        const short = costOf(shortRow).filter((cost) => free(cost.id) < cost.num)
          .map((cost) => `${cost.id} ${free(cost.id)}/${cost.num}`).join(' ') || '未知';
        notes.push(`${b.buildingId} 空闲：料不够（${short}）${whyNoPack(shortRow)}`);
      }
      continue;
    }
    // 兑换动作已在上面的 applyPacks 里推进 actions，位置就在排产动作之前（数组顺序即执行顺序）。
    const need = demand.get(best.itemId) ?? 0;
    const finalSeconds = produceFinalTime(best.produceTime, produceReduce);
    const instant = instantOf(best);
    // 一次排几个：瞬成 + **队列空** → 把剩余空位排满（每一份都真的立刻完成）；
    // 队首还在跑 → 只排 1 个（排多了只是往队尾堆一堆排队项，全在等队首，还把位置占满）。
    // 一次排几个：
    //   - 队首还在跑 → **1 个**（多排只是往队尾堆排队项，全在等队首）
    //   - 队列空/队首已完成 → 瞬成配方把剩余空位排满；非瞬成仍只 1 个
    //   - 有**明确需求**（订单 / 货船）时按缺口排，别一次干到 6 个造成过量：
    //     货船要 2 个淡水、排 6 个，多出来的 4 个既占库存也占材料
    const needNow = Math.max(0, (demand.get(best.itemId) ?? 0) - queueHeldOf(best.itemId));
    // 走「无需求小额兜底」排上的这条，强制只排 1 个：料是拿包换的，排满等于把包按 N 倍烧。
    const wanted = packSmallGap
      ? 1
      : (fillInstantQueue && instant && !headRunning
        ? (needNow > 0 ? Math.min(openSlots, needNow) : openSlots)
        : 1);
    // 这条配方的持有量（仓库 + 待收 + 队列）。pool 已经按同一个 heldOf 过滤过上限，
    // 这里只是把它取出来给循环里的「瞬成排满」再逐份卡上限用。
    const held = heldOf(best.itemId);
    // label 里带上配方消耗：排产最常出问题的地方就是「挑了哪条配方、这条配方吃什么」。
    const costText = (best.costItem ?? []).map(([id, n]) => `${id}×${n}`).join(' ');
    const timeText = instant
      ? `瞬成${produceReduce > 0 ? `，原 ${best.produceTime}s - 减免 ${produceReduce}s` : '（队列观测）'}`
      : `${finalSeconds}s${finalSeconds !== best.produceTime ? `（原 ${best.produceTime}s）` : ''}`;
    let planned = 0;
    for (let k = 0; k < wanted; k += 1) {
      // 每排一个都要再扣一次料：瞬成排满 = 同一配方连着烧 N 份材料。
      // 料不够时**先试着用自选包补这一份**（额度还有、并且这个配方**有需求**才补）——
      // 以前这里是直接 break，结果挑中的配方只排得动前几个就停（生鱼片 6 个只排 4 个）。
      // 「有需求」这条与下面的兜底路径保持一致：没需求的配方不烧包，否则一整夜每轮都往
      // 没人要的产品上砸几百个包。
      let shortCosts = (best.costItem ?? []).filter(([id, n]) => free(id) < n);
      if (shortCosts.length > 0 && useSelectPack && needNow > 0) {
        const plan = planPacks(costOf(best), `排产 ${b.buildingId} ${best.itemId}`);
        if (plan.entries.length > 0) {
          applyPacks(plan, `排产 ${b.buildingId} ${best.itemId}`);
          notes.push(`${b.buildingId} ${best.itemId} 第 ${k + 1} 个缺料，用自选包补 `
            + `${plan.entries.map((entry) => `${entry.itemId}×${entry.gain}`).join('、')}`
            + (plan.ok ? '' : '（本轮额度还没兑够，下轮继续）'));
        }
        shortCosts = (best.costItem ?? []).filter(([id, n]) => free(id) < n);
      }
      if (shortCosts.length > 0) {
        const short = shortCosts.map(([id, n]) => `${id} ${free(id)}/${n}`).join(' ');
        notes.push(`${b.buildingId} ${best.itemId} 排到第 ${k + 1} 个材料不够（${short}），本座工厂本轮排 ${k} 个`);
        break;
      }
      // 存量上限：瞬成排满会把成品堆在工厂里，超上限服务端会回 storage full。
      if (survey.stockCap > 0 && held + k >= survey.stockCap) {
        notes.push(`${b.buildingId} ${best.itemId} 已持有 ${held + k} 个（含待收与队列），到存量上限 ${survey.stockCap}，不再排`);
        break;
      }
      for (const [id, n] of best.costItem ?? []) reserve(id, n);
      planned += 1;
      // 本轮排出去的也要记进全局在产量：同一件物品可能后面还有另一座工厂也要产，
      // 不记账的话两座会各排一批，合计超存量上限，第二个必被 `storage full` 拒。
      globalPending.set(best.itemId, pendingOf(best.itemId) + 1);
      actions.push({
        kind: 'startProduce',
        request: 'StartFactoryProduceRequest',
        response: null,
        body: { buildingId: b.buildingId, productId: best.itemId },
        // 一条动作 = 一个成品。日志按 items 累加，瞬成排 3 个就显示「排产 木板×3」。
        items: [[best.itemId, 1]],
        // 瞬成排满是同一座工厂连发 N 条：key 必须带上序号，否则 stepKey 会把它们算成同一个动作。
        // transient：排产失败几乎都是瞬时原因（队列满/库存满/料不够），不该被 rejected 永久记住。
        key: `startProduce:${b.buildingId}#${k}`,
        group: `startProduce:${b.buildingId}`,
        transient: true,
        label: `排产 ${b.buildingId} -> ${best.itemId}（${timeText}`
          + `${wanted > 1 ? `，第 ${k + 1}/${wanted} 个` : ''}`
          + `${costText ? `，耗 ${costText}` : ''}${need ? `，需求 ${need}` : ''}）`,
      });
    }
    if (planned > 1) notes.push(`${b.buildingId} 瞬成配方 ${best.itemId} 一次排了 ${planned} 个（队列空，每一份都能立刻完成）`);
  }

  // 5.5 农田：熟的一次批量收，空出来的地一次批量播。
  //   FarmHarvestRequest.buildingId 与 FarmPlantRequest.args 都是 repeated，
  //   所以一轮各发一条就能覆盖所有农田（客户端框选批量操作发的也是这两个）。
  //   作物表 FarmlandPlantCfg：{id, time, produceNum, material: [种子, 份数]}。
  //   游戏内「自动种植」（SetAutoFarmingRequest / water.autoFarming）开着时服务端自己播，这边只收不种。
  const farms = survey.buildings.filter((b) => b.farm);
  if (farm && farms.length > 0) {
    const ripe = farms.filter((b) => b.farm.productId && b.farm.ripeAt > 0 && b.farm.ripeAt <= now);
    if (ripe.length > 0) {
      actions.push({
        kind: 'farmHarvest',
        request: 'FarmHarvestRequest',
        response: null,
        body: { buildingId: ripe.map((b) => b.buildingId) },
        // transient：body 里没有 buildingId 单值/index，stepKey 退化成常量 'farmHarvest:'。
        // 「这一块刚好被别人收过」是瞬时状态，记住它等于整场挂机不再收农田。
        transient: true,
        // 农田的「数量」是地块数不是作物件数（收获件数要乘 FarmlandPlantCfg.produceNum，
        // 而协议回包是空的、拿不到实际入库量），所以单位标成「块」，别让人以为是 4 个小麦。
        items: ripe.map((b) => [b.farm.productId, 1]),
        unit: '块',
        label: `收农田 ${ripe.map((b) => `${b.buildingId}(${b.farm.productId})`).join(' ')}`,
      });
    }
    // 本轮刚收的地收完就是空的，可以紧接着种（服务端按顺序处理）。
    const empties = farms.filter((b) => !b.farm.productId || ripe.includes(b));
    if (empties.length > 0 && survey.autoFarming === true) {
      notes.push(`农田 ${empties.length} 块空着，游戏内「自动种植」开着，交给服务端`);
    } else if (empties.length > 0) {
      const cap = Math.max(0, Number(farmCropCap) || 0);
      const blockedUntil = (crop) => Number(farmBlocked?.get?.(crop) ?? 0) || 0;
      const skippedSeeds = [];
      const options = rowsOf(config, 'FarmlandPlantCfg')
        .map((row) => ({
          id: row?.id,
          time: Number(row?.time) || 0,
          // 一季收获几个（配置全是 5，但要按表读：分散铺开时靠它预估「种下去会长出多少」）。
          produce: Math.max(1, Number(row?.produceNum) || 5),
          // 注意：FarmlandPlantCfg.material 是**一对** `[种子名, 份数]`，不是 [[id,num], …] 的列表
          // （实测 `{"id":"玉米","material":["玉米种子",1]}`）。当成列表取 [0] 会拿到字符串，
          // 解构出来是「玉」「米」两个字，free('玉') 永远是 0 → 一块都种不上。
          seed: Array.isArray(row?.material) && row.material.length >= 2 ? row.material : null,
        }))
        .filter((row) => row.id && row.seed)
        // 播种前先做两道「别再撞墙」的检查（2026-10-27 事故：土豆一路堆到 265，
        // 服务端每轮回 `item limit reached`，4 块地空了一个多小时，日志每轮刷一条失败）：
        //   ① 该作物库存已到单种上限 → 不种（收获不校验上限，能顶到 265）。
        //   ② 刚被服务端拒过（loop 记下来暂缓的）→ 不种，等解禁。
        .filter((row) => {
          const held = free(row.id);
          // 用「种下去之后」的量判：收获不校验上限，所以 held 245 种一季（+5 = 250）
          // 刚好压线，再种就必然顶着上限被拒。宁可这一季不种，也别把自己顶死。
          if (cap > 0 && held + row.produce > cap) {
            skippedSeeds.push(`${row.id} 库存 ${held}，种一季 +${row.produce} 会超过上限 ${cap}`);
            return false;
          }
          const until = blockedUntil(row.id);
          if (until > now * 1000) {
            skippedSeeds.push(`${row.id} 刚被服务端拒过，${Math.ceil((until - now * 1000) / 60000)} 分钟后再试`);
            return false;
          }
          return true;
        });
      if (skippedSeeds.length > 0) notes.push(`农田跳过这些种子：${skippedSeeds.join('、')}`);
      const args = [];
      const left = [...empties];
      // **目标水位 + 分散铺开**（2026-10-28 两轮改动合并）：
      //   分散铺开解决的是「4 块地常年只种土豆/小麦，另外 11 种恒为 0，缺料的产品线永远排不出来」；
      //   目标水位解决的是反过来那一头 —— 只按「库存少的先种」会把 13 种作物一起推向单种上限 250，
      //   然后上限过滤把每一种都剔掉，地块永久空着（死局），而仓库里全是工厂吃不掉的存货。
      // 现在每放一块地重挑一次「离水位最远的那种」：
      //   ① 订单/货船有缺口的最优先（需求扣掉已排的量），并且**可以突破水位**；
      //   ② 其余按「水位 − 当前持有量」降序 —— 越缺越先，放下后立刻 +produceNum，
      //      所以同一种作物不会一口吃光所有地块，有种子且缺的作物自然轮着铺开；
      //   ③ 都到水位的地块宁可空着 —— 工厂把库存吃下去后下一轮自动恢复种。
      const load = new Map(options.map((option) => [option.id, free(option.id)]));
      const hasDemand = (option) => (demand.get(option.id) ?? 0) - (load.get(option.id) ?? 0) > 0;
      const plantable = (option) => hasDemand(option)
        || (load.get(option.id) ?? 0) < waterlineOf(option.id);
      const cropScore = (option) => {
        const held = load.get(option.id) ?? 0;
        // 有缺口：用一个足够大的负基数排到所有「没需求」的前面；同档仍按持有量少的先。
        if (hasDemand(option)) return -1e9 + held;
        // 没需求：越小越先 —— 也就是「离水位越远（越缺）越先种」，和以前的「库存少的先」同向，
        // 但多了一条「到水位就不参与」（见 plantable）。
        return held - waterlineOf(option.id);
      };
      const seedPer = (option) => Math.max(1, Number(option.seed[1]) || 1);
      // 本圈已经拿到地的那种作物：一圈之内一作物只占一块地，
      // 等所有「有种子」的作物都轮过一遍（fresh 为空）才开下一圈。
      const usedThisRing = new Set();
      while (left.length > 0) {
        // 种子够 + 还没到水位，两条都满足才参与挑地。
        const ready = options.filter((option) => free(option.seed[0]) >= seedPer(option) && plantable(option));
        if (ready.length === 0) break;
        let pool = ready.filter((option) => !usedThisRing.has(option.id));
        if (pool.length === 0) {
          usedThisRing.clear();
          pool = ready;
        }
        pool.sort((a, b) => cropScore(a) - cropScore(b) || b.time - a.time);
        const pick = pool[0];
        const plot = left.shift();
        reserve(pick.seed[0], seedPer(pick));
        args.push({ buildingId: plot.buildingId, productId: pick.id });
        usedThisRing.add(pick.id);
        // 种下去就是「预计会多出 produceNum 个」，记进去，下一圈才会先挑别的作物。
        load.set(pick.id, (load.get(pick.id) ?? 0) + pick.produce);
      }
      // **一种作物一条 FarmPlantRequest**：以前全部打包成一条，土豆那条被
      // `item limit reached` 拒掉时，小麦/玉米跟着一条都发不出去（runWorld 按 group
      // 失败隔离，同一组里第一条失败后面全 skip）。分开之后互不拖累。
      const byCrop = new Map();
      for (const arg of args) {
        if (!byCrop.has(arg.productId)) byCrop.set(arg.productId, []);
        byCrop.get(arg.productId).push(arg);
      }
      for (const [crop, group] of byCrop) {
        actions.push({
          kind: 'farmPlant',
          request: 'FarmPlantRequest',
          response: null,
          body: { args: group },
          // transient：同 farmHarvest —— 一次「种子不足/地块状态变了/该作物到上限」的 prompt
          // 会让播种在本进程内永久停掉。下一轮探测会重新判库存和种子，重试是安全的。
          transient: true,
          key: `farmPlant:${crop}`,
          group: `farmPlant:${crop}`,
          // 同上：单位是地块数（args 一个元素 = 一块地）。
          items: group.map((a) => [a.productId, 1]),
          unit: '块',
          label: `播种 ${group.length} 块（${crop}×${group.length}）`,
        });
      }
      if (left.length > 0) {
        // 空着的原因有三种，别再混着写「没种子可种」（2026-10-28 加水位机制后必须分开）：
        //   ① 想种的那几种没有种子 → 指向种子厂，这是唯一值得去催的情况；
        //   ② 有种子但都到水位 → 正常，等工厂把库存吃下去；
        //   ③ 剩下的地配不上（种子只够种一部分）。
        const shortNoSeed = options
          .filter((option) => plantable(option) && free(option.seed[0]) < seedPer(option))
          .map((option) => option.id);
        const anyRoom = options.some((option) => free(option.seed[0]) >= seedPer(option) && plantable(option));
        const why = shortNoSeed.length > 0
          ? `缺 ${shortNoSeed.slice(0, 3).join('、')}${shortNoSeed.length > 3 ? ` 等 ${shortNoSeed.length} 种` : ''} 但没有种子`
          : (anyRoom ? '剩下的地种子不够' : '作物都到安全水位了（等工厂消化）');
        notes.push(`农田还有 ${left.length} 块没种（${left.map((b) => b.buildingId).join(' ')}）：${why}`);
      }
    }
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
  // 同建造：升级候选也是一次性扫出来的，而 level>=2 的行**全都有消耗**，
  // 同类型多座（民居、仓库…）时两条候选看到的 free() 完全相同 —— 必须边发边核销，
  // 否则第二条必被服务端拒，且 upgrade 不是 transient，那座建筑整场挂机都不会再升。
  let upgraded = 0;
  for (const u of upgrades) {
    if (upgraded >= maxUpgrades) {
      notes.push(`${u.building.buildingId} 本轮升级额度用完，下一轮再升`);
      continue;
    }
    const short = u.consume.find((c) => free(c.id) < c.num);
    if (short) {
      notes.push(`${u.building.buildingId} 升级材料被本轮其它动作占用（${short.id} ${free(short.id)}/${short.num}），下一轮再升`);
      continue;
    }
    for (const c of u.consume) reserve(c.id, c.num);
    upgraded += 1;
    actions.push({
      kind: 'upgrade',
      request: 'UpgradeBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      label: `升级 ${u.building.buildingId} ${u.building.level}->${u.building.level + 1}（${u.costTime}s，人口 ${u.row.curPeople}）`,
    });
  }

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
  // 显式指定的 key 优先：有些动作的去重粒度靠 body 里的字段算不出来
  // （典型是「按天一次」，body 里压根没有日期）。当前计划器没用到，但 runWorld 的
  // rejected 集合认这条规则，动作定义里写了 key 就按它算。
  if (step.key) return step.key;
  // selectPack 的 body 里没有 buildingId/index，用 selectItemId（材料名，天然唯一）区分，
  // 否则多个兑换动作会撞成同一个 key，被 rejected 集合误伤。
  const target = step.body?.buildingId ?? step.body?.index ?? step.body?.selectItemId ?? '';
  return `${step.kind}:${Array.isArray(target) ? target.join('+') : target}`;
}

// PromptResponse.prompt 里这几种是「此刻不行」，等一下/重试就能过，不该按「这类动作全废」处理：
// 7 SERVER_IS_BUSY（服务忙）、70 HIGH_OP_FREQUENCY（操作过快）、74 ACTIVE_END（活动状态切换中）。
// 实测教训：装备升 50 级被 prompt=74 拒，同 group 的 18 条（51~65 级 + 别件装备）全被跳过，
// 下一轮重试 51 级却成功了 —— 一条瞬时失败废掉一整组，纯亏。
export const TRANSIENT_PROMPT_IDS = new Set([7, 70, 74]);

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
  // 失败隔离的粒度：默认按 kind（同类动作一起停），带 group 的按 group 停。
  // 排产就是这样用的 —— 瞬成配方一次连发 6 条，第 3 条失败（队列满/库存满）
  // 只该停掉这座工厂剩下的几条，不能把其它工厂的排产一起废掉。
  const isolationKey = (step) => step.group ?? step.kind;
  for (const step of plan.actions) {
    const key = stepKey(step);
    const guard = isolationKey(step);
    let entry;
    if (rejected.has(key)) entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
    else if (blocked.has(guard)) entry = { step, ok: false, skipped: true, error: `同类动作已失败，本轮不再尝试` };
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
        // transient 的失败原因多是瞬时状态（队列满、库存满、这一份料刚好不够），
        // 记进 rejected 会让后续轮次永远跳过同一格，反而不排了。
        if (!step.transient) rejected.add(key);
        // 瞬时类拒绝（忙 / 太快 / 活动切换）只说明这一条此刻不行，不封锁整个 group ——
        // 否则一次抖动会把后面十几条本来能成的动作一起废掉。
        if (!TRANSIENT_PROMPT_IDS.has(Number(error.prompt?.prompt ?? 0))) blocked.add(guard);
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
export function assetCount(num) {
  if (typeof num === 'number') return Number.isFinite(num) ? num : 0;
  if (num && typeof num === 'object') return Number(num.low ?? 0) + Number(num.high ?? 0) * 2 ** 32;
  return Number(num ?? 0) || 0;
}

// 物品明细的统一格式：`淡水×2、木板×1`。重复 id 合并、数量 <=0 的丢掉。
// 海面计划、循环日志、锻造提示都走这一个函数 —— 各写一份的话，同一批动作在不同地方
// 迟早会显示成不同的数字。
export function itemText(pairs, { unit = '', limit = 6 } = {}) {
  const merged = new Map();
  for (const pair of pairs ?? []) {
    const [id, num] = pair ?? [];
    if (!id) continue;
    const n = assetCount(num);
    if (n <= 0) continue;
    merged.set(id, (merged.get(id) ?? 0) + n);
  }
  const list = [...merged].slice(0, limit).map(([id, num]) => `${id}×${num}${unit}`);
  if (merged.size > limit) list.push(`另有 ${merged.size - limit} 种`);
  return list.join('、');
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
  if (!summary.items.length) {
    // 全被拒不等于功能坏了：海面漂浮物有时效，也可能被别人捡走，
    // 服务端用 deniedFloaterIds 明确告诉你「这几件已经没了」，下一轮会拿新列表。
    if (summary.denied && !summary.failed) {
      return `${head}：这批已经失效（被别人捡走或过期），下一轮会拿新列表`;
    }
    return `${head}：没有回报`;
  }
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
    // 格子像素尺寸：算「城与城之间的距离」要用（客户端 coordToPosition 的 tileWidth/tileHeight）。
    // 缺这两个数就只能按 gridIdx 顶替，距离会错得很离谱，所以一并带出来。
    tileWidth: mapInfo?.tileWidth ?? 0,
    tileHeight: mapInfo?.tileHeight ?? 0,
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

// --- 舰队耐久 ----------------------------------------------------------------
//
// 80% 这条线不是拍脑袋：配置表 `LoadingTipsCfg` 的原话是
// 「城战中舰船耐久度低于 1600 会降低输出，增加受到的伤害，记得及时维修。」
// 本账号 maxDura = 2000 → 1600 / 2000 = **80%**。所以耐久低于 80% 的船去打任何一场战斗
// 都是「输出低 + 挨打疼」，输了还要花汽油修（5.76 汽油/点，见 radar.mjs），不如先修再派。
//
// 耐久消耗本身是分场景的（`WorldParamCfg`）：攻城战 100、打野怪 0、资源地 0、进攻首领 0；
// 情报事件与货轮战斗走通用战损。无论哪一段，判定口径都该是同一个，所以放在这里给各段共用。
export const DURABILITY_WARN_RATIO = 0.8;

// 耐久百分比（0~1）。maxDura 缺失时按「满耐久」处理 —— 拿不到上限就拦船，
// 等于把整个玩法关掉，那是更糟的失败方式。
export function fleetDuraPct(fleet) {
  const max = Number(fleet?.maxDurability ?? fleet?.maxDura) || 0;
  if (max <= 0) return 1;
  return Math.min(1, Math.max(0, (Number(fleet?.durability) || 0) / max));
}

// 耐久够不够派出去打架。floor 是比例（0.8）；<=0 = 不拦（关掉这道闸）。
export function fleetDuraOk(fleet, floor = 0) {
  const ratio = Number(floor);
  if (!(ratio > 0)) return true;
  return fleetDuraPct(fleet) >= Math.min(1, ratio);
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
  // 生产减免直接摆出来：它是「为什么这座工厂能一次排 6 个」的唯一解释依据。
  const reduce = produceReduceOf(survey);
  const hints = (survey.produce?.instant ?? []).length;
  if (reduce > 0) {
    lines.push(`生产时间减免 ${reduce}s（英雄委任）：≤${reduce}s 的配方瞬成，会一次排满制造位`);
  } else if (hints > 0) {
    lines.push(`生产时间减免没算出来（缺委任/英雄数据），但队列里观测到 ${hints} 条瞬成配方，这些会排满`);
  } else {
    lines.push('生产时间减免 0s：没取到委任数据，排产按原时长算，一轮每座工厂排 1 个');
  }
  const farms = (survey.buildings ?? []).filter((b) => b.farm);
  if (farms.length > 0) {
    const nowSec = survey.now ?? Math.floor(Date.now() / 1000);
    const ripe = farms.filter((b) => b.farm.productId && b.farm.ripeAt > 0 && b.farm.ripeAt <= nowSec).length;
    const idle = farms.filter((b) => !b.farm.productId).length;
    const growing = farms.filter((b) => b.farm.productId && b.farm.ripeAt > nowSec);
    const soonest = growing.length > 0 ? Math.min(...growing.map((b) => b.farm.ripeAt - nowSec)) : 0;
    lines.push(`农田 ${farms.length} 块：成熟 ${ripe} · 空闲 ${idle}`
      + (growing.length > 0 ? ` · 生长中 ${growing.length}（最近 ${soonest}s 后）` : '')
      + (survey.autoFarming === true ? ' · 游戏内自动种植开着（只收不种）' : ''));
  }
  if (survey.resFields) {
    const fields = survey.resFields.fields ?? [];
    lines.push(`资源田 ${fields.length}/${survey.resFields.maxNum ?? '?'}${fields.length ? `  已占 ${fields.map((f) => f.gridIdx).join(',')}` : ''}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of [...survey.notes, ...plan.notes]) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
