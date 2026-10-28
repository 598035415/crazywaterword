// 海盗讨伐（世界地图）：派空闲舰队**真出战**打地图上的海盗。
//
// 事实来源（协议表 + 反编译客户端 `SelectTroopPop` / `WarPirateModel` / `PirateAutoModel`）：
//
// - 请求 `ChallengePirateRequest { uid:int32, fleetBuildingIds:[string], cityId:int32 }`。
//   客户端出战面板 `case _.Pirate:` 就是 `new ChallengePirateRequest({uid, fleetBuildingIds, cityId})`。
//   ⚠️ **协议表里没有 `ChallengePirateResponse`** → 只能 `sendWatch`，回包若是 `PromptResponse` 即被拒。
//   ⚠️ 旧笔记里写的 `PirateFightRequest` 这个名字**不存在**（协议表和客户端都没有）。
//
// - 地图海盗 `AllPirateResponse.pirates[]` = `Pirate{uid,type,level,gridIdx,cityId}`，type 1/2/3 = 先锋/精锐/头目。
//   注意 `Pirate` **没有 state 字段**（不像雷达事件），所以「这个海盗是不是已经在被我打」只能靠舰队状态判断：
//   船派出去后 state 变 MOVING，下一轮就不在空闲列表里了。
//   `sweepTimes` 是**免战扫荡**的余量（`PirateParamCfg.每日野怪扫荡次数` = 10），跟真出战无关，
//   别拿它当「今天还能打几次」—— 那是 `dailies.mjs` 1010 那条任务的事。
//
// - 击杀进度 `PirateKillRecordResponse.records[{type,maxKilledLevel}]`：每种 type 已击杀的最高等级。
//   客户端的自动讨伐就是「从 maxKilledLevel+1 往上找」，我们照抄这个口径：**默认只打没打过的等级**
//   （首杀有 firstKillReward + firstKillEquip，重复打只剩 fixedReward）。要刷重复等级得显式开 repeat。
//
// - 成本 `WorldParamCfg.打野怪消耗汽油` = 300/次，`打野怪消耗耐久` = **0**（打海盗不掉耐久）。
//   收益 `WorldPirateCfg`：`firstKillReward` + `firstKillEquip`（首杀）+ `fixedReward`（每次）。
//   注意这两组参数在 `WorldParamCfg`，**不在** `PirateParamCfg`（后者只有一行「每日野怪扫荡次数」）。
//
// - 敌方战力 `WorldPirateCfg` **必须按 (season,type,level) 三元组查**：表里 1650 行 =
//   3 type × season 1~10 × level 1~50/80，同 type 同 level 有 10 个赛季版本，战力能差 40 倍
//   （type1 Lv8：S1 = 551000 / S2 = 1830000 / S10 = 9530000）。
//   只按 type+level `find` 会永远命中 season 1 那一行 → 严重低估 → 派出打不过的船白烧汽油。
//   赛季从 `player.worldId` 算：`Math.floor(worldId / 1e6 % 1000)`（客户端 `WorldIdRule.getSeason`）。
//
// 边界：只在战力够的时候派（输赢虽然都不掉耐久，但白烧 300 汽油）；
// 不碰免战扫荡（`PirateSweepRequest`，那是 dailies 1010 的活）；不做「合服世界禁讨伐时段」判断
// （客户端 `isUniteWorldsForbidTime()` 依赖合服计划数据，我们拿不到 —— 服务端会拒，被拒的动作记 rejected 即可）。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, fleetDuraOk, fleetDuraPct } from './world.mjs';

// 三种海盗类型。配置表里 showName 是「海盗先锋/精锐/头目」，但表可能缺行，所以留一份兜底文案。
export const PIRATE_TYPES = [1, 2, 3];
const PIRATE_TYPE_TEXT = { 1: '海盗先锋', 2: '海盗精锐', 3: '海盗头目' };

// 汽油单价的兜底值（配置里「打野怪消耗汽油」读不到时用，实测 300）。
export const FALLBACK_PETROL_COST = 300;

const FLEET_STATE_TEXT = { 1: '空闲', 2: '航行中', 3: '战斗中', 4: '修理中', 5: '排队中' };

function paramValue(rows, name) {
  const row = (rows ?? []).find((entry) => entry?.paramName === name);
  const value = Number(row?.paramValue);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// 单次讨伐的汽油消耗（WorldParamCfg「打野怪消耗汽油」）。
export function petrolCostOf(config) {
  return paramValue(rowsOf(config, 'WorldParamCfg'), '打野怪消耗汽油') || FALLBACK_PETROL_COST;
}

// 当前赛季：worldId 的编码规则 `Math.floor(worldId / 1e6 % 1000)`。
// 拿不到（CLI 没传 player）就是 0 —— 后面查战力会退回「该 type 的第一行赛季」，并在 view 里标出
// seasonExact=false，让日志能说清「赛季未知，战力按 S1 估的」。
export function seasonOf(player) {
  const worldId = Number(player?.worldId) || 0;
  return worldId > 0 ? Math.floor((worldId / 1e6) % 1000) : 0;
}

// 战力查表。返回 { power, season, exact, name, row } —— **查不到返回 null**（= 配置过期）。
// 不能退化成 0：0 战力会让「需要战力」变成 0，等于闭着眼派船。
export function pirateOf(config, { season = 0, type, level } = {}) {
  const rows = rowsOf(config, 'WorldPirateCfg')
    .filter((row) => Number(row?.type) === Number(type) && Number(row?.level) === Number(level));
  if (rows.length === 0) return null;
  const exact = rows.find((row) => String(row?.season) === String(season)) ?? null;
  // 赛季未知（CLI 没登录态拿 worldId）或表里没有该赛季时：取**所有赛季里的最大战力**。
  // 不能退回 rows[0]（那是 S1，全场最低）—— 低估战力会派出打不过的船，白烧 300 汽油；
  // 高估只会「这轮不派」，代价小得多。
  const row = exact ?? rows.reduce((max, one) => ((Number(one.power) || 0) > (Number(max.power) || 0) ? one : max), rows[0]);
  return {
    power: Number(row.power) || 0,
    season: String(row.season ?? ''),
    exact: Boolean(exact),
    name: String(row.showName ?? '') || (PIRATE_TYPE_TEXT[type] ?? `海盗 ${type}`),
    row,
  };
}

// 该 (赛季, 类型) 下配置里的最高等级：超过它就不可能再有新等级（客户端的 maxPirateLevel）。
export function maxLevelOf(config, { season = 0, type } = {}) {
  const rows = rowsOf(config, 'WorldPirateCfg').filter((row) => Number(row?.type) === Number(type));
  const ofSeason = rows.filter((row) => String(row?.season) === String(season));
  const pool = ofSeason.length > 0 ? ofSeason : rows;
  return pool.reduce((max, row) => Math.max(max, Number(row.level) || 0), 0);
}

// 奖励摘要（首杀三件套 + 每次固定掉落）。配置里 reward 是 `[[id, num], …]` 对子。
function pairsToAssets(pairs) {
  return (pairs ?? [])
    .filter((pair) => Array.isArray(pair) && pair.length >= 2 && pair[0])
    .map(([id, num]) => ({ id, num: Number(num) || 0 }))
    .filter((asset) => asset.num > 0);
}

function rewardOf(info) {
  const row = info?.row ?? {};
  const first = pairsToAssets(row.firstKillReward);
  const fixed = pairsToAssets(row.fixedReward);
  const equip = row.firstKillEquip ? String(row.firstKillEquip) : '';
  return { first, fixed, equip, score: first.length + fixed.length + (equip ? 1 : 0) };
}

function formatReward(reward, limit = 3) {
  const list = (reward ?? []).slice(0, limit).map((asset) => `${asset.id}×${asset.num}`);
  const rest = (reward ?? []).length - list.length;
  return list.join('、') + (rest > 0 ? ` 等 ${(reward ?? []).length} 项` : '');
}

// 战力文案：8.42万 / 1.83亿 —— 海盗战力跨 4 个数量级，直接印数字在日志里读不出来。
export function powerText(value) {
  const n = Number(value) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(Math.round(n));
}

// 只读探测：海盗列表 + 舰队 + 击杀进度（+ 库存，循环里由 world 段复用传入）。
// `stock` 传了就不再拉 AllItemRequest —— 汽油数量从它里面取（key 是物品中文名「汽油」）。
export async function surveyPirates(client, protocol, {
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

  const [all, fleetList, record, itemList] = await Promise.all([
    get('AllPirateRequest'),
    get('MyFleetsRequest'),
    get('PirateKillRecordRequest'),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
  ]);
  if (!all) throw new Error('拿不到 AllPirateResponse，读不了世界海盗');

  const bag = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bag.set(id, (bag.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
  }

  // uid 是 int32（不是 int64），normalize 之后就是普通数字，不需要 uidKey 那套转换。
  const pirates = (all.pirates ?? [])
    .map((raw) => ({
      uid: Number(raw?.uid) || 0,
      type: Number(raw?.type) || 0,
      level: Number(raw?.level) || 0,
      gridIdx: Number(raw?.gridIdx) || 0,
      cityId: Number(raw?.cityId) || 0,
    }))
    // 缺 uid / type / level 的条目直接丢掉：发出去只会白烧汽油。
    .filter((pirate) => pirate.uid > 0 && pirate.type > 0 && pirate.level > 0);

  return {
    now: Math.floor(Date.now() / 1000),
    season: seasonOf(player),
    petrol: bag.get('汽油') ?? 0,
    stock: bag,
    // 免战扫荡余量：**只用于显示**，真出战不看它（见文件头）。
    sweepTimes: Math.max(0, Math.floor(Number(all.sweepTimes) || 0)),
    pirates,
    killed: new Map((record?.records ?? [])
      .map((row) => [Number(row?.type) || 0, Number(row?.maxKilledLevel) || 0])
      .filter(([type]) => type > 0)),
    fleets: (fleetList?.fleets ?? []).map((fleet) => ({
      buildingId: fleet.buildingId,
      state: Number(fleet.state) || 0,
      power: assetCount(fleet.power),
      durability: assetCount(fleet.durability),
      maxDurability: assetCount(fleet.maxDura) || 0,
    })),
    config,
  };
}

// 视图：把「每种 type 打到第几级、地图上有没有下一级、哪艘船打得过」算成一张表。
// repeat=false（默认）时只认「未击杀的下一个等级」—— 照客户端自动讨伐的口径；
// repeat=true 才把地图上已通关的等级也算进候选（只拿 fixedReward）。
export function viewPirates(survey, {
  config = null,
  minPowerRatio = 1.2,
  repeat = false,
  // 耐久闸（比例）：低于它的船不出战。打野怪本身「消耗耐久 = 0」（WorldParamCfg），
  // 但耐久 <1600 会「降低输出、增加受到的伤害」（LoadingTipsCfg），
  // 也就是更容易打输、白烧 300 汽油 —— 所以先修再打更划算。0 = 不拦（旧行为）。
  duraFloor = 0,
} = {}) {
  const cfg = config ?? survey.config ?? null;
  const season = Number(survey.season) || 0;
  const ratio = Number(minPowerRatio) > 0 ? Number(minPowerRatio) : 1.2;
  const fleets = survey.fleets ?? [];
  const idleAll = fleets.filter((fleet) => fleet.state === 1);
  // 耐久不够的留在港里（由情报段统一修）：它们不参与战力评估，否则会算出「能打」却没人去。
  const groundedFleets = (Number(duraFloor) > 0 ? idleAll.filter((fleet) => !fleetDuraOk(fleet, duraFloor)) : [])
    .map((fleet) => ({ ...fleet, duraPct: fleetDuraPct(fleet) }));
  const idle = idleAll
    .filter((fleet) => !groundedFleets.some((one) => one.buildingId === fleet.buildingId))
    .slice()
    .sort((a, b) => b.power - a.power);
  // 舰队战力取「最强的那艘空闲船」：派兵是一艘一艘派的，`powerNeeded` 的判定同理。
  const bestPower = idle.reduce((max, fleet) => Math.max(max, fleet.power), 0);
  const petrol = Number(survey.petrol) || 0;
  const petrolCost = petrolCostOf(cfg);
  const targets = [];
  let seasonExact = true;

  const types = PIRATE_TYPES.map((type) => {
    const killedLevel = Number(survey.killed?.get(type)) || 0;
    const maxLevel = maxLevelOf(cfg, { season, type });
    const nextLevel = killedLevel + 1;
    const onMap = (survey.pirates ?? []).filter((pirate) => pirate.type === type);

    // 每个地图上的海盗都算一遍战力（含赛季是否精确命中）。
    const rows = onMap.map((pirate) => {
      const info = pirateOf(cfg, { season, type, level: pirate.level });
      if (info && !info.exact) seasonExact = false;
      const power = info?.power ?? 0;
      const powerNeeded = power > 0 ? Math.ceil(power * ratio) : 0;
      const reward = rewardOf(info);
      return {
        ...pirate,
        name: info?.name ?? (PIRATE_TYPE_TEXT[type] ?? `海盗 ${type}`),
        power,
        powerNeeded,
        powerUnknown: info == null,
        season: info?.season ?? '',
        seasonExact: info?.exact ?? false,
        firstReward: reward.first,
        fixedReward: reward.fixed,
        firstEquip: reward.equip,
        rewardScore: reward.score,
        firstKill: pirate.level === nextLevel,
      };
    });

    // 首选：地图上正好有「下一个未击杀等级」（有首杀奖励）。
    const primary = rows.filter((row) => row.level === nextLevel);
    // 已到该赛季上限：再往上没有配置了，这个 type 就结束了。
    const maxed = maxLevel > 0 && killedLevel >= maxLevel;
    // 备选（只有 repeat 才用）：地图上任一战力达标的已通关等级。
    const others = repeat ? rows.filter((row) => row.level !== nextLevel) : [];

    // 同一个 (type, level) 的首杀目标**只留一个**：一轮里两艘船同时去打两个 Lv8，
    // 第一单打完击杀记录就升到 8 了，第二单只剩 fixedReward —— 等于白烧 300 汽油。
    // 剩下的船宁可闲着，下一轮它要打的就是 Lv9 了。
    const claimed = new Set();
    for (const row of primary) {
      if (claimed.has(row.type)) continue;
      claimed.add(row.type);
      targets.push(row);
    }
    for (const row of others) targets.push(row);

    let reason = '';
    if (maxed) reason = `已打到赛季上限 Lv${maxLevel}`;
    else if (rows.length === 0) reason = '地图上没有这类型的海盗';
    else if (primary.length === 0) {
      const levels = [...new Set(rows.map((row) => row.level))].sort((a, b) => b - a);
      reason = `地图上没有 Lv${nextLevel}（只有 Lv${levels.slice(0, 3).join('/Lv')}），已通关的等级不重复打`;
    }

    return {
      type,
      name: PIRATE_TYPE_TEXT[type] ?? `海盗 ${type}`,
      killedLevel,
      nextLevel,
      maxLevel,
      maxed,
      onMapCount: rows.length,
      onMapLevels: [...new Set(rows.map((row) => row.level))].sort((a, b) => b - a),
      targets: primary.length + others.length,
      // 能达到的最高可打等级（只是展示，实际配对在 plan 里按船算）。
      topFits: rows.filter((row) => row.power > 0 && bestPower >= row.powerNeeded)
        .map((row) => row.level)
        .sort((a, b) => b - a),
      reason,
    };
  });

  // 排序：首杀优先 → 等级高的优先（战力高的奖励好） → type 小的。
  targets.sort((a, b) => (Number(b.firstKill) - Number(a.firstKill))
    || (b.level - a.level) || (a.type - b.type));

  return {
    now: survey.now,
    season,
    seasonExact,
    petrol,
    petrolCost,
    sweepTimes: survey.sweepTimes,
    minPowerRatio: ratio,
    repeat,
    fleets: fleets.map((fleet) => ({
      ...fleet,
      stateText: FLEET_STATE_TEXT[fleet.state] ?? `状态 ${fleet.state}`,
      duraPct: fleetDuraPct(fleet),
    })),
    idleFleets: idle.map((fleet) => ({
      ...fleet,
      stateText: FLEET_STATE_TEXT[fleet.state] ?? `状态 ${fleet.state}`,
      duraPct: fleetDuraPct(fleet),
    })),
    // 因为耐久不够被留下的空闲船（由情报段修）。
    groundedFleets,
    duraFloor: Number(duraFloor) > 0 ? Math.min(1, Number(duraFloor)) : 0,
    bestIdlePower: bestPower,
    types,
    targets,
  };
}

// 计划：一船一海盗，最强的那艘先挑。
// 三个上限都要守：船数、汽油、maxPerRound（页面「一次最多派几艘」，默认不限）。
// 汽油按「这次要烧的量」累计判断 —— 只判一次会让 2 艘船派出去后才发现只够 1 次的油。
export function planPirates(view, { maxPerRound = Infinity } = {}) {
  const actions = [];
  const notes = [];
  const cap = Number.isFinite(Number(maxPerRound)) ? Math.max(0, Number(maxPerRound)) : Infinity;
  const cost = Math.max(1, Number(view.petrolCost) || FALLBACK_PETROL_COST);

  if (view.targets.length === 0) {
    for (const type of view.types) {
      if (type.reason) notes.push(`${type.name}：${type.reason}`);
    }
    return { actions, notes };
  }
  if (view.idleFleets.length === 0) {
    const grounded = view.groundedFleets ?? [];
    if (grounded.length > 0) {
      // 全被耐久闸留下：这是新增的一层，必须说清楚，否则看着像「开关没生效」。
      notes.push(`${grounded.length} 艘空闲船耐久低于 ${Math.round((Number(view.duraFloor) || 0) * 100)}%，`
        + `先去修再出战：${grounded.map((fleet) => `${fleet.buildingId}(${Math.round((fleet.duraPct ?? 0) * 100)}%)`).join('、')}`);
    } else {
      notes.push(`没有空闲舰队（${view.fleets.map((fleet) => `${fleet.buildingId}=${fleet.stateText}`).join(' ') || '一艘都没有'}）`);
    }
    return { actions, notes };
  }
  if (view.petrol < cost) {
    notes.push(`汽油只有 ${view.petrol}，打一次要 ${cost}`);
    return { actions, notes };
  }

  const taken = new Set();
  const left = [];
  for (const fleet of view.idleFleets) {
    if (taken.size >= cap) break;
    if (view.petrol < cost * (taken.size + 1)) {
      notes.push(`汽油只够打 ${taken.size} 次（剩 ${view.petrol}，每次 ${cost}）`);
      break;
    }
    const target = view.targets.find((one) => !taken.has(one.uid)
      && !one.powerUnknown
      && fleet.power >= one.powerNeeded);
    if (!target) {
      left.push(fleet);
      continue;
    }
    taken.add(target.uid);
    const rewardTail = target.firstKill
      ? `首杀 ${formatReward(target.firstReward)}${target.firstEquip ? `+${target.firstEquip}` : ''}`
      : `固定 ${formatReward(target.fixedReward)}`;
    actions.push({
      kind: 'pirateChallenge',
      request: 'ChallengePirateRequest',
      // 协议表里没有 ChallengePirateResponse：失败靠 sendWatch 抓 PromptResponse。
      response: null,
      body: {
        uid: target.uid,
        fleetBuildingIds: [fleet.buildingId],
        cityId: target.cityId,
      },
      // uid 天然唯一；派兵失败多是「刚被别人打掉 / 船不在港 / 合服禁讨伐」这类瞬时状态，
      // 记进 rejected 会让这个点永远不再尝试，所以标 transient。
      key: `pirateChallenge:${target.uid}`,
      // 按船分隔离组：一条被拒只停这艘船，别的船照派。
      group: `pirateChallenge:${fleet.buildingId}`,
      transient: true,
      label: `派 ${fleet.buildingId}（战力 ${powerText(fleet.power)}）打 ${target.name} Lv${target.level}`
        + `（敌方 ${powerText(target.power)}，${view.minPowerRatio}× 余量 = ${powerText(target.powerNeeded)}），${rewardTail}`,
    });
  }

  if (actions.length === 0) {
    const top = view.targets.reduce((max, one) => Math.max(max, one.powerNeeded), 0);
    notes.push(`能打的海盗至少需要 ${powerText(top)} 战力，最强空闲船只有 ${powerText(view.bestIdlePower)}`);
  } else {
    const rest = view.targets.filter((one) => !taken.has(one.uid));
    if (rest.length > 0 && left.length > 0) {
      // 还有没派出去的海盗，船却闲着 = 战力不够（不是「没目标了」）。
      const need = Math.max(...rest.map((one) => one.powerNeeded));
      notes.push(`${left.length} 艘空闲船战力不够：剩下 ${rest.length} 个海盗最高需要 ${powerText(need)}，`
        + `最弱空闲船只有 ${powerText(left[left.length - 1].power)}`);
    } else if (rest.length === 0 && left.length > 0) {
      notes.push(`${left.length} 艘空闲船没派：能打的海盗都派出去了（每艘船同时只能打一个点）`);
    }
  }
  // 被跳过的 type 原因也说一句，否则「为什么头目不打了」只能靠猜。
  for (const type of view.types) {
    if (type.reason && type.targets === 0) notes.push(`${type.name}：${type.reason}`);
  }
  return { actions, notes };
}

// 一行概览：日志与网页共用。
export function formatPirateSummary(view) {
  const head = `S${view.season || '?'}${view.seasonExact ? '' : '（赛季未知，战力取各赛季最高，偏保守）'}`
    + ` · 汽油 ${view.petrol}（每次 ${view.petrolCost}）`
    + ` · 空闲船 ${view.idleFleets.length}/${view.fleets.length}（最强 ${powerText(view.bestIdlePower)}）`
    // 被耐久闸留下的船单独标出来：否则「空闲船 0/2」看着像船都在航行。
    + ((view.groundedFleets ?? []).length > 0 ? ` · 耐久<${Math.round((Number(view.duraFloor) || 0) * 100)}% ${view.groundedFleets.length} 艘待修` : '');
  const progress = view.types.map((type) => `${type.name.replace('海盗', '')} ${type.killedLevel}`).join(' / ');
  return `${head} · 击杀 ${progress}`;
}

export function formatPiratePlan(view, plan) {
  const lines = [formatPirateSummary(view)];
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of plan.notes) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
