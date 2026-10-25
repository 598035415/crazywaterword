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
  // eventId <= 0 的条目直接丢掉：它连名字和战力都查不到，派出去只会白跑一次。
  const events = (info.events ?? [])
    .map((raw) => toEvent(raw, { config }))
    .filter((event) => event.eventId > 0);
  // 固定事件在第 6 个字段，不在 events 里 —— 客户端也是把它 push 进同一份列表再用。
  // 没有它「路易斯的行踪」这类事件永远不会出现在计划里。
  if (Number(info.fixedEvent?.eventId) > 0) {
    events.push(toEvent(info.fixedEvent, { config, fromFixed: true }));
  }
  return {
    now: Math.floor(Date.now() / 1000),
    level: Number(info.level) || 0,
    exp: Number(info.exp) || 0,
    storedNum: Number(info.storedNum) || 0,
    nextRefreshTime: Number(info.nextRefreshTime) || 0,
    petrol: bag.get('汽油') ?? 0,
    stock: bag,
    events,
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

// 一个事件「现在能不能派、为什么不能」的唯一判定。
// 之前 formatRadarPlan 和页面各算一套，加了固定事件后已经漂移（页面不认识「已派兵」「配置过期」），
// 所以在这里算一次，两个渲染端都只读 verdict / verdictChip。
function verdictOf(event) {
  if (event.state === 4) return { text: '待领奖', chip: 'done' };
  // 固定事件 startTime > 0 = 我方舰队已经在打（客户端 isBatting()），state 推送慢时也要能看出来。
  if (event.fixed && event.state === 1 && event.startTime > 0) return { text: '已派兵', chip: 'waiting' };
  if (event.state !== 1) return { text: event.stateText, chip: 'waiting' };
  if (event.dispatchable) return { text: '可派', chip: 'ready' };
  if (event.powerUnknown) return { text: '配置过期', chip: 'blocked' };
  return event.fits ? { text: '材料不齐', chip: 'blocked' } : { text: '战力不够', chip: 'blocked' };
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
    const verdict = verdictOf(view);
    view.verdict = verdict.text;
    view.verdictChip = verdict.chip;
    return view;
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

  if (candidates.length === 0) {
    if (skipped.length > 0) {
      notes.push(`有 ${skipped.length} 个事件打不了：`
        + skipped.map((event) => `${event.name}(${reasonOf(event)})`).slice(0, 4).join('、'));
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
    // 走到这里 rest === 0，即「能打的事件全派出去了」：剩下的船不是打不过，是没事件可打
    // （以前这里统一写成「战力不够」，一艘船打一个事件的场景下会给出误导性原因）。
    notes.push(`${idleLeft.length} 艘空闲船没派：能打的事件都派出去了（每艘船同时只能打一个点）`);
  }
  if (skipped.length > 0) {
    notes.push(`${skipped.length} 个事件打不过或材料不齐：`
      + skipped.map((event) => `${event.name}(${reasonOf(event)})`).slice(0, 4).join('、'));
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
    // 判定文本来自 viewRadar 的 verdict，这里不再自己算一遍（否则和页面会各说各话）。
    lines.push(`  [${event.verdict}] ${event.fixed ? `${event.name}（固定）` : event.name}  ${power}  ${event.rewardText}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of plan.notes) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
