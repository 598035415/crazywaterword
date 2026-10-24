// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorld, summarizeFloaters, formatFloaters } from './world.mjs';

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
  sleep = defaultSleep,
  stop = { aborted: false },
  onRound,
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  const rejected = { tasks: new Set(), world: new Set() };
  const history = [];
  // 拾荒的「上次执行时间」（毫秒）。0 表示还没执行过，第一次跑就立刻做一次。
  // 只在**真的排进了请求**时才更新 —— 海面没漂浮物时不该白等一个间隔。
  let lastPickAt = 0;
  // 农田同理：只有真的排了收/种动作才计时，没熟也没空地时不占用间隔。
  let lastFarmAt = 0;
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出。
  const total = rounds > 0 ? rounds : Infinity;

  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    const tickAt = Date.now();
    const summary = { round, startedAt: Math.floor(tickAt / 1000), tasks: null, dailies: null, world: null };

    // 1. 任务奖励
    const tasksSurvey = await surveyTasks(client, protocol, { config });
    summary.tasks = { planned: tasksSurvey.plan.length, results: [] };
    if (tasksSurvey.plan.length > 0) {
      summary.tasks.results = await runTasks(client, protocol, tasksSurvey, {
        allowMutate,
        onStep: (entry) => onStep?.({ round, phase: 'tasks', ...entry }),
      });
    }

    // 2. 日常。活跃度宝箱与每日免费赠礼也算进计划数，否则「任务都做完了、只差领取」的轮次会被整段跳过。
    const dailySurvey = await surveyDailies(client, protocol, { config, player });
    const dailyActions = dailySurvey.tasks.reduce((sum, entry) => sum + (entry.actions ?? []).length, 0)
      + (dailySurvey.chests?.actions.length ?? 0)
      + (dailySurvey.gift?.actions.length ?? 0);
    summary.dailies = { planned: dailyActions, results: [] };
    if (dailyActions > 0) {
      summary.dailies.results = await runDailies(client, protocol, dailySurvey, {
        allowMutate,
        allowPaid,
        onStep: (entry) => onStep?.({ round, phase: 'dailies', ...entry }),
      });
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

    // 计时以「本轮开始时刻」为准：动作已经排进计划，就算执行过，失败也不立刻重试
    // （下一轮照样被 rejected 或间隔挡住），避免失败时高频撞服务端。
    if (pickDue && worldPlan.actions.some((action) => action.kind === 'pickUpFloater')) lastPickAt = tickAt;
    if (farmDue && worldPlan.actions.some((action) => action.kind === 'farmHarvest' || action.kind === 'farmPlant')) lastFarmAt = tickAt;
    summary.gates = {
      pick: { ...gateSummary(pickUpFloaters, pickEveryMs, lastPickAt, tickAt), throttled: pickUpFloaters && !pickDue },
      farm: { ...gateSummary(farmEnabled, farmEveryMs, lastFarmAt, tickAt), throttled: farmEnabled && !farmDue },
    };

    history.push(summary);
    onRound?.(summary);
    if (round < total && !stop.aborted) await sleep(everyMs);
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
  upgrade: '升级',
  speedUpUpgrade: '加速建造',
  speedUpProduce: '加速生产',
  selectPack: '兑材料',
  pickUpFloater: '拾荒',
};

// 每一部分的明细：成功的按 kind 聚合、失败逐条列（最多 limit 条）、跳过的按原因聚合。
function detailLines(part, limit = 4) {
  const lines = [];
  const okBy = new Map();
  for (const entry of part.results) {
    if (entry.skipped || !entry.ok) continue;
    const name = KIND_TEXT[entry.step?.kind] ?? entry.step?.kind ?? '其他';
    okBy.set(name, (okBy.get(name) ?? 0) + 1);
  }
  if (okBy.size) lines.push(`    成功 ${[...okBy].map(([name, n]) => `${name}×${n}`).join('  ')}`);

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
    line('日常', summary.dailies),
    ...detailLines(summary.dailies),
    `${line('海面', summary.world)}  人口 ${summary.world.population}`,
    ...detailLines(summary.world),
    ...(floater ? [`  ${floater}`] : []),
    ...[gateLine('拾荒', summary.gates?.pick)].filter(Boolean),
    ...[gateLine('农田', summary.gates?.farm)].filter(Boolean),
  ].join('\n');
}
