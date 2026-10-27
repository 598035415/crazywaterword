// 海商王（活动「Trade」）—— 17 个港口之间的低买高卖。
//
// 规则来源：客户端 TipsDescCfg「海商王」原文 + 反编译 TradeUtil/TradeModel/TradeBuyPop/TradeSellPop
// + 协议表 + 2026-10-27 实盘（买→航行→加速→到达→看价）核对。
//
// 【规则原文（客户端弹窗）】
//   · 世界上共 17 个港口，每个港口有一种「特产」和一种「紧缺货物」。
//   · 特产**固定不变**；紧缺货物**每天 10 点更新**。
//   · 货物分 4 档品质（绿/蓝/紫/橙），品质越高利润空间越大、库存越少。
//   · 港口库存**全联盟共享**，先到先得。
//   · 每天 10~20 点，港口**每 2 小时刷新价格与库存**（10/12/14/16/18/20 点整）。
//   · 货物不能在买入港出售，必须运到别的港口。
//   · 各港航行时间均为 2 小时；「商会指针」每个减 30 分钟；指针可用钻石买（每天 50 次，本工具不买）。
//   · 利润 = (卖出价 − 买入价) × 数量 × (1 + 商船利润加成)；亏本卖出无加成，亏损不计入累计利润。
//   · 紧缺货物必须**亲自到港**才能查看与共享；共享后全联盟可见（就是 TradeGuildRadar 那份雷达）。
//
// 【实盘核对出来的价格形状（2026-10-27 10 点前，city 91 / city 64）】
//   每个港口挂 17 种货，price = 基准价 unitPrice × 系数，系数落在 [0.85, 1.13]：
//     specGoodsId   = 系数最低的那一个（= 特产，本城买入最便宜）
//     rareGoodsId   = 系数最高的那一个（= 当日紧缺货，拉到本城卖最贵）
//   实测 city91：特产 布匹 44/50=0.88，紧缺 海鲜披萨 316/280=1.129；
//        city64：特产 海洋球 681/800=0.851，紧缺 布匹 56/50=1.12。
//   也就是说 91 买布匹(44) → 64 卖(56) = 单轮 +27%（再乘商船加成 1.03 ≈ +31%）。
//
// 【关键推论：雷达是一张「配对表」】
//   实盘雷达 17 个港口的 spec/rare 恰好是同一组 17 种货的两个排列 ——
//   每个港口「特产 g」都正好是**另一个**港口的「紧缺 g」。所以最优路线不是自由规划，
//   而是一条固定环线：在 C 买 C 的特产 → 开到「紧缺 = C 特产」的那个港口卖 → 在那里买它的特产 → …
//   每一段都吃到 0.88 → 1.13 的最大价差，没有更优的挑法（这是全局最大边）。
//
// 【协议】
//   TradeInfoRequest {} → TradeInfoResponse {
//     period, player:{coins,maxCoins,profit,goods[{pid,goodsId,num,buyPrice,cityId}],buySpeedTimes},
//     cargo:{cargoLv,cityId,moveStartTime,moveEndTime,moveToCityId},
//     gotAchieveRwdId, gotReportRwdId, guildReportNum,
//     worldCargo:[{cargo,playerId,nickname,guildIdx}]   ← 别人在跑哪条线，纯情报
//     guildTask:{profit,tradeTimes,gotTaskId[]}          ← **联盟**累计，不是个人的
//   }
//   TradeCityRequest {cityId} → TradeCityResponse {goods:[{goodsId,stock,price}], specGoodsId, rareGoodsId, isReport}
//     ⚠ 只能在**船所在的港口**查，别处一律 `server prompt: not in city`（实盘 12 个城市全被拒）。
//     ⚠ stock 是「本刷新周期内已被买走的数量」，可买量 = TradeGoodsCfg.maxCount − stock。
//   TradeBuyRequest {cityId, goodsId, buyNum}  → player
//   TradeSellRequest {cityId, pid, sellNum}    → player
//   TradeMoveRequest {cityId, mvToCityId}      → cargo（moveEndTime = now + 7200 秒，**秒级**）
//   TradeSpeedRequest {useNum}                 → moveEndTime（每个指针 −1800 秒；useNum 上限 4）
//   TradeCargoUpgradeRequest {}                → cargo（升船：要 RUBY，本工具不做）
//   TradeCityReportRequest {cityId}            → 无 Response，服务端推 SCTradeCityReport（共享紧缺货）
//   GotTradeAchievementRequest {}              → {gotAchieveRwdId, reward}   个人累计利润成就
//   TradeGotTaskRequest {taskId}               → {gotTaskId, reward}          联盟任务领取
//   GotTradeReportRequest {}                   → {gotReportRwdId, reward}     商情共享奖励
//   BattlePassRequest/BattlePassGotRewardRequest {type:3} → 海商王战令（3 = BP_TRADE），领免费档
//
// 【时间闸门，实盘 09:3x 核对】
//   TradeBuyRequest 在 10 点前返回 `server prompt: not trade time`，但
//   TradeMoveRequest / TradeSpeedRequest **不受时间限制** —— 所以可以在 10 点前先把船开到
//   目标港口、把指针全用掉，10 点一开门立刻抢库存（库存全联盟共享，先到先得）。
//
// 安全边界：不花钻石（升船、买指针都不做）；商会指针是免费道具（联盟任务/战令产出），默认全用。

import { assetCount } from './world.mjs';

// 紧缺货物的价格系数（实盘 1.12~1.13）。保守取 1.10，避免高估利润把资金压死在一次交易上。
export const DEFAULT_SELL_RATIO = 1.10;
// 目的地未知的货不买 —— 运到一个不挂这件货的港口连卖都卖不掉（TradeSellRequest 会直接被拒）。
export const TRADE_PASS_TYPE = 3;
export const SPEED_ITEM = '海商王加速';
export const SPEED_ITEM_NAME = '商会指针';
// TradeCargoUpgrade 的钻石成本 —— 只用来在概览里提示「还差多少 / 要花多少钻石」，永不自动执行。
export const QUALITY_TEXT = { 1: '绿', 2: '蓝', 3: '紫', 4: '橙', 5: '红' };

const num = (v) => Number(v ?? 0) || 0;

// ActivityTradeCfg 是 key/value 表，客户端全都是 `tradeCfgArgs(key)` 直读。
export function tradeParams(config) {
  const rows = config?.tables?.ActivityTradeCfg?.data ?? [];
  const get = (key, fallback) => {
    const hit = rows.find((row) => row?.key === key);
    const value = hit?.value;
    const n = Number(value);
    return Number.isFinite(n) ? n : (value ?? fallback);
  };
  const hours = String(get('海商王贸易时间', '10-22')).split('-').map((s) => Number(s) || 0);
  const refresh = String(get('海商王刷新时间', '10,12,14,16,18,20'))
    .split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    // 行驶时间 / 加速时长 都是**分钟**（客户端 `60 * tradeCfgArgs(...)`），不是秒。
    sailMinutes: num(get('海商王行驶时间', 120)) || 120,
    speedMinutes: num(get('海商王加速时长', 30)) || 30,
    speedBuyLimit: num(get('海商王加速日购买上限', 50)),
    initCoins: num(get('海商王初始货币', 10000)),
    openFrom: hours[0] ?? 10,
    openTo: hours[1] ?? 22,
    refreshHours: refresh.length > 0 ? refresh : [10, 12, 14, 16, 18, 20],
  };
}

export function shipOf(config, lv) {
  const rows = config?.tables?.TradeShipCfg?.data ?? [];
  const row = rows.find((r) => num(r?.lv) === num(lv));
  return {
    lv: num(lv) || 1,
    // profitMargin 是万分比：300 = 3%，客户端 `1 + profitMargin / 1e4`。
    marginBp: num(row?.profitMargin) || 0,
    capacity: num(row?.capacity) || 0,
    upMoney: num(row?.upMoney) || 0,
    // upCost = ["RUBY", 300]；钻石成本，只展示不执行。
    upRuby: num(Array.isArray(row?.upCost) ? row.upCost[1] : 0),
  };
}

export function goodsMap(config) {
  const map = new Map();
  for (const row of config?.tables?.TradeGoodsCfg?.data ?? []) {
    map.set(num(row?.goodsId), {
      goodsId: num(row?.goodsId),
      lv: num(row?.lv),
      itemId: row?.itemId ?? '',
      name: row?.itemName ?? row?.itemId ?? String(row?.goodsId ?? ''),
      quality: num(row?.qualityIndex),
      base: num(row?.unitPrice),
      maxCount: num(row?.maxCount),
      // capacity = 这件货每个占多少舱位（绿 1 / 蓝 2 / 紫 4 / 橙 10 / 红 20）。
      capacity: num(row?.capacity) || 1,
    });
  }
  return map;
}

// 服务端时间是秒，本工具到处是毫秒。只在这一层换算，别在各处 Math.floor(now/1000)。
const secOf = (ms) => Math.floor(Number(ms) / 1000);

// 10~22 点开市；开门前 / 关门后都返回「下一次开门」。
export function tradeWindow(nowMs, params) {
  const now = Number(nowMs);
  const from = params?.openFrom ?? 10;
  const to = params?.openTo ?? 22;
  const start = new Date(now);
  start.setHours(from, 0, 0, 0);
  const end = new Date(now);
  end.setHours(to, 0, 0, 0);
  const open = now >= start.getTime() && now < end.getTime();
  if (open) return { open: true, startAt: secOf(start.getTime()), endAt: secOf(end.getTime()) };
  const next = now < start.getTime() ? start : new Date(start.getTime() + 86_400_000);
  return { open: false, startAt: secOf(next.getTime()), endAt: secOf(end.getTime()) };
}

// 下一次「价格与库存刷新」（10/12/14/16/18/20 点整）。
export function nextRefreshAt(nowMs, params) {
  const now = Number(nowMs);
  for (const hour of params?.refreshHours ?? []) {
    const at = new Date(now);
    at.setHours(hour, 0, 0, 0);
    if (at.getTime() > now) return secOf(at.getTime());
  }
  const at = new Date(now + 86_400_000);
  at.setHours(params?.refreshHours?.[0] ?? 10, 0, 0, 0);
  return secOf(at.getTime());
}

// 雷达 → 配对表。
//   specByCity : cityId → 特产 goodsId（固定不变，可长期用）
//   rareByCity : cityId → 当日紧缺 goodsId（每天 10 点变）
//   rareCityOf : goodsId → 哪个港口把它当紧缺货（= 这件货该卖到哪）
// radar 里可能缺某些港口（联盟没人共享），缺的港口就不参与配对。
export function buildCityIndex(radar) {
  const list = Array.isArray(radar?.radar) ? radar.radar : (Array.isArray(radar) ? radar : []);
  const cities = [];
  const specByCity = new Map();
  const rareByCity = new Map();
  const rareCityOf = new Map();
  for (const row of list) {
    const cityId = num(row?.cityId);
    if (!cityId) continue;
    const spec = num(row?.specGoodsId);
    const rare = num(row?.rareGoodsId);
    cities.push({
      cityId,
      specGoodsId: spec,
      rareGoodsId: rare,
      reporter: row?.reportName ?? '',
    });
    if (spec) specByCity.set(cityId, spec);
    if (rare) {
      rareByCity.set(cityId, rare);
      // 同一个货被两个港口当紧缺时，保留先出现的（理论上不会，配平是双射）。
      if (!rareCityOf.has(rare)) rareCityOf.set(rare, cityId);
    }
  }
  return { cities, specByCity, rareByCity, rareCityOf };
}

// 只读探测。**航行途中不发 TradeCity**（必定被拒，白打一个请求）。
export async function surveyTradeKing(client, protocol, { timeout = 8000, learned = null, stock = null } = {}) {
  const info = await client.request('TradeInfoRequest', {}, 'TradeInfoResponse', timeout);
  const now = Date.now();
  const period = num(info?.period);
  const cargo = info?.cargo ?? {};
  const moveEnd = num(cargo.moveEndTime);
  const docked = !(moveEnd > secOf(now));
  const cityId = num(cargo.cityId);
  // 雷达只有「在港 / 在航」都要（在航时也要知道到了之后去哪儿），但开市前也该读：
  // 10 点前船长已经在路上，配对表决定了目标港口。所以雷达每次都读，城市价格只在港才读。
  const radar = await client.request('TradeGuildRadarRequest', {}, 'TradeGuildRadarResponse', timeout)
    .catch(() => null);
  const city = docked && cityId
    ? await client.request('TradeCityRequest', { cityId }, 'TradeCityResponse', timeout).catch(() => null)
    : null;
  // 商会指针的存量：TradeInfoResponse 里没有这个字段，只能从背包表拿。
  // 挂机里复用海面那一段已经拉过的库存表（零额外请求）；单独跑时传进来的 stock 为 null。
  const speedItems = stock instanceof Map ? assetCount(stock.get(SPEED_ITEM)) : null;
  return { info, radar, city, now, period, docked, learned, speedItems };
}

// 把协议摊平成页面/日志/计划器能直接用的形状。纯函数（单测喂合成数据）。
export function viewTradeKing(survey, { config, now = null, sellRatio = DEFAULT_SELL_RATIO } = {}) {
  const nowMs = Number(now ?? survey?.now ?? Date.now());
  const nowSec = secOf(nowMs);
  const params = tradeParams(config);
  const goods = goodsMap(config);
  const info = survey?.info ?? {};
  const period = num(info.period ?? survey?.period);
  const player = info.player ?? {};
  const cargoRaw = info.cargo ?? {};
  const cargoLv = num(cargoRaw.cargoLv) || 1;
  const ship = shipOf(config, cargoLv);
  const cityId = num(cargoRaw.cityId);
  const moveEnd = num(cargoRaw.moveEndTime);
  const phase = moveEnd > nowSec ? 'sail' : 'dock';
  const win = tradeWindow(nowMs, params);
  const index = buildCityIndex(survey?.radar);

  // 持仓：pid 是卖货时唯一要带回去的句柄。
  const holdings = (Array.isArray(player.goods) ? player.goods : []).map((row) => {
    const cfg = goods.get(num(row?.goodsId));
    return {
      pid: num(row?.pid),
      goodsId: num(row?.goodsId),
      name: cfg?.name ?? String(row?.goodsId ?? ''),
      quality: cfg?.quality ?? 0,
      num: assetCount(row?.num),
      buyPrice: num(row?.buyPrice),
      cityId: num(row?.cityId),
      capacity: (cfg?.capacity ?? 1) * assetCount(row?.num),
    };
  });
  const usedCapacity = holdings.reduce((sum, h) => sum + h.capacity, 0);
  const freeCapacity = Math.max(0, ship.capacity - usedCapacity);

  // 本港货架。avail = maxCount − stock（stock 是「这个刷新周期已卖出的数量」）。
  const shelf = (Array.isArray(survey?.city?.goods) ? survey.city.goods : []).map((row) => {
    const cfg = goods.get(num(row?.goodsId));
    const price = num(row?.price);
    const base = cfg?.base ?? 0;
    const maxCount = cfg?.maxCount ?? 0;
    const stock = num(row?.stock);
    return {
      goodsId: num(row?.goodsId),
      name: cfg?.name ?? String(row?.goodsId ?? ''),
      quality: cfg?.quality ?? 0,
      capacity: cfg?.capacity ?? 1,
      base,
      price,
      stock,
      avail: Math.max(0, maxCount - stock),
      ratio: base > 0 ? price / base : 0,
      maxCount,
    };
  });
  const shelfByGoods = new Map(shelf.map((row) => [row.goodsId, row]));
  const specGoodsId = num(survey?.city?.specGoodsId);
  const rareGoodsId = num(survey?.city?.rareGoodsId);
  // 本港特产的到货卖点：雷达里把这种货当紧缺货的港口。
  const specSellCity = specGoodsId ? num(index.rareCityOf.get(specGoodsId)) : 0;

  // 已学到的「港口 → 挂哪些货」（只有在那个港口停过才知道）。用来判断第二件货能不能卖得掉。
  const learned = survey?.learned ?? null;
  const learnedCities = learned?.cities ?? {};
  const knowsShelf = (targetCityId, goodsId) => {
    const list = learnedCities[String(targetCityId)];
    return Array.isArray(list) && list.includes(goodsId);
  };

  // 持仓能在本港卖掉的（cityId 不同才允许卖，且本港货架必须有这件货）。
  const sellable = holdings
    .filter((h) => h.cityId !== cityId && shelfByGoods.has(h.goodsId))
    .map((h) => {
      const row = shelfByGoods.get(h.goodsId);
      const margin = 1 + ship.marginBp / 10_000;
      // 与客户端 TradeSellPop 完全同款：先算差价再乘商船加成，最后把本金加回来。
      const profit = Math.ceil((row.price - h.buyPrice) * h.num * margin);
      const revenue = Math.ceil(h.buyPrice * h.num) + profit;
      return {
        ...h,
        sellPrice: row.price,
        profit,
        revenue,
        // 亏本不卖（客户端也拦着）：亏了掉本金，而且亏损不计入累计利润，纯亏。
        profitable: row.price >= h.buyPrice,
      };
    });
  const keep = sellable.filter((h) => !h.profitable);

  // 买什么：只认「有确切卖点」的货 —— 它必须是某个港口的当日紧缺货（稀有 = 该港最高价）。
  const candidates = [];
  for (const row of shelf) {
    if (row.avail <= 0 || row.price <= 0 || row.base <= 0) continue;
    const destCityId = num(index.rareCityOf.get(row.goodsId));
    // 货物不能在买入港出售 —— 配对港口是本港时，这件货就等于没有卖点（客户端 TradeSellPop 也拦着）。
    const selfDest = Boolean(destCityId) && destCityId === cityId;
    const expected = Math.round(row.base * sellRatio);
    const unitProfit = Math.ceil((expected - row.price) * (1 + ship.marginBp / 10_000));
    if (unitProfit <= 0) continue;
    // 本港特产 = 该港最便宜的那一件，永远是本港最优买入（也是雷达配对的那一件）。
    const isSpec = row.goodsId === specGoodsId;
    candidates.push({
      ...row,
      destCityId,
      expected,
      unitProfit,
      roi: row.price > 0 ? unitProfit / row.price : 0,
      perCapacity: row.capacity > 0 ? unitProfit / row.capacity : 0,
      isSpec,
      selfDest,
      // 卖点确认度：特产 → 雷达配对（100% 卖得掉）；其余只有「到过那个港口见过这件货」才算数。
      sure: Boolean(destCityId) && !selfDest && (isSpec || knowsShelf(destCityId, row.goodsId)),
    });
  }

  const achievements = (config?.tables?.TradeAchieveRewardCfg?.data ?? [])
    .filter((row) => num(row?.id) === period)
    .map((row) => ({ rewardId: num(row.rewardId), target: num(row.target), rewards: row.rewards ?? [] }))
    .sort((a, b) => a.rewardId - b.rewardId);
  const gotAchieve = num(info.gotAchieveRwdId);
  const nextAchieve = achievements.find((row) => row.rewardId > gotAchieve) ?? null;

  const guildTasks = (config?.tables?.TradeGuildTaskCfg?.data ?? [])
    .map((row) => ({
      id: num(row.id),
      day: num(row.day),
      // taskType 0 = 联盟累计利润，1 = 联盟贸易次数（客户端 getTaskState 同款）。
      type: num(row.taskType),
      target: num(row.tragetCount),
      rewards: row.rewards ?? [],
    }))
    .sort((a, b) => a.id - b.id);
  const gotTasks = new Set((Array.isArray(info.guildTask?.gotTaskId) ? info.guildTask.gotTaskId : []).map(num));
  const guildProfit = num(info.guildTask?.profit);
  const guildTimes = num(info.guildTask?.tradeTimes);
  const claimableTasks = guildTasks
    .filter((task) => !gotTasks.has(task.id) && (task.type === 0 ? guildProfit : guildTimes) >= task.target)
    .map((task) => task.id);

  const reportRewards = (config?.tables?.TradeDayRewardCfg?.data ?? [])
    .map((row) => ({ id: num(row.id), roleNum: num(row.roleNum), rewards: row.rewards ?? [] }))
    .sort((a, b) => a.id - b.id);
  const gotReport = num(info.gotReportRwdId);
  const reportNum = num(info.guildReportNum);
  const nextReport = reportRewards.find((row) => row.id > gotReport) ?? null;
  const reportClaimable = Boolean(nextReport && reportNum >= nextReport.roleNum);

  // 海商王战令（BP_TRADE=3）：积分就是累计利润（客户端 tips「1利润=1积分」）。
  // 免费档只要 reqScore 到线就能领，永久有效 —— 所以「够线了」才发请求，别在 0 分时问一整天。
  const passTiers = (config?.tables?.TradePassCfg?.data ?? [])
    .filter((row) => num(row?.period) === period)
    .map((row) => ({ rwdId: num(row.rwdId), reqScore: num(row.reqScore), rewards: row.freeReward ?? [] }))
    .filter((row) => row.rewards.length > 0)
    .sort((a, b) => a.reqScore - b.reqScore);
  const passScore = num(player.profit);

  // 下一段航线：手里有货 → 去「把这件货当紧缺」的港口；空舱 → 去本港特产的卖点买下一批。
  // 手里的货在本港卖不掉（本港不挂这件货 / 亏本留着）时，目的地照样按「这件货的紧缺港口」算，
  // 否则会一直原地打转。
  const lead = sellable.slice().sort((a, b) => b.profit - a.profit)[0] ?? null;
  const leadGoodsId = lead?.goodsId ?? holdings[0]?.goodsId ?? specGoodsId;
  let targetCityId = num(index.rareCityOf.get(leadGoodsId));
  if (!targetCityId || targetCityId === cityId) {
    // 无配对（雷达缺项 / 目的地就是本港）：退化成「任一其他港口」，让船先动起来。
    targetCityId = index.cities.find((c) => c.cityId !== cityId)?.cityId ?? 0;
  }

  const speedLeftSeconds = phase === 'sail' ? Math.max(0, moveEnd - nowSec) : 0;
  const speedSecsPerItem = params.speedMinutes * 60;
  const speedNeed = speedLeftSeconds > 0 ? Math.ceil(speedLeftSeconds / speedSecsPerItem) : 0;
  // 客户端滑块上限 = min(ceil(剩余/1800), floor(7200/1800) = 4)。
  const speedMax = Math.min(4, speedNeed);
  const speedOwned = assetCount(survey?.speedItems);

  const profit = num(player.profit);
  return {
    now: nowSec,
    period,
    // period = 0 = 本期没开（客户端 isOpen 同款判据）。
    open: Boolean(period > 0) && win.open,
    windowOpen: win.open,
    startAt: win.startAt,
    endAt: win.endAt,
    nextRefreshAt: nextRefreshAt(nowMs, params),
    refreshHours: params.refreshHours,
    sailSeconds: params.sailMinutes * 60,
    speedSeconds: speedSecsPerItem,
    ship,
    player: {
      coins: num(player.coins),
      maxCoins: num(player.maxCoins),
      profit,
      buySpeedTimes: num(player.buySpeedTimes),
    },
    cargo: {
      lv: cargoLv,
      cityId,
      phase,
      moveStartTime: num(cargoRaw.moveStartTime),
      moveEndTime: moveEnd,
      moveToCityId: num(cargoRaw.moveToCityId),
      leftSeconds: speedLeftSeconds,
    },
    holdings,
    usedCapacity,
    freeCapacity,
    shelf,
    specGoodsId,
    rareGoodsId,
    specSellCity,
    isReport: Boolean(survey?.city?.isReport),
    sellable,
    keep,
    candidates,
    targetCityId,
    cities: index.cities,
    // 货 → 该卖到哪个港口（当日紧缺表）。挂机里给页面和计划器直接查，不用再摸 Map。
    rareCityOf: Object.fromEntries(index.rareCityOf),
    pairs: index.cities.map((c) => ({
      cityId: c.cityId,
      specGoodsId: c.specGoodsId,
      specName: goods.get(c.specGoodsId)?.name ?? '',
      sellCityId: num(index.rareCityOf.get(c.specGoodsId)),
    })),
    rewards: {
      achieve: { next: nextAchieve, got: gotAchieve, claimable: Boolean(nextAchieve && profit > nextAchieve.target) },
      tasks: { claimable: claimableTasks, got: [...gotTasks], profit: guildProfit, times: guildTimes },
      report: { next: nextReport, got: gotReport, num: reportNum, claimable: reportClaimable },
      pass: {
        score: passScore,
        tiers: passTiers.length,
        minReqScore: passTiers[0]?.reqScore ?? 0,
        reachable: passTiers.filter((row) => passScore >= row.reqScore).length,
      },
    },
    speed: { leftSeconds: speedLeftSeconds, max: speedMax, owned: speedOwned, secsPerItem: speedSecsPerItem },
    worldCargo: Array.isArray(info.worldCargo) ? info.worldCargo : [],
    guildTask: info.guildTask ?? null,
  };
}

// 背包里的商会指针数量（TradeInfoResponse 里没有，得从 AllItemRequest 拿）。
export function speedItemCount(itemList, itemName = SPEED_ITEM) {
  for (const item of itemList?.items ?? []) {
    const id = item?.itemId ?? item?.id;
    if (id === itemName) return assetCount(item?.num ?? item?.count);
  }
  return 0;
}

// 两种约束（资金 / 舱位）下的贪心分配，取更优的那个。
// 这不是随意的启发式：这是 2 约束线性规划的两个顶点 —— 最优解必然落在其中一个顶点附近，
// 一个按「每块商会币的利润」排序（资金先耗尽），一个按「每格舱位的利润」排序（舱位先耗尽）。
function allocate(candidates, coins, freeCapacity, orderOf) {
  let left = Math.max(0, Math.floor(coins));
  let cap = Math.max(0, Math.floor(freeCapacity));
  const picked = [];
  let profit = 0;
  let spent = 0;
  for (const row of orderOf(candidates)) {
    if (cap <= 0 || left <= 0) break;
    const byCap = Math.floor(cap / row.capacity);
    const byCoin = row.price > 0 ? Math.floor(left / row.price) : 0;
    const want = Math.min(row.avail, byCap, byCoin);
    if (want <= 0) continue;
    picked.push({ row, num: want });
    spent += want * row.price;
    left -= want * row.price;
    cap -= want * row.capacity;
    profit += want * row.unitProfit;
  }
  return { picked, profit, spent };
}

// 买什么：**一条航线只能去一个港口**，所以每种候选各自吃满资金/舱位，取「单件总利润」最大的那个。
// 贪心混着买会踩坑：几种货的紧缺港口各不相同，第二件货会被运到一个卖不掉它的港口，白占舱位。
// 特产天然是最优解（本港系数最低 → 单币利润最高），雷达配对保证它一定卖得掉。
export function planBuy(view, { sellRatio = DEFAULT_SELL_RATIO } = {}) {
  const notes = [];
  const coins = view?.player?.coins ?? 0;
  if (coins <= 0) return { picks: [], notes: ['商会币为 0，无法买入'], spent: 0, expectedProfit: 0 };
  // 只挑「卖点确定」的：特产（雷达配对）或到过那个港口见过这种货。
  const sure = (view?.candidates ?? []).filter((row) => row.sure);
  if (sure.length === 0) {
    return { picks: [], notes: ['本港没有「有确切卖点」的货可买（雷达缺项或库存为 0）'], spent: 0, expectedProfit: 0 };
  }
  let best = null;
  for (const row of sure) {
    const alloc = allocate([row], coins, view.freeCapacity, (rows) => rows);
    const pick = alloc.picked[0];
    if (!pick) continue;
    const profit = pick.num * row.unitProfit;
    if (!best || profit > best.profit) {
      best = { row, num: pick.num, profit, spent: pick.num * row.price };
    }
  }
  if (!best) {
    return { picks: [], notes: ['舱位或资金不够买一件，本轮空舱'], spent: 0, expectedProfit: 0 };
  }
  const picks = [{ row: best.row, num: best.num }];
  if (!best.row.isSpec) {
    const spec = view.candidates.find((row) => row.isSpec && row.sure && row.avail > 0);
    if (spec) {
      notes.push(`本港特产「${spec.name}」库存 ${spec.avail}，不是本轮最优（选的是「${best.row.name}」）`);
    }
  }
  const lost = view.candidates.filter((row) => !row.sure && row.avail > 0);
  if (lost.length > 0) {
    notes.push(`${lost.length} 种货没有可卖港口（${lost.slice(0, 3).map((r) => r.name).join('、')}${lost.length > 3 ? ' 等' : ''}），不买`);
  }
  return {
    picks,
    notes,
    spent: best.spent,
    expectedProfit: Math.round(best.profit),
  };
}

// 一段（一个来回的一半）的完整计划：领奖 → 卖 → 共享商情 → 买 → 起航 → 加速。
// 全部按「当前视图」静态算好，执行顺序就是数组顺序（买卖必须串行，买多少靠卖出后的商会币）。
export function planTradeKing(view, {
  config = null,
  allowSpeed = true,
  sellRatio = DEFAULT_SELL_RATIO,
  allowPass = true,
} = {}) {
  const actions = [];
  const notes = [];
  if (!view) return { actions, notes: ['没有视图'] };
  const period = view.period ?? 0;
  if (!period) {
    return { actions, notes: ['本期海商王未开启（period=0）'] };
  }

  // ---- 1. 领奖：跟「在不在市」无关，只要条件满足就能领 ----
  const rewards = view.rewards ?? {};
  if (rewards.achieve?.claimable) {
    const next = rewards.achieve.next;
    actions.push({
      kind: 'tradeAchieve',
      request: 'GotTradeAchievementRequest',
      response: 'GotTradeAchievementResponse',
      body: {},
      key: `tradeAchieve:${period}:${next.rewardId}`,
      // 成就只能按顺序领，领完 gotAchieveRwdId 变化，下一轮自然会指向下一个。
      transient: true,
      label: `领海商王成就 ${next.rewardId}（累计利润 ${view.player.profit}/${next.target}）`,
    });
  }
  if (rewards.report?.claimable) {
    const next = rewards.report.next;
    actions.push({
      kind: 'tradeReportReward',
      request: 'GotTradeReportRequest',
      response: 'GotTTradeReportResponse',
      body: {},
      key: `tradeReport:${period}:${next.id}`,
      transient: true,
      label: `领商情共享奖励 ${next.id}（联盟已共享 ${rewards.report.num}/${next.roleNum} 个港口）`,
    });
  }
  // 联盟任务：一天只领到当前天、且目标已达成的那些；一次最多领 1 个（服务端按顺序发）。
  const taskId = (rewards.tasks?.claimable ?? [])[0];
  if (taskId) {
    const task = (config?.tables?.TradeGuildTaskCfg?.data ?? []).find((row) => Number(row?.id) === Number(taskId));
    actions.push({
      kind: 'tradeTask',
      request: 'TradeGotTaskRequest',
      response: 'TradeGotTaskResponse',
      body: { taskId },
      key: `tradeTask:${period}:${taskId}:${new Date(view.now * 1000).toDateString()}`,
      // 被「当天还没解锁」拒掉时不该永久拉黑 —— key 里带上日期，第二天自动重试。
      transient: false,
      label: `领联盟任务 ${taskId}（${task?.desc ?? ''}）`,
    });
  }
  // 战令免费档：只在「积分（= 累计利润）已经够到第一档」时才发。
  // 0 分就发必被服务端拒，而 key 带日期（失败当天不再重试）—— 那样会把一整天的战令奖励全丢掉。
  const pass = rewards.pass ?? {};
  if (allowPass && num(pass.reachable) > 0) {
    actions.push({
      kind: 'tradePass',
      request: 'BattlePassGotRewardRequest',
      response: 'BattlePassGotRewardResponse',
      body: { type: TRADE_PASS_TYPE },
      key: `tradePass:${period}:${new Date(view.now * 1000).toDateString()}`,
      // 领完所有可达档位后服务端会拒（没有可领的）→ 当天不再重试就是正确行为。
      transient: false,
      group: 'tradePass',
      label: `领海商王战令免费奖励（积分 ${pass.score}，已达 ${pass.reachable}/${pass.tiers} 档）`,
    });
  }

  // ---- 2. 在航：只用指针加速，别的都做不了 ----
  if (view.cargo.phase === 'sail') {
    if (allowSpeed && view.speed.max > 0 && view.speed.owned > 0) {
      const useNum = Math.min(view.speed.max, view.speed.owned);
      actions.push({
        kind: 'tradeSpeed',
        request: 'TradeSpeedRequest',
        response: 'TradeSpeedResponse',
        body: { useNum },
        key: `tradeSpeed:${view.cargo.moveStartTime}:${view.cargo.moveEndTime}`,
        transient: true,
        label: `用 ${useNum} 个商会指针加速（${Math.ceil(view.speed.leftSeconds / 60)} 分 → ${Math.max(0, Math.ceil((view.speed.leftSeconds - useNum * view.speed.secsPerItem) / 60))} 分）`,
      });
    } else {
      notes.push(`航行中，还剩 ${Math.ceil(view.speed.leftSeconds / 60)} 分钟`
        + (view.speed.owned > 0 ? '' : '（没有商会指针）'));
    }
    return { actions, notes };
  }

  if (!view.windowOpen) {
    notes.push(`不在贸易时间（每天 ${new Date(view.startAt * 1000).getHours()}~${new Date(view.endAt * 1000).getHours()} 点），本轮只领奖`);
    return { actions, notes };
  }

  // 连本港货架都没拿到（TradeCityRequest 失败 / 港口没数据）时什么都别干：
  // 这时既算不出卖价也算不出买什么，硬起航只会把货拉到一个未知的港口。
  if (view.shelf.length === 0) {
    notes.push(`没拿到城市 ${view.cargo.cityId} 的货架价格，本轮不动（下轮重试）`);
    return { actions, notes };
  }

  // ---- 3. 卖货：能卖且不亏的全卖（亏本的留着，等一个更贵的港口） ----
  let coins = view.player.coins;
  for (const h of view.sellable) {
    if (!h.profitable) continue;
    coins += h.revenue;
    actions.push({
      kind: 'tradeSell',
      request: 'TradeSellRequest',
      response: 'TradeSellResponse',
      body: { cityId: view.cargo.cityId, pid: h.pid, sellNum: h.num },
      key: `tradeSell:${h.pid}`,
      transient: true,
      group: 'tradeSell',
      items: [[h.name, h.num]],
      label: `卖 ${h.name}×${h.num}（买 ${h.buyPrice} → 卖 ${h.sellPrice}，预计利润 ${h.profit}）`,
    });
  }
  for (const h of view.keep) {
    notes.push(`${h.name}×${h.num} 本港只卖 ${h.sellPrice}，低于买入价 ${h.buyPrice}，留着`);
  }

  // ---- 4. 共享商情（免费，且是全联盟的雷达来源；每港每天一次） ----
  if (!view.isReport && view.cargo.cityId) {
    actions.push({
      kind: 'tradeShare',
      request: 'TradeCityReportRequest',
      response: null,
      body: { cityId: view.cargo.cityId },
      key: `tradeShare:${view.cargo.cityId}:${new Date(view.now * 1000).toDateString()}`,
      // 已被别人共享过时服务端会拒 → 这个港口当天就不用再试了。
      transient: false,
      label: `共享城市 ${view.cargo.cityId} 的紧缺货物（全联盟可见）`,
    });
  }

  // ---- 5. 买货 ----
  // 买入量要按「卖完之后」的资金与舱位算：这一轮卖的货是同一轮里腾出来的，
  // 拿探测时的旧值算会少买一大截（资金是主要瓶颈，差一倍很常见）。
  const soldPids = new Set(view.sellable.filter((h) => h.profitable).map((h) => h.pid));
  const usedAfterSell = view.holdings
    .filter((h) => !soldPids.has(h.pid))
    .reduce((sum, h) => sum + h.capacity, 0);
  const buyView = {
    ...view,
    player: { ...view.player, coins },
    freeCapacity: Math.max(0, view.ship.capacity - usedAfterSell),
  };
  const buy = planBuy(buyView, { sellRatio });
  notes.push(...buy.notes);
  for (const pick of buy.picks) {
    actions.push({
      kind: 'tradeBuy',
      request: 'TradeBuyRequest',
      response: 'TradeBuyResponse',
      body: { cityId: view.cargo.cityId, goodsId: pick.row.goodsId, buyNum: pick.num },
      key: `tradeBuy:${view.cargo.cityId}:${pick.row.goodsId}:${view.nextRefreshAt}`,
      transient: true,
      group: 'tradeBuy',
      items: [[pick.row.name, pick.num]],
      label: `买 ${pick.row.name}×${pick.num} @${pick.row.price}（→ 城市 ${pick.row.destCityId} 卖出，预计利润 ${pick.num * pick.row.unitProfit}）`,
    });
  }

  // ---- 6. 起航 ----
  // 目的地优先级：还压着没卖掉的货 → 那件货的紧缺港口；本轮买到了 → 买的那件货的紧缺港口；
  // 都没买到 → 本港特产的紧缺港口（到了再买）。
  const keepDest = num(view.rareCityOf?.[view.keep?.[0]?.goodsId]);
  const boughtDest = num(buy.picks[0]?.row.destCityId);
  const dest = keepDest || boughtDest || view.targetCityId;
  // 起航是整整 2 小时，所以「本段能不能用指针」看的是持有量而不是当前剩余航时
  // （view.speed.max 是给「已在航」用的，停港时它是 0）。
  const speedForLeg = allowSpeed ? Math.min(4, view.speed.owned) : 0;
  const arriveAt = view.now + Math.max(0, view.sailSeconds - speedForLeg * view.speed.secsPerItem);
  if (!dest) {
    notes.push('雷达里没有可用目的地，本轮不起航');
  } else if (dest === view.cargo.cityId) {
    notes.push('目的地就是本港，本轮不起航');
  } else if (arriveAt > view.endAt) {
    // 收市前到不了就别走：货在船上过夜不亏，但白烧指针。
    notes.push(`现在起航要 ${Math.ceil((view.sailSeconds - speedForLeg * view.speed.secsPerItem) / 60)} 分钟，`
      + `会错过 ${new Date(view.endAt * 1000).getHours()} 点收市，本轮不起航`);
  } else {
    actions.push({
      kind: 'tradeSail',
      request: 'TradeMoveRequest',
      response: 'TradeMoveResponse',
      body: { cityId: view.cargo.cityId, mvToCityId: dest },
      key: `tradeSail:${view.cargo.cityId}:${dest}:${view.nextRefreshAt}`,
      transient: true,
      label: `起航 城市${view.cargo.cityId} → 城市${dest}`
        + (speedForLeg > 0 ? `（随即用 ${speedForLeg} 个指针，约 ${Math.max(0, Math.ceil((view.sailSeconds - speedForLeg * view.speed.secsPerItem) / 60))} 分钟到）` : '（约 2 小时）'),
    });
    // 起航后立刻用指针：指针是免费道具（联盟任务/战令产出），留着不用等于少跑好几趟。
    if (speedForLeg > 0) {
      actions.push({
        kind: 'tradeSpeed',
        request: 'TradeSpeedRequest',
        response: 'TradeSpeedResponse',
        body: { useNum: speedForLeg },
        key: `tradeSpeed:${view.cargo.cityId}:${dest}:${view.nextRefreshAt}`,
        transient: true,
        group: 'tradeSpeed',
        label: `用 ${speedForLeg} 个商会指针加速航程`,
      });
    }
  }

  return { actions, notes };
}

// 一轮概览：一期利润 / 商会币 / 船 / 位置 / 下一段卖点。
export function formatTradeSummary(view) {
  if (!view) return '';
  const p = view.player ?? {};
  const parts = [
    `利润 ${p.profit ?? 0}`,
    `商会币 ${p.coins ?? 0}/${p.maxCoins ?? 0}`,
    `船 lv${view.cargo?.lv ?? 1}（舱位 ${view.ship?.capacity ?? 0}，+${Math.round((view.ship?.marginBp ?? 0) / 100)}%）`,
  ];
  if (view.cargo?.phase === 'sail') {
    parts.push(`航行中 城${view.cargo.cityId}→城${view.cargo.moveToCityId} 剩 ${Math.ceil((view.cargo.leftSeconds ?? 0) / 60)} 分钟`);
  } else {
    parts.push(`停在城市 ${view.cargo?.cityId ?? '-'}`);
    if (view.holdings?.length) parts.push(`持仓 ${view.holdings.map((h) => `${h.name}×${h.num}`).join('、')}`);
  }
  if (view.targetCityId) parts.push(`下一站 城市 ${view.targetCityId}`);
  return parts.join(' · ');
}

// 这一轮真的赚了多少：从 TradeSellResponse.player 里读服务端算的 profit（不信自己的估算）。
export function summarizeTrade(results = []) {
  let soldNum = 0;
  let soldProfit = 0;
  let boughtNum = 0;
  let boughtCost = 0;
  let profit = null;
  let coins = null;
  let speedUsed = 0;
  for (const entry of results) {
    if (!entry?.ok) continue;
    const kind = entry.step?.kind;
    if (kind === 'tradeSell') {
      const items = entry.step.items ?? [];
      soldNum += items.reduce((s, [, n]) => s + (Number(n) || 0), 0);
    }
    if (kind === 'tradeBuy') {
      const items = entry.step.items ?? [];
      boughtNum += items.reduce((s, [, n]) => s + (Number(n) || 0), 0);
      boughtCost += Number(entry.step.spent ?? 0);
    }
    if (kind === 'tradeSpeed') speedUsed += Number(entry.step.body?.useNum ?? 0);
    const player = entry.body?.player;
    if (player) {
      profit = Number(player.profit ?? profit ?? 0);
      coins = Number(player.coins ?? coins ?? 0);
    }
  }
  return { soldNum, soldProfit, boughtNum, boughtCost, profit, coins, speedUsed };
}

export function formatTradeGain(gain) {
  if (!gain) return '';
  const parts = [];
  if (gain.soldNum) parts.push(`卖 ${gain.soldNum} 件`);
  if (gain.boughtNum) parts.push(`买 ${gain.boughtNum} 件/花费 ${gain.boughtCost}`);
  if (gain.speedUsed) parts.push(`指针 ×${gain.speedUsed}`);
  if (gain.profit != null) parts.push(`累计利润 ${gain.profit}`);
  return parts.length > 0 ? `海商王 ${parts.join('，')}` : '';
}

// 学习表：每个港口挂哪些货（只有停靠过才知道）。紧缺货每天变，但「挂哪些货」按实测是稳定的，
// 所以按 period 存一份就够，跨天复用。读取失败一律当空表（不能因为一个坏了的小文件停挂机）。
export function mergeLearned(learned, { period, cityId, shelf }) {
  const base = learned && typeof learned === 'object' ? learned : { cities: {} };
  const cities = { ...(base.cities ?? {}) };
  if (period && cityId && Array.isArray(shelf) && shelf.length > 0) {
    const ids = shelf.map((row) => Number(row.goodsId)).filter(Boolean).sort((a, b) => a - b);
    cities[String(cityId)] = ids;
  }
  return { ...base, period, cities };
}
