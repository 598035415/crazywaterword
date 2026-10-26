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
  appointProduceReduce, observedInstantRecipes, produceFinalTime, produceReduceOf, packIndex,
} from './world.mjs';

// 成本里缺的材料能不能用白名单自选包（原料 / 工事材料）换出来。
// 三处共用一个口径：工厂页的「兑料并制造」提示、手动排产的预检、挂机排产。
// 一包换 num 个单位（SelectPackLibCfg.num，实测原料包是 1），所以要 ceil(缺口 / per) 个包。
// 返回的 ok = 缺口**全部**都能换出来且包够 —— 只补一部分对排产没意义（配方要整份料）。
// `packs` 可以传入已经建好的反查表（工厂页一次 view 要算几十条配方，别每条都重建）。
export function packCoverPlan(config, { costs = [], stock, packs = null } = {}) {
  const index = packs ?? packIndex(config);
  const have = (id) => stock?.get?.(id) ?? 0;
  const gaps = [];
  for (const cost of costs) {
    const need = Number(cost.num ?? 0) - have(cost.id);
    if (need <= 0) continue;
    const entry = index.get(cost.id);
    gaps.push({
      id: cost.id,
      num: Number(cost.num ?? 0),
      have: have(cost.id),
      gap: need,
      // 没有对应的包 = 只能等生产/采集，页面要如实说「换不出来」。
      pack: entry?.pack ?? null,
      per: entry?.per ?? 0,
      packs: entry ? Math.ceil(need / (entry.per || 1)) : 0,
      packHave: entry ? have(entry.pack) : 0,
    });
  }
  const unpackable = gaps.filter((gap) => !gap.pack);
  const shortOnPacks = gaps.filter((gap) => gap.pack && gap.packHave < gap.packs);
  // 同一批缺口可能都靠同一个包补，按包合并成「原料自选包×43」。
  const byPack = new Map();
  for (const gap of gaps) if (gap.pack) byPack.set(gap.pack, (byPack.get(gap.pack) ?? 0) + gap.packs);
  const needs = [...byPack].map(([pack, num]) => ({ pack, num }));
  return {
    gaps,
    unpackable,
    shortOnPacks,
    needs,
    // 真正要发出去的兑换清单：一个材料一条（num = 缺口，协议里 num 是「要换到的数量」）。
    // needs 只用于显示（按包合并），执行必须用 orders，否则一个包换两种材料时会漏发。
    orders: gaps.filter((gap) => gap.pack).map((gap) => ({ pack: gap.pack, itemId: gap.id, num: gap.gap })),
    ok: gaps.length > 0 && unpackable.length === 0 && shortOnPacks.length === 0,
    text: needs.map((entry) => `${entry.pack}×${entry.num}`).join(' + '),
  };
}

// 显式授权（页面「兑料并制造」/ 接口带 usePack:true）才走这里：把缺的材料兑出来。
// 一包换一个单位，是真的花包 —— 所以绝不自动触发，只在用户点了按钮之后调。
// 没有配套 Response，走 sendWatch 守 prompt；被拒会抛错，调用方据此中止排产。
export async function exchangePacks(client, orders, { window = 500, gap = 200 } = {}) {
  const sent = [];
  for (const order of orders ?? []) {
    if (!(Number(order.num) > 0)) continue;
    await client.sendWatch('SelectPackRequest', { itemId: order.pack, selectItemId: order.itemId, num: Number(order.num) }, { window });
    sent.push({ ...order, num: Number(order.num) });
    if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return sent;
}

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
  // 自选包反查表整页只建一次：每条缺料配方都要查「能不能兑」，逐条重建太浪费。
  const packMap = packIndex(config);

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
          // 缺料时算一下「能不能用自选包补齐」：页面靠它决定要不要给「兑料并制造」，
          // 手动排产接口靠同一套数在报错里写清楚要花几个包。
          // 只在缺料时算 —— 料齐的配方不需要知道包里有多少（也省掉每次 view 的重复计算）。
          const cover = costs.some((cost) => !cost.enough)
            ? packCoverPlan(config, { costs, stock, packs: packMap })
            : null;
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
            // 缺料时能不能靠自选包补齐：packable 决定页面是否给「兑料并制造」，
            // packText 是给用户看的消耗（原料自选包×43），packNeeds 是真正要发的兑换清单。
            packable: Boolean(cover?.ok),
            packText: cover?.text ?? '',
            packNeeds: cover?.needs ?? [],
            // 换不出来的材料（比如布匹只存在稀有的蓝装材料包里）：页面要说明「只能等生产」。
            unpackable: (cover?.unpackable ?? []).map((gap) => gap.id),
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
