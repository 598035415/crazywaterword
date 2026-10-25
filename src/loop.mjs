// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）
// → 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级） → 搁浅的货轮（抢无人占领的货轮）
// → 联盟情报（领奖 + 派舰队） → 装备厂（收装备 + 锻造）。
//
// 拾荒 / 农田 / 货轮 / 情报 / 锻造 / 挂机领取 各自有独立间隔（gateDue）：自动循环每轮都会看一眼，
// 只有「距上次执行」超过自己的间隔才真的跑一次，其余轮次整段跳过（连探测请求都不发）。
//
// 货轮排在情报**前面**是刻意的：两边抢的是同一份资源 —— 空闲舰队。
// 货轮每小时整点才刷一次、万吨全服 1 艘，错过就没了；情报事件 6 小时才刷一批、
// 而且一直挂在那儿不会跑。所以先让货轮挑船，剩下的才给情报。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorld, summarizeFloaters, formatFloaters } from './world.mjs';
import { surveyRadar, viewRadar, planRadar, DEFAULT_MIN_POWER_RATIO } from './radar.mjs';
import { surveyEquip, planEquip, formatEquipSummary } from './equip.mjs';
import { surveyIdle, planIdle, runIdle, formatIdleSummary } from './idle.mjs';
import {
  surveyTreasure,
  viewTreasure,
  planTreasure,
  formatTreasureSummary,
  DEFAULT_MAX_FLEETS,
  DEFAULT_MIN_COLOR,
} from './treasure.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 拾荒的节流判定：海面漂浮物是慢慢刷出来的，跟循环的 60s 不是一回事 ——
// 每轮都发一遍既没收益，也更容易被服务端注意到「这个号的请求频率过于规整」。
// 所以给它一个间隔，只有距上次执行超过间隔才发。
// everyMs <= 0 表示不限制（等于旧行为：每轮都试）。
export function gateDue(lastAt, everyMs, nowMs) {
  if (!(Number(everyMs) > 0)) return true;
  if (!Number(lastAt)) return true;
  return Number(nowMs) - Number(lastAt) >= Number(everyMs);
}

// 轮数与间隔的兜底判定单独导出，纯函数好测：
//   rounds 非法（"abc" → NaN）回退 1 轮 —— NaN 不满足 > 0，会静默变成「永久挂机」；
//   everyMs 非法或负数回退 60 秒 —— NaN 传给 setTimeout 会被钳成 1ms，等于毫秒级轰炸网关。
// rounds <= 0（一直跑）与 everyMs === 0（不节流）的既有语义保持不变。
export function loopTotal(rounds) {
  const n = Number(rounds);
  if (!Number.isFinite(n)) return 1;
  return n > 0 ? n : Infinity;
}

export function loopGap(everyMs) {
  const n = Number(everyMs);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
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

export async function runLoop(client, protocol, {
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
  pickUpFloaters = false,
  pickEveryMs = 0,
  // 农田跟拾荒一样有自己的节奏：作物最快也要 30 分钟成熟，每轮都探测纯属浪费请求，
  // 所以默认 2 分钟看一次（0 = 不限制，每轮都看）。开关默认开。
  farmEnabled = true,
  farmEveryMs = 120_000,
  // 联盟情报：领已完成的奖励 + 派舰队打能打过的事件。舰队派出后 state 变 MOVING，
  // 下一轮自然没有空闲船，但事件会随时刷出来，所以给它自己的节奏：默认 60 秒扫一次，
  // 时间没到就整段跳过（省掉 RadarInfo + MyFleets + AllItem 三个请求）。
  radarEnabled = true,
  radarEveryMs = 60_000,
  // 装备厂（锻造）：造好了收取 + 按部位均衡排下一件。一件蓝装原时长 1800 秒、
  // 减完「锻造时间」委任也要 25 分钟左右，所以默认 3 分钟看一眼就够。
  // 它比农田更值得勤看：同一时间只能造一件，造好不收等于整座工厂停产。
  forgeEnabled = true,
  forgeEveryMs = 180_000,
  // 挂机领取：邮件附件 + 挂机本段收益 + 挂机等级奖励/升级。三件都免费、不发就白放着，
  // 但节奏是「小时级」的（收益 8 小时封顶、等级奖励是按级一次），所以 5 分钟看一次足够，
  // 不必每轮都多打 3 个请求（AfkInfo + EmailBox + 库存复用）。
  idleEnabled = true,
  idleEveryMs = 300_000,
  // 搁浅的货轮（世界宝藏）：整点刷新、一天只有 3 次奖励，抢的是刷新后那几十秒的窗口，
  // 所以给它最短的间隔 —— 默认 60 秒（与情报同节奏）。它排在情报前面先挑船。
  treasureEnabled = true,
  treasureEveryMs = 60_000,
  // 一次最多派几支舰队抢同一个货轮；同联盟最多 10 支能占同一个，3 支已经够把小型推完。
  treasureMaxFleets = DEFAULT_MAX_FLEETS,
  // 最低品质：3 蓝(小型) / 4 紫(中型) / 5 橙(万吨)。默认 3 = 能抢就抢，先把 3 次名额拿满。
  treasureMinColor = DEFAULT_MIN_COLOR,
  minPowerRatio = DEFAULT_MIN_POWER_RATIO,
  sleep = defaultSleep,
  stop = { aborted: false },
  onRound,
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  const rejected = { tasks: new Set(), world: new Set(), radar: new Set(), forge: new Set(), idle: new Set(), treasure: new Set() };
  const history = [];
  // 拾荒的「上次执行时间」（毫秒）。0 表示还没执行过，第一次跑就立刻做一次。
  // 只在**真的排进了请求**时才更新 —— 海面没漂浮物时不该白等一个间隔。
  let lastPickAt = 0;
  // 农田同理：只有真的排了收/种动作才计时，没熟也没空地时不占用间隔。
  let lastFarmAt = 0;
  // 情报不一样：探测本身就会刷新事件列表，「读取情报 → 领奖 → 派兵」是一整套动作，
  // 所以只要这轮真的探测成功就计时（不管有没有事件可派），间隔到了才做下一次。
  let lastRadarAt = 0;
  // 锻造同理：探测是一整套「读装备厂 → 收取 → 排产」，探测成功就计时。
  let lastForgeAt = 0;
  // 挂机领取同理：探测成功就计时（哪怕这一轮没有可领的）。
  let lastIdleAt = 0;
  // 货轮同理：探测成功就计时（哪怕这一轮没有可抢的）。
  let lastTreasureAt = 0;
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出；
  // 非法输入的回退规则见 loopTotal()，别在这里再写一份。
  const total = loopTotal(rounds);
  const gapMs = loopGap(everyMs);

  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    const tickAt = Date.now();
    const summary = { round, startedAt: Math.floor(tickAt / 1000), tasks: null, dailies: null, world: null, idle: null, treasure: null, radar: null, forge: null };

    // 1. 任务奖励
    summary.tasks = { planned: 0, results: [], notes: [] };
    try {
      const tasksSurvey = await surveyTasks(client, protocol, { config });
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
    summary.dailies = { planned: 0, results: [], notes: [] };
    try {
      const dailySurvey = await surveyDailies(client, protocol, { config, player });
      const dailyActions = dailySurvey.tasks.reduce((sum, entry) => sum + (entry.actions ?? []).length, 0)
        + (dailySurvey.chests?.actions.length ?? 0)
        + (dailySurvey.gift?.actions.length ?? 0);
      summary.dailies.planned = dailyActions;
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
    const pickDue = pickUpFloaters && gateDue(lastPickAt, pickEveryMs, tickAt);
    const farmDue = farmEnabled && gateDue(lastFarmAt, farmEveryMs, tickAt);
    const worldSurvey = await surveyWorld(client, protocol, { config, player });
    const worldPlan = planWorld(worldSurvey, {
      config,
      allowSpeedUp,
      allowReroll,
      useSelectPack,
      maxPackPerRound,
      pickUpFloaters: pickDue,
      farm: farmDue,
    });
    summary.world = {
      planned: worldPlan.actions.length,
      notes: [...worldSurvey.notes, ...worldPlan.notes],
      population: `${worldSurvey.population}/${worldSurvey.maxPopulation}`,
      results: [],
      floaterLoot: null,
    };
    if (worldPlan.actions.length > 0) {
      const { results, rejected: stillRejected } = await runWorld(client, protocol, worldPlan, {
        allowMutate,
        rejected: rejected.world,
        onStep: (entry) => onStep?.({ round, phase: 'world', ...entry }),
      });
      rejected.world = stillRejected;
      summary.world.results = results;
      summary.world.floaterLoot = summarizeFloaters(results);
    }

    // 4. 挂机领取：邮件附件 + 挂机本段收益 + 等级奖励 + 等级升级。
    //    放在海面之后是因为它直接复用 worldSurvey.stock（省一次 AllItemRequest）。
    //    日常那一段如果正好有「领取挂机收益(1004)」这条任务，会先把本段领掉 ——
    //    那时这里看到的是刚开的新一段，自然什么都不做，不会重复领。
    const idleDue = idleEnabled && gateDue(lastIdleAt, idleEveryMs, tickAt);
    summary.idle = { planned: 0, notes: [], results: [] };
    if (idleDue) {
      try {
        const idleSurvey = await surveyIdle(client, protocol, { config, player, stock: worldSurvey.stock });
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

    // 5. 搁浅的货轮（世界宝藏）：只抢「无人占领」的货轮，一条请求把选中的空闲舰队全压上去。
    //    必须在情报之前 —— 情报是「有多少空闲船就派多少」，放在前面会把船抢光，
    //    货轮就永远排不上（整点刷新错过就没了，情报事件挂 6 小时还在）。
    //    复用 world 那一段的库存（汽油），所以这一轮只多 Stats + List + MyFleets 三个只读请求。
    const treasureDue = treasureEnabled && gateDue(lastTreasureAt, treasureEveryMs, tickAt);
    summary.treasure = { planned: 0, notes: [], results: [] };
    if (treasureDue) {
      try {
        const treasureSurvey = await surveyTreasure(client, protocol, { config, player, stock: worldSurvey.stock });
        const treasureView = viewTreasure(treasureSurvey, {
          config,
          minColor: treasureMinColor,
          maxFleets: treasureMaxFleets,
        });
        const treasurePlan = planTreasure(treasureView, {
          minColor: treasureMinColor,
          maxFleets: treasureMaxFleets,
        });
        summary.treasure.planned = treasurePlan.actions.length;
        summary.treasure.notes = treasurePlan.notes;
        summary.treasure.summary = formatTreasureSummary(treasureView);
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
    const radarDue = radarEnabled && gateDue(lastRadarAt, radarEveryMs, tickAt);
    summary.radar = { planned: 0, notes: [], results: [] };
    if (radarDue) {
      try {
        const radarSurvey = await surveyRadar(client, protocol, { config, stock: worldSurvey.stock });
        const radarView = viewRadar(radarSurvey, { config, minPowerRatio });
        const radarPlan = planRadar(radarView, { minPowerRatio });
        summary.radar.planned = radarPlan.actions.length;
        summary.radar.notes = radarPlan.notes;
        // 事件为 0 时把「下次刷新」一起说出来 —— 否则日志里连续几十轮「事件 0 个」，
        // 看不出是没刷出来还是刷不出来。
        const refreshLeft = Number(radarView.nextRefreshTime) > 0
          ? Number(radarView.nextRefreshTime) - Math.floor(tickAt / 1000) : 0;
        summary.radar.summary = `Lv${radarView.level} · 事件 ${radarView.events.length} 个`
          + (radarView.events.length === 0
            ? (refreshLeft > 0 ? `（下次刷新 ${humanDuration(refreshLeft)}后）` : '（等刷新）')
            : '')
          + ` · 空闲舰队 ${radarView.idleFleets.length}`;
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
      } catch (error) {
        summary.radar.notes = [`情报探测失败：${error.message}`];
      }
    }

    // 7. 装备厂（锻造）：造好了就收，收完接着排下一件；按部位件数最少的先补。
    //    复用 world 那一轮已经拉到的建筑与库存（含 GOLD），所以这轮只多一个 EquipsRequest。
    const forgeDue = forgeEnabled && gateDue(lastForgeAt, forgeEveryMs, tickAt);
    summary.forge = { planned: 0, notes: [], results: [] };
    if (forgeDue) {
      try {
        const equipSurvey = await surveyEquip(client, protocol, {
          config,
          stock: worldSurvey.stock,
          buildings: worldSurvey.buildings,
        });
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

    // 计时以「本轮开始时刻」为准：动作已经排进计划，就算执行过，失败也不立刻重试
    // （下一轮照样被 rejected 或间隔挡住），避免失败时高频撞服务端。
    if (pickDue && worldPlan.actions.some((action) => action.kind === 'pickUpFloater')) lastPickAt = tickAt;
    if (farmDue && worldPlan.actions.some((action) => action.kind === 'farmHarvest' || action.kind === 'farmPlant')) lastFarmAt = tickAt;
    summary.gates = {
      pick: { ...gateSummary(pickUpFloaters, pickEveryMs, lastPickAt, tickAt), throttled: pickUpFloaters && !pickDue },
      farm: { ...gateSummary(farmEnabled, farmEveryMs, lastFarmAt, tickAt), throttled: farmEnabled && !farmDue },
      idle: { ...gateSummary(idleEnabled, idleEveryMs, lastIdleAt, tickAt), throttled: idleEnabled && !idleDue },
      treasure: { ...gateSummary(treasureEnabled, treasureEveryMs, lastTreasureAt, tickAt), throttled: treasureEnabled && !treasureDue },
      radar: { ...gateSummary(radarEnabled, radarEveryMs, lastRadarAt, tickAt), throttled: radarEnabled && !radarDue },
      forge: { ...gateSummary(forgeEnabled, forgeEveryMs, lastForgeAt, tickAt), throttled: forgeEnabled && !forgeDue },
    };

    history.push(summary);
    onRound?.(summary);
    if (round < total && !stop.aborted) await sleep(gapMs);
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
  treasureDispatch: '抢货轮',
  equipPick: '收装备',
  equipMake: '锻造',
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

export function formatLoopRound(summary) {
  const ok = (results) => results.filter((entry) => entry.ok).length;
  const failed = (results) => results.filter((entry) => entry.ok === false && !entry.skipped).length;
  const skipped = (results) => results.filter((entry) => entry.skipped).length;
  const line = (name, part) => `  ${name} 计划 ${part.planned}，成功 ${ok(part.results)}，失败 ${failed(part.results)}`
    + (skipped(part.results) ? `，跳过 ${skipped(part.results)}` : '');
  const floater = summary.world.floaterLoot ? formatFloaters(summary.world.floaterLoot) : '';
  // 勾了但被间隔挡住的那一轮要说清楚，否则看起来像「勾了没反应」。
  const gateLine = (name, gate) => {
    if (!gate?.enabled || !gate.throttled) return '';
    return `  ${name} 间隔未到，还差 ${humanDuration(gate.waitSeconds)}（每 ${humanDuration(gate.everyMs / 1000)}一次）`;
  };
  return [
    `第 ${summary.round} 轮`,
    line('任务', summary.tasks),
    ...detailLines(summary.tasks),
    // 探测失败只跳过本段，但必须让它出现在日志里 —— 否则「任务一直是 计划 0」看不出是被跳过了。
    ...(summary.tasks.notes ?? []).map((note) => `    注意 ${note}`),
    line('日常', summary.dailies),
    ...detailLines(summary.dailies),
    ...(summary.dailies.notes ?? []).map((note) => `    注意 ${note}`),
    `${line('海面', summary.world)}  人口 ${summary.world.population}`,
    ...detailLines(summary.world),
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
    // 锻造同理：这轮真的探测过就印一行（哪怕是「还在锻造、还剩 20 分钟」），
    // 否则日志里看不到它，很容易以为开关没生效。
    ...(summary.forge && (summary.forge.summary || (summary.forge.notes ?? []).length > 0)
      ? [`${line('锻造', summary.forge)}${summary.forge.summary ? `  ${summary.forge.summary}` : ''}`,
        ...detailLines(summary.forge),
        ...(summary.forge.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    ...(floater ? [`  ${floater}`] : []),
    ...[gateLine('货轮', summary.gates?.treasure)].filter(Boolean),
    ...[gateLine('情报', summary.gates?.radar)].filter(Boolean),
    ...[gateLine('锻造', summary.gates?.forge)].filter(Boolean),
    ...[gateLine('挂机领取', summary.gates?.idle)].filter(Boolean),
    ...[gateLine('拾荒', summary.gates?.pick)].filter(Boolean),
    ...[gateLine('农田', summary.gates?.farm)].filter(Boolean),
  ].join('\n');
}
