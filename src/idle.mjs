// 挂机领取：三件「不发请求就白放着」的免费收益 —— 邮件附件、挂机本段收益、挂机等级奖励/升级。
//
// 为什么单独成一个模块，而不是塞进 dailies：
// 日常驱动只在服务端正好下发了「领取挂机收益(1004)」这条日常任务时才会去领本段收益，
// 没有这条任务的那一天，收益就一整天没人领 —— 而它是 8 小时封顶的，封顶之后产出等于停摆。
// 邮件、挂机等级奖励同理：它们跟「日常任务」没有半点关系，不该由日常来驱动。
//
// 三条判据都照抄客户端，不猜：
// - 本段收益：afkFinishTime > 0 且 now >= afkFinishTime（OfflineRewardView 的按钮灰化条件）。
// - 等级奖励：OfflineLvRewardCfg 里第一个 level > rewardedLevel 且 reward 非空的行，
//   且该 level <= afkInfo.level（客户端 nextLvRewardCfg + `i.level<=e`）。
// - 升级：OfflineRewardView._refreshLevelUpBtn —— 可升到几级由 maxLevel() 决定，
//   maxLevel = OfflineCfg 里 stage <= 主线关卡-1 的最大 level；一次升 10 / 5 / 1 级三档，
//   取能连升的最高档，消耗是这些级 consume[1]（挂机徽章）之和。
//
// **升级会重置本段计时**（UpgradeAfkLevelResponse 回传新的 afkStartTime/afkFinishTime），
// 所以只在「本段收益刚领过 / 本段刚开没多久」时才升级，否则会把累积的收益白扔掉。

import { normalize } from './worlds.mjs';
import { assetCount } from './world.mjs';
import { afkMaxLevelOf, nextAfkRewardLevelOf } from './config.mjs';

// 客户端常量 OFFLINE_LV_ITEM：升级挂机等级消耗的道具。
export const AFK_LV_ITEM = '挂机徽章';

// 邮箱状态：EmailStatus.ES_READ=1、ES_NEW=2（协议里没有「已领」这个状态，看 got 布尔）。
const EMAIL_STATUS_NEW = 2;

// 「本段刚开」的阈值：计时不满 2 分钟时升级不会损失什么，可以放心升。
const FRESH_SEGMENT_SECONDS = 120;

// 一次能连升的档位，客户端的 [5,10]。1 级是兜底。
const JUMP_TIERS = [5, 10];

// 邮件分页的上限：一键领取发的是 all:true，所以只要能确认「还有没领的」就够，
// 不必把几十页全部拉完（每页都是一次往返）。
const MAIL_MAX_PAGES = 4;

function rowsOf(config, name) {
  return config?.tables?.[name]?.data ?? [];
}

// 挂机等级上限与「下一个有奖等级」的判定只有一份实现，在 config.mjs
// （config.afkMaxLevel / config.nextAfkRewardLevel 是同一份逻辑的绑定糖）。
export const afkMaxLevel = afkMaxLevelOf;
export const nextLevelReward = nextAfkRewardLevelOf;

// 升一级要几个挂机徽章：OfflineCfg.consume 是 ["挂机徽章", 数量]，
// 客户端 `t.consume[1]` 取的就是这个数量。缺行时返回 null（不能升到那一级）。
function upgradeCost(config, level) {
  const row = rowsOf(config, 'OfflineCfg').find((entry) => Number(entry.level) === Number(level));
  if (!row) return null;
  const consume = row.consume ?? [];
  if (consume.length < 2) return null;
  return Number(consume[1]) || 0;
}

// 客户端 _refreshLevelUpBtn 的等价实现：先试连升 5 级，够了再试 10 级；都不够就升 1 级。
// 返回 { jump, need, have, reason }，jump=0 表示这一轮不能升。
export function planAfkUpgrade(config, { level = 0, have = 0, maxLevel = 0 } = {}) {
  const current = Number(level) || 0;
  if (maxLevel == null) return { jump: 0, need: 0, have, reason: '拿不到主线关卡，算不出挂机等级上限' };
  if (current >= maxLevel) {
    const nextRow = rowsOf(config, 'OfflineCfg').find((row) => Number(row.level) === current + 1);
    const needStage = nextRow ? Number(nextRow.stage) || 0 : null;
    return {
      jump: 0,
      need: 0,
      have,
      reason: needStage == null
        ? `挂机已到配置最高级 ${current}`
        : `主线第 ${needStage + 1} 关才解锁第 ${current + 1} 级（现在第 ${needStage} 关）`,
    };
  }

  const cost1 = upgradeCost(config, current + 1);
  if (cost1 == null) return { jump: 0, need: 0, have, reason: `OfflineCfg 里没有第 ${current + 1} 级` };

  let jump = 1;
  let need = cost1;
  for (const tier of JUMP_TIERS) {
    if (current + tier > maxLevel) break;
    let sum = 0;
    let affordable = true;
    for (let offset = jump + 1; offset <= tier; offset += 1) {
      const cost = upgradeCost(config, current + offset);
      if (cost == null) {
        affordable = false;
        break;
      }
      sum += cost;
      if (need + sum > have) {
        affordable = false;
        break;
      }
    }
    if (!affordable) break;
    need += sum;
    jump = tier;
  }

  if (have < need) {
    return { jump: 0, need, have, reason: `${AFK_LV_ITEM} 不够：要 ${need}，有 ${have}` };
  }
  return { jump, need, have, reason: null };
}

// 邮件一页。EmailBoxRequest.pageNo 从 0 开始。
async function fetchMails(client, protocol, { timeout = 8000 } = {}) {
  const pages = [];
  let total = null;
  for (let pageNo = 0; pageNo < MAIL_MAX_PAGES; pageNo += 1) {
    let response = null;
    try {
      response = normalize(await client.request('EmailBoxRequest', { pageNo }, 'EmailBoxResponse', timeout));
    } catch {
      response = null;
    }
    if (!response) break;
    const list = response.email ?? [];
    total = Number(response.total ?? total ?? list.length);
    pages.push(...list);
    // 第一页就没有「新邮件」也没有「未领附件」时，才需要翻后面的页 ——
    // 一键领取发的是 all:true，只要任意一页能确认「有得领」就够。
    if (!mailClaimable(pages)) {
      if (pages.length < total && list.length > 0) continue;
    }
    break;
  }
  return { emails: pages, total: total ?? pages.length };
}

// 客户端 MailView 的按钮灰化条件：有 ES_NEW 的邮件，或者带附件且 got=false。
export function mailClaimable(emails) {
  return (emails ?? []).some((mail) => Number(mail.status) === EMAIL_STATUS_NEW
    || (mail.attachment != null && mail.got !== true));
}

// 等级奖励能不能领 + 为什么不能领。界面说明与计划共用这一份判断，
// 免得「概览说可领、计划里没有」这种对不上的情况。
export function levelRewardView(afk, config) {
  const level = afk && config ? nextLevelReward(config, afk.rewardedLevel) : null;
  return {
    level,
    claimable: Boolean(afk && level != null && level <= afk.level),
    reason: !afk ? '没有挂机信息'
      : !config ? '没有配置表（OfflineLvRewardCfg）'
        : level == null ? '挂机等级奖励已全部领完'
          : level > afk.level ? `第 ${level} 级奖励要挂机到 ${level} 级（现在 ${afk.level}）`
            : null,
  };
}

// 挂机两个「领」的动作（本段收益 / 等级奖励）。afk 收原始 afkInfo 或 survey.afk 都行，
// 两者字段同名。CLI 的 `loot`（基于 collectState 的快照）与循环（基于实时探测）共用这一份，
// 不然两边的判据迟早会漂。
export function planAfkClaims(afk, config, now = Math.floor(Date.now() / 1000)) {
  const steps = [];
  if (!afk) return steps;
  const finish = Number(afk.afkFinishTime) || 0;
  const level = Number(afk.level) || 0;
  if (finish > 0 && now >= finish) {
    steps.push({
      kind: 'afkDraw',
      request: 'DrawAfkRewardRequest',
      response: 'DrawAfkRewardResponse',
      body: {},
      // body 是空的 → runIdle 的 key 退化成常量 'afkDraw:'。本段收益是每 8 小时循环的，
      // 一次「还没封顶/状态没同步」的拒绝不能变成整场挂机都不领。
      transient: true,
      label: `挂机本段收益（Lv${level}）`,
    });
  }
  const reward = levelRewardView({ ...afk, level }, config);
  if (reward.claimable) {
    steps.push({
      kind: 'afkLevelDraw',
      request: 'DrawAfkLevelRewardRequest',
      response: 'DrawAfkLevelRewardResponse',
      body: { level: reward.level },
      label: `挂机 ${reward.level} 级奖励`,
    });
  }
  return steps;
}

// 只读探测。stock 由循环里 world 那一段传进来（省一次 AllItemRequest）；
// 单独跑（网页「立刻领取一次」）时才自己拉库存。
export async function surveyIdle(client, protocol, {
  config = null,
  player = null,
  stock = null,
  timeout = 8000,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const notes = [];
  const get = async (name, body = {}) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, body, responseName, timeout));
    } catch {
      return null;
    }
  };

  const [afkRaw, itemList, mail] = await Promise.all([
    get('AfkInfoRequest'),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
    fetchMails(client, protocol, { timeout }),
  ]);

  const bagStock = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bagStock.set(id, (bagStock.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
  }

  const afkInfo = afkRaw?.afkInfo ? normalize(afkRaw.afkInfo) : null;
  let afk = null;
  if (afkInfo) {
    const finish = Number(afkInfo.afkFinishTime) || 0;
    const start = Number(afkInfo.afkStartTime) || 0;
    afk = {
      level: Number(afkInfo.level) || 0,
      rewardedLevel: Number(afkInfo.rewardedLevel) || 0,
      afkStartTime: start,
      afkFinishTime: finish,
      remainSeconds: finish > now ? finish - now : 0,
      ready: finish > 0 && now >= finish,
      fresh: start > 0 && now - start <= FRESH_SEGMENT_SECONDS,
    };
  } else {
    notes.push('拿不到挂机信息（AfkInfoResponse），本轮不领挂机收益');
  }

  // 等级奖励（判据只有一份：levelRewardView，planAfkClaims 也用它）
  const levelReward = levelRewardView(afk, config);

  // 升级
  const mainlineStage = player?.mainlineStage ?? null;
  const maxLevel = afk && config ? afkMaxLevel(config, mainlineStage) : null;
  const have = bagStock.get(AFK_LV_ITEM) ?? 0;
  const upgradePlan = afk && config
    ? planAfkUpgrade(config, { level: afk.level, have, maxLevel })
    : { jump: 0, need: 0, have, reason: afk ? '没有配置表（OfflineCfg）' : '没有挂机信息' };
  // 只有「本段刚开」或「这一轮马上要领本段收益」才升级 —— 见文件头的说明。
  const segmentSafe = Boolean(afk && (afk.fresh || afk.ready));
  const upgrade = {
    level: afk?.level ?? null,
    maxLevel,
    have,
    need: upgradePlan.need,
    jump: segmentSafe ? upgradePlan.jump : 0,
    safe: segmentSafe,
    claimable: segmentSafe && upgradePlan.jump > 0,
    reason: !segmentSafe && upgradePlan.jump > 0
      ? '本段收益已累积，先领了再升级（升级会重置本段计时）'
      : upgradePlan.reason,
  };

  return {
    now,
    afk,
    mail: {
      total: mail.total,
      fetched: mail.emails.length,
      newCount: mail.emails.filter((entry) => Number(entry.status) === EMAIL_STATUS_NEW).length,
      ungotCount: mail.emails.filter((entry) => entry.attachment != null && entry.got !== true).length,
      claimable: mailClaimable(mail.emails),
    },
    levelReward,
    upgrade,
    stock: bagStock,
    config,
    notes,
  };
}

// 计划。顺序固定：邮件 → 本段收益 → 等级奖励 → 升级（升级挂 after，等本段收益真的领到再发）。
export function planIdle(survey, { now = null, config = null, allowUpgrade = true } = {}) {
  const at = now ?? survey.now ?? Math.floor(Date.now() / 1000);
  const actions = [];
  const notes = [...(survey.notes ?? [])];

  if (survey.mail?.claimable) {
    actions.push({
      kind: 'mailQuickGet',
      request: 'QuickGotReadEmailRequest',
      response: null,
      body: { all: true },
      // 常量 key（'mailQuickGet:'）：一次瞬时失败不该让整个挂机会话再也不领邮件，
      // 每轮重新探一遍邮箱本来就是幂等的，重试安全。
      transient: true,
      label: `邮件一键领取（新 ${survey.mail.newCount} / 未领附件 ${survey.mail.ungotCount}）`,
    });
  }

  // 本段收益 + 等级奖励：判据在 planAfkClaims 里（CLI 的 loot 用的是同一份）。
  actions.push(...planAfkClaims(survey.afk, config ?? survey.config, at));
  if (survey.afk && !survey.afk.ready) {
    notes.push(`挂机本段还剩 ${Math.ceil(survey.afk.remainSeconds / 60)} 分钟封顶`);
  }

  if (allowUpgrade && survey.upgrade?.claimable) {
    actions.push({
      kind: 'afkUpgrade',
      request: 'UpgradeAfkLevelRequest',
      response: 'UpgradeAfkLevelResponse',
      body: { level: survey.upgrade.jump },
      label: `挂机等级 +${survey.upgrade.jump}（花 ${survey.upgrade.need} ${AFK_LV_ITEM}）`,
      // 升级失败多半是「徽章刚被别处花掉」，下一轮的 survey 会重新算够不够，重试安全。
      transient: true,
      // 升级会重置本段计时：必须等本段收益真的领到了再发。
      after: 'afkDraw',
      // 只有「本段本来就刚开」时不需要等领取动作。
      afterSatisfied: survey.afk?.fresh === true,
    });
  } else if (allowUpgrade && survey.upgrade?.reason) {
    notes.push(`挂机等级：${survey.upgrade.reason}`);
  }

  return { actions, notes };
}

// 从回包里抠出奖励物品，给循环日志的「成功 挂机收益 金币×800」用。
function rewardPairs(body) {
  const pkg = body?.reward?.assetPackage ?? body?.assetPackage ?? null;
  const asset = pkg?.asset ?? [];
  return asset
    .map((entry) => [entry.id, assetCount(entry.num)])
    .filter(([id, num]) => Boolean(id) && num > 0);
}

// 逐条执行。带 after 的动作要等依赖的动作真的成功（升级依赖领本段收益）。
// rejected 语义跟 runWorld 一致：被服务端拒过的具体动作跨轮不再重发。
export async function runIdle(client, protocol, plan, {
  allowMutate = false,
  window = 800,
  timeout = 15000,
  rejected = new Set(),
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('领取挂机收益会改变账号状态，需要 --yes');
  const results = [];
  const okKinds = new Set();
  for (const step of plan.actions) {
    let entry;
    const key = `${step.kind}:${step.body?.level ?? ''}`;
    const unmet = step.after && !okKinds.has(step.after) && step.afterSatisfied !== true;
    if (unmet) {
      entry = { step, ok: false, skipped: true, error: `等「${step.after}」成功后再做` };
    } else if (rejected.has(key)) {
      entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
    } else if (!protocol[step.request]) {
      entry = { step, ok: false, error: `协议表里没有 ${step.request}` };
    } else {
      try {
        if (step.response && protocol[step.response]) {
          const body = await client.request(step.request, step.body, step.response, timeout);
          const items = rewardPairs(normalize(body));
          // 物品挂回 step：loop 的 detailLines 从 step.items 取「成功」明细。
          if (items.length) step.items = items;
          entry = { step, ok: true, body };
        } else {
          // 没有配套 Response：静默即成功，回包是 PromptResponse 就是被拒。
          const sent = await client.sendWatch(step.request, step.body, { window });
          entry = { step, ok: true, sent };
        }
      } catch (error) {
        // 被拒的动作跨轮记住（不再骚扰服务端），但瞬时动作不记：这些 key 里有的是常量
        // （afkDraw / mailQuickGet），记下来等于把整块功能关到进程结束。
        if (!step.transient) rejected.add(key);
        entry = { step, ok: false, error: error.message };
      }
    }
    if (entry.ok) okKinds.add(step.kind);
    results.push(entry);
    onStep?.(entry);
    if (entry.ok) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { results, rejected };
}

// 一行概览：挂机 Lv1（已领 0） · 本段还剩 3 小时 12 分 · 徽章 2（升级要 1） · 邮件 1 新
export function formatIdleSummary(survey) {
  const parts = [];
  if (survey.afk) {
    const afk = survey.afk;
    const time = afk.ready ? '本段已封顶' : `本段还剩 ${human(afk.remainSeconds)}`;
    parts.push(`挂机 Lv${afk.level}（已领到 ${afk.rewardedLevel}）`);
    parts.push(time);
    if (survey.upgrade) {
      const up = survey.upgrade;
      const cap = up.maxLevel == null ? '?' : up.maxLevel;
      // need 为 0 表示「算不出要几个」（比如主线上限卡住），这时别印成 0/? 这种看不懂的形状。
      parts.push(`${AFK_LV_ITEM} ${up.have}${up.need > 0 ? `/${up.need}` : ''}（上限 Lv${cap}）`);
    }
  } else {
    parts.push('挂机信息不可用');
  }
  if (survey.mail) {
    const mail = survey.mail;
    parts.push(mail.claimable
      ? `邮件 新 ${mail.newCount} / 未领附件 ${mail.ungotCount}`
      : `邮件 ${mail.total} 封都已领`);
  }
  return parts.join(' · ');
}

function human(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  if (m < 60) return m % 60 > 0 ? `${m} 分 ${m % 60} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return m % 60 > 0 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}
