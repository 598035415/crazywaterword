// 搁浅的货轮（世界宝藏 / TreasureLoot）：整点刷新的货轮，派舰队去占领，进度满 100% 结算奖励。
//
// 为什么值得自动化：货轮在每天 8:00~22:00 的**每个整点**刷新，万吨全服只有 1 艘，
// 谁先派到船谁占；而玩家一天最多拿 3 次奖励（TreasureLootParamCfg「每日宝藏奖励次数」= 3）。
// 人不可能整点守着，所以漏掉的不是"一点收益"，是当天的名额。
//
// 事实来源（协议 + 抓包 + 客户端反编译三处对齐，没有推测）：
// - TreasureLootStatsRequest {} -> TreasureLootStatsResponse
//     { stats:[{color,count}], nextRefreshTime, todayRewardTimes, totalRewardTimes }
//   totalRewardTimes = **每日上限**（实测 3，与 TreasureLootParamCfg 一致），不是累计总次数。
//   nextRefreshTime = 下一个整点（实测 1792936000 时回 1792936800，整点差 3600）。
// - TreasureLootListRequest {} -> TreasureLootListResponse { treasure: [TreasureLootInstance] }
//   TreasureLootInstance = { uid, color, ownerGuildIdx, ownerFleetNum, progress, reward, gridIdx, battlePoint }
//     color 是全局品质枚举：3=蓝(小型货轮) 4=紫(中型货轮) 5=橙(万吨货轮)，
//     对应 TreasureLootCfg 的 qualityIndex = color - 2（1/2/3）。抓包实测：
//     color 3 的奖励是「蓝装材料自选包」，color 4 是「紫装材料自选包」，与配置表吻合。
//     ownerGuildIdx = 0 表示**还没有任何联盟占**（到达即开始占领，不打架）；
//     != 0 表示被某个联盟占着，派过去要先打赢守军（battlePoint.rightFighter）才算数。
// - TreasureLootSendFleetsRequest { uid: int32, fleetBuildingIds: repeated string }
//   一条请求可以带多支舰队（客户端自动抢万吨就是一次把全部空闲船塞进去）。
// - MyFleetsRequest -> fleets[].{ buildingId, state, power, durability, maxDura, treasureLootUid }
//   FleetState：1 IDLE / 2 MOVING / 3 BATTLING / 4 REPAIRING / 5 QUEUING。
//   treasureLootUid > 0 = 这支舰队**正在抢某个货轮**（为 0 时 protobuf 不编码，字段直接不出现），
//   所以「能不能派」= state === 1 && treasureLootUid === 0 —— 与客户端
//   `f.troopState == Idle && 0 == f.treasureLootUid` 逐字一致。
// - 单次派兵消耗 WorldParamCfg「进攻宝藏消耗汽油」= 500（每支舰队）。
// - 同联盟最多 10 支舰队占领同一个货轮（游戏内「世界宝藏」说明），满了会被自动遣返。
// - 奖励**没有领取请求**：进度满 100% 由服务端结算（战报进邮件，邮件由 idle 模块一键领）。
//   所以本模块只做一件写操作 —— 派舰队。
//
// 抢哪些等级由用户多选（`colors`，协议 color 3/4/5），**默认只抢万吨**（`DEFAULT_COLORS = [5]`）。
// 万吨全服 1 艘、奖励最厚，先把它占住最划算；小型/中型要不要是用户的取舍，页面上勾。
//
// 有人占领也照样派（2026-10-26 按用户要求改的，原来只抢 ownerGuildIdx === 0）：
//   抢别人占着的要先打赢守军，而 battlePoint.rightFighter 里**没有战力字段**
//   （只有 name / avatar / isNpc / guildIdx / skinId），拿不到对手战力就无法判断能不能赢，
//   赌输要掉舰船耐久（维修 6 汽油/点）。但"占着"里有一半是我们自己联盟（协议只给联盟编号，
//   拿不到自己的 guildIdx），一眼看不出敌我；而且整点刷新后几十秒就可能被别人全占走，
//   干等着等于当天空手。所以现在全都派，同一等级里无人占领的排在前面先挑（见 rank），
//   输赢交给战报（进邮件，由 idle 模块一键领）。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount } from './world.mjs';

// 兜底值：配置表读不到时用（数值都来自游戏内说明，不是猜的）。
const FALLBACK_DAILY_LIMIT = 3;
const FALLBACK_PETROL_COST = 500;
// 赛季天数兜底：S1~S3 是 24 天（SeasonTaskCfg 里 lastDay 最大 24）。
const FALLBACK_SEASON_DAYS = 24;

// 赛季结束前 1 小时就派不了船了 —— 游戏内「合服计划」原话：
// 「进入新赛季前的 1 小时内，玩家将不再能操作舰队参与包括但不限于货轮争夺、硅矿争夺…」。
export const SEASON_CLOSE_GUARD_SECONDS = 3600;

// 赛季结束时间的缓存：这个值一天最多变一次，没必要 60 秒一轮问一遍
//（`SeasonRankInfoRequest` 是登录时客户端自己也会发的只读请求，但每轮都发就纯属浪费）。
// 按 worldId 分键 —— 多账号 / 换赛季时不能串号。
const SEASON_CACHE_MS = 3600 * 1000;
const seasonCache = new Map();

// 可抢的货轮等级（协议 color 枚举）：3 蓝(小型) / 4 紫(中型) / 5 橙(万吨)。
// 页面上的多选框就是这三个；配置表改名不用动这里（名字仍走 qualityOf 读 TreasureLootCfg）。
export const TREASURE_LEVELS = [3, 4, 5];

// 默认只抢万吨货轮（用户口里的「大货轮」）：
// 每天只有 3 次奖励、一天 14 次刷新，稀缺的是「次数」不是「船」，万吨奖励最厚（橙装材料自选包）。
// 想顺手把中型/小型也扫掉，在页面「抢哪些」里勾上就行（多选题）。
export const DEFAULT_COLORS = [5];

// 把外部输入（页面多选 / JSON payload / CLI --colors）归一成升序去重的 color 数组。
// - 不给（null/undefined）→ 默认值（只抢万吨）
// - 显式空数组 → 空数组（页面上「全不勾」= 一个都不抢，不要偷偷回退成默认值）
// - 只认 >= 3 的整数（3 蓝 / 4 紫 / 5 橙），脏值直接丢掉
export function colorsOf(value) {
  if (value == null) return [...DEFAULT_COLORS];
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set();
  for (const entry of raw) {
    const color = Math.floor(Number(entry));
    if (Number.isFinite(color) && color >= 3) seen.add(color);
  }
  return [...seen].sort((a, b) => a - b);
}

// 日志/页面共用一份「抢哪些」文案：`万吨货轮` / `中型货轮、万吨货轮` / `未选等级`。
export function colorsText(config, colors) {
  const list = colorsOf(colors);
  if (list.length === 0) return '未选等级';
  return list.map((color) => qualityOf(config, color).name).join('、');
}

// 同联盟最多 10 支舰队占同一个货轮（游戏内「世界宝藏 / 舰队数量限制」）。
export const MAX_GUILD_FLEETS = 10;

// 一次最多派几支舰队。默认 3：两三条就够把一个小型货轮推到结算，
// 再多会把船全压在货轮上，情报事件/资源田就没船可用（船是全局共享的）。
export const DEFAULT_MAX_FLEETS = 3;

const FLEET_STATE_TEXT = { 1: '空闲', 2: '航行中', 3: '战斗中', 4: '修理中', 5: '排队中' };

function paramValue(rows, name) {
  const row = (rows ?? []).find((entry) => entry?.paramName === name);
  const value = Number(row?.paramValue);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// 每日奖励上限：服务端回的 totalRewardTimes 优先（那是权威值），
// 拿不到才回配置表，再拿不到用兜底 3。
export function dailyLimitOf(config, stats) {
  const fromServer = Number(stats?.totalRewardTimes) || 0;
  if (fromServer > 0) return fromServer;
  return paramValue(rowsOf(config, 'TreasureLootParamCfg'), '每日宝藏奖励次数') || FALLBACK_DAILY_LIMIT;
}

// 单支舰队派兵的汽油消耗（WorldParamCfg「进攻宝藏消耗汽油」）。
export function petrolCostOf(config) {
  return paramValue(rowsOf(config, 'WorldParamCfg'), '进攻宝藏消耗汽油') || FALLBACK_PETROL_COST;
}

// --- 活动有效期（赛季窗口）------------------------------------------------------
//
// 世界宝藏**没有独立的「活动时间」协议字段**（把它当成运营活动去找会白找：`SCAllActivity` 里
// 只有首充/七日活动/皮肤/限时礼包这些，世界宝藏属于 `WorldGameplay`，是随赛季存在的常驻玩法）。
// 它真正的边界是**赛季结束**：
// - 赛季结束世界重置，货轮清空重刷；
// - 新赛季前 1 小时连船都派不了（见 SEASON_CLOSE_GUARD_SECONDS）；
// - 新赛季按 `GameplayOpenCfg.openDays` 重新开放（S1 第 3 天、S2 之后第 1 天）。
//
// 两个来源，实测在 S1 上**完全相等**（差 0 秒），所以互为兜底：
//   ① `SeasonRankInfoResponse.endTime` = 1794499170 = 2026-11-12 23:59:30
//   ② `playerInfo.worldOpenTime`（10-20 00:00）+ `SeasonTaskCfg` 该赛季最大 `lastDay`（24 天）
//      = 10-20 + 23 天 + 23:59:30 = 1794499170
// 拿不到 ① 就用 ②；两个都算不出来时 `endAt = 0`（**不能**因为算不出来就把功能停掉）。

// 服务端时间戳的「本地零点」：游戏是国内服，用户本机时区与服务器一致（项目里 archive/dayOf 也按本地日切）。
function startOfDayLocal(ts) {
  const date = new Date(Number(ts) * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

// 赛季天数：`SeasonTaskCfg` 里该赛季最大的 `lastDay`（S1~S3 = 24，S4+ = 45）。
// 配置包里同时躺着 `SeasonTaskCfg` / `1_` / `2_` 三份（按服/剧本不同用不同表），全部扫一遍取最大。
export function seasonDaysOf(config, seasonNo) {
  const season = Number(seasonNo) || 0;
  if (season <= 0) return FALLBACK_SEASON_DAYS;
  let best = 0;
  for (const name of ['SeasonTaskCfg', '1_SeasonTaskCfg', '2_SeasonTaskCfg']) {
    for (const row of rowsOf(config, name)) {
      if (Number(row?.season) !== season) continue;
      best = Math.max(best, Number(row.lastDay) || 0);
    }
  }
  return best || FALLBACK_SEASON_DAYS;
}

// 赛季窗口。worldId 的编码规则（客户端 WorldIdRule.getSeason）：
// `Math.floor(worldId / 1e6 % 1000)`，2_001_014_410 → S1。
export function seasonWindowOf(config, {
  worldId = 0,
  worldOpenTime = 0,
  endTimeFromServer = 0,
} = {}) {
  const season = Number(worldId) > 0 ? Math.floor(Number(worldId) / 1e6 % 1000) : 0;
  const fromServer = Number(endTimeFromServer) || 0;
  if (fromServer > 0) return { season, endAt: fromServer, source: 'server' };
  const openTime = Number(worldOpenTime) || 0;
  if (openTime <= 0) return { season, endAt: 0, source: null };
  const days = seasonDaysOf(config, season);
  // 赛季第 N 天的最后一秒：零点 + (N-1) 天 + 23:59:30（服务端给的正是 23:59:30，不是 59 秒）。
  return {
    season,
    endAt: startOfDayLocal(openTime) + (days - 1) * 86400 + 86370,
    source: 'config',
  };
}

async function seasonWindow(client, protocol, { config = null, player = null, timeout = 8000 } = {}) {
  const worldId = Number(player?.worldId) || 0;
  const key = worldId > 0 ? String(worldId) : 'default';
  const nowMs = Date.now();
  const cached = seasonCache.get(key);
  if (cached && nowMs - cached.at < SEASON_CACHE_MS) return cached.window;

  let endAt = 0;
  if (protocol.SeasonRankInfoRequest && protocol.SeasonRankInfoResponse) {
    try {
      const body = normalize(await client.request('SeasonRankInfoRequest', {}, 'SeasonRankInfoResponse', timeout));
      endAt = Number(body?.endTime) || 0;
    } catch {
      endAt = 0;
    }
  }
  const window = seasonWindowOf(config, {
    worldId,
    worldOpenTime: player?.worldOpenTime,
    endTimeFromServer: endAt,
  });
  // 算不出来（endAt = 0）也缓存：免得每轮都去撞一个正挂着的接口。
  seasonCache.set(key, { at: nowMs, window });
  return window;
}

// 日志里的时间戳：`11-12 23:59`，不在今年就带上年份。
function stamp(ts) {
  const date = new Date(Number(ts) * 1000);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '?';
  const pad = (n) => String(n).padStart(2, '0');
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}-${md}`;
}

// 品质：color 是全局品质枚举（3 蓝 / 4 紫 / 5 橙），货轮表用的 qualityIndex = color - 2。
// 名字与积分都从 TreasureLootCfg 取，配置表改名/加档都不用改代码。
export function qualityOf(config, color) {
  const index = Number(color) - 2;
  const row = rowsOf(config, 'TreasureLootCfg').find((entry) => Number(entry?.qualityIndex) === index);
  if (row) {
    return {
      name: String(row.name ?? `货轮 ${color}`),
      quality: String(row.quality ?? ''),
      score: Number(row.score) || 0,
    };
  }
  // 配置表缺档（游戏更新加新品质）时不能把货轮当不存在 —— 名字降级但照样能抢。
  return { name: `货轮（品质 ${color}）`, quality: '', score: 0 };
}

function rewardOf(raw) {
  return (raw?.reward?.asset ?? [])
    // type 要留着：0 = 物品（材料/经验/宝箱），1 = 资源（GOLD/RUBY）。排序权重不同，见 rewardScore。
    .map((asset) => ({ type: Number(asset.type) || 0, id: asset.id, num: assetCount(asset.num) }))
    .filter((asset) => Boolean(asset.id) && asset.num > 0);
}

// 奖励粗排：**只按物品件数**算分，资源（GOLD/RUBY，type 1）只作同分时的次级比较。
//
// 为什么不能把资源算进去：GOLD 动辄 8300，比其他货轮的全部物品件数还多，
// 按总件数排会让「金币多的那个」永远排第一 —— 跟 radar 里那个
// 「带 GOLD 3700 的打捞宝箱把分数拉得虚高，结果一艘船天天去捞箱子」是同一个坑。
// 金币是游戏里最容易得的资源，货轮真正值钱的是材料自选包和藏品经验。
function rewardScore(reward) {
  let items = 0;
  let resources = 0;
  for (const asset of reward ?? []) {
    if (asset.type === 0) items += Number(asset.num) || 0;
    else resources += Number(asset.num) || 0;
  }
  return { items, resources };
}

function formatReward(reward, limit = 3) {
  const list = (reward ?? []).slice(0, limit).map((asset) => `${asset.id}×${asset.num}`);
  const rest = (reward ?? []).length - list.length;
  return list.join('、') + (rest > 0 ? ` 等 ${(reward ?? []).length} 项` : '');
}

export async function surveyTreasure(client, protocol, {
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

  // 四个只读请求一起发：次数、货轮列表、舰队状态，外加赛季窗口（内部有 1 小时缓存，
  // 稳态下这一项不发请求）。库存由循环里的 world 那一段传进来，
  // 单独跑（网页「立刻抢一次」）时才自己拉 —— 只为读一个汽油数。
  const [stats, list, fleetList, itemList, season] = await Promise.all([
    get('TreasureLootStatsRequest'),
    get('TreasureLootListRequest'),
    get('MyFleetsRequest'),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
    seasonWindow(client, protocol, { config, player, timeout }),
  ]);
  if (!list) throw new Error('拿不到 TreasureLootListResponse，读不了世界宝藏');

  const bag = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bag.set(id, (bag.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
  }

  const limit = dailyLimitOf(config, stats);
  const treasures = (list.treasure ?? []).map((raw) => {
    const color = Number(raw.color) || 0;
    const meta = qualityOf(config, color);
    const reward = rewardOf(raw);
    const score = rewardScore(reward);
    return {
      uid: Number(raw.uid) || 0,
      color,
      name: meta.name,
      quality: meta.quality,
      score: meta.score,
      ownerGuildIdx: Number(raw.ownerGuildIdx) || 0,
      ownerFleetNum: Number(raw.ownerFleetNum) || 0,
      progress: Number(raw.progress) || 0,
      gridIdx: Number(raw.gridIdx) || 0,
      reward,
      itemScore: score.items,
      resourceScore: score.resources,
      rewardText: formatReward(reward),
    };
  });

  return {
    now: Math.floor(Date.now() / 1000),
    // stats 拿不到时这里为 null —— 「今天还能领几次」是派兵的唯一硬约束，不能猜。
    statsAvailable: Boolean(stats),
    dailyLimit: limit,
    todayRewardTimes: stats ? Number(stats.todayRewardTimes) || 0 : null,
    nextRefreshTime: Number(stats?.nextRefreshTime) || 0,
    counts: (stats?.stats ?? []).map((entry) => ({ color: Number(entry.color) || 0, count: Number(entry.count) || 0 })),
    petrol: bag.get('汽油') ?? 0,
    petrolCost: petrolCostOf(config),
    // 活动有效期（赛季窗口）：stopAt 已经减掉「新赛季前 1 小时」的封盘时间。
    season: {
      ...season,
      stopAt: season.endAt > 0 ? season.endAt - SEASON_CLOSE_GUARD_SECONDS : 0,
    },
    stock: bag,
    treasures,
    fleets: (fleetList?.fleets ?? []).map((fleet) => ({
      buildingId: fleet.buildingId,
      state: Number(fleet.state) || 0,
      power: assetCount(fleet.power),
      durability: assetCount(fleet.durability),
      maxDurability: assetCount(fleet.maxDura) || 0,
      // 为 0 时 protobuf 不编码这个字段，读出来就是 undefined —— 统一成 0。
      treasureLootUid: Number(fleet.treasureLootUid) || 0,
      targetGridIdx: Number(fleet.targetGridIdx) || 0,
    })),
    config,
  };
}

// 视图：每个货轮标「能不能抢」，加上舰队/次数/汽油的现状。
export function viewTreasure(survey, {
  config = null,
  colors,
  maxFleets = DEFAULT_MAX_FLEETS,
} = {}) {
  const config_ = config ?? survey.config ?? null;
  const limit = Number(survey.dailyLimit) || FALLBACK_DAILY_LIMIT;
  const today = survey.todayRewardTimes;
  const dailyFull = today != null && today >= limit;
  const remainingRewards = today == null ? null : Math.max(0, limit - today);
  const petrolCost = Number(survey.petrolCost) || FALLBACK_PETROL_COST;
  const petrol = Number(survey.petrol) || 0;
  // 用户勾的等级（默认只抢万吨）。空数组 = 一个都不抢，日志里会说清楚。
  const wanted = colorsOf(colors);
  const wantedSet = new Set(wanted);
  const colorText = colorsText(config_, wanted);

  // 活动有效期：stopAt 是「真能派船的最后时刻」（已减去新赛季前 1 小时的封盘）。
  // unknown = 两个来源都算不出来 —— 这时**不能停**（算不出来不代表活动结束了），只提示。
  const nowSec = Math.floor(Date.now() / 1000);
  const stopAt = Number(survey.season?.stopAt) || 0;
  const activity = {
    season: Number(survey.season?.season) || 0,
    endAt: Number(survey.season?.endAt) || 0,
    stopAt,
    source: survey.season?.source ?? null,
    expired: stopAt > 0 && nowSec >= stopAt,
    unknown: stopAt <= 0,
    remainingSeconds: stopAt > 0 ? Math.max(0, stopAt - nowSec) : null,
  };

  // 空闲 = state IDLE 且没有正在抢的货轮（客户端同款判据）。
  const idleFleets = (survey.fleets ?? []).filter((fleet) => fleet.state === 1 && fleet.treasureLootUid === 0);

  // 我方已经在抢哪个货轮：`MyFleet.treasureLootUid` 在**航行途中就有值**（实测派兵后立刻回 34，
  // 船还是 MOVING），所以这个计数包含"在路上"和"已经在推"两种。
  // 只用于展示 —— 判据仍然是货轮的 ownerGuildIdx（舰队到达后服务端才会把它改成我方联盟）。
  const ourFleetsByUid = new Map();
  for (const fleet of survey.fleets ?? []) {
    const uid = Number(fleet.treasureLootUid) || 0;
    if (uid > 0) ourFleetsByUid.set(uid, (ourFleetsByUid.get(uid) ?? 0) + 1);
  }

  const treasures = (survey.treasures ?? []).map((treasure) => {
    const free = treasure.ownerGuildIdx === 0;
    const ourFleets = ourFleetsByUid.get(treasure.uid) ?? 0;
    // 名额只能按**我方**舰队数算：`ownerFleetNum` 是占领方联盟的船数，可能是别人的 ——
    // 拿 10 - ownerFleetNum 当自己的余量，会在「别人占满 10 支」时把自己算成 0 支，永远不派。
    const slotsLeft = Math.max(0, MAX_GUILD_FLEETS - ourFleets);
    const levelOk = wantedSet.has(treasure.color);
    return {
      ...treasure,
      free,
      ourFleets,
      slotsLeft,
      levelOk,
      // 有人占领也派（打赢守军就换我们占）。等级要勾了、进度没满、我方还没占满才有意义。
      claimable: levelOk && treasure.progress < 100 && slotsLeft > 0,
      // 优先级：等级高的先派（万吨 > 中型 > 小型），同等级里 无人占领(0) → 我方在推(1) → 别人占着(2)。
      // 等级排在「有没有人占」前面是刻意的：用户要的是「被占了也要派」，如果让"无人占领的中型"
      // 盖过"被占的万吨"，就变成宁愿捡小的也不去抢大的 —— 与需求相反。
      rank: free ? 0 : (ourFleets > 0 ? 1 : 2),
    };
  });

  // 候选按「等级 → 能不能白捡 → 物品件数 → 资源件数 → uid」排。同等级里无人占领的先派；
  // 物品一样多才看资源（金币/红宝石）—— 见 rewardScore 的说明。
  const targets = treasures
    .filter((treasure) => treasure.claimable)
    .sort((a, b) => (b.color - a.color)
      || (a.rank - b.rank)
      || (b.itemScore - a.itemScore)
      || (b.resourceScore - a.resourceScore)
      || (a.uid - b.uid));

  const notes = [];
  // 有效期排在最前面：活动都结束了，后面「次数满了 / 没船 / 没货轮」都是废话。
  // 文案要和 formatTreasureSummary 那句错开 —— 日志里两行都印，重复一遍没意义。
  if (activity.expired) {
    notes.push('活动已结束，不再派船');
  } else if (activity.unknown) {
    notes.push('算不出活动有效期（无 SeasonRankInfo 也无 worldOpenTime），按未结束处理');
  }
  if (!survey.statsAvailable) {
    // 不知道今天还能领几次，就不派 —— 上限满了再派等于白烧 500 汽油/船。
    notes.push('拿不到今日奖励次数（TreasureLootStatsResponse），保守不派');
  } else if (dailyFull) {
    notes.push(`今日货轮奖励已满 ${today}/${limit}，明天 0 点重置`);
  }
  if (wanted.length === 0) {
    // 页面上把三个等级全取消勾选 = 明确表示"不抢"。不能悄悄回退成默认值。
    notes.push('一个货轮等级都没勾（页面「抢哪些」），不会派船');
  } else if (!activity.expired && survey.treasures.length > 0 && targets.length === 0 && !dailyFull) {
    const offLevel = treasures.filter((treasure) => !treasure.levelOk && treasure.progress < 100).length;
    const done = treasures.filter((treasure) => treasure.progress >= 100).length;
    const filled = treasures.filter((treasure) => treasure.levelOk && treasure.progress < 100 && treasure.slotsLeft <= 0).length;
    const reasons = [];
    if (offLevel > 0) reasons.push(`${offLevel} 个不是勾选的等级（只抢 ${colorText}）`);
    if (done > 0) reasons.push(`${done} 个已结算`);
    if (filled > 0) reasons.push(`${filled} 个我方已占满 ${MAX_GUILD_FLEETS} 支`);
    notes.push(`没有可抢的货轮${reasons.length > 0 ? `：${reasons.join('、')}` : ''}`);
  }

  return {
    now: survey.now,
    activity,
    statsAvailable: survey.statsAvailable,
    dailyLimit: limit,
    todayRewardTimes: today,
    remainingRewards,
    dailyFull,
    nextRefreshTime: survey.nextRefreshTime,
    counts: survey.counts,
    petrol,
    petrolCost,
    colors: wanted,
    colorText,
    maxFleets: Number(maxFleets) || DEFAULT_MAX_FLEETS,
    treasures,
    targets,
    fleets: (survey.fleets ?? []).map((fleet) => ({
      ...fleet,
      stateText: FLEET_STATE_TEXT[fleet.state] ?? `状态 ${fleet.state}`,
    })),
    idleFleets,
    notes,
  };
}

// 「接下来一段时间都不用再探测」的时间点 —— 返回 { until, reason, forever }。
//
// 判据必须是**确定要到某个时刻才会变**的状态，其余情况（没空闲船 / 汽油不够 / 船在航行）
// 都是几分钟内自己会变，静默掉就会漏掉刷新窗口，所以一律不跳过：
//   1. 活动结束（赛季封盘）→ 本季彻底不用再问；
//   2. 今日奖励满了 → 明天 0 点重置前，探测也不可能有任何动作；
//   3. 勾选等级里一个可抢的都没有 → 等到下一个整点刷新为止（进度只会涨、等级不会变、
//      「我方占满 10 支」也要等结算，这段时间里探测结果稳定）。
//
// 3 的等待时长用服务端给的 nextRefreshTime，但**封顶 12 小时**：万一服务端给了一个
// 脏时间，不能把整段挂机静默掉（22:00 收摊到次日 8:00 是 10 小时，落在上限内）。
export const SKIP_MAX_MS = 12 * 3600 * 1000;

export function skipUntilOf(view, { now = Date.now() } = {}) {
  if (view.activity?.expired) {
    return { until: Number.MAX_SAFE_INTEGER, reason: '活动已结束', forever: true };
  }
  if (view.dailyFull) {
    // 次日 00:00:05：留 5 秒给服务端重置（日志里出现过 0 点后几秒还是满的次数）。
    const reset = new Date(now);
    reset.setHours(24, 0, 5, 0);
    return {
      until: reset.getTime(),
      reason: `今日奖励已满 ${view.todayRewardTimes}/${view.dailyLimit}`,
      forever: false,
    };
  }
  const next = Number(view.nextRefreshTime) * 1000;
  if ((view.targets?.length ?? 0) === 0 && next > now) {
    const why = (view.colors?.length ?? 0) === 0
      ? '未勾选任何货轮等级'
      : `没有可抢的货轮（只抢 ${view.colorText}）`;
    return { until: Math.min(next, now + SKIP_MAX_MS), reason: why, forever: false };
  }
  return { until: 0, reason: '', forever: false };
}

// 每日奖励次数的统一口径（日志 / CLI / 页面同一个说法）：
//   已领 1/3（还能领 2 次） / 已领 3/3（已满，明天 0 点重置） / 已领 ?/3（拿不到次数就不派）
export function rewardCountText(view) {
  const limit = Number(view.dailyLimit) || FALLBACK_DAILY_LIMIT;
  const today = view.todayRewardTimes;
  if (today == null) return `已领 ?/${limit}（拿不到次数，保守不派）`;
  if (view.dailyFull) return `已领 ${today}/${limit}（已满，明天 0 点重置）`;
  return `已领 ${today}/${limit}（还能领 ${Math.max(0, limit - today)} 次）`;
}

// 计划：一次只抢**一个**货轮（勾选等级里最值的那个），把空闲舰队压上去把进度推快。
//
// 为什么不分兵：同联盟最多 10 支占同一个货轮，进度是"所有占领者同速推进"，船越多越快结算；
// 而每天只有 3 次奖励，一天 14 次刷新，分散到多个货轮只是把每场都拖慢 ——
// 拖慢就更容易被人抢走（对方一赢守军就换人）。
export function planTreasure(view, {
  maxFleets = DEFAULT_MAX_FLEETS,
} = {}) {
  const actions = [];
  const notes = [...(view.notes ?? [])];

  // 活动结束就彻底停手（不只是「这轮不派」）—— 这是给「活动下线后把整块删掉」留的闸门。
  // 说明文字已经在 view.notes 里（第一行），这里不再重复。
  if (view.activity?.expired) return { actions, notes };
  if (!view.statsAvailable || view.dailyFull) return { actions, notes };
  // 一个等级都没勾 = 用户明确不想抢（view.notes 里已经说明了），别再往下算。
  if (Array.isArray(view.colors) && view.colors.length === 0) return { actions, notes };

  const idle = (view.idleFleets ?? []).slice().sort((a, b) => b.power - a.power);
  if (idle.length === 0) {
    const fleets = view.fleets ?? [];
    if (fleets.length === 0) {
      notes.push('一艘舰队都没有（MyFleetsResponse 为空），派不了');
    } else {
      // 两种「不能派」要分开说：在航行/修理，和「已经在抢别的货轮」（treasureLootUid > 0）。
      const away = fleets.filter((fleet) => fleet.state !== 1);
      const onWay = fleets.filter((fleet) => fleet.state === 1 && fleet.treasureLootUid > 0);
      const parts = [];
      if (away.length > 0) parts.push(away.map((fleet) => `${fleet.buildingId}=${fleet.stateText}`).join(' '));
      if (onWay.length > 0) parts.push(`${onWay.map((fleet) => fleet.buildingId).join('、')} 正在抢别的货轮`);
      notes.push(`没有空闲舰队（${parts.join('，')}）`);
    }
  }

  const target = (view.targets ?? [])[0];
  if (!target) {
    if (Number(view.nextRefreshTime) > 0) {
      const left = Number(view.nextRefreshTime) - Math.floor(Date.now() / 1000);
      if (left > 0) notes.push(`下次整点刷新还有 ${Math.round(left / 60)} 分钟`);
    } else if (!view.dailyFull && view.statsAvailable) {
      notes.push(`现在没有勾选等级的货轮（${view.colorText}），等整点刷新`);
    }
    return { actions, notes };
  }
  if (idle.length === 0) return { actions, notes };

  // 条数上限：maxFleets（船本身的上限）、货轮剩余名额、汽油能负担的条数，三者取最小。
  // 汽油不够就少派几条 —— 派到一半卡住比不派更糟（船在航行途中）。
  const cap = Math.max(0, Number(maxFleets) || DEFAULT_MAX_FLEETS);
  const cost = Number(view.petrolCost) || FALLBACK_PETROL_COST;
  // 汽油够几支。view.petrol 为 0 视为「读不到」，不走这条（上面单独判）。
  const affordable = Number(view.petrol) > 0 ? Math.floor(Number(view.petrol) / cost) : 0;
  const count = Math.min(cap, target.slotsLeft, idle.length, affordable);
  if (count <= 0) {
    // petrol 为 0 有两种可能：库存里真的没有汽油，或者根本没读到库存。
    // 两种都不该派（派出去半路卡住比不派更糟），但原因要分开说。
    notes.push(Number(view.petrol) > 0
      ? `汽油不够派船：要 ${cost}/支，只剩 ${view.petrol}`
      : '读不到汽油（库存里没有「汽油」这一项），保守不派');
    return { actions, notes };
  }

  const picks = idle.slice(0, count);
  const shortOfPetrol = affordable < Math.min(cap, target.slotsLeft, idle.length);
  actions.push({
    kind: 'treasureDispatch',
    request: 'TreasureLootSendFleetsRequest',
    response: null,
    // 一条请求带多支舰队（客户端自动抢万吨就是一次塞全部空闲船）：
    // 少一次往返，也更容易在整点刷新的抢位窗口里挤进去。
    body: { uid: target.uid, fleetBuildingIds: picks.map((fleet) => fleet.buildingId) },
    // uid 天然唯一（同一货轮一轮只派一次）；派兵失败多是「被别人先占了 / 船刚被别的动作派走」，
    // 记进 rejected 会让这个点永远不再尝试，所以 transient。
    key: `treasureDispatch:${target.uid}`,
    transient: true,
    label: `派 ${picks.map((fleet) => fleet.buildingId).join('、')} 抢「${target.name}」`
      + (target.free ? '' : `（要先打赢联盟 ${target.ownerGuildIdx} 的守军，${target.ownerFleetNum} 支）`)
      + `（uid ${target.uid}，${target.progress}% → 100%）`
      + `，奖励 ${target.rewardText}`,
  });

  const restIdle = idle.length - picks.length;
  if (restIdle > 0) {
    notes.push(`${restIdle} 艘空闲船没派：`
      + (shortOfPetrol ? `汽油只够 ${affordable} 支` : `单次上限 ${cap} 支（货轮是共同推进度，3 支已经够快）`));
  }
  const restTargets = (view.targets ?? []).length - 1;
  if (restTargets > 0) {
    notes.push(`另有 ${restTargets} 个可抢的货轮排在后面：一天只有 ${view.dailyLimit} 次奖励，先集中打这一个`);
  }
  return { actions, notes };
}

// 一行概览：可领 1/3 · 货轮 8 个（无人 6） · 抢 万吨货轮 · 空闲舰队 0/2 · 22:00 刷新 · 有效至 11-12 23:59
export function formatTreasureSummary(view) {
  const activity = view.activity ?? null;
  // 活动结束就只印这一句 —— 后面的次数/舰队/刷新全是废话，日志里也更容易一眼看到。
  if (activity?.expired) {
    return `活动已结束（${stamp(activity.endAt)} 赛季收官），自动化停用 —— src/treasure.mjs 这段可以删了`;
  }
  const parts = [];
  if (!view.statsAvailable) {
    parts.push('奖励次数不可用');
  } else {
    const remain = view.remainingRewards == null ? '?' : view.remainingRewards;
    parts.push(view.dailyFull
      ? `今日奖励已满 ${view.todayRewardTimes}/${view.dailyLimit}`
      : `今日奖励 ${view.todayRewardTimes}/${view.dailyLimit}（还能领 ${remain} 次）`);
  }
  const free = (view.treasures ?? []).filter((treasure) => treasure.free && treasure.progress < 100).length;
  parts.push(`货轮 ${(view.treasures ?? []).length} 个（无人 ${free}）`);
  // 「抢哪些」每轮都印：等级是多选的，日志里要能一眼确认当前配置（默认只抢万吨）。
  parts.push(view.colors?.length ? `抢 ${view.colorText}` : '未勾等级（不派船）');
  parts.push(`空闲舰队 ${(view.idleFleets ?? []).length}/${(view.fleets ?? []).length}`);
  const ourFleetCount = (view.treasures ?? []).reduce((sum, treasure) => sum + (treasure.ourFleets ?? 0), 0);
  if (ourFleetCount > 0) parts.push(`我方 ${ourFleetCount} 支在抢`);
  if (Number(view.petrol) > 0) parts.push(`汽油 ${view.petrol}`);
  const refreshLeft = Number(view.nextRefreshTime) > 0
    ? Number(view.nextRefreshTime) - Math.floor(Date.now() / 1000) : 0;
  if (refreshLeft > 0) parts.push(`下次刷新 ${human(refreshLeft)}后`);
  // 有效期：每轮都印（用户要的是「日志里能看见还有多久到期」）。
  if (activity?.stopAt > 0) {
    parts.push(`有效至 ${stamp(activity.stopAt)}（还剩 ${human(activity.remainingSeconds)}）`);
  } else if (activity?.unknown) {
    parts.push('有效期未知');
  }
  return parts.join(' · ');
}

// 详细计划（CLI `treasure` 子命令用）。
export function formatTreasurePlan(view, plan) {
  const lines = [];
  const activity = view.activity ?? null;
  // 有效期单独一行、放最前面：这是"活动还剩多久"的唯一出处。
  if (activity?.stopAt > 0) {
    const tail = activity.expired
      ? '已过期，不再执行'
      : `还剩 ${human(activity.remainingSeconds)}`;
    lines.push(`活动有效期：S${activity.season} · 赛季结束 ${stamp(activity.endAt)}`
      + ` · 派船截止 ${stamp(activity.stopAt)}（新赛季前 1 小时封盘）· ${tail}`);
  } else if (activity?.unknown) {
    lines.push('活动有效期：算不出来（没有 SeasonRankInfo 也没有 worldOpenTime），按未结束处理');
  }
  // 活动结束了就不再列货轮/次数/舰队 —— 这些数字此时没有任何决策价值，只会显得「好像还能抢」。
  if (activity?.expired) {
    for (const note of plan.notes) lines.push(`跳过 ${note}`);
    return lines.join('\n');
  }
  const refreshLeft = Number(view.nextRefreshTime) > 0
    ? Number(view.nextRefreshTime) - Math.floor(Date.now() / 1000) : 0;
  lines.push(`每天 ${view.dailyLimit} 次奖励（已领 ${view.todayRewardTimes ?? '?'}）`
    + ` · ${view.colors?.length ? `抢 ${view.colorText}` : '未勾等级（不派船）'}`
    + ` · 汽油 ${view.petrol}（${view.petrolCost}/支）`
    + ` · 舰队 ${view.fleets.length} 艘（空闲 ${view.idleFleets.length}）`
    + (refreshLeft > 0 ? ` · 下次刷新 ${human(refreshLeft)}后` : ''));
  if ((view.treasures ?? []).length === 0) {
    lines.push('  现在世界里没有货轮（每天 8:00~22:00 整点刷新）');
  }
  for (const treasure of view.treasures ?? []) {
    // 「我方在途 / 在占」必须排在「被联盟 N 占」前面：协议只给联盟**编号**，
    // 我们拿不到自己的 guildIdx，所以自家在推的货轮也会是 ownerGuildIdx != 0。
    // 用舰队上的 treasureLootUid 反查才能认出「这是自己人」。
    // 「要打守军」是 2026-10-26 起的新行为：有人占着也派，只是排在无人占领的后面。
    const state = treasure.progress >= 100 ? '已结算'
      : !treasure.levelOk ? (view.colors?.length ? `等级没勾（只抢 ${view.colorText}）` : '等级没勾（一个都没勾）')
        : treasure.slotsLeft <= 0 ? `我方已占满 ${MAX_GUILD_FLEETS} 支`
          : treasure.ourFleets > 0 ? (treasure.free ? '我方在途' : '我方在占')
            : treasure.free ? '可抢（无人占领）'
              : `可抢（要先打赢联盟 ${treasure.ownerGuildIdx} 的 ${treasure.ownerFleetNum} 支守军）`;
    const ours = treasure.ourFleets > 0 ? ` · 我方 ${treasure.ourFleets} 支在抢` : '';
    lines.push(`  [${state}] ${treasure.name}（uid ${treasure.uid}）  进度 ${treasure.progress}%${ours}  ${treasure.rewardText}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of plan.notes) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}

function human(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  if (m < 60) return m % 60 > 0 ? `${m} 分 ${m % 60} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}
