// 装备工厂（锻造）：收取已经造好的装备 + 按部位均衡排一件新的。
//
// 事实来源（`tools/describe.mjs` + 反编译客户端双重确认，没有推测）：
// - 装备厂就是一座普通水上建筑（`BuildingCfg.buildingType = '装备厂'`），打造状态挂在
//   `DispWaterBuilding.equipMaking = { makeId, equipId, star, finishTime }`。
//   **它没有 `factory` 字段** —— 所以不走 BuildingProduce 那套排产，`planWorld` 完全不碰它。
// - 同一时间只能造一件：客户端点「锻造」先判 `_makeUpLeftSeconds() > 0`，还在造就只弹提示，
//   连排队都不给。所以「造好不收」= 整座工厂停产，不是闲置。
//   实测本账号就这样卡了 21.8 小时（10-24 13:25 造好，14007 条回包一次没变）。
// - 请求：
//   `PickMadeEquipRequest { buildingId }`                 → `PickMadeEquipResponse { equipId }`
//   `MakeEquipRequest { buildingId, makeId, universal }`   → 无 Response，结果靠 `SCUpdateWaterBuilding` 推送
//   `SpeedMakeEquipRequest { buildingId, speedUp }`        → **花钻石加速，本项目永不使用**
//   `universal` 是客户端的 `_isAutoExchange`（材料不够时自动兑换），我们恒发 false。
// - 配方 `BuildingEquipMakeCfg`：makeId 1xxx/2xxx/3xxx = 武器/防具/饰品，末位 1..4 = 蓝/紫/橙/红；
//   `costItem` 是 `[[id, num]]` 对子（GOLD 也在里面 —— `surveyWorld` 已经把资源合进 stock）；
//   红装标 `season: 2`：赛季号在协议里拿不到（没有哪条状态消息带 season 字段），
//   所以按材料筛 —— 红材料要 800 个，攒够之前根本不会去试；真攒够了但赛季没开，
//   服务端会拒一次，日志里能看到（`transient` 不会把它记住）。
// - 排产策略：英雄每个部位只能穿一件，所以「可分配库存」必须按部位成套 —— 哪一类少就补哪一类。
//   件数 = 背包 + 打造中（已穿在英雄身上的不算：那是「已在用」，不是「可分配」）。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, makeTypeResolver, RESOURCE_NAMES } from './world.mjs';

// 三个部位。顺序就是「件数相同时先造哪个」的固定轮转顺序。
export const EQUIP_TYPES = ['武器', '防具', '饰品'];

// 装备厂的建筑类型名（BuildingCfg.buildingType）。
export const FORGE_TYPE = '装备厂';

// 剩余时间只要给人看个量级，不需要 loop 里那种「1 小时 3 分」的精确格式。
function remainText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

function parseCost(row) {
  return (row?.costItem ?? [])
    .filter((pair) => Array.isArray(pair) && pair.length >= 2 && pair[0])
    .map(([id, num]) => ({ id, num: Number(num) || 0 }));
}

// 配方 → { 品质, 可能产出的装备 }。libId 指向 EquipMakeLibCfg，一个配方给 2 种装备（rate 都 100），
// 具体出哪个由服务端定（打造中的 equipMaking.equipId 里已经写死了）。
function describeRecipe(config, row) {
  const libs = rowsOf(config, 'EquipMakeLibCfg').filter((lib) => Number(lib?.libId) === Number(row?.libId));
  const equips = libs
    .map((lib) => rowsOf(config, 'EquipCfg').find((equip) => equip.id === lib.equipId))
    .filter(Boolean);
  return {
    makeId: Number(row?.makeId) || 0,
    type: row?.type ?? '',
    // 原时长。真正生效的还要减「锻造时间」委任（AppointPosCfg posId 13/14/15），
    // 但排产不需要算它 —— 造没造好以服务端给的 finishTime 为准。
    seconds: Number(row?.seconds) || 0,
    season: Number(row?.season) || 1,
    cost: parseCost(row),
    qualityIndex: Number(equips[0]?.qualityIndex) || 0,
    qualityName: equips[0]?.qualityName ?? '',
    equipIds: equips.map((equip) => equip.id),
  };
}

// 按「背包 + 打造中」给每个部位数件数。已穿在英雄身上的不算。
export function countByType(equipIndex, bag, making = null) {
  const counts = Object.fromEntries(EQUIP_TYPES.map((type) => [type, 0]));
  for (const entry of bag ?? []) {
    const type = equipIndex.get(entry.equipId)?.type;
    if (type in counts) counts[type] += 1;
  }
  const makingType = making?.equipId ? equipIndex.get(making.equipId)?.type : null;
  if (makingType && makingType in counts) counts[makingType] += 1;
  return counts;
}

// 下一件造什么：件数最少的部位优先；同件数按 EQUIP_TYPES 的顺序轮转
// （Array#sort 在 V8 里是稳定的，所以同数时保持原顺序）；部位内先试品质最高的，
// 材料不够就降级 —— 所以「紫材料攒够 160」时会自动改造紫装，不用改代码。
export function pickRecipe(config, counts, stock) {
  const recipes = rowsOf(config, 'BuildingEquipMakeCfg').map((row) => describeRecipe(config, row));
  const order = EQUIP_TYPES.slice().sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0));
  for (const type of order) {
    const usable = recipes
      .filter((recipe) => recipe.type === type)
      .filter((recipe) => recipe.cost.every((item) => (stock.get(item.id) ?? 0) >= item.num))
      .sort((a, b) => b.qualityIndex - a.qualityIndex);
    if (usable.length > 0) return usable[0];
  }
  return null;
}

// 只读探测：装备厂 + 打造中 + 背包 + 材料。循环里 world 那一轮已经拉过海面和库存，
// 传 stock / buildings 进来就只多一个 EquipsRequest。
export async function surveyEquip(client, protocol, {
  config = null,
  stock = null,
  buildings = null,
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

  const needWater = !buildings;
  const [water, itemList, resourceList, equipsRaw] = await Promise.all([
    needWater ? get('OnWaterRequest') : Promise.resolve(null),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
    stock ? Promise.resolve(null) : get('AllResourceRequest'),
    get('EquipsRequest'),
  ]);
  if (!equipsRaw && !water) throw new Error('拿不到 EquipsResponse，读不了装备背包');

  const bagStock = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bagStock.set(id, (bagStock.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
    // GOLD 这类资源不在 AllItemResponse 里，跟 surveyWorld 一样合并成一张表，
    // 否则 costItem 里的 ["GOLD", 2000] 永远判成不够。
    for (const entry of resourceList?.list ?? []) {
      const id = RESOURCE_NAMES[entry.res] ?? String(entry.res);
      bagStock.set(id, (bagStock.get(id) ?? 0) + assetCount(entry.amount));
    }
  }

  const resolveType = makeTypeResolver(config);
  const list = buildings ?? (water?.building ?? []).map((raw) => {
    const item = normalize(raw);
    return {
      buildingId: item.buildingId,
      level: Number(item.level) || 0,
      type: resolveType(item.buildingId),
      equipMaking: item.equipMaking && Number(item.equipMaking.makeId) > 0
        ? {
            makeId: Number(item.equipMaking.makeId) || 0,
            equipId: item.equipMaking.equipId || '',
            star: Number(item.equipMaking.star) || 0,
            finishTime: Number(item.equipMaking.finishTime) || 0,
          }
        : null,
    };
  });
  const forge = list.find((entry) => entry.type === FORGE_TYPE) ?? null;

  const now = Math.floor(Date.now() / 1000);
  const rawMaking = forge?.equipMaking ?? null;
  const making = rawMaking
    ? {
        makeId: rawMaking.makeId,
        equipId: rawMaking.equipId,
        star: rawMaking.star,
        finishTime: rawMaking.finishTime,
        remainSeconds: Math.max(0, rawMaking.finishTime - now),
        // finishTime 缺省（0）时按「已造好」处理：收一下不会有损失，漏收才会停产。
        done: rawMaking.finishTime <= now,
      }
    : null;

  const equipIndex = new Map(rowsOf(config, 'EquipCfg').map((equip) => [equip.id, equip]));
  const bag = (equipsRaw?.equip ?? []).map((entry) => {
    const cfg = equipIndex.get(entry.equipId);
    return {
      uid: entry.uid,
      equipId: entry.equipId,
      type: cfg?.type ?? '',
      qualityIndex: Number(cfg?.qualityIndex) || 0,
      qualityName: cfg?.qualityName ?? '',
      level: Number(entry.level) || 0,
      star: Number(entry.star) || 0,
    };
  });

  return {
    now,
    building: forge ? { buildingId: forge.buildingId, level: Number(forge.level) || 0 } : null,
    making,
    bag,
    counts: countByType(equipIndex, bag, making),
    stock: bagStock,
    config,
  };
}

function equipName(making) {
  return making.equipId || `makeId ${making.makeId}`;
}

// 计划：造好了就收，收完（工厂空了）排下一件。一轮最多一个收取 + 一个排产。
export function planEquip(survey, { config = null } = {}) {
  const config_ = config ?? survey.config ?? null;
  const actions = [];
  const notes = [];
  if (!survey.building) {
    notes.push('没有装备厂（BuildingCfg 里叫「装备厂」），这轮不锻造');
    return { actions, notes };
  }

  const { buildingId, level } = survey.building;
  const making = survey.making;
  // 收取和排产放同一个失败隔离组：收取失败（背包满 / 状态还没同步）时别再硬排一件，
  // 否则两条必然一起失败，日志里全是噪音。runWorld 的 group 只停本组，不影响别的动作。
  const group = `equip:forge:${buildingId}`;

  if (making && !making.done) {
    notes.push(`「${equipName(making)}」还在锻造，还剩 ${remainText(making.remainSeconds)}`
      + `（同一时间只能造一件，等它好了再排下一件）`);
    return { actions, notes };
  }

  if (making && making.done) {
    actions.push({
      kind: 'equipPick',
      request: 'PickMadeEquipRequest',
      response: 'PickMadeEquipResponse',
      body: { buildingId },
      // key 带上批次（makeId + finishTime）：换了一批就是新 key，不会被上一批的失败记录挡住。
      key: `equipPick:${buildingId}:${making.makeId}:${making.finishTime}`,
      group,
      transient: true,
      // 收的是哪一件（equipId 是服务端写死的，准确）。
      items: [[equipName(making), 1]],
      label: `收取已锻好的「${equipName(making)}」${making.star ? `（${making.star} 星）` : ''}`,
    });
  }

  const recipe = pickRecipe(config_, survey.counts, survey.stock);
  if (!recipe) {
    const detail = EQUIP_TYPES.map((type) => `${type} ${survey.counts[type] ?? 0}`).join(' / ');
    notes.push(`没有哪个部位的材料够造下一件（现有 ${detail}）`);
    return { actions, notes };
  }

  const costText = recipe.cost.map((item) => `${item.id}×${item.num}`).join(' + ');
  actions.push({
    kind: 'equipMake',
    request: 'MakeEquipRequest',
    response: null,
    body: { buildingId, makeId: recipe.makeId, universal: false },
    key: `equipMake:${buildingId}`,
    group,
    transient: true,
    // 一个配方可能出 2 件具体装备（服务端定），所以这里只用「品质+部位」，
    // 不假装知道确切 id —— 下一轮 equipMaking.equipId 出来后才知道。
    items: [[`${recipe.qualityName}${recipe.type}` || `makeId ${recipe.makeId}`, 1]],
    label: `锻造「${recipe.equipIds.join('/') || `${recipe.type}${recipe.makeId}`}」`
      + `（${recipe.qualityName}${recipe.type}，现在 ${survey.counts[recipe.type] ?? 0} 件）`
      + `· 耗 ${costText}`,
  });
  notes.push(`装备厂 lv${level}，按部位最少优先：${
    EQUIP_TYPES.map((type) => `${type} ${survey.counts[type] ?? 0}`).join(' / ')}`);
  return { actions, notes };
}

// 循环日志里的一行概览（跟情报的 summary 一个用法）。
export function formatEquipSummary(survey) {
  const counts = EQUIP_TYPES.map((type) => `${type} ${survey.counts[type] ?? 0}`).join('/');
  if (!survey.building) return '没有装备厂';
  const making = survey.making;
  const state = making
    ? (making.done ? `「${equipName(making)}」已造好待收取` : `打造中「${equipName(making)}」还剩 ${remainText(making.remainSeconds)}`)
    : '工厂空闲';
  return `${survey.building.buildingId} lv${survey.building.level} · ${state} · ${counts}`;
}

export function formatEquipPlan(survey, plan) {
  const lines = [formatEquipSummary(survey)];
  for (const action of plan?.actions ?? []) lines.push(`动作 ${action.label}`);
  for (const note of plan?.notes ?? []) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
