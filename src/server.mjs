import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GameClient } from './client.mjs';
import { attach, ARCHIVE_ROOT, dayOf, listDays, summarizeDay, appendConsole } from './archive.mjs';
import { loadProtocol } from './proto.mjs';
import { PAGE } from './page.mjs';
import { listWorlds, enterWorld, describeRole } from './worlds.mjs';
import { collectState, summarize, formatState } from './game.mjs';
import { getConfig, APPID } from './config.mjs';
import { qrSvg } from './vendor/qrcode.mjs';
import { planHeroes, runHeroPlan, formatHeroPlan } from './heroes.mjs';
import { surveyDailies, runDailies, formatSurvey } from './dailies.mjs';
import { surveyTasks, runTasks, formatTaskPlan } from './tasks.mjs';
import { surveyWorld, planWorld, runWorld, formatWorldPlan, formatFieldReport, loadMapAsset, summarizeFloaters, formatFloaters, materialGroups } from './world.mjs';
import { runLoop, formatLoopRound } from './loop.mjs';
import { surveyRadar, viewRadar, planRadar, formatRadarPlan, DEFAULT_MIN_POWER_RATIO } from './radar.mjs';
import { surveyEquip, planEquip, formatEquipPlan } from './equip.mjs';
import { surveyPet, planPet, formatPetPlan, PET_QUALITIES } from './pet.mjs';
import { surveyIdle, planIdle, runIdle, formatIdleSummary } from './idle.mjs';
import { surveyTreasure, viewTreasure, planTreasure, formatTreasureSummary, formatTreasurePlan, DEFAULT_MAX_FLEETS, DEFAULT_COLORS, colorsOf, colorsText } from './treasure.mjs';
import { surveyFactories, viewFactories, factoryRecipes, startProduce, gainAllProducts } from './factories.mjs';
import { runAction } from './actions.mjs';
import { loadStore, saveStore, upsertAccount, removeAccount, setActive, pickAccount, describeAccount, revealAccount, DATA_DIR } from './accounts.mjs';
import { startCapture, stopCapture, captureState, DEFAULT_PROXY_PORT } from './capture.mjs';
import { iconIndex, atlasFile, itemIcon, resourceIcon, materialIcon, heroIcon, heroCard, buildingIcon } from './art.mjs';

const LOG_LIMIT = 400;
// 新开的页面先回放这么多条：SSE 只推增量，不回放的话刷新一次日志窗口就是空的，
// 而「刷新前那一分钟发生了什么」往往正是要看的。前端按 t|message 去重，重连不会出双行。
const LOG_REPLAY = 100;
// 协议帧不再进界面，但仍然要能事后查：时序流水在 data/protocol.log，
// 完整回包按接口分文件存在 data/responses/<日期>/，人话的运行记录在 data/console/<日期>.log
// —— 三套都由 archive.mjs 负责。

const STATE_TEXT = {
  IDLE: '未连接',
  CONNECTING: '连接中',
  READY: '已连接',
  FAILED: '连接失败',
  REJECTED: '服务器拒绝登录',
  CLOSED: '连接已断开',
  STOPPED: '已停止',
};

export function createConsole({ host = '127.0.0.1', port = 17321 }) {
  const protocol = loadProtocol();
  const globalLog = [];
  const streams = new Set();
  const sessions = new Map();

  const logLimit = (list) => {
    while (list.length > LOG_LIMIT) list.shift();
  };

  // 某个连接该看到哪些条目：不带 account 的全局消息谁都看，带 account 的只看自己那一路。
  const visible = (entry, account) => !account || entry.account === null || entry.account === account;

  function emit(session, level, message, extra) {
    const t = Date.now();
    const entry = { t, level, message, extra, account: session?.id ?? null };
    const list = session ? session.log : globalLog;
    list.push(entry);
    logLimit(list);
    // 内存只留 400 条、刷新就清空，所以每条都同步落盘一份：
    // 事后要回看「那一轮为什么跳过这一步」，协议流水答不了，只有这行中文能答。
    appendConsole({ t, level, message, account: entry.account, extra });
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of streams) {
      if (!visible(entry, res.account)) continue;
      res.write(payload);
    }
    return entry;
  }

  // 协议层细节（帧、序号、字节数、原始 JSON）只落盘，不进运行记录：
  // 归档在 wire() 里统一挂上，这里没有 trace 函数了。

  function newSession(id) {
    return {
      id,
      client: null,
      player: null,
      busy: null,
      log: [],
      loop: {
        running: false,
        rounds: 0,
        completed: 0,
        everyMs: 60_000,
        // 拾荒的间隔（0 = 不限制，每轮都试）。潜水已移除，这里只剩拾荒。
        pickEveryMs: 0,
        lastPickAt: null,
        // 农田开关与间隔：作物最快 30 分钟成熟，没必要每轮都探测，默认 2 分钟看一次。
        farmEnabled: true,
        farmEveryMs: 120_000,
        lastFarmAt: null,
        // 联盟情报：默认开，派兵前要求舰队战力 ≥ 敌方 × minPowerRatio（战败掉耐久）。
        // 探测 + 领奖 + 派兵按自己的间隔跑（默认 60 秒），没到点整段跳过。
        radarEnabled: true,
        radarEveryMs: 60_000,
        lastRadarAt: null,
        // 装备厂（锻造）：造好了收取 + 按部位均衡排下一件。一件蓝装 25 分钟上下，
        // 所以默认 3 分钟看一眼；造好不收 = 整座工厂停产，比农田更值得勤看。
        forgeEnabled: true,
        forgeEveryMs: 180_000,
        lastForgeAt: null,
        // 海兽培育室：收成熟的 + 队列空位排产。蓝配方 4 小时、橙 36 小时，5 分钟看一次足够。
        // petMaxQuality 是品质上限（默认橙）：红要 season 2 + 100 万金，常态打不开。
        petEnabled: true,
        petEveryMs: 300_000,
        lastPetAt: null,
        petMaxQuality: 'ORANGE',
        // 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级）：收益 8 小时封顶、等级奖励是按级一次，
        // 都是小时级节奏，所以默认 5 分钟看一眼，不必每轮多打 3 个请求。
        idleEnabled: true,
        idleEveryMs: 300_000,
        lastIdleAt: null,
        // 搁浅的货轮（世界宝藏）：整点刷新、一天 3 次奖励，抢的是刷新后那几十秒，
        // 所以给最短的间隔（默认 60 秒）。它排在情报前面先挑空闲舰队。
        treasureEnabled: true,
        treasureEveryMs: 60_000,
        lastTreasureAt: null,
        treasureMaxFleets: DEFAULT_MAX_FLEETS,
        // 抢哪些等级（多选，3 蓝小型 / 4 紫中型 / 5 橙万吨）：默认只抢万吨。
        treasureColors: [...DEFAULT_COLORS],
        minPowerRatio: DEFAULT_MIN_POWER_RATIO,
        stop: { aborted: false },
        history: [],
        error: null,
      },
    };
  }

  function sessionFor(id) {
    if (!sessions.has(id)) sessions.set(id, newSession(id));
    return sessions.get(id);
  }

  function wire(session, instance) {
    // 出站 body 与完整回包都交给 archive：protocol.log 只留业务帧（心跳/序号确认不进），
    // data/responses/<日期>/<消息名>.jsonl 存全量不截断。tag 用账号前 8 位，和日志前缀一致。
    attach(instance, { tag: session.id.slice(0, 8) });
    instance.on('state', ({ state, detail }) => emit(session, 'state', STATE_TEXT[state] ?? state, detail ? { detail } : undefined));
    instance.on('drop', ({ name, reason }) => emit(session, 'warn', `漏收了一条 ${name} 的应答（${reason}），本轮跳过`));
    instance.on('warn', (message) => emit(session, 'warn', message === 'ping timeout' ? '服务器心跳超时，连接可能已经断了' : message));
    instance.on('fatal', ({ reason }) => emit(session, 'error', reason === 'SCChannelExpired' ? '这个账号在别处登录了，本条连接被顶掉' : `连接被服务器中断（${reason}）`));
    instance.on('error', (error) => emit(session, 'error', error.message));
    instance.on('close', () => emit(session, 'state', '连接已断开'));
  }

  // 每次连接把服务端给的昵称/等级/区服写回账号文件，账号列表里就能看到人话标记。
  function persistIdentity(account, player) {
    try {
      const store = loadStore();
      const target = store.accounts.find((entry) => entry.id === account.id);
      if (!target) return;
      const role = describeRole(player);
      target.lastSeen = { nickname: role?.nickname ?? null, level: role?.level ?? null, power: role?.power ?? null, worldId: role?.worldId ?? null, at: new Date().toISOString() };
      if (!target.label && role?.nickname) target.label = role.nickname;
      saveStore(store);
    } catch {
      /* 回填失败不影响连接 */
    }
  }

  async function connect(session, account) {
    if (session.client?.connected) throw new Error('这个账号已经连上了');
    const client = new GameClient({ url: account.url, protocol });
    wire(session, client);
    session.client = client;
    session.player = null;
    const response = await client.connect(account.login);
    session.player = response.playerInfo || null;
    persistIdentity(account, session.player);
    const role = describeRole(session.player);
    emit(session, 'info', `已进入游戏：${role?.nickname ?? '未知'} lv${role?.level ?? '?'}`);
    return { url: account.url, result: response.result, initSeqNo: response.initSeqNo, playerInfo: session.player };
  }

  async function ensureConnected(session, account) {
    if (session.client?.connected) return session.client;
    await connect(session, account);
    return session.client;
  }

  // 每个请求都带 ?account=<id>；不给就是当前选中的那个账号。
  function resolve(url) {
    const store = loadStore();
    const account = pickAccount(store, url.searchParams.get('account'));
    if (!account) throw new Error('还没有任何账号，先在「账号」页添加一个');
    return { store, account, session: sessionFor(account.id) };
  }

  function accountStatus(session) {
    return {
      connected: Boolean(session.client?.connected),
      state: session.client?.snapshot?.().state ?? 'IDLE',
      busy: session.busy,
      looping: session.loop.running,
    };
  }

  function loadConfigSafe() {
    try {
      return getConfig();
    } catch {
      return null;
    }
  }

  // ---- 只读汇总 -------------------------------------------------------------

  async function overview(session, account) {
    const instance = await ensureConnected(session, account);
    const { ok, failed } = await collectState(instance, protocol, { timeout: 15000 });
    const config = loadConfigSafe();
    const view = summarize({ ok }, { config });
    const daily = view.daily;
    // 仓库材料：从完整道具清单里按名字取数量（view.items.top 只留了前 12 个，不够用）。
    // 工厂产品 158 种，只传仓库里真有的，并按数量降序 —— 这一栏是给人看的，不是图鉴。
    const stock = new Map((Array.isArray(ok.AllItemRequest?.items) ? ok.AllItemRequest.items : [])
      .map((item) => [item.itemId, item.num]));
    const materials = materialGroups(config)
      .map((group) => {
        const owned = group.items.map((id) => ({ id, num: stock.get(id) ?? 0 }));
        const kept = group.onlyOwned
          ? owned.filter((item) => item.num > 0).sort((a, b) => b.num - a.num)
          : owned;
        return {
          key: group.key,
          name: group.name,
          onlyOwned: group.onlyOwned === true,
          items: kept.map((item) => ({ ...item, icon: itemIcon(item.id) })),
        };
      })
      .filter((group) => group.items.length > 0);
    return {
      account: describeAccount(account, { active: account.id === loadStore().activeId }),
      status: accountStatus(session),
      player: describeRole(session.player),
      resources: view.resources.map((entry) => ({ ...entry, icon: resourceIcon(entry.res) })),
      items: {
        ...view.items,
        top: view.items.top.map((item) => ({ itemId: item.itemId, num: item.num, icon: itemIcon(item.itemId) })),
      },
      materials,
      claimable: {
        mainTask: view.mainTask ? 1 : 0,
        daily: daily?.claimable ?? 0,
        achievement: view.achievements?.claimable ?? 0,
        email: view.email?.unclaimed ?? 0,
        afk: view.afk ? Math.max((view.afk.level ?? 0) - (view.afk.rewardedLevel ?? 0), 0) : 0,
      },
      afk: view.afk,
      heroes: {
        count: view.heroes.count,
        power: view.heroes.power,
        list: view.heroes.list.slice(0, 12).map((hero) => ({ ...hero, icon: heroCard(hero.heroId) ?? heroIcon(hero.heroId) })),
      },
      water: view.water,
      resFields: view.resFields,
      monthCard: view.monthCard,
      unreadable: Object.keys(failed),
      text: formatState(view),
    };
  }

  async function tasks(session, account) {
    const instance = await ensureConnected(session, account);
    const survey = await surveyTasks(instance, protocol, { config: loadConfigSafe() });
    return { ...survey, text: formatTaskPlan(survey) };
  }

  async function world(session, account, { pickUpFloaters = false, farm = true } = {}) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyWorld(instance, protocol, { config, player: session.player });
    const plan = planWorld(survey, { config, pickUpFloaters, farm });
    let map = null;
    try {
      map = loadMapAsset(Number(session.player?.scenarioId ?? 0));
    } catch {
      map = null;
    }
    const fields = { ...survey.resFields, text: formatFieldReport(survey, map) };
    return {
      population: `${survey.population}/${survey.maxPopulation}`,
      factories: survey.factories.map((b) => ({ buildingId: b.buildingId, type: b.type, level: b.level, queue: (b.factory.factoryQ ?? []).length, auto: b.factory.autoProductId ?? null, icon: buildingIcon(b.type) })),
      orders: survey.orders.map((order) => ({
        ...order,
        requirements: order.requirements.map((need) => ({ ...need, icon: materialIcon(need.id) })),
        missing: (order.missing ?? []).map((need) => ({ ...need, icon: materialIcon(need.id) })),
      })),
      // 建筑全表：level=0 的是空位（正在盖或还没盖），界面靠它解释「为什么没在建造」。
      buildings: survey.buildings.map((b) => ({
        buildingId: b.buildingId, type: b.type ?? null, level: b.level,
        building: b.buildFinishTime > 0 && b.buildFinishTime > Date.now() / 1000,
        icon: buildingIcon(b.type),
      })),
      // 农田单独一栏：成熟与否决定「收」还是「等」，空着则要播种。
      farms: survey.buildings.filter((b) => b.farm).map((b) => ({
        buildingId: b.buildingId,
        icon: buildingIcon(b.type),
        productId: b.farm.productId || null,
        ripeAt: b.farm.ripeAt || 0,
        remainSeconds: Math.max(0, (b.farm.ripeAt || 0) - (survey.now || 0)),
        ripe: Boolean(b.farm.productId) && b.farm.ripeAt > 0 && b.farm.ripeAt <= (survey.now || 0),
        idle: !b.farm.productId,
        cropIcon: b.farm.productId ? materialIcon(b.farm.productId) : null,
      })),
      autoFarming: survey.autoFarming === true,
      stock: [...survey.stock].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, num_]) => ({ id, num: num_, icon: materialIcon(id) })),
      resFields: fields,
      plan: plan.actions,
      notes: [...survey.notes, ...plan.notes],
      text: formatWorldPlan(survey, plan),
    };
  }

  // 工厂页：所有工厂 + 队列（含剩余秒数）+ 每个工厂这个等级能造的配方（够不够材料都算好）。
  async function factory(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyFactories(instance, protocol, { config });
    const view = viewFactories(survey, { config });
    return {
      ...view,
      factories: view.factories.map((entry) => ({
        ...entry,
        icon: buildingIcon(entry.type),
        queue: entry.queue.map((job) => ({ ...job, icon: itemIcon(job.productId) })),
        finished: entry.finished.map((asset) => ({ ...asset, icon: itemIcon(asset.id) })),
        recipes: entry.recipes.map((recipe) => ({
          ...recipe,
          icon: itemIcon(recipe.itemId),
          costs: recipe.costs.map((cost) => ({ ...cost, icon: itemIcon(cost.id) })),
        })),
      })),
    };
  }

  // 联盟情报：只读视图（事件 + 舰队 + 计划）。真正的派兵走 /api/radar/run。
  // 舰队 id 形如「1远征船」，去掉前缀数字就是建筑类型，拿来取图标。
  async function radar(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyRadar(instance, protocol, { config });
    const ratio = Number(session.loop.minPowerRatio) || DEFAULT_MIN_POWER_RATIO;
    const view = viewRadar(survey, { config, minPowerRatio: ratio });
    const plan = planRadar(view, { minPowerRatio: ratio });
    const fleetIcon = (buildingId) => buildingIcon(String(buildingId).replace(/^\d+[A-Z]?/, ''));
    return {
      level: view.level,
      exp: view.exp,
      storedNum: view.storedNum,
      nextRefreshTime: view.nextRefreshTime,
      petrol: view.petrol,
      bestIdlePower: view.bestIdlePower,
      minPowerRatio: ratio,
      fleets: view.fleets.map((fleet) => ({ ...fleet, icon: fleetIcon(fleet.buildingId) })),
      events: view.events.map((event) => ({
        ...event,
        reward: (event.reward ?? []).map((asset) => ({ ...asset, icon: materialIcon(asset.id) })),
      })),
      plan: plan.actions,
      notes: plan.notes,
      text: formatRadarPlan(view, plan),
    };
  }

  // 装备厂（锻造）：读装备厂 + 背包，算「收哪件、造哪件」。只读视图，真正的写走 /api/forge/run。
  async function forge(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyEquip(instance, protocol, { config });
    const plan = planEquip(survey, { config });
    return {
      building: survey.building,
      making: survey.making,
      counts: survey.counts,
      bagCount: survey.bag.length,
      actions: plan.actions,
      notes: plan.notes,
      text: formatEquipPlan(survey, plan),
    };
  }

  // 海兽培育室：读队列 + 库存，算「收哪几只、空位排什么」。只读视图，真正的写走 /api/pet/run。
  async function pet(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyPet(instance, protocol, { config });
    const plan = planPet(survey, { config, maxQuality: session.loop.petMaxQuality });
    return {
      buildings: survey.buildings.map((building) => ({
        buildingId: building.buildingId,
        level: building.level,
        maxQ: building.maxQ,
        jobs: building.jobs.length,
        mature: building.mature.length,
      })),
      mature: survey.mature.map((entry) => ({ petId: entry.petId, star: entry.star })),
      jobs: survey.jobs.map((job) => ({
        buildingId: job.buildingId,
        idx: job.idx,
        petId: job.petId,
        star: job.star,
        remainSeconds: job.remainSeconds,
        done: job.done,
      })),
      maxQ: survey.maxQ,
      maxQuality: session.loop.petMaxQuality,
      actions: plan.actions.map((step) => ({ kind: step.kind, label: step.label })),
      notes: plan.notes,
      text: formatPetPlan(survey, plan),
    };
  }

  // 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级）：只读视图，真正的领取走 /api/idle/run。
  async function idle(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyIdle(instance, protocol, { config, player: session.player });
    const plan = planIdle(survey, { config });
    const pending = plan.actions.map((step) => step.label);
    return {
      afk: survey.afk,
      mail: survey.mail,
      levelReward: survey.levelReward,
      upgrade: survey.upgrade,
      actions: plan.actions.map((step) => ({ kind: step.kind, label: step.label })),
      notes: plan.notes,
      text: formatIdleSummary(survey) + (pending.length ? `\n待领：${pending.join('、')}` : '\n没有可领的（等下一段封顶/新邮件）'),
    };
  }

  // 搁浅的货轮（世界宝藏）：只读视图 + 派兵计划，真正的派兵走 /api/treasure/run。
  // 单独跑（不经过循环）时要自己拉库存 —— 只为了那个汽油数。
  // 等级选择与派船数都取 session.loop 里的当前配置：页面上勾的等级，
  // 「立刻抢一次」和面板必须跟挂机里那套完全一致，否则同一份设置有两种行为。
  async function treasure(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const colors = colorsOf(session.loop.treasureColors);
    const maxFleets = session.loop.treasureMaxFleets;
    const survey = await surveyTreasure(instance, protocol, { config, player: session.player });
    const view = viewTreasure(survey, { config, colors, maxFleets });
    const plan = planTreasure(view, { maxFleets });
    return {
      // 活动有效期：页面直接据此显示「还有多久到期 / 已结束」。
      activity: view.activity,
      dailyLimit: view.dailyLimit,
      todayRewardTimes: view.todayRewardTimes,
      remainingRewards: view.remainingRewards,
      dailyFull: view.dailyFull,
      nextRefreshTime: view.nextRefreshTime,
      petrol: view.petrol,
      petrolCost: view.petrolCost,
      colors: view.colors,
      colorText: view.colorText,
      maxFleets: view.maxFleets,
      treasures: view.treasures.map((one) => ({
        uid: one.uid,
        name: one.name,
        color: one.color,
        progress: one.progress,
        ownerGuildIdx: one.ownerGuildIdx,
        ownerFleetNum: one.ownerFleetNum,
        ourFleets: one.ourFleets,
        free: one.free,
        levelOk: one.levelOk,
        rank: one.rank,
        claimable: one.claimable,
        gridIdx: one.gridIdx,
        rewardText: one.rewardText,
      })),
      fleets: view.fleets,
      actions: plan.actions.map((step) => ({ kind: step.kind, label: step.label })),
      notes: plan.notes,
      text: formatTreasureSummary(view) + `\n${formatTreasurePlan(view, plan)}`,
    };
  }

  async function heroes(session, account) {
    const instance = await ensureConnected(session, account);
    const heroList = await instance.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
    const itemList = await instance.request('AllItemRequest', {}, 'AllItemResponse', 15000);
    const counts = new Map();
    for (const item of itemList.items ?? []) {
      const id = item.itemId ?? item.id;
      counts.set(id, (counts.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
    }
    const config = loadConfigSafe();
    if (!config) throw new Error('没有配置表，算不出英雄养成计划');
    const plan = planHeroes({ config, heroes: heroList.heroes ?? [], itemNum: (id) => counts.get(id) ?? 0, playerLevel: describeRole(session.player)?.level ?? 1 });
    return {
      steps: plan.steps,
      notes: plan.notes,
      maxLevel: plan.maxLevel,
      maxStar: plan.maxStar,
      text: formatHeroPlan(plan),
      heroes: (heroList.heroes ?? []).map((hero) => ({ ...hero, icon: heroCard(hero.heroId), head: heroIcon(hero.heroId) })),
    };
  }

  async function dailies(session, account) {
    const instance = await ensureConnected(session, account);
    const survey = await surveyDailies(instance, protocol, { config: loadConfigSafe(), player: session.player });
    return { tasks: survey.tasks.map((entry) => ({ ...entry, task: { ...entry.task } })), chests: survey.chests, gift: survey.gift, ruby: survey.ruby, text: formatSurvey(survey) };
  }

  // ---- 抓包与扫码 -----------------------------------------------------------

  // 二维码只负责把游戏在电脑上拉起来，凭证还是靠本机代理抓。
  // 优先级：用户自己放的 data/qrcode.png → 微信官方的跳转链接画成码 → 页面上只留手动步骤。
  function qrInfo() {
    if (fs.existsSync(path.join(DATA_DIR, 'qrcode.png'))) {
      return { kind: 'image', url: '/api/capture/qrcode', note: '用的是你放在 data/qrcode.png 的小程序码' };
    }
    const scheme = `weixin://dl/business/?appid=${APPID}&env_version=release`;
    const content = `https://servicewechat.com/wxascheme/jump_wxa?url=${encodeURIComponent(scheme)}`;
    const note = '手机扫一下，让微信把游戏在电脑上打开；扫不动就复制链接，或按下面的步骤手动开';
    try {
      return { kind: 'svg', svg: qrSvg(content, { scale: 4 }), content, note };
    } catch (error) {
      return { kind: 'link', content, note: `二维码画不出来（${error.message}），复制链接或按下面的步骤手动开游戏` };
    }
  }

  // 抓到登录包就落库；顺手连一次把昵称/等级/区服回填，账号列表才看得到人话。
  async function addCapturedAccount({ url, body, rawFrameHex }) {
    const credential = { url, login: body, loginFrameHex: rawFrameHex, source: 'mitm', capturedAt: new Date().toISOString() };
    const store = loadStore();
    const { account, created } = upsertAccount(store, credential);
    saveStore(store);
    const title = describeAccount(account).title;
    emit(null, 'info', created ? `新账号已入库：${title}` : `账号凭证已刷新：${title}`);

    const session = sessionFor(account.id);
    try {
      await connect(session, account);
      emit(null, 'info', `${title} 的角色信息已读取（游戏那边会被顶下线一次，重进即可）`);
      session.client?.stop();
      session.client = null;
      session.player = null;
    } catch (error) {
      emit(null, 'warn', `读取角色信息失败，账号本身已经存好了：${error.message}`);
    }
    await stopCapture('已抓到账号');
    return { id: account.id };
  }

  // ---- 路由 -----------------------------------------------------------------

  async function handle(req, res, body) {
    const parsed = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${parsed.pathname}`;
    const json = (value, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const jsonBody = () => JSON.parse(body || '{}');
    const needConfirm = (payload) => {
      if (payload.confirm !== true) throw new Error('这个操作会改动游戏里的状态，需要先确认');
    };
    const longRunning = /^(GET|POST) \/api\/(heroes|dailies|tasks|world|overview|loop|factory)(\/|$)/.test(route);
    let scoped = null;
    // 所有账号相关的路由都先过这里：拿到账号、对应会话，长请求再挂个忙碌标记。
    const scoped_ = (url) => {
      const found = resolve(url);
      scoped = found.session;
      if (longRunning) found.session.busy = route;
      return found;
    };
    try {
      if (route === 'GET /') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (route === 'GET /api/art/index') {
        json(iconIndex());
        return;
      }
      // 图标是游戏自己的贴图，从 FairyGUI 图集里按图集页整张给出去，裁切交给浏览器。
      if (route.startsWith('GET /api/art/atlas/')) {
        const [, , , , bundle, file] = route.split('/').map((part) => decodeURIComponent(part));
        const found = atlasFile(bundle, file);
        if (!found) {
          json({ error: 'not found' }, 404);
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(fs.readFileSync(found));
        return;
      }
      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.account = parsed.searchParams.get('account');
        // 先回放再登记到 streams：反过来的话，回放期间新冒出来的条目会抢在旧条目前面推送。
        // 切账号时前端会先 clear，所以这里不必担心串号。
        const source = res.account ? sessionFor(res.account).log : globalLog;
        for (const entry of source.filter((item) => visible(item, res.account)).slice(-LOG_REPLAY)) {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }

      // ---- 账号 ----
      if (route === 'GET /api/accounts') {
        const store = loadStore();
        json({
          activeId: store.activeId,
          accounts: store.accounts.map((account) => ({
            ...describeAccount(account, { active: account.id === store.activeId }),
            status: accountStatus(sessionFor(account.id)),
          })),
        });
        return;
      }
      if (route === 'GET /api/accounts/credential') {
        const store = loadStore();
        const account = pickAccount(store, parsed.searchParams.get('account'));
        if (!account) throw new Error('没有这个账号');
        json(parsed.searchParams.get('reveal') === '1' ? revealAccount(account) : describeAccount(account, { active: account.id === store.activeId }));
        return;
      }
      if (route === 'POST /api/accounts/active') {
        const payload = jsonBody();
        needConfirm(payload);
        const store = loadStore();
        const account = pickAccount(store, payload.id);
        if (!account) throw new Error('没有这个账号');
        setActive(store, account.id);
        saveStore(store);
        emit(null, 'info', `当前账号切到 ${describeAccount(account).title}`);
        json({ ok: true, activeId: account.id });
        return;
      }
      if (route === 'POST /api/accounts/label') {
        const payload = jsonBody();
        needConfirm(payload);
        const store = loadStore();
        const account = pickAccount(store, payload.id);
        if (!account) throw new Error('没有这个账号');
        account.label = String(payload.label ?? '').trim() || null;
        saveStore(store);
        json({ ok: true });
        return;
      }
      if (route === 'POST /api/accounts/remove') {
        const payload = jsonBody();
        needConfirm(payload);
        const store = loadStore();
        const account = pickAccount(store, payload.id);
        if (!account) throw new Error('没有这个账号');
        // 先停掉这个账号的连接与循环：sessions.delete() 只是丢掉 Map 里的引用，
        // 正在跑的 runLoop 还持着 client 的强引用，会继续操作一个凭证已经被删掉的账号；
        // 那些 socket / tickTimer 之后再也拿不到，也就永远停不了。
        const dead = sessions.get(account.id);
        if (dead) {
          dead.loop.stop.aborted = true;
          try {
            dead.client?.stop();
          } catch {
            /* 已经断了 */
          }
        }
        removeAccount(store, account.id);
        saveStore(store);
        sessions.delete(account.id);
        emit(null, 'info', `已删除账号 ${describeAccount(account).title}`);
        json({ ok: true });
        return;
      }

      // ---- 连接 ----
      if (route === 'POST /api/connect') {
        const payload = jsonBody();
        const { account, session } = scoped_(parsed);
        json(await connect(session, account));
        return;
      }
      if (route === 'POST /api/disconnect') {
        const { session } = scoped_(parsed);
        session.client?.stop();
        session.client = null;
        session.player = null;
        json({ ok: true });
        return;
      }

      // ---- 抓包与扫码 ----
      // 二维码只负责把游戏在电脑上拉起来，凭证还是靠本机代理抓。
      // 优先用游戏自己的小程序码（data/qrcode.png），没有就退回微信的跳转链接。
      if (route === 'GET /api/capture') {
        json({ ...captureState(), qr: qrInfo() });
        return;
      }
      if (route === 'GET /api/capture/qrcode') {
        const file = path.join(DATA_DIR, 'qrcode.png');
        if (!fs.existsSync(file)) {
          json({ error: '没有 data/qrcode.png' }, 404);
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
      if (route === 'POST /api/capture/start') {
        const payload = jsonBody();
        needConfirm(payload);
        if (captureState().running) throw new Error('已经在抓包了');
        emit(null, 'info', `开始抓包：本地 CA 与系统代理（127.0.0.1:${DEFAULT_PROXY_PORT}）都是当前用户范围，抓到即自动还原`);
        await startCapture({
          port: DEFAULT_PROXY_PORT,
          onLog: (line) => emit(null, 'info', line),
          onLogin: async ({ url, body, rawFrameHex }) => addCapturedAccount({ url, body, rawFrameHex }),
        });
        json({ ...captureState(), qr: qrInfo() });
        return;
      }
      if (route === 'POST /api/capture/stop') {
        needConfirm(jsonBody());
        await stopCapture('用户点了停止');
        json({ ...captureState(), qr: qrInfo() });
        return;
      }

      // ---- 只读视图 ----
      // 今天归档了什么：哪个接口、多少条、多大的文件，以及落在哪个目录。
      // 不碰网关、不碰账号，纯文件系统读取，所以不带 ?account。
      if (route === 'GET /api/archive') {
        // 只接受 YYYY-MM-DD。这个值会直接进 path.join，放任 `../..` 就等于把任意目录
        // （连同绝对路径回显与同步全量读）暴露给任何能访问本机 17321 的进程。
        const wanted = parsed.searchParams.get('day') ?? '';
        const day = /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : dayOf();
        json({ root: ARCHIVE_ROOT, day, days: listDays(), entries: summarizeDay(ARCHIVE_ROOT, day) });
        return;
      }
      if (route === 'GET /api/overview') {
        const { account, session } = scoped_(parsed);
        json(await overview(session, account));
        return;
      }
      if (route === 'GET /api/heroes') {
        const { account, session } = scoped_(parsed);
        json(await heroes(session, account));
        return;
      }
      if (route === 'GET /api/dailies') {
        const { account, session } = scoped_(parsed);
        json(await dailies(session, account));
        return;
      }
      if (route === 'GET /api/tasks') {
        const { account, session } = scoped_(parsed);
        json(await tasks(session, account));
        return;
      }
      if (route === 'GET /api/world') {
        const { account, session } = scoped_(parsed);
        json(await world(session, account, {
          pickUpFloaters: parsed.searchParams.get('pick') === '1',
          // 农田默认开；显式传 farm=0 才关。
          farm: parsed.searchParams.get('farm') !== '0',
        }));
        return;
      }
      // ---- 工厂 ----
      if (route === 'GET /api/radar') {
        const { account, session } = scoped_(parsed);
        json(await radar(session, account));
        return;
      }
      // 派兵/领奖：跟 world 一样先探测再计划再执行；每艘空闲船各派一个事件。
      if (route === 'POST /api/radar/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyRadar(instance, protocol, { config });
        const ratio = Number(payload.powerRatio) > 0 ? Number(payload.powerRatio) : (Number(session.loop.minPowerRatio) || DEFAULT_MIN_POWER_RATIO);
        const view = viewRadar(survey, { config, minPowerRatio: ratio });
        const plan = planRadar(view, {
          minPowerRatio: ratio,
          // 默认不限：有多少空闲船就派多少（每艘船打一个事件）。传 max 才限制。
          maxDispatch: Number(payload.max) > 0 ? Number(payload.max) : Infinity,
        });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 900,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `情报「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `情报 ${entry.step.label}` : `情报 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          ...(await radar(session, account)),
        });
        return;
      }
      // ---- 装备厂（锻造） ----
      if (route === 'GET /api/forge') {
        const { account, session } = scoped_(parsed);
        json(await forge(session, account));
        return;
      }
      // 收取 + 排产：跟情报一样先探测再计划再执行。一轮最多一个收取 + 一个排产。
      if (route === 'POST /api/forge/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyEquip(instance, protocol, { config });
        const plan = planEquip(survey, { config });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 800,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `锻造「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `锻造 ${entry.step.label}` : `锻造 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          ...(await forge(session, account)),
        });
        return;
      }
      if (route === 'GET /api/pet') {
        const { account, session } = scoped_(parsed);
        json(await pet(session, account));
        return;
      }
      // 收取成熟的 + 空位排产：跟锻造一样先探测再计划再执行。
      if (route === 'POST /api/pet/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyPet(instance, protocol, { config });
        const plan = planPet(survey, { config, maxQuality: session.loop.petMaxQuality });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 800,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `培育「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `培育 ${entry.step.label}` : `培育 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          ...(await pet(session, account)),
        });
        return;
      }
      if (route === 'GET /api/idle') {
        const { account, session } = scoped_(parsed);
        json(await idle(session, account));
        return;
      }
      // 立刻领取一次：不看间隔，跟挂机里那套完全一样（探测 → 计划 → 执行）。
      if (route === 'POST /api/idle/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyIdle(instance, protocol, { config, player: session.player });
        const plan = planIdle(survey, { config });
        const { results } = await runIdle(instance, protocol, plan, {
          allowMutate: true,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `挂机领取「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `挂机领取 ${entry.step.label}` : `挂机领取 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          ...(await idle(session, account)),
        });
        return;
      }
      // 搁浅的货轮：手动「立刻抢一次」，判据与循环里那套完全一样（等级选择取当前配置）。
      if (route === 'POST /api/treasure/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        // 页面「立刻抢一次」会把当前勾选的等级带过来：先落进 session.loop，
        // 这样面板、手动抢、之后启动的挂机看到的是同一份选择（不会出现「勾了却还是按旧的抢」）。
        if (payload.treasureColors !== undefined) session.loop.treasureColors = colorsOf(payload.treasureColors);
        const colors = colorsOf(session.loop.treasureColors);
        const maxFleets = session.loop.treasureMaxFleets;
        const survey = await surveyTreasure(instance, protocol, { config, player: session.player });
        const view = viewTreasure(survey, { config, colors, maxFleets });
        const plan = planTreasure(view, { maxFleets });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 800,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `抢货轮「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `抢货轮 ${entry.step.label}` : `抢货轮 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          ...(await treasure(session, account)),
        });
        return;
      }
      if (route === 'GET /api/factory') {
        const { account, session } = scoped_(parsed);
        json(await factory(session, account));
        return;
      }
      // 一键收成：把所有工厂的囤积成品一次收完，收益按产品名合并后返回。
      // 逐座收、一座失败不连累其它（原因会一起带回去），收完再读一次状态给页面。
      if (route === 'POST /api/factory/gain') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const before = await surveyFactories(instance, protocol, { config });
        if (!before.factories.some((entry) => entry.finished.length > 0)) {
          json({ ok: true, note: '现在没有待收的成品', gained: [], results: [], ...(await factory(session, account)) });
          return;
        }
        const { targets, results, gained } = await gainAllProducts(instance, protocol, before.factories);
        const failed = results.filter((entry) => !entry.ok);
        const gainText = gained.length ? gained.map((entry) => `${entry.id}×${entry.num}`).join('、') : '没收到东西';
        const note = `收成 ${results.length - failed.length}/${targets} 座工厂：${gainText}`
          + (failed.length ? `；失败 ${failed.map((entry) => `${entry.buildingId}（${entry.error}）`).join('、')}` : '');
        emit(session, failed.length ? 'warn' : 'info', note);
        await new Promise((resolve) => setTimeout(resolve, 600));
        json({ ok: true, note, gained: gained.map((entry) => ({ ...entry, icon: itemIcon(entry.id) })), results, ...(await factory(session, account)) });
        return;
      }
      // 手动排产：先按当前状态挡掉明显发不出去的请求（队列满 / 没解锁 / 材料不够），
      // 免得靠 sendWatch 猜服务端那条 prompt 是什么意思。
      if (route === 'POST /api/factory/produce') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        if (!payload.buildingId || !payload.productId) throw new Error('要指定 buildingId 与 productId');
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const before = await surveyFactories(instance, protocol, { config });
        const target = before.factories.find((entry) => entry.buildingId === payload.buildingId);
        if (!target) throw new Error(`${payload.buildingId} 不在这个账号的工厂列表里`);
        const recipe = factoryRecipes(config, target.type).find((entry) => entry.itemId === payload.productId);
        if (!recipe) throw new Error(`${target.buildingId}（${target.type ?? '未知类型'}）没有 ${payload.productId} 这条配方`);
        if (target.level < recipe.unlockLevel) throw new Error(`${target.buildingId} 还是 lv${target.level}，${payload.productId} 要 lv${recipe.unlockLevel} 才解锁`);
        if (target.queue.length >= before.factorySlots) throw new Error(`${target.buildingId} 的制造位满了（${target.queue.length}/${before.factorySlots}）`);
        if (recipe.costItem.length > 0) {
          const lacking = recipe.costItem
            .map((cost) => ({ id: cost.id, num: cost.num, have: before.stock.get(cost.id) ?? 0 }))
            .filter((cost) => cost.have < cost.num);
          if (lacking.length > 0) {
            // 材料不齐时客户端会弹「用钻石补」，本工具永远不用钻石，直接不发。
            throw new Error(`材料不够：${lacking.map((cost) => `${cost.id} ${cost.have}/${cost.num}`).join('、')}`);
          }
        }
        // 持有量 = 仓库 + 这个工厂待收的 + 队列里还排着的。只算仓库会漏掉待收那部分，
        // 服务端判 storage full 的口径更宽（实测淡水仓库 23 个时仍可能被拒）。
        const inStock = before.stock.get(payload.productId) ?? 0;
        const inFactory = target.finished.filter((asset) => asset.id === payload.productId).reduce((sum, asset) => sum + asset.num, 0)
          + target.queue.filter((job) => job.productId === payload.productId).length;
        const held = inStock + inFactory;
        if (before.stockCap > 0 && held >= before.stockCap) {
          const advice = inFactory >= before.stockCap
            ? '先「一键收成」把工厂里囤的成品收走'
            : inStock >= before.stockCap
              ? '仓库里这批已经到上限，得先把它消耗掉（收成只会让仓库更满）'
              : '先收成再消耗掉一些';
          throw new Error(`${payload.productId} 已经到上限了：仓库 ${inStock} + 工厂待收/在造 ${inFactory} = ${held}/${before.stockCap}。${advice}。`);
        }
        try {
          await startProduce(instance, { buildingId: payload.buildingId, productId: payload.productId });
        } catch (error) {
          // 服务端驳回时只有一句英文 prompt（storage full / feature locked…），
          // 这里翻成「哪个产品、卡在哪、怎么办」，不然页面上只看到 server prompt: storage full。
          const raw = String(error?.message ?? '');
          if (/storage full/i.test(raw)) {
            throw new Error(`${payload.buildingId} 造不了 ${payload.productId}：服务端说仓库满了（storage full）。`
              + `产品存量上限 ${before.stockCap || '?'} 个，我这边看到仓库 ${inStock}、工厂待收/在造 ${inFactory}。`
              + '先「一键收成」把工厂里囤的收走，还不够就把它消耗掉（交订单 / 建造）再来造。');
          }
          if (/not enough|insufficient|lack|no enough/i.test(raw)) {
            throw new Error(`${payload.buildingId} 造不了 ${payload.productId}：服务端说材料不够（${raw}）。`);
          }
          if (/feature locked/i.test(raw)) {
            throw new Error(`${payload.buildingId} 造不了 ${payload.productId}：这个功能还没解锁（feature locked）。`);
          }
          throw error;
        }
        const costText = recipe.costItem.map((cost) => `${cost.id}×${cost.num}`).join(' ');
        emit(session, 'info', `工厂 ${payload.buildingId} 开始制造 ${payload.productId}（${recipe.produceTime}s${costText ? `，耗 ${costText}` : ''}）`);
        // 服务端入队要一小会儿，等它写进 factoryQ 再读回去，页面才不会显示成「没排上」。
        await new Promise((resolve) => setTimeout(resolve, 900));
        json({ ok: true, note: `${payload.buildingId} 开始制造 ${payload.productId}`, ...(await factory(session, account)) });
        return;
      }
      if (route === 'GET /api/worlds') {
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        json({ ...(await listWorlds(instance)), currentPlayer: describeRole(session.player) });
        return;
      }
      // 进服自己开一条短连接，所以不会打扰控制台这边正在跑的会话。
      if (route === 'POST /api/worlds/enter') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        if (!payload.worldId) throw new Error('要指定 worldId');
        const entered = await enterWorld({ url: account.url, login: account.login, protocol }, Number(payload.worldId));
        const player = describeRole(entered.player);
        entered.client.stop();
        json({ player });
        return;
      }

      // ---- 写操作 ----
      if (route === 'POST /api/heroes/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const plan = await heroes(session, account);
        const started = Date.now();
        const steps = [];
        const results = await runHeroPlan(instance, protocol, plan, {
          allowMutate: true,
          timeout: 8000,
          onStep: (entry) => {
            const step = entry.step;
            const label = step.kind === 'level' ? `${step.heroId} 升到 ${step.to} 级` : step.kind === 'star' ? `${step.heroId} 升到 ${step.to} 星` : `${step.heroId} 技能 ${step.slot + 1}`;
            steps.push({ label, ok: entry.ok, error: entry.error });
            emit(session, entry.ok ? 'info' : 'error', entry.ok ? `英雄 ${label}` : `英雄 ${label} 失败：${entry.error}`);
          },
        });
        const after = await instance.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
        json({ sent: results.length, failed: results.filter((r) => !r.ok).length, ms: Date.now() - started, steps, heroes: after.heroes ?? [] });
        return;
      }
      if (route === 'POST /api/dailies/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyDailies(instance, protocol, { config, player: session.player });
        const started = Date.now();
        const results = await runDailies(instance, protocol, survey, {
          allowMutate: true,
          allowPaid: payload.paid === true,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `日常「${entry.title}」跳过：${entry.reason}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `日常「${entry.title}」${entry.note}` : `日常「${entry.title}」失败：${entry.error}`);
          },
        });
        // 任务奖励、活跃度宝箱与每日赠礼的领取都在 runDailies 内部收尾，这里只把结果重新读一遍给页面。
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await surveyDailies(instance, protocol, { config, player: session.player });
        const claimed = results
          .filter((entry) => entry.ok && (entry.request === 'DrawDailyTaskRewardRequest' || entry.id === 'activityChest' || entry.id === 'freeDailyPack'))
          .map((entry) => entry.note);
        json({ results, claimed, ms: Date.now() - started, tasks: after.tasks, chests: after.chests, gift: after.gift, ruby: after.ruby });
        return;
      }
      if (route === 'POST /api/tasks/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const survey = await tasks(session, account);
        const results = await runTasks(instance, protocol, survey, {
          allowMutate: true,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `任务「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `领取 ${entry.step.label}` : `领取 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await tasks(session, account);
        json({ results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })), plan: after.plan, text: after.text });
        return;
      }
      if (route === 'POST /api/world/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyWorld(instance, protocol, { config, player: session.player });
        const plan = planWorld(survey, {
          config,
          allowSpeedUp: payload.speedUp === true,
          allowReroll: payload.reroll === true,
          // 材料不齐时默认拿自选包补；前端传 selectPack:false 可关，maxPack 可改每轮上限。
          useSelectPack: payload.selectPack !== false,
          maxPackPerRound: Number(payload.maxPack) > 0 ? Number(payload.maxPack) : undefined,
          // 拾荒默认不做，前端勾了「自动拾荒」才扫海面漂浮物。
          pickUpFloaters: payload.pickFloaters === true,
          // 农田默认做（收成熟作物 + 补种），前端取消勾选才关。
          farm: payload.farm !== false,
          // 潜水**没有这个参数**：DivingRequest 要上报「这一局捡到了什么」，
          // 纯协议发空体只会拿回空奖励，详见 docs/gameplay.md 与 world.mjs 顶部注释。
        });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `海面「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `海面 ${entry.step.label}` : `海面 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        const floaterLoot = summarizeFloaters(results);
        const floaterText = formatFloaters(floaterLoot);
        if (floaterText) emit(session, 'info', floaterText);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await world(session, account, {
          pickUpFloaters: payload.pickFloaters === true,
          farm: payload.farm !== false,
        });
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          // 跟 /api/radar/run 一样把整份世界视图带回去。页面执行完要重画工厂/订单/仓库/订单表，
          // 只回 results/plan/text 的话 renderWorld 会读到 undefined，在「已清空面板」之后抛
          // TypeError，页面停在半更新状态，连本轮执行结果都显示不出来。
          ...after,
          floaterText, floaterLoot,
        });
        return;
      }
      // 循环：开启后立刻返回，进度走 /api/loop 与事件流。
      if (route === 'GET /api/loop') {
        const { session } = scoped_(parsed);
        json(loopView(session));
        return;
      }
      if (route === 'POST /api/loop/start') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const loop = session.loop;
        if (loop.running) throw new Error('这个账号的循环已经在跑了');
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        loop.running = true;
        // 参数一律先过有限数校验：`"abc"` 会让 Number() 得到 NaN，
        // rounds 变 NaN 等于「永久挂机」（NaN 不满足 > 0），
        // everySeconds 变 NaN 则让 setTimeout(NaN) 退化成 1ms 间隔的高频轰炸。
        const secondsArg = (value, fallback) => {
          const n = Number(value ?? fallback);
          return Number.isFinite(n) && n >= 0 ? n : fallback;
        };
        const roundsArg = Number(payload.rounds ?? 1);
        loop.rounds = Number.isFinite(roundsArg) ? roundsArg : 1;
        loop.completed = 0;
        loop.everyMs = secondsArg(payload.everySeconds, 60) * 1000;
        // 0 或负数 = 不节流（旧行为）。负数按 0 处理，免得写成 -1 时被当成「永远不做」。
        loop.pickEveryMs = secondsArg(payload.pickEverySeconds, 0) * 1000;
        loop.lastPickAt = null;
        // 农田默认开，前端取消勾选才关；间隔同样 0 = 不限制。
        loop.farmEnabled = payload.farm !== false;
        loop.farmEveryMs = secondsArg(payload.farmEverySeconds, 120) * 1000;
        loop.lastFarmAt = null;
        // 情报默认开；powerRatio 前端可调（默认 1.2，越大越保守）；间隔默认 60 秒。
        loop.radarEnabled = payload.radar !== false;
        loop.radarEveryMs = secondsArg(payload.radarEverySeconds, 60) * 1000;
        loop.lastRadarAt = null;
        // 锻造默认开，间隔默认 180 秒（一件蓝装约 25 分钟，没必要每轮去问）。
        loop.forgeEnabled = payload.forge !== false;
        loop.forgeEveryMs = secondsArg(payload.forgeEverySeconds, 180) * 1000;
        loop.lastForgeAt = null;
        // 海兽培育室默认开，间隔默认 300 秒（蓝配方 4 小时、橙 36 小时，看太勤没意义）。
        loop.petEnabled = payload.pet !== false;
        loop.petEveryMs = secondsArg(payload.petEverySeconds, 300) * 1000;
        loop.lastPetAt = null;
        loop.petMaxQuality = PET_QUALITIES.includes(payload.petMaxQuality) ? payload.petMaxQuality : 'ORANGE';
        // 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级）默认开，间隔默认 300 秒。
        loop.idleEnabled = payload.idle !== false;
        loop.idleEveryMs = secondsArg(payload.idleEverySeconds, 300) * 1000;
        loop.lastIdleAt = null;
        // 搁浅的货轮默认开，间隔默认 60 秒（整点刷新，抢的是刷新后那几十秒）。
        // 等级是多选（3=蓝小型 4=紫中型 5=橙万吨），页面上不传才用默认（只抢万吨）；
        // 显式传空数组 = 一个都不抢（页面上三个全取消勾选就是这个意思，不能悄悄回退默认）。
        loop.treasureEnabled = payload.treasure !== false;
        loop.treasureEveryMs = secondsArg(payload.treasureEverySeconds, 60) * 1000;
        loop.lastTreasureAt = null;
        loop.treasureMaxFleets = Number.isFinite(Number(payload.treasureMaxFleets)) && Number(payload.treasureMaxFleets) > 0
          ? Math.min(10, Math.floor(Number(payload.treasureMaxFleets)))
          : DEFAULT_MAX_FLEETS;
        loop.treasureColors = colorsOf(payload.treasureColors);
        loop.minPowerRatio = Number(payload.powerRatio) > 0 ? Number(payload.powerRatio) : DEFAULT_MIN_POWER_RATIO;
        loop.history = [];
        loop.error = null;
        loop.stop = { aborted: false };
        const gateText = loop.pickEveryMs > 0 ? `拾荒每 ${Math.round(loop.pickEveryMs / 1000)} 秒最多一次` : '拾荒每轮都试';
        const farmText = loop.farmEnabled
          ? (loop.farmEveryMs > 0 ? `农田每 ${Math.round(loop.farmEveryMs / 1000)} 秒看一眼` : '农田每轮都看')
          : '农田关';
        const radarText = loop.radarEnabled
          ? `情报${loop.radarEveryMs > 0 ? `每 ${Math.round(loop.radarEveryMs / 1000)} 秒一次` : '每轮都看'}（战力余量 ${loop.minPowerRatio}×）`
          : '情报关';
        const forgeText = loop.forgeEnabled
          ? (loop.forgeEveryMs > 0 ? `锻造每 ${Math.round(loop.forgeEveryMs / 1000)} 秒看一眼` : '锻造每轮都看')
          : '锻造关';
        const petText = loop.petEnabled
          ? (loop.petEveryMs > 0 ? `海兽培育每 ${Math.round(loop.petEveryMs / 1000)} 秒看一眼（品质上限 ${loop.petMaxQuality}）` : `海兽培育每轮都看（品质上限 ${loop.petMaxQuality}）`)
          : '海兽培育关';
        const idleText = loop.idleEnabled
          ? (loop.idleEveryMs > 0 ? `挂机领取每 ${Math.round(loop.idleEveryMs / 1000)} 秒看一眼` : '挂机领取每轮都看')
          : '挂机领取关';
        const treasureText = loop.treasureEnabled
          ? (loop.treasureEveryMs > 0
            ? `货轮每 ${Math.round(loop.treasureEveryMs / 1000)} 秒抢一次（${loop.treasureColors.length > 0 ? `抢 ${colorsText(config, loop.treasureColors)}` : '未勾等级，不会派船'}）`
            : `货轮每轮都抢（${loop.treasureColors.length > 0 ? `抢 ${colorsText(config, loop.treasureColors)}` : '未勾等级，不会派船'}）`)
          : '货轮关';
        emit(session, 'info', `自动挂机开始：${loop.rounds} 轮，每轮间隔 ${Math.round(loop.everyMs / 1000)} 秒；${gateText}；${farmText}；${idleText}；${treasureText}；${radarText}；${forgeText}；${petText}`);
        runLoop(instance, protocol, {
          config,
          player: session.player,
          rounds: loop.rounds,
          everyMs: loop.everyMs,
          allowMutate: true,
          allowPaid: payload.paid === true,
          allowSpeedUp: payload.speedUp === true,
          allowReroll: payload.reroll === true,
          pickUpFloaters: payload.pickFloaters === true,
          pickEveryMs: loop.pickEveryMs,
          farmEnabled: loop.farmEnabled,
          farmEveryMs: loop.farmEveryMs,
          radarEnabled: loop.radarEnabled,
          radarEveryMs: loop.radarEveryMs,
          forgeEnabled: loop.forgeEnabled,
          forgeEveryMs: loop.forgeEveryMs,
          petEnabled: loop.petEnabled,
          petEveryMs: loop.petEveryMs,
          petMaxQuality: loop.petMaxQuality,
          idleEnabled: loop.idleEnabled,
          idleEveryMs: loop.idleEveryMs,
          treasureEnabled: loop.treasureEnabled,
          treasureEveryMs: loop.treasureEveryMs,
          treasureMaxFleets: loop.treasureMaxFleets,
          treasureColors: loop.treasureColors,
          minPowerRatio: loop.minPowerRatio,
          stop: loop.stop,
          onRound: (summary) => {
            loop.completed = summary.round;
            loop.lastPickAt = summary.gates?.pick?.lastAt ?? loop.lastPickAt;
            loop.lastFarmAt = summary.gates?.farm?.lastAt ?? loop.lastFarmAt;
            loop.lastRadarAt = summary.gates?.radar?.lastAt ?? loop.lastRadarAt;
            loop.lastForgeAt = summary.gates?.forge?.lastAt ?? loop.lastForgeAt;
            loop.lastPetAt = summary.gates?.pet?.lastAt ?? loop.lastPetAt;
            loop.lastIdleAt = summary.gates?.idle?.lastAt ?? loop.lastIdleAt;
            loop.lastTreasureAt = summary.gates?.treasure?.lastAt ?? loop.lastTreasureAt;
            loop.history.push(summary);
            if (loop.history.length > 50) loop.history.shift();
            emit(session, 'info', formatLoopRound(summary));
          },
          onStep: (entry) => {
            const label = entry.step?.label ?? entry.title ?? entry.id;
            if (entry.skipped) return;
            emit(session, entry.ok ? 'info' : 'error', entry.ok ? `循环[${entry.phase}] ${label}` : `循环[${entry.phase}] ${label} 失败：${entry.error}`);
          },
        })
          .then(() => emit(session, 'info', '自动挂机结束'))
          .catch((error) => {
            loop.error = error.message;
            emit(session, 'error', `自动挂机中止：${error.message}`);
          })
          .finally(() => {
            loop.running = false;
          });
        json({ ok: true, running: true });
        return;
      }
      if (route === 'POST /api/loop/stop') {
        const payload = jsonBody();
        needConfirm(payload);
        const { session } = scoped_(parsed);
        session.loop.stop.aborted = true;
        json({ ok: true, running: session.loop.running });
        return;
      }

      json({ error: 'not found' }, 404);
    } catch (error) {
      emit(scoped, 'error', error.message);
      // 响应头已经发出去时不能再 writeHead（典型：图集/二维码先 writeHead(200) 再 readFileSync
      // 抛 ENOENT）。那个二次异常发生在 catch 之外，会变成未处理的 rejection 把进程带走。
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* 客户端已经断了 */
        }
        return;
      }
      json({ error: error.message }, 400);
    } finally {
      if (scoped && scoped.busy === route) scoped.busy = null;
    }
  }

  function loopView(session) {
    const loop = session.loop;
    return {
      running: loop.running,
      rounds: loop.rounds,
      completed: loop.completed,
      everyMs: loop.everyMs,
      pickEveryMs: loop.pickEveryMs,
      lastPickAt: loop.lastPickAt,
      farmEnabled: loop.farmEnabled,
      farmEveryMs: loop.farmEveryMs,
      lastFarmAt: loop.lastFarmAt,
      radarEnabled: loop.radarEnabled,
      radarEveryMs: loop.radarEveryMs,
      lastRadarAt: loop.lastRadarAt,
      forgeEnabled: loop.forgeEnabled,
      forgeEveryMs: loop.forgeEveryMs,
      lastForgeAt: loop.lastForgeAt,
      petEnabled: loop.petEnabled,
      petEveryMs: loop.petEveryMs,
      lastPetAt: loop.lastPetAt,
      petMaxQuality: loop.petMaxQuality,
      idleEnabled: loop.idleEnabled,
      idleEveryMs: loop.idleEveryMs,
      lastIdleAt: loop.lastIdleAt,
      treasureEnabled: loop.treasureEnabled,
      treasureEveryMs: loop.treasureEveryMs,
      lastTreasureAt: loop.lastTreasureAt,
      treasureMaxFleets: loop.treasureMaxFleets,
      treasureColors: loop.treasureColors,
      minPowerRatio: loop.minPowerRatio,
      history: loop.history.map((summary) => ({ ...summary, text: formatLoopRound(summary) })),
      error: loop.error,
    };
  }

  // 请求体上限：控制台只收很小的 JSON，给一个宽松但有限的天花板，
  // 免得任意本机进程一个超大 POST 就把控制台的内存吃光。
  const MAX_BODY_BYTES = 16 * 1024 * 1024;
  const server = http.createServer((req, res) => {
    // 先收 Buffer、最后一次性转字符串：`body += chunk` 会对每个分片各做一次
    // toString('utf8')，一个中文字正好跨 TCP 分片时会被拆成两个替换字符
    // （账号 label 是要落盘的，坏了就是脏数据）。
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on('error', () => {
      // 客户端中途断开时不处理会从 http 服务器内部抛出去。
      settled = true;
    });
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        try {
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `请求体超过 ${MAX_BODY_BYTES} 字节` }));
        } catch {
          /* 已经断了 */
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks).toString('utf8');
      // handle 是 async：不接住它的 reject 就是未处理的 promise rejection，
      // Node 15+ 默认行为是直接退出进程（控制台整体挂掉）。
      handle(req, res, body).catch((error) => {
        emit(null, 'error', error.message);
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: error.message }));
          } else {
            res.end();
          }
        } catch {
          /* 已经断了 */
        }
      });
    });
  });

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          emit(null, 'info', `控制台已启动 http://${host}:${port}`);
          resolve(`http://${host}:${port}`);
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
    emit,
    sessions,
    captureState,
  };
}

export function openBrowser(url) {
  const attempts = [
    ['msedge', [`--app=${url}`]],
    ['chrome', [`--app=${url}`]],
    ['cmd', ['/c', 'start', '', url]],
  ];
  for (const [command, args] of attempts) {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return command;
    } catch {
      /* try next */
    }
  }
  return null;
}
