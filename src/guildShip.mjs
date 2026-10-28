// 联盟商船（活动 GuildShip）—— 全联盟一起「凑货舱」，凑齐就启航，船长和登船成员拿**同样**的奖励。
//
// 规则来源：客户端 TipsDescCfg「联盟商船」原文 + 反编译 GuildShipModel / GuildShipLeaderPop /
// GuildShipCargoPop / GuildShipUtil + 协议表 + 2026-10-28 12:30 实盘（4 艘船 + 补货一次）核对。
//
// 【规则原文要点（客户端弹窗）】
//   · 商船定期在联盟码头刷新，所有成员都能看到当前列表。
//   · 每艘船要派**英雄当船长**才能启航（应聘船长的英雄要满足 leaderCond 的星级）。
//   · 有船长后才开启「补货」：联盟成员完成某个货舱的订单需求，就**自动登船**。
//   · 所有货舱的订单都完成后，船立刻启航；到达目的地后船长与全体登船成员都拿奖励。
//   · 规格：史诗(PURPLE) 2.5 小时 / 传说(ORANGE) 5 小时 / 超凡(RED) 9 小时，规格越高奖励越好。
//   · 刷新：每天 8/11/14/17/20/23 点，史诗与传说**各自补满至 shipNum 艘**（第 1 赛季 2 艘），
//     并重置船长与货舱需求。超凡每天最多 2 艘（8/11/14 随机一艘、17/20/23 随机一艘），
//     港口同时只能停 1 艘，旧船没走新船不刷新。
//   · 补货阶段只有 **30 分钟**（GuildShipParamCfg.duration）；没达标的船会被**重置并遣返船长**，
//     已提交的商品**退还**。达标线：史诗 1 个舱 / 传说 2 个舱 / 超凡 3 个舱。
//   · **船长不需要完成订单**（也补不了货 —— 实盘 `GuildShipOrderRequest` 回 `captain cannot resupply`）。
//   · **每个玩家最多同时登上 2 艘**（`GuildShipParamCfg.shipNum`）；船员每条船只补 1 个货舱。
//   · 活动结束前 10 分钟提前结算，未出发的船不能再应聘/补货。
//
// 【协议】
//   GuildShipRequest {}                     → GuildShipResponse {period, ship[], ownRun[], worldShip[]}
//   GuildShipSeekRequest {shipId}           → 无 Response（静默即成功，被拒走 PromptResponse）
//   GuildShipOrderRequest {shipId, crewId}  → 无 Response（同上）
//   DispGuildShip {shipId, type, state, leaderCond[], leader, cabin[], reward,
//                  preparedEndTime, cityId, mvToCityId, mvStartTime, mvEndTime, pos}
//   GuildShipCabin {crewId, order:[{type,id,num}], player}
//   GuildShipState = 1 GS_STATE_PREPARED（补货中）/ 2 GS_STATE_MOVING（航行中）
//   GuildShipType  = 1 GUILD_SHIP_S(PURPLE) / 2 GUILD_SHOP_M(ORANGE) / 3 GUILD_SHOP_L(RED)
//
// 【自动化边界】
//   · 只补**材料已经够**的货舱。客户端在缺料时会弹「购买」（`buyProducts`，花钻石），
//     本工具不接那条路 —— 缺料就等工厂产，绝不花钱买货舱材料。
//   · 船长是**零成本赌队友**（补不齐只遣返，不扣资源），所以剩余名额可以当船长；
//     但名额总共只有 2 个、且一旦上船就被锁到船到港（2.5~9 小时），所以船员优先、
//     优先挑「空舱少 = 快启航」的船，名额释放得快。

const num = (v) => Number(v ?? 0) || 0;

// int64 字段（playerId / order[].num）在 protobuf 里是 Long 对象，**不能直接 Number()**。
// ⚠ 坑：protobufjs 的 `low` 是**有符号** int32，玩家 id 这种 3.4e13 的大数 low 会是负数，
// 直接用 `low + high*2^32` 会算出错的（甚至负的）值 —— 实测我的 playerId 被算成 -1058096678，
// 于是「我是不是这艘船的船长」判成 false，计划器就会让船长去补自己的船（服务端回
// `captain cannot resupply`）。所以优先走 Long.toString()，退路才手工拼。
export function bigNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return Number(v) || 0;
  if (v && typeof v === 'object') {
    if (typeof v.toString === 'function' && v.toString !== Object.prototype.toString) {
      const s = v.toString();
      if (/^-?\d+$/.test(s)) return Number(s);
    }
    const low = Number(v.low ?? 0) >>> 0;
    const high = Number(v.high ?? 0);
    return high * 2 ** 32 + low;
  }
  return Number(v ?? 0) || 0;
}

export const GS_STATE_PREPARED = 1;
export const GS_STATE_MOVING = 2;

const QUALITY_NAME = { PURPLE: '史诗', ORANGE: '传说', RED: '超凡' };
// 补货不达标的门槛（TipsDesc 原文：史诗 1 舱 / 传说 2 舱 / 超凡 3 舱）。
const MIN_FILLED = { 1: 1, 2: 2, 3: 3 };

export function gsParams(config) {
  const row = config?.tables?.GuildShipParamCfg?.data?.[0] ?? {};
  const hours = Array.isArray(row.time) ? row.time.map(num).filter((h) => h >= 0 && h < 24) : [];
  return {
    maxShips: Math.max(1, num(row.shipNum) || 2),
    prepareMinutes: Math.max(1, num(row.duration) || 30),
    refreshHours: hours.length > 0 ? hours.slice().sort((a, b) => a - b) : [8, 11, 14, 17, 20, 23],
  };
}

// GuildShipCfg 用 shipId(=type) 查规格：品质、货舱数、航行分钟数。
export function gsShipSpec(config, type) {
  const row = (config?.tables?.GuildShipCfg?.data ?? []).find((r) => num(r.shipId) === num(type));
  if (!row) return null;
  return {
    type: num(row.shipId),
    quality: String(row.quality ?? ''),
    qualityName: QUALITY_NAME[row.quality] ?? String(row.quality ?? ''),
    cabins: Math.max(1, num(row.num) || 1),
    minutes: num(row.time) || 0,
  };
}

// 下一个刷新点（照抄客户端 GuildShipUtil.getNextRefreshTime）。
export function nextRefreshAt(nowMs, params) {
  const d = new Date(nowMs);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const passed = nowMs / 1000 - dayStart;
  const hit = params.refreshHours.find((h) => h * 3600 > passed);
  return hit === undefined ? dayStart + 86_400 + params.refreshHours[0] * 3600 : dayStart + hit * 3600;
}

// 英雄能不能当这艘船的船长：**每一条** leaderCond 都要满足
// `英雄星级 + 专武星级 >= star + exStar`（客户端 GuildShipLeaderPop._checkCanSeek 同款）。
export function seekCheck(conds, heroes) {
  for (const cond of conds ?? []) {
    const heroId = String(cond?.heroId ?? '');
    if (!heroId) continue;
    const hero = heroes?.get ? heroes.get(heroId) : heroes?.[heroId];
    if (!hero) return { ok: false, why: `没有英雄「${heroId}」` };
    const have = num(hero.star) + num(hero.exStar);
    const need = num(cond.star) + num(cond.exStar);
    if (have < need) return { ok: false, why: `${heroId} 要 ${need} 星，现在 ${have} 星` };
  }
  return { ok: true, why: '' };
}

export async function surveyGuildShip(client, protocol, { timeout = 10_000, now = Date.now() } = {}) {
  const res = await client.request('GuildShipRequest', {}, 'GuildShipResponse', timeout);
  return {
    now,
    period: num(res?.period),
    ships: Array.isArray(res?.ship) ? res.ship : [],
    ownRun: Array.isArray(res?.ownRun) ? res.ownRun : [],
  };
}

// 货舱需求 → { needs:[{id, num}], short:[{id, need, have}] }
function cabinNeeds(order, stock) {
  const needs = [];
  const short = [];
  for (const row of order ?? []) {
    const id = String(row?.id ?? '');
    if (!id) continue;
    const need = bigNum(row.num);
    const have = stock?.get ? (stock.get(id) ?? 0) : Number(stock?.[id] ?? 0) || 0;
    needs.push({ id, num: need, have });
    if (have < need) short.push({ id, need, have });
  }
  return { needs, short };
}

// 奖励折成一个可比的数字：只看「有几种 + 大致量级」。
// 具体值多少钱不重要（这些奖励都是白拿的），排序时用它挑规格高、内容多的船就够。
function rewardScore(asset) {
  let score = 0;
  for (const row of asset ?? []) {
    const n = bigNum(row?.num);
    score += Math.min(50, Math.log10(Math.max(1, n) + 1) * 10);
  }
  return Math.round(score * 10) / 10;
}

export function viewGuildShip(survey, { config = null, stock = null, heroes = null, playerId = 0, now = null } = {}) {
  const me = num(playerId);
  const at = now ?? survey?.now ?? Date.now();
  const params = gsParams(config);
  const period = num(survey?.period);
  const open = period > 0;

  // 我占了名额的船：我当船长的，或者我补过某个舱的。
  const myShips = [];
  const ships = [];
  for (const raw of survey?.ships ?? []) {
    const spec = gsShipSpec(config, raw?.type) ?? { type: num(raw?.type), quality: '', qualityName: '?', cabins: 0, minutes: 0 };
    // ⚠ 玩家 id 是 int64：用 num() 判空会得到 0（Number({low,high}) = NaN），
    // 于是「有船长」被判成「没船长」，整条船的逻辑全错。必须走 bigNum。
    const leader = raw?.leader && bigNum(raw.leader.playerId) !== 0 ? raw.leader : null;
    const leaderId = bigNum(leader?.playerId);
    const mineLeader = Boolean(leader) && leaderId === me;
    const cabins = [];
    let myCabinId = null;
    for (const cabin of raw?.cabin ?? []) {
      const crewId = num(cabin?.crewId);
      const owner = cabin?.player && bigNum(cabin.player.playerId) !== 0 ? cabin.player : null;
      const byMe = Boolean(owner) && bigNum(owner?.playerId) === me;
      if (byMe) myCabinId = crewId;
      const { needs, short } = cabinNeeds(cabin?.order, stock);
      cabins.push({
        crewId,
        ownerId: bigNum(owner?.playerId),
        ownerName: owner?.nickname ?? '',
        filled: Boolean(owner),
        byMe,
        needs,
        short,
        // 舱空着、而且是「我这个身份能补的」才叫可补（船长不能补自己的船）。
        canFill: !owner && !mineLeader,
      });
    }
    const filledCount = cabins.filter((c) => c.filled).length;
    const emptyCabins = cabins.filter((c) => !c.filled);
    const leftSeconds = num(raw?.preparedEndTime) > 0
      ? Math.max(0, num(raw.preparedEndTime) - Math.floor(at / 1000))
      : 0;
    // 补货窗口：preparedEndTime 存在且还没过。没船长的船 preparedEndTime=0，还没开始计时。
    const filling = num(raw?.preparedEndTime) > 0 && leftSeconds > 0;
    const state = num(raw?.state);
    if (mineLeader || myCabinId !== null) {
      myShips.push({ shipId: num(raw.shipId), role: mineLeader ? 'leader' : 'crew', state });
    }
    ships.push({
      shipId: num(raw?.shipId),
      pos: num(raw?.pos),
      ...spec,
      state,
      stateName: state === GS_STATE_MOVING ? '航行中' : (leader ? '补货中' : '待应聘'),
      leaderId,
      leaderName: leader?.nickname ?? '',
      mineLeader,
      myCabinId,
      mine: mineLeader || myCabinId !== null,
      cabinTotal: cabins.length || spec.cabins,
      filledCount,
      emptyCount: emptyCabins.length,
      // 达标线：几个舱被补上，这船就不会被重置。
      passLine: MIN_FILLED[spec.type] ?? 1,
      filling,
      endAt: num(raw?.preparedEndTime),
      leftSeconds,
      cabins,
      // 我能补的舱：**有船长**（没船长时补货阶段压根没开启）+ 空着 + 材料齐 +
      // 我不是这船的船长 + 我在这船上还没有舱（每条船只补 1 个）。
      fillable: (leaderId && myCabinId === null && state !== GS_STATE_MOVING
        ? cabins.filter((c) => c.canFill && c.short.length === 0).map((c) => ({ crewId: c.crewId, needs: c.needs }))
        : []),
      // 缺料的舱：明确列出来，日志里说清「为什么没补」。
      blocked: (leaderId && myCabinId === null && state !== GS_STATE_MOVING
        ? cabins.filter((c) => c.canFill && c.short.length > 0).map((c) => ({ crewId: c.crewId, short: c.short }))
        : []),
      seekCheck: seekCheck(raw?.leaderCond, heroes),
      rewardAsset: (raw?.reward?.asset ?? []).map((a) => ({ id: String(a.id), num: bigNum(a.num) })),
      rewardScore: rewardScore(raw?.reward?.asset),
    });
  }

  // 在航的船：还没到港，但**名额照样被占着**（一旦上船就锁到到港才释放）。
  // ⚠ 实盘 2026-10-28 14:41：码头 0 艘是我的、在航 2 艘，slotsLeft 却算成 2 →
  //   补货和应聘都被 `server prompt: ship slot limit` 拒掉（计划 2 / 成功 0 / 失败 2）。
  //   `GuildShipResponse.ownRun` 就是「我自己在航的船」，必须一起算进名额。
  const ownRun = (survey?.ownRun ?? []).map((s) => ({
    shipId: num(s?.shipId),
    type: num(s?.type),
    state: num(s?.state),
    moveEndAt: num(s?.mvEndTime),
  }));
  const dockMine = new Set(myShips.map((s) => s.shipId).filter((id) => id > 0));
  // 在航的船通常已从 ship[] 里消失，按 shipId 去重只是保险；shipId 缺失时一律算占用（宁可少抢也不被拒）。
  const runningMine = ownRun.filter((s) => !(s.shipId > 0) || !dockMine.has(s.shipId));
  const slotsUsed = myShips.length + runningMine.length;
  const slotsLeft = Math.max(0, params.maxShips - slotsUsed);

  // 可应聘的船：没船长 + 英雄条件满足 + 名额还有。**不包括**「我已经在这船上」的。
  const seekable = open
    ? ships.filter((s) => s.state !== GS_STATE_MOVING && !s.leaderId && !s.mine && s.seekCheck.ok)
    : [];

  // 可补货的船：有船长 + **还在码头**（航行中的船补不了）+ 在补货窗口内 + 名额还有 + 有空着且材料齐的舱。
  const fillableShips = open
    ? ships.filter((s) => s.state !== GS_STATE_MOVING && s.leaderId && !s.mineLeader && s.myCabinId === null
      && s.filling && s.fillable.length > 0)
    : [];

  return {
    now: at,
    period,
    open,
    ready: open,
    maxShips: params.maxShips,
    prepareMinutes: params.prepareMinutes,
    refreshHours: params.refreshHours,
    nextRefreshAt: nextRefreshAt(at, params),
    myShips,
    // 名额口径：slotsUsed = 码头上的我的船 + 在航的我的船；slotsLeft 是真正还能抢几个。
    slotsUsed,
    slotsLeft,
    // 在航的那部分单独给出来，日志里要能说清「名额是被在航的船占着的」。
    runningMine,
    ships,
    seekable,
    fillableShips,
    ownRun,
  };
}

export function planGuildShip(view, { config = null, allowSeek = true } = {}) {
  const actions = [];
  const notes = [];
  if (!view?.open) {
    notes.push('联盟商船本期未开启（period=0）');
    return { actions, notes };
  }
  if (view.slotsLeft <= 0) {
    // 占名额的可能是码头上的船、也可能是在航的船，两个都要报清楚（否则会误以为名额是空的）。
    const held = [
      ...view.myShips.map((s) => `#${s.shipId}${s.role === 'leader' ? '船长' : '船员'}`),
      ...(view.runningMine ?? []).map((s) => `#${s.shipId}在航`),
    ].join('、') || '（探测没给出占用的船）';
    notes.push(`已占满 ${view.maxShips} 个船位（${held}），等这些船到港才会空出名额`);
  }

  // ---- 1. 补货：优先「空舱少 = 快启航」的船（名额能最快释放），同级挑规格高的 ----
  const crewPicks = view.fillableShips
    .slice()
    .sort((a, b) => (a.emptyCount - b.emptyCount)
      || (b.rewardScore - a.rewardScore)
      || (a.leftSeconds - b.leftSeconds))
    .slice(0, view.slotsLeft);
  for (const ship of crewPicks) {
    // 每条船只补 1 个舱（服务端也这么限）。挑缺口最"便宜"的那个舱 —— 材料数量总和最小。
    const cabin = ship.fillable
      .slice()
      .sort((a, b) => a.needs.reduce((s, n) => s + n.num, 0) - b.needs.reduce((s, n) => s + n.num, 0))[0];
    if (!cabin) continue;
    const items = cabin.needs.map((n) => [n.id, n.num]);
    actions.push({
      kind: 'guildShipOrder',
      request: 'GuildShipOrderRequest',
      body: { shipId: ship.shipId, crewId: cabin.crewId },
      key: `guildShipOrder:${ship.shipId}:${cabin.crewId}`,
      // 舱位是动态的：可能刚被别人抢走、或材料被别的事消耗掉 → 失败不该永久拉黑。
      transient: true,
      group: `guildShipOrder:${ship.shipId}`,
      items,
      label: `补货 ${ship.qualityName}商船#${ship.shipId} 舱${cabin.crewId}`
        + `（${items.map(([id, n]) => `${id}×${n}`).join(' ')}，`
        + `该船 ${ship.filledCount}/${ship.cabinTotal} 舱已补，剩 ${Math.ceil(ship.leftSeconds / 60)} 分钟）`,
    });
  }

  // ---- 2. 剩余名额当船长（零成本：凑不齐只遣返船长，不扣资源） ----
  if (allowSeek) {
    const slotsForSeek = view.slotsLeft - actions.length;
    if (slotsForSeek > 0) {
      // 优先「已经有舱被补」的船（说明队友在干活，凑齐概率高），再按规格高。
      const seekPicks = view.seekable
        .slice()
        .sort((a, b) => (b.filledCount - a.filledCount)
          || (b.rewardScore - a.rewardScore)
          || (a.shipId - b.shipId))
        .slice(0, slotsForSeek);
      for (const ship of seekPicks) {
        actions.push({
          kind: 'guildShipSeek',
          request: 'GuildShipSeekRequest',
          body: { shipId: ship.shipId },
          key: `guildShipSeek:${ship.shipId}`,
          transient: true,
          group: 'guildShipSeek',
          label: `应聘船长 ${ship.qualityName}商船#${ship.shipId}`
            + `（${ship.cabinTotal} 舱、航行 ${ship.minutes} 分钟，奖励 ${ship.rewardScore} 分）`,
        });
      }
    } else if (view.seekable.length > 0 && view.slotsLeft > 0) {
      // 只有「名额还有、但被补货动作占掉了」才这么说。名额本来就是 0 时上面已经报过「已占满」，
      // 再来一句「留给补货了」会让人以为还有名额可以腾（实盘 14:52 就是这样误导的）。
      notes.push(`有 ${view.seekable.length} 艘船缺船长，但名额都留给补货了（名额 ${view.maxShips} 个）`);
    }
  }

  // ---- 3. 解释「看得到但没动手」的船 ----
  for (const ship of view.ships) {
    if (ship.state === GS_STATE_MOVING) continue;
    if (ship.mine) continue;
    if (ship.myCabinId !== null) continue;
    if (!ship.leaderId) continue;
    if (!ship.filling) {
      notes.push(`${ship.qualityName}商船#${ship.shipId} 补货阶段已结束（剩 ${ship.filledCount}/${ship.cabinTotal} 舱）`);
      continue;
    }
    if (ship.emptyCount === 0) {
      notes.push(`${ship.qualityName}商船#${ship.shipId} 货舱已补齐，等待启航`);
      continue;
    }
    if (ship.fillable.length === 0 && ship.blocked.length > 0) {
      // 每个空舱分别说清缺什么 —— 只报第一个的话，另一个舱的缺口就被藏起来了。
      const detail = ship.blocked.map((b) => `舱${b.crewId} ` + b.short.map((s) => `${s.id} ${s.have}/${s.need}`).join('、'));
      notes.push(`${ship.qualityName}商船#${ship.shipId} 缺料没补：${detail.join('；')}`);
    }
  }
  for (const ship of view.ships) {
    if (ship.mineLeader && ship.fillable.length === 0 && ship.emptyCount > 0) {
      notes.push(`你不是自己船长那条船#${ship.shipId} 的补货人（船长不能补货），等队友补完 ${ship.emptyCount} 个舱`);
    }
  }

  return { actions, notes };
}

// 执行结果 → 「补了几舱 / 当上几条船的船长」
export function summarizeGuildShip(results) {
  const out = { orders: [], seeks: [], failed: 0 };
  for (const entry of results ?? []) {
    const kind = entry?.step?.kind;
    if (kind !== 'guildShipOrder' && kind !== 'guildShipSeek') continue;
    if (!entry.ok) {
      if (!entry.skipped) out.failed += 1;
      continue;
    }
    if (kind === 'guildShipOrder') out.orders.push(entry.step);
    else out.seeks.push(entry.step);
  }
  return out;
}

export function formatGuildShipGain(summary) {
  const parts = [];
  if (summary?.orders?.length) parts.push(`补货 ${summary.orders.length} 舱`);
  if (summary?.seeks?.length) parts.push(`当船长 ${summary.seeks.length} 艘`);
  if (summary?.failed) parts.push(`失败 ${summary.failed}`);
  return parts.join('，');
}

export function formatGuildShipSummary(view) {
  if (!view) return '联盟商船：还没探测';
  if (!view.open) return '联盟商船：本期未开启（period=0）';
  // 名额要把**在航的船**算进去：它们还没到港，一样锁着名额（否则会以为还能抢 2 个）。
  const mine = [
    ...view.myShips.map((s) => `#${s.shipId}${s.role === 'leader' ? '船长' : '船员'}`),
    ...(view.runningMine ?? []).map((s) => `#${s.shipId}在航`),
  ].join('、') || '无';
  const parts = [
    `码头 ${view.ships.length} 艘`,
    `我的名额 ${view.slotsUsed ?? view.myShips.length}/${view.maxShips}（${mine}）`,
    `可补 ${view.fillableShips.length} 艘`,
    `可当船长 ${view.seekable.length} 艘`,
    `下次刷新 ${new Date(view.nextRefreshAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
  ];
  if (view.ownRun.length > 0) {
    const soonest = Math.min(...view.ownRun.map((s) => s.moveEndAt || Infinity));
    if (Number.isFinite(soonest)) {
      const left = Math.max(0, soonest - Math.floor(Date.now() / 1000));
      parts.push(`在航 ${view.ownRun.length} 艘（最快 ${Math.ceil(left / 60)} 分钟到）`);
    } else {
      parts.push(`在航 ${view.ownRun.length} 艘`);
    }
  }
  return `联盟商船：${parts.join(' · ')}`;
}
