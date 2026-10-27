// 贸易港口（建筑 buildingType「货轮港口」，UI 名「贸易港口」，resPath buildingTrade/TradePort）。
//
// 玩法（游戏内说明原文，2026-10-26 截图核对）：
//   「港口最多停靠 3 艘货船，每艘贸易货船会采购 4 种物品。供货完成时即可获得一定
//    【玩家经验】和【金币】奖励。货船采购完全部物品后就会出发，并在一段时间后返回。
//    返回时会随机带回 4 份贸易奖励（藏品大师徽章 / 稀有·史诗·传说藏品经验 / 藏品碎片）。」
//
// 也就是三件事：① 逐格交货（拿 EXP+GOLD） ② 交满 4 格 → 船出发（arriveTime） ③ 到点领 4 份奖励。
// 一套全是免费动作 —— 不花钻石、不花加速器，物品就是工厂/农田产出的常规货。
//
// 事实来源（协议 + 实探 + 客户端反编译三处对齐）：
// - CargoShipsRequest {} -> CargoShipsResponse { ship: DispCargoShip[] }
//   DispCargoShip = { index, status, orderItem: DispCargoOrderItem[], arriveTime, reward: DisplayAsset[] }
//     index      = 船号（1..3）
//     status     = CargoShipStatus：0 IN_ORDER（采购中）/ 1 TRANSPORTING（航行中）/ 2 ARRIVED（已返回可领）
//     orderItem  = 4 个采购槽，每槽 { asset:{type,id,num}, filled:bool, reward:DisplayAssetPackage }
//                  asset.id 是中文物品名（"铜锭"/"淡水"），asset.num 是 int64
//     arriveTime = **秒级**时间戳（不是毫秒！实探 1793046699 vs now 1793027208）。
//                  采购中为 0；航行中是未来；已返回是过去。
//     reward     = 返航奖励池（4 条），到点领奖时按它结算
// - FillCargoShipRequest { shipIndex:int32, cargoIndex:repeated int32 } -> FillCargoShipResponse { reward }
//   cargoIndex 是**从 1 开始的槽位号**（客户端 `for(e=0..3) if(!filled) t.push(e+1)` 逐字如此），
//   一条请求可以带多个槽位 —— 这就是界面上那个「全部交货」按钮。
//   响应 reward 是这一批交货拿到的 EXP/GOLD。
// - DrawShipRewardRequest { index:int32 } -> DrawShipRewardResponse { reward, ship }
//   只有 status === ARRIVED 时才发（客户端 `_onBtnBonus` 的判据），领完 ship 变回采购中。
// - SpeedUpShipRequest { index, speedUp:SpeedUpCostParam } —— 花加速器缩短返航，默认**不做**。
// - 推送 SCUpdateShip { ship }：交货 / 领奖后服务端会主动推新的船状态。
//
// 判据不看 status 数字，统一按 arriveTime 推（更抗版本变化，且实探三种状态各自唯一）：
//   arriveTime === 0            → 采购中（可交货）
//   arriveTime * 1000 > now     → 航行中
//   arriveTime * 1000 <= now    → 已返回（可领奖）
// status 只用来**交叉校验**：万一哪天服务端语义变了，日志里能看出对不上。
//
// 库存不够的槽位只提示不等待 —— 缺的物品由工厂/农田慢慢补，下一轮探测自然又够了。
// 不给缺料槽位买货（客户端会调 buyProducts 用钻石补，本工具不这么做）。

import { assetCount, RESOURCE_NAMES } from './world.mjs';

// CargoShipStatus（客户端枚举，实探反推：采购中 0 / 航行中 1 / 已返回 2）。
export const CARGO_STATUS = { IN_ORDER: 0, TRANSPORTING: 1, ARRIVED: 2 };
export const CARGO_STATUS_TEXT = { 0: '采购中', 1: '航行中', 2: '已返回' };

// 一艘船的采购槽位数（游戏内说明「每艘贸易货船会采购 4 种物品」）。
export const CARGO_SLOTS = 4;

// arriveTime 是秒，别的模块都是毫秒。这里集中转一次，免得各处 Math.floor(now/1000) 写错。
export function secondsOf(ms) {
  return Math.floor(Number(ms) / 1000);
}

// 只读探测：3 艘货船的状态。stock 由调用方传入（循环里复用海面那一段的库存表），
// 传不进来时退化成「只看订单、不判库存」——此时 fillable 恒为空，不会误发交货请求。
export async function surveyCargo(client, protocol, { stock = null, timeout = 8000 } = {}) {
  const response = await client.request('CargoShipsRequest', {}, 'CargoShipsResponse', timeout);
  return {
    ships: Array.isArray(response?.ship) ? response.ship : [],
    stock,
    now: Date.now(),
  };
}

// 单独跑（网页「立刻交一次货」/ CLI）时自己拉库存：循环里是复用海面那一段的，
// 这里两个只读请求换来一份独立可用的库存表。资源（GOLD 之类）也并进来 ——
// 贸易采购的都是道具，但合并口径跟 world.mjs 保持一致，将来加资源型采购不会漏。
export async function fetchStock(client, protocol, { timeout = 8000 } = {}) {
  const [itemList, resList] = await Promise.all([
    client.request('AllItemRequest', {}, 'AllItemResponse', timeout),
    client.request('AllResourceRequest', {}, 'AllResourceResponse', timeout).catch(() => null),
  ]);
  const stock = new Map();
  for (const item of itemList?.items ?? []) {
    const id = item.itemId ?? item.id;
    if (!id) continue;
    stock.set(id, (stock.get(id) ?? 0) + assetCount(item.num ?? item.count));
  }
  for (const entry of resList?.list ?? []) {
    const id = RESOURCE_NAMES[entry.res] ?? String(entry.res);
    stock.set(id, (stock.get(id) ?? 0) + assetCount(entry.amount));
  }
  return stock;
}

// 把协议原始结构摊平成「页面/日志能直接用」的形状。纯函数，单测可以喂合成数据。
export function viewCargo(survey, { now = null } = {}) {
  const nowMs = Number(now ?? survey?.now ?? Date.now());
  const nowSec = secondsOf(nowMs);
  const stock = survey?.stock ?? new Map();
  const have = (id) => Number(stock.get(id) ?? 0);

  const ships = (survey?.ships ?? []).map((raw) => {
    const arriveTime = Number(raw.arriveTime ?? 0) || 0;
    const phase = arriveTime === 0
      ? 'order'
      : (arriveTime > nowSec ? 'sailing' : 'arrived');
    // 交叉校验：arriveTime 推出的阶段与 status 对不上时留一条线索（不影响决策）。
    const expectedStatus = phase === 'order'
      ? CARGO_STATUS.IN_ORDER
      : (phase === 'sailing' ? CARGO_STATUS.TRANSPORTING : CARGO_STATUS.ARRIVED);
    const slots = (raw.orderItem ?? []).map((item, i) => {
      const id = item?.asset?.id ?? '';
      const num = assetCount(item?.asset?.num);
      return {
        // cargoIndex 是 1-based，和下发的请求体直接对齐。
        slot: i + 1,
        id,
        num,
        filled: Boolean(item?.filled),
        have: have(id),
        reward: (item?.reward?.asset ?? []).map((a) => ({ id: a.id, num: assetCount(a.num) })),
      };
    });
    return {
      index: Number(raw.index ?? 0) || 0,
      status: Number(raw.status ?? 0) || 0,
      statusText: CARGO_STATUS_TEXT[Number(raw.status ?? 0)] ?? `未知(${raw.status})`,
      statusMismatch: expectedStatus !== Number(raw.status ?? 0),
      phase,
      arriveTime,
      // 航行中 = 还要等多久；已返回 = 0；采购中 = null。
      leftSeconds: phase === 'sailing' ? Math.max(0, arriveTime - nowSec) : 0,
      slots,
      filledCount: slots.filter((s) => s.filled).length,
      // 采购中、还没交、库存够 → 这一轮真的能交的槽位。
      fillable: phase === 'order' ? slots.filter((s) => !s.filled && s.have >= s.num) : [],
      // 采购中、还没交、库存不够 → 只报缺口，不买货。
      short: phase === 'order'
        ? slots.filter((s) => !s.filled && s.have < s.num).map((s) => ({ ...s, lack: s.num - s.have }))
        : [],
      claimable: phase === 'arrived',
      reward: (raw.reward ?? []).map((a) => ({ id: a.id, num: assetCount(a.num) })),
    };
  });

  const by = (phase) => ships.filter((s) => s.phase === phase);
  const sailing = by('sailing');
  const nextArrive = sailing.length > 0
    ? sailing.reduce((min, s) => (s.arriveTime < min ? s.arriveTime : min), sailing[0].arriveTime)
    : 0;
  return {
    now: nowSec,
    // 原样带一份库存进来：planCargo 要按船号顺序扣减（同一件物品可能被多艘船同时采购）。
    stock,
    stockSize: stock.size,
    ships,
    order: by('order'),
    sailing,
    arrived: by('arrived'),
    // 最近一艘什么时候回来（秒级时间戳 / 剩余秒数），日志用它说「还要等多久」。
    nextArriveAt: nextArrive,
    nextArriveLeftSeconds: nextArrive > nowSec ? nextArrive - nowSec : 0,
    mismatch: ships.filter((s) => s.statusMismatch).map((s) => s.index),
  };
}

// 给「不经过自动循环」的调用方（网页海面页 / CLI `world`）用：现探测一次货船，把缺口算成排产需求。
// 失败就回空表 —— 海面那一段不能因为「贸易港口探测不到」而整段失败，
// 但也不能因此就把货船需求漏掉（那样手动执行和挂机的排产结果会不一样）。
export async function safeCargoDemand(client, protocol, { stock = null } = {}) {
  try {
    return cargoDemandOf(viewCargo(await surveyCargo(client, protocol, { stock })));
  } catch {
    return new Map();
  }
}

const pairText = (pairs) => (pairs ?? []).map((p) => `${p.id}×${p.num}`).join(' ');

// 货船缺口 → 工厂排产需求（Map<itemId, 数量>）。
//
// 只算**采购中**的船：航行中的船不采购，给它补货纯属占仓库。已交的格子当然也不算。
// 缺口 = num - have，取 max(0)：库存够的格子不产生需求（不然工厂会照着上限一直产）。
//
// 为什么需要这个：工厂排产以前只认**居民订单缺口**（planWorld 里的 demand），
// 于是「货船要鱼皮风筝×2、仓库只有 1、服装厂却在拿空位产别的」这种局面会一直僵着 ——
// 物品不够 → 交不了货 → 船不走 → 港口白占。把缺口并进 demand 后，工厂会优先产它。
export function cargoDemandOf(view) {
  const demand = new Map();
  for (const ship of view?.order ?? []) {
    for (const slot of ship.slots) {
      if (slot.filled) continue;
      const lack = Math.max(0, Number(slot.num) - Number(slot.have));
      if (lack > 0) demand.set(slot.id, (demand.get(slot.id) ?? 0) + lack);
    }
  }
  return demand;
}

// 纯计划：到点的船领奖，采购中的船把「库存够的槽位」一次性交掉（= 界面上的全部交货）。
//
// 同一件物品可能被多艘船同时采购（实探：1 号和 2 号船都要淡水×4），所以按船号顺序
// 边交边扣 —— 拿探测时的库存当绝对量会超卖，第二条必被服务端拒（和 world.mjs 里
// 「同类型多座建筑抢同一批材料」是同一个坑）。
export function planCargo(view, { maxShips = Infinity } = {}) {
  const actions = [];
  const notes = [];
  const left = new Map(view?.stock ? [...view.stock].map(([id, n]) => [id, Number(n) || 0]) : []);
  // stock 传不进来时 view.stock 为 null，此时不判库存（fillable 已经为空，这里只是兜底）。
  const unknownStock = !view?.stock;
  const take = (id, num) => {
    if (unknownStock) return true;
    const current = left.get(id) ?? 0;
    if (current < num) return false;
    left.set(id, current - num);
    return true;
  };

  const cap = Number.isFinite(Number(maxShips)) ? Math.max(1, Math.floor(Number(maxShips))) : Infinity;
  let handled = 0;

  // 先领奖：领完船才回到采购中，这一轮不再对它发交货（服务端状态还没变）。
  for (const ship of view?.arrived ?? []) {
    if (handled >= cap) { notes.push(`货船#${ship.index} 本轮额度用完，下一轮再领`); continue; }
    handled += 1;
    actions.push({
      kind: 'cargoReward',
      request: 'DrawShipRewardRequest',
      response: 'DrawShipRewardResponse',
      body: { index: ship.index },
      // 显式 key：stepKey 会取 body.index，这里语义清楚点，也方便 selftest 断。
      key: `cargoReward:${ship.index}`,
      // 领奖失败多半是「刚被别处领走了」，下一轮再试是安全的。
      transient: true,
      label: `领贸易奖励 货船#${ship.index}（返航 ${ship.reward.length} 份）`,
    });
  }

  for (const ship of view?.order ?? []) {
    if (handled >= cap) { notes.push(`货船#${ship.index} 本轮额度用完，下一轮再交`); continue; }
    const cargoIndex = [];
    const items = [];
    for (const slot of ship.slots) {
      if (slot.filled) continue;
      if (!take(slot.id, slot.num)) continue;
      cargoIndex.push(slot.slot);
      items.push([slot.id, slot.num]);
    }
    if (cargoIndex.length === 0) {
      const lack = ship.short.map((s) => `${s.id} ${s.have}/${s.num}（缺 ${s.lack}）`).join('，');
      notes.push(`货船#${ship.index} 攒料中：${lack || '4 格都已交'}`);
      continue;
    }
    handled += 1;
    actions.push({
      kind: 'cargoFill',
      request: 'FillCargoShipRequest',
      response: 'FillCargoShipResponse',
      body: { shipIndex: ship.index, cargoIndex },
      key: `cargoFill:${ship.index}`,
      // 交货失败多是瞬时状态（槽位刚被别处交掉 / 船刚好出发），重试安全。
      transient: true,
      // 一条船失败只停这条船剩下的动作，不影响另外两艘。
      group: `cargo:${ship.index}`,
      items,
      label: `交货 货船#${ship.index} ${cargoIndex.length}/${CARGO_SLOTS} 格（${pairText(items.map(([id, num]) => ({ id, num })))}）`,
    });
    const skipped = ship.slots.filter((s) => !s.filled && !cargoIndex.includes(s.slot));
    if (skipped.length > 0) {
      notes.push(`货船#${ship.index} 有 ${skipped.length} 格没库存（${skipped.map((s) => `${s.id} ${s.have}/${s.num}`).join('，')}），等工厂补料`);
    }
  }

  for (const ship of view?.sailing ?? []) {
    notes.push(`货船#${ship.index} 航行中，${Math.ceil(ship.leftSeconds / 60)} 分钟后返回`);
  }

  return { actions, notes };
}

// 一轮概览：货船总数 + 三种状态各几艘 + 最近返航时间。
export function formatCargoSummary(view) {
  const total = view?.ships?.length ?? 0;
  if (total === 0) return '没有货船（贸易港口未建成或没解锁船位）';
  const parts = [
    `采购中 ${view.order.length}`,
    `航行中 ${view.sailing.length}`,
    `可领 ${view.arrived.length}`,
  ];
  let text = `货船 ${total} 艘（${parts.join(' / ')}）`;
  if (view.nextArriveLeftSeconds > 0) {
    const m = Math.ceil(view.nextArriveLeftSeconds / 60);
    text += ` · 最近一艘 ${m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分`}后返回`;
  }
  if (view.mismatch.length > 0) {
    // 服务端换了 status 语义时唯一的线索，别让它静默。
    text += ` · 状态与 arriveTime 对不上：${view.mismatch.join(',')}`;
  }
  return text;
}

// 统计这一轮真的到手的收益（交货拿 EXP/GOLD，领奖拿藏品类奖励）。只读 results，不发请求。
export function summarizeCargo(results = []) {
  const gained = new Map();
  const add = (assets) => {
    for (const a of assets ?? []) {
      const num = assetCount(a?.num);
      if (!num) continue;
      gained.set(a.id, (gained.get(a.id) ?? 0) + num);
    }
  };
  for (const entry of results) {
    if (!entry?.ok) continue;
    if (entry.step?.kind === 'cargoFill') add(entry.body?.reward?.asset);
    if (entry.step?.kind === 'cargoReward') add(entry.body?.reward?.asset);
  }
  return [...gained].map(([id, num]) => ({ id, num }));
}

export function formatCargoGain(gained) {
  if (!gained || gained.length === 0) return '';
  return `贸易收益 ${gained.map((g) => `${g.id}×${g.num}`).join(' ')}`;
}
