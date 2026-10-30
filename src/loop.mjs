// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）
// → 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级） → 搁浅的货轮（按勾选等级抢货轮，默认只抢万吨）
// → 联盟情报（领奖 + 派舰队） → 海盗讨伐（派空闲船真出战打地图海盗） → 装备厂（收装备 + 锻造） → 海兽培育室（收成熟 + 排空位）
// → 贸易港口（3 艘货船逐格交货换 EXP/金币，返航后领 4 份藏品奖励）。
//
// 拾荒 / 农田 / 货轮 / 情报 / 海盗 / 锻造 / 挂机领取 / 培育 各自有独立间隔（gateDue）：自动循环每轮都会看一眼，
// 只有「距上次执行」超过自己的间隔才真的跑一次，其余轮次整段跳过（连探测请求都不发）。
//
// 货轮 → 情报 → 海盗 的先后顺序是刻意的：三段抢的是同一份资源 —— 空闲舰队。
// 货轮每小时整点才刷一次、万吨全服 1 艘，错过就没了；情报事件 6 小时才刷一批、
// 而且一直挂在那儿不会跑；海盗是自己的世界里刷的、没人抢，也不刷新倒计时。
// 所以先让货轮挑船，剩下的给情报，最后剩下的才去打海盗。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorld, summarizeFloaters, formatFloaters } from './world.mjs';
import { surveyRadar, viewRadar, planRadar, radarIdleUntil, DEFAULT_MIN_POWER_RATIO } from './radar.mjs';
import { surveyPirates, viewPirates, planPirates, formatPirateSummary, giveUpUntilOf, sweepCountText } from './pirate.mjs';
import { surveyEquip, planEquip, formatEquipSummary } from './equip.mjs';
import { surveyPet, planPet, formatPetSummary } from './pet.mjs';
import { surveyCargo, viewCargo, planCargo, formatCargoSummary, summarizeCargo, formatCargoGain, cargoDemandOf } from './tradePort.mjs';
import { surveyGuildOrder, viewGuildOrder, planGuildOrder, formatGuildOrderSummary } from './guildOrder.mjs';
import {
  surveyCityWar,
  viewCityWar,
  planCityWar,
  formatCityWarSummary,
  formatCityWarGain,
  claimWarOnlineReward,
  formatOnlineReward,
  warPollInterval,
  nextWarStartAt,
  DEFAULT_CW_PREP_LEAD_SEC,
  DEFAULT_CW_REPAIR_BELOW,
  DEFAULT_CW_MIN_POWER_RATIO,
  DEFAULT_CW_PETROL_RESERVE,
  DEFAULT_CW_MAX_FLEETS_PER_CITY,
} from './cityWar.mjs';
import {
  surveyGuildShip,
  viewGuildShip,
  planGuildShip,
  summarizeGuildShip,
  formatGuildShipSummary,
  formatGuildShipGain,
  bigNum,
} from './guildShip.mjs';
import {
  surveyYoudu,
  viewYoudu,
  planYoudu,
  runYouduSigns,
  runYouduActive,
  settleYouduEdict,
  formatYouduSummary,
  summarizeYoudu,
  formatYouduGain,
  isYouduClosed,
} from './youdu.mjs';
// ⚠ 海商王（活动 Trade）2026-10-28 已下线：第 10 段整段注释，下面这几个导入暂时用不到，
// 但**故意保留** —— 活动重开时解注释那一段就能直接跑，不用回来补 import（ESM 允许未使用的导入）。
import {
  surveyTradeKing,
  viewTradeKing,
  planTradeKing,
  formatTradeSummary,
  summarizeTrade,
  formatTradeGain,
  mergeLearned,
} from './tradeKing.mjs';
import { surveyIdle, planIdle, runIdle, formatIdleSummary } from './idle.mjs';
import { surveyGuildPack, planGuildPack, runGuildPack, formatGuildPackSummary } from './guildPack.mjs';
import {
  surveyTreasure,
  viewTreasure,
  planTreasure,
  formatTreasureSummary,
  skipUntilOf,
  rewardCountText,
  DEFAULT_MAX_FLEETS,
  DEFAULT_COLORS,
  colorsOf,
} from './treasure.mjs';

// 「暂停探测」这条日志的重复间隔：货轮静默窗可能长达 10 小时（22:00 收摊 → 次日 8:00），
// 每轮都印一句会把有用的记录挤没，所以只每 30 分钟报一次。
const SKIP_NOTICE_MS = 30 * 60 * 1000;
// 瞬成补产的节奏：排满 → 等 6 秒（服务端跑完 tick）→ 收 → 再排。
// 上限 4 趟 + 30 秒总预算：主循环间隔是 60 秒，这一段再长就会把整轮拖过间隔、
// 影响情报/货轮/海盗这些同样按 60 秒跑的段（用户明确要求「最多 4 次，避免异常」）。
const INSTANT_TOPUP_WAIT_MS = 6_000;
const INSTANT_TOPUP_MAX_PASSES = 4;
const INSTANT_TOPUP_BUDGET_MS = 30_000;
// 某一种作物的播种被服务端拒（典型 `item limit reached` = 该作物库存到上限）后，
// 这种作物歇多久再试。半小时足够工厂/订单吃掉一批农产品，也不至于白等一整场挂机。
const FARM_BLOCK_MS = 30 * 60 * 1000;
// 失败原因里出现这些字样就说明「这类作物先别种了」，换成数量少的那种。
const FARM_LIMIT_HINT = /item limit|storage full|limit reached|上限/i;
// 「领奖」类海商王动作：成功后可能带回「海商王加速」（商人指针），会影响下一轮要不要继续探测。
const TRADE_REWARD_KINDS = new Set(['tradePass', 'tradeTask', 'tradeReportReward', 'tradeAchieve']);
// 本轮有没有「成功领到奖」。领奖常带回「海商王加速」= 商会指针，而探测时的 owned 是旧快照，
// 所以要靠这个把静默窗推迟一轮（详见海商王段注释）。
export function tradeGainedReward(results) {
  return (results ?? []).some((entry) => entry?.ok === true && TRADE_REWARD_KINDS.has(entry?.step?.kind));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 拾荒的节流判定：海面漂浮物是慢慢刷出来的，跟循环的 60s 不是一回事 ——
// 每轮都发一遍既没收益，也更容易被服务端注意到「这个号的请求频率过于规整」。
// 所以给它一个间隔，只有距上次执行超过间隔才发。
// everyMs <= 0 表示不限制（等于旧行为：每轮都试）。
//
// 容差是必须的：tickAt 是**轮首**时刻，而 lastAt 是轮内某一段真正执行的时刻，
// 两者天然差几秒（一轮要跑 8 段）。没有容差时，「间隔 = 轮间隔」的模块
// （货轮 / 情报默认都是 60 秒）每轮都会差那几秒不满足条件 → 永远排在下一轮 →
// 实际变成两轮才跑一次，货轮整点刷新照样能错过。容差取 10%、最多 2 秒、最少 200ms。
export function gateSlack(everyMs) {
  const every = Number(everyMs) || 0;
  return Math.min(2_000, Math.max(200, every * 0.1));
}

export function gateDue(lastAt, everyMs, nowMs) {
  const every = Number(everyMs) || 0;
  if (!(every > 0)) return true;
  if (!Number(lastAt)) return true;
  return Number(nowMs) - Number(lastAt) >= every - gateSlack(every);
}

// 轮数与间隔的兜底判定单独导出，纯函数好测：
//   rounds 非法（"abc" → NaN）回退 1 轮 —— NaN 不满足 > 0，会静默变成「永久挂机」；
//   everyMs 非法或负数回退 60 秒 —— NaN 传给 setTimeout 会被钳成 1ms，等于毫秒级轰炸网关。
// rounds <= 0（一直跑）的既有语义保持不变。
export function loopTotal(rounds) {
  const n = Number(rounds);
  if (!Number.isFinite(n)) return 1;
  return n > 0 ? n : Infinity;
}

// 主循环两次「轮首」之间的最小间隔。
// 这个值和其它 gate 的 everyMs 语义**不一样**：别的填 0 表示「每轮最多做一次」，
// 而主循环填 0 等于「上一轮结束立刻开下一轮」—— 一小时几千次探测，
// 顺手把「间隔」输入框填 0 就会撞上。所以这里给一个下限。
export const MIN_LOOP_GAP_MS = 5_000;

export function loopGap(everyMs) {
  const n = Number(everyMs);
  if (!Number.isFinite(n) || n < 0) return 60_000;
  return Math.max(MIN_LOOP_GAP_MS, n);
}

// 间隔的展示文案：40 秒 / 5 分 20 秒 / 1 小时 3 分。
export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const rest = total % 60;
  if (m < 60) return rest > 0 ? `${m} 分 ${rest} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM > 0 ? `${h} 小时 ${restM} 分` : `${h} 小时`;
}

// 一轮结束时把两个闸门的状态塞进 summary，网页与日志都靠它显示「还差多久」。
function gateSummary(enabled, everyMs, lastAt, nowMs) {
  const every = Math.max(0, Number(everyMs) || 0);
  const waitMs = enabled && lastAt && every > 0 ? Math.max(0, lastAt + every - nowMs) : 0;
  return {
    enabled,
    everyMs: every,
    lastAt: lastAt ? Math.floor(lastAt / 1000) : null,
    waitSeconds: Math.ceil(waitMs / 1000),
  };
}

export async function runLoop(initialClient, protocol, {
  config = null,
  player = null,
  rounds = 1,
  everyMs = 60_000,
  allowMutate = false,
  allowPaid = false,
  allowSpeedUp = false,
  allowReroll = false,
  useSelectPack = true,
  maxPackPerRound,
  // 无需求配方的兑包门槛（见 planWorld 的 packGapMax）：默认 Infinity = 不设门槛，
  // 因为产品策略是「工厂无时无刻都在制造」。传数字收紧，传 0 退回「无需求绝不烧包」。
  packGapMax,
  pickUpFloaters = false,
  pickEveryMs = 0,
  // 瞬成补产（默认开）：瞬成配方排满后不用等下一轮才收 —— 等 6 秒再探一次、收掉、接着排，
  // 最多 4 趟。理由：瞬成产物排下去就完成，但「收取」要重新探测才看得见，
  // 一轮只走「排 6 个 → 下一轮收 6 个」这一格，60 秒才 6 个；库存被打空时要等好几轮才能补回来。
  instantTopUp = true,
  // 队列里允许堆几个非瞬成配方（见 world.mjs 的 maxLongQueue）：默认 1，多排不提升产能、
  // 只会把制造位吃光让瞬成排不进去。
  maxLongQueue = 1,
  // 农田跟拾荒一样有自己的节奏：作物最快也要 30 分钟成熟，每轮都探测纯属浪费请求，
  // 所以默认 2 分钟看一次（0 = 不限制，每轮都看）。开关默认开。
  farmEnabled = true,
  farmEveryMs = 120_000,
  // 联盟情报：领已完成的奖励 + 派舰队打能打过的事件。舰队派出后 state 变 MOVING，
  // 下一轮自然没有空闲船，但事件会随时刷出来，所以给它自己的节奏：默认 60 秒扫一次，
  // 时间没到就整段跳过（省掉 RadarInfo + MyFleets + AllItem 三个请求）。
  radarEnabled = true,
  radarEveryMs = 60_000,
  // 修船门槛（**百分数**，方便页面上直接填 80）：耐久低于这个百分比就把船留在港里修，
  // 不派出去打情报。实测出现过 0/2000 的船照样被派出去（服务端不拦），所以这条是硬保护。
  // 0 = 关掉修船（也等于不按耐久拦派兵）；100 = 不满就修。
  radarRepairBelow = 80,
  // 海盗讨伐：派空闲舰队**真出战**打世界地图上的海盗（ChallengePirateRequest）。
  // 跟免战扫荡（dailies 1010 的 PirateSweepRequest，一天 10 次、不动舰队）是两码事：
  // 真出战每次烧 300 汽油、不掉耐久，收益是首杀奖励 + 固定掉落。
  // 默认开、60 秒看一眼；它排在情报之后，只能捡货轮和情报没带走的空闲船。
  pirateEnabled = true,
  pirateEveryMs = 60_000,
  // 只打「没打过的下一个等级」（客户端自动讨伐同款口径，首杀才有 firstKillReward）。
  // 打开 = 连已通关的等级也打，只拿 fixedReward（每次 GOLD 250 + 材料）。
  pirateRepeat = false,
  // 一次最多派几艘船去打海盗（默认不限 = 有多少空闲船派多少）。
  pirateMaxPerRound = Infinity,
  // 「战力不够就先不打」（默认开）：战力不够的时候 60 秒探一次毫无收益，暂停探测，
  // 改成 30 分钟复查一次战力，够打了当轮立刻恢复（判据见 pirate.mjs 的 giveUpUntilOf ——
  // 只有「连全账号最强的船都打不过」才暂停；船出海/在修/汽油不够这些几分钟就会变的状态照旧重试）。
  pirateGiveUp = true,
  // 装备厂（锻造）：造好了收取 + 按部位均衡排下一件。一件蓝装原时长 1800 秒、
  // 减完「锻造时间」委任也要 25 分钟左右，所以默认 3 分钟看一眼就够。
  // 它比农田更值得勤看：同一时间只能造一件，造好不收等于整座工厂停产。
  forgeEnabled = true,
  forgeEveryMs = 180_000,
  // 海兽培育室：收成熟的 + 队列空位排新的一批。最短的蓝配方也要 4 小时，橙 36 小时，
  // 所以 5 分钟看一次足够；它跟锻造一样「队列空着就是白亏」，值得按自己的节奏勤看。
  petEnabled = true,
  petEveryMs = 300_000,
  // 品质上限（RED / ORANGE / PURPLE / BLUE，默认橙）：红配方标 season 2 且要 100 万金币，
  // 常态打不开；要给金币留余地就往下调。
  petMaxQuality = 'ORANGE',
  // 材料加速（投喂）：消耗该队列位 feedRequirements 里的材料，每次把剩余时间往前推
  // PetParamCfg「投喂减少培育时间」（本服 4 小时）。默认开 —— 不花钻石/加速器/广告，
  // 只吃「鱼肠线/粗铁/烤鱼」这类囤着没别的用途的培育材料。
  petFeed = true,
  // 贸易港口（建筑「货轮港口」）：3 艘货船各采购 4 种物品，交齐一格立得 EXP+金币，
  // 4 格交完船出发、几小时后返航，返航后领 4 份藏品奖励（徽章 / 经验 / 碎片）。
  // 全程免费（只吃工厂与农田产出的常规货），所以默认开；请求只有一个 CargoShipsRequest，
  // 默认 60 秒看一眼 —— 返航是小时级的，等一分钟不会漏。
  cargoEnabled = true,
  cargoEveryMs = 60_000,
  // 海商王（10~22 点的港口贸易活动）：在港就卖掉、买本港特产、开去「把这件货当紧缺」的港口。
  // 全程只花活动内的商会币，不花钻石；唯一消耗是商会指针（免费道具，联盟任务/战令产出）。
  // 一趟「卖+买+起航」就是一轮，所以 60 秒看一眼足够；在航且没指针时会静默到靠港。
  tradeEnabled = true,
  tradeEveryMs = 60_000,
  // 联盟订单（GuildOrder）：每天 0 点刷一单，交齐 3 种物品换公会经验 + 功勋（+联盟城市兵力）。
  // 请求体只有 cityId，不花货币/钻石，唯一成本是仓库里那 3 样货（多是加工品）—— 默认开。
  // 间隔 10 分钟：料是工厂产的（30~300 分钟一炉），看太勤只是白打 3 个请求，看太慢会错过刚补齐的时刻。
  // 交成功后静默到 nextRefreshTime（次日 00:00）。
  guildOrderEnabled = true,
  guildOrderEveryMs = 600_000,
  // 联盟商船（活动 GuildShip）：给「有船长、舱还空着」的船补一个货舱（材料得够，缺料绝不买），
  // 外加应聘没人当的船长（零成本赌队友）。名额只有 2 个、上船就锁到到港，所以节奏不用太快：
  // 补货窗口 30 分钟、刷新 3 小时一次，2 分钟看一眼足够抢到好舱。
  guildShipEnabled = true,
  guildShipEveryMs = 120_000,
  guildShipSeek = true,
  // 国战（联盟攻城）：每天 20:00–21:00。这一段的动作只有「派兵」和「修船」——
  // 舰队进城就自动驻守、战期内由服务端排进战斗点，不需要脚本在战期里反复派兵（10/28 实盘验证）。
  // 不宣战（脚本账号是普通成员，且取消宣战要 200 钻石），只跟随联盟已经宣好的城。
  // 平时整段静默：不在「战前 10 分钟 ~ 战期结束」之间就直接睡到下一场布署点。
  cityWarEnabled = true,
  cityWarEveryMs = 180_000,
  // 战期内的节奏：舰队打完就被服务端送回后方城，3 分钟一轮等于白等 —— 战期只有 1 小时，
  // 每多等一轮就少打一波。默认 60 秒（与拾荒/情报同节奏），战期外仍按 cityWarEveryMs。
  cityWarLiveEveryMs = 60_000,
  cityWarRepair = true,
  // 战前提前多少秒开始布署（默认 600 = 10 分钟，够修一次満耐久）。
  cityWarPrepLeadSec = DEFAULT_CW_PREP_LEAD_SEC,
  // 耐久低于这个比例就修（0.8 = 1600/2000，配置表 TipsDescCfg 的衰减线）。
  cityWarRepairBelow = DEFAULT_CW_REPAIR_BELOW,
  // 派兵的最低战力比：0 = 不拦（进城就能拿战斗点，打不过也有功勋）。
  cityWarMinPowerRatio = DEFAULT_CW_MIN_POWER_RATIO,
  // 派兵后至少留这么多汽油。
  cityWarPetrolReserve = DEFAULT_CW_PETROL_RESERVE,
  // 每座城最多派几艘。
  cityWarMaxFleetsPerCity = DEFAULT_CW_MAX_FLEETS_PER_CITY,
  // 酆都诡事（捞尸人联动）：只剩 4 个免费板块要做 —— 灭基地邪祟 + 领累计奖、转龙王罗盘 + 领积分奖、
  // 酆都法旨（服务端把答案放在 session.rune 里，0 显化直接提交 → 耐心满值拿最高档）、签到 + 每日活跃奖。
  // 付费板块（累充 / 每日特惠 / 礼遇战令 / 满减商店）一个请求都不会发。
  // 节奏 5 分钟：邪祟每 3 分钟刷 1 个（上限 6），罗盘券和贡品都是签到/日常给的，半天才凑够一张。
  youduEnabled = true,
  youduEveryMs = 300_000,
  // 关掉就只灭邪祟/签到，不动罗盘和法旨（保守模式）。
  youduSpin = true,
  youduEdict = true,
  // 用商会指针加速航程（免费道具）。关掉就是老老实实等 2 小时一趟。
  tradeAllowSpeed = true,
  // 领海商王战令的免费奖励（BattlePassGotRewardRequest type=3，只会发免费档）。
  tradePass = true,
  // 挂机领取：邮件附件 + 挂机本段收益 + 挂机等级奖励/升级。三件都免费、不发就白放着，
  // 但节奏是「小时级」的（收益 8 小时封顶、等级奖励是按级一次），所以 5 分钟看一次足够，
  // 不必每轮都多打 3 个请求（AfkInfo + EmailBox + 库存复用）。
  idleEnabled = true,
  idleEveryMs = 300_000,
  // 联盟礼包：队友丢进「联盟礼包库」的免费包，每个都能领一次、24 小时过期。
  // 一条空请求全领走，所以只需要「多久看一次库」—— 10 分钟足够（不会因为晚几分钟少拿东西）。
  guildPackEnabled = true,
  guildPackEveryMs = 600_000,
  // 搁浅的货轮（世界宝藏）：整点刷新、一天只有 3 次奖励，抢的是刷新后那几十秒的窗口，
  // 所以给它最短的间隔 —— 默认 60 秒（与情报同节奏）。它排在情报前面先挑船。
  treasureEnabled = true,
  treasureEveryMs = 60_000,
  // 一次最多派几支舰队抢同一个货轮；同联盟最多 10 支能占同一个，3 支已经够把小型推完。
  treasureMaxFleets = DEFAULT_MAX_FLEETS,
  // 抢哪些等级（协议 color，多选）：3 蓝(小型) / 4 紫(中型) / 5 橙(万吨)。默认只抢万吨。
  // 空数组 = 一个都不抢（页面上把三个全取消勾选时的语义，不是"回退默认"）。
  treasureColors = DEFAULT_COLORS,
  minPowerRatio = DEFAULT_MIN_POWER_RATIO,
  // 断线重连的钩子：返回新的 client（网关断线后 server 会新建一个 GameClient 实例，
  // 旧实例已经 stop 了，继续用它发请求只会一直 not connected）。不传 = 断线就按失败处理（CLI 一次性命令）。
  reconnect = null,
  // 时钟可注入：单测用它验证「等待 = 间隔 - 本轮耗时」，不必真的 sleep 一分钟。
  now = Date.now,
  // 每轮重新读一次的「当前生效参数」，返回 runLoop 的同名参数（间隔 / 开关 / 抢哪些等级…）。
  // 网页挂机传 () => session.loop：改完设置下一轮就生效，不用停掉重开。
  // 不传 = 全程用上面那些启动参数（CLI 行为不变）。
  live = null,
  sleep = defaultSleep,
  stop = { aborted: false },
  onRound,
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  // 重连会换实例，所以 client 必须是可变引用：server 的 reconnect 返回新实例后，
  // 下面十几处 `client.request(...)` 自动就跟上新的，不用逐个改。
  let client = initialClient;
  let linkError = '';
  const rejected = { tasks: new Set(), world: new Set(), radar: new Set(), pirate: new Set(), forge: new Set(), pet: new Set(), idle: new Set(), treasure: new Set(), cargo: new Set(), trade: new Set(), guildOrder: new Set(), guildShip: new Set(), guildPack: new Set(), cityWar: new Set(), youdu: new Set() };
  const history = [];
  // 拾荒的「上次执行时间」（毫秒）。0 表示还没执行过，第一次跑就立刻做一次。
  // 只在**真的排进了请求**时才更新 —— 海面没漂浮物时不该白等一个间隔。
  let lastPickAt = 0;
  // 农田同理：只有真的排了收/种动作才计时，没熟也没空地时不占用间隔。
  let lastFarmAt = 0;
  // 被服务端拒过的作物 → 解禁时间戳(ms)。撞一次 `item limit reached`（该作物库存到上限）
  // 就歇 30 分钟，别每轮拿同一条请求去撞墙刷日志；这期间换别的种子顶上。
  const farmBlocked = new Map();
  // 联盟订单：上次探测时间 + 交成功后的静默窗（睡到次日刷新点）。
  let lastGuildOrderAt = 0;
  let lastGuildShipAt = 0;
  // 联盟礼包：上次看库的时间。
  let lastGuildPackAt = 0;
  let guildOrderSkipUntil = 0;
  // 联盟商船的静默窗（船位满了就睡到自己那几条船最早释放的一刻）与英雄星级缓存。
  let guildShipSkipUntil = 0;
  let guildShipSkipReason = '';
  let guildShipSkipNoticedAt = 0;
  let gsHeroes = null;
  let gsHeroesAt = 0;
  // 国战：上次探测时间 + 静默窗（不在布署窗/战中就睡到下一场开战前）。
  // 静默窗可以长达一整天，所以只在「设窗/换窗」那一轮报一次，不按 30 分钟重复刷屏。
  let lastCityWarAt = 0;
  let cityWarSkipUntil = 0;
  let cityWarSkipReason = '';
  // 上一轮 survey 到的战期窗口（秒）。有它才能在「战期内」按 60 秒跑，而不是等到这一轮
  // 探测完才知道在战期里（那时已经白等了一个 180 秒的间隔）。
  let cityWarWindow = null;
  // 本轮战期节奏（60 秒）还是常规节奏（180 秒）。summary 与 gate 都用它，避免两处不一致。
  let cityWarInterval = 180_000;
  // 酆都诡事：上次探测时间。活动没开（服务端回 ACTIVE_END/74）也照常计时，
  // 否则每轮都要多打 3 个必败请求。
  let lastYouduAt = 0;
  // 活动下线之后（2026-11-11 结束）这一段还在：每 5 分钟 3 个 info 请求全是 prompt 74。
  // 所以「探测到没开」就退避 1 小时一次（和联盟商船同一套做法），日志里只报一句「暂停探测」。
  let youduSkipUntil = 0;
  let youduSkipReason = '';
  let youduSkipNotice = false;
  // 情报不一样：探测本身就会刷新事件列表，「读取情报 → 领奖 → 派兵」是一整套动作，
  // 所以只要这轮真的探测成功就计时（不管有没有事件可派），间隔到了才做下一次。
  let lastRadarAt = 0;
  // 但「间隔到了」不等于「值得再探」：事件打光之后服务端要等 nextRefreshTime 才刷新的，
  // 那段（实测 6 小时量级）里每 60 秒探一次全是空包。这里记到什么时候才再探，
  // 算法见 radar.mjs 的 radarIdleUntil（有任何事可做就返回 0，退回常规间隔）。
  let radarSkipUntil = 0;
  let radarSkipNoticedAt = 0;
  // 最近一次探测到的刷新时刻（秒）—— 只用来给页面显示「还有多久刷新」，不参与调度。
  let radarNextRefreshAt = 0;
  // 海盗讨伐同理：探测（海盗列表 + 舰队 + 击杀记录）成功就计时。
  let lastPirateAt = 0;
  // 「战力不够就先不打」的暂停窗（见 pirate.mjs 的 giveUpUntilOf）：命中期间这一段的
  // 3 个只读探测请求一次都不发，到点复查一次战力，够打了当轮立刻恢复。用户原话：
  // 「打不过的话，今天就可以先不打了」→ 后来收紧成「战力不够之前就不打」。
  let pirateSkipUntil = 0;
  let pirateSkipReason = '';
  let pirateSkipNoticedAt = 0;
  // 最近一次探测到的免战扫荡次数（网页上「每日野怪扫荡 · 已用 x/N，还剩 y 次」直接用，
  // 跟货轮的 treasureStats 一个套路：不为看个数字再打一遍探测请求）。
  let pirateStats = null;
  // 免战扫荡被服务端拒过（`PromptResponse = sweep times not enough`，已实测）就到今天结束为止不再扫：
  // 次数是服务端管的，我们的「上限 = 配置 10 + VIP」可能比真实上限低，被拒一次说明已经到顶，
  // 每 60 秒再试一次只会把日志刷成同一句失败。
  let sweepBlockedUntil = 0;
  // 锻造同理：探测是一整套「读装备厂 → 收取 → 排产」，探测成功就计时。
  let lastForgeAt = 0;
  // 培育同理：探测成功就计时（哪怕这一轮没有空位、也没有成熟的）。
  let lastPetAt = 0;
  // 挂机领取同理：探测成功就计时（哪怕这一轮没有可领的）。
  let lastIdleAt = 0;
  // 货轮同理：探测成功就计时（哪怕这一轮没有可抢的）。
  let lastTreasureAt = 0;
  // 贸易港口同理：探测成功就计时（哪怕三艘船都在航行、或者物品还不够交）。
  let lastCargoAt = 0;
  // 海商王同理：探测成功就计时（哪怕正在航行、或者不在 10~22 点的贸易时间里）。
  let lastTradeAt = 0;
  // 海商王的「在航且没指针」静默窗：2 小时一趟，每 60 秒打一次 TradeInfo 纯属浪费。
  let tradeSkipUntil = 0;
  let tradeSkipReason = '';
  let tradeSkipNoticedAt = 0;
  // 学到的「港口 → 挂哪些货」（停靠过才知道）。只在内存里，重启就重新学 ——
  // 它只是用来判断第二件货卖不卖得掉，丢了大不了少赚一点，不值得为它落盘。
  let tradeLearned = null;
  // 货船缺口 → 工厂排产需求（Map<itemId, 数量>），由第 9 段探测后更新、下一轮的排产使用。
  // null = 从来没探测过（第一次挂机），海面那一段会补一次只读探测。
  let cargoOrderDemand = null;
  // 三艘船全在航行时没有任何可做的（船在海上不采购，物品再怎么攒也得等它回来），
  // 所以直接静默到最早那艘返航为止 —— 否则 60 秒一次的只读请求纯属白打 5 小时。
  let cargoSkipUntil = 0;
  let cargoSkipReason = '';
  let cargoSkipNoticedAt = 0;
  // 「今日没机会了」的静默窗（毫秒时间戳）：命中后连探测请求都不发。
  // 判据见 treasure.mjs 的 skipUntilOf —— 奖励次数满了 / 活动结束 / 勾选等级里一个可抢的都没有。
  let treasureSkipUntil = 0;
  let treasureSkipReason = '';
  let treasureSkipForever = false;
  // 上次把「暂停探测」写进日志的时刻。静默窗可能长达 10 小时，每轮都印一句会把日志刷满，
  // 所以只在开始静默时印一次、之后每 30 分钟提醒一次（间隔见 SKIP_NOTICE_MS）。
  let treasureSkipNoticedAt = 0;
  // 最近一次印过的「卡住的日常」文案：内容不变就不再印（挂机每 60 秒一轮）。
  let lastStuckKey = '';
  // 最近一次探测到的每日奖励次数：网页直接显示它，不用为了"看个数字"再打 4 个请求。
  let treasureStats = null;
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出；
  // 非法输入的回退规则见 loopTotal()，别在这里再写一份。
  const total = loopTotal(rounds);

  // ---- 断线自愈 ------------------------------------------------------------
  // 一次掉线不该把整条挂机判死。2026-10-26 11:45:32 的归档里，网关用 code=1000 正常关闭了连接，
  // 同一轮剩下的 3 个动作全变成 `not connected`，紧接着海面探测拿不到 OnWaterResponse，
  // runLoop 一路抛到 server 的 catch，打出「自动挂机中止」—— 明明 60 秒后自己就重连上了。
  //
  // 判据看 `client.connected` 而不是错误文案：只有「抛错时连接已经断了」才值得重连重试；
  // 连接还在的失败（服务端拒绝、材料不够、storage full）原样抛，不能拿重连掩盖真正的原因。
  const ensureLink = async () => {
    if (client.connected) return true;
    if (!reconnect) return false;
    try {
      client = (await reconnect()) || client;
      linkError = '';
      return client.connected;
    } catch (error) {
      linkError = error.message;
      return false;
    }
  };
  const linkRetry = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      if (!reconnect || client.connected) throw error;
      // 重连本身失败就把重连的错误抛出去（「result=3」「login timeout」比 30 条 not connected 有用得多）。
      client = (await reconnect()) || client;
      return await fn();
    }
  };

  // 本轮末尾的等待：按「轮首 + 间隔」对齐，而不是「本轮结束后再等一个间隔」。
  // 以前是 sleep(gapMs)：一轮要做 8 段、耗时几秒到几十秒，所以设 60 秒实际是
  // 「60 秒 + 本轮耗时」一轮，越跑越漂，日志时间戳也对不上「每 60 秒一轮」。
  // 最后一轮不等待 —— 否则 `--rounds 1` 的命令会白等一个间隔才退出。
  //
  // 分段等待（每 1 秒醒一次）是必需的两个理由：
  //   ① 一次 sleep 到点的话，用户点了停止还要等满整个间隔（60 秒甚至 300 秒）才退出；
  //   ② 把间隔从 300 改成 5 想快点生效，也要等旧的长间隔走完。
  const waitNext = async (startedAt, intervalMs, hasNext) => {
    if (!hasNext || stop.aborted) return;
    const deadline = startedAt + intervalMs;
    while (!stop.aborted && now() < deadline) {
      // 间隔被改小（含热更新）：立刻开下一轮，不用等旧期限。
      const target = loopGap(pickAt(confOf(), 'everyMs', everyMs));
      const elapsed = now() - startedAt;
      if (elapsed >= target) return;
      await sleep(Math.min(1_000, Math.max(0, deadline - now())));
    }
  };

  // 每轮开头取一份「当前生效参数」：网页挂机传 live（读 session.loop），
  // 于是运行中改间隔 / 勾选不用停掉重开（以前必须停一次，前面跑完的轮次其实白等了）。
  // CLI 不传 live，就用启动时固定的那套值。
  const confOf = () => (typeof live === 'function' ? live() ?? {} : null);
  const pickAt = (conf, key, fallback) => (conf && conf[key] !== undefined ? conf[key] : fallback);

  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    const tickAt = now();
    const conf = confOf();
    // 主循环间隔每轮重读（热更新）；下限 5 秒见 loopGap。
    const everyNow = loopGap(pickAt(conf, 'everyMs', everyMs));
    // 所有段先给一份默认值：段级停止 / 某段提前跳出时，格式化函数也不能撞上 null。
    const part = () => ({ planned: 0, results: [], notes: [] });
    const summary = {
      round, startedAt: Math.floor(tickAt / 1000), link: '', everyMs: everyNow,
      tasks: part(), dailies: part(), world: { ...part(), population: '-', floaterLoot: null },
      idle: part(), treasure: part(), radar: part(), pirate: part(), forge: part(), pet: part(), cargo: part(),
      trade: part(),
      guildOrder: part(), guildShip: part(), guildPack: part(), cityWar: part(), youdu: part(),
    };

    // 一轮的统一收尾：补耗时 → 进历史 → 交给页面/日志。
    // 断线跳过、被停止、海面探测失败、正常结束这四条路都走它，
    // 否则漏掉某条路时页面上的「上一轮耗时」会是空的。
    const finish = () => {
      summary.elapsedMs = now() - tickAt;
      history.push(summary);
      onRound?.(summary);
    };

    // 上一轮断过线就先把连接接回来再干活 —— 否则这一轮七段会各自撞一次 not connected，
    // 计划全是 0、日志刷一屏红字。重连失败（网关对刚被踢下线的账号会回 result=3，约 1 分钟）
    // 就整轮跳过，等下一个间隔再试，不把挂机判死。
    if (reconnect && !client.connected) {
      const linked = await ensureLink();
      if (!linked) {
        summary.link = `连接已断开，重连失败：${linkError}；本轮跳过`;
        finish();
        await waitNext(tickAt, everyNow, round < total);
        continue;
      }
    }

    // 用户点了停止：不再开新的一段。以前只在轮首检查，所以点完「停止」还要等这一轮
    // 把剩下 7 段（几十个请求、最长一分钟）全跑完，看起来像按钮没反应。
    // 命中时顺手把这一轮的 summary 收尾，页面才能立刻看到「已停止」。
    const halted = () => {
      if (!stop.aborted) return false;
      summary.stopped = true;
      finish();
      return true;
    };

    // 1. 任务奖励
    if (halted()) break;
    try {
      const tasksSurvey = await linkRetry(() => surveyTasks(client, protocol, { config }));
      summary.tasks.planned = tasksSurvey.plan.length;
      if (tasksSurvey.plan.length > 0) {
        summary.tasks.results = await runTasks(client, protocol, tasksSurvey, {
          allowMutate,
          // 跨轮去重：被拒过的那条下一轮直接跳过，否则每轮都会再骚扰一次必败请求。
          rejected: rejected.tasks,
          onStep: (entry) => onStep?.({ round, phase: 'tasks', ...entry }),
        });
      }
    } catch (error) {
      // 探测失败只跳过这一段：整轮中止会让一次超时把整条挂机停掉，其它模块本来都能跑。
      summary.tasks.notes = [`任务领取探测失败：${error.message}`];
    }

    // 2. 日常。活跃度宝箱与每日免费赠礼也算进计划数，否则「任务都做完了、只差领取」的轮次会被整段跳过。
    if (halted()) break;
    try {
      const dailySurvey = await linkRetry(() => surveyDailies(client, protocol, { config, player }));
      const dailyActions = dailySurvey.tasks.reduce((sum, entry) => sum + (entry.actions ?? []).length, 0)
        + (dailySurvey.chests?.actions.length ?? 0)
        + (dailySurvey.gift?.actions.length ?? 0);
      summary.dailies.planned = dailyActions;
      // 「做了一部分却卡住」的日常单独说一句：否则计划数悄悄少 1，看不出是哪个任务、为什么。
      // 只挑 progress > 0 的（纯 0 的 blocked 是未开放功能，page 与 docs 里都有），
      // 且同一句话只印一次 —— 挂机是每 60 秒一轮，同一句重复几千行等于没有。
      const stuck = dailySurvey.tasks
        .filter((entry) => entry.status === 'blocked' && entry.reason && Number(entry.task.progress) > 0)
        .map((entry) => `${entry.task.title} ${entry.task.progress}/${entry.task.targetProgress}（${entry.reason}）`)
        .join('；');
      if (stuck && stuck !== lastStuckKey) {
        lastStuckKey = stuck;
        summary.dailies.notes.push(`卡住的日常：${stuck}`);
      }
      if (dailyActions > 0) {
        summary.dailies.results = await runDailies(client, protocol, dailySurvey, {
          allowMutate,
          allowPaid,
          onStep: (entry) => onStep?.({ round, phase: 'dailies', ...entry }),
        });
      }
    } catch (error) {
      summary.dailies.notes = [`日常探测失败：${error.message}`];
    }

    // 3. 海面世界。拾荒按自己的间隔节流：间隔没到就这轮不发，到点才发。
    //    （潜水已移除：DivingRequest 要上报「捡到了什么」，纯协议发空体只能拿回空奖励。见 docs。）
    //    所有开关 / 间隔都从 conf 取：网页运行中改了设置，这一轮就能生效。
    const pickOn = pickAt(conf, 'pickUpFloaters', pickUpFloaters);
    const pickEvery = pickAt(conf, 'pickEveryMs', pickEveryMs);
    const farmOn = pickAt(conf, 'farmEnabled', farmEnabled);
    const farmEvery = pickAt(conf, 'farmEveryMs', farmEveryMs);
    const pickDue = pickOn && gateDue(lastPickAt, pickEvery, tickAt);
    const farmDue = farmOn && gateDue(lastFarmAt, farmEvery, tickAt);
    // 贸易港口的开关在这里就取：工厂排产要用它的货船缺口当需求（见下面的 cargoDemand），
    // 所以不能等到最后一段才读。第 9 段复用这两个变量。
    const cargoOn = pickAt(conf, 'cargoEnabled', cargoEnabled);
    const cargoEvery = pickAt(conf, 'cargoEveryMs', cargoEveryMs);
    // 海面是这一轮的**地基**：后面的挂机领取（库存）、货轮（汽油）、情报/锻造/培育（建筑与库存）
    // 全都复用它的 survey。所以它拿不到就只能结束本轮，不能带着 null 往下跑（那会变成一串
    // 「Cannot read properties of null」把真正的原因埋掉）。
    // 断线（not connected / 拿不到 OnWaterResponse）先 linkRetry 重连一次再重试。
    summary.world = { planned: 0, notes: [], population: '-', results: [], floaterLoot: null };
    let worldSurvey = null;
    let worldPlan = null;
    if (halted()) break;
    try {
      worldSurvey = await linkRetry(() => surveyWorld(client, protocol, { config, player }));
      // 货船缺口 → 工厂排产需求。用上一轮（第 9 段）探测到的那份；
      // 从来没有探测过（挂机刚启动 / 刚打开贸易港口）就现在补一次只读探测 ——
      // 否则第一轮排产完全看不到货船要什么，得白等一整轮。
      if (cargoOn && cargoOrderDemand === null) {
        try {
          const firstCargo = await surveyCargo(client, protocol, { stock: worldSurvey.stock });
          cargoOrderDemand = cargoDemandOf(viewCargo(firstCargo));
        } catch {
          // 补探测失败不影响海面这一段：这一轮按「订单缺口」排，下一轮再说。
          cargoOrderDemand = null;
        }
      }
      // 解禁到期的作物（撞上限歇 30 分钟），过期的条目顺手清掉，别让表一直长。
      for (const [crop, until] of farmBlocked) if (until <= tickAt) farmBlocked.delete(crop);
      worldPlan = planWorld(worldSurvey, {
        config,
        allowSpeedUp: pickAt(conf, 'allowSpeedUp', allowSpeedUp),
        allowReroll: pickAt(conf, 'allowReroll', allowReroll),
        useSelectPack: pickAt(conf, 'useSelectPack', useSelectPack),
        maxPackPerRound: pickAt(conf, 'maxPackPerRound', maxPackPerRound),
        packGapMax: pickAt(conf, 'packGapMax', packGapMax),
        pickUpFloaters: pickDue,
        farm: farmDue,
        // 撞过上限的作物：到期的已经在下面清掉，没到期的就在 planWorld 里跳过。
        farmBlocked,
        // 工厂排产的额外需求：货船缺的货（空 Map = 只按订单缺口排）。
        cargoDemand: cargoOn ? cargoOrderDemand : null,
        // 队列里非瞬成配方的上限（默认 1）：多排不提升产能，还会把制造位吃光，
        // 让 0 秒的瞬成配方（布匹/淡水/生鱼片）连排队资格都没有。
        maxLongQueue: pickAt(conf, 'maxLongQueue', maxLongQueue),
      });
      summary.world.planned = worldPlan.actions.length;
      summary.world.notes = [...worldSurvey.notes, ...worldPlan.notes];
      summary.world.population = `${worldSurvey.population}/${worldSurvey.maxPopulation}`;
      if (worldPlan.actions.length > 0) {
        const { results, rejected: stillRejected } = await runWorld(client, protocol, worldPlan, {
          allowMutate,
          rejected: rejected.world,
          onStep: (entry) => onStep?.({ round, phase: 'world', ...entry }),
        });
        rejected.world = stillRejected;
        summary.world.results = results;
        summary.world.floaterLoot = summarizeFloaters(results);
        // 播种被拒 = 这种作物的库存已经到服务端上限（`item limit reached`）。
        // 记进 farmBlocked 歇 30 分钟，并把原因写进本轮 notes ——
        // 否则日志里只有一行「失败：server prompt: item limit reached」，看不出是哪种作物、
        // 也看不出已经换成别的作物在种（2026-10-27 事故现场就是这样，每轮刷一条，地一直空着）。
        for (const entry of results) {
          if (entry.ok !== false || entry.skipped) continue;
          if (entry.step?.kind !== 'farmPlant' || !FARM_LIMIT_HINT.test(String(entry.error ?? ''))) continue;
          const crops = [...new Set((entry.step.items ?? []).map(([id]) => id))];
          for (const crop of crops) farmBlocked.set(crop, tickAt + FARM_BLOCK_MS);
          summary.world.notes.push(`${crops.join('、')} 播种被拒（${entry.error}）：`
            + `该作物库存到上限，${humanDuration(FARM_BLOCK_MS / 1000)} 内改种别的种子`);
        }
      }
    } catch (error) {
      summary.world.notes = [...summary.world.notes, `海面探测失败，本轮跳过：${error.message}`];
      finish();
      await waitNext(tickAt, everyNow, round < total);
      continue;
    }

    // 3.5 瞬成补产：排满 → 等 6 秒 → 收 → 再排，最多 4 趟（共 ≤30 秒）。
    //
    // 为什么需要：瞬成配方（减免后 0 秒，如布匹 300s − 委任 774s）排下去就完成，但「收取」
    // 必须重新探测才看得见 —— 一轮只走「排 6 个 → 下一轮收 6 个」这一格，60 秒才 6 个。
    // 实测 2026-10-30 13:57:40→13:58:40 就是一批 6 个布匹，库存被打空后要好几轮才补回来。
    //
    // 只做「队列里没有长物品」的工厂（`action.queueLong === 0`）：有长物品在跑时，瞬成排下去
    // 只是排队，等 6 秒也收不到，白等还白花请求。
    // 稳态下每轮只跑 1 趟（上轮已经顶到存量上限，第一次探测就发现没得排）；只有库存被打空时才连跑。
    // 硬上限 4 趟 + 30 秒预算，保住主循环的 60 秒节奏。
    // 本轮主段**一条瞬成都没排**（到上限 / 料不够 / 队列被长物品占着）就整段不进 ——
    // 否则每轮白等 6 秒。
    const instantPlanned = (worldPlan?.actions ?? []).some((action) => action.kind === 'startProduce'
      && action.instant === true && action.queueLong === 0);
    if (instantPlanned && pickAt(conf, 'instantTopUp', instantTopUp) !== false && allowMutate) {
      const topUpStartAt = Date.now();
      const collected = new Map();
      let passes = 0;
      try {
        while (passes < INSTANT_TOPUP_MAX_PASSES && !halted()) {
          if (Date.now() - topUpStartAt > INSTANT_TOPUP_BUDGET_MS) break;
          await sleep(INSTANT_TOPUP_WAIT_MS);
          if (halted()) break;
          const fresh = await linkRetry(() => surveyWorld(client, protocol, { config, player }));
          const topPlan = planWorld(fresh, {
            config,
            useSelectPack: pickAt(conf, 'useSelectPack', useSelectPack),
            maxPackPerRound: pickAt(conf, 'maxPackPerRound', maxPackPerRound),
            packGapMax: pickAt(conf, 'packGapMax', packGapMax),
            cargoDemand: cargoOn ? cargoOrderDemand : null,
            // 补产只做两件事：收成品 + 排瞬成。建造/农田/拾荒留给主段，别在这一格里重复做。
            pickUpFloaters: false,
            farm: false,
            maxBuilds: 0,
            maxUpgrades: 0,
            maxLongQueue: pickAt(conf, 'maxLongQueue', maxLongQueue),
          });
          // 只挑两件事：收成品 + 排「队列里没有长物品」的瞬成。
          // 收取和排产分开判：**收**永远要做（主段排的那 6 个就等这一下），
          // 没得排只是说明下一趟不用再来了，不能因此把收取也跳过。
          const collects = topPlan.actions.filter((action) => action.kind === 'gainFactory');
          const starts = topPlan.actions.filter((action) => action.kind === 'startProduce'
            && action.instant === true && action.queueLong === 0);
          if (collects.length === 0 && starts.length === 0) break;
          const quick = [...collects, ...starts];
          const { rejected: stillRejected } = await runWorld(client, protocol, { actions: quick, notes: [] }, {
            allowMutate,
            rejected: rejected.world,
            window: 400,
            onStep: (entry) => onStep?.({ round, phase: 'world', ...entry }),
          });
          rejected.world = stillRejected;
          for (const action of quick) {
            for (const [id, num] of action.items ?? []) collected.set(id, (collected.get(id) ?? 0) + num);
          }
          passes += 1;
          // 收完了但没有新的瞬成可排（到存量上限 / 料不够 / 队列被长物品占着）→ 不用再等一趟。
          if (starts.length === 0) break;
        }
      } catch (error) {
        summary.world.notes = [...(summary.world.notes ?? []), `瞬成补产中断：${error.message}`];
      }
      if (passes > 0) {
        // 不打进 notes：概览行（formatLoopRound）有专门一格显示它，notes 只留 4 条，
        // 挤进去反而会把「为什么这座厂没排产」那类原因挤掉。
        summary.world.instant = { passes, items: [...collected], ms: Date.now() - topUpStartAt };
      }
    }

    // 4. 挂机领取：邮件附件 + 挂机本段收益 + 等级奖励 + 等级升级。
    //    放在海面之后是因为它直接复用 worldSurvey.stock（省一次 AllItemRequest）。
    //    日常那一段如果正好有「领取挂机收益(1004)」这条任务，会先把本段领掉 ——
    //    那时这里看到的是刚开的新一段，自然什么都不做，不会重复领。
    const idleOn = pickAt(conf, 'idleEnabled', idleEnabled);
    const idleEvery = pickAt(conf, 'idleEveryMs', idleEveryMs);
    const idleDue = idleOn && gateDue(lastIdleAt, idleEvery, tickAt);
    if (halted()) break;
    if (idleDue) {
      try {
        const idleSurvey = await linkRetry(() => surveyIdle(client, protocol, { config, player, stock: worldSurvey.stock }));
        const idlePlan = planIdle(idleSurvey, { now: Math.floor(tickAt / 1000), config });
        summary.idle.planned = idlePlan.actions.length;
        summary.idle.notes = idlePlan.notes;
        summary.idle.summary = formatIdleSummary(idleSurvey);
        if (idlePlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runIdle(client, protocol, idlePlan, {
            allowMutate,
            rejected: rejected.idle,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'idle', ...entry }),
          });
          rejected.idle = stillRejected;
          summary.idle.results = results;
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastIdleAt = tickAt;
      } catch (error) {
        summary.idle.notes = [`挂机领取探测失败：${error.message}`];
      }
    }

    // 5. 搁浅的货轮（世界宝藏）：按勾选的等级挑货轮（默认只抢万吨），
    //    一条请求把选中的空闲舰队全压上去。无人占领的优先，被占着的也派（打守军换我们占）。
    //    必须在情报之前 —— 情报是「有多少空闲船就派多少」，放在前面会把船抢光，
    //    货轮就永远排不上（整点刷新错过就没了，情报事件挂 6 小时还在）。
    //    复用 world 那一段的库存（汽油），所以这一轮只多 Stats + List + MyFleets 三个只读请求。
    // 已经确定「这段时间不可能有动作」就整段跳过 —— 一个请求都不发。
    // 探测要打 4 个只读请求（Stats + List + MyFleets + 赛季），奖满后每 60 秒打一遍纯属浪费。
    // 舰队耐久闸（比例）：页面上是百分数（默认 80），模块内部统一用比例。
    // 货轮 / 情报 / 海盗**三段共用这一个值** —— 它来自配置表 LoadingTipsCfg 的官方提示
    // 「城战中舰船耐久度低于 1600 会降低输出，增加受到的伤害」（本账号 maxDura 2000 → 80%），
    // 所以低于它的船一律先留在港里修（维修请求由情报那一段发），不派去打架。
    const repairBelowNow = Math.min(1, Math.max(0, Number(pickAt(conf, 'radarRepairBelow', radarRepairBelow)) || 0) / 100);
    const treasureOn = pickAt(conf, 'treasureEnabled', treasureEnabled);
    const treasureEvery = pickAt(conf, 'treasureEveryMs', treasureEveryMs);
    // 勾选等级 / 派船数也走 conf：网页上改「抢哪些」不用停掉重开。
    const treasureColorsNow = colorsOf(pickAt(conf, 'treasureColors', treasureColors));
    const treasureFleetsNow = Math.max(1, Math.floor(Number(pickAt(conf, 'treasureMaxFleets', treasureMaxFleets)) || treasureMaxFleets));
    const treasureSkipping = treasureOn && treasureSkipUntil > tickAt;
    const treasureDue = treasureOn && !treasureSkipping && gateDue(lastTreasureAt, treasureEvery, tickAt);
    if (halted()) break;
    if (treasureDue) {
      try {
        const treasureSurvey = await linkRetry(() => surveyTreasure(client, protocol, { config, player, stock: worldSurvey.stock }));
        const treasureView = viewTreasure(treasureSurvey, {
          config,
          colors: treasureColorsNow,
          maxFleets: treasureFleetsNow,
          // 耐久不够的船不派去抢（要打守军）—— 留在港里等情报段修。
          duraFloor: repairBelowNow,
        });
        const treasurePlan = planTreasure(treasureView, {
          maxFleets: treasureFleetsNow,
        });
        summary.treasure.planned = treasurePlan.actions.length;
        summary.treasure.notes = treasurePlan.notes;
        summary.treasure.summary = formatTreasureSummary(treasureView);
        // 奖励次数随探测一起更新：网页那块「已领 x/N」就是靠它，不发额外请求。
        treasureStats = {
          at: Math.floor(tickAt / 1000),
          dailyLimit: treasureView.dailyLimit,
          todayRewardTimes: treasureView.todayRewardTimes,
          remainingRewards: treasureView.remainingRewards,
          dailyFull: treasureView.dailyFull,
          nextRefreshTime: treasureView.nextRefreshTime,
          text: rewardCountText(treasureView),
        };
        // 静默窗只在「确定会持续一段时间」的状态下才设。noticedAt 归零 = 下一轮立刻把
        // 「暂停探测」印一次（那一轮印的是概览和原因，两句不重复），之后每 30 分钟才再报一次。
        const skip = skipUntilOf(treasureView, { now: tickAt });
        treasureSkipUntil = skip.until;
        treasureSkipReason = skip.reason;
        treasureSkipForever = Boolean(skip.forever);
        treasureSkipNoticedAt = 0;
        if (treasurePlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, treasurePlan, {
            allowMutate,
            rejected: rejected.treasure,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'treasure', ...entry }),
          });
          rejected.treasure = stillRejected;
          summary.treasure.results = results;
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastTreasureAt = tickAt;
      } catch (error) {
        summary.treasure.notes = [`货轮探测失败：${error.message}`];
      }
    }

    // 6. 联盟情报：先把已完成的奖励领掉，再把每艘空闲船各派去打一个「战力够」的事件。
    //    舰队只有 IDLE 能派，派出去后 state 变 MOVING，下一轮自然跳过；
    //    另外整段受自己的间隔约束（默认 60 秒），没到点就一次请求都不发。
    //    货轮那一段已经挑走了它要的船，这里只能拿剩下的。
    //    事件打光之后还要「睡到刷新」：详情见 radar.mjs 的 radarIdleUntil。
    const radarOn = pickAt(conf, 'radarEnabled', radarEnabled);
    const radarEvery = pickAt(conf, 'radarEveryMs', radarEveryMs);
    const ratioNow = pickAt(conf, 'minPowerRatio', minPowerRatio);
    const radarDue = radarOn && !(radarSkipUntil > tickAt) && gateDue(lastRadarAt, radarEvery, tickAt);
    if (halted()) break;
    if (radarDue) {
      try {
        const radarSurvey = await linkRetry(() => surveyRadar(client, protocol, {
          config,
          stock: worldSurvey.stock,
          repairBelow: repairBelowNow,
        }));
        const radarView = viewRadar(radarSurvey, { config, minPowerRatio: ratioNow, repairBelow: repairBelowNow });
        const radarPlan = planRadar(radarView, { minPowerRatio: ratioNow, repairBelow: repairBelowNow });
        summary.radar.planned = radarPlan.actions.length;
        summary.radar.notes = radarPlan.notes;
        // 事件为 0 时把「下次刷新」一起说出来 —— 否则日志里连续几十轮「事件 0 个」，
        // 看不出是没刷出来还是刷不出来。
        const refreshLeft = Number(radarView.nextRefreshTime) > 0
          ? Number(radarView.nextRefreshTime) - Math.floor(tickAt / 1000) : 0;
        const repairs = radarPlan.actions.filter((action) => action.kind === 'radarRepair').length;
        const lowest = (radarView.fleets ?? []).filter((fleet) => fleet.maxDurability > 0)
          .sort((a, b) => a.duraPct - b.duraPct)[0];
        summary.radar.summary = `Lv${radarView.level} · 事件 ${radarView.events.length} 个`
          + (radarView.events.length === 0
            ? (refreshLeft > 0 ? `（下次刷新 ${humanDuration(refreshLeft)}后）` : '（等刷新）')
            : '')
          + ` · 空闲舰队 ${radarView.idleFleets.length}`
          // 耐久报「最低那艘」的绝对值 + 百分比，比只写百分比短，也不会再出现
          // 「最低耐久 80%（低于 80% 就修）」这种自相矛盾的读法（1600 正好在阈值上 = 不用修）。
          + (lowest
            ? ` · 最低耐久 ${lowest.durability}/${lowest.maxDurability}（${Math.round(lowest.duraPct * 100)}%`
              + (lowest.needRepair ? '，要修）'
                : radarView.repairBelow > 0 ? `，阈值 ${Math.round(radarView.repairBelow * 100)}%）` : '，不修船）')
            : '')
          + (repairs > 0 ? ` · 本轮修 ${repairs} 艘` : '');
        if (radarPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, radarPlan, {
            allowMutate,
            rejected: rejected.radar,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'radar', ...entry }),
          });
          rejected.radar = stillRejected;
          summary.radar.results = results;
        }
        // 探测成功就算这次「读取情报」用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastRadarAt = tickAt;
        radarNextRefreshAt = Number(radarView.nextRefreshTime) || 0;
        // 事件打光 + 舰队全在港 + 没有待领奖 → 到服务端刷新前一次请求都不用发。
        // 只要还有任何一件事能做（有 state=1 的事件、有船在外面/在修、有奖没领），这里就是 0，
        // 保持原来的 60 秒节奏（见 radarIdleUntil 的注释）。
        const radarIdleAt = radarIdleUntil(radarView, { nowMs: tickAt });
        radarSkipUntil = radarIdleAt;
        if (radarIdleAt > tickAt) {
          summary.radar.summary += ` · 没事件可打了，${humanDuration((radarIdleAt - tickAt) / 1000)}后才刷新（期间不再请求）`;
        }
      } catch (error) {
        summary.radar.notes = [`情报探测失败：${error.message}`];
      }
    }

    // 7. 海盗讨伐：派空闲舰队**真出战**打世界地图上的海盗（ChallengePirateRequest）。
    //    只捡货轮和情报没带走的船 —— 那两段都排在它前面，所以这里经常是「0 艘空闲船，不派」。
    //    默认只打「下一个未击杀等级」（客户端自动讨伐同款口径）：打完击杀记录 +1，下一轮自动指向下一级；
    //    重复刷已通关等级要显式开 pirateRepeat（那只有 fixedReward，没有首杀奖励）。
    //    复用 world 段的库存（汽油）—— 这一轮只多打三个只读请求：AllPirate + MyFleets + PirateKillRecord。
    const pirateOn = pickAt(conf, 'pirateEnabled', pirateEnabled);
    const pirateEvery = pickAt(conf, 'pirateEveryMs', pirateEveryMs);
    const pirateRepeatNow = pickAt(conf, 'pirateRepeat', pirateRepeat) === true;
    const pirateCapNow = pickAt(conf, 'pirateMaxPerRound', pirateMaxPerRound);
    const pirateGiveUpNow = pickAt(conf, 'pirateGiveUp', pirateGiveUp) !== false;
    // 「战力不够」的暂停窗：命中后连探测请求都不发（判据见 pirate.mjs 的 giveUpUntilOf）。
    // 关闭开关时窗口直接失效 —— 否则取消勾选还要等窗口走完（最多 30 分钟）才恢复，像没生效。
    const pirateSkipping = pirateOn && pirateGiveUpNow && pirateSkipUntil > tickAt;
    const pirateDue = pirateOn && !pirateSkipping && gateDue(lastPirateAt, pirateEvery, tickAt);
    if (halted()) break;
    if (pirateDue) {
      try {
        const pirateSurvey = await linkRetry(() => surveyPirates(client, protocol, {
          config,
          stock: worldSurvey.stock,
          // 赛季要从 worldId 算（WorldPirateCfg 战力按 season_type_level 三元组查），
          // 拿不到就会退化成「取各赛季最高战力」，偏保守但不会打输。
          player,
        }));
        const pirateView = viewPirates(pirateSurvey, {
          config,
          minPowerRatio: ratioNow,
          repeat: pirateRepeatNow,
          // 耐久不够的船不出战：打野怪本身不掉耐久（WorldParamCfg = 0），
          // 但耐久 <80% 会降输出、挨打更疼，输了白烧 300 汽油。
          duraFloor: repairBelowNow,
        });
        const piratePlan = planPirates(pirateView, {
          maxPerRound: pirateCapNow,
          // 被拒过就今天不扫（真出战照常）。
          sweep: sweepBlockedUntil <= tickAt,
        });
        summary.pirate.planned = piratePlan.actions.length;
        summary.pirate.notes = piratePlan.notes;
        summary.pirate.summary = formatPirateSummary(pirateView);
        // 每日野怪扫荡次数快照：网页那行「已用 x/N，还剩 y 次」直接用，不为看个数字再探一次
        // （跟货轮的 treasureStats 同一个套路）。
        pirateStats = {
          at: Math.floor(tickAt / 1000),
          used: Number(pirateView.sweepUsed) || 0,
          max: Number(pirateView.sweepMax) || 0,
          left: Math.max(0, Number(pirateView.sweepLeft) || 0),
          text: sweepCountText(pirateView),
        };
        // 「战力不够就先不打」：暂停探测到下次复查（默认 30 分钟后），够打了当轮立刻恢复。
        // 只在「连全账号最强的船都打不过」时成立（见 giveUpUntilOf 的注释）——
        // 船出海 / 在修 / 汽油不够这些几分钟就会变的状态照旧按间隔重试。
        // ⚠️ 扫荡被服务端拒过之后，`sweepLeft` 还挂在那儿但其实已经扫不动了（次数真用完 / 一天的上限到了），
        // 判「能不能暂停」时要按 0 算 —— 否则永远因为「还有扫荡次数没用完」而不暂停，60 秒一轮白探一整天。
        const giveUp = giveUpUntilOf(
          sweepBlockedUntil > tickAt ? { ...pirateView, sweepLeft: 0 } : pirateView,
          { now: tickAt, enabled: pirateGiveUpNow },
        );
        if (giveUp.until > tickAt) {
          pirateSkipUntil = giveUp.until;
          pirateSkipReason = giveUp.reason;
          // 归零 = 下一轮立刻把「暂停探测」印一次（abort 那种「设窗那轮不印」的情况也不会漏）。
          pirateSkipNoticedAt = 0;
        } else {
          pirateSkipUntil = 0;
          pirateSkipReason = '';
        }
        if (sweepBlockedUntil > tickAt) {
          summary.pirate.notes = [...(summary.pirate.notes ?? []), '免战扫荡今天已被服务端拒绝过，不再尝试（明天 0 点重置）'];
        }
        if (piratePlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, piratePlan, {
            allowMutate,
            rejected: rejected.pirate,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'pirate', ...entry }),
          });
          rejected.pirate = stillRejected;
          summary.pirate.results = results;
          // 扫荡被拒 → 到明天 0 点前不再扫。失败原因通常是 `sweep times not enough`
          //（服务端上限比我们算的高/低都会走到这里），此时已经到顶，继续试没有意义。
          const sweepFail = results.find((entry) => entry.step?.kind === 'pirateSweep' && !entry.ok && !entry.skipped);
          if (sweepFail) {
            const nextDay = new Date(tickAt);
            nextDay.setHours(24, 0, 0, 0); // 明天 0 点（本地时间，服务端按自然日重置）
            sweepBlockedUntil = nextDay.getTime();
            summary.pirate.notes = [...(summary.pirate.notes ?? []),
              `免战扫荡被拒（${sweepFail.error}），今天不再扫`];
          }
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastPirateAt = tickAt;
      } catch (error) {
        summary.pirate.notes = [`海盗探测失败：${error.message}`];
      }
    }

    // 8. 装备厂（锻造）：造好了就收，收完接着排下一件；按部位件数最少的先补。
    //    复用 world 那一轮已经拉到的建筑与库存（含 GOLD），所以这轮只多一个 EquipsRequest。
    const forgeOn = pickAt(conf, 'forgeEnabled', forgeEnabled);
    const forgeEvery = pickAt(conf, 'forgeEveryMs', forgeEveryMs);
    const forgeDue = forgeOn && gateDue(lastForgeAt, forgeEvery, tickAt);
    if (halted()) break;
    if (forgeDue) {
      try {
        const equipSurvey = await linkRetry(() => surveyEquip(client, protocol, {
          config,
          stock: worldSurvey.stock,
          buildings: worldSurvey.buildings,
        }));
        const equipPlan = planEquip(equipSurvey, { config });
        summary.forge.planned = equipPlan.actions.length;
        summary.forge.notes = equipPlan.notes;
        summary.forge.summary = formatEquipSummary(equipSurvey);
        if (equipPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, equipPlan, {
            allowMutate,
            rejected: rejected.forge,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'forge', ...entry }),
          });
          rejected.forge = stillRejected;
          summary.forge.results = results;
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastForgeAt = tickAt;
      } catch (error) {
        summary.forge.notes = [`锻造探测失败：${error.message}`];
      }
    }

    // 9. 海兽培育室：成熟的一次领走，队列空位按「材料够的里面品质最高」排满。
    //    复用 world 那一轮拉到的建筑与库存（含 GOLD），这轮零额外请求。
    const petOn = pickAt(conf, 'petEnabled', petEnabled);
    const petEvery = pickAt(conf, 'petEveryMs', petEveryMs);
    const petQualityNow = pickAt(conf, 'petMaxQuality', petMaxQuality);
    const petFeedNow = pickAt(conf, 'petFeed', petFeed);
    const petDue = petOn && gateDue(lastPetAt, petEvery, tickAt);
    if (halted()) break;
    if (petDue) {
      try {
        const petSurvey = await linkRetry(() => surveyPet(client, protocol, {
          config,
          stock: worldSurvey.stock,
          buildings: worldSurvey.buildings,
        }));
        const petPlan = planPet(petSurvey, { config, maxQuality: petQualityNow, allowFeed: petFeedNow });
        summary.pet.planned = petPlan.actions.length;
        summary.pet.notes = petPlan.notes;
        summary.pet.summary = formatPetSummary(petSurvey)
          + (petFeedNow ? '' : ' · 材料加速关');
        if (petPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, petPlan, {
            allowMutate,
            rejected: rejected.pet,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'pet', ...entry }),
          });
          rejected.pet = stillRejected;
          summary.pet.results = results;
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastPetAt = tickAt;
      } catch (error) {
        summary.pet.notes = [`培育探测失败：${error.message}`];
      }
    }

    // 9. 贸易港口（建筑 buildingType「货轮港口」，UI 名「贸易港口」）：
    //    3 艘货船各采购 4 种物品，交一格立得 EXP+金币，4 格交完船出发，
    //    arriveTime 到了再领 4 份藏品奖励（徽章 / 经验 / 碎片）。全程免费。
    //    排在最后一段：它吃的是工厂和农田产出的常规物品，跟前面几段抢的是同一个仓库 ——
    //    前面都做完了，剩下的才拿去贸易，避免跟海面那段的交单/排产互相抢料。
    //    库存必须扣掉海面这一段已经排进计划的消耗（worldPlan.reserved），否则拿探测时的
    //    绝对量去交货会超卖，服务端必拒。
    // cargoOn / cargoEvery 在第 3 段（工厂排产要用货船缺口）就已经取过了，这里直接用。
    const cargoSkipping = cargoOn && cargoSkipUntil > tickAt;
    const cargoDue = cargoOn && !cargoSkipping && gateDue(lastCargoAt, cargoEvery, tickAt);
    if (halted()) break;
    if (cargoDue) {
      try {
        const cargoStock = new Map(worldSurvey?.stock ?? []);
        for (const [id, num] of worldPlan?.reserved ?? []) {
          cargoStock.set(id, Number(cargoStock.get(id) ?? 0) - Number(num ?? 0));
        }
        const cargoSurvey = await linkRetry(() => surveyCargo(client, protocol, { stock: cargoStock }));
        const cargoView = viewCargo(cargoSurvey);
        const cargoPlan = planCargo(cargoView);
        summary.cargo.planned = cargoPlan.actions.length;
        summary.cargo.notes = cargoPlan.notes;
        summary.cargo.summary = formatCargoSummary(cargoView);
        // 这份缺口下一轮喂给工厂排产（并入 planWorld 的 demand）。
        cargoOrderDemand = cargoDemandOf(cargoView);
        // 三艘都出海了：静默到最早那艘返航（船在海上不采购，这期间的库存变化不影响任何决策）。
        const allSailing = cargoView.ships.length > 0
          && cargoView.order.length === 0
          && cargoView.arrived.length === 0
          && cargoView.nextArriveAt * 1000 > tickAt;
        cargoSkipUntil = allSailing ? cargoView.nextArriveAt * 1000 : 0;
        cargoSkipReason = allSailing ? `三艘货船都在航行` : '';
        cargoSkipNoticedAt = 0;
        // 船都出海了就没有「缺货」这回事：清掉需求，否则工厂会照着过期的缺口一直产同一件东西。
        if (allSailing) cargoOrderDemand = new Map();
        if (cargoPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, cargoPlan, {
            allowMutate,
            rejected: rejected.cargo,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'cargo', ...entry }),
          });
          rejected.cargo = stillRejected;
          summary.cargo.results = results;
          summary.cargo.gain = formatCargoGain(summarizeCargo(results));
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastCargoAt = tickAt;
      } catch (error) {
        summary.cargo.notes = [`贸易港口探测失败：${error.message}`];
      }
    }

    // 10. 海商王（活动「Trade」，每天 10~22 点，17 个港口之间低买高卖）
    // ───────────────────────────────────────────────────────────────────────
    // ⚠ 2026-10-28：**活动已下线，本段整段停用**。代码原样保留在下面（判据/协议一行没删），
    //   只是不再探测：不发请求、日志里也不会出现「海商王」这一行。
    //   活动重开时恢复办法：去掉下面那对块注释标记（就是单独一行的斜杠星号 / 星号斜杠），
    //   再删掉末尾那个 4 行 stub 即可。
    //   页面开关 / `/api/trade` / CLI `trade` 都还在，不用改。
    //   它不跟前面任何一段抢资源（不用材料、不用舰队），所以一直排在最后、独立开关。
    /*
    // 10. 海商王（活动「Trade」，每天 10~22 点，17 个港口之间低买高卖）：
    //     在港 → 领奖 + 卖掉 + 共享商情 + 买本港特产 + 开去「把这件货当紧缺」的港口；
    //     在航 → 只用商会指针加速（免费道具）。
    //     它不跟前面任何一段抢资源（不用材料、不用舰队），所以排在最后、独立开关。
    //     在航且没指针时静默到靠港；不在贸易时间时静默到开市 —— 否则 2 小时里白打 120 次探测。
    const tradeOn = pickAt(conf, 'tradeEnabled', tradeEnabled);
    const tradeEvery = pickAt(conf, 'tradeEveryMs', tradeEveryMs);
    const tradeSpeedNow = pickAt(conf, 'tradeAllowSpeed', tradeAllowSpeed) === true;
    const tradePassNow = pickAt(conf, 'tradePass', tradePass) === true;
    const tradeSkipping = tradeOn && tradeSkipUntil > tickAt;
    const tradeDue = tradeOn && !tradeSkipping && gateDue(lastTradeAt, tradeEvery, tickAt);
    if (halted()) break;
    if (tradeDue) {
      try {
        const tradeSurvey = await linkRetry(() => surveyTradeKing(client, protocol, {
          learned: tradeLearned,
          // 复用海面那一段的库存表：商会指针存量就在里面，零额外请求。
          stock: worldSurvey?.stock ?? null,
        }));
        const tradeView = viewTradeKing(tradeSurvey, { config });
        const tradePlan = planTradeKing(tradeView, {
          config,
          allowSpeed: tradeSpeedNow,
          allowPass: tradePassNow,
        });
        summary.trade.planned = tradePlan.actions.length;
        summary.trade.notes = tradePlan.notes;
        summary.trade.summary = formatTradeSummary(tradeView);
        // 学到本港挂哪些货（下次判断「第二件货卖不卖得掉」时用）。
        if (tradeView.cargo.phase === 'dock' && tradeView.shelf.length > 0) {
          tradeLearned = mergeLearned(tradeLearned, {
            period: tradeView.period,
            cityId: tradeView.cargo.cityId,
            shelf: tradeView.shelf,
          });
        }
        if (tradePlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, tradePlan, {
            allowMutate,
            rejected: rejected.trade,
            window: 800,
            onStep: (entry) => onStep?.({ round, phase: 'trade', ...entry }),
          });
          rejected.trade = stillRejected;
          summary.trade.results = results;
          summary.trade.gain = formatTradeGain(summarizeTrade(results));
        }
        // ⚠ 静默窗必须放在**执行之后**算。
        // 领奖（战令免费档 / 联盟任务 / 商情奖励 / 成就）经常带回「海商王加速」= 商会指针，
        // 而 tradeView.speed.owned 是**探测那一刻**的快照。拿旧快照判「在航且没指针 → 等到靠港」，
        // 会让刚领到手的指针白等 2 小时（实盘 13:45 领到 2 个，船却仍挂 119 分钟）。
        // 所以：本轮成功领过奖就先不进静默窗，下一轮重探一次 —— 那时 owned 是新值，能立刻加速靠港。
        // 领完之后再问会被服务端拒（prompt=35，不算 ok），所以不会无限重探。
        const gainedReward = tradeGainedReward(summary.trade.results);
        // 静默窗：在航且没指针 → 等靠港；不在贸易时间 → 等开市。两种都不该每 60 秒探一次。
        if (tradeView.period === 0) {
          // 本期没开。开闭时间只由服务端运营后台决定，本地配置里查不到（ActivityTradeCfg 只有玩法参数），
          // 所以**不能**一次静默到明天 10 点：10-28 实盘 08:53 探到 period=0，若今天下午运营开新一期
          // 就整天错过了。开市时段内每小时探一次（2 个请求，成本可忽略），夜间照旧等到开市。
          if (tradeView.windowOpen) {
            tradeSkipUntil = tickAt + 3_600_000;
            tradeSkipReason = '本期海商王未开启（每小时探一次，等开新一期）';
          } else {
            tradeSkipUntil = tradeView.startAt * 1000 + 1_000;
            tradeSkipReason = '本期海商王未开启（开市后再探）';
          }
        } else if (tradeView.cargo.phase === 'sail' && !gainedReward
          && !(tradeSpeedNow && tradeView.speed.owned > 0)) {
          tradeSkipUntil = (tradeView.cargo.moveEndTime + 5) * 1000;
          tradeSkipReason = `航行中（剩 ${Math.ceil(tradeView.cargo.leftSeconds / 60)} 分钟）`;
        } else if (!tradeView.windowOpen) {
          tradeSkipUntil = tradeView.startAt * 1000 + 1_000;
          tradeSkipReason = `不在贸易时间（${new Date(tradeView.startAt * 1000).getHours()} 点开市）`;
        } else {
          tradeSkipUntil = 0;
          tradeSkipReason = '';
        }
        tradeSkipNoticedAt = 0;
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastTradeAt = tickAt;
      } catch (error) {
        summary.trade.notes = [`海商王探测失败：${error.message}`];
      }
    }
    */
    // 停用期间的 stub：gates 与日志格式化仍然引用这几个名字。
    // enabled=false 时 gateLine 直接返回空串，所以日志里不会多一行「海商王」。
    const tradeOn = false;
    const tradeEvery = 0;
    const tradeDue = false;
    const tradeSkipping = false;

    // 11. 联盟订单：每天 0 点刷一单，交齐 3 种物品换公会经验 + 功勋（外加联盟城市兵力）。
    //     请求体只有 cityId，不花货币/钻石 —— 唯一的成本是仓库里那 3 样货（多是加工品，
    //     工厂本来就在产），所以默认开。
    //     节奏按 10 分钟看一次：订单料是加工品，工厂产出周期 30~300 分钟，料不会一分钟就补齐，
    //     看太勤只是白打 3 个请求（GuildOrder + GuildCityInfo + CounterInfo）；
    //     看太慢又会错过「刚补齐」的时刻，白等工厂下一炉。
    //     交成功后静默到 nextRefreshTime（次日 00:00）：一天就这一单，没必要反复问。
    const guildOrderOn = pickAt(conf, 'guildOrderEnabled', guildOrderEnabled);
    const guildOrderEvery = pickAt(conf, 'guildOrderEveryMs', guildOrderEveryMs);
    const guildOrderSkipping = guildOrderOn && guildOrderSkipUntil > tickAt;
    const guildOrderDue = guildOrderOn && !guildOrderSkipping && gateDue(lastGuildOrderAt, guildOrderEvery, tickAt);
    if (halted()) break;
    if (guildOrderDue) {
      try {
        const orderSurvey = await linkRetry(() => surveyGuildOrder(client, protocol, {
          config,
          // 复用海面那一段的库存表（物品 + 资源都在里面），零额外请求。
          stock: worldSurvey?.stock ?? null,
          player,
        }));
        const orderView = viewGuildOrder(orderSurvey);
        const orderPlan = planGuildOrder(orderView, { config });
        summary.guildOrder.planned = orderPlan.actions.length;
        summary.guildOrder.notes = orderPlan.notes;
        summary.guildOrder.summary = formatGuildOrderSummary(orderView);
        if (orderPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, orderPlan, {
            allowMutate,
            rejected: rejected.guildOrder,
            window: 1200,
            onStep: (entry) => onStep?.({ round, phase: 'guildOrder', ...entry }),
          });
          rejected.guildOrder = stillRejected;
          summary.guildOrder.results = results;
          const done = results.some((entry) => entry.ok);
          if (done) {
            // 交完当天就别再问了，直接睡到次日刷新点（拿不到就用 4 小时兜底）。
            const refreshAt = Number(orderView.nextRefreshTime) * 1000;
            guildOrderSkipUntil = refreshAt > tickAt ? refreshAt : tickAt + 4 * 3600 * 1000;
            summary.guildOrder.notes = [...summary.guildOrder.notes,
              `今日订单已交，${new Date(guildOrderSkipUntil).toLocaleString('zh-CN', { hour12: false })} 刷新后再看`];
          }
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastGuildOrderAt = tickAt;
      } catch (error) {
        summary.guildOrder.notes = [`联盟订单探测失败：${error.message}`];
      }
    }

    // 12. 联盟商船（活动「GuildShip」）
    // ───────────────────────────────────────────────────────────────────────
    // ⚠ 2026-10-30：**活动已结束，本段整段停用**。代码原样保留在下面（判据/协议一行没删），
    //   只是不再探测：不发请求、日志里也不会出现「联盟商船」这一行。
    //   活动重开时恢复办法：去掉下面那对块注释标记（单独一行的斜杠星号 / 星号斜杠），
    //   再删掉末尾那 4 行 stub 即可。页面开关 / `/api/guildship` / CLI 也都一起注释了，要一并恢复。
    /*
    // 12. 联盟商船（活动「GuildShip」）：全联盟一起凑货舱，凑齐立刻启航，船长与登船成员拿**同样**奖励。
    //     能做的只有两件事：
    //       ① 给「已有船长、舱还空着」的船**补一个货舱** —— 但材料必须已经够（缺料时客户端会弹
    //          「购买」，那是花钻石买料，本工具不接那条路，缺料就等工厂产）；
    //       ② 应聘没人当的**船长** —— 零成本赌队友（凑不齐只遣返船长、退还已交的商品）。
    //     ⚠ 两条硬限制：船长**不能**给自己的船补货（实盘 `captain cannot resupply`）；
    //       每个玩家最多同时登 2 艘，且一旦上船就被锁到船到港（2.5/5/9 小时）才释放名额。
    //       所以船员优先、而且优先挑「空舱少 = 快启航」的船，名额才转得动。
    //     节奏 2 分钟：补货窗口只有 30 分钟、好舱位会被队友抢；但刷新 3 小时一次，再快也没意义。
    const guildShipOn = pickAt(conf, 'guildShipEnabled', guildShipEnabled);
    const guildShipEvery = pickAt(conf, 'guildShipEveryMs', guildShipEveryMs);
    const guildShipSeekNow = pickAt(conf, 'guildShipSeek', guildShipSeek) === true;
    const guildShipSkipping = guildShipOn && guildShipSkipUntil > tickAt;
    const guildShipDue = guildShipOn && !guildShipSkipping && gateDue(lastGuildShipAt, guildShipEvery, tickAt);
    if (halted()) break;
    if (guildShipDue) {
      try {
        // 英雄星级决定「能不能应聘某艘船的船长」。星级不会一分钟一变，缓存 30 分钟，
        // 省掉每轮一个 AllHeroRequest。拿不到就当「没有英雄」，只是这次不当船长，不影响补货。
        if (!gsHeroes || tickAt - gsHeroesAt > 30 * 60 * 1000) {
          const heroBody = await linkRetry(() => client.request('AllHeroRequest', {}, 'AllHeroResponse', 12_000));
          gsHeroes = new Map();
          for (const hero of heroBody?.heroes ?? []) {
            const id = String(hero.heroId ?? hero.name ?? hero.id ?? '');
            if (id) gsHeroes.set(id, { star: Number(hero.star) || 0, exStar: Number(hero.exclusive?.star) || 0 });
          }
          gsHeroesAt = tickAt;
        }
        const gsSurvey = await linkRetry(() => surveyGuildShip(client, protocol, { now: tickAt }));
        const gsView = viewGuildShip(gsSurvey, {
          config,
          // 复用海面那一段的库存表（物品 + 资源），零额外请求。
          stock: worldSurvey?.stock ?? null,
          heroes: gsHeroes,
          // playerId 是 int64，必须走 bigNum：直接用裸 low 会算成负数，
          // 于是「我是不是这艘船的船长」判成 false，计划器就会让船长去补自己的船（必被拒）。
          playerId: bigNum(player?.playerId),
          now: tickAt,
        });
        const gsPlan = planGuildShip(gsView, { config, allowSeek: guildShipSeekNow });
        summary.guildShip.planned = gsPlan.actions.length;
        summary.guildShip.notes = gsPlan.notes;
        summary.guildShip.summary = formatGuildShipSummary(gsView);
        if (gsPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, gsPlan, {
            allowMutate,
            rejected: rejected.guildShip,
            window: 1200,
            onStep: (entry) => onStep?.({ round, phase: 'guildShip', ...entry }),
          });
          rejected.guildShip = stillRejected;
          summary.guildShip.results = results;
          summary.guildShip.gain = formatGuildShipGain(summarizeGuildShip(results));
        }
        // 静默窗：
        //   period=0  → 本期没开。开闭时间只由运营后台定（GuildShipParamCfg 只有刷新点，没有起止），
        //               所以每小时探一次，别一次睡到明天 —— 中途开新一期也不会错过。
        //   船位满了   → 睡到自己那几条船里**最早释放**的一刻（在航的到港时间 / 补货截止时间）+5 秒。
        //               否则 2 分钟一次全是白打请求，而名额没释放前什么都做不了。
        // 服务端明确回「船位已满」→ 我们的账和服务端对不上（典型：在航的船没被 ownRun 给出）。
        // 别硬打请求，退避 10 分钟，下一轮重探时以服务端返回为准。
        const slotRejected = (summary.guildShip.results ?? []).some(
          (entry) => entry.ok === false && !entry.skipped && /slot limit|船位/i.test(String(entry.error ?? '')),
        );
        if (gsView.period === 0) {
          guildShipSkipUntil = tickAt + 3_600_000;
          guildShipSkipReason = '本期联盟商船未开启（每小时探一次）';
        } else if (slotRejected) {
          guildShipSkipUntil = tickAt + 10 * 60 * 1000;
          guildShipSkipReason = '服务端回「船位已满」（我们算出来还有空位），退避 10 分钟等状态同步';
        } else if (gsView.slotsLeft <= 0) {
          const releases = [];
          for (const run of gsView.ownRun) if (run.moveEndAt > 0) releases.push(run.moveEndAt * 1000);
          for (const ship of gsView.ships) if (ship.mine && ship.endAt > 0) releases.push(ship.endAt * 1000);
          const soonest = releases.length > 0 ? Math.min(...releases) + 5_000 : tickAt + 30 * 60 * 1000;
          guildShipSkipUntil = soonest > tickAt ? soonest : tickAt + 60_000;
          // 名额占用 = 码头上的 + **在航的**（在航的船还没到港，一样锁着名额）。
          const held = [
            ...gsView.myShips.map((row) => `#${row.shipId}${row.role === 'leader' ? '船长' : '船员'}`),
            ...(gsView.runningMine ?? []).map((row) => `#${row.shipId}在航`),
          ].join('、');
          guildShipSkipReason = `船位已满 ${gsView.slotsUsed ?? gsView.myShips.length}/${gsView.maxShips}（${held || '?'}），等最早一条释放`;
        } else {
          guildShipSkipUntil = 0;
          guildShipSkipReason = '';
        }
        guildShipSkipNoticedAt = 0;
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastGuildShipAt = tickAt;
      } catch (error) {
        summary.guildShip.notes = [`联盟商船探测失败：${error.message}`];
      }
    }
    */
    // 停用期间的 stub：gates 与概览行仍然引用这几个名字。
    // guildShipOn=false 时 gateLine 直接返回空串，日志里不会多一行「联盟商船」。
    const guildShipOn = false;
    const guildShipEvery = 0;
    const guildShipDue = false;
    const guildShipSkipping = false;

    // 12.5 联盟礼包（公会福利礼包）：队友买礼包 / 闯关 / 每日订单成单时会往「联盟礼包库」丢一个包，
    //      联盟所有成员**各能免费领一次**，24 小时后消失。不发请求就永远躺着 —— 纯白丢的收益
    //      （10/29 实测库里积了 25 个没领，含 RUBY / 抽卡券 / 藏品券 / 原料自选包）。
    //      请求 `GotGuildWelfarePackRequest` 是**空消息**：一条就把库里所有未领的一次结清，
    //      回包 `{ reward, lastGotTime }` 直接给出合并奖励，所以没有「先领哪个」的问题。
    //      判据照抄客户端 `_onBtnGot`：有包的 createTime > guild.gotWelfareTime。
    //      节奏 10 分钟：礼包是别人随时丢进来的，24 小时才过期，看太勤只是白打 GuildInfo。
    const guildPackOn = pickAt(conf, 'guildPackEnabled', guildPackEnabled);
    const guildPackEvery = pickAt(conf, 'guildPackEveryMs', guildPackEveryMs);
    const guildPackDue = guildPackOn && gateDue(lastGuildPackAt, guildPackEvery, tickAt);
    if (halted()) break;
    if (guildPackDue) {
      try {
        const packSurvey = await linkRetry(() => surveyGuildPack(client, protocol));
        const packPlan = planGuildPack(packSurvey);
        summary.guildPack.planned = packPlan.actions.length;
        summary.guildPack.notes = packPlan.notes;
        summary.guildPack.summary = formatGuildPackSummary(packSurvey);
        if (packPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runGuildPack(client, protocol, packPlan, {
            allowMutate,
            rejected: rejected.guildPack,
            onStep: (entry) => onStep?.({ round, phase: 'guildPack', ...entry }),
          });
          rejected.guildPack = stillRejected;
          summary.guildPack.results = results;
          // 领到之后库里就空了，把概览改成「已领完」——否则这一轮的日志会写
          // 「25 个待领」+「成功 领 25 个」两句自相矛盾的话。
          if (results.some((entry) => entry.ok)) {
            summary.guildPack.summary = formatGuildPackSummary({
              ...packSurvey,
              pending: 0,
              claimable: [],
              gotWelfareTime: results.find((entry) => entry.ok)?.step?.lastGotTime ?? packSurvey.gotWelfareTime,
            });
          }
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastGuildPackAt = tickAt;
      } catch (error) {
        summary.guildPack.notes = [`联盟礼包探测失败：${error.message}`];
      }
    }

    // 13. 国战（联盟攻城）：每天 20:00–21:00 一场，联盟宣战最多 3 座城。
    //     **这一段只做「派兵 + 修船」两件事**，不写任何战斗逻辑：
    //     舰队进城后自动驻守，战期内由服务端排进战斗点（10/28 实盘：派一次就够，
    //     21:48 复查船仍 IDLE 驻在城 73，联盟 3 城全占）。
    //     ⛔ 不宣战/不取消宣战（取消要 200 钻石）/不募兵 —— 只跟随联盟已宣的城。
    //     平时整段静默：不在「战前 10 分钟 ~ 战期结束」之间就睡到下一场布署点，
    //     所以白天不会每小时多打几条请求。
    const cityWarOn = pickAt(conf, 'cityWarEnabled', cityWarEnabled);
    const cityWarEvery = pickAt(conf, 'cityWarEveryMs', cityWarEveryMs);
    const cityWarLiveEvery = Math.max(30_000, Number(pickAt(conf, 'cityWarLiveEveryMs', cityWarLiveEveryMs)) || 60_000);
    const cityWarRepairOn = pickAt(conf, 'cityWarRepair', cityWarRepair) === true;
    const cityWarPrepLead = Math.max(60, Number(pickAt(conf, 'cityWarPrepLeadSec', cityWarPrepLeadSec)) || DEFAULT_CW_PREP_LEAD_SEC);
    // ⚠ 局部名不能和同名参数一样：`const cityWarRepairBelow = ... pickAt(conf, '…', cityWarRepairBelow)`
    // 右边引用的是自己 → TDZ「Cannot access before initialization」→ 整轮 loop 直接抛错。
    const cwRepairBelow = Number(pickAt(conf, 'cityWarRepairBelow', cityWarRepairBelow)) || DEFAULT_CW_REPAIR_BELOW;
    const cityWarMinRatio = Number(pickAt(conf, 'cityWarMinPowerRatio', cityWarMinPowerRatio)) || 0;
    const cityWarReserve = Number(pickAt(conf, 'cityWarPetrolReserve', cityWarPetrolReserve)) || 0;
    const cityWarPerCity = Math.max(1, Number(pickAt(conf, 'cityWarMaxFleetsPerCity', cityWarMaxFleetsPerCity)) || DEFAULT_CW_MAX_FLEETS_PER_CITY);
    // 战期只有 1 小时，而舰队一波打完就被服务端送回后方城 —— 3 分钟一轮等于每波白等 2 分钟。
    // 用上一轮记下的战期窗口判断「现在在不在战期」，免得等这一轮探测完才知道（那时已经晚了）。
    const cwNowSec = Math.floor(tickAt / 1000);
    cityWarInterval = warPollInterval(cityWarEvery, cityWarLiveEvery, cityWarWindow, cwNowSec);
    const cityWarSkipping = cityWarOn && cityWarSkipUntil > tickAt;
    const cityWarDue = cityWarOn && !cityWarSkipping && gateDue(lastCityWarAt, cityWarInterval, tickAt);
    // 静默窗可长达一整天（白天 → 次日 19:50），只在「设窗/换窗」那一轮报一次。
    let cityWarSkipNotice = false;
    if (halted()) break;
    if (cityWarDue) {
      try {
        const cwSurvey = await linkRetry(() => surveyCityWar(client, protocol, {
          config,
          // 复用海面那一段的库存表（物品 + 资源），零额外请求。
          stock: worldSurvey?.stock ?? null,
          player,
          prepLead: cityWarPrepLead,
          repairBelow: cwRepairBelow,
          now: tickAt,
        }));
        const cwView = viewCityWar(cwSurvey, { config, player, now: tickAt });
        const cwPlan = planCityWar(cwView, {
          repair: cityWarRepairOn,
          minPowerRatio: cityWarMinRatio,
          petrolReserve: cityWarReserve,
          maxFleetsPerCity: cityWarPerCity,
        });
        summary.cityWar.planned = cwPlan.actions.length;
        summary.cityWar.notes = cwPlan.notes;
        summary.cityWar.summary = formatCityWarSummary(cwView);
        if (cwPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, cwPlan, {
            allowMutate,
            rejected: rejected.cityWar,
            // 派兵/修船都没有配套 Response，靠 sendWatch 等 PromptResponse。1.5 秒足够。
            window: 1500,
            onStep: (entry) => onStep?.({ round, phase: 'cityWar', ...entry }),
          });
          rejected.cityWar = stillRejected;
          summary.cityWar.results = results;
          summary.cityWar.gain = formatCityWarGain(results);
        }

        // ---- 城战在线奖励（7 档）----
        // `WorldOnlineRwdCfg` 的档位是「累计在线 1/60/120/180/240/300/300 秒」，客户端是
        // **自动发** `GotWorldOnlineRwdRequest` 的（`WarOnlineReward` 里 stage==已领+1 && 计时到点），
        // 无头客户端不跑那段 UI → 10/29 实测整场 7 档一个都没领。
        // 战期内每轮补几次，领到服务端拒为止（拒 = 这一档还没解锁或已经领完）。
        if (allowMutate && cwView.phase === 'live') {
          const online = await claimWarOnlineReward(client, protocol);
          summary.cityWar.online = online;
          summary.cityWar.onlineText = formatOnlineReward(online);
        }

        // 静默窗：算下一次该醒的时刻。
        //   waiting/done → 睡到下一场「开战前 N 分钟」；战期是按天固定的，所以直接按整日推。
        //   unknown      → 服务端没给战期（没宣战 / 还没到 0 点推送），每小时探一次。
        //   战中被拒     → 战期内 1 分钟就重试（战期只有 1 小时，5 分钟退避等于白丢 5 分钟的战斗点）。
        const failedNow = (summary.cityWar.results ?? []).filter((entry) => entry.ok === false && !entry.skipped).length;
        const nextSkip = (() => {
          if (cwView.phase === 'waiting' || cwView.phase === 'done') {
            const nextStart = nextWarStartAt(cwSurvey.rawStart, cwSurvey.rawEnd, Math.floor(tickAt / 1000));
            if (nextStart > 0) {
              const at = nextStart * 1000 - cityWarPrepLead * 1000;
              return { until: Math.max(tickAt + 60_000, at), why: `未到布署时间（下一场 ${new Date(nextStart * 1000).toLocaleString('zh-CN', { hour12: false })} 开战，提前 ${Math.round(cityWarPrepLead / 60)} 分钟布署）` };
            }
            return { until: tickAt + 3_600_000, why: '服务端没给战期（每小时探一次）' };
          }
          if (cwView.phase === 'unknown') {
            return { until: tickAt + 3_600_000, why: '服务端没给战期（每小时探一次）' };
          }
          // 战前布署被服务端拒（prompt「not city war time」）：说明这座城还没进战期，
          // 提前派纯属白打请求（10/29 实测：19:50/19:55/20:00 各派 2 艘全被拒，
          // 20:01 才真的动）。既然服务端只认战期，就直接睡到开战，别 5 分钟撞一次墙。
          const warTimeRefused = (summary.cityWar.results ?? []).some(
            (entry) => entry.ok === false && !entry.skipped && /city war time/i.test(String(entry.error ?? '')),
          );
          if (warTimeRefused && cwSurvey.startAt * 1000 > tickAt) {
            const at = new Date(cwSurvey.startAt * 1000).toLocaleTimeString('zh-CN', { hour12: false });
            return { until: cwSurvey.startAt * 1000, why: `战前布署被拒（服务端只认战期内派兵），等到 ${at} 开战再派` };
          }
          if (failedNow > 0) {
            if (cwView.phase === 'live') {
              return { until: tickAt + cityWarInterval, why: `派兵/修船被拒，战期内每 ${Math.round(cityWarInterval / 1000)} 秒重试` };
            }
            return { until: tickAt + 5 * 60_000, why: '派兵/修船被拒，5 分钟后再试' };
          }
          return { until: 0, why: '' };
        })();
        // 「换窗」也算新消息（白天一次，次日 19:50 一次），两种情况都要印一行。
        cityWarSkipNotice = nextSkip.until > 0 && Math.abs(nextSkip.until - cityWarSkipUntil) > 60_000;
        cityWarSkipUntil = nextSkip.until;
        cityWarSkipReason = nextSkip.why;
        // 记下这一场的窗口：下一轮开算「现在在不在战期」不用再等探测结果，
        // 战期一到就按 60 秒的节奏跑（否则要多等一个 180 秒间隔才发觉开战了）。
        if (cwSurvey.startAt > 0 && cwSurvey.endAt > cwSurvey.startAt) {
          cityWarWindow = { startAt: cwSurvey.startAt, endAt: cwSurvey.endAt };
        }
        // 探测成功就算用掉了这一格时间；失败不记时，下一轮立刻重试。
        lastCityWarAt = tickAt;
      } catch (error) {
        summary.cityWar.notes = [`国战探测失败：${error.message}`];
      }
    }

    // 14. 酆都诡事（《疯狂水世界》×《捞尸人》联动）：只做 4 个免费板块 ——
    //     ① 驱邪除祟：基地里的邪祟，一个请求杀一只，杀完领累计里程碑奖（15 档，打满 75 只）
    //     ② 龙王罗盘：花「抽奖券」转盘，抽完领累计积分档位奖
    //     ③ 酆都法旨：花「入场券」开一局；**服务端把答案放在 session.rune 里**（客户端用它渲染
    //        符纸图案，shown 只是遮罩掩码），所以 0 显化直接提交 → 耐心留满 100 → 最高档奖励。
    //        显化一次扣 5 耐心、猜错扣 10，自动化里一次都不该显化。
    //     ④ 签到（14 天）+ 每日活跃度里程碑：签到靠回包推进（already checked in / not time yet），
    //        不能塞进静态计划，所以单独走 runYouduSigns。
    //     ⛔ 付费板块（每日累充 / 每日特惠 / 酆都礼遇战令 / 满减商店结账）一个请求都不发。
    //     节奏 5 分钟：邪祟每 3 分钟刷 1 个（同时最多 6 个），券和入场券半天才凑够一张。
    const youduOn = pickAt(conf, 'youduEnabled', youduEnabled);
    const youduEvery = pickAt(conf, 'youduEveryMs', youduEveryMs);
    const youduSpinNow = pickAt(conf, 'youduSpin', youduSpin) === true;
    const youduEdictNow = pickAt(conf, 'youduEdict', youduEdict) === true;
    const youduSkipping = youduOn && youduSkipUntil > tickAt;
    const youduDue = youduOn && !youduSkipping && gateDue(lastYouduAt, youduEvery, tickAt);
    youduSkipNotice = false;
    if (halted()) break;
    if (youduDue) {
      try {
        // 库存复用海面那一段的（`worldSurvey.stock`）—— 和货轮/情报/海盗/国战几段同一做法，
        // 省掉每轮一次 AllItemRequest（5 分钟一次，一天 288 次）。
        const ydSurvey = await linkRetry(() => surveyYoudu(client, { config, items: worldSurvey?.stock ?? null }));
        const ydView = viewYoudu(ydSurvey, { config });
        // 活动下线（2026-11-11 之后）时 3 个 info 请求全是 prompt 74 → 退避 1 小时再探，
        // 日志里只留一句「暂停探测」，别把每轮日志都刷成「未开启」。
        // ⚠ 只有服务端明确说「活动关了」才退避：`not connected`（掉线/刚重连）也走
        //   `open=false` 这条分支，按 1 小时退避就等于断一次网白丢一小时活动。
        if (!ydView.open && isYouduClosed(ydSurvey?.reason)) {
          const until = tickAt + 3_600_000;
          youduSkipNotice = Math.abs(until - youduSkipUntil) > 60_000;
          youduSkipUntil = until;
          youduSkipReason = `活动未开启（${String(ydSurvey?.reason ?? '').slice(0, 40)}，每小时探一次）`;
        } else {
          youduSkipUntil = 0;
          youduSkipReason = '';
        }
        const ydPlan = planYoudu(ydView, { config, spin: youduSpinNow, edict: youduEdictNow });
        summary.youdu.planned = ydPlan.actions.length;
        summary.youdu.notes = ydPlan.notes;
        summary.youdu.summary = formatYouduSummary(ydView);
        if (ydPlan.actions.length > 0) {
          const { results, rejected: stillRejected } = await runWorld(client, protocol, ydPlan, {
            allowMutate,
            rejected: rejected.youdu,
            window: 1000,
            onStep: (entry) => onStep?.({ round, phase: 'youdu', ...entry }),
          });
          rejected.youdu = stillRejected;
          summary.youdu.results = results;
          // 法旨：开局回包里就带答案，当轮直接交，不用白等一个间隔。
          const edictFix = await settleYouduEdict(client, results, {
            allowMutate,
            onStep: (entry) => onStep?.({ round, phase: 'youdu', ...entry }),
          });
          if (edictFix.results.length > 0) summary.youdu.results = [...results, ...edictFix.results];
          summary.youdu.planned = (summary.youdu.planned ?? 0) + edictFix.results.length;
          if (edictFix.notes.length > 0) summary.youdu.notes = [...(summary.youdu.notes ?? []), ...edictFix.notes];
          summary.youdu.gain = formatYouduGain(summarizeYoudu(summary.youdu.results));
        }
        // 签到与每日活跃都「试了才知道」，得按回包推进（already checked in / not time yet /
        // no claimable reward），塞进静态计划只会白打一堆必被拒的请求。
        if (ydView.open) {
          const signs = await runYouduSigns(client, {
            config,
            onStep: (entry) => onStep?.({ round, phase: 'youdu', ...entry }),
          });
          summary.youdu.results = [...(summary.youdu.results ?? []), ...signs.results];
          // 「计划 N」= 静态计划 + 按回包推进里真正发起的动作（否则签到/活跃度领到了却显示「计划 0」）。
          summary.youdu.planned = (summary.youdu.planned ?? 0) + signs.results.length;
          if (signs.notes.length > 0) summary.youdu.notes = [...(summary.youdu.notes ?? []), ...signs.notes];
          const active = await runYouduActive(client, {
            onStep: (entry) => onStep?.({ round, phase: 'youdu', ...entry }),
          });
          summary.youdu.results = [...(summary.youdu.results ?? []), ...active.results];
          summary.youdu.planned = (summary.youdu.planned ?? 0) + active.results.length;
          if (active.notes.length > 0) summary.youdu.notes = [...(summary.youdu.notes ?? []), ...active.notes];
          summary.youdu.gain = formatYouduGain(summarizeYoudu(summary.youdu.results));
        }
        // 探测成功（含「活动没开」）都算用掉这一格时间；网络异常不记时，下一轮立刻重试。
        lastYouduAt = tickAt;
      } catch (error) {
        summary.youdu.notes = [`酆都诡事探测失败：${error.message}`];
      }
    }

    // 计时以「本轮开始时刻」为准：动作已经排进计划，就算执行过，失败也不立刻重试
    // （下一轮照样被 rejected 或间隔挡住），避免失败时高频撞服务端。
    if (pickDue && worldPlan?.actions.some((action) => action.kind === 'pickUpFloater')) lastPickAt = tickAt;
    if (farmDue && worldPlan?.actions.some((action) => action.kind === 'farmHarvest' || action.kind === 'farmPlant')) lastFarmAt = tickAt;
    // 静默窗还在跑的时候，攒够 30 分钟才再报一次（第一次已经在设窗那一轮报过了）。
    const treasureSkipNotice = treasureSkipping && tickAt - treasureSkipNoticedAt >= SKIP_NOTICE_MS;
    if (treasureSkipNotice) treasureSkipNoticedAt = tickAt;
    // 情报的静默窗是「事件打光了，等刷新」，可以长达几小时 —— 同样只在设窗那轮记一次。
    const radarSkipping = radarOn && radarSkipUntil > tickAt;
    const radarSkipNotice = radarSkipping && tickAt - radarSkipNoticedAt >= SKIP_NOTICE_MS;
    if (radarSkipNotice) radarSkipNoticedAt = tickAt;
    // 贸易港口的静默窗是「船在海上」这一个原因，设窗那一轮印一次就够。
    const cargoSkipNotice = cargoSkipping && tickAt - cargoSkipNoticedAt >= SKIP_NOTICE_MS;
    if (cargoSkipNotice) cargoSkipNoticedAt = tickAt;
    // 海商王的静默窗有两种原因（在航 / 不在市），同样只在设窗那一轮 + 每 30 分钟报一次。
    const tradeSkipNotice = tradeSkipping && tickAt - tradeSkipNoticedAt >= SKIP_NOTICE_MS;
    if (tradeSkipNotice) tradeSkipNoticedAt = tickAt;
    // 海盗的暂停窗是「战力不够，先不打」—— 到点复查（默认 30 分钟），同样每 30 分钟才提一句。
    // 这里**重新算一次**而不是复用段首那个 pirateSkipping：静默窗可能就是这一轮刚设的，
    // 用段首的旧值会让「设窗那一轮」显示成「间隔未到」，看着像没生效。
    const pirateSkippingNow = pirateOn && pirateGiveUpNow && pirateSkipUntil > tickAt;
    const pirateSkipNotice = pirateSkippingNow && tickAt - pirateSkipNoticedAt >= SKIP_NOTICE_MS;
    if (pirateSkipNotice) pirateSkipNoticedAt = tickAt;
    // gates 里必须是**这一轮真正生效**的值（conf），否则网页上改了设置，
    // 状态行还按启动时的旧值算「还差多久」，看起来像改了没用。
    summary.gates = {
      pick: { ...gateSummary(pickOn, pickEvery, lastPickAt, tickAt), throttled: pickOn && !pickDue },
      farm: { ...gateSummary(farmOn, farmEvery, lastFarmAt, tickAt), throttled: farmOn && !farmDue },
      idle: { ...gateSummary(idleOn, idleEvery, lastIdleAt, tickAt), throttled: idleOn && !idleDue },
      treasure: {
        ...gateSummary(treasureOn, treasureEvery, lastTreasureAt, tickAt),
        // 静默中不算「间隔未到」—— 那是两种完全不同的原因，混在一起会看不出为什么一直没请求。
        throttled: treasureOn && !treasureDue && !treasureSkipping,
        skipped: treasureSkipping,
        skipReason: treasureSkipping ? treasureSkipReason : '',
        skipForever: treasureSkipping && treasureSkipForever,
        skipLeftSeconds: treasureSkipping && !treasureSkipForever
          ? Math.max(0, Math.ceil((treasureSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: treasureSkipping && !treasureSkipForever ? Math.floor(treasureSkipUntil / 1000) : null,
        skipNotice: treasureSkipNotice,
        // 最近一次探测到的每日奖励次数（网页直接显示，不用额外请求）。
        stats: treasureStats,
      },
      radar: {
        ...gateSummary(radarOn, radarEvery, lastRadarAt, tickAt),
        // 静默中不算「间隔未到」—— 「事件打光等刷新」和「60 秒间隔没到」是两件事，
        // 混在一起页面上就只是「还差 43 秒」，看不出其实要睡到几小时后。
        throttled: radarOn && !radarDue && !radarSkipping,
        skipped: radarSkipping,
        skipReason: radarSkipping ? '事件已打完，等刷新' : '',
        skipForever: false,
        skipLeftSeconds: radarSkipping ? Math.max(0, Math.ceil((radarSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: radarSkipping ? Math.floor(radarSkipUntil / 1000) : null,
        skipNotice: radarSkipNotice,
        // 服务端给的下次刷新时刻（秒）。页面拿它显示「还有多久刷新」，不额外发请求。
        nextRefreshAt: radarNextRefreshAt > 0 ? radarNextRefreshAt : null,
      },
      pirate: {
        ...gateSummary(pirateOn, pirateEvery, lastPirateAt, tickAt),
        // 静默中不算「间隔未到」：一个是「打不过，今天先不打」，一个是「60 秒还没到」。
        throttled: pirateOn && !pirateDue && !pirateSkippingNow,
        skipped: pirateSkippingNow,
        skipReason: pirateSkippingNow ? pirateSkipReason : '',
        skipForever: false,
        skipLeftSeconds: pirateSkippingNow ? Math.max(0, Math.ceil((pirateSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: pirateSkippingNow ? Math.floor(pirateSkipUntil / 1000) : null,
        skipNotice: pirateSkipNotice,
        // 最近一次探测到的每日野怪扫荡次数（网页直接显示，不用额外请求）。
        stats: pirateStats,
      },
      forge: { ...gateSummary(forgeOn, forgeEvery, lastForgeAt, tickAt), throttled: forgeOn && !forgeDue },
      pet: { ...gateSummary(petOn, petEvery, lastPetAt, tickAt), throttled: petOn && !petDue },
      cargo: {
        ...gateSummary(cargoOn, cargoEvery, lastCargoAt, tickAt),
        // 静默中不算「间隔未到」：两种完全不同的原因，混在一起就看不出为什么一直没请求。
        throttled: cargoOn && !cargoDue && !cargoSkipping,
        skipped: cargoSkipping,
        skipReason: cargoSkipping ? cargoSkipReason : '',
        skipForever: false,
        skipLeftSeconds: cargoSkipping ? Math.max(0, Math.ceil((cargoSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: cargoSkipping ? Math.floor(cargoSkipUntil / 1000) : null,
        skipNotice: cargoSkipNotice,
      },
      trade: {
        ...gateSummary(tradeOn, tradeEvery, lastTradeAt, tickAt),
        throttled: tradeOn && !tradeDue && !tradeSkipping,
        skipped: tradeSkipping,
        skipReason: tradeSkipping ? tradeSkipReason : '',
        skipForever: false,
        skipLeftSeconds: tradeSkipping ? Math.max(0, Math.ceil((tradeSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: tradeSkipping ? Math.floor(tradeSkipUntil / 1000) : null,
        skipNotice: tradeSkipNotice,
      },
      guildOrder: {
        ...gateSummary(guildOrderOn, guildOrderEvery, lastGuildOrderAt, tickAt),
        throttled: guildOrderOn && !guildOrderDue && !guildOrderSkipping,
        // 「今天这单已经交了、睡到明早刷新」跟「间隔未到」是两回事，页面上要分得清。
        skipped: guildOrderSkipping,
        skipReason: guildOrderSkipping ? '今日已交，等 00:00 刷新' : '',
        skipForever: false,
        skipLeftSeconds: guildOrderSkipping ? Math.max(0, Math.ceil((guildOrderSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: guildOrderSkipping ? Math.floor(guildOrderSkipUntil / 1000) : null,
        skipNotice: false,
      },
      guildShip: {
        ...gateSummary(guildShipOn, guildShipEvery, lastGuildShipAt, tickAt),
        throttled: guildShipOn && !guildShipDue && !guildShipSkipping,
        // 「船位满了在等释放」跟「间隔未到」是两回事，页面上要分得清。
        skipped: guildShipSkipping,
        skipReason: guildShipSkipping ? guildShipSkipReason : '',
        skipForever: false,
        skipLeftSeconds: guildShipSkipping ? Math.max(0, Math.ceil((guildShipSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: guildShipSkipping ? Math.floor(guildShipSkipUntil / 1000) : null,
        // 静默窗可以很长（一场 9 小时的超凡船），但只在设窗那轮报一次，之后每 30 分钟提醒。
        skipNotice: guildShipSkipping && tickAt - guildShipSkipNoticedAt >= SKIP_NOTICE_MS,
      },
      guildPack: { ...gateSummary(guildPackOn, guildPackEvery, lastGuildPackAt, tickAt), throttled: guildPackOn && !guildPackDue },
      cityWar: {
        // 战期内用 60 秒节奏（cityWarInterval），页面上的倒计时才不会和服务端实际节奏打架。
        ...gateSummary(cityWarOn, cityWarInterval, lastCityWarAt, tickAt),
        throttled: cityWarOn && !cityWarDue && !cityWarSkipping,
        // 「战斗还没开始/已经打完，睡到下一场布署点」跟「间隔未到」是两回事，页面上要分得清。
        skipped: cityWarSkipping,
        skipReason: cityWarSkipping ? cityWarSkipReason : '',
        skipForever: false,
        skipLeftSeconds: cityWarSkipping ? Math.max(0, Math.ceil((cityWarSkipUntil - tickAt) / 1000)) : 0,
        skipUntil: cityWarSkipping ? Math.floor(cityWarSkipUntil / 1000) : null,
        skipNotice: cityWarSkipNotice,
      },
      youdu: {
        ...gateSummary(youduOn, youduEvery, lastYouduAt, tickAt),
        throttled: youduOn && !youduDue && !youduSkipping,
        // 活动下线后每小时才探一次；gateLine 靠这几个字段印「暂停探测：…，N 分后再试」。
        skipped: youduSkipping,
        skipReason: youduSkipReason,
        skipUntil: youduSkipping ? Math.floor(youduSkipUntil / 1000) : null,
        skipLeftSeconds: youduSkipping ? Math.max(0, Math.ceil((youduSkipUntil - tickAt) / 1000)) : 0,
        skipNotice: youduSkipNotice,
      },
    };

    // 本轮耗时：页面上直接能看到「一轮 12 秒」，据此判断间隔是否够用。
    finish();
    // 按「轮首 + 间隔」对齐，不再「结束后再等一个间隔」（那会让周期 = 间隔 + 耗时）。
    await waitNext(tickAt, everyNow, round < total);
  }

  return { history, rejected };
}

// 动作 kind → 中文名。循环每轮按 kind 聚合，比一条条列 71 行可读得多。
const KIND_TEXT = {
  gainFactory: '收成品',
  collectProduct: '收建筑产物',
  finishUpgrade: '竣工',
  build: '建造',
  finishOrder: '交订单',
  denyOrder: '拒单',
  startProduce: '排产',
  farmHarvest: '收农田',
  farmPlant: '播种',
  radarReward: '领情报奖励',
  radarDispatch: '派舰队',
  radarRepair: '维修舰队',
  pirateChallenge: '讨伐海盗',
  pirateSweep: '免战扫荡',
  treasureDispatch: '抢货轮',
  equipPick: '收装备',
  equipMake: '锻造',
  petPick: '收海兽',
  petBreed: '培育海兽',
  petFeed: '材料加速',
  cargoFill: '交货',
  cargoReward: '领贸易奖励',
  tradeSell: '海商王卖货',
  tradeBuy: '海商王买货',
  tradeSail: '海商王起航',
  tradeSpeed: '商会指针加速',
  tradeShare: '共享商情',
  tradeAchieve: '领海商王成就',
  tradeTask: '领联盟任务',
  tradeReportReward: '领商情奖励',
  tradePass: '领海商王战令',
  guildOrder: '交联盟订单',
  guildShipOrder: '商船补货',
  guildShipSeek: '应聘船长',
  cityWarMove: '国战派兵',
  cityWarRepair: '国战修船',
  youduKill: '灭邪祟',
  youduEvilClaim: '领驱邪奖励',
  youduSpin: '转罗盘',
  youduWheelClaim: '领罗盘积分',
  youduEdictStart: '开法旨',
  youduEdictGuess: '交法旨',
  youduSign: '签到',
  youduActive: '领活跃度',
  mailQuickGet: '领邮件',
  afkDraw: '挂机收益',
  afkLevelDraw: '挂机等级奖励',
  afkUpgrade: '挂机升级',
  upgrade: '升级',
  speedUpUpgrade: '加速建造',
  speedUpProduce: '加速生产',
  selectPack: '兑材料',
  pickUpFloater: '拾荒',
};

// 每一部分的明细：成功的按 kind 聚合、失败逐条列（最多 limit 条）、跳过的按原因聚合。
// 成功那一行必须带上**具体物品**（收成品 淡水×2、木板×1 / 排产 木板×3）：
// 只写「收成品×3」看不出收到什么，等于没记。物品来自 step.items（由 planWorld / planEquip 填）。
const OK_ITEM_LIMIT = 8;
function detailLines(part, limit = 4) {
  const lines = [];
  const okBy = new Map();
  for (const entry of part.results) {
    if (entry.skipped || !entry.ok) continue;
    const step = entry.step ?? {};
    const name = KIND_TEXT[step.kind] ?? step.kind ?? '其他';
    const slot = okBy.get(name) ?? { count: 0, items: new Map(), unit: step.unit ?? '' };
    slot.count += 1;
    for (const pair of step.items ?? []) {
      const [id, num] = pair ?? [];
      const n = Math.abs(Number(num) || 0);
      if (id && n > 0) slot.items.set(id, (slot.items.get(id) ?? 0) + n);
    }
    okBy.set(name, slot);
  }
  if (okBy.size) {
    // 一类动作一行：一条 26 个动作的轮次如果全挤在一行，物品一多就折成好几行还看不到对应关系。
    // 第一行带「成功」，后续行缩进对齐（"    成功 " 占 9 列）。
    const parts = [...okBy].map(([name, slot]) => {
      if (slot.items.size === 0) return `${name}×${slot.count}`;
      const list = [...slot.items].slice(0, OK_ITEM_LIMIT)
        .map(([id, n]) => `${id}×${n}${slot.unit}`).join('、');
      const rest = slot.items.size > OK_ITEM_LIMIT ? `、另有 ${slot.items.size - OK_ITEM_LIMIT} 种` : '';
      return `${name} ${list}${rest}`;
    });
    lines.push(`    成功 ${parts[0]}`);
    for (const line of parts.slice(1)) lines.push(`         ${line}`);
  }

  const fails = part.results.filter((entry) => !entry.skipped && entry.ok === false);
  for (const entry of fails.slice(0, limit)) {
    lines.push(`    失败 ${entry.step?.label ?? '?'}：${entry.error}`);
  }
  if (fails.length > limit) lines.push(`    失败 另有 ${fails.length - limit} 条`);

  const skipBy = new Map();
  for (const entry of part.results) {
    if (!entry.skipped) continue;
    const why = entry.error ?? '跳过';
    skipBy.set(why, (skipBy.get(why) ?? 0) + 1);
  }
  if (skipBy.size) lines.push(`    跳过 ${[...skipBy].map(([why, n]) => `${n}×${why}`).join('  ')}`);
  return lines;
}

// 海面备注：以前一个都印不出来，工厂为什么空着全靠猜。这里最多印 4 条，
// 并且先印「排产相关」的（空闲/缺料/自选包/存量上限），其余（拾荒额度、农田、订单保留）排后面。
// 农田相关的放进热名单：撞了单种上限、被服务端拒过之后，这 4 条就是你唯一能看到原因的出口。
// 「用过剩作物排产」和「作物都到安全水位」也要算热 —— 前者是农产品终于被吃掉的证据，
// 后者是地块空着的唯一原因（不写进前 4 条的话，看日志的人只会觉得农田又不动了）。
const WORLD_NOTE_HOT = /空闲|缺料|自选包|排产|存量上限|单种上限|播种|被服务端拒|安全水位|过剩作物/;
function worldNoteLines(world) {
  const notes = (world?.notes ?? []).filter((note) => typeof note === 'string' && note);
  if (notes.length === 0) return [];
  const hot = notes.filter((note) => WORLD_NOTE_HOT.test(note));
  const rest = notes.filter((note) => !WORLD_NOTE_HOT.test(note));
  return [...hot, ...rest].slice(0, 4).map((note) => `    注意 ${note}`);
}

export function formatLoopRound(summary) {
  const ok = (results) => results.filter((entry) => entry.ok).length;
  const failed = (results) => results.filter((entry) => entry.ok === false && !entry.skipped).length;
  const skipped = (results) => results.filter((entry) => entry.skipped).length;
  const line = (name, part) => `  ${name} 计划 ${part.planned}，成功 ${ok(part.results)}，失败 ${failed(part.results)}`
    + (skipped(part.results) ? `，跳过 ${skipped(part.results)}` : '');
  const floater = summary.world.floaterLoot ? formatFloaters(summary.world.floaterLoot) : '';
  // 勾了但被间隔挡住 / 因为「今日没机会」暂停探测的那一轮要说清楚，
  // 否则看起来像「勾了没反应」。
  const gateLine = (name, gate) => {
    if (!gate?.enabled) return '';
    if (gate.skipped) {
      // 静默中：只在开始那一轮和每 30 分钟报一次，不然日志会被同一句刷满。
      if (!gate.skipNotice) return '';
      return gate.skipForever
        ? `  ${name} 暂停探测：${gate.skipReason}（本季不用再试）`
        : `  ${name} 暂停探测：${gate.skipReason}，${humanDuration(gate.skipLeftSeconds)}后再试`;
    }
    if (!gate.throttled) return '';
    return `  ${name} 间隔未到，还差 ${humanDuration(gate.waitSeconds)}（每 ${humanDuration(gate.everyMs / 1000)}一次）`;
  };
  return [
    // 带上本轮耗时：间隔是按「轮首 → 下一轮轮首」算的，看到 12 秒就知道离下一轮还有多久。
    `第 ${summary.round} 轮${summary.elapsedMs ? `（本轮 ${humanDuration(summary.elapsedMs / 1000)}）` : ''}`,
    // 断线整轮跳过时先说这一句，否则「计划 0/0/0」看起来像模块全挂了。
    ...(summary.link ? [`  ${summary.link}`] : []),
    // 段级停止：用户点了停止，这一轮剩下的段没跑，别让「计划 0」看起来像故障。
    ...(summary.stopped ? ['  已按要求停止，本轮剩余段落跳过'] : []),
    line('任务', summary.tasks),
    ...detailLines(summary.tasks),
    // 探测失败只跳过本段，但必须让它出现在日志里 —— 否则「任务一直是 计划 0」看不出是被跳过了。
    ...(summary.tasks.notes ?? []).map((note) => `    注意 ${note}`),
    line('日常', summary.dailies),
    ...detailLines(summary.dailies),
    ...(summary.dailies.notes ?? []).map((note) => `    注意 ${note}`),
    // 瞬成补产单独挂在海面那一行：它不在主段的 planned/results 里（是同一轮的第 3.5 段），
    // 不印出来就只能去翻逐条动作日志才知道跑了几趟、收了多少。
    `${line('海面', summary.world)}  人口 ${summary.world.population}`
      + (summary.world.instant
        ? `  · 瞬成补产 ${summary.world.instant.passes} 趟`
          + `${(summary.world.instant.items ?? []).length > 0
            ? `，收 ${(summary.world.instant.items ?? []).map(([id, num]) => `${id}×${num}`).join('、')}` : ''}`
          + `${summary.world.instant.ms > 0 ? `（${humanDuration(summary.world.instant.ms / 1000)}）` : ''}`
        : ''),
    ...detailLines(summary.world),
    // 海面这一段的 note 以前**没有任何出口**（控制台和网页都看不到），
    // 于是「为什么这座工厂没排产」只能靠猜。这里把它印出来，最多 4 条。
    ...worldNoteLines(summary.world),
    // 挂机领取同理：这一轮真的探测过就印一行（哪怕「本段还剩 7 小时」「邮件都已领」）——
    // 否则日志里看不到它，很容易以为开关没生效。
    ...(summary.idle && (summary.idle.summary || (summary.idle.notes ?? []).length > 0)
      ? [`${line('挂机领取', summary.idle)}${summary.idle.summary ? `  ${summary.idle.summary}` : ''}`,
        ...detailLines(summary.idle),
        ...(summary.idle.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 货轮这一轮真的探测过就印一行概览（哪怕「今日奖励已满」「没有可抢的」）——
    // 否则日志里看不到它，很容易以为开关没生效。被间隔挡住的那轮只在 gateLine 里体现。
    ...(summary.treasure && (summary.treasure.summary || (summary.treasure.notes ?? []).length > 0)
      ? [`${line('货轮', summary.treasure)}${summary.treasure.summary ? `  ${summary.treasure.summary}` : ''}`,
        ...detailLines(summary.treasure),
        ...(summary.treasure.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 情报这一轮真的探测过就印一行概览（哪怕「事件 0 个」）——
    // 否则日志里连续几十轮看不到情报，很容易以为它根本没在跑。
    // 被间隔挡住的那轮没有 summary 字段，只在下面的 gateLine 里体现。
    ...(summary.radar && (summary.radar.summary || (summary.radar.notes ?? []).length > 0)
      ? [`${line('情报', summary.radar)}${summary.radar.summary ? `  ${summary.radar.summary}` : ''}`,
        ...detailLines(summary.radar),
        ...(summary.radar.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 海盗同理：这轮真的探测过就印一行（哪怕是「地图上没有下一级」）——
    // 否则日志里看不到它，很容易以为开关没生效。被间隔挡住的那轮只在 gateLine 里体现。
    ...(summary.pirate && (summary.pirate.summary || (summary.pirate.notes ?? []).length > 0)
      ? [`${line('海盗', summary.pirate)}${summary.pirate.summary ? `  ${summary.pirate.summary}` : ''}`,
        ...detailLines(summary.pirate),
        ...(summary.pirate.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 锻造同理：这轮真的探测过就印一行（哪怕是「还在锻造、还剩 20 分钟」），
    // 否则日志里看不到它，很容易以为开关没生效。
    ...(summary.forge && (summary.forge.summary || (summary.forge.notes ?? []).length > 0)
      ? [`${line('锻造', summary.forge)}${summary.forge.summary ? `  ${summary.forge.summary}` : ''}`,
        ...detailLines(summary.forge),
        ...(summary.forge.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 培育同理：探测过就印一行（哪怕是「队列满，最近一只还剩 20 小时」）。
    ...(summary.pet && (summary.pet.summary || (summary.pet.notes ?? []).length > 0)
      ? [`${line('海兽培育', summary.pet)}${summary.pet.summary ? `  ${summary.pet.summary}` : ''}`,
        ...detailLines(summary.pet),
        ...(summary.pet.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 贸易港口同理：探测过就印一行（哪怕是「三艘都在航行」），否则看不出开关是否生效。
    ...(summary.cargo && (summary.cargo.summary || (summary.cargo.notes ?? []).length > 0)
      ? [`${line('贸易港口', summary.cargo)}${summary.cargo.summary ? `  ${summary.cargo.summary}` : ''}`
          + (summary.cargo.gain ? `  ${summary.cargo.gain}` : ''),
        ...detailLines(summary.cargo),
        ...(summary.cargo.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    ...(floater ? [`  ${floater}`] : []),
    // 海商王同理：探测过就印一行（哪怕是「航行中，还剩 100 分钟」），否则看不出开关是否生效。
    ...(summary.trade && (summary.trade.summary || (summary.trade.notes ?? []).length > 0)
      ? [`${line('海商王', summary.trade)}${summary.trade.summary ? `  ${summary.trade.summary}` : ''}`
          + (summary.trade.gain ? `  ${summary.trade.gain}` : ''),
        ...detailLines(summary.trade),
        ...(summary.trade.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 联盟订单：探测过就印一行（「今天这单已交」也要印，否则看不出开关有没有生效）。
    ...(summary.guildOrder && (summary.guildOrder.summary || (summary.guildOrder.notes ?? []).length > 0)
      ? [`${line('联盟订单', summary.guildOrder)}${summary.guildOrder.summary ? `  ${summary.guildOrder.summary}` : ''}`,
        ...detailLines(summary.guildOrder),
        ...(summary.guildOrder.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 联盟商船：探测过就印一行（「船位满了在等释放」「缺料没补」也要印，
    // 否则看不出开关有没有生效，也看不出为什么一条都没补）。
    ...(summary.guildShip && (summary.guildShip.summary || (summary.guildShip.notes ?? []).length > 0)
      ? [`${line('联盟商船', summary.guildShip)}${summary.guildShip.summary ? `  ${summary.guildShip.summary}` : ''}`
          + (summary.guildShip.gain ? `  ${summary.guildShip.gain}` : ''),
        ...detailLines(summary.guildShip),
        ...(summary.guildShip.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 联盟礼包：看过库就印一行（「已领完」也要印，否则看不出开关有没有生效）。
    ...(summary.guildPack && (summary.guildPack.summary || (summary.guildPack.notes ?? []).length > 0)
      ? [`${line('联盟礼包', summary.guildPack)}${summary.guildPack.summary ? `  ${summary.guildPack.summary}` : ''}`,
        ...detailLines(summary.guildPack),
        ...(summary.guildPack.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 国战：探测过就印一行（「还没到布署时间」「无需派兵」也要印，
    // 否则白天整天看不到这一段，会以为开关没生效）。
    ...(summary.cityWar && (summary.cityWar.summary || (summary.cityWar.notes ?? []).length > 0)
      ? [`${line('国战', summary.cityWar)}${summary.cityWar.summary ? `  ${summary.cityWar.summary}` : ''}`
          + (summary.cityWar.gain ? `  ${summary.cityWar.gain}` : '')
          + (summary.cityWar.onlineText ? `  ${summary.cityWar.onlineText}` : ''),
        ...detailLines(summary.cityWar),
        ...(summary.cityWar.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    // 酆都诡事：探测过就印一行（「没邪祟」「券不够」也要印，否则看不出这一段有没有生效）。
    ...(summary.youdu && (summary.youdu.summary || (summary.youdu.notes ?? []).length > 0)
      ? [`${line('酆都诡事', summary.youdu)}${summary.youdu.summary ? `  ${summary.youdu.summary}` : ''}`
          + (summary.youdu.gain ? `  ${summary.youdu.gain}` : ''),
        ...detailLines(summary.youdu),
        ...(summary.youdu.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    ...[gateLine('货轮', summary.gates?.treasure)].filter(Boolean),
    ...[gateLine('情报', summary.gates?.radar)].filter(Boolean),
    ...[gateLine('海盗', summary.gates?.pirate)].filter(Boolean),
    ...[gateLine('锻造', summary.gates?.forge)].filter(Boolean),
    ...[gateLine('海兽培育', summary.gates?.pet)].filter(Boolean),
    ...[gateLine('贸易港口', summary.gates?.cargo)].filter(Boolean),
    ...[gateLine('海商王', summary.gates?.trade)].filter(Boolean),
    ...[gateLine('联盟订单', summary.gates?.guildOrder)].filter(Boolean),
    ...[gateLine('联盟商船', summary.gates?.guildShip)].filter(Boolean),
    ...[gateLine('联盟礼包', summary.gates?.guildPack)].filter(Boolean),
    ...[gateLine('国战', summary.gates?.cityWar)].filter(Boolean),
    ...[gateLine('酆都诡事', summary.gates?.youdu)].filter(Boolean),
    ...[gateLine('挂机领取', summary.gates?.idle)].filter(Boolean),
    ...[gateLine('拾荒', summary.gates?.pick)].filter(Boolean),
    ...[gateLine('农田', summary.gates?.farm)].filter(Boolean),
  ].join('\n');
}
