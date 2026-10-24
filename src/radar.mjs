// 联盟情报（RADAR_VIEW）：读事件列表 + 舰队战力，算出「哪些能打、派哪艘、先领哪些奖」。
//
// 事实来源（全部来自客户端调用点与配置表，没有推测）：
// - RadarInfoResponse.radarInfo = { events[], level, exp, storedNum, nextRefreshTime }
//   events[] = { uid, eventId, color, gridIdx, reward:{asset[]}, pirate?:{type,level},
//                refugee?:{requirements[]}, createTime, state }
//   注意 uid 是 protobuf int64，normalize 之前是 {low,high}，直接当 Map key / JSON 会出错。
// - RadarEventState：1 INIT（可派兵）/ 2 LOCKED（被别人占了）/ 3 START（我方舰队在打）/ 4 FINISHED（可领奖）。
// - FleetState：1 IDLE / 2 MOVING / 3 BATTLING / 4 REPAIRING / 5 QUEUING —— 只有 IDLE 能派。
// - 敌方战力在 WorldPirateCfg：按 (season, type, level) 查 power。type 1/2/3 = 海盗先锋/精锐/头目。
// - RadarRandEventCfg 给事件类型与文案（eventId 10001+）；RadarFixedEventCfg 是固定事件（eventId < 10000，
//   自己带 power 与 reward）。
//
// 请求（tools/describe.mjs 确认字段）：
//   RadarSendFleetsRequest { uid: int64, fleetBuildingIds: repeated string }  ← fixed 事件不带 uid
//   RadarGetRewardRequest  { uid: int64 }       按事件领
//   RadarGetAllRewardsRequest {}                一键全领（空体）
//   派兵要消耗汽油（客户端 paramValue('情报事件消耗汽油') × 舰队数），本模块只读时不校验。
//
// 边界：只做「派舰队打情报事件 + 领奖」，不做世界地图上的占田/掠夺（那需要舰队且属于 PvP）。
// 战败会掉舰船耐久（修船要资源），所以派兵前必须按战力留足余量，见 minPowerRatio。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, paramOf } from './world.mjs';

// 派兵的最低战力比：舰队战力 ≥ 敌方战力 × 这个系数才派。
// 1.0 = 刚好打平就上（拿耐久赌）；1.2 是保守值，战损小。
export const DEFAULT_MIN_POWER_RATIO = 1.2;

const EVENT_STATE_TEXT = { 1: '可派兵', 2: '被占', 3: '进行中', 4: '可领奖' };
const FLEET_STATE_TEXT = { 1: '空闲', 2: '航行中', 3: '战斗中', 4: '修理中', 5: '排队中' };

// int64 可能是数字，也可能是 {low, high} —— 统一成同一个十进制字符串 key。
// 必须用和 client.mjs toNumber 一样的换算（high × 2^32 + (low >>> 0)），
// 否则同一个事件在两种形状下会得到两个 key，去重/回填就会失效。
export function uidKey(uid) {
  if (uid == null) return '';
  if (typeof uid === 'object') {
    const high = Number(uid.high ?? 0);
    const low = Number(uid.low ?? 0);
    return String(high * 4294967296 + (low >>> 0));
  }
  return String(uid);
}

// 回包里的 uid 已经过 normalize：小 uid 是数字，超大整数才会留 {low, high} 形状。
// 两种都直接回传 —— 实测 RadarSendFleetsRequest 用数字和 {low, high} 编码出的字节完全一致
// （1.4e14 这个量级远低于 2^53，数值精确），所以不需要在两边来回转换。
function rawUid(uid) {
  if (uid && typeof uid === 'object') {
    return { low: Number(uid.low ?? 0), high: Number(uid.high ?? 0), unsigned: Boolean(uid.unsigned) };
  }
  return uid;
}

export async function surveyRadar(client, protocol, { config = null, stock = null, timeout = 8000 } = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, {}, responseName, timeout));
    } catch {
      return null;
    }
  };

  // 汽油在仓库里。循环模式下 world 那一轮已经拉过 AllItem，传 stock 进来就不用再拉一遍。
  const [radar, fleetList, itemList] = await Promise.all([
    get('RadarInfoRequest'),
    get('MyFleetsRequest'),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
  ]);
  if (!radar?.radarInfo) throw new Error('拿不到 RadarInfoResponse，读不了联盟情报');

  const bag = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bag.set(id, (bag.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
  }

  const info = radar.radarInfo;
  return {
    now: Math.floor(Date.now() / 1000),
    level: Number(info.level) || 0,
    exp: Number(info.exp) || 0,
    storedNum: Number(info.storedNum) || 0,
    nextRefreshTime: Number(info.nextRefreshTime) || 0,
    petrol: bag.get('汽油') ?? 0,
    stock: bag,
    events: (info.events ?? []).map((raw) => ({
      uid: rawUid(raw.uid),
      // 固定事件（isFixed）没有 uid，多个固定事件的 key 会一起退化成空串 ——
      // 那样「同一事件不派两次」的去重和 stepKey 都会失效，所以用 eventId+格位兜底。
      key: uidKey(raw.uid) || `fixed:${Number(raw.eventId) || 0}:${Number(raw.gridIdx) || 0}`,
      eventId: Number(raw.eventId) || 0,
      color: Number(raw.color) || 0,
      gridIdx: Number(raw.gridIdx) || 0,
      state: Number(raw.state) || 0,
      createTime: Number(raw.createTime) || 0,
      pirate: raw.pirate ? { type: Number(raw.pirate.type) || 0, level: Number(raw.pirate.level) || 0 } : null,
      refugee: raw.refugee
        ? { requirements: (raw.refugee.requirements ?? []).map((r) => ({ id: r.id, num: assetCount(r.num) })) }
        : null,
      // 固定事件（RadarFixedEventCfg）不带 uid 派兵，且自带 power —— 用 eventId 区间区分。
      fixed: Number(raw.eventId) < 10000,
      reward: (raw.reward?.asset ?? []).map((asset) => ({ id: asset.id, num: assetCount(asset.num) })),
    })),
    fleets: (fleetList?.fleets ?? []).map((fleet) => ({
      buildingId: fleet.buildingId,
      state: Number(fleet.state) || 0,
      power: assetCount(fleet.power),
      durability: assetCount(fleet.durability),
      maxDurability: assetCount(fleet.maxDura) || 0,
      autoFight: fleet.autoFight?.isOn === true,
      todayFightTimes: Number(fleet.autoFight?.todayTimes) || 0,
    })),
    config,
  };
}

// 敌方战力：海盗查 WorldPirateCfg；固定事件查 RadarFixedEventCfg；其它事件没有战斗。
function enemyPowerOf(config, event) {
  if (event.pirate) {
    const row = rowsOf(config, 'WorldPirateCfg')
      .find((r) => Number(r?.type) === event.pirate.type && Number(r?.level) === event.pirate.level);
    return Number(row?.power) || 0;
  }
  if (event.fixed) {
    const row = rowsOf(config, 'RadarFixedEventCfg').find((r) => Number(r?.eventId) === event.eventId);
    return Number(row?.power) || 0;
  }
  return 0; // 打捞宝箱 / 救助海兽 / 收集资源 / 解救难民：无战力要求
}

// 事件名与类型：随机事件表给「击退{0}」这类模板，固定事件表给具体名字。
function describeEvent(config, event) {
  const rand = rowsOf(config, 'RadarRandEventCfg').find((r) => Number(r?.eventId) === event.eventId);
  if (rand) {
    const params = rand.eventNameParams ?? [];
    const name = String(rand.eventName ?? '').replace(/\{(\d+)\}/g, (_, i) => params[Number(i)] ?? '');
    return { name: name || rand.type || `事件 ${event.eventId}`, type: rand.type ?? '' };
  }
  const fixed = rowsOf(config, 'RadarFixedEventCfg').find((r) => Number(r?.eventId) === event.eventId);
  if (fixed) {
    const params = fixed.eventNameParams ?? [];
    const name = String(fixed.eventName ?? '').replace(/\{(\d+)\}/g, (_, i) => params[Number(i)] ?? '');
    return { name: name || `固定事件 ${event.eventId}`, type: '固定事件' };
  }
  return { name: `事件 ${event.eventId}`, type: '' };
}

// 奖励摘要：按「件数」粗排，够用来比大小，不做价格折算（配置里没有售价）。
function rewardScore(reward) {
  return (reward ?? []).reduce((sum, asset) => sum + (Number(asset.num) || 0), 0);
}

function formatReward(reward, limit = 3) {
  const list = (reward ?? []).slice(0, limit).map((asset) => `${asset.id}×${asset.num}`);
  const rest = (reward ?? []).length - list.length;
  return list.join('、') + (rest > 0 ? ` 等 ${(reward ?? []).length} 项` : '');
}

// 视图：每个事件标出「能不能打、敌方多少战力、值不值得」。
export function viewRadar(survey, { config = null, minPowerRatio = DEFAULT_MIN_POWER_RATIO } = {}) {
  const config_ = config ?? survey.config ?? null;
  const fleets = survey.fleets ?? [];
  const idle = fleets.filter((fleet) => fleet.state === 1);
  // 舰队战力取「最强的那艘空闲船」—— 派兵是按 buildingId 一艘一艘派的。
  const bestPower = idle.reduce((max, fleet) => Math.max(max, fleet.power), 0);

  const events = (survey.events ?? []).map((event) => {
    const meta = describeEvent(config_, event);
    const power = enemyPowerOf(config_, event);
    const need = Math.ceil(power * (Number(minPowerRatio) || 1));
    const fits = need === 0 || bestPower >= need;
    return {
      ...event,
      name: meta.name,
      type: meta.type,
      stateText: EVENT_STATE_TEXT[event.state] ?? `状态 ${event.state}`,
      enemyPower: power,
      powerNeeded: need,
      fits,
      rewardScore: rewardScore(event.reward),
      rewardText: formatReward(event.reward),
      // 能不能派：事件可派 + 战力够 + 难民事件材料齐。
      dispatchable: event.state === 1 && fits
        && (!event.refugee || event.refugee.requirements.every((need_) => (survey.stock?.get(need_.id) ?? 0) >= need_.num)),
    };
  });

  return {
    now: survey.now,
    level: survey.level,
    exp: survey.exp,
    storedNum: survey.storedNum,
    nextRefreshTime: survey.nextRefreshTime,
    petrol: survey.petrol,
    minPowerRatio,
    idleFleets: idle.map((fleet) => ({ ...fleet, stateText: FLEET_STATE_TEXT[fleet.state] ?? String(fleet.state) })),
    fleets: fleets.map((fleet) => ({ ...fleet, stateText: FLEET_STATE_TEXT[fleet.state] ?? String(fleet.state) })),
    bestIdlePower: bestPower,
    events,
    // 待领奖的事件（state=4）不占舰队，先领掉最省事。
    rewards: events.filter((event) => event.state === 4),
  };
}

// 计划：先领奖（一条 RadarGetAllRewardsRequest 全领），再把**每一艘空闲船各派一个事件**。
// 一艘船同一时刻只能打一个点，所以船数就是并发上限；同一事件不会被派两次。
// maxDispatch 是「最多派几艘」的上限（默认 Infinity = 有多少空闲船就派多少）。
export function planRadar(view, {
  maxDispatch = Infinity,
  minPowerRatio = DEFAULT_MIN_POWER_RATIO,
} = {}) {
  const actions = [];
  const notes = [];

  if (view.rewards.length > 0) {
    actions.push({
      kind: 'radarReward',
      request: 'RadarGetAllRewardsRequest',
      response: null,
      body: {},
      // 一键全领是幂等的一天一次动作，失败（比如没有可领的）不该被永远记住重试。
      key: 'radarReward:all',
      transient: true,
      label: `领情报奖励 ${view.rewards.length} 个（${view.rewards.map((event) => event.name).join('、')}）`,
    });
  }

  const idle = (view.idleFleets ?? []).slice().sort((a, b) => b.power - a.power);
  if (idle.length === 0) {
    notes.push(`没有空闲舰队（${(view.fleets ?? []).map((fleet) => `${fleet.buildingId}=${fleet.stateText}`).join(' ') || '一艘都没有'}），这轮只领奖`);
    return { actions, notes };
  }

  // 候选：可派 + 战力够。排序优先看颜色（4 紫 > 3 蓝 > 2 绿，客户端用它标事件稀有度），
  // 同色再挑「战力需求高的」（奖励通常跟难度走），最后看奖励件数。
  // 不按奖励件数单独排 —— 带 GOLD 3700 的打捞宝箱会把分数拉得虚高，
  // 结果一艘船天天去捞箱子，海盗一个不打。
  const candidates = view.events
    .filter((event) => event.dispatchable)
    .sort((a, b) => (b.color - a.color) || (b.enemyPower - a.enemyPower) || (b.rewardScore - a.rewardScore));
  const skipped = view.events.filter((event) => event.state === 1 && !event.dispatchable);

  if (candidates.length === 0) {
    if (skipped.length > 0) {
      notes.push(`有 ${skipped.length} 个事件打不了：`
        + skipped.map((event) => `${event.name}(需 ${event.powerNeeded} 战力)`).slice(0, 4).join('、'));
    }
    return { actions, notes };
  }

  // 贪心配对：最强的那艘先挑，所以它能拿优先级最高（通常奖励最好）的事件；
  // 弱船往后顺延挑剩下的。战力不够的事件不硬派 —— 打输会掉耐久，修船要资源。
  const cap = Number.isFinite(Number(maxDispatch)) ? Math.max(0, Number(maxDispatch)) : Infinity;
  const taken = new Set();
  const idleLeft = [];
  for (const fleet of idle) {
    if (taken.size >= cap) break;
    const event = candidates.find((one) => !taken.has(one.key)
      && (one.powerNeeded === 0 || fleet.power >= one.powerNeeded));
    if (!event) {
      idleLeft.push(fleet);
      continue;
    }
    taken.add(event.key);
    actions.push({
      kind: 'radarDispatch',
      request: 'RadarSendFleetsRequest',
      response: null,
      // fixed 事件不带 uid（客户端 isFixed() 分支），普通事件带。
      body: event.fixed
        ? { fleetBuildingIds: [fleet.buildingId] }
        : { uid: event.uid, fleetBuildingIds: [fleet.buildingId] },
      // 事件 uid 天然唯一，拿它当 key；派兵失败多是「被别人抢了 / 船不在港」这类瞬时状态，
      // 记进 rejected 会让这个点永远不再尝试，所以标 transient。
      key: `radarDispatch:${event.key}`,
      // 按船分隔离组：一条被拒只停这艘船，别的船照派（否则一条失败全废）。
      group: `radarDispatch:${fleet.buildingId}`,
      transient: true,
      label: `派 ${fleet.buildingId}（战力 ${fleet.power}）打「${event.name}」`
        + (event.enemyPower > 0 ? `（敌方 ${event.enemyPower}，${minPowerRatio}× 余量 = ${event.powerNeeded}）` : '')
        + `，奖励 ${event.rewardText}`,
    });
  }

  const rest = candidates.length - taken.size;
  if (rest > 0) {
    notes.push(idleLeft.length > 0
      ? `还有 ${rest} 个事件没派：${idleLeft.length} 艘空闲船的战力不够（每艘船同时只能打一个点）`
      : `还有 ${rest} 个能打的事件，空闲船都用完了（每艘船同时只能打一个点）`);
  } else if (idleLeft.length > 0) {
    notes.push(`${idleLeft.length} 艘空闲船没派：剩下的事件它们战力不够`);
  }
  if (skipped.length > 0) {
    notes.push(`${skipped.length} 个事件打不过或材料不齐：`
      + skipped.map((event) => `${event.name}(${event.powerNeeded > 0 ? `需 ${event.powerNeeded}` : '缺材料'})`).slice(0, 4).join('、'));
  }
  return { actions, notes };
}

export function formatRadarPlan(view, plan) {
  const lines = [];
  lines.push(`情报 Lv${view.level}（经验 ${view.exp}）· 存 ${view.storedNum} 个 · 汽油 ${view.petrol}`
    + ` · 舰队 ${view.fleets.length} 艘（空闲 ${view.idleFleets.length}，最强 ${view.bestIdlePower}）`);
  if (view.events.length === 0) {
    // 事件为空不等于出问题：情报池按 nextRefreshTime 才刷（实测隔 6 小时量级），
    // 期间每轮探测都会是 0 个。
    const left = Number(view.nextRefreshTime) > 0 ? Number(view.nextRefreshTime) - Math.floor(Date.now() / 1000) : 0;
    lines.push(`  现在没有事件可打${left > 0 ? `，下次刷新还有 ${Math.round(left / 60)} 分钟` : ''}`);
  }
  for (const event of view.events) {
    const power = event.enemyPower > 0 ? `敌方 ${event.enemyPower}` : '无需战斗';
    const verdict = event.state === 4 ? '待领奖'
      : event.state !== 1 ? event.stateText
        : event.dispatchable ? '可派'
          : event.fits ? '材料不齐' : '战力不够';
    lines.push(`  [${verdict}] ${event.name}  ${power}  ${event.rewardText}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of plan.notes) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
