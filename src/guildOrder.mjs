// 联盟订单（GuildOrder）：每天 0 点刷新一单，交齐 3 种物品换公会经验 + 功勋（外加联盟城市兵力）。
//
// 事实来源（配置 + 真实回包 + 反编译客户端三方核对，没有推测）：
// - `GuildOrderRequest {}` → `GuildOrderResponse { order: { requirements: [{type,id,num}], nextRefreshTime } }`
//   实测 2026-10-28 09:28：日用品 4 / 海藻汁 6 / 木板 3，nextRefreshTime = 次日 00:00。
//   **订单里没有数量上下限配置**（GuildOrderCfg 只有 itemId/guildExp/reward），数量由服务端随机。
// - `FinishGuildOrderRequest { cityId }` → `FinishGuildOrderResponse { reward }`。
//   客户端 `_onBtnFinishGuildOrder` 就是 `L("FinishGuildOrderRequest",{cityId:this._cityData.cityId})` ——
//   **请求体只有 cityId 一个必填字段，没有物品清单、没有货币、没有钻石**；服务端按当前订单的
//   requirements 直接从仓库扣。所以「交单要不要额外资源」的答案是不要。
//   交单前客户端会 `isAssetsEnough(orderList)`，不够就引导你去买（`buyProducts`）—— 我们不买，
//   直接跳过并把缺什么写进 notes。
// - cityId 来自「联盟城市驻军」弹窗里的城市数据 → 这里取 `GuildCityInfoResponse.cities[]`：
//   优先 `recommended: true` 的那个，没有就取第一个。
// - 次数上限：`GuildOrderNumCfg` 按 (season, playerLevel) 给 maxNum，**-1 = 不限**。
//   今天交了几次看 `CounterInfoResponse.counters[type='DAILY_FINISH_GUILD_ORDER'].num`
//   （客户端 `_onBtnFinishGuildOrder` 用同一个计数器判上限）。赛季号协议里拿不到，
//   所以按「所有 playerLevel ≤ 我的等级」的行取**最宽松**的 maxNum：只要有一行是 -1 就不限。
// - 奖励：`GuildOrderCfg` 里按物品给 (guildExp, 功勋)；实际到手看 `FinishGuildOrderResponse.reward`。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount } from './world.mjs';

// 计数器里「今日已完成联盟订单」的 type。
export const GUILD_ORDER_COUNTER = 'DAILY_FINISH_GUILD_ORDER';

// 当前订单缺什么：返回 [{ id, need, have, lack }]，lack 全 0 表示交得起。
export function guildOrderLack(requirements, stock) {
  return requirements.map((req) => {
    const have = Number(stock?.get?.(req.id) ?? 0) || 0;
    return { id: req.id, need: req.num, have, lack: Math.max(0, req.num - have) };
  });
}

// 今天还能交几单：maxNum < 0 → 不限（返回 Infinity）；否则 maxNum - 今天已交。
export function orderQuota(maxNum, doneToday) {
  const max = Number(maxNum);
  if (!Number.isFinite(max) || max < 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, max - (Number(doneToday) || 0));
}

// 今天的次数上限。传了 playerLevel 就只看「够得着的档位」，取最宽松的一档：
// 赛季号拿不到，宁可放松也不能把自己误判成「交够了」而不交。
export function maxOrderPerDay(config, playerLevel = 0) {
  const rows = rowsOf(config, 'GuildOrderNumCfg');
  const reachable = rows.filter((row) => Number(row?.playerLevel) <= Math.max(0, Number(playerLevel) || 0));
  const pool = (reachable.length > 0 ? reachable : rows).map((row) => Number(row?.maxNum));
  if (pool.length === 0) return -1;
  const finite = pool.filter((n) => Number.isFinite(n) && n >= 0);
  if (pool.some((n) => !Number.isFinite(n) || n < 0)) return -1;
  return finite.length > 0 ? Math.max(...finite) : -1;
}

export async function surveyGuildOrder(client, protocol, {
  config = null,
  stock = null,
  player = null,
  timeout = 8000,
} = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, {}, responseName, timeout));
    } catch {
      return null;
    }
  };

  const [orderRes, cityRes, counterRes] = await Promise.all([
    get('GuildOrderRequest'),
    get('GuildCityInfoRequest'),
    get('CounterInfoRequest'),
  ]);
  if (!orderRes) throw new Error('拿不到 GuildOrderResponse，读不了联盟订单');

  const order = orderRes.order ?? {};
  const requirements = (order.requirements ?? [])
    .map((req) => ({ type: Number(req?.type) || 0, id: req?.id ?? '', num: assetCount(req?.num) }))
    .filter((req) => req.id && req.num > 0);

  const cities = (cityRes?.cities ?? []).map((city) => ({
    cityId: Number(city?.cityId) || 0,
    recommended: city?.recommended === true,
    defenceNum: Number(city?.defenceNum) || 0,
  }));
  const city = cities.find((c) => c.recommended) ?? cities[0] ?? null;

  const counters = (counterRes?.counters ?? []).map((c) => ({ type: c?.type ?? '', num: assetCount(c?.num) }));
  const doneToday = counters.find((c) => c.type === GUILD_ORDER_COUNTER)?.num ?? 0;

  const playerLevel = Number(player?.level ?? player?.playerLevel ?? 0) || 0;

  return {
    requirements,
    nextRefreshTime: Number(order.nextRefreshTime) || 0,
    city,
    cities,
    doneToday,
    maxNum: config ? maxOrderPerDay(config, playerLevel) : -1,
    quota: orderQuota(config ? maxOrderPerDay(config, playerLevel) : -1, doneToday),
    stock: stock ?? null,
  };
}

// 一份「能不能交、缺什么」的视图。纯函数，页面和循环共用同一个口径。
export function viewGuildOrder(survey) {
  const lack = guildOrderLack(survey.requirements, survey.stock);
  const missing = lack.filter((row) => row.lack > 0);
  return {
    requirements: lack,
    missing,
    canFinish: survey.requirements.length > 0 && missing.length === 0 && Boolean(survey.city),
    cityId: survey.city?.cityId ?? 0,
    cities: survey.cities ?? [],
    doneToday: survey.doneToday ?? 0,
    maxNum: survey.maxNum ?? -1,
    quota: survey.quota ?? 0,
    nextRefreshTime: survey.nextRefreshTime ?? 0,
  };
}

export function planGuildOrder(view, { config = null } = {}) {
  const actions = [];
  const notes = [];
  if (view.requirements.length === 0) {
    notes.push('今天没有联盟订单（可能已交完，等 00:00 刷新）');
    return { actions, notes };
  }
  if (view.quota <= 0) {
    notes.push(`今日联盟订单已交 ${view.doneToday} 单（上限 ${view.maxNum}），等 00:00 刷新`);
    return { actions, notes };
  }
  if (!view.cityId) {
    notes.push('没读到联盟城市（GuildCityInfo 为空），交单需要 cityId，跳过');
    return { actions, notes };
  }
  if (!view.canFinish) {
    const short = view.missing.map((row) => `${row.id} ${row.have}/${row.need}`).join(' ');
    notes.push(`订单料不齐（${short}），等工厂补`);
    return { actions, notes };
  }

  // 交单奖励来自 GuildOrderCfg（每种物品一份 guildExp + 功勋），实际到手以回包 reward 为准。
  const rewardText = view.requirements
    .map((row) => {
      const cfg = config ? rowsOf(config, 'GuildOrderCfg').find((r) => r.itemId === row.id) : null;
      return cfg ? `${row.id}(经验${cfg.guildExp}/功勋${cfg.reward?.[1] ?? '?'})` : row.id;
    })
    .join(' ');
  actions.push({
    kind: 'guildOrder',
    request: 'FinishGuildOrderRequest',
    response: 'FinishGuildOrderResponse',
    // **只传 cityId**：没有物品清单、没有货币 —— 服务端按订单要求扣仓库。
    body: { cityId: view.cityId },
    // transient：订单状态是每天一份的瞬时状态，交失败（料刚好被别的段吃掉）不该被永久记住。
    transient: true,
    key: `guildOrder:${view.nextRefreshTime}`,
    items: view.requirements.map((row) => [row.id, row.need]),
    unit: '件',
    label: `交联盟订单（${view.requirements.map((row) => `${row.id}×${row.need}`).join(' ')}）`
      + `${rewardText ? ` → ${rewardText}` : ''}`,
  });
  return { actions, notes };
}

// 一行概览：`城市 49 · 今日 0/不限 · 日用品 4/50 海藻汁 6/47 木板 3/46`
export function formatGuildOrderSummary(view) {
  const quota = view.quota === Number.POSITIVE_INFINITY ? '不限' : view.quota;
  const city = view.cityId ? `城市 ${view.cityId}` : '无城市';
  const items = view.requirements
    .map((row) => `${row.id} ${row.have}/${row.need}`)
    .join(' · ');
  return `${city} · 今日已交 ${view.doneToday}/${view.maxNum < 0 ? '不限' : view.maxNum}`
    + ` · 还能交 ${quota}` + (items ? ` · ${items}` : '');
}
