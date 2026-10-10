// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）。
//
// 循环是显式开的：必须同时给 --loop 与 --yes，且每轮都是「先只读探测，再算计划，再执行」，
// 所以第二轮起没有可做的事时计划自然为空，不会重复发同样的请求。
// 被服务端拒过的具体动作记在 rejected 里跨轮传递（runTasks / runWorld 各自维护）。

import { surveyTasks, runTasks } from './tasks.mjs';
import { surveyDailies, runDailies } from './dailies.mjs';
import { surveyWorld, planWorld, runWorld } from './world.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runLoop(client, protocol, {
  config = null,
  player = null,
  rounds = 1,
  everyMs = 60_000,
  allowMutate = false,
  allowPaid = false,
  allowSpeedUp = false,
  allowReroll = false,
  sleep = defaultSleep,
  stop = { aborted: false },
  onRound,
  onStep,
} = {}) {
  if (!allowMutate) throw new Error('循环会持续改变账号状态，需要 --yes');
  const rejected = { tasks: new Set(), world: new Set() };
  const history = [];
  // rounds <= 0 表示一直跑，靠 stop.aborted（Ctrl-C 或网页停止按钮）退出。
  const total = rounds > 0 ? rounds : Infinity;

  for (let round = 1; round <= total; round += 1) {
    if (stop.aborted) break;
    const summary = { round, startedAt: Math.floor(Date.now() / 1000), tasks: null, dailies: null, world: null };

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

    // 3. 海面世界
    const worldSurvey = await surveyWorld(client, protocol, { config, player });
    const worldPlan = planWorld(worldSurvey, { config, allowSpeedUp, allowReroll });
    summary.world = {
      planned: worldPlan.actions.length,
      notes: [...worldSurvey.notes, ...worldPlan.notes],
      population: `${worldSurvey.population}/${worldSurvey.maxPopulation}`,
      results: [],
    };
    if (worldPlan.actions.length > 0) {
      const { results, rejected: stillRejected } = await runWorld(client, protocol, worldPlan, {
        allowMutate,
        rejected: rejected.world,
        onStep: (entry) => onStep?.({ round, phase: 'world', ...entry }),
      });
      rejected.world = stillRejected;
      summary.world.results = results;
    }

    history.push(summary);
    onRound?.(summary);
    if (round < total && !stop.aborted) await sleep(everyMs);
  }

  return { history, rejected };
}

export function formatLoopRound(summary) {
  const ok = (results) => results.filter((entry) => entry.ok).length;
  const failed = (results) => results.filter((entry) => entry.ok === false && !entry.skipped).length;
  const line = (name, part) => `  ${name} 计划 ${part.planned}，成功 ${ok(part.results)}，失败 ${failed(part.results)}`;
  return [
    `第 ${summary.round} 轮`,
    line('任务', summary.tasks),
    line('日常', summary.dailies),
    `${line('海面', summary.world)}  人口 ${summary.world.population}`,
  ].join('\n');
}
