// 自动循环：每轮依次跑 任务领取 → 日常（含任务奖励与活跃度宝箱） → 海面（收成品/竣工/建造/交单/排产/升级）
// → 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级） → 搁浅的货轮（按勾选等级抢货轮，默认只抢万吨）
// → 联盟情报（领奖 + 派舰队） → 装备厂（收装备 + 锻造） → 海兽培育室（收成熟 + 排空位）。
//
// 拾荒 / 农田 / 货轮 / 情报 / 锻造 / 挂机领取 / 培育 各自有独立间隔（gateDue）：自动循环每轮都会看一眼，
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
import { surveyPet, planPet, formatPetSummary } from './pet.mjs';
import { surveyIdle, planIdle, runIdle, formatIdleSummary } from './idle.mjs';
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
  const rejected = { tasks: new Set(), world: new Set(), radar: new Set(), forge: new Set(), pet: new Set(), idle: new Set(), treasure: new Set() };
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
  // 培育同理：探测成功就计时（哪怕这一轮没有空位、也没有成熟的）。
  let lastPetAt = 0;
  // 挂机领取同理：探测成功就计时（哪怕这一轮没有可领的）。
  let lastIdleAt = 0;
  // 货轮同理：探测成功就计时（哪怕这一轮没有可抢的）。
  let lastTreasureAt = 0;
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
      idle: part(), treasure: part(), radar: part(), forge: part(), pet: part(),
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
      worldPlan = planWorld(worldSurvey, {
        config,
        allowSpeedUp: pickAt(conf, 'allowSpeedUp', allowSpeedUp),
        allowReroll: pickAt(conf, 'allowReroll', allowReroll),
        useSelectPack: pickAt(conf, 'useSelectPack', useSelectPack),
        maxPackPerRound: pickAt(conf, 'maxPackPerRound', maxPackPerRound),
        pickUpFloaters: pickDue,
        farm: farmDue,
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
      }
    } catch (error) {
      summary.world.notes = [...summary.world.notes, `海面探测失败，本轮跳过：${error.message}`];
      finish();
      await waitNext(tickAt, everyNow, round < total);
      continue;
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
    const radarOn = pickAt(conf, 'radarEnabled', radarEnabled);
    const radarEvery = pickAt(conf, 'radarEveryMs', radarEveryMs);
    const ratioNow = pickAt(conf, 'minPowerRatio', minPowerRatio);
    const radarDue = radarOn && gateDue(lastRadarAt, radarEvery, tickAt);
    if (halted()) break;
    if (radarDue) {
      try {
        const radarSurvey = await linkRetry(() => surveyRadar(client, protocol, { config, stock: worldSurvey.stock }));
        const radarView = viewRadar(radarSurvey, { config, minPowerRatio: ratioNow });
        const radarPlan = planRadar(radarView, { minPowerRatio: ratioNow });
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

    // 8. 海兽培育室：成熟的一次领走，队列空位按「材料够的里面品质最高」排满。
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

    // 计时以「本轮开始时刻」为准：动作已经排进计划，就算执行过，失败也不立刻重试
    // （下一轮照样被 rejected 或间隔挡住），避免失败时高频撞服务端。
    if (pickDue && worldPlan?.actions.some((action) => action.kind === 'pickUpFloater')) lastPickAt = tickAt;
    if (farmDue && worldPlan?.actions.some((action) => action.kind === 'farmHarvest' || action.kind === 'farmPlant')) lastFarmAt = tickAt;
    // 静默窗还在跑的时候，攒够 30 分钟才再报一次（第一次已经在设窗那一轮报过了）。
    const treasureSkipNotice = treasureSkipping && tickAt - treasureSkipNoticedAt >= SKIP_NOTICE_MS;
    if (treasureSkipNotice) treasureSkipNoticedAt = tickAt;
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
      radar: { ...gateSummary(radarOn, radarEvery, lastRadarAt, tickAt), throttled: radarOn && !radarDue },
      forge: { ...gateSummary(forgeOn, forgeEvery, lastForgeAt, tickAt), throttled: forgeOn && !forgeDue },
      pet: { ...gateSummary(petOn, petEvery, lastPetAt, tickAt), throttled: petOn && !petDue },
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
  treasureDispatch: '抢货轮',
  equipPick: '收装备',
  equipMake: '锻造',
  petPick: '收海兽',
  petBreed: '培育海兽',
  petFeed: '材料加速',
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
    // 培育同理：探测过就印一行（哪怕是「队列满，最近一只还剩 20 小时」）。
    ...(summary.pet && (summary.pet.summary || (summary.pet.notes ?? []).length > 0)
      ? [`${line('海兽培育', summary.pet)}${summary.pet.summary ? `  ${summary.pet.summary}` : ''}`,
        ...detailLines(summary.pet),
        ...(summary.pet.notes ?? []).slice(0, 4).map((note) => `    跳过 ${note}`)]
      : []),
    ...(floater ? [`  ${floater}`] : []),
    ...[gateLine('货轮', summary.gates?.treasure)].filter(Boolean),
    ...[gateLine('情报', summary.gates?.radar)].filter(Boolean),
    ...[gateLine('锻造', summary.gates?.forge)].filter(Boolean),
    ...[gateLine('海兽培育', summary.gates?.pet)].filter(Boolean),
    ...[gateLine('挂机领取', summary.gates?.idle)].filter(Boolean),
    ...[gateLine('拾荒', summary.gates?.pick)].filter(Boolean),
    ...[gateLine('农田', summary.gates?.farm)].filter(Boolean),
  ].join('\n');
}
