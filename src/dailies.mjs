// 日常任务的自动完成：每个任务一个驱动，先只读探测前置条件，再给出可执行的动作。
//
// 只有客户端确实会发的请求才会被排进计划（request/body 与客户端调用点一致），
// 服务端是否计数以 SCDailyTaskUpdate 推送和完成后的 DailyTaskInfoRequest 为准。
//
// 有些任务天生无法协议完成：需要联盟身份、限时时段（20-21 点城战）、地图上得有野怪，
// 或者功能还没开放。这些驱动只报告原因，不会硬发请求。
//
// 除了任务本身，DailyTaskInfoResponse 还带着两样「领了才算完」的东西：
// - dailyTask[].rewardClaimed：任务达标后要点一下 DrawDailyTaskRewardRequest 才拿到奖励，
//   而奖励里带活跃度，所以顺序必须是「先跑任务 → 再领任务奖励 → 最后领活跃宝箱」。
// - dailyRewardClaimed / weeklyRewardClaimed：活跃度宝箱，各 5 档，领的是
//   DrawDailyRewardRequest / DrawWeeklyRewardRequest（都是 index 数组）。
//   两张表、两套门槛：DailyActivityRewardCfg 20/40/60/80/100，
//   WeeklyActivityRewardCfg 120/240/360/480/600。

import { normalize } from './worlds.mjs';
import { FREE_DAILY_PACK_ID } from './actions.mjs';

export const TASK_TITLES = {
  1001: '登录游戏',
  1002: '招募英雄',
  1003: '主线战斗',
  1004: '领取挂机收益',
  1005: '竞技场战斗',
  1006: '点金次数',
  1007: '折扣商店购买',
  1008: '累计贸易次数',
  1009: '累计试炼挑战',
  1010: '累计击败野怪',
  1011: '累计联盟情报',
  1012: '累计联盟订单',
  1013: '累计联盟互助',
  1014: '累计请求帮助',
  1015: '城战获得功勋',
  1016: '博物馆探险',
  1017: '参与积分赛',
};

const RECRUIT_ITEM = '抽卡券';
const RUBY = 4;
const RESOURCE_RUBY = '钻石';

export function describeDailyTask(task, config) {
  const row = (config?.tables?.DailyTaskCfg?.data ?? []).find((r) => r.taskId === task.id);
  return { ...task, title: TASK_TITLES[task.id] ?? row?.type ?? String(task.id), desc: row?.desc ?? '' };
}

// ---- 活跃度宝箱 ---------------------------------------------------------------

// 日和周是两张不同的表，门槛差很远：日 20/40/60/80/100，周 120/240/360/480/600。
// 客户端也是分开取的（allDailyActiveRewardCfg / allWeeklyActiveRewardCfg），
// 所以判「哪几档可领」必须按 kind 选表——混用会把 85 周活跃算成能领 4 档，发出去被服务端拒。
export const CHEST_TABLE = { daily: 'DailyActivityRewardCfg', weekly: 'WeeklyActivityRewardCfg' };

// 哪几档现在能领：活跃度够了、而且服务端没记在已领列表里。
// 四个季节的门槛与档位号完全一样（只有第 5 档的奖励不同），所以领哪几档不用挑季节；
// 只有要显示「第 5 档给什么」时才需要知道季节，那一步交给界面，不在这里猜。
export function chestTiers(config, { kind = 'daily', activity = 0, claimed = [], season = null } = {}) {
  const rows = config?.tables?.[CHEST_TABLE[kind] ?? CHEST_TABLE.daily]?.data ?? [];
  const use = season == null ? rows : rows.filter((row) => row.season === season);
  const taken = new Set(claimed ?? []);
  const byId = new Map();
  for (const row of use) {
    if (taken.has(row.id) || Number(activity) < Number(row.activity)) continue;
    if (!byId.has(row.id)) byId.set(row.id, { id: row.id, activity: row.activity, reward: row.reward });
  }
  return [...byId.values()].sort((a, b) => a.activity - b.activity);
}

// 从一次 DailyTaskInfoResponse 算出要发的两个请求。两个都没有可领档位时返回空动作表。
export function planChests(daily, config) {
  const day = { activity: daily?.dailyActivity ?? 0, claimed: daily?.dailyRewardClaimed ?? [] };
  const week = { activity: daily?.weeklyActivity ?? 0, claimed: daily?.weeklyRewardClaimed ?? [] };
  const dailyTiers = chestTiers(config, { ...day, kind: 'daily' });
  const weeklyTiers = chestTiers(config, { ...week, kind: 'weekly' });
  const actions = [];
  if (dailyTiers.length > 0) {
    actions.push({
      request: 'DrawDailyRewardRequest',
      body: { index: dailyTiers.map((tier) => tier.id) },
      response: null,
      cost: '无',
      note: `领日常活跃宝箱 第 ${dailyTiers.map((tier) => tier.id).join('/')} 档（活跃度 ${day.activity}）`,
    });
  }
  if (weeklyTiers.length > 0) {
    actions.push({
      request: 'DrawWeeklyRewardRequest',
      body: { index: weeklyTiers.map((tier) => tier.id) },
      response: null,
      cost: '无',
      note: `领周活跃宝箱 第 ${weeklyTiers.map((tier) => tier.id).join('/')} 档（活跃度 ${week.activity}）`,
    });
  }
  return {
    daily: { ...day, tiers: dailyTiers, nextAt: nextThreshold(config, 'daily', day) },
    weekly: { ...week, tiers: weeklyTiers, nextAt: nextThreshold(config, 'weekly', week) },
    actions,
  };
}

// 下一档的门槛，界面上用来解释「为什么现在没得领」。
function nextThreshold(config, kind, { activity = 0, claimed = [] }) {
  const rows = config?.tables?.[CHEST_TABLE[kind] ?? CHEST_TABLE.daily]?.data ?? [];
  return rows
    .filter((row) => !claimed.includes(row.id) && Number(row.activity) > Number(activity))
    .reduce((min, row) => (min == null || row.activity < min ? row.activity : min), null);
}

// ---- 每日精选的免费礼包 -------------------------------------------------------

// 「每日精选」面板每天有一档免费赠礼，领走的是 GotFreeDailyPackRequest{packId:"赠礼"}。
// packId 是客户端硬编码的字符串，服务端状态在 DailyGiftPackResponse.drawnPack 里；
// resetTime 是次日 0 点，所以这是真正的「日奖励」，和活跃度宝箱是两回事。
//
// 面板里另外三个（礼包1/2/3）要走充值，"合并礼包" 要先买过前三个才可领，都不在本工具范围内。
export function planDailyGift(response) {
  const drawn = response?.drawnPack ?? [];
  const available = !drawn.includes(FREE_DAILY_PACK_ID);
  return {
    drawn,
    freeAvailable: available,
    resetTime: response?.resetTime ?? null,
    actions: available
      ? [{
        request: 'GotFreeDailyPackRequest',
        body: { packId: FREE_DAILY_PACK_ID },
        response: null,
        cost: '无',
        note: '领每日精选的免费赠礼',
      }]
      : [],
  };
}

// 每个驱动声明它要的只读前置请求，框架统一批量取一遍。
export const DAILY_DRIVERS = {
  1002: {
    id: 1002,
    title: '招募英雄',
    probes: [['RecruitInfoRequest', {}]],
    evaluate({ task, probe, items, now }) {
      const info = probe('RecruitInfoRequest')?.hero;
      const remaining = Math.max(0, task.targetProgress - task.progress);
      if (remaining === 0) return { status: 'done' };
      const actions = [];
      // RecruitWay: 1=免费 2=单抽 3=十连 4=五十连 5=高级；单抽花 1 张抽卡券。
      if (info && info.freeEndTimeSeconds <= now) {
        actions.push({ request: 'RecruitStartRequest', body: { way: 1 }, response: 'RecruitStartResponse', cost: '免费次数', note: '免费招募' });
      }
      const tickets = items.get(RECRUIT_ITEM) ?? 0;
      const singles = Math.min(remaining - actions.length, tickets);
      for (let i = 0; i < singles; i += 1) {
        actions.push({ request: 'RecruitStartRequest', body: { way: 2 }, response: 'RecruitStartResponse', cost: `${RECRUIT_ITEM} x1`, note: '单抽' });
      }
      if (actions.length === 0) {
        return { status: 'blocked', reason: `免费次数未好，且没有${RECRUIT_ITEM}（需要 ${remaining} 次）` };
      }
      if (actions.length < remaining) {
        return { status: 'partial', reason: `只有 ${actions.length}/${remaining} 次可做`, actions };
      }
      return { status: 'ready', actions };
    },
  },

  1003: {
    id: 1003,
    title: '主线战斗',
    probes: [],
    evaluate({ task, player }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      // 客户端发的是 PlayerInfo.mainlineStage（下一关的关卡号），不是 PassStageState.maxOpenStage。
      const stage = player?.mainlineStage;
      if (!stage) return { status: 'blocked', reason: '登录信息里没有 mainlineStage' };
      return {
        status: 'ready',
        actions: [{ request: 'ChallengeStageRequest', body: { stage }, response: 'ChallengeStageResponse', cost: '体力', note: `挑战主线第 ${stage} 关` }],
      };
    },
  },

  1004: {
    id: 1004,
    title: '领取挂机收益',
    probes: [['AfkInfoRequest', {}]],
    evaluate({ task, probe, now }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const afk = probe('AfkInfoRequest')?.afkInfo;
      if (!afk) return { status: 'blocked', reason: '没有挂机信息' };
      if (!(afk.afkFinishTime > 0 && afk.afkFinishTime <= now)) {
        return { status: 'waiting', reason: `本段挂机还有 ${Math.ceil(afk.afkFinishTime - now)} 秒` };
      }
      return { status: 'ready', actions: [{ request: 'DrawAfkRewardRequest', body: {}, response: 'DrawAfkRewardResponse', cost: '无', note: '领取挂机本段收益' }] };
    },
  },

  1005: {
    id: 1005,
    title: '竞技场战斗',
    probes: [['ArenaInfoRequest', {}]],
    evaluate({ task, probe }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const challenges = probe('ArenaInfoRequest')?.challenges ?? [];
      const remaining = task.targetProgress - task.progress;
      if (!challenges.length) return { status: 'blocked', reason: '竞技场没有可挑战对手' };
      // 从战力最低的开始打，胜率最高。
      const targets = [...challenges].sort((a, b) => lowPower(a.power) - lowPower(b.power)).slice(0, remaining);
      const actions = targets.map((target) => ({
        request: 'ArenaChallengeRequest',
        body: { rank: target.rankNo, challengeId: target.id },
        response: 'ArenaChallengeResponse',
        cost: '竞技场次数',
        note: `挑战 rank=${target.rankNo} 战力=${lowPower(target.power)}`,
      }));
      return { status: 'ready', actions };
    },
  },

  1006: {
    id: 1006,
    title: '点金次数',
    probes: [['ClickGoldInfoRequest', {}]],
    evaluate({ task, probe, config, ruby }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const info = probe('ClickGoldInfoRequest')?.info;
      if (!info) return { status: 'blocked', reason: '拿不到点金信息' };
      const param = (name) => (config?.tables?.OfflineParamCfg?.data ?? []).find((row) => row.paramName === name)?.paramValue ?? 0;
      const remaining = task.targetProgress - task.progress;
      // 免费次数上限来自 OfflineParamCfg.免费点金次数，付费单价来自 点金价格（单位钻石）。
      const freeLeft = Math.max(0, param('免费点金次数') - (info.freeTimes ?? 0));
      if (freeLeft > 0) {
        // 免费点金客户端永远是 times:1 一次一发，服务端不接受免费模式下的多连。
        const count = Math.min(freeLeft, remaining);
        const actions = [];
        for (let i = 0; i < count; i += 1) {
          actions.push({ request: 'ClickGoldRequest', body: { times: 1, free: true }, response: 'ClickGoldResponse', cost: '免费次数', note: '免费点金 x1' });
        }
        return { status: 'ready', actions };
      }
      const price = param('点金价格');
      const paidLeft = Math.max(0, (info.maxPaidTimes ?? 0) - (info.paidTimes ?? 0));
      if (paidLeft < remaining) return { status: 'blocked', reason: `免费次数用完，付费上限只剩 ${paidLeft} 次` };
      if (price * remaining > ruby) return { status: 'blocked', reason: `付费点金要 ${price * remaining} 钻石，当前 ${ruby}` };
      // 付费点金扣的是钻石（RUBY），必须显式开 allowPaid。
      return {
        status: 'paid',
        reason: `免费次数已用完，付费 ${price} 钻石一次`,
        actions: [{ request: 'ClickGoldRequest', body: { times: remaining, free: false }, response: 'ClickGoldResponse', paid: true, cost: `${RESOURCE_RUBY} x${price * remaining}`, note: '付费点金' }],
      };
    },
  },

  1007: {
    id: 1007,
    title: '折扣商店购买',
    probes: [['DiscountShopRequest', {}]],
    evaluate({ task, probe, ruby }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const shop = probe('DiscountShopRequest');
      const items = (shop?.shopItem ?? []).filter((item) => !item.isBuy);
      if (!items.length) return { status: 'blocked', reason: '折扣商店没有可买商品' };
      // 客户端价格 = floor(price * discount)，付的是钻石。
      const cheapest = items
        .map((item) => ({ ...item, realPrice: Math.floor(item.price * item.discount) }))
        .sort((a, b) => a.realPrice - b.realPrice)[0];
      if (cheapest.realPrice > ruby) return { status: 'blocked', reason: `最便宜的一件要 ${cheapest.realPrice} 钻石，当前 ${ruby}` };
      // 这里**必须**是 paid：客户端 `_onBtnBuyDiscountItem` 是
      // `checkResAndShowNotice(Resource.RUBY, floor(price * discount))` 才发请求，付的就是钻石。
      // 以前标成 ready，runDailies 只拦 status === 'paid'，于是「没开 --paid」也会照买 ——
      // 归档里能看到 DiscountShopBuyRequest{id:5} 紧跟在三条 free 点金后面，RUBY 9742→9730。
      return {
        status: 'paid',
        reason: `折扣店最便宜一件要 ${cheapest.realPrice} ${RESOURCE_RUBY}`,
        actions: [{
          request: 'DiscountShopBuyRequest',
          body: { id: cheapest.id },
          response: null,
          paid: true,
          cost: `${RESOURCE_RUBY} x${cheapest.realPrice}`,
          note: `购买商品 ${cheapest.id}`,
        }],
      };
    },
  },

  1008: {
    id: 1008,
    title: '累计贸易次数',
    probes: [['CargoShipsRequest', {}], ['TradeInfoRequest', {}]],
    evaluate({ task, probe }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const ships = probe('CargoShipsRequest')?.ship ?? [];
      const cargo = probe('TradeInfoRequest')?.worldCargo ?? [];
      if (!ships.length && !cargo.length) {
        return { status: 'blocked', reason: '没有货轮也没有世界货物，贸易需要先在地图上接货' };
      }
      return { status: 'blocked', reason: '货轮贸易要在地图上选航线，未找到可自动化的入口' };
    },
  },

  1009: {
    id: 1009,
    title: '累计试炼挑战',
    probes: [['TrialRaidInfoRequest', { raidId: 1 }]],
    evaluate({ task, probe, config, player }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const raid = probe('TrialRaidInfoRequest')?.raid;
      if (!raid) return { status: 'blocked', reason: '拿不到试炼副本信息' };
      // passedStage 是已通关的 stageLevel，stageId 是 1001 这种编号，两者不是一回事。
      const stages = (config?.tables?.TrialRaidStageCfg?.data ?? [])
        .filter((row) => row.raidId === raid.raidId)
        .sort((a, b) => a.stageLevel - b.stageLevel);
      const next = stages.find((row) => row.stageLevel > (raid.passedStage ?? 0));
      if (!next) return { status: 'blocked', reason: '这个试炼副本已经全通' };
      const level = player?.level ?? 1;
      if ((next.openLevel ?? 0) > level) {
        return { status: 'blocked', reason: `试炼副本需要玩家等级 ${next.openLevel}，当前 ${level}` };
      }
      return {
        status: 'ready',
        actions: [{ request: 'TrialRaidChallengeRequest', body: { raidId: raid.raidId, stageId: next.stageId }, response: 'TrialRaidChallengeResponse', cost: '挑战次数', note: `英雄经验副本第 ${next.stageLevel} 关` }],
      };
    },
  },

  1010: {
    id: 1010,
    title: '累计击败野怪',
    probes: [['AllPirateRequest', {}]],
    evaluate({ task, probe }) {
      if (task.progress >= task.targetProgress) return { status: 'done' };
      const all = probe('AllPirateRequest');
      const pirates = all?.pirates ?? [];
      if (!pirates.length) return { status: 'blocked', reason: '世界地图上没有海盗部队可扫荡' };
      // sweepTimes 跟 pirates 一起下发，是**免战扫荡**的剩余次数。为 0 时发 PirateSweepRequest
      // 一律被服务端回 PromptResponse「cannot sweep」——这里以前只判断「有没有海盗」，
      // 于是进度卡在 1/5 的账号每轮都白试一次，日志每 60 秒一行红字。
      // 次数用完要接着做只能真出战（PirateFightRequest，得算战力和战损），没做自动化，所以直接报 blocked。
      const sweepTimes = Math.max(0, Math.floor(Number(all?.sweepTimes) || 0));
      if (sweepTimes === 0) {
        const left = task.targetProgress - task.progress;
        return { status: 'blocked', reason: `扫荡次数已用完（0 次），还差 ${left} 次击败野怪，只能手动出战` };
      }
      const remaining = Math.min(task.targetProgress - task.progress, sweepTimes);
      const actions = pirates.slice(0, remaining).map((pirate) => ({
        request: 'PirateSweepRequest',
        body: { uid: pirate.uid, cityId: pirate.cityId },
        response: null,
        cost: '讨伐次数',
        note: `扫荡海盗 ${pirate.uid}`,
      }));
      return { status: 'ready', actions };
    },
  },

  1011: { id: 1011, title: '累计联盟情报', probes: [['TradeGuildRadarRequest', {}]], evaluate: lockedReason('联盟情报（雷达）') },
  1012: { id: 1012, title: '累计联盟订单', probes: [['GuildCityInfoRequest', {}]], evaluate: lockedReason('联盟城市募兵') },
  1013: { id: 1013, title: '累计联盟互助', probes: [['GuildAidListRequest', { type: 0 }]], evaluate: lockedReason('联盟互助') },
  1014: { id: 1014, title: '累计请求帮助', probes: [], evaluate: lockedReason('联盟求助') },
  1015: { id: 1015, title: '城战获得功勋', probes: [], evaluate: lockedReason('城战（20:00-21:00 限时）') },
  1016: { id: 1016, title: '博物馆探险', probes: [['MuseumInfoRequest', {}]], evaluate: lockedReason('博物馆') },
  1017: { id: 1017, title: '参与积分赛', probes: [['LeagueInfoRequest', {}]], evaluate: lockedReason('跨服积分赛') },
};

// 这类任务的入口请求被服务端直接拒绝（未入盟 / 未开放 / 限时），探测结果只用来确认原因。
function lockedReason(feature) {
  return ({ task }) => {
    if (task.progress >= task.targetProgress) return { status: 'done' };
    return { status: 'blocked', reason: `${feature}当前不可用（服务端拒绝或功能未开放）` };
  };
}

function lowPower(power) {
  if (power == null) return 0;
  if (typeof power === 'number') return power;
  return power.low ?? 0;
}

// 只读调研：跑一遍前置请求，给出每个日常任务能不能做、要发什么。
export async function surveyDailies(client, protocol, { config = null, player = null, timeout = 8000 } = {}) {
  const daily = await client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse', timeout);
  const tasks = (daily.dailyTask ?? []).map((task) => describeDailyTask(task, config));
  const itemList = await client.request('AllItemRequest', {}, 'AllItemResponse', timeout);
  const items = new Map();
  for (const item of itemList.items ?? []) {
    const id = item.itemId ?? item.id;
    items.set(id, (items.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
  }
  const resourceList = await client.request('AllResourceRequest', {}, 'AllResourceResponse', timeout);
  const ruby = Number((resourceList.list ?? []).find((entry) => entry.res === RUBY)?.amount ?? 0);

  const cache = new Map();
  const fetchProbe = async (name, body) => {
    const key = `${name}|${JSON.stringify(body)}`;
    if (cache.has(key)) return cache.get(key);
    const responseName = `${name.slice(0, -7)}Response`;
    let value = null;
    try {
      value = await client.request(name, body ?? {}, responseName, timeout);
    } catch {
      value = null;
    }
    cache.set(key, value);
    return value;
  };

  const probeCache = new Map();
  for (const driver of Object.values(DAILY_DRIVERS)) {
    for (const [name, body] of driver.probes ?? []) {
      const key = `${name}|${JSON.stringify(body)}`;
      if (probeCache.has(key)) continue;
      probeCache.set(key, await fetchProbe(name, body));
    }
  }
  const probe = (name) => {
    for (const [key, value] of probeCache) if (key.startsWith(`${name}|`)) return value;
    return null;
  };

  const now = Date.now() / 1000;
  const evaluations = [];
  for (const task of tasks) {
    if (task.progress >= task.targetProgress) {
      evaluations.push({ task, status: 'done', actions: [] });
      continue;
    }
    const driver = DAILY_DRIVERS[task.id];
    if (!driver) {
      evaluations.push({ task, status: 'unknown', reason: '没有对应的驱动' });
      continue;
    }
    let verdict;
    try {
      verdict = normalize(driver.evaluate({ task, probe, items, ruby, now, config, player }));
    } catch (error) {
      verdict = { status: 'error', reason: error.message };
    }
    evaluations.push({ task, ...verdict });
  }
  let gift = null;
  if (protocol.DailyGiftPackRequest && protocol.DailyGiftPackResponse) {
    try {
      gift = planDailyGift(await client.request('DailyGiftPackRequest', {}, 'DailyGiftPackResponse', timeout));
    } catch {
      // 这个面板取不到不影响任务本身，如实留空比编一个状态好。
      gift = null;
    }
  }
  return { daily, tasks: evaluations, chests: planChests(daily, config), gift, ruby, config };
}

// 发一条动作，带 Response 的等回包，没有配套 Response 的靠 sendWatch 看有没有被 PromptResponse 打回来。
async function sendAction(client, protocol, action, timeout) {
  if (action.response && protocol[action.response]) {
    return client.request(action.request, action.body, action.response, timeout);
  }
  await client.sendWatch(action.request, action.body, { window: 400 });
  return null;
}

// 一个驱动是不是「要花钻石」：优先看驱动自己标的 status / 动作上的 paid 标记，
// 再兜一层 cost 文案（防以后新驱动忘了标，也能被拦住）。三处任一命中就算付费。
export function needsPaid(entry) {
  if (entry?.status === 'paid') return true;
  return (entry?.actions ?? []).some((action) => action?.paid === true || String(action?.cost ?? '').includes('钻石'));
}

// 有付费动作时必须显式开 allowPaid，否则默认只做免费的部分。
//
// claimRewards 走的是「收尾」：驱动动作发完服务端才更新完成数，所以这里重新问一次
// DailyTaskInfoResponse，先把达标任务的奖励领了（奖励里的活跃度会把活跃度顶上去），
// 再领活跃度宝箱。少了这一步，任务做完了奖励还挂在服务端上。
export async function runDailies(client, protocol, survey, { allowMutate = false, allowPaid = false, claimRewards = true, config = null, timeout = 15000, onStep } = {}) {
  if (!allowMutate) throw new Error('完成日常会改变账号状态，需要 --yes');
  const results = [];
  for (const entry of survey.tasks) {
    if (!entry.actions?.length) continue;
    // 门控按「动作」判，不只看 status：折扣店以前标的是 ready，漏掉了 allowPaid 这一关，
    // 结果没开 --paid 也会花钻石买东西（见 1007 的注释与 docs/gameplay.md 第 8 节）。
    if (needsPaid(entry) && !allowPaid) {
      results.push({ id: entry.task.id, skipped: true, reason: '需要付费，未开 allowPaid' });
      onStep?.({ id: entry.task.id, title: entry.task.title, skipped: true, reason: '需要付费' });
      continue;
    }
    for (const action of entry.actions) {
      try {
        const body = await sendAction(client, protocol, action, timeout);
        const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, note: action.note, ok: true, body };
        results.push(outcome);
        onStep?.(outcome);
      } catch (error) {
        const outcome = { id: entry.task.id, title: entry.task.title, request: action.request, note: action.note, ok: false, error: error.message };
        results.push(outcome);
        onStep?.(outcome);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  if (claimRewards) {
    // 服务端的完成数是异步落库的，动作刚发完就问会读到旧值。
    await new Promise((resolve) => setTimeout(resolve, 1000));
    results.push(...await claimDailies(client, protocol, { config: config ?? survey.config, timeout, onStep }));
  }
  return results;
}

// 收尾两连：先领达标任务的奖励，再领活跃度宝箱。
export async function claimDailies(client, protocol, { config = null, timeout = 15000, onStep } = {}) {
  const results = [];
  if (!protocol.DailyTaskInfoRequest || !protocol.DailyTaskInfoResponse) return results;

  const report = (outcome) => {
    results.push(outcome);
    onStep?.(outcome);
  };

  const after = await client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse', timeout);
  const claimable = (after.dailyTask ?? []).filter((task) => task.progress >= task.targetProgress && !task.rewardClaimed);
  for (const task of claimable) {
    const title = TASK_TITLES[task.id] ?? String(task.id);
    const action = { request: 'DrawDailyTaskRewardRequest', response: 'DrawDailyTaskRewardResponse', body: { id: task.id }, note: `领任务奖励（${title}）` };
    try {
      const body = await sendAction(client, protocol, action, timeout);
      report({ id: task.id, title, request: action.request, note: action.note, ok: true, body });
    } catch (error) {
      report({ id: task.id, title, request: action.request, note: action.note, ok: false, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 任务奖励刚加过活跃度，所以宝箱要按新活跃度重新算一次，否则会漏掉刚好够到的档位。
  const fresh = await client.request('DailyTaskInfoRequest', {}, 'DailyTaskInfoResponse', timeout);
  const { actions } = planChests(fresh, config);
  for (const action of actions) {
    const title = action.request === 'DrawWeeklyRewardRequest' ? '周活跃宝箱' : '日常活跃宝箱';
    try {
      const body = await sendAction(client, protocol, action, timeout);
      report({ id: 'activityChest', title, request: action.request, note: action.note, ok: true, body });
    } catch (error) {
      report({ id: 'activityChest', title, request: action.request, note: action.note, ok: false, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 每日精选的免费赠礼。GotFreeDailyPackRequest 没有配套 Response，所以发完要重新问一次
  // DailyGiftPackResponse 确认 drawnPack 里真的多了「赠礼」——只看「没被 prompt 打回」不算成功。
  if (protocol.DailyGiftPackRequest && protocol.DailyGiftPackResponse) {
    const before = await client.request('DailyGiftPackRequest', {}, 'DailyGiftPackResponse', timeout);
    const plan = planDailyGift(before);
    if (plan.actions.length > 0) {
      const action = plan.actions[0];
      try {
        await sendAction(client, protocol, action, timeout);
        const after = await client.request('DailyGiftPackRequest', {}, 'DailyGiftPackResponse', timeout);
        const ok = (after.drawnPack ?? []).includes(FREE_DAILY_PACK_ID);
        // 一次动作只报一条结果：以前失败时先报一条无 error 的、再报一条带 error 的，
        // 日志与「失败 N 条」的统计都会把同一个请求数成两次。
        report({
          id: 'freeDailyPack',
          title: '每日免费赠礼',
          request: action.request,
          note: action.note,
          ok,
          body: ok ? null : { drawnPack: after.drawnPack },
          ...(ok ? {} : { error: '服务端没有把它记进 drawnPack' }),
        });
      } catch (error) {
        report({ id: 'freeDailyPack', title: '每日免费赠礼', request: action.request, note: action.note, ok: false, error: error.message });
      }
    }
  }
  return results;
}

// 活跃奖励那两行：没得领的时候也要说清楚差多少，否则看不出是「领完了」还是「没在领」。
function chestLine(name, chest) {
  const claimed = chest.claimed.length ? chest.claimed.join('/') : '无';
  if (chest.tiers.length) {
    return `活跃奖励 ${name} ${chest.activity} 活跃 · 已领 ${claimed} · 可领 第 ${chest.tiers.map((tier) => tier.id).join('/')} 档`;
  }
  const tail = chest.nextAt == null ? '全部领完' : `还差 ${chest.nextAt - chest.activity} 点到第 ${chest.nextAt} 档`;
  return `活跃奖励 ${name} ${chest.activity} 活跃 · 已领 ${claimed} · 暂无可领（${tail}）`;
}

export function formatSurvey(survey) {
  const lines = [];
  const label = { ready: '可做', paid: '需付费', partial: '部分', waiting: '等待中', done: '已完成', blocked: '不可用', error: '出错', unknown: '未知' };
  for (const entry of survey.tasks) {
    const task = entry.task;
    const progress = `${task.progress}/${task.targetProgress}`;
    const actions = (entry.actions ?? []).length;
    const suffix = entry.reason ? ` — ${entry.reason}` : actions ? ` — ${actions} 个动作` : '';
    lines.push(`${(label[entry.status] ?? entry.status).padEnd(4)} ${String(task.id).padEnd(5)}${task.title.padEnd(8)} ${progress.padEnd(6)}${suffix}`);
  }
  if (survey.chests) {
    lines.push(chestLine('日', survey.chests.daily));
    lines.push(chestLine('周', survey.chests.weekly));
  }
  if (survey.gift) {
    lines.push(survey.gift.freeAvailable
      ? `每日赠礼 未领 · 可领（免费，${FREE_DAILY_PACK_ID}）`
      : `每日赠礼 已领（${FREE_DAILY_PACK_ID}）`);
  }
  return lines.join('\n');
}
