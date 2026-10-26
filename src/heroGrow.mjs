// 主战英雄养成（主线出战阵容，GetFormationResponse）：在 heroes.mjs 的「等级 / 升星 / 技能」之外，补上
// **勋章（强化、替换）** 与 **装备（升级、精炼、升星、替换）**。
//
// 事实来源（反编译客户端 `subpackages/main/game.js` + 生产回包双向核对，无推测）：
// - 徽章数据在 `AllHeroResponse.heroes[].badges[]`（含 pos 1..4 与随机属性 attr），
//   背包里的在 `BadgesResponse.badge[]`（同一个 uid 池，已佩戴的也会出现在这里）。
// - 徽章等级上限只由「徽章 id + 星级」决定：`HeroBadgeAttrCfg[id_star].maxLevel`
//   （蓝坦克 star2 = 45 级，到顶就点不动）。每级消耗 `HeroBadgeLevelCfg[level]`：
//   `exp` 点经验 + `exp × goldExpRadio` 金币。
// - `EnhanceBadgeRequest { uid, decomposeUid[], expItemNum }`：客户端弹窗里
//   `_maxExpItemNum = getAssetNum("徽章经验")`，`expItemNum` 就是实际投入的经验点数，
//   `decomposeUid` 是额外的「分解掉换经验」的闲置徽章。**本模块恒发空数组**：
//   只花背包里的「徽章经验」道具，不分解任何徽章 —— 分解不可逆，没有收益判断依据时不做。
// - 徽章升星（`BadgeStarRequest`）需要分解 `HeroBadgeStarCfg[star].upBadgeNum` 个徽章，
//   客户端按 `equalBadgeNum` 折算，属于不可逆操作，本模块**只探测不执行**。
// - 替换方向（实证 `_onBtnPutOn` / `BadgeReplaceRequest`）：
//   `downUid` = 要穿上的那件（背包里更好的），`upUid` = 身上被换下的那件。
//   空位用 `PutOnBadgeRequest { uid, heroId, pos }` / `PutOnEquipRequest { uid, heroId }`。
// - 装备三件（武器 / 防具 / 饰品，`EquipCfg.type`）。三种养成走三条独立请求：
//   升级 `EnhanceEquipRequest{uid}`（消耗 `EquipUpDecomposeCfg[level+1].upgradeCost` 精铁，
//   上限 `EquipAttrCfg[id_star].maxLv`）—— 注意请求名是 EnhanceEquip，不是 EquipLevelUp；
//   精炼 `EquipRefineRequest{uid}`（`EquipRefineCfg[refineLv+1]`：精铁 ×costItem1 +
//   精炼石 ×costItem2，上限 `EquipAttrCfg[id_star].maxRefineLv`）；
//   升星 `EquipStarUpRequest{uid}`（`EquipUpStarCfg[star+1].upCosts`，上限 5 星）。
//   前两条与升星都**没有 Response**，成功静默 / 被拒推 PromptResponse，所以走 sendWatch。
// - 执行器直接复用 world.mjs 的 `runWorld`（它认 request/response/body/key/group/transient），
//   不另写一套 —— 那是本仓库唯一一份「失败隔离 + 跳过被拒动作」的实现。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, RESOURCE_NAMES } from './world.mjs';

export const BADGE_EXP_ITEM = '徽章经验';
export const BADGE_STAR_ITEM = '徽章升星石';
export const EQUIP_IRON = '精铁';
export const EQUIP_REFINE_ITEM = '精炼石';
export const EQUIP_STAR_ITEM = '装备升星石';
export const GOLD = 'GOLD';

// 装备部位。顺序固定，用于「空位先穿哪件」这类确定性输出。
export const EQUIP_SLOTS = ['武器', '防具', '饰品'];

export const MAX_EQUIP_STAR = 5;

// 一次执行的上限：每条升级请求只涨 1 级，不封顶会在精铁充足时一次发出几百条。
export const MAX_ACTIONS_PER_HERO = 80;

// 页面上的开关名与默认值。默认全开 = 「点执行就养成」；
// 替换类单独可关（它会把身上的东西换下来，属于不可逆的那一档）。
export const GROW_SWITCHES = {
  badgeEnhance: true,
  badgeReplace: true,
  equipLevel: true,
  equipRefine: true,
  equipStar: true,
  equipReplace: true,
};

export const SWITCH_LABELS = {
  badgeEnhance: '勋章强化',
  badgeReplace: '勋章替换',
  equipLevel: '装备升级',
  equipRefine: '装备精炼',
  equipStar: '装备升星',
  equipReplace: '装备替换',
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 徽章 / 装备的「谁更好」只做三级比较：品质 → 星级 → 等级。
// 随机属性（attr）类型不同不可比（初始法力 6 点 vs 法强 0.021），强行折算只会骗自己，
// 所以它不参与比较 —— 这也保证替换判定永远可以解释给用户听。
export function badgeScore(entry) {
  return num(entry.qualityIndex) * 1e6 + num(entry.star) * 1e4 + num(entry.level) * 100;
}

export function equipScore(entry) {
  return num(entry.qualityIndex) * 1e6 + num(entry.star) * 1e4 + num(entry.level) * 100 + num(entry.refineLv);
}

// 替换前的最低等级门槛：品质高但等级低到离谱的装备换上去会掉战力
// （属性 = baseAttrs + growAttrs × level）。低于旧件 60% 就先不动，日志里说清楚。
export const REPLACE_MIN_LEVEL_RATIO = 0.6;

function buildIndex(config) {
  return {
    hero: new Map(rowsOf(config, 'HeroCfg').map((row) => [row.id, row])),
    badge: new Map(rowsOf(config, 'HeroBadgeCfg').map((row) => [row.id, row])),
    badgeAttr: new Map(rowsOf(config, 'HeroBadgeAttrCfg').map((row) => [`${row.id}_${num(row.star)}`, row])),
    badgeLevel: new Map(rowsOf(config, 'HeroBadgeLevelCfg').map((row) => [num(row.level), row])),
    badgeStar: new Map(rowsOf(config, 'HeroBadgeStarCfg').map((row) => [num(row.star), row])),
    badgeUnlock: new Map(rowsOf(config, 'HeroBadgeUnlockCfg').map((row) => [num(row.pos), row])),
    equip: new Map(rowsOf(config, 'EquipCfg').map((row) => [row.id, row])),
    equipAttr: new Map(rowsOf(config, 'EquipAttrCfg').map((row) => [`${row.id}_${num(row.star)}`, row])),
    equipUpLevel: new Map(rowsOf(config, 'EquipUpDecomposeCfg').map((row) => [num(row.level), row])),
    equipRefine: new Map(rowsOf(config, 'EquipRefineCfg').map((row) => [num(row.level), row])),
    equipUpStar: new Map(rowsOf(config, 'EquipUpStarCfg').map((row) => [num(row.star), row])),
  };
}

export function badgeMaxLevel(index, badgeId, star) {
  return num(index.badgeAttr.get(`${badgeId}_${num(star)}`)?.maxLevel);
}

export function equipMaxLevel(index, equipId, star) {
  return num(index.equipAttr.get(`${equipId}_${num(star)}`)?.maxLv);
}

export function equipMaxRefine(index, equipId, star) {
  return num(index.equipAttr.get(`${equipId}_${num(star)}`)?.maxRefineLv);
}

// ---- 只读探测 ----------------------------------------------------------------

// 主战阵型的模块号。`FormationModule` 只有 MAINLINE=1 这一个值，
// 也就是「主线出战阵容」—— 页面上说的「主战英雄」就是这五个位置上的英雄。
export const FORMATION_MODULE_MAINLINE = 1;

// 六个请求一起打：英雄（带已佩戴的勋章/装备）、背包勋章、背包装备、物品、资源、当前阵型。
// 已佩戴的东西在两个列表里都有（同一个 uid 池），调用方要按 uid 去重。
export async function surveyHeroGrowth(client, protocol, { config, playerLevel = 1, timeout = 12000 } = {}) {
  const get = async (request, response, body = {}) => {
    if (!protocol[request] || !protocol[response]) return null;
    return normalize(await client.request(request, body, response, timeout));
  };
  const [heroBody, badgeBody, equipBody, itemBody, resourceBody, formationBody] = await Promise.all([
    get('AllHeroRequest', 'AllHeroResponse'),
    get('BadgesRequest', 'BadgesResponse'),
    get('EquipsRequest', 'EquipsResponse'),
    get('AllItemRequest', 'AllItemResponse'),
    get('AllResourceRequest', 'AllResourceResponse'),
    // 阵型是可选增强：拿不到就退回「所有英雄」，不能让整页探测失败。
    get('GetFormationRequest', 'GetFormationResponse', { module: FORMATION_MODULE_MAINLINE }).catch(() => null),
  ]);
  if (!heroBody) throw new Error('拿不到 AllHeroResponse，读不了英雄列表');

  const index = buildIndex(config);
  // 物品与资源合成一张库存表：GOLD 这类资源只出现在 AllResourceResponse 里，
  // 不合并的话「强化徽章要金币」永远判成不够。
  const stock = new Map();
  for (const item of itemBody?.items ?? []) {
    const id = item.itemId ?? item.id;
    stock.set(id, (stock.get(id) ?? 0) + assetCount(item.num ?? item.count));
  }
  for (const entry of resourceBody?.list ?? []) {
    const id = RESOURCE_NAMES[entry.res] ?? String(entry.res);
    stock.set(id, (stock.get(id) ?? 0) + assetCount(entry.amount));
  }

  const describeBadge = (raw, pos = null) => {
    const cfg = index.badge.get(raw.badgeId);
    return {
      uid: raw.uid,
      badgeId: raw.badgeId,
      pos,
      career: cfg?.career ?? '',
      quality: cfg?.quality ?? '',
      qualityIndex: num(cfg?.qualityIndex),
      level: num(raw.level),
      exp: num(raw.exp),
      star: num(raw.star),
      attr: raw.attr ? { attr: num(raw.attr.attr), value: num(raw.attr.value) } : null,
      score: badgeScore({ qualityIndex: num(cfg?.qualityIndex), star: num(raw.star), level: num(raw.level) }),
    };
  };

  const describeEquip = (raw) => {
    const cfg = index.equip.get(raw.equipId);
    const entry = {
      uid: raw.uid,
      equipId: raw.equipId,
      type: cfg?.type ?? '',
      quality: cfg?.quality ?? '',
      qualityName: cfg?.qualityName ?? '',
      qualityIndex: num(cfg?.qualityIndex),
      level: num(raw.level),
      star: num(raw.star),
      refineLv: num(raw.refineLv),
    };
    entry.score = equipScore(entry);
    return entry;
  };

  // 当前出战阵容。heroPositions 给的是 { heroId, pos{x,y} }，x 越小越靠前。
  const formationSlots = (formationBody?.formation?.heroPositions ?? [])
    .filter((slot) => slot && slot.heroId)
    .map((slot) => ({ heroId: slot.heroId, x: num(slot.pos?.x), y: num(slot.pos?.y) }));
  const formation = {
    presetId: num(formationBody?.formation?.presetId),
    heroes: formationSlots,
    heroIds: formationSlots.map((slot) => slot.heroId),
  };
  const frontSet = new Set(formation.heroIds);

  const heroes = (heroBody.heroes ?? []).map((raw) => {
    const hero = normalize(raw);
    const cfg = index.hero.get(hero.heroId);
    return {
      heroId: hero.heroId,
      level: num(hero.level),
      star: num(hero.star),
      exp: assetCount(hero.exp),
      power: assetCount(hero.power),
      career: cfg?.career ?? '',
      quality: cfg?.quality ?? '',
      qualityIndex: num(cfg?.qualityIndex),
      // 是否在主线出战阵容里 —— 页面上「主战英雄」就是这一批。
      front: frontSet.has(hero.heroId),
      skillLevels: (hero.skillLevels ?? []).map(num),
      badges: (hero.badges ?? []).filter((one) => one && one.badgeId).map((one) => describeBadge(one, num(one.pos))),
      equips: (hero.equips ?? []).filter((one) => one && one.equipId).map(describeEquip),
    };
  });

  const wornBadgeUids = new Set();
  for (const hero of heroes) for (const one of hero.badges) wornBadgeUids.add(one.uid);
  const wornEquipUids = new Set();
  for (const hero of heroes) for (const one of hero.equips) wornEquipUids.add(one.uid);

  const badgeBag = (badgeBody?.badge ?? [])
    .map((raw) => normalize(raw))
    .map((raw) => ({ ...describeBadge(raw), worn: wornBadgeUids.has(raw.uid) }));
  const equipBag = (equipBody?.equip ?? [])
    .map((raw) => normalize(raw))
    .map((raw) => ({ ...describeEquip(raw), worn: wornEquipUids.has(raw.uid) }));

  return {
    at: Math.floor(Date.now() / 1000),
    playerLevel,
    index,
    stock,
    heroes,
    // 主战阵型（主线出战）。拉不到时 heroIds 为空，调用方按「全部英雄」退化处理。
    formation,
    badgeBag,
    equipBag,
    // 已解锁的勋章位：pos → 需要英雄等级。徽章位按英雄等级逐个解锁（1/70/90/110）。
    badgeSlots: [...index.badgeUnlock.values()]
      .map((row) => ({ pos: num(row.pos), level: num(row.level) }))
      .sort((a, b) => a.pos - b.pos),
  };
}

// ---- 计划 --------------------------------------------------------------------

function makeBudget(stock) {
  const left = new Map(stock);
  return {
    left,
    have: (id) => left.get(id) ?? 0,
    take(id, n) {
      const want = num(n);
      if (want <= 0) return true;
      const now = left.get(id) ?? 0;
      if (now < want) return false;
      left.set(id, now - want);
      return true;
    },
    takeAll(pairs) {
      const need = (pairs ?? []).filter((pair) => Array.isArray(pair) && pair[0] && num(pair[1]) > 0);
      if (!need.every(([id, n]) => (left.get(id) ?? 0) >= num(n))) return false;
      for (const [id, n] of need) left.set(id, (left.get(id) ?? 0) - num(n));
      return true;
    },
  };
}

function costText(pairs) {
  return pairs.filter(([, n]) => num(n) > 0).map(([id, n]) => `${id}×${num(n)}`).join(' + ');
}

function goldText(n) {
  const value = num(n);
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(Math.round(value));
}

// 徽章强化：从当前等级往上加，每级按 `HeroBadgeLevelCfg[目标级]` 扣经验与金币。
// 与客户端 `calBadgeEnhanceExpAndGoldInLimit` 同一套推进方式（逐级、余量可跨级）。
function planBadgeEnhance(badge, index, budget) {
  const maxLevel = badgeMaxLevel(index, badge.badgeId, badge.star);
  if (!maxLevel || badge.level >= maxLevel) return null;
  let level = badge.level;
  let expInLevel = badge.exp;
  let spentExp = 0;
  let spentGold = 0;
  let gained = 0;
  while (level < maxLevel) {
    const row = index.badgeLevel.get(level + 1);
    if (!row) break;
    const need = Math.max(0, num(row.exp) - expInLevel);
    const unit = num(row.goldExpRadio);
    const byGold = unit > 0 ? Math.floor(budget.have(GOLD) / unit) : Number.POSITIVE_INFINITY;
    const afford = Math.min(budget.have(BADGE_EXP_ITEM), byGold, need);
    if (afford <= 0) break;
    budget.take(BADGE_EXP_ITEM, afford);
    if (unit > 0) budget.take(GOLD, afford * unit);
    spentExp += afford;
    spentGold += afford * unit;
    if (afford >= need) {
      level += 1;
      expInLevel = 0;
      gained += 1;
    } else {
      expInLevel += afford;
      break;
    }
  }
  // 一级都升不满就不发：投入了经验却没涨级，看不出效果，还占一条动作。
  if (gained === 0) return null;
  return { from: badge.level, to: level, gained, exp: spentExp, gold: spentGold };
}

// 空位 / 更优件的替换候选。同职业才穿（徽章 id 带职业，跨职业穿上去大概率不加属性）。
// minLevel 用来把「品质更高但等级低到会掉战力」的件挡在候选池外 —— 如果只在选中之后
// 再判断，一个紫 lv1 就会把背包里真正能换的蓝 lv40 挡住，结果是两边都没换上。
function bestCandidate(pool, heroCareer, exclude, { needSameCareer = true, minLevel = 0 } = {}) {
  const usable = pool
    .filter((one) => !one.worn && !exclude.has(one.uid))
    .filter((one) => !needSameCareer || !heroCareer || one.career === heroCareer)
    .filter((one) => one.level >= minLevel);
  if (!usable.length) return null;
  return usable.sort((a, b) => b.score - a.score)[0];
}

// 把「一件装备升 6 级」这类被拆开的明细收成一句话。页面上每个英雄最多几行，
// 不能因为升了 6 级就刷 6 行 —— 那会让真正稀有的动作（换装备、换勋章）被淹没。
function finalizeItems(items) {
  return items.map((item) => {
    if (!item.mergeKey) return { kind: item.kind, text: item.text };
    if (item.kind === 'equipLevel') {
      return { kind: item.kind, text: `${item.title} ${item.from}→${item.to} 级（+${item.to - item.from}，精铁 ${item.cost}）` };
    }
    if (item.kind === 'equipRefine') {
      return { kind: item.kind, text: `${item.title} ${item.from}→${item.to}${item.cost ? `（精铁 ${item.cost}）` : ''}` };
    }
    return { kind: item.kind, text: `${item.title} ${item.from}→${item.to} 星` };
  });
}

export function planHeroGrowth(survey, { switches = {}, heroIds = null, onlyFront = true } = {}) {
  const on = { ...GROW_SWITCHES, ...switches };
  const index = survey.index;
  const budget = makeBudget(survey.stock);
  const notes = [];
  const actions = [];
  const heroes = [];

  // 战力高的先吃资源：精铁 / 徽章经验有限时，同样的材料给主 C 收益最大。
  // 每个英雄都复制一份再往上改（后面要「穿上→强化」地推演），不能污染 survey ——
  // 调用方拿 survey 当原始快照显示，被改了就会把计划值当成当前值。
  //
  // onlyFront：默认只养当前出战阵容（GetFormationResponse 的 5 个位置）。拉不到阵型
  // （heroIds 为空）时退化成「全部英雄」，否则整页会一条动作都排不出来。
  const hasFormation = (survey.formation?.heroIds ?? []).length > 0;
  const picked = survey.heroes
    .filter((hero) => (heroIds ? heroIds.includes(hero.heroId) : true))
    .filter((hero) => (heroIds || !onlyFront || !hasFormation ? true : hero.front))
    .sort((a, b) => b.power - a.power)
    .map((hero) => ({
      ...hero,
      badges: hero.badges.map((one) => ({ ...one })),
      equips: hero.equips.map((one) => ({ ...one })),
    }));

  // 背包里的候选按英雄逐个消耗：一件装备/一个徽章只能穿到一个英雄身上。
  const usedUids = new Set();

  for (const hero of picked) {
    // 一件装备升 6 级会拆成 6 条请求，但页面上只该占一行 —— 所以先记明细，
    // 结束时按 mergeKey 合并（每级都显示一遍会把表格撑成几百行）。
    const items = [];
    const heroActions = [];
    const push = (action, item) => {
      if (heroActions.length >= MAX_ACTIONS_PER_HERO) return false;
      heroActions.push(action);
      if (item.mergeKey) {
        const found = items.find((one) => one.mergeKey === item.mergeKey);
        if (found) {
          // from/to/cost 传的都是「从起点累计到现在」的值，直接覆盖，不能再累加
          // （累加过一次，橙装升 6 级就显示成耗精铁 15900，而背包里只有 5218）。
          found.to = item.to;
          if (item.cost !== undefined) found.cost = item.cost;
        } else {
          items.push({ kind: action.kind, ...item });
        }
      } else {
        items.push({ kind: action.kind, text: item.text });
      }
      return true;
    };

    // ---- 勋章替换：先换（抬高基数），再强化 ----
    if (on.badgeReplace) {
      for (const slot of survey.badgeSlots) {
        if (hero.level < slot.level) continue;
        const current = hero.badges.find((one) => one.pos === slot.pos) ?? null;
        // 已有徽章时把「等级太低」的候选直接排除（见 bestCandidate 注释）。
        const best = bestCandidate(survey.badgeBag, hero.career, usedUids, {
          minLevel: current ? current.level * REPLACE_MIN_LEVEL_RATIO : 0,
        });
        if (!best) continue;
        if (!current) {
          usedUids.add(best.uid);
          hero.badges.push({ ...best, pos: slot.pos });
          push({
            kind: 'badgePutOn',
            request: 'PutOnBadgeRequest',
            response: null,
            body: { uid: best.uid, heroId: hero.heroId, pos: slot.pos },
            key: `badgePutOn:${hero.heroId}:${slot.pos}:${best.uid}`,
            group: `hero:${hero.heroId}:badge`,
            transient: true,
            label: `${hero.heroId} 第${slot.pos}枚勋章位戴上「${best.badgeId}」lv${best.level} ${best.star}星`,
          }, { text: `戴勋章 ${best.badgeId} lv${best.level} ${best.star}星 → 第${slot.pos}位` });
          continue;
        }
        if (best.score <= current.score) continue;
        usedUids.add(best.uid);
        const pos = slot.pos;
        hero.badges = hero.badges.map((one) => (one.pos === pos ? { ...best, pos } : one));
        push({
          kind: 'badgeReplace',
          request: 'BadgeReplaceRequest',
          response: 'BadgeReplaceResponse',
          body: { downUid: best.uid, upUid: current.uid },
          key: `badgeReplace:${hero.heroId}:${pos}:${best.uid}`,
          group: `hero:${hero.heroId}:badge`,
          transient: true,
          label: `${hero.heroId} 第${pos}位：「${best.badgeId}」lv${best.level} ${best.star}星 换下「${current.badgeId}」lv${current.level} ${current.star}星`,
        }, { text: `换勋章 第${pos}位：${current.badgeId} lv${current.level} ${current.star}星 → ${best.badgeId} lv${best.level} ${best.star}星` });
      }
    }

    // ---- 勋章强化：只花「徽章经验」道具，不分解任何徽章 ----
    if (on.badgeEnhance) {
      for (const badge of [...hero.badges].sort((a, b) => b.score - a.score)) {
        const delta = planBadgeEnhance(badge, index, budget);
        if (!delta) continue;
        badge.level = delta.to;
        push({
          kind: 'badgeEnhance',
          request: 'EnhanceBadgeRequest',
          response: 'EnhanceBadgeResponse',
          // decomposeUid 恒空：客户端的经验来自「徽章经验」道具，分解徽章是不可逆的，这里不做。
          body: { uid: badge.uid, decomposeUid: [], expItemNum: delta.exp },
          key: `badgeEnhance:${badge.uid}:${delta.to}`,
          group: `hero:${hero.heroId}:badge`,
          transient: true,
          label: `${hero.heroId} 强化「${badge.badgeId}」${delta.from} → ${delta.to} 级（经验 ${delta.exp} · 金币 ${goldText(delta.gold)}）`,
        }, { text: `勋章 ${badge.badgeId} ${delta.from}→${delta.to} 级（+${delta.gained}）` });
      }
    }

    // ---- 装备替换 ----
    if (on.equipReplace) {
      for (const type of EQUIP_SLOTS) {
        const current = hero.equips.find((one) => one.type === type) ?? null;
        const pool = survey.equipBag.filter((one) => one.type === type);
        const best = bestCandidate(pool, '', usedUids, {
          needSameCareer: false,
          minLevel: current ? current.level * REPLACE_MIN_LEVEL_RATIO : 0,
        });
        if (!best) continue;
        if (!current) {
          usedUids.add(best.uid);
          hero.equips.push(best);
          push({
            kind: 'equipPutOn',
            request: 'PutOnEquipRequest',
            response: null,
            body: { uid: best.uid, heroId: hero.heroId },
            key: `equipPutOn:${hero.heroId}:${type}:${best.uid}`,
            group: `hero:${hero.heroId}:equip`,
            transient: true,
            label: `${hero.heroId} 穿上 ${type}「${best.equipId}」lv${best.level} ${best.star}星`,
          }, { text: `穿装备 ${type}：${best.equipId} lv${best.level} ${best.star}星` });
          continue;
        }
        if (best.score <= current.score) continue;
        usedUids.add(best.uid);
        hero.equips = hero.equips.map((one) => (one === current ? best : one));
        push({
          kind: 'equipReplace',
          request: 'EquipReplaceRequest',
          response: 'EquipReplaceResponse',
          body: { downUid: best.uid, upUid: current.uid },
          key: `equipReplace:${hero.heroId}:${type}:${best.uid}`,
          group: `hero:${hero.heroId}:equip`,
          transient: true,
          label: `${hero.heroId} ${type}：「${best.equipId}」lv${best.level} ${best.star}星 换下「${current.equipId}」lv${current.level} ${current.star}星`,
        }, { text: `换装备 ${type}：${current.equipId} lv${current.level} ${current.star}星 → ${best.equipId} lv${best.level} ${best.star}星` });
      }
    }

    // ---- 装备三种养成：升级（精铁）→ 精炼（精铁+精炼石）→ 升星（升星石+精铁）----
    for (const equip of [...hero.equips].sort((a, b) => b.score - a.score)) {
      if (on.equipLevel) {
        const maxLv = equipMaxLevel(index, equip.equipId, equip.star);
        const from = equip.level;
        let level = from;
        let iron = 0;
        while (maxLv && level < maxLv) {
          // 先看还能不能塞进本轮动作上限，再扣材料：反过来的话，超限那一级的材料
          // 已经从共享预算里拿走了，后面的英雄会凭空少一截。
          if (heroActions.length >= MAX_ACTIONS_PER_HERO) break;
          const cost = num(index.equipUpLevel.get(level + 1)?.upgradeCost);
          if (!budget.take(EQUIP_IRON, cost)) break;
          iron += cost;
          level += 1;
          push({
            kind: 'equipLevel',
            request: 'EnhanceEquipRequest',
            response: null,
            body: { uid: equip.uid },
            // 每级一条请求，key 必须带目标等级，否则第 2 级起会撞成同一条被去重。
            key: `equipLevel:${equip.uid}:${level}`,
            group: `hero:${hero.heroId}:equipLevel`,
            transient: true,
            label: `${hero.heroId} 装备「${equip.equipId}」升到 ${level} 级（精铁 ${cost}）`,
          }, { mergeKey: `level:${equip.uid}`, title: `装备 ${equip.equipId} 升级`, from, to: level, cost: iron });
        }
        equip.level = level;
      }

      if (on.equipRefine) {
        const maxRefine = equipMaxRefine(index, equip.equipId, equip.star);
        const from = equip.refineLv;
        let refineLv = from;
        let iron = 0;
        while (refineLv < maxRefine) {
          if (heroActions.length >= MAX_ACTIONS_PER_HERO) break;
          const row = index.equipRefine.get(refineLv + 1);
          if (!row) break;
          // takeAll 是原子的：精铁够、精炼石不够时一件都不扣。
          if (!budget.takeAll([[EQUIP_IRON, row.costItem1], [EQUIP_REFINE_ITEM, row.costItem2]])) break;
          iron += num(row.costItem1);
          refineLv += 1;
          push({
            kind: 'equipRefine',
            request: 'EquipRefineRequest',
            response: null,
            body: { uid: equip.uid },
            key: `equipRefine:${equip.uid}:${refineLv}`,
            group: `hero:${hero.heroId}:equipRefine`,
            transient: true,
            label: `${hero.heroId} 装备「${equip.equipId}」精炼到 ${refineLv}（${costText([[EQUIP_IRON, row.costItem1], [EQUIP_REFINE_ITEM, row.costItem2]])}）`,
          }, { mergeKey: `refine:${equip.uid}`, title: `装备 ${equip.equipId} 精炼`, from, to: refineLv, cost: iron });
        }
        equip.refineLv = refineLv;
      }

      if (on.equipStar) {
        const from = equip.star;
        let star = from;
        let iron = 0;
        while (star < MAX_EQUIP_STAR) {
          if (heroActions.length >= MAX_ACTIONS_PER_HERO) break;
          const row = index.equipUpStar.get(star + 1);
          const costs = row?.upCosts ?? [];
          if (!costs.length) break;
          if (!budget.takeAll(costs)) break;
          iron += num(costs.find(([id]) => id === EQUIP_IRON)?.[1] ?? 0);
          star += 1;
          push({
            kind: 'equipStar',
            request: 'EquipStarUpRequest',
            response: null,
            body: { uid: equip.uid },
            key: `equipStar:${equip.uid}:${star}`,
            group: `hero:${hero.heroId}:equipStar`,
            transient: true,
            label: `${hero.heroId} 装备「${equip.equipId}」升到 ${star} 星（${costText(costs)}）`,
          }, { mergeKey: `star:${equip.uid}`, title: `装备 ${equip.equipId} 升星`, from, to: star, cost: iron });
        }
        equip.star = star;
      }
    }

    actions.push(...heroActions);
    heroes.push({
      heroId: hero.heroId,
      level: hero.level,
      star: hero.star,
      power: hero.power,
      career: hero.career,
      quality: hero.quality,
      qualityIndex: hero.qualityIndex,
      badges: hero.badges.map((one) => ({
        pos: one.pos, badgeId: one.badgeId, level: one.level, star: one.star, qualityIndex: one.qualityIndex,
      })),
      equips: hero.equips.map((one) => ({
        type: one.type, equipId: one.equipId, level: one.level, star: one.star, refineLv: one.refineLv,
      })),
      items: finalizeItems(items),
    });
  }

  return { actions, notes, heroes, switches: on };
}

// 页面表格的一行：把「英雄本体（等级/升星/技能）」与「勋章 / 装备」合成同一条记录。
// 抽成独立函数是为了离线也能渲染同一份数据（自检与截图核对），server 只往上补图标。
export function buildHeroRows(survey, plan, growth, { onlyFront = true } = {}) {
  const bodySteps = new Map();
  for (const step of plan.steps) {
    const list = bodySteps.get(step.heroId) ?? [];
    list.push(step);
    bodySteps.set(step.heroId, list);
  }
  const growthByHero = new Map(growth.heroes.map((one) => [one.heroId, one]));
  const hasFormation = (survey.formation?.heroIds ?? []).length > 0;

  return survey.heroes
    // 默认只列主战英雄（出战阵容）；「含未上阵」时才把整本英雄册摊开。
    .filter((hero) => (!onlyFront || !hasFormation ? true : hero.front))
    .map((hero) => {
      const grow = growthByHero.get(hero.heroId);
      const steps = bodySteps.get(hero.heroId) ?? [];
      const levelStep = steps.find((step) => step.kind === 'level');
      const starSteps = steps.filter((step) => step.kind === 'star');
      const skillSteps = steps.filter((step) => step.kind === 'skill');
      const items = grow?.items ?? [];
      return {
        heroId: hero.heroId,
        name: hero.heroId,
        level: hero.level,
        star: hero.star,
        power: hero.power,
        career: hero.career,
        quality: hero.quality,
        qualityIndex: hero.qualityIndex,
        // 主战 = 在主线出战阵容里。
        front: Boolean(hero.front),
        skillLevels: hero.skillLevels,
        badges: hero.badges,
        equips: hero.equips,
        // 英雄本体：等级 / 升星 / 技能各一行口径。
        kpi: {
          level: levelStep ? `lv${levelStep.from}→${levelStep.to}（+${levelStep.count}）` : null,
          star: starSteps.length ? `${hero.star}→${starSteps[starSteps.length - 1].to}（+${starSteps.length}）` : null,
          skill: skillSteps.length ? `${skillSteps.length} 项` : null,
        },
        badgeItems: items.filter((one) => one.kind.startsWith('badge')).map((one) => one.text),
        equipItems: items.filter((one) => one.kind.startsWith('equip')).map((one) => one.text),
        actions: items.length,
      };
    })
    .sort((a, b) => b.power - a.power);
}

export function formatHeroGrowth(plan) {  const lines = [];
  for (const hero of plan.heroes) {
    if (!hero.items.length) continue;
    lines.push(`${hero.heroId} lv${hero.level} ${hero.star}星`);
    for (const item of hero.items) lines.push(`  · ${item.text}`);
  }
  for (const note of plan.notes) lines.push(`跳过 ${note}`);
  if (!plan.actions.length) lines.push('没有可提升的地方（材料不够或都到顶了）');
  return lines.join('\n');
}

// 页面表格用的一句话概览：每种养成各一条，带上前后的数字。
export function growthSummary(hero) {
  if (!hero.items.length) return '无';
  return hero.items.map((item) => item.text).join('；');
}
