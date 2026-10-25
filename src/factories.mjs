// 工厂页的数据层：读出每个工厂的队列与囤积成品，算出「这个等级能造什么」，外加一条手动排产请求。
//
// 事实来源（与 world.mjs 同一套口径，避免页面和计划器各说各话）：
// - DispFactory = OnWaterResponse.building[].factory：
//   { factoryQ: [{idx, productId, finishTime}], finishedProducts: [{type,id,num}], autoProductId }
//   finishTime 是 protobuf int64，不 normalize 会变成 {low,high}，倒计时直接算成 NaN。
// - BuildingProduceCfg = { buildType, itemId, limitType, unlockLevel, produceTime, costItem: [[id,num]…] }
//   解锁条件就是 unlockLevel <= 工厂当前等级 —— 客户端同一个判断，没有第二处来源。
//   limitType 非空的是限时活动配方（例如「活动26中秋_捞月钩」），只有活动工厂里有，平时碰不到。
// - 制造位上限在 BuildingProduceParamCfg「制造位上限」，产品存量上限在 GameParamCfg「产品存量初始上限」。
// - StartFactoryProduceRequest{buildingId, productId} 只有这两个字段，且没有配套 Response，
//   所以走 sendWatch：守到 PromptResponse 才算被拒。

import { normalize } from './worlds.mjs';
import {
  rowsOf, paramOf, assetCount, makeTypeResolver, RESOURCE_NAMES, SLOTS_PARAM, STOCK_PARAM,
  appointProduceReduce, observedInstantRecipes, produceFinalTime, produceReduceOf,
} from './world.mjs';

// 只读探测：海面（工厂挂在 building 上）+ 库存（算材料够不够），不多拉资源田与舰队。
// AppointInfo / AllHero 只为算「生产时间减少」—— 页面上要标出哪些配方已经瞬成。
export async function surveyFactories(client, protocol, { config = null, timeout = 8000 } = {}) {
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
  if (!water) throw new Error('拿不到 OnWaterResponse，读不了工厂');
  const [itemList, resourceList, appointInfo, allHero] = await Promise.all([
    get('AllItemRequest'),
    get('AllResourceRequest'),
    get('AppointInfoRequest'),
    get('AllHeroRequest'),
  ]);

  // 道具与资源合成一张库存表：配方消耗项里既有道具名（木材），也有资源名（GOLD）。
  const stock = new Map();
  for (const item of itemList?.items ?? []) {
    const id = item.itemId ?? item.id;
    stock.set(id, (stock.get(id) ?? 0) + assetCount(item.num ?? item.count));
  }
  for (const entry of resourceList?.list ?? []) {
    const id = RESOURCE_NAMES[entry.res] ?? String(entry.res);
    stock.set(id, (stock.get(id) ?? 0) + assetCount(entry.amount));
  }

  const resolveType = makeTypeResolver(config);
  const now = Math.floor(Date.now() / 1000);
  const factories = [];
  for (const rawBuilding of water.building ?? []) {
    const raw = normalize(rawBuilding);
    if (!raw.factory) continue; // 非工厂建筑（民居、指标楼…）直接跳过
    // 制造位是串行的：只有队首正在做的那一项带 finishTime，后面的排队项是 0。
    // 实测 1食品厂 6 个刺身拼盘里只有第 1 个有完成时间，所以 0 要读成「排队中」，
    // 不能当成「已完成」——否则六个格子会全亮成「可收取」。判定集中在 viewFactories。
    const queue = (raw.factory.factoryQ ?? []).map((job) => ({
      idx: job.idx,
      productId: job.productId,
      finishAt: Number(job.finishTime ?? 0) || 0,
    }));
    factories.push({
      buildingId: raw.buildingId,
      type: resolveType(raw.buildingId),
      level: raw.level ?? 0,
      queue,
      finished: (raw.factory.finishedProducts ?? []).map((asset) => ({ id: asset.id, num: assetCount(asset.num) })),
      autoProductId: raw.factory.autoProductId || null,
    });
  }

  return {
    now,
    stock,
    factories,
    factorySlots: paramOf(config, SLOTS_PARAM),
    stockCap: paramOf(config, STOCK_PARAM),
    // 生产时间减免（秒）：来自英雄委任折算的「生产时间减少」，见 world.mjs 的公式。
    // 774 秒的意思就是「300 秒的配方排下去就完成」，页面用 instant 把它标出来。
    // 委任算得出来就不看队列观测了 —— 观测只是拿不到委任数据时的兜底，两者别混。
    produce: (() => {
      const reduce = config
        ? appointProduceReduce(config, { appointed: appointInfo?.heroes ?? [], heroes: allHero?.heroes ?? [] })
        : 0;
      return {
        reduce,
        instant: reduce > 0 ? [] : [...observedInstantRecipes(now, factories, rowsOf(config, 'BuildingProduceCfg'))],
        source: reduce > 0 ? 'appoint' : 'none',
      };
    })(),
  };
}

// 某类工厂的全部配方（含未解锁的，页面要拿等级提示解释「为什么灰着」）。
export function factoryRecipes(config, type) {
  if (!type) return [];
  return rowsOf(config, 'BuildingProduceCfg')
    .filter((row) => row?.buildType === type)
    .map((row) => ({
      itemId: row.itemId,
      produceTime: Number(row.produceTime) || 0,
      unlockLevel: Number(row.unlockLevel) || 1,
      limitType: row.limitType || '',
      costItem: (row.costItem ?? []).map(([id, num]) => ({ id, num: Number(num) || 0 })),
    }));
}

// 页面用的视图：把「够不够、能不能排」都算好，前端只负责画。
// 图标在 server.mjs 那层补（art.mjs 属展示层，不往数据模块里引）。
export function viewFactories(survey, { config = null } = {}) {
  const { stock, factorySlots, stockCap, now } = survey;
  const have = (id) => stock.get(id) ?? 0;
  // 生产时间减免：774s 减免下 300s 的配方就是 0 秒，排下去立刻能收。
  const reduce = produceReduceOf(survey);

  // 整张配方表只扫一遍，按 buildType 分组；「已排队的配方要显示多久」也从这里取 produceTime。
  const byType = new Map();
  for (const row of rowsOf(config, 'BuildingProduceCfg')) {
    if (!row?.buildType) continue;
    if (!byType.has(row.buildType)) byType.set(row.buildType, []);
    byType.get(row.buildType).push({
      itemId: row.itemId,
      produceTime: Number(row.produceTime) || 0,
      unlockLevel: Number(row.unlockLevel) || 1,
      limitType: row.limitType || '',
      costItem: (row.costItem ?? []).map(([id, num]) => ({ id, num: Number(num) || 0 })),
    });
  }

  return {
    now,
    slots: factorySlots,
    stockCap,
    // 生产时间减免（秒）与来源，页面拿它解释「为什么这个配方标着瞬成」。
    produceReduce: reduce,
    produceSource: survey.produce?.source ?? 'none',
    factories: survey.factories.map((factory) => {
      const recipes = byType.get(factory.type) ?? [];
      const produceTimeOf = new Map(recipes.map((recipe) => [recipe.itemId, recipe.produceTime]));
      // 同一配方可以排多个（实测 1食品厂 队列里 6 个刺身拼盘），所以这里只数个数、不当成阻碍。
      const queuedCount = new Map();
      for (const job of factory.queue) queuedCount.set(job.productId, (queuedCount.get(job.productId) ?? 0) + 1);
      return {
        buildingId: factory.buildingId,
        type: factory.type,
        level: factory.level,
        // 队列项带上配方时长，前端拿它算进度条（查不到就是 0，只显示倒计时）。
        // pending = 还没轮到的排队项（finishTime 为 0）；remain 是队首的剩余秒数。
        // finalSeconds 是**减免后**的秒数 —— 进度条的分母必须用它，写原时长会让
        // 「1200 秒配方在 840 秒减免下 360 秒做完」的进度条只走到三成然后跳满。
        queue: factory.queue.map((job) => {
          const produceTime = produceTimeOf.get(job.productId) ?? 0;
          return {
            ...job,
            pending: (job.finishAt ?? 0) <= 0,
            remain: Math.max(0, (job.finishAt ?? 0) - now),
            produceTime,
            finalSeconds: produceFinalTime(produceTime, reduce),
          };
        }),
        finished: factory.finished,
        finishedTotal: factory.finished.reduce((sum, entry) => sum + entry.num, 0),
        autoProductId: factory.autoProductId,
        full: factory.queue.length >= factorySlots,
        recipes: recipes.map((recipe) => {
          const costs = recipe.costItem.map((cost) => ({
            id: cost.id,
            num: cost.num,
            have: have(cost.id),
            enough: have(cost.id) >= cost.num,
          }));
          // 产品本身的持有量要算三处：仓库里 + 这个工厂待收的 + 队列里还排着的。
          // 服务端的 storage full 就是按「这个产品有多少」判的，只算仓库会漏掉待收的
          // （实测：淡水仓库 23 个时仍被回 storage full，说明上限的口径比 AllItem 宽）。
          const inStock = have(recipe.itemId);
          const inFactory = factory.finished
            .filter((asset) => asset.id === recipe.itemId)
            .reduce((sum, asset) => sum + asset.num, 0)
            + factory.queue.filter((job) => job.productId === recipe.itemId).length;
          const held = inStock + inFactory;
          const finalSeconds = produceFinalTime(recipe.produceTime, reduce);
          const hint = (survey.produce?.instant ?? []).includes(`${factory.type}\u0000${recipe.itemId}`);
          return {
            itemId: recipe.itemId,
            produceTime: recipe.produceTime,
            // 减免后的实际秒数。瞬成 = 排下去就完成，可以一次把制造位排满。
            finalSeconds,
            instant: finalSeconds <= 0 || hint,
            unlockLevel: recipe.unlockLevel,
            limitType: recipe.limitType,
            costs,
            enough: costs.every((cost) => cost.enough),
            unlocked: factory.level >= recipe.unlockLevel,
            queuedCount: queuedCount.get(recipe.itemId) ?? 0,
            inStock,
            inFactory,
            held,
            // 仓库里已经有 stockCap 个了，再造也收不进去（服务端会回 storage full）。
            atCap: stockCap > 0 && held >= stockCap,
            // 到底是哪一处满了，决定该给什么建议：工厂囤满 → 收成；仓库满 → 收成没用，得先消耗。
            capKind: stockCap <= 0 || held < stockCap ? null
              : inFactory >= stockCap ? 'factory'
                : inStock >= stockCap ? 'stock'
                  : 'total',
          };
        }),
      };
    }),
  };
}

// 手动排产：只发客户端那条一模一样的请求。没有 Response，守 prompt。
export async function startProduce(client, { buildingId, productId, window = 500 } = {}) {
  if (!client?.connected) throw new Error('还没连上游戏');
  return client.sendWatch('StartFactoryProduceRequest', { buildingId, productId }, { window });
}

// 一键收成：对有囤积成品的每座工厂各发一条 GainFactoryProduceRequest，按产品名合并所得。
// 这条请求**有**配套 Response（GainFactoryProduceResponse.products.asset），所以走 request 而不是 sendWatch：
// 服务端拒了会直接抛错，不用靠猜 prompt。
// 某座工厂失败不影响其它的 —— 逐座 try/catch，最后把失败原因一起返回给页面。
export async function gainAllProducts(client, protocol, factories, { timeout = 15000, gap = 300 } = {}) {
  if (!client?.connected) throw new Error('还没连上游戏');
  if (!protocol.GainFactoryProduceRequest || !protocol.GainFactoryProduceResponse) {
    throw new Error('协议表里没有 GainFactoryProduceRequest / GainFactoryProduceResponse');
  }
  const targets = factories.filter((factory) => factory.finished.length > 0);
  const gained = new Map();
  const results = [];
  for (const target of targets) {
    try {
      const response = normalize(await client.request('GainFactoryProduceRequest', { buildingId: target.buildingId }, 'GainFactoryProduceResponse', timeout));
      const assets = (response?.products?.asset ?? []).map((asset) => ({ id: asset.id, num: assetCount(asset.num) }));
      for (const asset of assets) gained.set(asset.id, (gained.get(asset.id) ?? 0) + asset.num);
      results.push({ buildingId: target.buildingId, ok: true, assets });
    } catch (error) {
      results.push({ buildingId: target.buildingId, ok: false, error: error.message });
    }
    // 一座一座收，不并发打服务端：这里本来就没多少座，慢一点更稳。
    if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return { targets: targets.length, results, gained: [...gained].map(([id, num]) => ({ id, num })) };
}
