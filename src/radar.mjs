// 联盟情报（RADAR_VIEW）：读事件列表 + 舰队战力，算出「哪些能打、派哪艘、先领哪些奖」。
//
// 事实来源（全部来自客户端调用点与配置表，没有推测）：
// - RadarInfoResponse.radarInfo = { events[], level, exp, storedNum, nextRefreshTime, fixedEvent? }
//   events[] = { uid, eventId, color, gridIdx, reward:{asset[]}, pirate?:{type,level},
//                refugee?:{requirements[]}, createTime, state }
//   注意 uid 是 protobuf int64，normalize 之前是 {low,high}，直接当 Map key / JSON 会出错。
//
// - **固定事件在第 6 个字段 fixedEvent（单数，一次只有一个），不在 events 里。**
//   客户端的做法（WorldRadarModel._updateRadar）：`var f = [].concat(e.events); if (e.fixedEvent) f.push(e.fixedEvent);`
//   —— 把它追加进同一份列表，再用同一个模型类包装，靠 `eventData instanceof RadarFixedEvent`
//   区分（本地 uid 固定为 RadarUtil.FIXED_UID = 1）。所以「路易斯的行踪」这类固定事件
//   只有读 fixedEvent 才看得见；只遍历 events 会让它永远不出现（实测 10-24 / 10-25 归档里
//   它每一条回包都带着 {eventId:11, gridIdx:93979, state:1}，一次都没被派过）。
//   RadarFixedEvent 只有 { eventId, gridIdx, startTime, createTime, state } ——
//   没有 reward、没有 color、没有 pirate，奖励要回 RadarFixedEventCfg 补。
// - RadarEventState：1 INIT（可派兵）/ 2 LOCKED（被别人占了）/ 3 START（我方舰队在打）/ 4 FINISHED（可领奖）。
// - FleetState：1 IDLE / 2 MOVING / 3 BATTLING / 4 REPAIRING / 5 QUEUING —— 只有 IDLE 能派。
// - 敌方战力在 WorldPirateCfg：按 (season, type, level) 查 power。type 1/2/3 = 海盗先锋/精锐/头目。
// - RadarRandEventCfg 给事件类型与文案（eventId 10001+）；
//   RadarFixedEventCfg 是固定事件（eventId 1-150，自己带 power 与 reward，reward 是
//   `[[id, num], …]` 对子，不是回包里的 `{asset:[{id,num}]}` 形状）。
//
// 请求（tools/describe.mjs + 反编译客户端双重确认）：
//   RadarSendFleetsRequest { uid: int64, fleetBuildingIds: repeated string }
//     —— 固定事件**不带 uid**：客户端 `I.isFixed() ? new RadarSendFleetsRequest({fleetBuildingIds:[g]})
//        : new RadarSendFleetsRequest({uid:I.uid, ...})`（自动派兵与手动面板两处都一样）。
//   RadarGetRewardRequest  { uid: int64 }       按事件领
//   RadarGetAllRewardsRequest {}                一键全领（空体，固定事件也走这条）
//   派兵要消耗汽油（`WorldParamCfg.情报事件消耗汽油` × 舰队数），本模块只读时不校验。
//
// 边界：只做「派舰队打情报事件 + 领奖 + 修船」，不做世界地图上的占田/掠夺（那需要舰队且属于 PvP）。
// 战败会掉舰船耐久（修船要资源），所以派兵前必须按战力留足余量，见 minPowerRatio。
//
// ---- 修船（2026-10-27 加，全部按反编译客户端核对，别凭猜测改）----
//   FleetRepairParamRequest  { buildingId }        -> FleetRepairParamResponse { unitRepairTime, unitRepairCost }
//   RepairFleetRequest       { buildingId }        **无 Response**（协议表里没有 RepairFleetResponse）
//   StopRepairingRequest     { buildingId }        中途停修（本模块不用）
//   客户端两处调用点（FleetUtil.openArmyPop / ArmyPop._onBtnAmend、_onBtnRepair）：
//     · `if (dura != maxDura)` 满耐久不发请求 —— 修是「修满」，请求体里没有数量字段。
//     · `if (fleet.state == FleetState.IDLE)` 才发 —— **航行/战斗中不能修**，这条必须照抄。
//     · 汽油是耐久道具：`GlobalDefine.DURABY_ITEM = "汽油"`。
//       花费 = `Math.ceil((maxDura - dura) * unitRepairCost)`，时长 ≈ `(maxDura - dura) * unitRepairTime` 秒。
//       unitRepairCost / unitRepairTime 都是服务端下发（double），**不能硬编码**（旧注释里的「6 汽油/点」是估的）。
//     · 客户端只拦「持有汽油 < unitRepairCost」（连一个单位都修不起），不拦总量 ——
//       但总量不足时服务端会怎么处理没验证过，所以本模块要求 gasoline 够修满才发，
//       不够就只写 note，别拿一次必败请求去骚扰服务端。
//   fleet.repairing = RepairingData { startTs, endTs, endDura } —— 有它就说明正在修（state=4），不要重复发。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, paramOf } from './world.mjs';

// 派兵的最低战力比：舰队战力 ≥ 敌方战力 × 这个系数才派。
// 1.0 = 刚好打平就上（拿耐久赌）；1.2 是保守值，战损小。
export const DEFAULT_MIN_POWER_RATIO = 1.2;

// 耐久低于这个比例就修（0.8 = 80%）。挂机页/CLI 用百分数（80）配置，到这里统一换成比例。
// <=0 关掉修船，>=1 表示「不满就修」。
export const DEFAULT_REPAIR_BELOW = 0.8;

// 维修消耗的道具名（客户端 GlobalDefine.DURABY_ITEM = "汽油"），和派兵烧的是同一种。
export const DURABY_ITEM = '汽油';

// 修理中的舰队（state=4）不再派兵；这里只用来给「能不能派」一个统一的判定。
const FLEET_STATE_IDLE = 1;
const FLEET_STATE_REPAIRING = 4;

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

// RadarFixedEventCfg.reward 是 `[[id, num], …]` 对子（和 BuildingProduceCfg.costItem 同一种写法）。
// 固定事件的协议回包不带奖励，只能从这里补 —— 不补的话页面上奖励列是空的，
// 计划文案里也会变成「奖励 」，看不出值不值得打。
function fixedRewardOf(config, eventId) {
  const row = rowsOf(config, 'RadarFixedEventCfg').find((r) => Number(r?.eventId) === eventId);
  return (row?.reward ?? [])
    .filter((pair) => Array.isArray(pair) && pair.length >= 2 && pair[0])
    .map(([id, num]) => ({ id, num: Number(num) || 0 }));
}

// 一条事件的归一化。随机事件（events[]）与固定事件（fixedEvent）字段不一样：
// 固定事件没有 uid / color / pirate / reward，但两者共用同一套 state 枚举与派兵流程。
// fromFixed 是「它来自 fixedEvent 字段」这个事实本身，比 eventId 区间更可靠
// （客户端就是按 instanceof 判的），eventId < 10000 只当兜底。
function toEvent(raw, { config = null, fromFixed = false } = {}) {
  const eventId = Number(raw?.eventId) || 0;
  // eventId > 0 的守卫不能省：events[] 里若出现 eventId 缺省的畸形条目（protobuf 默认 0），
  // `0 < 10000` 会把它当成固定事件 —— 而固定事件派兵不带 uid，等于拿一条空数据去打。
  const fixed = fromFixed || (eventId > 0 && eventId < 10000);
  const reward = (raw?.reward?.asset ?? [])
    .map((asset) => ({ id: asset.id, num: assetCount(asset.num) }));
  return {
    uid: rawUid(raw?.uid),
    // 固定事件没有 uid，key 会退化成空串 —— 那样「同一事件不派两次」的去重和 stepKey
    // 都会失效，所以用 eventId + 格位兜底（固定事件一次只有一个，这样就够唯一）。
    key: uidKey(raw?.uid) || `${fixed ? 'fixed' : 'event'}:${eventId}:${Number(raw?.gridIdx) || 0}`,
    eventId,
    color: Number(raw?.color) || 0,
    gridIdx: Number(raw?.gridIdx) || 0,
    state: Number(raw?.state) || 0,
    createTime: Number(raw?.createTime) || 0,
    startTime: Number(raw?.startTime) || 0,
    pirate: raw?.pirate ? { type: Number(raw.pirate.type) || 0, level: Number(raw.pirate.level) || 0 } : null,
    refugee: raw?.refugee
      ? { requirements: (raw.refugee.requirements ?? []).map((r) => ({ id: r.id, num: assetCount(r.num) })) }
      : null,
    fixed,
    // 固定事件优先用回包里的（将来服务端要是补上就不用改），没有才回配置表。
    reward: reward.length > 0 ? reward : (fixed ? fixedRewardOf(config, eventId) : []),
  };
}

// 舰队一条的归一化。repairing 有值 = 正在修（state 一般也是 4），端上来给 viewRadar 判断
// 「已经在修了，别再发 RepairFleetRequest」。
function toFleet(raw) {
  return {
    buildingId: raw?.buildingId ?? '',
    state: Number(raw?.state) || 0,
    power: assetCount(raw?.power),
    durability: assetCount(raw?.durability),
    maxDurability: assetCount(raw?.maxDura) || 0,
    repairing: raw?.repairing
      ? {
        startTs: Number(raw.repairing.startTs) || 0,
        endTs: Number(raw.repairing.endTs) || 0,
        endDura: assetCount(raw.repairing.endDura),
      }
      : null,
    autoFight: raw?.autoFight?.isOn === true,
    todayFightTimes: Number(raw?.autoFight?.todayTimes) || 0,
  };
}

// 缺多少耐久。maxDura 缺失（老回包 / 编造的测试数据）时按 0 处理 = 不修，
// 因为「修满」的目标值就是 maxDura，没有它连花多少汽油都算不出来。
function repairGapOf(fleet) {
  const max = Number(fleet.maxDurability) || 0;
  if (max <= 0) return 0;
  return Math.max(0, max - (Number(fleet.durability) || 0));
}

// 耐久是否低于阈值。below 是比例（0.8）；<=0 关掉修船，>=1 等价于「不满就修」。
function needsRepairOf(fleet, below) {
  const ratio = Number(below);
  if (!(ratio > 0)) return false;
  const gap = repairGapOf(fleet);
  if (gap <= 0) return false;
  const max = Number(fleet.maxDurability) || 0;
  return (Number(fleet.durability) || 0) < max * Math.min(1, ratio);
}

// 现在能不能真发 RepairFleetRequest：耐久低 + 空闲 + 没在修。
// 客户端 _onBtnAmend 有 `state == IDLE` 这条硬判定，航行/战斗中不发 —— 服务端大概率也拒。
function canStartRepair(fleet, below) {
  return needsRepairOf(fleet, below)
    && fleet.state === FLEET_STATE_IDLE
    && !fleet.repairing;
}

export async function surveyRadar(client, protocol, { config = null, stock = null, timeout = 8000, repairBelow = DEFAULT_REPAIR_BELOW } = {}) {
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
  // eventId <= 0 的条目直接丢掉：它连名字和战力都查不到，派出去只会白跑一次。
  const events = (info.events ?? [])
    .map((raw) => toEvent(raw, { config }))
    .filter((event) => event.eventId > 0);
  // 固定事件在第 6 个字段，不在 events 里 —— 客户端也是把它 push 进同一份列表再用。
  // 没有它「路易斯的行踪」这类事件永远不会出现在计划里。
  if (Number(info.fixedEvent?.eventId) > 0) {
    events.push(toEvent(info.fixedEvent, { config, fromFixed: true }));
  }
  // 只给「现在真能修」的船查参数：空闲 + 没在修 + 耐久低于阈值。
  // 每艘一条只读请求，所以必须先筛 —— 否则每轮探测都白多发几条。
  const fleets = (fleetList?.fleets ?? []).map(toFleet);
  const repairParams = new Map();
  const wantRepair = fleets.filter((fleet) => canStartRepair(fleet, repairBelow));
  if (wantRepair.length > 0 && protocol.FleetRepairParamRequest && protocol.FleetRepairParamResponse) {
    await Promise.all(wantRepair.map(async (fleet) => {
      try {
        const params = normalize(await client.request(
          'FleetRepairParamRequest',
          { buildingId: fleet.buildingId },
          'FleetRepairParamResponse',
          timeout,
        ));
        repairParams.set(fleet.buildingId, {
          unitRepairTime: Number(params?.unitRepairTime) || 0,
          unitRepairCost: Number(params?.unitRepairCost) || 0,
        });
      } catch {
        // 拿不到参数 = 这轮不修这艘。修船是附属功能，不能因为它让整段情报探测失败。
      }
    }));
  }

  return {
    now: Math.floor(Date.now() / 1000),
    level: Number(info.level) || 0,
    exp: Number(info.exp) || 0,
    storedNum: Number(info.storedNum) || 0,
    nextRefreshTime: Number(info.nextRefreshTime) || 0,
    petrol: bag.get(DURABY_ITEM) ?? 0,
    stock: bag,
    events,
    fleets,
    // buildingId -> { unitRepairTime, unitRepairCost }（服务端下发，不能硬编码）
    repairParams,
    repairBelow,
    config,
  };
}

// 敌方战力：固定事件查 RadarFixedEventCfg（自己带 power，没有 pirate 字段）；
// 随机事件里的海盗查 WorldPirateCfg；其它事件没有战斗。
function enemyPowerOf(config, event) {
  // 先判 fixed：固定事件本来就没有 pirate，但万一将来带上了，
  // 拿 type/level 去 WorldPirateCfg 查也查不到（那是海盗表），会静默变成 0 战力。
  if (event.fixed) {
    const row = rowsOf(config, 'RadarFixedEventCfg').find((r) => Number(r?.eventId) === event.eventId);
    return Number(row?.power) || 0;
  }
  if (event.pirate) {
    const row = rowsOf(config, 'WorldPirateCfg')
      .find((r) => Number(r?.type) === event.pirate.type && Number(r?.level) === event.pirate.level);
    return Number(row?.power) || 0;
  }
  return 0; // 打捞宝箱 / 救助海兽 / 收集资源 / 解救难民：无战力要求
}

// 事件名与类型：随机事件表给「击退{0}」这类模板，固定事件表给具体名字。
// 固定事件按 event.fixed 先查固定表 —— 两张表的 eventId 区间不重叠（1-150 / 10001+），
// 但先认标记比先认区间更稳（将来服务端把固定事件塞进 events 也不会认错）。
function describeEvent(config, event) {
  const fixed = event.fixed ? rowsOf(config, 'RadarFixedEventCfg').find((r) => Number(r?.eventId) === event.eventId) : null;
  const rand = fixed ? null : rowsOf(config, 'RadarRandEventCfg').find((r) => Number(r?.eventId) === event.eventId);
  const row = fixed ?? rand;
  if (row) {
    const params = row.eventNameParams ?? [];
    const name = String(row.eventName ?? '').replace(/\{(\d+)\}/g, (_, i) => params[Number(i)] ?? '');
    return {
      name: name || (fixed ? `固定事件 ${event.eventId}` : (row.type || `事件 ${event.eventId}`)),
      type: fixed ? '固定事件' : (row.type ?? ''),
    };
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

// 80% -> "80%"。阈值配的是比例，日志/页面一律按百分数说，跟用户输入的口径一致。
function pctText(ratio) {
  return `${Math.round((Number(ratio) || 0) * 1000) / 10}%`;
}

// 耐久 400/2000 = 20%
function duraText(fleet) {
  const max = Number(fleet.maxDurability) || 0;
  const dur = Number(fleet.durability) || 0;
  if (max <= 0) return `${dur}`;
  return `${dur}/${max} = ${Math.round((dur / max) * 100)}%`;
}

// 修理时长（秒）-> 人话。跟 loop.mjs 的 humanDuration 分开写：两个模块互相 import 会成环。
function durationText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total <= 0) return '—';
  if (total < 60) return `${total} 秒`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

// 一个事件「现在能不能派、为什么不能」的唯一判定。
// 之前 formatRadarPlan 和页面各算一套，加了固定事件后已经漂移（页面不认识「已派兵」「配置过期」），
// 所以在这里算一次，两个渲染端都只读 verdict / verdictChip。
// hasIdle = 当前有没有空闲舰队：一艘空闲船都没有时（全在航行/战斗/修理）说「战力不够」是错的 ——
// 实测修船那 5 分钟里日志会写「路易斯的行踪 战力不够」，看着像配置过期。
function verdictOf(event, { hasIdle = true } = {}) {
  if (event.state === 4) return { text: '待领奖', chip: 'done' };
  // 固定事件 startTime > 0 = 我方舰队已经在打（客户端 isBatting()），state 推送慢时也要能看出来。
  if (event.fixed && event.state === 1 && event.startTime > 0) return { text: '已派兵', chip: 'waiting' };
  if (event.state !== 1) return { text: event.stateText, chip: 'waiting' };
  if (event.dispatchable) return { text: '可派', chip: 'ready' };
  if (event.powerUnknown) return { text: '配置过期', chip: 'blocked' };
  if (!hasIdle) return { text: '没空闲船', chip: 'waiting' };
  return event.fits ? { text: '材料不齐', chip: 'blocked' } : { text: '战力不够', chip: 'blocked' };
}

// 视图：每个事件标出「能不能打、敌方多少战力、值不值得」，每艘船标出耐久与要不要修。
export function viewRadar(survey, {
  config = null,
  minPowerRatio = DEFAULT_MIN_POWER_RATIO,
  repairBelow = survey.repairBelow ?? DEFAULT_REPAIR_BELOW,
} = {}) {
  const config_ = config ?? survey.config ?? null;
  const repairParams = survey.repairParams ?? new Map();
  // 阈值统一成比例，且不允许 >1（>1 等价于「不满就修」）。
  const below = Number(repairBelow) > 0 ? Math.min(1, Number(repairBelow)) : 0;
  const fleets = (survey.fleets ?? []).map((fleet) => {
    const max = Number(fleet.maxDurability) || 0;
    const gap = repairGapOf(fleet);
    const param = repairParams.get(fleet.buildingId) ?? null;
    return {
      ...fleet,
      stateText: FLEET_STATE_TEXT[fleet.state] ?? String(fleet.state),
      // maxDura 缺失（老回包/编的测试数据）按「满耐久」处理 —— 0/0 当成 0% 会每轮都想修。
      duraPct: max > 0 ? (Number(fleet.durability) || 0) / max : 1,
      needRepair: needsRepairOf(fleet, below),
      // 「现在就能发 RepairFleetRequest」：耐久低 + 空闲 + 没在修。
      repairable: canStartRepair(fleet, below),
      repairParam: param,
      // 花多少汽油、修多久：服务端下发 unitRepairCost / unitRepairTime（都是 double），
      // 按「缺多少点耐久」折算；参数没拿到就是 null（这轮不修，也不瞎算）。
      repairCost: param ? Math.ceil(gap * (Number(param.unitRepairCost) || 0)) : null,
      repairSeconds: param ? Math.ceil(gap * (Number(param.unitRepairTime) || 0)) : null,
    };
  });
  const idle = fleets.filter((fleet) => fleet.state === FLEET_STATE_IDLE);
  // 舰队战力取「最强的那艘空闲船」—— 派兵是按 buildingId 一艘一艘派的。
  const bestPower = idle.reduce((max, fleet) => Math.max(max, fleet.power), 0);

  const events = (survey.events ?? []).map((event) => {
    const meta = describeEvent(config_, event);
    const power = enemyPowerOf(config_, event);
    const need = Math.ceil(power * (Number(minPowerRatio) || 1));
    // 固定事件的战力只能来自 RadarFixedEventCfg（协议不下发）。查不到 = 配置表没跟上游戏版本，
    // 这时不能按「无需战斗」放行 —— power=0 会让 need=0、fits 恒真，等于闭着眼派船去打，输了要修船。
    const powerUnknown = event.fixed && power <= 0;
    const fits = !powerUnknown && (need === 0 || bestPower >= need);
    const view = {
      ...event,
      name: meta.name,
      type: meta.type,
      stateText: EVENT_STATE_TEXT[event.state] ?? `状态 ${event.state}`,
      enemyPower: power,
      powerNeeded: need,
      powerUnknown,
      fits,
      rewardScore: rewardScore(event.reward),
      rewardText: formatReward(event.reward),
      // 能不能派：事件可派 + 战力够 + 难民材料齐 + 固定事件不能已经派出去了。
      // 固定事件的「我方已在打」有两个信号：state 变 3，以及 startTime > 0
      // （客户端 isBatting() = startTime>0 && (isPirate || isFixed)，这条是专门给海盗和固定事件留的）。
      // 两个都看 —— 服务端推送（SCRadarEventState）有延迟，只信 state 时可能重复派兵烧汽油。
      dispatchable: event.state === 1
        && (!event.fixed || !(event.startTime > 0))
        && fits
        && (!event.refugee || event.refugee.requirements.every((need_) => (survey.stock?.get(need_.id) ?? 0) >= need_.num)),
    };
    const verdict = verdictOf(view, { hasIdle: idle.length > 0 });
    view.verdict = verdict.text;
    view.verdictChip = verdict.chip;
    return view;
  });

  // 派一艘兵要烧多少汽油（WorldParamCfg「情报事件消耗汽油」，本服 500）。维修和派兵抢同一池汽油，
  // 所以维修预算必须先把派兵的钱扣掉 —— 否则会排出「派 2 艘（1000）+ 修满 2 艘（23000）」的超支计划。
  const dispatchFuel = Number(
    rowsOf(config_, 'WorldParamCfg').find((row) => row.paramName === '情报事件消耗汽油')?.paramValue,
  ) || 0;

  return {
    now: survey.now,
    level: survey.level,
    exp: survey.exp,
    storedNum: survey.storedNum,
    nextRefreshTime: survey.nextRefreshTime,
    petrol: survey.petrol,
    minPowerRatio,
    repairBelow: below,
    dispatchFuel,
    idleFleets: idle,
    fleets,
    bestIdlePower: bestPower,
    events,
    // 待领奖的事件（state=4）不占舰队，先领掉最省事。
    rewards: events.filter((event) => event.state === 4),
    // 该修的船（耐久低于阈值）：repairable = 现在就能修，否则是在航行/战斗中或在修。
    repairQueue: fleets.filter((fleet) => fleet.needRepair),
  };
}

// 计划：先领奖（一条 RadarGetAllRewardsRequest 全领），再把**每一艘空闲船各派一个事件**。
// 一艘船同一时刻只能打一个点，所以船数就是并发上限；同一事件不会被派两次。
// maxDispatch 是「最多派几艘」的上限（默认 Infinity = 有多少空闲船就派多少）。
// repair / repairBelow：耐久低于 repairBelow（比例）的船**不派出去**，改成留在港里修。
// 顺序固定为「领奖 → 派兵 → 修船」：派兵用的都是耐久达标的船，跟维修对象互不重叠。
export function planRadar(view, {
  maxDispatch = Infinity,
  minPowerRatio = DEFAULT_MIN_POWER_RATIO,
  repair = true,
  repairBelow = view.repairBelow ?? DEFAULT_REPAIR_BELOW,
  maxRepair = Infinity,
} = {}) {
  const actions = [];
  const notes = [];
  const below = Number(repairBelow) > 0 ? Math.min(1, Number(repairBelow)) : 0;
  const repairOn = repair === true && below > 0;

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

  const idleAll = (view.idleFleets ?? []).slice().sort((a, b) => b.power - a.power);
  // 耐久不达标的船留在港里等修，不派出去：它已经掉了这么多耐久，再打一场很可能直接打空。
  // 实测出现过 0/2000 的船照样被派出去（服务端不拦 IDLE 船的耐久），所以这条必须自己判。
  const grounded = repairOn ? idleAll.filter((fleet) => needsRepairOf(fleet, below)) : [];
  const idle = idleAll.filter((fleet) => !grounded.includes(fleet));

  if (idleAll.length === 0) {
    notes.push(`没有空闲舰队（${(view.fleets ?? []).map((fleet) => `${fleet.buildingId}=${fleet.stateText}`).join(' ') || '一艘都没有'}），这轮只领奖`);
  } else if (grounded.length > 0) {
    notes.push(`${grounded.length} 艘空闲船耐久低于 ${pctText(below)}，留在港里修，不出去打：`
      + grounded.map((fleet) => `${fleet.buildingId}(${duraText(fleet)})`).join('、'));
  }

  // 候选：可派 + 战力够。排序规则：
  // 1. 固定事件排最前 —— 它不带 color（恒为 0），按颜色排会永远垫底；而空闲船少于事件数时
  //    垫底就等于永远轮不到。固定事件是一次性的（打掉就不再来），随机事件按 6 小时刷新。
  // 2. 再按颜色（4 紫 > 3 蓝 > 2 绿，客户端用它标事件稀有度）。
  // 3. 同色挑「战力需求高的」（奖励通常跟难度走），最后看奖励件数。
  // 不按奖励件数单独排 —— 带 GOLD 3700 的打捞宝箱会把分数拉得虚高，
  // 结果一艘船天天去捞箱子，海盗一个不打。
  const candidates = view.events
    .filter((event) => event.dispatchable)
    .sort((a, b) => ((b.fixed ? 1 : 0) - (a.fixed ? 1 : 0))
      || (b.color - a.color) || (b.enemyPower - a.enemyPower) || (b.rewardScore - a.rewardScore));
  // 「可派但打不了」的事件：state=1 却没进候选。
  // 固定事件 startTime>0 表示我方舰队已经在打它（客户端 isBatting()），那不是「打不了」，
  // 必须剔出去 —— 否则服务端状态推送稍慢时，每轮都会说它「材料不齐」。
  const alreadyOut = view.events.filter((event) => event.fixed && event.state === 1 && event.startTime > 0);
  const skipped = view.events.filter((event) => event.state === 1 && !event.dispatchable
    && !(event.fixed && event.startTime > 0));
  const reasonOf = (event) => {
    if (event.powerUnknown) return '配置里查不到战力';
    if (event.powerNeeded > 0) return `需 ${event.powerNeeded}`;
    return '缺材料';
  };
  for (const event of alreadyOut) {
    notes.push(`固定事件「${event.name}」已经派舰队去打，等它回来再派`);
  }

  // 贪心配对：最强的那艘先挑，所以它能拿优先级最高（通常奖励最好）的事件；
  // 弱船往后顺延挑剩下的。战力不够的事件不硬派 —— 打输会掉耐久，修船要资源。
  const taken = new Set();
  const idleLeft = [];
  if (idle.length > 0 && candidates.length > 0) {
    const cap = Number.isFinite(Number(maxDispatch)) ? Math.max(0, Number(maxDispatch)) : Infinity;
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
      // 走到这里 rest === 0，即「能打的事件全派出去了」：剩下的船不是打不过，是没事件可打
      // （以前这里统一写成「战力不够」，一艘船打一个事件的场景下会给出误导性原因）。
      notes.push(`${idleLeft.length} 艘空闲船没派：能打的事件都派出去了（每艘船同时只能打一个点）`);
    }
  } else if (candidates.length > 0 && idle.length === 0 && grounded.length === 0) {
    notes.push(`${candidates.length} 个事件能打，但没有空闲船`);
  }
  // 一艘空闲船都没有时不报「打不过」：那几艘在航行/修理，几分钟后自己会回来，
  // 上面已经有一条「没有空闲舰队（…）」，再写「战力不够」会让人以为配置过期。
  if (skipped.length > 0 && idleAll.length > 0) {
    notes.push(`${skipped.length} 个事件打不过或材料不齐：`
      + skipped.map((event) => `${event.name}(${reasonOf(event)})`).slice(0, 4).join('、'));
  }

  // ---- 修船 ----
  // 只对「现在就能修」的船动手：空闲 + 没在修 + 耐久低于阈值（客户端 _onBtnAmend 同款门槛）。
  // 修满要花的汽油按服务端下发的 unitRepairCost 折算，**不硬编码**。
  if (repairOn) {
    const queue = (view.fleets ?? [])
      .filter((fleet) => canStartRepair(fleet, below))
      // 最破的先修：一艘 0/2000 的船比 1900/2000 的船更该先回厂。
      .sort((a, b) => repairGapOf(b) - repairGapOf(a));
    const capRepair = Number.isFinite(Number(maxRepair)) ? Math.max(0, Number(maxRepair)) : Infinity;
    // 派兵先花掉一部分汽油（每艘「情报事件消耗汽油」），维修预算从剩下的里面算。
    const dispatchSpent = taken.size * (Number(view.dispatchFuel) || 0);
    let fuelLeft = Math.max(0, (Number(view.petrol) || 0) - dispatchSpent);
    let planned = 0;
    for (const fleet of queue) {
      if (planned >= capRepair) {
        notes.push(`还有 ${queue.length - planned} 艘船要修，本轮达到上限 ${capRepair} 艘，下一轮继续`);
        break;
      }
      const gap = repairGapOf(fleet);
      const param = fleet.repairParam;
      if (!param) {
        notes.push(`${fleet.buildingId} 要修但拿不到维修参数（FleetRepairParamRequest 没成功），这轮跳过`);
        continue;
      }
      const cost = Math.ceil(gap * (Number(param.unitRepairCost) || 0));
      if (cost > fuelLeft) {
        notes.push(`${fleet.buildingId} 修满要 ${cost} ${DURABY_ITEM}，`
          + `剩下的汽油只有 ${fuelLeft}${dispatchSpent > 0 ? `（已扣掉派兵 ${dispatchSpent}）` : ''}，攒够再修`);
        continue;
      }
      fuelLeft -= cost;
      planned += 1;
      actions.push({
        kind: 'radarRepair',
        request: 'RepairFleetRequest',
        response: null,
        body: { buildingId: fleet.buildingId },
        // 一艘船一个 key：失败了别让整段情报陪葬，也别把这条永久记进 rejected
        // （维修失败多是「汽油又被别的段花掉了」这种会恢复的状态）。
        key: `radarRepair:${fleet.buildingId}`,
        group: `radarRepair:${fleet.buildingId}`,
        transient: true,
        label: `维修 ${fleet.buildingId}（耐久 ${duraText(fleet)}，低于 ${pctText(below)}）→ 修满`
          + `，花 ${cost} ${DURABY_ITEM}` + (fleet.repairSeconds > 0 ? `，约 ${durationText(fleet.repairSeconds)}` : ''),
      });
    }
    // 要修但现在修不了的（航行中 / 战斗中 / 已经在修）说清楚原因，别让人以为漏了。
    const waiting = (view.fleets ?? []).filter((fleet) => needsRepairOf(fleet, below) && !canStartRepair(fleet, below));
    if (waiting.length > 0) {
      notes.push(`${waiting.length} 艘船耐久也低，但暂时修不了：`
        + waiting.map((fleet) => `${fleet.buildingId}(${fleet.stateText}${fleet.repairing && fleet.repairing.endTs > 0 ? `，${durationText(fleet.repairing.endTs - Math.floor(Date.now() / 1000))}后好` : ''})`).join('、'));
    }
  }

  return { actions, notes };
}

// 情报池刷新的余量：nextRefreshTime 是秒级时间戳，我们到点前后几秒难免有误差，
// 早探一次只会白拿一份空列表（而且又要再等一个间隔）。宁可晚 5 秒。
export const RADAR_REFRESH_SLACK_MS = 5_000;

// 这次探测之后，到什么时候才值得再探一次。返回 0 = 按常规间隔（radarEveryMs）再来。
//
// 背景：情报事件是「打掉就没了，等服务端按 nextRefreshTime 刷一批新的」的池子，
// 刷新间隔是小时级（实测 6 小时量级）。以前不管有没有事件可打都每 60 秒探一次 ——
// 一晚上几百次 RadarInfo + MyFleets 全打在空气上。
//
// 只有下面这些条件**全部**成立才敢睡到刷新点，任何一条不成立都按常规节奏回来：
//  1. 服务端给了 nextRefreshTime 且还没到（没给 = 不知道什么时候刷，只能照常轮询）；
//  2. 没有待领奖的事件（state=4 不领不会自己进包里）；
//  3. 没有任何 state=1 的事件 —— 包括我们战力/材料不够打不了的，因为材料是工厂现产、
//     战力会随英雄养成变，几分钟后就可能打得过了；
//  4. 所有舰队都空闲且不在修（派出去的船回来就能接着打，不能睡）；
//  5. 没有该修还没修的船（可能只是汽油暂时不够，下轮就够）。
//
// state=2（被别人占了）不算「有事可做」：抢不回来，只能等刷新。
// state=3（我方在打）必然对应一艘非空闲的船，第 4 条已经拦住了。
export function radarIdleUntil(view, { nowMs = Date.now(), slackMs = RADAR_REFRESH_SLACK_MS } = {}) {
  const now = Math.floor(Number(nowMs) / 1000);
  const refreshAt = Number(view?.nextRefreshTime) || 0;
  if (!(refreshAt > now)) return 0;
  if ((view.rewards ?? []).length > 0) return 0;
  if ((view.events ?? []).some((event) => Number(event?.state) === 1)) return 0;
  const fleets = view.fleets ?? [];
  if (fleets.some((fleet) => Number(fleet?.state) !== FLEET_STATE_IDLE || fleet?.repairing)) return 0;
  if ((view.repairQueue ?? []).length > 0) return 0;
  return refreshAt * 1000 + Math.max(0, Number(slackMs) || 0);
}

export function formatRadarPlan(view, plan) {
  const lines = [];
  lines.push(`情报 Lv${view.level}（经验 ${view.exp}）· 存 ${view.storedNum} 个 · 汽油 ${view.petrol}`
    + ` · 舰队 ${view.fleets.length} 艘（空闲 ${view.idleFleets.length}，最强 ${view.bestIdlePower}）`);
  // 舰队耐久单独列一行：修船是按耐久判的，不写出来就看不出「为什么这轮没派兵」。
  if ((view.fleets ?? []).length > 0) {
    const below = Number(view.repairBelow) || 0;
    lines.push(`  舰队耐久（低于 ${pctText(below)} 就修）：`
      + view.fleets.map((fleet) => `${fleet.buildingId} ${fleet.stateText} ${duraText(fleet)}`
        + (fleet.repairable ? `（要修，${fleet.repairCost !== null ? `${DURABY_ITEM} ${fleet.repairCost}` : '参数未知'}）`
          // 修的时候服务端**不更新 durability**，只给 repairing.endDura —— 光看「0/2000」会以为没修上，
          // 所以把「修到多少、还有多久」一起写出来。
          : fleet.repairing
            ? `（修理中${fleet.repairing.endDura > 0 ? ` → ${fleet.repairing.endDura}/${fleet.maxDurability}` : ''}`
              + `${fleet.repairing.endTs > 0 ? `，${durationText(fleet.repairing.endTs - Math.floor(Date.now() / 1000))}后好` : ''}）`
            : '')).join('；'));
  }
  if (view.events.length === 0) {
    // 事件为空不等于出问题：情报池按 nextRefreshTime 才刷（实测隔 6 小时量级），
    // 期间每轮探测都会是 0 个。
    const left = Number(view.nextRefreshTime) > 0 ? Number(view.nextRefreshTime) - Math.floor(Date.now() / 1000) : 0;
    lines.push(`  现在没有事件可打${left > 0 ? `，下次刷新还有 ${Math.round(left / 60)} 分钟` : ''}`);
  }
  for (const event of view.events) {
    const power = event.enemyPower > 0 ? `敌方 ${event.enemyPower}` : '无需战斗';
    // 判定文本来自 viewRadar 的 verdict，这里不再自己算一遍（否则和页面会各说各话）。
    lines.push(`  [${event.verdict}] ${event.fixed ? `${event.name}（固定）` : event.name}  ${power}  ${event.rewardText}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of plan.notes) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
