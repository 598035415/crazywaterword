// 酆都诡事（《疯狂水世界》×《捞尸人》联动活动）—— 协议侧自动化。
//
// 只做 4 个**免费**板块，付费板块（每日累充 / 每日特惠 / 酆都礼遇战令 / 满减商店结账）一律不碰：
//   ① 驱邪除祟：基地里的邪祟，点一下杀一个，累计数量领里程碑奖励（15 档，打满 75 个）
//   ② 龙王罗盘：花「抽奖券」转盘，抽完领累计积分档位奖励
//   ③ 酆都法旨：花「贡品」开一局，猜 4 个符文；这一块见下面的「答案」说明
//   ④ 签到 / 活跃：14 天签到 + 每日活跃度里程碑
//
// ── 三个必须记住的坑（都是 2026-10-29 实盘验出来的）───────────────────────
// 1. **活动 id 不是活动开始日期**。`20261029`（活动上线日）请求一律被拒 `prompt 74`，
//    真正能用的是 `20261001` —— 这是这个大版本活动容器的 id（日常活跃也挂在同一个 id 上，
//    所以 `SCActivityActiveScoreUpdate` 里推的就是它）。猜别的值只会拿到 74（= ACTIVE_END）。
// 2. **法旨把答案直接下发了**。`EdictInfoResponse.session.rune` 是 4 个符文 id，客户端拿它
//    渲染 4 张符纸的图案（`LSRFaZhiGuessItem.setFont`），`shown` 只是「哪几格已显化」的 6 位掩码。
//    也就是说：**不显化也能直接提交正确答案** → 耐心留满 100 → 拿最高档（功德 ×20）。
//    显化一次扣 5 耐心、猜错扣 10，所以自动化里一次都不该显化。
// 3. **领奖不带档位号**。`EvilExpelClaimRequest` / `ClaimCompassWheelRewardRequest` /
//    `ClaimActivityDailyActiveRewardRequest` 的 body 只有 `activityId`，服务端永远按
//    「已领到第几档」的顺序给下一档 → 想领 N 档就得发 N 次，直到被拒为止。
import { assetCount } from './world.mjs';

// 大版本活动容器 id。写死是有意的：它跨活动期不变（2026-10-01 起），
// 而活动上线日/结束日都会变，按日期猜必错。
export const YOUDU_ACTIVITY_ID = 20261001;

export const YOUDU_ITEMS = {
  ticket: '活动26捞尸人_入场券', // 贡品：开一局法旨的门票
  coin: '活动26捞尸人_抽奖券', // 铜钱：罗盘转一次
  merit: '活动26捞尸人_货币', // 功德：满减商店的兑换货币（本工具只统计，不花）
  energy: '打雪仗体力', // 能量饮料：11-05 才开的「走江踏浪」用
};

// 邪祟同时最多 6 个（攻略与实盘一致），每日刷新 6 个。
export const YOUDU_MAX_ALIVE = 6;

// 罗盘 70 抽必出龙纹（`LinkageLSRCompassWheelCfg` rewardId=8 的 mustDraw）。
export const YOUDU_DRAGON_PITY = 70;

const rowsOf = (config, name) => (Array.isArray(config?.tables?.[name]?.data) ? config.tables[name].data : []);

// int64 字段（activityId / 各种 num）统一走这里：裸 Number 会得到 NaN 或负数。
const num = (v) => assetCount(v);

function assetOf(display) {
  if (!display) return null;
  return { id: String(display.id ?? ''), num: num(display.num) };
}

// 法旨答案：`session.rune` 的 4 个符文 id 就是答案（客户端只拿它渲染符纸、再用遮罩挡住）。
// 位数不对或全 0 都当「没有答案」，宁可这局不交（扣耐心不值），也不要瞎猜。
function runeOf(session) {
  const raw = (session?.rune ?? []).map(num);
  if (raw.length !== 4) return null;
  if (!raw.some((v) => v > 0)) return null;
  return raw;
}

function rewardText(pkg) {
  const list = pkg?.assets ?? pkg?.asset ?? pkg?.rewards ?? [];
  const pairs = [];
  for (const row of list) {
    if (!row) continue;
    if (Array.isArray(row)) pairs.push([row[0], num(row[1])]);
    else pairs.push([String(row.id ?? row.itemId ?? ''), num(row.num ?? row.count)]);
  }
  return pairs;
}

// ───────────────────────────── 探测 ─────────────────────────────

export async function surveyYoudu(client, { config = null, items = null, activityId = YOUDU_ACTIVITY_ID, timeout = 12_000 } = {}) {
  const body = { activityId };
  const [evil, wheel, edict] = await Promise.all([
    client.request('EvilExpelInfoRequest', body, 'EvilExpelInfoResponse', timeout).catch((error) => ({ __error: error })),
    client.request('CompassWheelInfoRequest', body, 'CompassWheelInfoResponse', timeout).catch((error) => ({ __error: error })),
    client.request('EdictInfoRequest', body, 'EdictInfoResponse', timeout).catch((error) => ({ __error: error })),
  ]);

  // 三个都挂 → 活动没开 / id 变了。第一条错误信息就够解释了。
  if (evil.__error && wheel.__error && edict.__error) {
    return { open: false, activityId, reason: evil.__error.message };
  }

  let stock = items;
  if (!stock) {
    const bag = await client.request('AllItemRequest', {}, 'AllItemResponse', timeout).catch(() => null);
    stock = new Map();
    for (const row of bag?.items ?? []) {
      const id = String(row.id ?? row.itemId ?? '');
      if (id) stock.set(id, num(row.num ?? row.count));
    }
  }

  return {
    open: true,
    activityId,
    evil: evil.__error ? null : {
      killTotal: num(evil.killTotal),
      claimed: num(evil.claimed),
      todayKill: num(evil.todayKill),
      alive: num(evil.alive),
    },
    wheel: wheel.__error ? null : {
      score: num(wheel.score),
      claimedId: num(wheel.claimedId),
      times: num(wheel.times),
      pity: num(wheel.pity),
      minScore: num(wheel.minScore),
      maxScore: num(wheel.maxScore),
      outerGot: (wheel.outerGot ?? []).map(num),
      cost: assetOf(wheel.cost),
    },
    edict: edict.__error ? null : {
      cost: assetOf(edict.cost),
      session: edict.session ?? null,
    },
    stock,
  };
}

// ───────────────────────────── 视图 ─────────────────────────────

export function viewYoudu(survey, { config = null } = {}) {
  if (!survey?.open) return { open: false, reason: survey?.reason ?? '活动未开启', activityId: survey?.activityId };

  const stock = survey.stock ?? new Map();
  const have = (id) => num(stock.get(id) ?? 0);

  // ---- 邪祟 ----
  const evilCfg = rowsOf(config, 'LinkageLSREvilExpelTotalRewardCfg')
    .map((row) => ({ id: num(row.id), totalCount: num(row.totalCount), rewards: row.rewards ?? [] }))
    .sort((a, b) => a.id - b.id);
  const evil = survey.evil ?? { killTotal: 0, claimed: 0, todayKill: 0, alive: 0 };
  // ⚠ `EvilExpelInfoResponse.claimed` 不是「第几档」，而是**已领档位的累计杀数**（= 该档的 totalCount）。
  //   2026-10-29 实测：累计杀 6 只、领完第 1 档后 claimed=5（配置里第 1 档 totalCount 就是 5），
  //   而档位 id 是 1。按 id 比较的话会算成「已领到第 5 档」，之后 5/10/15… 全被当成已领。
  const evilClaimable = evilCfg.filter((row) => row.totalCount > evil.claimed && evil.killTotal >= row.totalCount);
  const evilNext = evilCfg.find((row) => row.totalCount > evil.claimed) ?? null;

  // ---- 罗盘 ----
  const scoreCfg = rowsOf(config, 'LinkageLSRCompassWheelScoreRewardCfg')
    .map((row) => ({ id: num(row.id), score: num(row.score), isStage: row.isStage === '是' || row.isStage === true }))
    .sort((a, b) => a.id - b.id);
  const wheel = survey.wheel ?? { score: 0, claimedId: 0, times: 0, pity: 0, cost: null, outerGot: [] };
  const costId = wheel.cost?.id ?? YOUDU_ITEMS.coin;
  const costNum = wheel.cost?.num || 1;
  const coinHeld = have(costId);
  const wheelClaimable = scoreCfg.filter((row) => row.id > wheel.claimedId && wheel.score >= row.score);
  const wheelNext = scoreCfg.find((row) => row.id > wheel.claimedId) ?? null;

  // ⚠ `CompassWheelInfoResponse.pity` 是「**距保底还剩几抽**」，从 mustDraw 往下递减 ——
  //   不是「已累计抽数」（那是 `times`）。2026-10-29 同一账号 21 次 info 快照实测：
  //   times=2→pity=68、times=3→pity=67、times=5→pity=65，严格等于 70-times、递减。
  //   所以「还要抽几发才保底」就是 pity 本身，**不能再拿 mustDraw 减一次**
  //   （旧写法 70-65=5 会把「还差 65 抽」显示成「还差 5 抽」，差一个数量级）。
  //   龙纹最早第 20 抽才可能出（`LinkageLSRCompassWheelCfg` rewardId=8 的 minDraw）。
  const dragonRow = rowsOf(config, 'LinkageLSRCompassWheelCfg').find((row) => row.isDragon === '是');
  const dragonMustDraw = num(dragonRow?.mustDraw) || YOUDU_DRAGON_PITY;
  const dragonMinDraw = num(dragonRow?.minDraw);
  // pity 缺失（0）时退回按次数算，防止服务端没下发这个字段。
  const dragonIn = wheel.pity > 0 ? wheel.pity : Math.max(0, dragonMustDraw - wheel.times);


  // ---- 法旨 ----
  const edict = survey.edict ?? { cost: null, session: null };
  const ticketId = edict.cost?.id ?? YOUDU_ITEMS.ticket;
  const ticketNum = edict.cost?.num || 1;
  const ticketHeld = have(ticketId);
  const patienceCfg = rowsOf(config, 'LinkageLSREdictPatienceCfg')[0] ?? {};
  const edictRewardCfg = rowsOf(config, 'LinkageLSREdictRewardCfg')
    .map((row) => ({ id: num(row.id), patience: num(row.patience), battlePassScore: num(row.battlePassScore), rewards: row.rewards ?? [] }))
    .sort((a, b) => b.patience - a.patience);

  return {
    open: true,
    activityId: survey.activityId,
    evil: {
      ...evil,
      alive: Math.max(0, evil.alive),
      claimable: evilClaimable,
      next: evilNext,
      maxAlive: YOUDU_MAX_ALIVE,
    },
    wheel: {
      ...wheel,
      costId,
      costNum,
      coinHeld,
      // 一次最多能抽几发：券数 / 单抽花费。别四舍五入，缺一张就是抽不了。
      spins: costNum > 0 ? Math.floor(coinHeld / costNum) : 0,
      claimable: wheelClaimable,
      next: wheelNext,
      dragonIn,
      dragonMustDraw,
      dragonMinDraw,
    },
    edict: {
      ...edict,
      ticketId,
      ticketNum,
      ticketHeld,
      canStart: ticketHeld >= ticketNum,
      patienceTotal: num(patienceCfg.patienceTotal) || 100,
      askCost: num(patienceCfg.askCost) || 5,
      receiveCost: num(patienceCfg.receiveCost) || 10,
      rewards: edictRewardCfg,
    },
    stock,
  };
}

// ───────────────────────────── 计划 ─────────────────────────────

export function planYoudu(view, {
  config = null,
  spin = true,
  spinMax = 10, // 一次请求最多抽几发（客户端有 1/5/10 连，服务端 num 是次数）
  edict = true,
  kill = true,
  claim = true,
} = {}) {
  const actions = [];
  const notes = [];
  if (!view?.open) {
    notes.push(`酆都诡事未开启：${view?.reason ?? '探测失败'}`);
    return { actions, notes };
  }
  const act = { activityId: view.activityId };

  // ---- 1. 驱邪除祟：一个请求杀一只，alive 就是基地里现存的只数 ----
  if (kill) {
    const alive = view.evil.alive;
    if (alive <= 0) {
      notes.push(`基地里没有邪祟（今日已杀 ${view.evil.todayKill} 只，累计 ${view.evil.killTotal}）`);
    } else {
      for (let i = 0; i < alive; i += 1) {
        actions.push({
          kind: 'youduKill',
          request: 'EvilExpelKillRequest',
          response: 'EvilExpelKillResponse',
          body: act,
          key: `youduKill:${i}`,
          // 邪祟数量是实时变化的（队友/服务端刷新都会动），失败不该永久拉黑。
          transient: true,
          group: 'youduKill',
          label: `灭邪祟 ${i + 1}/${alive}`,
        });
      }
    }
  }

  // ---- 2. 驱邪累计奖励：领到没得领为止 ----
  //      关键：这一轮的 kill 动作会让 killTotal 涨，所以可领档位要按「杀完之后」算。
  //      不这么算的话，杀满 6 只后这一轮领不了奖，白等下一轮（而下一轮又要先探一次）。
  if (claim) {
    const evilCfg = rowsOf(config, 'LinkageLSREvilExpelTotalRewardCfg')
      .map((row) => ({ id: num(row.id), totalCount: num(row.totalCount) }))
      .sort((a, b) => a.id - b.id);
    const projected = view.evil.killTotal + (kill ? view.evil.alive : 0);
    // claimed 是「已领档位的累计杀数」（见 viewYoudu 的注释），不是档位 id。
    const claimable = evilCfg.filter((row) => row.totalCount > view.evil.claimed && projected >= row.totalCount);
    claimable.forEach((row) => {
      actions.push({
        kind: 'youduEvilClaim',
        request: 'EvilExpelClaimRequest',
        response: 'EvilExpelClaimResponse',
        body: act,
        key: `youduEvilClaim:${row.id}`,
        // 必须 transient：可领档位是「按杀完之后」投影出来的，本轮 kill 万一失败，
        // 这条 claim 一定被拒。不标 transient 就会被写进跨轮 rejected 集合，
        // 之后这档永远不再尝试（要等进程重启才发现漏领）。
        transient: true,
        group: 'youduEvilClaim',
        label: `领驱邪奖励第 ${row.id} 档（累计 ${row.totalCount} 只）`,
      });
    });
  }

  // ---- 3. 龙王罗盘：有券才转；一次请求按 spinMax 分批 ----
  if (spin && view.wheel.spins > 0) {
    let left = view.wheel.spins;
    let batch = 0;
    while (left > 0) {
      const take = Math.min(left, Math.max(1, spinMax));
      actions.push({
        kind: 'youduSpin',
        request: 'SpinCompassWheelRequest',
        response: 'SpinCompassWheelResponse',
        body: { ...act, num: take },
        key: `youduSpin:${batch}`,
        transient: true,
        group: 'youduSpin',
        label: `转罗盘 ×${take}（持券 ${view.wheel.coinHeld}，单抽 ${view.wheel.costNum}）`,
      });
      left -= take;
      batch += 1;
    }
  }

  // ---- 4. 罗盘累计积分奖励 ----
  if (claim && view.wheel.claimable.length > 0) {
    view.wheel.claimable.forEach((row) => {
      actions.push({
        kind: 'youduWheelClaim',
        request: 'ClaimCompassWheelRewardRequest',
        response: 'ClaimCompassWheelRewardResponse',
        body: act,
        key: `youduWheelClaim:${row.id}`,
        // 同 evil claim：条件由本地积分推算，和上一轮 spin 的结果可能有时差，失败要允许重试。
        transient: true,
        group: 'youduWheelClaim',
        label: `领罗盘积分第 ${row.id} 档（${row.score} 分）`,
      });
    });
  }

  // ---- 5. 酆都法旨：有贡品就开一局，然后直接提交 session 里下发的答案 ----
  if (edict) {
    if (view.edict.session) {
      // 符文 id 是 1~6（`shown` 是 6 位掩码），但**别用 filter(v>0) 洗** ——
      // 万一服务端哪天用 0 当合法符文，洗一下就把 4 位洗成 3 位、这局永远交不出去。
      const rune = runeOf(view.edict.session);
      if (rune) {
        actions.push({
          kind: 'youduEdictGuess',
          request: 'EdictGuessRequest',
          response: 'EdictGuessResponse',
          body: { ...act, guess: rune },
          key: 'youduEdictGuess',
          transient: true,
          group: 'youduEdict',
          label: `提交法旨答案 [${rune.join(',')}]（当前耐心 ${num(view.edict.session.patience)}）`,
        });
      } else {
        notes.push(`法旨有进行中的局，但 session.rune 不是 4 位（${JSON.stringify(view.edict.session.rune ?? [])}），跳过以免扣耐心`);
      }
    } else if (view.edict.canStart) {
      actions.push({
        kind: 'youduEdictStart',
        request: 'EdictStartRequest',
        response: 'EdictStartResponse',
        body: act,
        key: 'youduEdictStart',
        // 入场券是签到/日常给的，今天没有明天可能有 —— 一次失败不能拉黑到进程结束。
        transient: true,
        group: 'youduEdict',
        label: `开一局法旨（消耗 ${view.edict.ticketId}×${view.edict.ticketNum}，持 ${view.edict.ticketHeld}）`,
      });
    } else {
      notes.push(`法旨没贡品（${view.edict.ticketId} 持 ${view.edict.ticketHeld}，开一局要 ${view.edict.ticketNum}）`);
    }
  }

  // ---- 6. 签到（14 天）单独走 runYouduSigns：它需要「按回包决定继续还是停」，
  //      用静态计划会白打 14 条请求（2026-10-29 实测：第 1 天 `already checked in`，
  //      第 2~14 天全是 `not time yet`）。

  // ---- 7. 每日活跃度里程碑也单独走 runYouduActive，理由同上：
  //      body 只有 activityId（服务端按「已领到第几档」顺序给下一档），
  //      没分可领时回 `no claimable reward`。静态计划只能猜要排几条 ——
  //      排 1 条会在积压时白等好几个间隔，排 5 条又会在没分时刷 4 行「跳过」。

  return { actions, notes };
}

// ───────────────────────────── 每日活跃度里程碑 ─────────────────────────────
//
// 和签到一样是「试了才知道」：没有 info 接口能查「已领到第几档」，
// 服务端只会按顺序给下一档，没得给时回 `no claimable reward`。
// 所以按回包推进 —— 成功就继续要下一档，被拒就停：
//   · 没分可领：一轮恰好 1 条请求（不会像排 5 条那样刷 4 行「跳过」）
//   · 有积压（一天没挂机回来涨了好几档）：一轮连领，最多 `max` 档
export async function runYouduActive(client, {
  activityId = YOUDU_ACTIVITY_ID,
  max = 8,
  timeout = 8000,
  onStep = null,
} = {}) {
  const results = [];
  const notes = [];
  const limit = Math.max(1, Number(max) || 1);
  for (let i = 0; i < limit; i += 1) {
    const step = { kind: 'youduActive', label: i === 0 ? '领活跃度奖励' : `领活跃度奖励 #${i + 1}` };
    try {
      const body = await client.request(
        'ClaimActivityDailyActiveRewardRequest',
        { activityId },
        'ClaimActivityDailyActiveRewardResponse',
        timeout,
      );
      const entry = { step, ok: true, body };
      results.push(entry);
      onStep?.(entry);
    } catch (error) {
      const msg = String(error?.message ?? '');
      if (/no claimable reward/i.test(msg)) {
        // 进度到头了 —— 正常结束，只在第一条就撞上时留一句说明。
        if (i === 0) notes.push('活跃度没有可领的档位（分数还没到下一档）');
        break;
      }
      const entry = { step, ok: false, error: msg };
      results.push(entry);
      onStep?.(entry);
      notes.push(`领活跃度奖励失败：${msg}`);
      break;
    }
  }
  return { results, notes };
}

// ───────────────────────────── 法旨：开局后当轮直交 ─────────────────────────────
//
// 静态计划解决不了这一段的延迟：开局那一轮 view 里还没有 session，所以计划只能先「开局」，
// 答案得等下一轮探测（默认 300 秒后）才交。但 `EdictStartResponse` 里**直接带 session（含 rune）**
// ——2026-10-29 实盘：`{session:{rune:[2,1,6,4], shown:[0,0,0,0], patience:100}}`。
// 所以开局成功后立刻补一条 guess，一局在同一轮内闭环，耐心满 100 拿满三档（货币20 + 抽奖券2，战令 60 分）。
export async function settleYouduEdict(client, results, {
  allowMutate = false,
  activityId = YOUDU_ACTIVITY_ID,
  timeout = 8000,
  onStep = null,
} = {}) {
  const empty = { results: [], notes: [] };
  if (!allowMutate) return empty;
  const started = (results ?? []).find((entry) => entry.ok === true && entry.step?.kind === 'youduEdictStart');
  if (!started) return empty;
  const rune = runeOf(started.body?.session);
  if (!rune) {
    return { results: [], notes: ['法旨开局回包里没有可用的 4 位 rune，这局留到下一轮探测再交（不乱猜，猜错扣 10 耐心）'] };
  }
  const step = { kind: 'youduEdictGuess', label: `提交法旨答案 [${rune.join(',')}]（开局直交，0 显化）` };
  try {
    const body = await client.request('EdictGuessRequest', { activityId, guess: rune }, 'EdictGuessResponse', timeout);
    const entry = { step, ok: true, body };
    onStep?.(entry);
    return { results: [entry], notes: [] };
  } catch (error) {
    const message = String(error?.message ?? error);
    const entry = { step, ok: false, error: message };
    onStep?.(entry);
    return { results: [entry], notes: [`法旨开局后直交失败：${message}（下一轮会按 session 再试）`] };
  }
}

// ───────────────────────────── 签到 ─────────────────────────────
//
// 签到不能塞进静态计划：服务端会用两种「拒绝」表达进度，必须按回包决定下一步 ——
//   `already checked in` → 这一天签过了，跳到下一天继续试
//   `not time yet`       → 还没到那一天，**今天到此为止**，直接停
// 2026-10-29 实盘：活动第 1 天，checkId=1 回 already、checkId=2 回 not time yet → 2 条请求收工。
// 按静态计划发 14 条的话，后面 13 条纯粹是噪音（还会把 rejected 集合塞满）。
//
// 另外「今天到此为止」这个结论要记住：挂机一轮 5 分钟、一天 288 轮，不记住的话每轮都会
// 重打一遍 already + not time（实测 2 小时就攒了 50 条 `ClaimActivityDailyCheckInRewardRequest`）。
// 但**不能按本地日期一刀切「今天不试了」**——服务端的「一天」不一定在本地 0 点翻（实测
// 00:34 还能签到、签到档位按活动第 N 天算），所以这里用「被拒后冷却 1 小时」：
// 一天最多 24 次探测，既不刷屏也不会因为时区/刷新点差异漏掉一整天。
const SIGN_RETRY_MS = 60 * 60 * 1000;
const signMemo = { retryAfterAt: 0 };

export async function runYouduSigns(client, {
  config = null,
  activityId = YOUDU_ACTIVITY_ID,
  timeout = 8000,
  onStep = null,
  now = Date.now(),
} = {}) {
  const results = [];
  const notes = [];
  const signCfg = rowsOf(config, 'LinkageLSRSignCfg')
    .map((row) => ({ id: num(row.rewardId), signDay: num(row.signDay) }))
    .sort((a, b) => a.id - b.id);
  if (signCfg.length === 0) {
    notes.push('配置表里没有 LinkageLSRSignCfg，跳过签到');
    return { results, notes };
  }
  // 冷却中就不发了（静默：日志里那段本来就没东西可看）。
  if (now < signMemo.retryAfterAt) return { results, notes };

  let done = 0;
  for (const row of signCfg) {
    const step = { kind: 'youduSign', label: `签到第 ${row.signDay} 天` };
    try {
      const body = await client.request(
        'ClaimActivityDailyCheckInRewardRequest',
        { activityId, checkId: row.id },
        'ClaimActivityDailyCheckInRewardResponse',
        timeout,
      );
      const entry = { step, ok: true, body };
      results.push(entry);
      onStep?.(entry);
      done += 1;
    } catch (error) {
      const msg = String(error?.message ?? '');
      if (/already checked in/i.test(msg)) {
        // 这一天签过了 —— 正常的进度表达，不算失败，也不算跳过。
        continue;
      }
      if (/not time yet/i.test(msg)) {
        notes.push(`签到停在「第 ${row.signDay} 天」（服务端回 not time yet，说明今天只能签到这里）`);
        signMemo.retryAfterAt = now + SIGN_RETRY_MS;
        break;
      }
      const entry = { step, ok: false, error: msg };
      results.push(entry);
      onStep?.(entry);
      notes.push(`签到第 ${row.signDay} 天失败：${msg}`);
      signMemo.retryAfterAt = now + SIGN_RETRY_MS;
      break;
    }
  }
  if (done === 0 && notes.length === 0) {
    signMemo.retryAfterAt = now + SIGN_RETRY_MS;
    notes.push('今天已经签过了，没有新的签到可领');
  }
  return { results, notes };
}

// ───────────────────────────── 展示 ─────────────────────────────

export function youduBlockedReason(view) {
  if (!view?.open) return view?.reason ?? '活动未开启';
  return null;
}

// 三个 info 请求全挂时 `open=false`，「活动下线」和「网络断了」长得一模一样，
// 但处理必须不同：前者退避 1 小时，后者下一轮立刻重试。
// 判据：服务端明确的 prompt（74 = ACTIVE_END / 活动状态不符）才算「活动关闭」；
// `not connected` / `timeout` / `拿不到 xxx` 都只是这一轮没通，不能停一小时。
export function isYouduClosed(reason) {
  const text = String(reason ?? '');
  if (/prompt/i.test(text) || /ACTIVE_END/i.test(text)) return true;
  return false;
}

export function formatYouduSummary(view) {
  if (!view?.open) return `酆都诡事：未开启（${view?.reason ?? '探测失败'}）`;
  const parts = [];
  parts.push(`邪祟 ${view.evil.alive}/${view.evil.maxAlive} 只待灭`
    + `（今日 ${view.evil.todayKill}，累计 ${view.evil.killTotal}`
    + `${view.evil.claimed > 0 ? `，已领到累计 ${view.evil.claimed} 只的档` : '，还没领过档位'}`
    + `${view.evil.claimable.length ? `，可领 ${view.evil.claimable.length} 档` : ''}）`);
  parts.push(`罗盘 ${view.wheel.coinHeld} 券${view.wheel.spins ? `（可转 ${view.wheel.spins} 次）` : '（没券）'}`
    + ` 积分 ${view.wheel.score}${view.wheel.claimable.length ? ` 可领 ${view.wheel.claimable.length} 档` : ''}`
    + ` 保底还剩 ${view.wheel.dragonIn} 抽（已抽 ${view.wheel.times}）`);
  parts.push(`法旨 ${view.edict.session ? '有一局未交' : '空闲'}`
    + `（${view.edict.ticketId} 持 ${view.edict.ticketHeld}）`);
  return `酆都诡事：${parts.join(' · ')}`;
}

export function summarizeYoudu(results) {
  const summary = { ok: 0, fail: 0, kill: 0, spin: 0, edict: null, rewards: [] };
  for (const entry of results ?? []) {
    // 「同类动作已失败，本轮不再尝试」是 runWorld 的隔离，不是这条自己失败 ——
    // 算进 fail 会让「失败 N 条」虚高（活跃度排 5 条时就是 4 条假失败）。
    if (entry.skipped) continue;
    if (entry.ok !== true) {
      // `no claimable reward` = 活跃度已经领到头，是进度而不是错误，不计失败。
      if (entry.step?.kind === 'youduActive' && /no claimable reward/i.test(String(entry.error ?? ''))) continue;
      summary.fail += 1;
      continue;
    }
    summary.ok += 1;
    const kind = entry.step?.kind;
    const body = entry.body ?? {};
    if (kind === 'youduKill') summary.kill += 1;
    else if (kind === 'youduSpin') {
      // 回包里 `spin` 是本批次的每一格结果（num=10 就是 10 项），数它最准。
      summary.spin += Array.isArray(body.spin) ? body.spin.length : 0;
    } else if (kind === 'youduEdictGuess' || kind === 'youduEdictStart') {
      summary.edict = body;
    }
    const rewards = rewardText(body.reward);
    if (rewards.length > 0) summary.rewards.push(...rewards);
  }
  return summary;
}

export function formatYouduGain(summary) {
  if (!summary) return '';
  const bits = [];
  if (summary.kill) bits.push(`灭邪祟 ${summary.kill}`);
  if (summary.spin) bits.push(`转罗盘 ${summary.spin}`);
  if (summary.edict?.success) bits.push(`法旨成功（剩耐心 ${num(summary.edict.patience)}）`);
  const merged = new Map();
  for (const [id, n] of summary.rewards ?? []) {
    if (!id || !n) continue;
    merged.set(id, (merged.get(id) ?? 0) + n);
  }
  if (merged.size > 0) bits.push([...merged].map(([id, n]) => `${id}×${n}`).join('、'));
  if (summary.fail) bits.push(`失败 ${summary.fail} 条`);
  return bits.join('，');
}
