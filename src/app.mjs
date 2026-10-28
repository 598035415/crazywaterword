import fs from 'node:fs';
import { GameClient, SECRET_FRAMES, clipBody } from './client.mjs';
import { loadProtocol } from './proto.mjs';
import { createConsole, openBrowser } from './server.mjs';
import { loadStore, saveStore, pickAccount, removeAccount, setActive, describeAccount, revealAccount, ACCOUNTS_PATH, LEGACY_CREDENTIALS_PATH } from './accounts.mjs';
import { listWorlds, listGroup, enterWorld, describeRole } from './worlds.mjs';
import { collectState, summarize, formatState } from './game.mjs';
import { ACTIONS, listActions, runAction, assertAllowed, buildBody } from './actions.mjs';
import { normalize } from './worlds.mjs';
import { getConfig } from './config.mjs';
import { planHeroes, runHeroPlan, formatHeroPlan } from './heroes.mjs';
import { surveyDailies, runDailies, formatSurvey, planChests, planDailyGift } from './dailies.mjs';
import { surveyTasks, runTasks, formatTaskPlan } from './tasks.mjs';
import { surveyWorld, planWorld, runWorld, formatWorldPlan, formatFieldReport, loadMapAsset, planFieldOccupy, planFieldGiveUp, summarizeFloaters, formatFloaters, SPEED_UP_ITEM, makeTypeResolver as resolveBuildingType, upgradeRow } from './world.mjs';
import { runLoop, formatLoopRound } from './loop.mjs';
import { surveyRadar, viewRadar, planRadar, formatRadarPlan, DEFAULT_MIN_POWER_RATIO } from './radar.mjs';
import { surveyPirates, viewPirates, planPirates, formatPiratePlan } from './pirate.mjs';
import { surveyEquip, planEquip, formatEquipPlan, formatEquipSummary } from './equip.mjs';
import { surveyPet, planPet, formatPetPlan, formatPetSummary, PET_QUALITIES } from './pet.mjs';
import { surveyIdle, planIdle, runIdle, formatIdleSummary, mailClaimable, planAfkClaims } from './idle.mjs';
import {
  surveyTreasure,
  viewTreasure,
  planTreasure,
  formatTreasurePlan,
  formatTreasureSummary,
  rewardCountText,
  colorsOf,
  colorsText,
  DEFAULT_MAX_FLEETS,
  DEFAULT_COLORS,
} from './treasure.mjs';
import {
  surveyTradeKing,
  viewTradeKing,
  planTradeKing,
  formatTradeSummary,
  summarizeTrade,
  formatTradeGain,
} from './tradeKing.mjs';
import {
  surveyCargo,
  fetchStock,
  viewCargo,
  planCargo,
  formatCargoSummary,
  summarizeCargo,
  formatCargoGain,
  safeCargoDemand,
  CARGO_SLOTS,
} from './tradePort.mjs';

const READ_ONLY_PROBES = [
  'AllResourceRequest',
  'AllItemRequest',
  'AfkInfoRequest',
  'DailyTaskInfoRequest',
  'ArenaInfoRequest',
  'GuildInfoRequest',
];

// --account <id|昵称|序号> 或 CW_ACCOUNT 指定用哪个号；都不给就用当前选中的那个。
function accountSelector() {
  const at = process.argv.indexOf('--account');
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1];
  return process.env.CW_ACCOUNT ?? null;
}

function loadCredentials() {
  const store = loadStore();
  if (!store.accounts.length) {
    throw new Error(`还没有任何账号。先跑 node tools/capture-credentials.mjs 抓一份凭证，或在网页控制台里扫码添加`);
  }
  const account = pickAccount(store, accountSelector());
  if (!account) throw new Error('选不出账号，用 --account <id|昵称|序号> 指定一个');
  // 有多个号、或用户明确指定了账号时才提示，免得单账号时每行输出都多一句。
  if (store.accounts.length > 1 || accountSelector()) {
    console.log(`账号: ${describeAccount(account).title} (${account.id.slice(0, 8)}…)`);
  }
  return { url: account.url, login: account.login, account };
}

// 配置表缓存可能不存在，缺了只是少点名字，不该让整条命令失败。
function loadConfigSafe() {
  try {
    return getConfig();
  } catch (error) {
    console.log(`warn: 未加载配置表 (${error.message})`);
    return null;
  }
}

// 读 `--flag 12` 这种带数值的参数。没写、或写的不是数字都返回 undefined，
// 让下游用它自己的默认值，而不是吃一个 NaN。
function numericArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

// 读 `--flag value` / `--flag=value` 这种带字符串值的参数。
// 只判 includes 会把值丢掉（`--out x.json` 会静默写死到默认路径，还不报错），所以两种写法都认。
function valueArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next !== undefined && next !== '' && !next.startsWith('--')) return next;
  }
  const prefix = `${flag}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) || null : null;
}

async function headless({ seconds = 60, probes = true }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });

  client.on('state', ({ state, detail }) => console.log(`state: ${state}${detail ? ` (${detail})` : ''}`));
  client.on('pong', ({ latencyMs, offsetMs }) => console.log(`pong: ${latencyMs}ms offset=${offsetMs}ms`));
  // 发出去了什么也要看得见 —— 排产/交单这类请求的问题往往在 body 里（productId 选错、
  // buildingId 认错建筑），只看 recv 无从判断。LoginRequest 带 token/sign，永远不打。
  client.on('frame', ({ dir, name, seq, bytes, body }) => {
    if (dir !== 'out' || !body || SECRET_FRAMES.has(name)) return;
    const text = clipBody(body);
    console.log(`send [${name}] seq=${seq} ${bytes.byteLength}B${text ? ` ${text}` : ''}`);
  });
  client.on('message', ({ name, seq, body }) => {
    const text = JSON.stringify(body);
    console.log(`recv [${name}] seq=${seq} ${text.length > 600 ? `${text.slice(0, 600)}...` : text}`);
  });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  console.log('login ok:', JSON.stringify({
    result: response.result,
    initSeqNo: response.initSeqNo,
    nickname: response.playerInfo?.nickname,
    level: response.playerInfo?.level,
    power: response.playerInfo?.power,
  }));

  if (probes) {
    for (const name of READ_ONLY_PROBES) {
      const responseName = `${name.slice(0, -7)}Response`;
      try {
        const body = await client.request(name, {}, responseName, 8000);
        const text = JSON.stringify(body);
        console.log(`probe [${name}] ok ${text.length > 400 ? `${text.slice(0, 400)}...` : text}`);
      } catch (error) {
        console.log(`probe [${name}] failed: ${error.message}`);
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  client.stop();
}

// Read-only: list the worlds this account has roles on, plus the user info for the
// world the account currently sits in. Passing a worldId adds a second connection that
// enters that world and prints its user info (see the newRole warning below).
async function worlds({ worldId = null, group = false, seconds = 0 }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  console.log(`current world (login worldId=0), user info:`);
  console.log(JSON.stringify(describeRole(response.playerInfo), null, 2));

  const worlds = await listWorlds(client);
  console.log(`\nworlds on this account (latestGroupId=${worlds.latestGroupId}, count=${worlds.recentWorlds.length}):`);
  for (const world of worlds.recentWorlds) {
    const role = world.role || {};
    const moved = role.worldId && role.worldId !== world.worldId ? ` -> ${role.worldId}` : '';
    console.log(`  worldId=${world.worldId}${moved} tag=${world.tag} ${role.nickname ?? ''} lv=${role.level ?? ''} power=${role.power ?? ''} lastLogin=${role.lastLoginTime ?? ''}`);
  }

  if (group && worlds.latestGroupId) {
    const all = await listGroup(client, worlds.latestGroupId);
    console.log(`\nworlds in group ${worlds.latestGroupId} (count=${all.length}):`);
    for (const world of all) console.log(`  worldId=${world.worldId} tag=${world.tag}`);
  }

  const worldIds = new Set(worlds.recentWorlds.map((world) => world.worldId));
  client.stop();

  if (worldId !== null) {
    const entered = await enterWorld({ url, login, protocol }, worldId);
    const player = entered.player || {};
    console.log(`\nentered worldId=${player.worldId} (requested ${worldId}), user info:`);
    console.log(JSON.stringify(describeRole(player), null, 2));
    if (!worldIds.has(worldId)) console.log(`note: worldId=${worldId} was not in the account's world list`);
    if (player.newRole) console.log('warning: newRole=true — this login created a role in that world');
    if (seconds > 0) await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    entered.client.stop();
  }
}

// Read-only: fire the whole post-login query set and dump what the game state is.
async function state({ raw = false, out = null }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} world=${describeRole(response.playerInfo)?.worldId}`);

  const started = Date.now();
  const { ok, failed } = await collectState(client, protocol, {
    onResult: (name, body, error) => {
      const size = error ? `failed: ${error.message}` : `${JSON.stringify(body).length}B`;
      console.log(`  ${error ? 'x' : '.'} ${name} ${size}`);
    },
  });
  console.log(`collected ${Object.keys(ok).length} responses, ${Object.keys(failed).length} failed in ${Date.now() - started}ms`);
  for (const [name, message] of Object.entries(failed)) console.log(`  failed ${name}: ${message}`);

  if (out) {
    fs.writeFileSync(out, `${JSON.stringify({ login: describeRole(response.playerInfo), ok, failed }, null, 1)}\n`);
    console.log(`state written to ${out}`);
  }
  if (raw) {
    for (const [name, body] of Object.entries(ok)) {
      const text = JSON.stringify(body);
      console.log(`\n=== ${name} ${text.length}B ===`);
      console.log(text.length > 2000 ? `${text.slice(0, 2000)}...` : text);
    }
  } else {
    console.log(`\n${formatState(summarize({ ok }, { config: loadConfigSafe() }))}`);
  }
  client.stop();
}


const asArray = (value) => (Array.isArray(value) ? value : []);

// 一键领取：先采集状态判定哪些能领，再逐个执行，最后重新采集做前后对比。
// 只包含领取类动作，不改动任何需要消耗资源的东西。
function planLoot(ok, now, config = null, level = 1) {
  const plan = [];
  const claimable = (list) => asArray(list).filter((task) => task.progress >= task.targetProgress && !task.rewardClaimed);

  // 邮件：判据跟循环里那份是同一个函数（idle.mjs 的 mailClaimable），
  // 别再写「无条件发一次」—— 没有可领的邮件时那条请求会被服务端打回。
  if (mailClaimable(ok.EmailBoxRequest?.email ?? [])) {
    plan.push({ id: 'emailQuickGet', params: {}, why: '邮件一键领取' });
  }

  const daily = ok.DailyTaskInfoRequest;
  for (const task of claimable(daily?.dailyTask)) plan.push({ id: 'dailyTaskDraw', params: { id: task.id }, why: `每日任务 ${task.id}` });

  // 活跃度宝箱排在任务奖励之后：任务奖励本身会加活跃度，顺序反了会白跑一轮。
  for (const action of planChests(daily, config).actions) {
    plan.push({
      id: action.request === 'DrawWeeklyRewardRequest' ? 'weeklyRewardDraw' : 'dailyRewardDraw',
      params: { index: action.body.index },
      why: action.note,
    });
  }

  // 每日精选那档免费赠礼，和活跃度宝箱无关，单独看 DailyGiftPackResponse.drawnPack。
  for (const action of planDailyGift(ok.DailyGiftPackResponse).actions) {
    plan.push({ id: 'freeDailyPackDraw', params: { packId: action.body.packId }, why: action.note });
  }

  const achievement = ok.AchievementInfoRequest;
  for (const task of claimable(achievement?.task)) plan.push({ id: 'achievementDraw', params: { id: task.id }, why: `成就 ${task.id}` });

  // 挂机两个领取（本段收益 / 等级奖励）用的是 idle.mjs 的 planAfkClaims —— 跟循环同一份判据：
  // 等级奖励看 OfflineLvRewardCfg 里第一个有奖的等级，且不能超过当前挂机等级。
  for (const step of planAfkClaims(ok.AfkInfoRequest?.afkInfo, config, now)) {
    plan.push({ id: step.kind, params: step.body, why: step.label });
  }

  for (const building of asArray(ok.OnWaterRequest?.building)) {
    // 竣工与建造只能二选一：同一轮先竣工再建造，竣工后它已不是 level 0，建造必被拒。
    const finishing = building.buildFinishTime > 0 && now >= building.buildFinishTime;
    if (finishing) {
      plan.push({ id: 'buildingFinish', params: { buildingId: building.buildingId }, why: `${building.buildingId} 竣工` });
    }
    if (asArray(building.factory?.finishedProducts).length > 0) {
      plan.push({ id: 'factoryGain', params: { buildingId: building.buildingId }, why: `${building.buildingId} 工厂成品` });
    }
    if (asArray(building.product?.asset).length > 0) {
      plan.push({ id: 'buildingCollect', params: { buildingId: building.buildingId }, why: `${building.buildingId} 建筑产物` });
    }
    // level=0 是想盖还没盖的空位，够等级就顺手盖掉（level 1 行的消耗与耗时都是空的）。
    if (building.level === 0 && !finishing && config) {
      const type = resolveBuildingType(config)(building.buildingId);
      const row = type ? upgradeRow(config, type, 1) : null;
      if (row && asArray(row.condition).length === 0 && row.playerLevel <= level) {
        plan.push({ id: 'buildBuilding', params: { buildingId: building.buildingId }, why: `建造 ${building.buildingId}（需等级 ${row.playerLevel}）` });
      }
    }
  }
  return plan;
}

const KEY_FIELDS = (ok) => {
  const afk = ok.AfkInfoRequest?.afkInfo;
  const daily = ok.DailyTaskInfoRequest;
  const heroes = asArray(ok.AllHeroRequest?.heroes);
  const items = asArray(ok.AllItemRequest?.items);
  return {
    挂机等级: afk ? `${afk.level} 已领${afk.rewardedLevel} 封顶至${afk.afkFinishTime}` : '-',
    每日任务已完成: daily ? `${asArray(daily.dailyTask).filter((t) => t.progress >= t.targetProgress).length} 个` : '-',
    邮件未领: ok.EmailBoxRequest ? asArray(ok.EmailBoxRequest.email).filter((m) => !m.got).length : '-',
    道具总数: items.length,
    装备数: asArray(ok.EquipsRequest?.equip).length,
    英雄战力: heroes.reduce((sum, hero) => sum + hero.power, 0),
  };
};

// 领取类动作：先判定后执行，最后重新采集对比。即发即弃的请求在断开前留出排空时间。
async function loot({ allowMutate, dryRun = false }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} world=${describeRole(response.playerInfo)?.worldId}`);
  const config = loadConfigSafe();
  try {
    const before = (await collectState(client, protocol)).ok;
    const now = Date.now() / 1000;
    const plan = planLoot(before, now, config, describeRole(response.playerInfo)?.level ?? 1);

    console.log(`\n可领取 ${plan.length} 项:`);
    for (const step of plan) console.log(`  ${step.id} ${JSON.stringify(step.params)} — ${step.why}`);

    if (dryRun) {
      console.log('\n--dry：只列出计划，未执行任何动作');
      return;
    }

    console.log('\n执行:');
    let failed = 0;
    for (const step of plan) {
      try {
        assertAllowed(step.id, { allowMutate });
        const result = await runAction(client, protocol, step.id, step.params, { allowMutate });
        const detail = result.body ? ` ${JSON.stringify(normalize(result.body)).slice(0, 200)}` : ' 即发即弃';
        console.log(`  . ${result.sent} ${JSON.stringify(step.params)}${detail}`);
      } catch (error) {
        failed += 1;
        console.log(`  x ${step.id} ${JSON.stringify(step.params)} 失败: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = (await collectState(client, protocol)).ok;
    console.log(`\n执行 ${plan.length - failed} 项成功，${failed} 项失败`);
    console.log('\n前后对比:');
    const a = KEY_FIELDS(before);
    const b = KEY_FIELDS(after);
    for (const key of Object.keys(a)) {
      const changed = String(a[key]) !== String(b[key]);
      console.log(`  ${changed ? '变' : '  '} ${key}: ${a[key]} -> ${b[key]}`);
    }
  } finally {
    client.stop();
  }
}

// One protocol call. Mutating actions need CW_ALLOW_MUTATE=1; without it the run stops
// before anything leaves the socket.
async function act({ id, params, allowMutate }) {
  assertAllowed(id, { allowMutate });
  buildBody(ACTIONS[id], params);
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  await client.connect(login);
  try {
    const result = await runAction(client, protocol, id, params, { allowMutate });
    console.log(`${result.sent}${result.response ? ` -> ${result.response}` : ' (无响应，回包走推送或 OkResponse)'}`);
    if (result.body) console.log(JSON.stringify(normalize(result.body), null, 2));
  } finally {
    client.stop();
  }
}

// 英雄养成：先按客户端红点条件算计划，--dry 只打印，--yes 才真发请求。
async function heroes({ allowMutate, dryRun, allowUniversal }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    const heroList = await client.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
    const itemList = await client.request('AllItemRequest', {}, 'AllItemResponse', 15000);
    const counts = new Map();
    for (const item of itemList.items ?? []) {
      const id = item.itemId ?? item.id;
      counts.set(id, (counts.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
    }
    const itemNum = (id) => counts.get(id) ?? 0;
    const playerLevel = describeRole(response.playerInfo).level;
    const plan = planHeroes({ config, heroes: heroList.heroes ?? [], itemNum, playerLevel, allowUniversal });
    console.log(`玩家等级 ${playerLevel}，英雄等级上限 ${plan.maxLevel}，星级上限 ${plan.maxStar}`);
    console.log(formatHeroPlan(plan));
    const requests = plan.steps.reduce((sum, step) => sum + (step.kind === 'level' ? step.count : 1), 0);
    console.log(`\n共 ${plan.steps.length} 个步骤 / ${requests} 个请求`);

    if (dryRun) {
      console.log('\n--dry：只列计划，未执行');
      return;
    }
    await runHeroPlan(client, protocol, plan, {
      allowMutate,
      timeout: 8000,
      onStep: (entry) => {
        const step = entry.step;
        const label = step.kind === 'level' ? `${step.heroId} lv${step.to}` : step.kind === 'star' ? `${step.heroId} ${step.to}星` : `${step.heroId} 技能${step.slot + 1}`;
        console.log(entry.ok ? `  . ${label}` : `  x ${label} 失败: ${entry.error}`);
      },
    });
    const after = await client.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
    console.log('\n养成后:');
    for (const hero of after.heroes ?? []) console.log(`  ${hero.heroId} lv${hero.level} ${hero.star}星 战力${hero.power} 技能${JSON.stringify(hero.skillLevels)}`);
  } finally {
    client.stop();
  }
}

// 日常：先只读探一遍（--dry 到这里就够），--yes 才执行，--paid 才允许花钻石的动作。
async function dailies({ allowMutate, dryRun, allowPaid }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} world=${describeRole(response.playerInfo)?.worldId}`);
    const survey = await surveyDailies(client, protocol, { config, player: response.playerInfo });
    console.log(`\n${formatSurvey(survey)}\n`);
    for (const entry of survey.tasks) {
      for (const action of entry.actions ?? []) console.log(`  ${entry.task.id} ${action.request} ${JSON.stringify(action.body)} — ${action.note} (${action.cost})`);
    }

    if (dryRun) {
      console.log('\n--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runDailies(client, protocol, survey, {
      allowMutate,
      allowPaid,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.title} 跳过: ${entry.reason}`);
        else console.log(entry.ok ? `  . ${entry.title} ${entry.note}` : `  x ${entry.title} ${entry.note} 失败: ${entry.error}`);
      },
    });

    // 完成数变化只认服务端回包，重新拉一次对照。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await surveyDailies(client, protocol, { config, player: response.playerInfo });
    console.log('\n任务进度对比:');
    const before = new Map(survey.tasks.map((entry) => [entry.task.id, entry.task]));
    for (const entry of after.tasks) {
      const was = before.get(entry.task.id);
      const a = `${was?.progress ?? 0}/${was?.targetProgress ?? 0}`;
      const b = `${entry.task.progress}/${entry.task.targetProgress}`;
      console.log(`  ${a !== b ? '变' : '  '} ${entry.task.title}: ${a} -> ${b}`);
    }
    // runDailies 已经把任务奖励、活跃度宝箱与每日赠礼收尾了，这里只把剩下的状态摆出来。
    console.log(`\n${formatSurvey(after).split('\n').filter((line) => line.startsWith('活跃奖励') || line.startsWith('每日赠礼')).join('\n')}`);
    if (after.ruby !== survey.ruby) console.log(`\n钻石 ${survey.ruby} -> ${after.ruby}`);
  } finally {
    client.stop();
  }
}

// 任务领取：主线 / 支线 / 成就 / 每日订单档位。--dry 只列判定，--yes 才真领。
async function tasks({ allowMutate, dryRun }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyTasks(client, protocol, { config });
    console.log(`\n${formatTaskPlan(survey)}\n`);
    for (const step of survey.plan) {
      const reward = step.reward ? ` 奖励 ${step.reward.map(([id, num]) => `${id}x${num}`).join(',')}` : '';
      console.log(`  ${step.request} ${JSON.stringify(step.body)} — ${step.label}${reward}`);
    }
    console.log(`\n共 ${survey.plan.length} 条可领`);

    if (dryRun) {
      console.log('--dry：只列判定，未领取');
      return;
    }

    console.log('\n领取:');
    await runTasks(client, protocol, survey, {
      allowMutate,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 领没领到只认服务端回包，重新探一遍对照。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await surveyTasks(client, protocol, { config });
    console.log(`\n领取后剩余可领 ${after.plan.length} 条:`);
    for (const step of after.plan) console.log(`  ${step.label}`);
  } finally {
    client.stop();
  }
}

// 海面世界：收成品 / 竣工 / 交单 / 排产 / 余料升级建筑。--dry 只列计划，--yes 才真发请求。
// --speed-up 才允许花「加速器」（钻石永远不碰）；--reroll 才允许拒绝材料不齐的订单。
// 材料不齐时默认会拿「原料自选包 / 工事材料自选包」兑出来补（--no-pack 关掉，--max-pack 改上限）。
// --pick 才扫海面漂浮物（拾荒），结束后打印所得。
// 没有 --dive：潜水/打捞的请求体里要填「你实际捡到了什么」，纯协议只能伪造，故不做（见 docs/gameplay.md）。
async function world({ allowMutate, dryRun, allowSpeedUp, allowReroll, useSelectPack = true, maxPackPerRound, packGapMax, pickUpFloaters = false, farm = true }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyWorld(client, protocol, { config, player: response.playerInfo });
    // 货船缺口也并进排产需求：CLI 与挂机必须算出同一份计划（贸易港口没建/探测失败时空表）。
    const cargoDemand = await safeCargoDemand(client, protocol, { stock: survey.stock });
    const plan = planWorld(survey, { config, allowSpeedUp, allowReroll, useSelectPack, maxPackPerRound, packGapMax, pickUpFloaters, farm, cargoDemand });
    console.log(`\n${formatWorldPlan(survey, plan)}\n`);
    console.log(`共 ${plan.actions.length} 个动作${allowSpeedUp ? '' : '（未开 --speed-up，不会花' + SPEED_UP_ITEM + '）'}`
      + `${pickUpFloaters ? `，含拾荒 ${(survey.floaters ?? []).length} 件漂浮物` : '（未开 --pick，不拾荒）'}`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    const { rejected, results } = await runWorld(client, protocol, plan, {
      allowMutate,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });
    // 拾荒所得汇总一行：逐条日志太碎，看不出这一轮到底拿到了什么。
    const floaterText = formatFloaters(summarizeFloaters(results));
    if (floaterText) console.log(`\n${floaterText}`);
    if (rejected.size) console.log(`本轮被拒 ${rejected.size} 条`);

    // 前面对照只认重新探测的结果。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await surveyWorld(client, protocol, { config, player: response.playerInfo });
    console.log(`\n对照: 人口 ${survey.population}/${survey.maxPopulation} -> ${after.population}/${after.maxPopulation}`);
    console.log(`  库存种类 ${survey.stock.size} -> ${after.stock.size}，订单 ${survey.orders.length} -> ${after.orders.length}`);
    const changed = survey.buildings.filter((b) => {
      const now = after.buildings.find((x) => x.buildingId === b.buildingId);
      return now && now.level !== b.level;
    });
    for (const b of changed) {
      const now = after.buildings.find((x) => x.buildingId === b.buildingId);
      console.log(`  变 ${b.buildingId} lv${b.level} -> lv${now.level}`);
    }
    for (const key of ['建筑蓝图', 'GOLD', SPEED_UP_ITEM, '木材', '玻璃', '塑料', '碎布', '金属', '海藻']) {
      const a = survey.have(key);
      const b = after.have(key);
      if (a !== b) console.log(`  变 ${key} ${a} -> ${b}`);
    }
  } finally {
    client.stop();
  }
}

// 装备厂（锻造）：造好了就收取，收完按部位件数最少的排下一件。
// --dry 只列计划；--yes 才真的收/造（会消耗材料与金币，但绝不动钻石、不加速）。
async function forge({ allowMutate, dryRun }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyEquip(client, protocol, { config });
    const plan = planEquip(survey, { config });
    console.log(`\n${formatEquipPlan(survey, plan)}\n`);
    console.log(`共 ${plan.actions.length} 个动作`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runWorld(client, protocol, plan, {
      allowMutate,
      window: 800,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 只认重新探测的结果：打造状态是服务端说了算。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await surveyEquip(client, protocol, { config });
    console.log(`\n对照: ${formatEquipSummary(after)}`);
  } finally {
    client.stop();
  }
}

// 海兽培育室：收成熟的 + 材料加速 + 队列空位排产。--dry 只列计划；品质上限 --pet-max-quality；
// 材料加速默认开，--no-pet-feed 关。
async function petCli({ allowMutate, dryRun, maxQuality = 'ORANGE', allowFeed = true }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyPet(client, protocol, { config });
    const plan = planPet(survey, { config, maxQuality, allowFeed });
    console.log(`\n${formatPetPlan(survey, plan)}\n`);
    console.log(`共 ${plan.actions.length} 个动作（品质上限 ${maxQuality}，材料加速 ${allowFeed ? '开' : '关'}）`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runWorld(client, protocol, plan, {
      allowMutate,
      window: 800,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 只认重新探测的结果：队列和成熟海兽都是服务端说了算。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await surveyPet(client, protocol, { config });
    console.log(`\n对照: ${formatPetSummary(after)}`);
  } finally {
    client.stop();
  }
}

// 挂机领取：邮件附件 + 挂机本段收益 + 挂机等级奖励 + 挂机等级升级。
// 四样都免费（升级只花「挂机徽章」道具），所以默认就在循环里开跑；--dry 只列计划。
async function idleCli({ allowMutate, dryRun }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyIdle(client, protocol, { config, player: response.playerInfo });
    const plan = planIdle(survey, { config });
    console.log(`\n${formatIdleSummary(survey)}\n`);
    for (const step of plan.actions) console.log(`  ${step.kind.padEnd(12)}${step.label}`);
    for (const note of plan.notes) console.log(`  跳过 ${note}`);
    console.log(`\n共 ${plan.actions.length} 个动作`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runIdle(client, protocol, plan, {
      allowMutate,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 只认重新探测的结果：挂机等级的计时是服务端说了算。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await surveyIdle(client, protocol, { config, player: response.playerInfo });
    console.log(`\n对照: ${formatIdleSummary(after)}`);
  } finally {
    client.stop();
  }
}

// 联盟情报（RADAR_VIEW）：先领已完成的奖励，再把每艘空闲船各派去打一个能打过的事件。
// --dry 只列判定；--yes 才真的派兵（战败会掉舰船耐久，所以默认要求 1.2 倍战力余量）。
// --power-ratio 0.8 可以放宽到「八折战力也上」，自己承担战损。
// --max N 限制最多派几艘（默认不限制 = 有多少空闲船就派多少）。
async function radar({ allowMutate, dryRun, minPowerRatio, maxDispatch = Infinity, repairBelowPercent = 80 }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  // 百分数 -> 比例（radar 模块内部统一用比例）。
  const repairBelow = Math.min(1, Math.max(0, Number(repairBelowPercent) || 0) / 100);
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyRadar(client, protocol, { config, repairBelow });
    const view = viewRadar(survey, { config, minPowerRatio, repairBelow });
    const plan = planRadar(view, { minPowerRatio, maxDispatch, repairBelow });
    console.log(`\n${formatRadarPlan(view, plan)}\n`);
    const capText = Number.isFinite(Number(maxDispatch)) ? `一次最多派 ${maxDispatch} 艘` : '空闲船全派';
    const repairText = repairBelow > 0 ? `耐久 <${Math.round(repairBelow * 100)}% 就修` : '不修船';
    console.log(`共 ${plan.actions.length} 个动作（战力余量 ${minPowerRatio}×，${capText}，${repairText}）`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runWorld(client, protocol, plan, {
      allowMutate,
      window: 900,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 只认重新探测的结果：舰队状态、事件状态都是服务端说了算。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await surveyRadar(client, protocol, { config, repairBelow });
    const afterView = viewRadar(after, { config, minPowerRatio, repairBelow });
    console.log(`\n对照: 舰队 ${afterView.fleets.map((fleet) => `${fleet.buildingId}=${fleet.stateText}(${Math.round(fleet.duraPct * 100)}%)`).join(' ') || '无'}`);
    console.log(`  待领奖 ${view.rewards.length} -> ${afterView.rewards.length}，可派 ${view.events.filter((e) => e.dispatchable).length} -> ${afterView.events.filter((e) => e.dispatchable).length}`);
    console.log(`  汽油 ${after.petrol}`);
  } finally {
    client.stop();
  }
}

// 海盗讨伐（世界地图**真出战**）：按「已击杀最高等级 + 1」找地图上的海盗，派空闲舰队去打。
// 跟每日任务里的「免战扫荡」（PirateSweepRequest，一天 10 次、不动舰队）是两码事。
// --dry 只列计划；--yes 才真派（每次烧 300 汽油，不掉耐久）。
// --repeat 连已通关等级也刷（只剩固定掉落）；--power-ratio 改战力余量；--max N 限制派几艘。
async function pirateCli({ allowMutate, dryRun, minPowerRatio, maxPerRound = Infinity, repeat = false, repairBelowPercent = 80 }) {
  // 耐久闸（百分数 -> 比例）：低于它的船不出战（打野怪不掉耐久，但耐久低会降输出）。
  const duraFloor = Math.min(1, Math.max(0, Number(repairBelowPercent) || 0) / 100);
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  // 赛季要从 worldId 算（战力按 season_type_level 三元组查表），所以必须把 playerInfo 传下去。
  const player = response.playerInfo ?? null;
  try {
    console.log(`login ok: ${describeRole(player)?.nickname} lv${describeRole(player)?.level}`);
    const survey = await surveyPirates(client, protocol, { config, player });
    const view = viewPirates(survey, { config, minPowerRatio, repeat, duraFloor });
    const plan = planPirates(view, { maxPerRound });
    console.log(`\n${formatPiratePlan(view, plan)}\n`);
    const capText = Number.isFinite(Number(maxPerRound)) ? `一次最多派 ${maxPerRound} 艘` : '空闲船全派';
    console.log(`共 ${plan.actions.length} 个动作（战力余量 ${minPowerRatio}×，${repeat ? '含已通关等级' : '只打首杀等级'}，${capText}）`);
    if (view.season <= 0) {
      console.log('注意：拿不到世界赛季（playerInfo 里没有 worldId），战力按各赛季最高值估，偏保守。');
    }

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runWorld(client, protocol, plan, {
      allowMutate,
      window: 900,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 只认重新探测的结果：舰队状态和击杀进度都是服务端说了算。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await surveyPirates(client, protocol, { config, player });
    const afterView = viewPirates(after, { config, minPowerRatio, repeat, duraFloor });
    const progress = (one) => one.types.map((type) => `${type.name.replace('海盗', '')}${type.killedLevel}`).join('/');
    console.log(`\n对照: 舰队 ${afterView.fleets.map((fleet) => `${fleet.buildingId}=${fleet.stateText}`).join(' ') || '无'}`);
    console.log(`  击杀进度 ${progress(view)} -> ${progress(afterView)}`);
    console.log(`  汽油 ${view.petrol} -> ${after.petrol}`);
  } finally {
    client.stop();
  }
}

// 搁浅的货轮（世界宝藏）：按勾选的等级挑货轮（无人占领的优先，被占着的也派）→ 一条请求把空闲舰队压上去。
async function treasureCli({ allowMutate, dryRun, maxFleets, colors, repairBelowPercent = 80 }) {
  // 耐久闸（百分数 -> 比例）：低于它的船不派去抢（要打守军，耐久低会降输出、挨打更疼）。
  const duraFloor = Math.min(1, Math.max(0, Number(repairBelowPercent) || 0) / 100);
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  const wanted = colorsOf(colors);
  try {
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const survey = await surveyTreasure(client, protocol, { config, player: response.playerInfo });
    const view = viewTreasure(survey, { config, colors: wanted, maxFleets, duraFloor });
    const plan = planTreasure(view, { maxFleets });
    console.log(`\n${formatTreasureSummary(view)}`);
    console.log(`\n${formatTreasurePlan(view, plan)}\n`);
    console.log(`共 ${plan.actions.length} 个动作（抢 ${colorsText(config, wanted)}，一次最多 ${maxFleets} 支舰队）`);

    if (dryRun) {
      console.log('--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    await runWorld(client, protocol, plan, {
      allowMutate,
      window: 900,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });

    // 只认重新探测的结果：货轮归属和舰队状态都是服务端说了算。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await surveyTreasure(client, protocol, { config, player: response.playerInfo });
    const afterView = viewTreasure(after, { config, colors: wanted, maxFleets, duraFloor });
    console.log(`\n对照: 舰队 ${afterView.fleets.map((fleet) => `${fleet.buildingId}=${fleet.stateText}`).join(' ') || '无'}`);
    console.log(`  可抢 ${view.targets.length} -> ${afterView.targets.length}，${rewardCountText(afterView)}，汽油 ${after.petrol}`);
  } finally {
    client.stop();
  }
}

// 贸易港口（建筑「货轮港口」）：3 艘货船逐格交货换 EXP+金币，返航后领 4 份藏品奖励。
// 默认只试算（--dry 之外才执行写操作），跟循环里那套完全一样：探测 → 计划 → 执行。
async function cargoCli({ allowMutate, dryRun }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  try {
    const response = await client.connect(login);
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const stock = await fetchStock(client, protocol);
    const survey = await surveyCargo(client, protocol, { stock });
    const view = viewCargo(survey);
    const plan = planCargo(view);
    console.log(`\n${formatCargoSummary(view)}`);
    for (const ship of view.ships) {
      console.log(`  货船#${ship.index} ${ship.statusText} 已交 ${ship.filledCount}/${CARGO_SLOTS}`
        + (ship.phase === 'sailing' ? `  返航剩 ${Math.ceil(ship.leftSeconds / 60)} 分` : '')
        + (ship.claimable ? '  可领奖' : ''));
      for (const slot of ship.slots) {
        console.log(`    [${slot.slot}] ${slot.id}×${slot.num} ${slot.filled ? '已交' : `未交（库存 ${slot.have}）`}`
          + ` → ${slot.reward.map((r) => `${r.id}×${r.num}`).join(' ')}`);
      }
    }
    console.log(`\n计划 ${plan.actions.length} 条`);
    for (const action of plan.actions) console.log(`  ${action.label}`);
    for (const note of plan.notes) console.log(`  跳过 ${note}`);

    if (dryRun) {
      console.log('\n--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    const { results } = await runWorld(client, protocol, plan, {
      allowMutate,
      window: 900,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });
    const gain = formatCargoGain(summarizeCargo(results));
    if (gain) console.log(`\n${gain}`);
  } finally {
    client.stop();
  }
}

// 海商王：只读探测 + 计划，「--run」才真执行（会改账号状态，需要 --yes）。
async function tradeCli({ allowMutate, dryRun, allowSpeed = true }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  try {
    const response = await client.connect(login);
    console.log(`login ok: ${describeRole(response.playerInfo)?.nickname} lv${describeRole(response.playerInfo)?.level}`);
    const config = getConfig();
    const stock = await fetchStock(client, protocol);
    const survey = await surveyTradeKing(client, protocol, { stock });
    const view = viewTradeKing(survey, { config });
    const plan = planTradeKing(view, { config, allowSpeed });
    console.log(`\n${formatTradeSummary(view)}`);
    if (!view.open) console.log('  本期未开启 / 不在贸易时间（每天 10~22 点）');
    console.log(`  下次刷新价 ${new Date(view.nextRefreshAt * 1000).toLocaleTimeString()} · 商会指针 ${view.speed.owned} 个`);
    if (view.shelf.length > 0) {
      console.log(`\n本港（城市 ${view.cargo.cityId}）货架：`);
      for (const row of view.shelf) {
        const mark = row.goodsId === view.specGoodsId ? ' 特产' : (row.goodsId === view.rareGoodsId ? ' 紧缺' : '');
        const cand = view.candidates.find((c) => c.goodsId === row.goodsId);
        console.log(`  ${row.name.padEnd(6, ' ')} ${String(row.price).padStart(5)} / 基准 ${row.base}`
          + ` 系数 ${row.ratio.toFixed(3)} 可买 ${row.avail}${mark}`
          + (cand ? ` → 城${cand.destCityId} 单件利润 ${cand.unitProfit}` : ''));
      }
    }
    console.log(`\n港口状态（已知紧缺 ${view.knownCount}/${view.cities.length} 港；每天 10 点重置，只有当天被共享过才知道）：`);
    for (const pair of view.pairs) {
      console.log(`  城${String(pair.cityId).padStart(3)} 特产 ${pair.specName.padEnd(6, ' ')}`
        + ` 紧缺 ${pair.known ? String(pair.rareName).padEnd(6, ' ') : '？'.padEnd(6, ' ')}`
        + ` → 特产卖到 ${pair.sellCityId ? `城${pair.sellCityId}` : '?'}`);
    }
    if (view.routes.length > 0) {
      console.log('\n已知航线（买 → 卖，按回报排序）：');
      for (const route of view.routes.slice(0, 8)) {
        console.log(`  ${route.name.padEnd(6, ' ')} 城${route.buyCity} @${route.buyPrice} → 城${route.sellCity} @${route.sellPrice}`
          + ` 单件 ${route.unitProfit} 回报 ${(route.roi * 100).toFixed(1)}% 一趟约 ${route.tripProfit}`
          + (route.priceKnown ? '（真实卖价）' : '（估算）'));
      }
    } else {
      console.log('\n还没有任何已知航线：等联盟共享，或者先开去「紧缺未知」的港口探路。');
    }
    console.log(`\n计划 ${plan.actions.length} 条`);
    for (const action of plan.actions) console.log(`  ${action.label}`);
    for (const note of plan.notes) console.log(`  跳过 ${note}`);

    if (dryRun) {
      console.log('\n--dry：只列计划，未执行');
      return;
    }

    console.log('\n执行:');
    const { results } = await runWorld(client, protocol, plan, {
      allowMutate,
      window: 900,
      onStep: (entry) => {
        if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
        else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
      },
    });
    const gain = formatTradeGain(summarizeTrade(results));
    if (gain) console.log(`\n${gain}`);
  } finally {
    client.stop();
  }
}

// 临时验证命令：SetAutoFarmingRequest 到底管什么？// 协议里它只有一个 isOn，配置里却同时有「自动潜水」和「自动拾荒」两个 param，
// 而海面响应里也有一堆并列的自动开关。所以不猜，发一次，前后各拍一张快照对比：
// 漂浮物数量掉不掉、autoFarming 变不变 true、三个小游戏等级动不动。
// 它会改账号状态，因此要 --yes；--off 用来恢复关闭；--wait 控制观察秒数。
async function autofarm({ allowMutate, turnOn = true, waitSeconds = 8 }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  await client.connect(login);
  const snapshot = async () => {
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse', 8000));
    return {
      autoFarming: water.autoFarming === true,
      floaters: (water.floater ?? []).length,
      autoProduceForever: water.autoProduceForever === true,
      diving: water.divingLevel?.level ?? null,
      salvage: water.salvageLevel?.level ?? null,
      fishing: water.fishingLevel?.level ?? null,
    };
  };
  const show = (tag, s) => console.log(
    `${tag} autoFarming=${s.autoFarming}  漂浮物=${s.floaters}  永久自动生产=${s.autoProduceForever}`
    + `  潜水Lv${s.diving} 打捞Lv${s.salvage} 钓鱼Lv${s.fishing}`,
  );

  try {
    const before = await snapshot();
    show('开前 ', before);

    if (!allowMutate) {
      console.log('\n（没加 --yes：只读快照，没发任何请求）');
      return;
    }

    try {
      // 这个请求没有 *Response，成功时服务端一声不吭，只能靠 sendWatch 守窗口。
      await client.sendWatch('SetAutoFarmingRequest', { isOn: turnOn }, { window: 900 });
      console.log(`\n已发送 SetAutoFarmingRequest { isOn: ${turnOn} }，窗口内没有被拒`);
    } catch (error) {
      console.log(`\nSetAutoFarmingRequest 被拒：${error.message}`);
      return;
    }

    console.log(`等 ${waitSeconds} 秒，看服务端会不会有反应 ...`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    const after = await snapshot();
    show('开后 ', after);

    console.log('\n对比:');
    console.log(`  autoFarming    ${before.autoFarming} -> ${after.autoFarming}`);
    console.log(`  漂浮物数量     ${before.floaters} -> ${after.floaters}`);
    console.log(`  永久自动生产   ${before.autoProduceForever} -> ${after.autoProduceForever}`);
    console.log(`  潜水等级       ${before.diving} -> ${after.diving}`);
    console.log(`  打捞等级       ${before.salvage} -> ${after.salvage}`);
    console.log(`  钓鱼等级       ${before.fishing} -> ${after.fishing}`);

    console.log('\n判读:');
    if (after.autoFarming !== before.autoFarming) {
      console.log('  → autoFarming 状态跟着变了，这个开关确实是它');
      if (after.floaters < before.floaters) console.log('  → 而且漂浮物在减少，说明它就是自动拾荒');
      else console.log('  → 但漂浮物没减少，说明它管的是别的东西（很可能只是农场）');
    } else if (after.floaters < before.floaters) {
      console.log('  → 回显字段没变，但漂浮物在减少，说明服务端已经在自动捡了');
    } else {
      console.log('  → 短时间内看不出变化。把 --wait 调大（如 --wait 60）再看一次，');
      console.log('     或者回网页观察 2 分钟：漂浮物自己变少 = 自动拾荒生效');
    }
  } finally {
    client.stop();
  }
}

// 资源田：默认只读报告；occupy / giveup 需要显式 gridIdx 与 --yes。
// 占田要求「该田所属城是我方城 + 有闲置且耐久>0 的舰队」，条件不满足就直接拒绝，不发请求。
async function field({ sub, gridIdx, fleets, allowMutate }) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const response = await client.connect(login);
  const config = loadConfigSafe();
  try {
    const player = response.playerInfo;
    let map = null;
    try {
      map = loadMapAsset(Number(player?.scenarioId ?? 0));
    } catch (error) {
      console.log(`warn: 地图资源读取失败 (${error.message})`);
    }
    const survey = await surveyWorld(client, protocol, { config, player });
    console.log(formatFieldReport(survey, map));

    if (!sub) return;
    const grid = Number(gridIdx);
    if (!Number.isFinite(grid)) throw new Error('usage: node src/app.mjs field [occupy|giveup <gridIdx>] [--fleets a,b]');
    const fleetIds = (fleets ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    let planned;
    if (sub === 'occupy') {
      const at = map?.fieldAt(grid);
      if (map && !at) throw new Error(`gridIdx=${grid} 在地图上不是资源田`);
      if (at) console.log(`地图: gridIdx=${grid} 属于城 ${at.cityId}，类型 ${at.resType}`);
      planned = planFieldOccupy(survey, grid, { fleetBuildingIds: fleetIds });
    } else if (sub === 'giveup') {
      planned = planFieldGiveUp(survey, grid);
    } else {
      throw new Error(`未知子命令 ${sub}`);
    }
    if (planned.error) throw new Error(planned.error);

    console.log(`${planned.action.label} -> ${planned.action.request} ${JSON.stringify(planned.action.body)}`);
    if (!allowMutate) {
      console.log('未加 --yes，只打印计划，未发送');
      return;
    }
    const { rejected } = await runWorld(client, protocol, { actions: [planned.action], notes: [] }, {
      allowMutate,
      onStep: (entry) => console.log(entry.ok ? '  . 已发送' : `  x ${entry.error}`),
    });
    if (rejected.size) console.log('被服务端拒绝（PromptResponse），未生效');
  } finally {
    client.stop();
  }
}

// 自动循环：任务 → 日常 → 海面，每轮之间睡 --every 秒。必须显式开，Ctrl-C 收尾后退出。
// 拾荒另外有自己的间隔（--pick-every，秒；0 = 不限制）。
// 农田默认开（收成熟作物 + 补种），--no-farm 关；间隔 --farm-every（秒，默认 120）。
// 联盟情报默认开（领奖 + 派兵），--no-radar 关；间隔 --radar-every（秒，默认 60）。
// 海盗讨伐默认开（真出战打地图海盗），--no-pirate 关；间隔 --pirate-every（秒，默认 60），
// --pirate-repeat 连已通关等级也刷（默认只打首杀等级）。
// 装备厂默认开（收装备 + 锻造），--no-forge 关；间隔 --forge-every（秒，默认 180）。
// 海兽培育室默认开（收成熟 + 排空位），--no-pet 关；间隔 --pet-every（秒，默认 300），
// 品质上限 --pet-max-quality（默认 ORANGE，红配方要 season 2 + 100 万金）。
// 挂机领取默认开（邮件/本段收益/等级奖励/升级），--no-idle 关；间隔 --idle-every（秒，默认 300）。
async function loopCli({
  allowMutate,
  rounds,
  everySeconds,
  allowSpeedUp,
  allowReroll,
  allowPaid,
  useSelectPack = true,
  maxPackPerRound,
  packGapMax,
  pickUpFloaters = false,
  pickEverySeconds = 0,
  farmEnabled = true,
  farmEverySeconds = 120,
  radarEnabled = true,
  radarEverySeconds = 60,
  // 修船门槛（百分数，默认 80）：耐久低于它就把船留在港里修，不派出去打情报。0 = 关。
  radarRepairBelow = 80,
  pirateEnabled = true,
  pirateEverySeconds = 60,
  pirateRepeat = false,
  forgeEnabled = true,
  forgeEverySeconds = 180,
  petEnabled = true,
  petEverySeconds = 300,
  petMaxQuality = 'ORANGE',
  // 材料加速（投喂）：默认开，--no-pet-feed 关。
  petFeed = true,
  idleEnabled = true,
  idleEverySeconds = 300,
  // 贸易港口（建筑「货轮港口」）：3 艘货船逐格交货换 EXP/金币，返航后领藏品奖励。
  cargoEnabled = true,
  cargoEverySeconds = 60,
  // 海商王（每天 10~22 点的港口贸易）：在港就卖、买本港特产、开去「把这件货当紧缺」的港口。
  tradeEnabled = true,
  tradeEverySeconds = 60,
  treasureEnabled = true,
  treasureEverySeconds = 60,
  // 抢哪些货轮等级（多选，3 蓝小型 / 4 紫中型 / 5 橙万吨）；默认只抢万吨。
  treasureColors = DEFAULT_COLORS,
  minPowerRatio = 1.2,
}) {
  const { url, login } = loadCredentials();
  const protocol = loadProtocol();
  const client = new GameClient({ url, protocol });
  client.on('warn', (message) => console.log(`warn: ${message}`));
  client.on('fatal', (info) => console.log(`fatal: ${JSON.stringify(info)}`));

  const stop = { aborted: false };
  const onSigint = () => {
    stop.aborted = true;
    console.log('\n收到 Ctrl-C：本轮结束后退出');
  };
  process.on('SIGINT', onSigint);
  try {
    const response = await client.connect(login);
    const config = loadConfigSafe();
    const player = response.playerInfo;
    console.log(`login ok: ${describeRole(player)?.nickname} lv${describeRole(player)?.level}，${rounds > 0 ? `共 ${rounds} 轮` : '一直跑（Ctrl-C 停）'}，间隔 ${Math.max(5, everySeconds)}s`);
    console.log(`开关: 加速=${allowSpeedUp ? '开(只花' + SPEED_UP_ITEM + ')' : '关'} 拒绝重刷=${allowReroll ? '开' : '关'}`);
    console.log(`拾荒=${pickUpFloaters ? (pickEverySeconds > 0 ? `开(每 ${pickEverySeconds}s 最多一次)` : '开(每轮都试)') : '关'}`);
    console.log(`农田=${farmEnabled ? (farmEverySeconds > 0 ? `开(每 ${farmEverySeconds}s 看一眼)` : '开(每轮都看)') : '关'}`);
    console.log(`情报=${radarEnabled ? (radarEverySeconds > 0 ? `开(每 ${radarEverySeconds}s 扫一次，战力余量 ${minPowerRatio}×` : `开(每轮都看，战力余量 ${minPowerRatio}×`) : '关'}` + (radarEnabled ? `，${radarRepairBelow > 0 ? `耐久<${radarRepairBelow}% 就修` : '不修船'})` : ''));
    console.log(`海盗=${pirateEnabled ? (pirateEverySeconds > 0 ? `开(每 ${pirateEverySeconds}s 讨伐一次，${pirateRepeat ? '含已通关等级' : '只打首杀等级'}，战力余量 ${minPowerRatio}×)` : `开(每轮都讨伐，${pirateRepeat ? '含已通关等级' : '只打首杀等级'}，战力余量 ${minPowerRatio}×)`) : '关'}`);
    console.log(`锻造=${forgeEnabled ? (forgeEverySeconds > 0 ? `开(每 ${forgeEverySeconds}s 看一眼)` : '开(每轮都看)') : '关'}`);
    console.log(`海兽培育=${petEnabled ? (petEverySeconds > 0 ? `开(每 ${petEverySeconds}s 看一眼，品质上限 ${petMaxQuality}，材料加速${petFeed ? '开' : '关'})` : `开(每轮都看，品质上限 ${petMaxQuality}，材料加速${petFeed ? '开' : '关'})`) : '关'}`);
    console.log(`挂机领取=${idleEnabled ? (idleEverySeconds > 0 ? `开(每 ${idleEverySeconds}s 看一眼：邮件/本段收益/等级奖励/升级)` : '开(每轮都看)') : '关'}`);
    console.log(`货轮=${treasureEnabled ? (treasureEverySeconds > 0 ? `开(每 ${treasureEverySeconds}s 抢一次：抢 ${treasureColors.length > 0 ? colorsText(config, treasureColors) : '未勾等级，不派船'}，一天 3 次奖励)` : '开(每轮都抢)') : '关'}`);
    console.log(`贸易港口=${cargoEnabled ? (cargoEverySeconds > 0 ? `开(每 ${cargoEverySeconds}s 看一眼：逐格交货换经验金币 + 返航领奖)` : '开(每轮都看)') : '关'}`);
    console.log(`海商王=${tradeEnabled ? (tradeEverySeconds > 0 ? `开(每 ${tradeEverySeconds}s 跑一段：卖→买特产→起航，指针全用)` : '开(每轮都跑)') : '关'}`);
    await runLoop(client, protocol, {
      config,
      player,
      rounds,
      everyMs: everySeconds * 1000,
      allowMutate,
      allowPaid,
      allowSpeedUp,
      allowReroll,
      useSelectPack,
      maxPackPerRound,
      packGapMax,
      pickUpFloaters,
      pickEveryMs: Math.max(0, Number(pickEverySeconds) || 0) * 1000,
      farmEnabled,
      farmEveryMs: Math.max(0, Number(farmEverySeconds) || 0) * 1000,
      radarEnabled,
      radarEveryMs: Math.max(0, Number(radarEverySeconds) || 0) * 1000,
      radarRepairBelow: Math.min(100, Math.max(0, Number(radarRepairBelow) || 0)),
      pirateEnabled,
      pirateEveryMs: Math.max(0, Number(pirateEverySeconds) || 0) * 1000,
      pirateRepeat,
      forgeEnabled,
      forgeEveryMs: Math.max(0, Number(forgeEverySeconds) || 0) * 1000,
      petEnabled,
      petEveryMs: Math.max(0, Number(petEverySeconds) || 0) * 1000,
      petMaxQuality,
      petFeed,
      idleEnabled,
      idleEveryMs: Math.max(0, Number(idleEverySeconds) || 0) * 1000,
      treasureEnabled,
      treasureEveryMs: Math.max(0, Number(treasureEverySeconds) || 0) * 1000,
      treasureColors,
      minPowerRatio,
      cargoEnabled,
      cargoEveryMs: Math.max(0, Number(cargoEverySeconds) || 0) * 1000,
      tradeEnabled,
      tradeEveryMs: Math.max(0, Number(tradeEverySeconds) || 0) * 1000,
      stop,
      onRound: (summary) => console.log(`\n${formatLoopRound(summary)}`),
      onStep: (entry) => {
        if (entry.phase === 'tasks') {
          if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
          else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
        } else if (entry.phase === 'world' || entry.phase === 'radar' || entry.phase === 'pirate' || entry.phase === 'forge' || entry.phase === 'pet' || entry.phase === 'idle' || entry.phase === 'treasure' || entry.phase === 'cargo' || entry.phase === 'trade') {
          if (entry.skipped) console.log(`  - ${entry.step.label} 跳过: ${entry.error}`);
          else console.log(entry.ok ? `  . ${entry.step.label}` : `  x ${entry.step.label} 失败: ${entry.error}`);
        } else if (entry.skipped) {
          console.log(`  - ${entry.title ?? entry.id} 跳过: ${entry.reason}`);
        } else {
          console.log(entry.ok ? `  . ${entry.title ?? entry.id} ${entry.note ?? ''}` : `  x ${entry.title ?? entry.id} 失败: ${entry.error}`);
        }
      },
    });
  } finally {
    process.off('SIGINT', onSigint);
    client.stop();
  }
}

// 账号管理：列、改名、切换、删除、看凭证。加账号本身要抓包，走
// tools/capture-credentials.mjs 或网页控制台的扫码向导。
async function accountsCli(args) {
  const sub = args.find((arg) => !arg.startsWith('--')) ?? 'list';
  const rest = args.filter((arg) => !arg.startsWith('--') && arg !== sub);
  const store = loadStore();

  const mutate = () => {
    saveStore(store);
    console.log(`已写入 ${ACCOUNTS_PATH}`);
  };

  if (sub === 'list') {
    if (!store.accounts.length) {
      console.log(`还没有任何账号。抓一份凭证：node tools/capture-credentials.mjs`);
      if (fs.existsSync(LEGACY_CREDENTIALS_PATH)) console.log(`（${LEGACY_CREDENTIALS_PATH} 也没读出来）`);
      return;
    }
    for (const [index, account] of store.accounts.entries()) {
      const info = describeAccount(account, { active: account.id === store.activeId });
      const seen = info.lastSeen;
      const tail = seen
        ? `lv${seen.level ?? '?'} 战力${seen.power ?? '?'} 区服${seen.worldId ?? '?'}`
        : '（还没连上过）';
      console.log(`${info.active ? '*' : ' '} ${index + 1}. ${info.title}  ${tail}`);
      console.log(`     openId ${info.id}  凭证抓于 ${info.capturedAt ?? '未知'}`);
    }
    return;
  }

  if (sub === 'use') {
    const account = pickAccount(store, rest[0]);
    if (!account) throw new Error('用法: node src/app.mjs accounts use <id|昵称|序号>');
    setActive(store, account.id);
    mutate();
    console.log(`当前账号: ${describeAccount(account).title}`);
    return;
  }

  if (sub === 'label') {
    const account = pickAccount(store, rest[0]);
    if (!account || !rest[1]) throw new Error('用法: node src/app.mjs accounts label <id|昵称|序号> <新名字>');
    account.label = rest[1];
    mutate();
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const account = pickAccount(store, rest[0]);
    if (!account) throw new Error('用法: node src/app.mjs accounts remove <id|昵称|序号>');
    removeAccount(store, account.id);
    mutate();
    console.log(`已删除 ${describeAccount(account).title}（原文件里的凭证会一起没掉）`);
    return;
  }

  if (sub === 'show') {
    const account = pickAccount(store, rest[0]);
    if (!account) throw new Error('用法: node src/app.mjs accounts show <id|昵称|序号>');
    console.log(JSON.stringify(revealAccount(account), null, 2));
    return;
  }

  throw new Error(`未知子命令 ${sub}。可用: list / use / label / remove / show`);
}

async function main() {
  const mode = process.argv[2] || 'console';

  if (mode === 'selftest') {
    await import('./selftest.mjs');
    return;
  }

  if (mode === 'accounts') {
    await accountsCli(process.argv.slice(3));
    return;
  }

  if (mode === 'connect') {
    await headless({ seconds: Number(process.argv[3] ?? 60) });
    return;
  }

  if (mode === 'probe') {
    await headless({ seconds: 0 });
    return;
  }

  if (mode === 'actions') {
    for (const action of listActions()) {
      const params = action.params.length ? ` <${action.params.join('> <')}>` : '';
      console.log(`${action.mutate ? '改状态' : '只读'}  ${action.id}${params}`);
      console.log(`        ${action.request} — ${action.desc}`);
    }
    return;
  }

  if (mode === 'act') {
    const id = process.argv[3];
    if (!id) throw new Error('usage: node src/app.mjs act <actionId> [k=v ...]');
    const params = {};
    for (const token of process.argv.slice(4).filter((arg) => !arg.startsWith('--'))) {
      const at = token.indexOf('=');
      if (at < 0) throw new Error(`parameter must be k=v, got: ${token}`);
      params[token.slice(0, at)] = token.slice(at + 1);
    }
    await act({
      id,
      params,
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'config') {
    const config = getConfig();
    const name = process.argv[3];
    if (!name) {
      console.log(`本地配置表 ${config.names.length} 张:`);
      console.log(config.names.join(', '));
      return;
    }
    const table = config.tables[name];
    if (!table) throw new Error(`没有配置表 ${name}`);
    console.log(JSON.stringify(table, null, 1));
    return;
  }

  if (mode === 'loot') {
    await loot({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'heroes') {
    await heroes({
      dryRun: process.argv.includes('--dry'),
      allowUniversal: !process.argv.includes('--no-universal'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'dailies') {
    await dailies({
      dryRun: process.argv.includes('--dry'),
      allowPaid: process.argv.includes('--paid'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'loop') {
    // 非数字必须回退默认值：`--rounds abc` 会让 rounds 变 NaN 而被当成「一直跑」，
    // `--every abc` 则让 setTimeout(NaN) 退化成 1ms 间隔的高频轰炸。
    const at = (name, fallback) => {
      const i = process.argv.indexOf(name);
      const raw = i >= 0 ? process.argv[i + 1] : undefined;
      if (raw === undefined || raw === '') return fallback;
      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    };
    await loopCli({
      rounds: at('--rounds', 1),
      everySeconds: at('--every', 60),
      allowSpeedUp: process.argv.includes('--speed-up'),
      allowReroll: process.argv.includes('--reroll'),
      allowPaid: process.argv.includes('--paid'),
      useSelectPack: !process.argv.includes('--no-pack'),
      maxPackPerRound: numericArg('--max-pack'),
      // 无需求配方的兑包门槛（个包）：默认不设限（工厂无时无刻都在制造），0 = 关掉。
      packGapMax: numericArg('--pack-gap'),
      pickUpFloaters: process.argv.includes('--pick'),
      pickEverySeconds: at('--pick-every', 0),
      farmEnabled: !process.argv.includes('--no-farm'),
      farmEverySeconds: at('--farm-every', 120),
      radarEnabled: !process.argv.includes('--no-radar'),
      radarEverySeconds: at('--radar-every', 60),
      // 修船门槛（百分数）：--repair-below 80 默认（--radar-repair 是旧别名）；
      // 0 = 不修船（耐久再低也照派）。
      radarRepairBelow: at('--repair-below', at('--radar-repair', 80)),
      pirateEnabled: !process.argv.includes('--no-pirate'),
      pirateEverySeconds: at('--pirate-every', 60),
      // 默认只打「没打过的下一个等级」，--pirate-repeat 才刷已通关的。
      pirateRepeat: process.argv.includes('--pirate-repeat'),
      forgeEnabled: !process.argv.includes('--no-forge'),
      forgeEverySeconds: at('--forge-every', 180),
      petEnabled: !process.argv.includes('--no-pet'),
      petEverySeconds: at('--pet-every', 300),
      // --pet-max-quality BLUE|PURPLE|ORANGE|RED；脏值回退默认橙。
      petMaxQuality: PET_QUALITIES.includes(valueArg('--pet-max-quality')) ? valueArg('--pet-max-quality') : 'ORANGE',
      // 材料加速（投喂）默认开，--no-pet-feed 关。
      petFeed: !process.argv.includes('--no-pet-feed'),
      idleEnabled: !process.argv.includes('--no-idle'),
      idleEverySeconds: at('--idle-every', 300),
      treasureEnabled: !process.argv.includes('--no-treasure'),
      treasureEverySeconds: at('--treasure-every', 60),
      // --treasure-colors 3,5 = 小型+万吨；不给就是默认（只抢万吨）。
      treasureColors: valueArg('--treasure-colors')
        ? colorsOf(valueArg('--treasure-colors').split(/[,，\s]+/))
        : DEFAULT_COLORS,
      minPowerRatio: numericArg('--power-ratio') ?? DEFAULT_MIN_POWER_RATIO,
      // 贸易港口：--no-cargo 关，--cargo-every 秒（默认 60）。
      cargoEnabled: !process.argv.includes('--no-cargo'),
      cargoEverySeconds: at('--cargo-every', 60),
      // 海商王：--no-trade 关，--trade-every 秒（默认 60）。
      tradeEnabled: !process.argv.includes('--no-trade'),
      tradeEverySeconds: at('--trade-every', 60),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  // 临时验证：node src/app.mjs autofarm [--yes] [--off] [--wait 秒]
  if (mode === 'autofarm') {
    await autofarm({
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
      turnOn: !process.argv.includes('--off'),
      waitSeconds: numericArg('--wait') ?? 8,
    });
    return;
  }

  if (mode === 'field') {
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith('--'));
    const fleetsAt = process.argv.findIndex((arg) => arg === '--fleets');
    await field({
      sub: args[0] ?? null,
      gridIdx: args[1] ?? null,
      fleets: fleetsAt >= 0 ? process.argv[fleetsAt + 1] : null,
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'world') {
    await world({
      dryRun: process.argv.includes('--dry'),
      allowSpeedUp: process.argv.includes('--speed-up'),
      allowReroll: process.argv.includes('--reroll'),
      useSelectPack: !process.argv.includes('--no-pack'),
      maxPackPerRound: numericArg('--max-pack'),
      // 无需求配方的兑包门槛（个包）：默认不设限（工厂无时无刻都在制造），0 = 关掉。
      packGapMax: numericArg('--pack-gap'),
      pickUpFloaters: process.argv.includes('--pick'),
      farm: !process.argv.includes('--no-farm'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'radar') {
    await radar({
      dryRun: process.argv.includes('--dry'),
      // 战力余量：默认 1.2（舰队战力要比敌方高 20% 才派），--power-ratio 可改。
      minPowerRatio: numericArg('--power-ratio') ?? DEFAULT_MIN_POWER_RATIO,
      maxDispatch: numericArg('--max') ?? Infinity,
      // 修船门槛（百分数，默认 80）：耐久低于它就把船留在港里修，不派出去。
      // --repair-below 0 = 关掉修船。
      repairBelowPercent: numericArg('--repair-below') ?? 80,
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'pirates') {
    await pirateCli({
      dryRun: process.argv.includes('--dry'),
      // 战力余量沿用情报那个参数名，省得记两套。
      minPowerRatio: numericArg('--power-ratio') ?? DEFAULT_MIN_POWER_RATIO,
      maxPerRound: numericArg('--max') ?? Infinity,
      // 默认只打首杀等级（没打过的下一个级别），--repeat 才刷已通关的。
      repeat: process.argv.includes('--repeat'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'treasure') {
    // --colors 3,4,5 是多选（3 蓝小型 / 4 紫中型 / 5 橙万吨）；只给 --min-color 时按「≥ 该等级」换算，
    // 保留旧用法不报错。两个都不给 = 默认只抢万吨（DEFAULT_COLORS）。
    const minColor = numericArg('--min-color');
    const colorsArg = valueArg('--colors');
    const colors = colorsArg
      ? colorsOf(colorsArg.split(/[,，\s]+/))
      : (minColor != null ? colorsOf([3, 4, 5].filter((color) => color >= minColor)) : DEFAULT_COLORS);
    await treasureCli({
      dryRun: process.argv.includes('--dry'),
      // 一次最多派几支舰队。
      maxFleets: numericArg('--max') ?? DEFAULT_MAX_FLEETS,
      colors,
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'forge') {
    await forge({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'pet') {
    await petCli({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
      maxQuality: PET_QUALITIES.includes(valueArg('--pet-max-quality')) ? valueArg('--pet-max-quality') : 'ORANGE',
      // 材料加速默认开，--no-pet-feed 关。
      allowFeed: !process.argv.includes('--no-pet-feed'),
    });
    return;
  }

  if (mode === 'cargo') {
    await cargoCli({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'trade') {
    await tradeCli({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
      allowSpeed: !process.argv.includes('--no-speed'),
    });
    return;
  }

  if (mode === 'idle') {
    await idleCli({      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'tasks') {
    await tasks({
      dryRun: process.argv.includes('--dry'),
      allowMutate: process.env.CW_ALLOW_MUTATE === '1' || process.argv.includes('--yes'),
    });
    return;
  }

  if (mode === 'state') {
    // --out 是**带值**参数，不能只判 includes：那样 `state --out mydump.json` 会静默写到
    // data/state.json，用户给的路径被丢掉也不报错。
    const outArg = valueArg('--out');
    await state({
      raw: process.argv.includes('--raw'),
      out: process.env.CW_STATE_OUT ?? outArg ?? (process.argv.includes('--out') ? 'data/state.json' : null),
    });
    return;
  }

  if (mode === 'worlds') {
    const arg = process.argv[3];
    // 开关（--group / --dry）也会落在 argv[3]，不能直接 Number()：`worlds --group`
    // 会得到 NaN 并被当成 worldId 再登录一次，可能顶号、甚至在没角色的服上建号。
    const wanted = arg && !arg.startsWith('--') && arg !== 'all' ? Number(arg) : null;
    await worlds({
      worldId: Number.isFinite(wanted) ? wanted : null,
      group: process.argv.includes('--group'),
      seconds: Number(process.env.CW_WORLD_HOLD ?? 0),
    });
    return;
  }

  const port = Number(process.env.CW_PORT ?? 17321);
  const console_ = createConsole({ port });
  const url = await console_.listen();
  const browser = process.env.CW_NO_BROWSER ? null : openBrowser(url);
  console.log(`console: ${url}${browser ? ` (via ${browser})` : ''}`);
  const store = loadStore();
  if (!store.accounts.length) {
    console.log(`还没有账号：打开 ${url} 用「账号」页扫码添加，或跑 node tools/capture-credentials.mjs`);
  } else {
    console.log(`账号 ${store.accounts.length} 个，当前: ${describeAccount(pickAccount(store, null)).title}`);
  }
}

main().catch((error) => {
  console.error(process.env.CW_DEBUG ? error : error.message);
  process.exitCode = 1;
});
