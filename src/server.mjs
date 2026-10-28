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
import { surveyHeroGrowth, planHeroGrowth, formatHeroGrowth, buildHeroRows, GROW_SWITCHES, SWITCH_LABELS, BADGE_EXP_ITEM, EQUIP_IRON, EQUIP_REFINE_ITEM, EQUIP_STAR_ITEM, EXCLUSIVE_LV_MATERIALS, EXCLUSIVE_STONE_ORANGE, EXCLUSIVE_STONE_RED } from './heroGrow.mjs';
import { surveyDailies, runDailies, formatSurvey } from './dailies.mjs';
import { surveyTasks, runTasks, formatTaskPlan } from './tasks.mjs';
import { surveyWorld, planWorld, runWorld, formatWorldPlan, formatFieldReport, loadMapAsset, summarizeFloaters, formatFloaters, materialGroups } from './world.mjs';
import { runLoop, formatLoopRound } from './loop.mjs';
import { surveyRadar, viewRadar, planRadar, formatRadarPlan, DEFAULT_MIN_POWER_RATIO } from './radar.mjs';
import { surveyPirates, viewPirates, planPirates, formatPiratePlan } from './pirate.mjs';
import { surveyEquip, planEquip, formatEquipPlan } from './equip.mjs';
import { surveyPet, planPet, formatPetPlan, PET_QUALITIES } from './pet.mjs';
import { surveyIdle, planIdle, runIdle, formatIdleSummary } from './idle.mjs';
import { surveyTreasure, viewTreasure, planTreasure, formatTreasureSummary, formatTreasurePlan, rewardCountText, DEFAULT_MAX_FLEETS, DEFAULT_COLORS, colorsOf, colorsText } from './treasure.mjs';
import {
  surveyGuildShip,
  viewGuildShip,
  planGuildShip,
  formatGuildShipSummary,
  summarizeGuildShip,
  formatGuildShipGain,
  bigNum,
} from './guildShip.mjs';
import { surveyCargo, fetchStock, viewCargo, planCargo, formatCargoSummary, summarizeCargo, formatCargoGain, safeCargoDemand, CARGO_SLOTS } from './tradePort.mjs';
import {
  surveyTradeKing,
  viewTradeKing,
  planTradeKing,
  formatTradeSummary,
  summarizeTrade,
  formatTradeGain,
} from './tradeKing.mjs';
import { surveyFactories, viewFactories, factoryRecipes, startProduce, gainAllProducts, packCoverPlan, exchangePacks } from './factories.mjs';
import { runAction } from './actions.mjs';
import { loadStore, saveStore, upsertAccount, removeAccount, setActive, pickAccount, describeAccount, revealAccount, DATA_DIR } from './accounts.mjs';
import { collectStats } from './stats.mjs';
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

// 「无需求配方的小额兜底上限」（planWorld 的 packGapMax）。
// 0 是合法值（关掉这个口子），所以不能像 maxPack 那样用 `> 0` 判断 —— 空串/没传
// 要跟 0 分开：前者返回 undefined 让 planWorld 用它自己的默认值 Infinity（不设门槛）。
function packGapArg(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : undefined;
}

// 页面上是百分数（默认 80），三个世界玩法（货轮/情报/海盗）内部统一用比例（0.8）。
// 放在一处算：分开算迟早出现「情报按 0.8 拦、货轮按 0.5 派」的漂移。
function duraFloorOf(loop) {
  return Math.min(1, Math.max(0, Number(loop?.radarRepairBelow ?? 80) / 100));
}

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
      // 重连失败后的静默截止时间（毫秒时间戳，0 = 不在冷却里）。
      // 网关对「刚被踢下线」的账号会连着回 result=3，而页面每 3 秒轮询一次 /api/overview，
      // 每次都触发 ensureConnected 重登 —— 等于我们自己在把冷却期一直踩满。
      linkCooldownUntil: 0,
      // 正在进行的重连（Promise）。loop 与页面轮询可能同时要重连，共用这一个，别各建一条连接。
      linkPending: null,
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
        // 修船门槛（百分数）：耐久低于它就留在港里修，不派出去打情报。0 = 关。
        radarRepairBelow: 80,
        // 海盗讨伐（真出战 ChallengePirateRequest）：跟免战扫荡（dailies 1010）不是一回事。
        // 每次烧 300 汽油、不掉耐久，收益是首杀奖励 + 固定掉落。它排在货轮和情报之后，只捡剩船。
        pirateEnabled: true,
        pirateEveryMs: 60_000,
        lastPirateAt: null,
        // false = 只打「没打过的下一个等级」（首杀）；true = 连已通关等级也刷，只拿 fixedReward。
        pirateRepeat: false,
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
        // 材料加速（投喂）：默认开。消耗队列位要求的材料把剩余时间往前推 4 小时，
        // 不花钻石/加速器/广告。
        petFeed: true,
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
        // 最近一次探测到的每日奖励次数（{ at, dailyLimit, todayRewardTimes, remainingRewards,
        // dailyFull, nextRefreshTime, text }）：页面上「已领 x/N」直接用它，不再为看数字打请求。
        treasureStats: null,
        // 贸易港口（建筑「货轮港口」）：3 艘货船逐格交货换 EXP+金币，交满出发、返航后领藏品奖励。
        // 全程免费、请求只有一个 CargoShipsRequest，默认 60 秒看一眼（返航是小时级的）。
        cargoEnabled: true,
        cargoEveryMs: 60_000,
        lastCargoAt: null,
        guildShipEnabled: true,
        guildShipEveryMs: 120_000,
        lastGuildShipAt: null,
        guildShipSeek: true,
        // 海商王（活动「Trade」，每天 10~22 点）：在港就卖 + 买本港特产 + 开去紧缺港口。
        // 只花活动内的商会币（不花钻石），商会指针是免费道具 —— 默认全用。
        // 海商王活动 2026-10-28 已下线，loop 里那一段整段注释，这里也跟着默认关。
        tradeEnabled: false,
        tradeEveryMs: 60_000,
        lastTradeAt: null,
        tradeAllowSpeed: true,
        tradePass: true,
        // 联盟订单：每天 0 点刷一单，交齐 3 种物品换公会经验 + 功勋（+联盟城市兵力）。
        // 请求体只有 cityId，不花货币/钻石，唯一成本是仓库里那 3 样货 —— 默认开，10 分钟看一次。
        guildOrderEnabled: true,
        guildOrderEveryMs: 600_000,
        lastGuildOrderAt: null,
        minPowerRatio: DEFAULT_MIN_POWER_RATIO,
        // 运行中可改的执行范围（以前只在 start 时生效，改完必须停掉重开）：
        // 拾荒开关、材料不齐时用不用自选包、加速器/拒单/付费这些允许项。
        pickUpFloaters: false,
        useSelectPack: true,
        maxPackPerRound: undefined,
        // 无需求配方的兑包门槛（个包）：null/undefined = 用 planWorld 的默认 Infinity（不拦），0 = 关掉。
        packGapMax: undefined,
        allowSpeedUp: false,
        allowReroll: false,
        allowPaid: false,
        // 已经点了停止、但循环还在收尾（最多跑完当前这一段）。
        stopping: false,
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
    // 本地 proto（反编译客户端 bundle）落后于服务端时会收到没定义的消息。
    // 这类帧已经按「跳过 body、照常推进 seq」处理，不影响后续收发 —— 用 warn 不用 error，避免误判成断线。
    instance.on('unknown', ({ name, seq }) => emit(session, 'warn', `收到本地 proto 未定义的消息 ${name}（seq=${seq}），已跳过该帧并继续`));
    instance.on('fatal', ({ reason, seqNo }) => emit(session, 'error', reason === 'SCChannelExpired'
      ? '这个账号在别处登录了，本条连接被顶掉'
      : `下行序号召回失败（${reason} seqNo=${seqNo}），这条连接已作废，需要重连`));
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

  // 重连失败后的静默时长：网关在「刚被踢下线」的一两分钟里对重登回 result=3
  // （2026-10-26 11:45:47 起连撞 40+ 次、每次间隔 3 秒，全是 /api/overview 的轮询触发的）。
  // 15 秒足够躲开这波高频撞击，又不至于让手动刷新等太久。
  const RECONNECT_COOLDOWN_MS = 15_000;

  async function ensureConnected(session, account) {
    if (session.client?.connected) return session.client;
    // 页面每 3 秒轮询 /api/overview、loop 自己也会重连，两边同时撞进来会各建一个 GameClient，
    // 后到的那个必然被 connect() 的「这个账号已经连上了」拦下，白白把冷却期又踩一次。
    // 并发期间只登一次，所有人共用同一个 promise。
    if (session.linkPending) return session.linkPending;
    if (session.linkCooldownUntil > Date.now()) {
      // 文案给的是「自动重连」而不是具体秒数：页面每 3 秒刷一次，秒数跳来跳去会晃眼。
      throw new Error('连接已断开，正在自动重连');
    }
    const pending = connect(session, account)
      .then(() => {
        session.linkCooldownUntil = 0;
        return session.client;
      })
      .catch((error) => {
        session.linkCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
        // 重登被拒的原话（result=3）留着，比一串 socket error 好定位。
        throw error;
      })
      .finally(() => {
        if (session.linkPending === pending) session.linkPending = null;
      });
    session.linkPending = pending;
    return pending;
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
    // 货船缺口也并进排产需求：手动「探测 / 执行」和挂机必须算出同一份计划。
    const plan = planWorld(survey, { config, pickUpFloaters, farm, cargoDemand: await safeCargoDemand(instance, protocol, { stock: survey.stock }) });
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
    const ratio = Number(session.loop.minPowerRatio) || DEFAULT_MIN_POWER_RATIO;
    // 页面上的 radarRepairBelow 是百分数（80），radar 模块内部用比例（0.8）。
    const repairBelow = duraFloorOf(session.loop);
    const survey = await surveyRadar(instance, protocol, { config, repairBelow });
    const view = viewRadar(survey, { config, minPowerRatio: ratio, repairBelow });
    const plan = planRadar(view, { minPowerRatio: ratio, repairBelow });
    const fleetIcon = (buildingId) => buildingIcon(String(buildingId).replace(/^\d+[A-Z]?/, ''));
    return {
      level: view.level,
      exp: view.exp,
      storedNum: view.storedNum,
      nextRefreshTime: view.nextRefreshTime,
      petrol: view.petrol,
      bestIdlePower: view.bestIdlePower,
      minPowerRatio: ratio,
      repairBelow,
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

  // 海盗讨伐（世界地图）：只读视图（地图海盗 + 舰队 + 击杀进度 + 计划）。真正的出战走 /api/pirates/run。
  // 跟「联盟情报」的雷达 event 是两套东西：那边是情报事件（有 uid + state），这边是地图上常驻的海盗部队。
  async function pirates(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const ratio = Number(session.loop.minPowerRatio) || DEFAULT_MIN_POWER_RATIO;
    const survey = await surveyPirates(instance, protocol, { config, player: session.player });
    const view = viewPirates(survey, { config, minPowerRatio: ratio, repeat: session.loop.pirateRepeat === true, duraFloor: duraFloorOf(session.loop) });
    const plan = planPirates(view, { maxPerRound: session.loop.pirateMaxPerRound });
    // 舰队 id 形如「1远征船」，去掉前缀数字就是建筑类型，拿来取图标（与情报那屏一致）。
    const fleetIcon = (buildingId) => buildingIcon(String(buildingId).replace(/^\d+[A-Z]?/, ''));
    return {
      season: view.season,
      seasonExact: view.seasonExact,
      petrol: view.petrol,
      petrolCost: view.petrolCost,
      sweepTimes: view.sweepTimes,
      bestIdlePower: view.bestIdlePower,
      minPowerRatio: ratio,
      repeat: view.repeat,
      fleets: view.fleets.map((fleet) => ({ ...fleet, icon: fleetIcon(fleet.buildingId) })),
      types: view.types,
      targets: view.targets.map((target) => ({
        ...target,
        firstReward: (target.firstReward ?? []).map((asset) => ({ ...asset, icon: materialIcon(asset.id) })),
        fixedReward: (target.fixedReward ?? []).map((asset) => ({ ...asset, icon: materialIcon(asset.id) })),
      })),
      plan: plan.actions,
      notes: plan.notes,
      text: formatPiratePlan(view, plan),
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
    const plan = planPet(survey, { config, maxQuality: session.loop.petMaxQuality, allowFeed: session.loop.petFeed });
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
      petFeed: session.loop.petFeed !== false,
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
    const view = viewTreasure(survey, { config, colors, maxFleets, duraFloor: duraFloorOf(session.loop) });
    const plan = planTreasure(view, { maxFleets });
    // 顺手把奖励次数记到 session 上：网页的「已领 x/N」读的就是这一份，
    // 手动抢完立刻就能看到新数字，不用等下一轮挂机。
    session.loop.treasureStats = {
      at: Math.floor(Date.now() / 1000),
      dailyLimit: view.dailyLimit,
      todayRewardTimes: view.todayRewardTimes,
      remainingRewards: view.remainingRewards,
      dailyFull: view.dailyFull,
      nextRefreshTime: view.nextRefreshTime,
      text: rewardCountText(view),
    };
    return {
      // 活动有效期：页面直接据此显示「还有多久到期 / 已结束」。
      activity: view.activity,
      dailyLimit: view.dailyLimit,
      todayRewardTimes: view.todayRewardTimes,
      remainingRewards: view.remainingRewards,
      dailyFull: view.dailyFull,
      // 「已领 1/3（还能领 2 次）」这种一句话口径，页面与日志共用。
      rewardText: rewardCountText(view),
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

  // 海商王（活动「Trade」）：只读视图 + 一段（卖/买/起航）的计划，真正的写走 /api/trade/run。
  // 单独跑时自己拉一次库存（商会指针的存量在里面）；循环里复用海面那一段的 stock，零额外请求。
  async function trade(session, account, options = {}) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const stock = await fetchStock(instance, protocol);
    const survey = await surveyTradeKing(instance, protocol, { stock, learned: options.learned ?? null });
    const view = viewTradeKing(survey, { config });
    const plan = planTradeKing(view, {
      config,
      allowSpeed: options.allowSpeed !== false,
      allowPass: options.allowPass !== false,
    });
    return {
      survey,
      view,
      plan,
      payload: {
        period: view.period,
        open: view.open,
        windowOpen: view.windowOpen,
        startAt: view.startAt,
        endAt: view.endAt,
        nextRefreshAt: view.nextRefreshAt,
        summary: formatTradeSummary(view),
        ship: view.ship,
        player: view.player,
        cargo: view.cargo,
        holdings: view.holdings,
        shelf: view.shelf,
        specGoodsId: view.specGoodsId,
        rareGoodsId: view.rareGoodsId,
        targetCityId: view.targetCityId,
        sellable: view.sellable.map((h) => ({
          pid: h.pid, name: h.name, num: h.num, buyPrice: h.buyPrice, sellPrice: h.sellPrice, profit: h.profit, profitable: h.profitable,
        })),
        candidates: view.candidates.map((c) => ({
          goodsId: c.goodsId,
          name: c.name,
          quality: c.quality,
          price: c.price,
          base: c.base,
          ratio: Number(c.ratio.toFixed(3)),
          avail: c.avail,
          destCityId: c.destCityId,
          unitProfit: c.unitProfit,
          isSpec: c.isSpec,
          sure: c.sure,
        })),
        pairs: view.pairs,
        rewards: view.rewards,
        speed: view.speed,
        actions: plan.actions.map((step) => ({ kind: step.kind, label: step.label })),
        notes: plan.notes,
        text: formatTradeSummary(view) + (plan.actions.length > 0
          ? `\n待办：${plan.actions.map((step) => step.label).join('、')}`
          : `\n没有可做的（${plan.notes[0] ?? '等下一个刷新点'}）`),
      },
    };
  }

  // 拉英雄星级（只为了判断「能不能应聘某艘船的船长」）。拿不到就当没有英雄，
  // 只是这次不当船长 —— 补货不受影响，所以这里吞掉错误。
  async function fetchHeroStars(instance) {
    const body = await instance.request('AllHeroRequest', {}, 'AllHeroResponse', 12_000).catch(() => null);
    const heroes = new Map();
    for (const hero of body?.heroes ?? []) {
      const id = String(hero.heroId ?? hero.name ?? hero.id ?? '');
      if (id) heroes.set(id, { star: Number(hero.star) || 0, exStar: Number(hero.exclusive?.star) || 0 });
    }
    return heroes;
  }

  // 联盟商船（活动「GuildShip」）：只读视图 + 补货/应聘计划，真正的写走 /api/guildship/run。
  async function guildShip(session, account, options = {}) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const [stock, heroes] = await Promise.all([
      fetchStock(instance, protocol),
      options.heroes ?? fetchHeroStars(instance),
    ]);
    const survey = await surveyGuildShip(instance, protocol);
    const view = viewGuildShip(survey, {
      config,
      stock,
      heroes,
      // int64 必须走 bigNum，否则大 id 会算成负数，「我是不是船长」判错。
      playerId: bigNum(session.player?.playerId),
    });
    const plan = planGuildShip(view, { config, allowSeek: options.allowSeek !== false });
    return {
      survey,
      view,
      plan,
      payload: {
        period: view.period,
        open: view.open,
        maxShips: view.maxShips,
        prepareMinutes: view.prepareMinutes,
        refreshHours: view.refreshHours,
        nextRefreshAt: view.nextRefreshAt,
        summary: formatGuildShipSummary(view),
        slotsLeft: view.slotsLeft,
        myShips: view.myShips,
        ownRun: view.ownRun,
        ships: view.ships.map((ship) => ({
          shipId: ship.shipId,
          pos: ship.pos,
          type: ship.type,
          quality: ship.quality,
          qualityName: ship.qualityName,
          cabinTotal: ship.cabinTotal,
          minutes: ship.minutes,
          state: ship.state,
          stateName: ship.stateName,
          leaderName: ship.leaderName,
          mineLeader: ship.mineLeader,
          myCabinId: ship.myCabinId,
          mine: ship.mine,
          filledCount: ship.filledCount,
          emptyCount: ship.emptyCount,
          passLine: ship.passLine,
          filling: ship.filling,
          endAt: ship.endAt,
          leftSeconds: ship.leftSeconds,
          reward: ship.rewardAsset,
          rewardScore: ship.rewardScore,
          seekOk: ship.seekCheck.ok,
          seekWhy: ship.seekCheck.why,
          cabins: ship.cabins.map((c) => ({
            crewId: c.crewId,
            filled: c.filled,
            byMe: c.byMe,
            ownerName: c.ownerName,
            needs: c.needs,
            short: c.short,
            canFill: c.canFill,
          })),
          fillable: ship.fillable,
          blocked: ship.blocked,
        })),
        seekable: view.seekable.map((s) => s.shipId),
        fillableShips: view.fillableShips.map((s) => s.shipId),
        actions: plan.actions.map((step) => ({ kind: step.kind, label: step.label })),
        notes: plan.notes,
        text: formatGuildShipSummary(view) + (plan.actions.length > 0
          ? `\n待办：${plan.actions.map((step) => step.label).join('、')}`
          : `\n没有可做的（${plan.notes[0] ?? '等下一条船刷新'}）`),
      },
    };
  }

  // 贸易港口（建筑「货轮港口」）：只读视图 + 交货/领奖计划，真正的写走 /api/cargo/run。
  // 单独跑（不经过循环）时要自己拉库存：循环里是复用海面那一段的 stock，这里两个只读请求换来一份。
  async function cargo(session, account) {
    const instance = await ensureConnected(session, account);
    const stock = await fetchStock(instance, protocol);
    const survey = await surveyCargo(instance, protocol, { stock });
    const view = viewCargo(survey);
    const plan = planCargo(view);
    return {
      slots: CARGO_SLOTS,
      summary: formatCargoSummary(view),
      nextArriveAt: view.nextArriveAt,
      nextArriveLeftSeconds: view.nextArriveLeftSeconds,
      ships: view.ships.map((ship) => ({
        index: ship.index,
        status: ship.status,
        statusText: ship.statusText,
        phase: ship.phase,
        arriveTime: ship.arriveTime,
        leftSeconds: ship.leftSeconds,
        filledCount: ship.filledCount,
        claimable: ship.claimable,
        reward: ship.reward,
        slots: ship.slots.map((slot) => ({
          slot: slot.slot,
          id: slot.id,
          num: slot.num,
          have: slot.have,
          filled: slot.filled,
          reward: slot.reward,
        })),
      })),
      actions: plan.actions.map((step) => ({ kind: step.kind, label: step.label })),
      notes: plan.notes,
      text: formatCargoSummary(view) + (plan.actions.length > 0
        ? `\n待办：${plan.actions.map((step) => step.label).join('、')}`
        : '\n没有可做的（料没攒够 / 船在航行 / 还没到返航时间）'),
    };
  }

  // 英雄页的一次完整探测：英雄本体（等级/升星/技能）+ 勋章 + 装备，全部是只读请求。  // 「养成」按钮、页面表格、执行前的复核都走这里，避免页面和执行各算一套。
  async function heroes(session, account, options = {}) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    if (!config) throw new Error('没有配置表，算不出英雄养成计划');
    const playerLevel = describeRole(session.player)?.level ?? 1;
    const survey = await surveyHeroGrowth(instance, protocol, { config, playerLevel });
    const itemNum = (id) => survey.stock.get(id) ?? 0;
    // 默认只养「主战英雄」（主线出战阵容里的那五个）；页面勾了「含未上阵」才覆盖全英雄册。
    const onlyFront = options.includeBench !== true;
    const plan = planHeroes({ config, heroes: survey.heroes, itemNum, playerLevel, heroIds: options.heroIds ?? null });
    const growth = planHeroGrowth(survey, { switches: options.switches, heroIds: options.heroIds, onlyFront });

    // 页面表格的行由 heroGrow.mjs 统一拼（同一个函数离线也能渲染，自检和截图核对走的就是它），
    // 这里只补游戏自己的图标。
    const heroes = buildHeroRows(survey, plan, growth, { onlyFront })
      .map((row) => ({ ...row, icon: heroCard(row.heroId), head: heroIcon(row.heroId) }));

    return {
      plan,
      survey,
      growth,
      payload: {
        steps: plan.steps,
        notes: plan.notes,
        maxLevel: plan.maxLevel,
        maxStar: plan.maxStar,
        text: formatHeroPlan(plan),
        // 勋章/装备的计划文本与动作数（动作明细不上页面，页面上按英雄分行看）。
        growthText: formatHeroGrowth(growth),
        growthNotes: growth.notes,
        growthActions: growth.actions.length,
        switches: GROW_SWITCHES,
        switchLabels: SWITCH_LABELS,
        // 主战阵容：页面顶部说明「只养这 N 个」靠这几个字段，勾了「含未上阵」才看全册。
        formation: {
          presetId: survey.formation?.presetId ?? 0,
          heroIds: survey.formation?.heroIds ?? [],
          frontCount: survey.heroes.filter((hero) => hero.front).length,
          total: survey.heroes.length,
          onlyFront,
        },
        stock: {
          精铁: survey.stock.get(EQUIP_IRON) ?? 0,
          徽章经验: survey.stock.get(BADGE_EXP_ITEM) ?? 0,
          精炼石: survey.stock.get(EQUIP_REFINE_ITEM) ?? 0,
          装备升星石: survey.stock.get(EQUIP_STAR_ITEM) ?? 0,
          // 专武材料有 4 档（初/中/高/特），哪一档是 0 就说明专武升到哪一级会断；
          // 升星石按英雄品质二选一，两种都列出来（橙英雄只吃橙石）。
          ...Object.fromEntries(EXCLUSIVE_LV_MATERIALS.map((id) => [id.replace('专武材料', '专武'), survey.stock.get(id) ?? 0])),
          橙专武升星石: survey.stock.get(EXCLUSIVE_STONE_ORANGE) ?? 0,
          红专武升星石: survey.stock.get(EXCLUSIVE_STONE_RED) ?? 0,
          GOLD: survey.stock.get('GOLD') ?? 0,
        },
        heroes,
      },
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
      // 今日收益统计：不从内存拿，直接按归档回包重算（口径见 src/stats.mjs 顶部注释）。
      // 所以刷新页面、重启进程、下午才开页面都能看到从 0 点起的完整数据，不依赖挂机是否一直在跑。
      // 只读文件、不连网关，但**要账号** —— 归档里的 acc 是 openId 前 8 位，多账号时得分开算。
      if (route === 'GET /api/stats') {
        const { account } = scoped_(parsed);
        const wanted = parsed.searchParams.get('day') ?? '';
        const day = /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : dayOf();
        const view = collectStats({ day, acc: String(account.id).slice(0, 8) });
        // 图标在 server 这层补：stats.mjs 只认 id，不碰图集，免得两边互相拉依赖。
        for (const source of view.sources) {
          source.items = source.items.map((item) => ({ ...item, icon: materialIcon(item.id) }));
        }
        view.days = listDays();
        json(view);
        return;
      }
      if (route === 'GET /api/overview') {
        const { account, session } = scoped_(parsed);
        json(await overview(session, account));
        return;
      }
      if (route === 'GET /api/heroes') {
        const { account, session } = scoped_(parsed);
        const result = await heroes(session, account, { includeBench: parsed.searchParams.get('bench') === '1' });
        json(result.payload);
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
        const ratio = Number(payload.powerRatio) > 0 ? Number(payload.powerRatio) : (Number(session.loop.minPowerRatio) || DEFAULT_MIN_POWER_RATIO);
        // 修船门槛同样吃页面上的百分数；payload 显式传了就用它（不写回 loop）。
        const repairBelow = Math.min(1, Math.max(0, Number(payload.repairBelow ?? duraFloorOf(session.loop) * 100) / 100));
        const survey = await surveyRadar(instance, protocol, { config, repairBelow });
        const view = viewRadar(survey, { config, minPowerRatio: ratio, repairBelow });
        const plan = planRadar(view, {
          minPowerRatio: ratio,
          repairBelow,
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
      // ---- 海盗讨伐（世界地图的真出战，跟免战扫荡不是一回事） ----
      if (route === 'GET /api/pirates') {
        const { account, session } = scoped_(parsed);
        json(await pirates(session, account));
        return;
      }
      // 手动「立刻讨伐一次」：判据与挂机里那段完全一样，只是不等间隔。
      if (route === 'POST /api/pirates/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const ratio = Number(payload.powerRatio) > 0
          ? Number(payload.powerRatio)
          : (Number(session.loop.minPowerRatio) || DEFAULT_MIN_POWER_RATIO);
        // 页面上勾了「刷已通关等级」就落进 session.loop，之后的挂机也按这个口径走。
        if (payload.repeat !== undefined) session.loop.pirateRepeat = payload.repeat === true;
        const survey = await surveyPirates(instance, protocol, { config, player: session.player });
        const view = viewPirates(survey, { config, minPowerRatio: ratio, repeat: session.loop.pirateRepeat === true, duraFloor: duraFloorOf(session.loop) });
        const plan = planPirates(view, {
          maxPerRound: Number(payload.max) > 0 ? Number(payload.max) : session.loop.pirateMaxPerRound,
        });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 900,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `海盗「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `海盗 ${entry.step.label}` : `海盗 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          ...(await pirates(session, account)),
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
      // 贸易港口：只读面板（3 艘船的订单 / 库存 / 返航时间 + 待办计划）。
      if (route === 'GET /api/cargo') {
        const { account, session } = scoped_(parsed);
        json(await cargo(session, account));
        return;
      }
      // 立刻交一次货 / 领一次奖：不看间隔，判据与循环里那套完全一样（探测 → 计划 → 执行）。
      if (route === 'POST /api/cargo/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const stock = await fetchStock(instance, protocol);
        const survey = await surveyCargo(instance, protocol, { stock });
        const plan = planCargo(viewCargo(survey));
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 800,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `贸易港口「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `贸易港口 ${entry.step.label}` : `贸易港口 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const gain = formatCargoGain(summarizeCargo(results));
        if (gain) emit(session, 'info', gain);
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          gain: summarizeCargo(results),
          ...(await cargo(session, account)),
        });
        return;
      }
      // 联盟商船（活动「GuildShip」）：只读视图 + 补货/应聘计划，真正的写走 /api/guildship/run。
      if (route === 'GET /api/guildship') {
        const { account, session } = scoped_(parsed);
        json((await guildShip(session, account)).payload);
        return;
      }
      // 立刻跑一段联盟商船（补货 → 应聘船长），判据与循环里那套完全一样。
      if (route === 'POST /api/guildship/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const allowSeek = payload.allowSeek !== false;
        const before = await guildShip(session, account, { allowSeek });
        const instance = await ensureConnected(session, account);
        const plan = before.plan;
        let results = [];
        if (plan.actions.length > 0) {
          ({ results } = await runWorld(instance, protocol, plan, {
            allowMutate: true,
            window: 1200,
            onStep: (entry) => {
              if (entry.skipped) emit(session, 'warn', `联盟商船「${entry.step.label}」跳过：${entry.error}`);
              else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `联盟商船 ${entry.step.label}` : `联盟商船 ${entry.step.label} 失败：${entry.error}`);
            },
          }));
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const gain = formatGuildShipGain(summarizeGuildShip(results));
          if (gain) emit(session, 'info', gain);
        }
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          gain: summarizeGuildShip(results),
          ...(await guildShip(session, account, { allowSeek })).payload,
        });
        return;
      }
      if (route === 'GET /api/trade') {
        const { account, session } = scoped_(parsed);
        json((await trade(session, account)).payload);
        return;
      }
      // 立刻跑一段海商王（卖 → 共享 → 买 → 起航 → 加速），判据与循环里那套完全一样。
      if (route === 'POST /api/trade/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const stock = await fetchStock(instance, protocol);
        const survey = await surveyTradeKing(instance, protocol, { stock });
        const view = viewTradeKing(survey, { config });
        const plan = planTradeKing(view, { config, allowSpeed: payload.allowSpeed !== false, allowPass: true });
        const { results } = await runWorld(instance, protocol, plan, {
          allowMutate: true,
          window: 800,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `海商王「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `海商王 ${entry.step.label}` : `海商王 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const gain = formatTradeGain(summarizeTrade(results));
        if (gain) emit(session, 'info', gain);
        json({
          results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })),
          gain: summarizeTrade(results),
          ...(await trade(session, account)).payload,
        });
        return;
      }
      if (route === 'GET /api/pet') {        const { account, session } = scoped_(parsed);
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
        // 页面上「材料加速」的勾选实时带过来（不传就沿用 session 里的值）。
        if (payload.petFeed !== undefined) session.loop.petFeed = payload.petFeed !== false;
        const survey = await surveyPet(instance, protocol, { config });
        const plan = planPet(survey, { config, maxQuality: session.loop.petMaxQuality, allowFeed: session.loop.petFeed });
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
        const view = viewTreasure(survey, { config, colors, maxFleets, duraFloor: duraFloorOf(session.loop) });
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
        // 需要兑料时会在中间重新探测一次，所以这里用 let。
        let before = await surveyFactories(instance, protocol, { config });
        let target = before.factories.find((entry) => entry.buildingId === payload.buildingId);
        if (!target) throw new Error(`${payload.buildingId} 不在这个账号的工厂列表里`);
        const recipe = factoryRecipes(config, target.type).find((entry) => entry.itemId === payload.productId);
        if (!recipe) throw new Error(`${target.buildingId}（${target.type ?? '未知类型'}）没有 ${payload.productId} 这条配方`);
        if (target.level < recipe.unlockLevel) throw new Error(`${target.buildingId} 还是 lv${target.level}，${payload.productId} 要 lv${recipe.unlockLevel} 才解锁`);
        if (target.queue.length >= before.factorySlots) throw new Error(`${target.buildingId} 的制造位满了（${target.queue.length}/${before.factorySlots}）`);

        // 「兑料并制造」：缺料时用白名单自选包（原料 / 工事材料）补齐 —— 一包换一个单位，**会真花包**，
        // 所以只有页面那个按钮（usePack:true）才走，绝不自动。兑完重新探测一次，材料/库存都以新快照为准。
        let exchanged = [];
        if (payload.usePack === true && recipe.costItem.length > 0) {
          const plan = packCoverPlan(config, { costs: recipe.costItem, stock: before.stock });
          if (plan.gaps.length > 0 && plan.ok) {
            exchanged = await exchangePacks(instance, plan.orders, { window: 600 });
            emit(session, 'info', `兑料 ${target.buildingId} ${recipe.itemId}：${plan.text} → 换出 `
              + `${plan.orders.map((order) => `${order.itemId}×${order.num}`).join('、')}`);
            // 服务端把兑换后的库存推过来需要一点时间，等一拍再重读，否则会误判成「还是不够」。
            await new Promise((resolve) => setTimeout(resolve, 500));
            before = await surveyFactories(instance, protocol, { config });
            target = before.factories.find((entry) => entry.buildingId === payload.buildingId) ?? target;
          }
        }

        if (recipe.costItem.length > 0) {
          const lacking = recipe.costItem
            .map((cost) => ({ id: cost.id, num: cost.num, have: before.stock.get(cost.id) ?? 0 }))
            .filter((cost) => cost.have < cost.num);
          if (lacking.length > 0) {
            // 材料不齐时客户端会弹「用钻石补」，本工具永远不用钻石，直接不发。
            const short = lacking.map((cost) => `${cost.id} ${cost.have}/${cost.num}`).join('、');
            const plan = packCoverPlan(config, { costs: recipe.costItem, stock: before.stock });
            const hint = plan.ok
              ? `；可用 ${plan.text} 换出来（页面点「兑料并制造」才会真的兑）`
              : plan.unpackable.length > 0
                ? `；${plan.unpackable.join('、')} 没有能换它的自选包，只能等生产/采集`
                : `；${plan.needs.map((entry) => entry.pack).join('、')} 也不够（${plan.shortOnPacks.map((gap) => `${gap.pack} ${gap.packHave}/${gap.packs}`).join('、')}）`;
            throw new Error(`材料不够：${short}${hint}`);
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
        json({
          ok: true,
          note: `${payload.buildingId} 开始制造 ${payload.productId}`
            + (exchanged.length ? `（先用 ${exchanged.map((entry) => `${entry.pack}×${entry.num}`).join('、')} 兑料补齐）` : ''),
          exchanged,
          ...(await factory(session, account)),
        });
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
        const { plan } = await heroes(session, account);
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
      // 英雄养成：勋章/装备（runWorld 执行）+ 英雄本体（runHeroPlan 执行）。
      // 顺序刻意是「换 → 强化 → 升星/技能」：先换到更好的底子上再花材料，
      // 升星又会抬技能上限，和 heroes.mjs 里的判定顺序保持一致。
      if (route === 'POST /api/heroes/grow') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const heroIds = typeof payload.heroId === 'string' && payload.heroId ? [payload.heroId] : null;
        const switches = payload.switches && typeof payload.switches === 'object' ? payload.switches : {};
        const includeBench = payload.includeBench === true;
        // 计划和页面表格用的是同一个函数：执行前会重新探测一遍，不看页面上的旧快照。
        const before = await heroes(session, account, { switches, heroIds, includeBench });
        const instance = await ensureConnected(session, account);
        const started = Date.now();
        const steps = [];
        const record = (label, entry) => {
          steps.push({ label, ok: entry.ok, skipped: Boolean(entry.skipped), error: entry.error });
          if (entry.skipped) emit(session, 'warn', `英雄「${label}」跳过：${entry.error}`);
          else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `英雄 ${label}` : `英雄 ${label} 失败：${entry.error}`);
        };

        const gear = await runWorld(instance, protocol, { actions: before.growth.actions }, {
          allowMutate: true,
          window: 700,
          timeout: 15000,
          onStep: (entry) => record(entry.step.label ?? entry.step.kind, entry),
        });
        const body = await runHeroPlan(instance, protocol, before.plan, {
          allowMutate: true,
          timeout: 8000,
          onStep: (entry) => {
            const step = entry.step;
            const label = step.kind === 'level' ? `${step.heroId} 升到 ${step.to} 级`
              : step.kind === 'star' ? `${step.heroId} 升到 ${step.to} 星`
                : `${step.heroId} 技能 ${step.slot + 1} 升到 ${step.to}`;
            record(label, entry);
          },
        });

        const gearResults = gear.results ?? [];
        const failed = gearResults.filter((one) => !one.ok).length + body.filter((one) => !one.ok).length;
        emit(session, failed ? 'warn' : 'info',
          `英雄养成完成：勋章/装备 ${gearResults.length} 条（失败 ${gearResults.filter((one) => !one.ok).length}）· 本体 ${body.length} 条（失败 ${body.filter((one) => !one.ok).length}）`);
        // 让服务端把状态推完再读，否则刚升的等级/星级可能还读不到。
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await heroes(session, account, { switches, heroIds, includeBench });
        json({
          sent: gearResults.length + body.length,
          failed,
          ms: Date.now() - started,
          steps,
          notes: [...before.growth.notes, ...before.plan.notes],
          heroes: after.payload.heroes,
        });
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
          cargoDemand: await safeCargoDemand(instance, protocol, { stock: survey.stock }),
          allowSpeedUp: payload.speedUp === true,
          allowReroll: payload.reroll === true,
          // 材料不齐时默认拿自选包补；前端传 selectPack:false 可关，maxPack 可改每轮上限。
          useSelectPack: payload.selectPack !== false,
          maxPackPerRound: Number(payload.maxPack) > 0 ? Number(payload.maxPack) : undefined,
          // 0 是合法值（关掉小额兜底），所以「空串/没传」要跟 0 区分开。
          packGapMax: packGapArg(payload.packGap),
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
        // 已经在跑 = **热更新**：只应用能中途改的参数（间隔 / 开关 / 抢哪些等级 / 材料包…），
        // 不重启循环、不清历史、不动已完成轮数。以前这里直接抛「已经在跑了」，
        // 用户改完设置必须手动停一次再开，前面跑的轮次白等 —— 而且没人看得懂为什么改了没反应。
        const hot = loop.running;
        const config = loadConfigSafe();
        // 热更新不用重连：连接由正在跑的循环自己维持（断了它自己会 reconnect）。
        const instance = hot ? null : await ensureConnected(session, account);
        if (!hot) {
          loop.running = true;
          loop.stopping = false;
        }
        // 参数一律先过有限数校验：`"abc"` 会让 Number() 得到 NaN，
        // rounds 变 NaN 等于「永久挂机」（NaN 不满足 > 0），
        // everySeconds 变 NaN 则让 setTimeout(NaN) 退化成 1ms 间隔的高频轰炸。
        const secondsArg = (value, fallback) => {
          const n = Number(value ?? fallback);
          return Number.isFinite(n) && n >= 0 ? n : fallback;
        };
        const roundsArg = Number(payload.rounds ?? 1);
        // 这些只有「新开一轮挂机」才重置：热更新时重置等于把历史与进度抹掉。
        if (!hot) {
          loop.rounds = Number.isFinite(roundsArg) ? roundsArg : 1;
          loop.completed = 0;
          loop.history = [];
          loop.error = null;
          loop.stop = { aborted: false };
          // 新一轮从「没有数据」开始：上一轮留下的奖励次数可能已经是昨天 23:59 的，
          // 直接显示会让人以为「今天已经领满了」。
          loop.treasureStats = null;
        }
        loop.everyMs = secondsArg(payload.everySeconds, 60) * 1000;
        // 0 或负数 = 不节流（旧行为）。负数按 0 处理，免得写成 -1 时被当成「永远不做」。
        loop.pickEveryMs = secondsArg(payload.pickEverySeconds, 0) * 1000;
        // 农田默认开，前端取消勾选才关；间隔同样 0 = 不限制。
        loop.farmEnabled = payload.farm !== false;
        loop.farmEveryMs = secondsArg(payload.farmEverySeconds, 120) * 1000;
        // 情报默认开；powerRatio 前端可调（默认 1.2，越大越保守）；间隔默认 60 秒。
        loop.radarEnabled = payload.radar !== false;
        loop.radarEveryMs = secondsArg(payload.radarEverySeconds, 60) * 1000;
        // 修船门槛（百分数，默认 80）：耐久低于它就留在港里修、不派出去。
        // 0 或负数 = 关掉修船（连「按耐久拦派兵」一起关，回到旧行为）。
        loop.radarRepairBelow = Number.isFinite(Number(payload.radarRepairBelow))
          ? Math.min(100, Math.max(0, Number(payload.radarRepairBelow)))
          : 80;
        // 海盗讨伐默认开，间隔默认 60 秒。它排在货轮与情报之后，只捡两段都没带走的空闲船，
        // 所以常出现「0 艘空闲船、这轮不派」—— 那是正常的，不是开关没生效。
        loop.pirateEnabled = payload.pirate !== false;
        loop.pirateEveryMs = secondsArg(payload.pirateEverySeconds, 60) * 1000;
        loop.pirateRepeat = payload.pirateRepeat === true;
        loop.pirateMaxPerRound = Number(payload.pirateMax) > 0 ? Math.floor(Number(payload.pirateMax)) : Infinity;
        // 锻造默认开，间隔默认 180 秒（一件蓝装约 25 分钟，没必要每轮去问）。
        loop.forgeEnabled = payload.forge !== false;
        loop.forgeEveryMs = secondsArg(payload.forgeEverySeconds, 180) * 1000;
        // 海兽培育室默认开，间隔默认 300 秒（蓝配方 4 小时、橙 36 小时，看太勤没意义）。
        loop.petEnabled = payload.pet !== false;
        loop.petEveryMs = secondsArg(payload.petEverySeconds, 300) * 1000;
        loop.petMaxQuality = PET_QUALITIES.includes(payload.petMaxQuality) ? payload.petMaxQuality : 'ORANGE';
        // 材料加速（投喂）默认开：只吃队列位要求的培育材料，不花钻石/加速器/广告。
        loop.petFeed = payload.petFeed !== false;
        // 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级）默认开，间隔默认 300 秒。
        loop.idleEnabled = payload.idle !== false;
        loop.idleEveryMs = secondsArg(payload.idleEverySeconds, 300) * 1000;
        // 搁浅的货轮默认开，间隔默认 60 秒（整点刷新，抢的是刷新后那几十秒）。
        // 等级是多选（3=蓝小型 4=紫中型 5=橙万吨），页面上不传才用默认（只抢万吨）；
        // 显式传空数组 = 一个都不抢（页面上三个全取消勾选就是这个意思，不能悄悄回退默认）。
        loop.treasureEnabled = payload.treasure !== false;
        loop.treasureEveryMs = secondsArg(payload.treasureEverySeconds, 60) * 1000;
        loop.treasureMaxFleets = Number.isFinite(Number(payload.treasureMaxFleets)) && Number(payload.treasureMaxFleets) > 0
          ? Math.min(10, Math.floor(Number(payload.treasureMaxFleets)))
          : DEFAULT_MAX_FLEETS;
        loop.treasureColors = colorsOf(payload.treasureColors);
        // 贸易港口（建筑「货轮港口」）默认开，间隔默认 60 秒：
        // 交货拿 EXP+金币是免费的，返航是小时级的，一分钟看一次就够。
        loop.cargoEnabled = payload.cargo !== false;
        loop.cargoEveryMs = secondsArg(payload.cargoEverySeconds, 60) * 1000;
        // 海商王默认开，间隔默认 60 秒（一趟卖+买+起航就完事，指针够时几乎瞬移）。
        loop.tradeEnabled = payload.trade !== false;
        loop.tradeEveryMs = secondsArg(payload.tradeEverySeconds, 60) * 1000;
        loop.tradeAllowSpeed = payload.tradeSpeed !== false;
        loop.tradePass = payload.tradePass !== false;
        // 联盟商船默认开，间隔默认 120 秒：补货窗口只有 30 分钟、好舱位会被队友抢，
        // 但商船 3 小时才刷新一次，探太勤也只是白打请求。
        loop.guildShipEnabled = payload.guildShip !== false;
        loop.guildShipEveryMs = secondsArg(payload.guildShipEverySeconds, 120) * 1000;
        loop.guildShipSeek = payload.guildShipSeek !== false;
        // 联盟订单默认开，间隔默认 600 秒：料是工厂产的加工品（30~300 分钟一炉），
        // 看太勤只是白打 3 个请求（GuildOrder + GuildCityInfo + CounterInfo）。
        loop.guildOrderEnabled = payload.guildOrder !== false;
        loop.guildOrderEveryMs = secondsArg(payload.guildOrderEverySeconds, 600) * 1000;
        loop.minPowerRatio = Number(payload.powerRatio) > 0 ? Number(payload.powerRatio) : DEFAULT_MIN_POWER_RATIO;
        // 执行范围也存进 loop：运行中改「拾荒 / 自选包 / 加速器 / 拒单」下一轮就能生效。
        // 注意 allowPaid 只影响日常里的点金/折扣店，热更新同样安全（每段都重新读）。
        loop.pickUpFloaters = payload.pickFloaters === true;
        loop.useSelectPack = payload.selectPack !== false;
        loop.maxPackPerRound = Number(payload.maxPack) > 0 ? Number(payload.maxPack) : undefined;
        loop.packGapMax = packGapArg(payload.packGap);
        loop.allowSpeedUp = payload.speedUp === true;
        loop.allowReroll = payload.reroll === true;
        loop.allowPaid = payload.paid === true;
        // 「上次执行时间」只有新开一轮挂机才清零：热更新时清掉会让每一段立刻重跑一次
        // （本来还差 4 分钟的锻造/情报会因为改了个间隔就全部重新探测一遍）。
        if (!hot) {
          loop.lastPickAt = null;
          loop.lastFarmAt = null;
          loop.lastRadarAt = null;
          loop.lastPirateAt = null;
          loop.lastForgeAt = null;
          loop.lastPetAt = null;
          loop.lastIdleAt = null;
          loop.lastTreasureAt = null;
          loop.lastCargoAt = null;
          loop.lastTradeAt = null;
          loop.lastGuildShipAt = null;
          loop.lastGuildOrderAt = null;
        }
        const gateText = loop.pickEveryMs > 0 ? `拾荒每 ${Math.round(loop.pickEveryMs / 1000)} 秒最多一次` : '拾荒每轮都试';
        const farmText = loop.farmEnabled
          ? (loop.farmEveryMs > 0 ? `农田每 ${Math.round(loop.farmEveryMs / 1000)} 秒看一眼` : '农田每轮都看')
          : '农田关';
        const radarText = loop.radarEnabled
          ? `情报${loop.radarEveryMs > 0 ? `每 ${Math.round(loop.radarEveryMs / 1000)} 秒一次` : '每轮都看'}（战力余量 ${loop.minPowerRatio}×`
            + `${loop.radarRepairBelow > 0 ? `，耐久 <${loop.radarRepairBelow}% 就修` : '，不修船'}）`
          : '情报关';
        const forgeText = loop.forgeEnabled
          ? (loop.forgeEveryMs > 0 ? `锻造每 ${Math.round(loop.forgeEveryMs / 1000)} 秒看一眼` : '锻造每轮都看')
          : '锻造关';
        const petText = loop.petEnabled
          ? (loop.petEveryMs > 0 ? `海兽培育每 ${Math.round(loop.petEveryMs / 1000)} 秒看一眼（品质上限 ${loop.petMaxQuality}，材料加速${loop.petFeed ? '开' : '关'}）` : `海兽培育每轮都看（品质上限 ${loop.petMaxQuality}，材料加速${loop.petFeed ? '开' : '关'}）`)
          : '海兽培育关';
        const idleText = loop.idleEnabled
          ? (loop.idleEveryMs > 0 ? `挂机领取每 ${Math.round(loop.idleEveryMs / 1000)} 秒看一眼` : '挂机领取每轮都看')
          : '挂机领取关';
        const treasureText = loop.treasureEnabled
          ? (loop.treasureEveryMs > 0
            ? `货轮每 ${Math.round(loop.treasureEveryMs / 1000)} 秒抢一次（${loop.treasureColors.length > 0 ? `抢 ${colorsText(config, loop.treasureColors)}` : '未勾等级，不会派船'}）`
            : `货轮每轮都抢（${loop.treasureColors.length > 0 ? `抢 ${colorsText(config, loop.treasureColors)}` : '未勾等级，不会派船'}）`)
          : '货轮关';
        const cargoText = loop.cargoEnabled
          ? (loop.cargoEveryMs > 0 ? `贸易港口每 ${Math.round(loop.cargoEveryMs / 1000)} 秒看一眼` : '贸易港口每轮都看')
          : '贸易港口关';
        const tradeText = loop.tradeEnabled
          ? (loop.tradeEveryMs > 0 ? `海商王每 ${Math.round(loop.tradeEveryMs / 1000)} 秒跑一段（指针${loop.tradeAllowSpeed ? '全用' : '不用'}）` : '海商王每轮都跑')
          : '海商王关';
        const guildShipText = loop.guildShipEnabled
          ? (loop.guildShipEveryMs > 0 ? `联盟商船每 ${Math.round(loop.guildShipEveryMs / 1000)} 秒看一眼（补货${loop.guildShipSeek ? ' + 应聘船长' : ''}）` : '联盟商船每轮都看')
          : '联盟商船关';
        const guildOrderText = loop.guildOrderEnabled
          ? (loop.guildOrderEveryMs > 0 ? `联盟订单每 ${Math.round(loop.guildOrderEveryMs / 1000)} 秒看一眼` : '联盟订单每轮都看')
          : '联盟订单关';
        const pirateText = loop.pirateEnabled
          ? `海盗${loop.pirateEveryMs > 0 ? `每 ${Math.round(loop.pirateEveryMs / 1000)} 秒` : '每轮'}讨伐一次`
            + `（${loop.pirateRepeat ? '含已通关等级' : '只打首杀等级'}，战力余量 ${loop.minPowerRatio}×）`
          : '海盗关';
        const head = hot ? '挂机设置已更新（下一轮生效）' : '自动挂机开始';
        emit(session, 'info', `${head}：${hot ? '' : `${loop.rounds} 轮，`}每轮间隔 ${Math.round(loop.everyMs / 1000)} 秒；${gateText}；${farmText}；${idleText}；${treasureText}；${cargoText}；${tradeText}；${guildShipText}；${guildOrderText}；${radarText}；${pirateText}；${forgeText}；${petText}`);
        // 热更新到此为止：正在跑的那个 runLoop 会从 live() 读到新值，下一轮自动生效。
        if (hot) {
          json({ ok: true, running: true, hot: true, note: '设置已应用，下一轮生效' });
          return;
        }
        runLoop(instance, protocol, {
          config,
          player: session.player,
          rounds: loop.rounds,
          everyMs: loop.everyMs,
          allowMutate: true,
          allowPaid: loop.allowPaid,
          allowSpeedUp: loop.allowSpeedUp,
          allowReroll: loop.allowReroll,
          pickUpFloaters: loop.pickUpFloaters,
          pickEveryMs: loop.pickEveryMs,
          farmEnabled: loop.farmEnabled,
          farmEveryMs: loop.farmEveryMs,
          radarEnabled: loop.radarEnabled,
          radarEveryMs: loop.radarEveryMs,
          radarRepairBelow: loop.radarRepairBelow,
          pirateEnabled: loop.pirateEnabled,
          pirateEveryMs: loop.pirateEveryMs,
          pirateRepeat: loop.pirateRepeat,
          pirateMaxPerRound: loop.pirateMaxPerRound,
          forgeEnabled: loop.forgeEnabled,
          forgeEveryMs: loop.forgeEveryMs,
          petEnabled: loop.petEnabled,
          petEveryMs: loop.petEveryMs,
          petMaxQuality: loop.petMaxQuality,
          petFeed: loop.petFeed,
          idleEnabled: loop.idleEnabled,
          idleEveryMs: loop.idleEveryMs,
          treasureEnabled: loop.treasureEnabled,
          treasureEveryMs: loop.treasureEveryMs,
          treasureMaxFleets: loop.treasureMaxFleets,
          treasureColors: loop.treasureColors,
          cargoEnabled: loop.cargoEnabled,
          cargoEveryMs: loop.cargoEveryMs,
          tradeEnabled: loop.tradeEnabled,
          tradeEveryMs: loop.tradeEveryMs,
          tradeAllowSpeed: loop.tradeAllowSpeed,
          tradePass: loop.tradePass,
          guildShipEnabled: loop.guildShipEnabled,
          guildShipEveryMs: loop.guildShipEveryMs,
          guildShipSeek: loop.guildShipSeek,
          guildOrderEnabled: loop.guildOrderEnabled,
          guildOrderEveryMs: loop.guildOrderEveryMs,
          minPowerRatio: loop.minPowerRatio,
          useSelectPack: loop.useSelectPack,
          maxPackPerRound: loop.maxPackPerRound,
          packGapMax: loop.packGapMax,
          // 运行中改设置不用停掉重开：runLoop 每轮开头都会调它重读一遍。
          live: () => loop,
          // 断线自愈：网关用 code=1000 关掉连接后，server 这边要新建一个 GameClient
          // （旧实例已经 stop，继续用只会一直 not connected）。不给这个钩子，
          // loop 里一次「拿不到 OnWaterResponse」就会把整条挂机判死 —— 2026-10-26 11:46 就是这样停的。
          // 注意 ensureConnected 在冷却期内会抛，loop 会把它记成「重连失败：…」并整轮跳过。
          reconnect: async () => {
            await ensureConnected(session, account);
            return session.client;
          },
          stop: loop.stop,
          onRound: (summary) => {
            loop.completed = summary.round;
            loop.lastPickAt = summary.gates?.pick?.lastAt ?? loop.lastPickAt;
            loop.lastFarmAt = summary.gates?.farm?.lastAt ?? loop.lastFarmAt;
            loop.lastRadarAt = summary.gates?.radar?.lastAt ?? loop.lastRadarAt;
            loop.lastPirateAt = summary.gates?.pirate?.lastAt ?? loop.lastPirateAt;
            loop.lastForgeAt = summary.gates?.forge?.lastAt ?? loop.lastForgeAt;
            loop.lastPetAt = summary.gates?.pet?.lastAt ?? loop.lastPetAt;
            loop.lastIdleAt = summary.gates?.idle?.lastAt ?? loop.lastIdleAt;
            loop.lastTreasureAt = summary.gates?.treasure?.lastAt ?? loop.lastTreasureAt;
            loop.lastCargoAt = summary.gates?.cargo?.lastAt ?? loop.lastCargoAt;
            loop.lastTradeAt = summary.gates?.trade?.lastAt ?? loop.lastTradeAt;
            loop.lastGuildShipAt = summary.gates?.guildShip?.lastAt ?? loop.lastGuildShipAt;
            loop.lastGuildOrderAt = summary.gates?.guildOrder?.lastAt ?? loop.lastGuildOrderAt;
            // 奖励次数只有真的探测过才有新值（静默窗里是上一轮的旧值，保留着给页面显示）。
            loop.treasureStats = summary.gates?.treasure?.stats ?? loop.treasureStats;
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
            loop.stopping = false;
          });
        json({ ok: true, running: true });
        return;
      }
      if (route === 'POST /api/loop/stop') {
        const payload = jsonBody();
        needConfirm(payload);
        const { session } = scoped_(parsed);
        // stopping 只是给页面看的：循环在一段之内是原子的（一段做完才检查停止），
        // 所以要有个「正在停」的状态，否则点完按钮页面还显示「挂机中」，用户以为没停。
        if (session.loop.running) session.loop.stopping = true;
        session.loop.stop.aborted = true;
        json({ ok: true, running: session.loop.running, stopping: session.loop.stopping });
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
      // 已点停止、正在收尾（当前这一段跑完就退出）。
      stopping: Boolean(loop.stopping && loop.running),
      rounds: loop.rounds,
      completed: loop.completed,
      everyMs: loop.everyMs,
      // 拾荒的「开关 + 间隔」都回给页面：运行中改了勾选，状态行要按服务端真实生效的值算，
      // 否则页面显示「还差 20 秒」而服务端其实已经关掉了这一段。
      pickEnabled: loop.pickUpFloaters === true,
      pickEveryMs: loop.pickEveryMs,
      lastPickAt: loop.lastPickAt,
      farmEnabled: loop.farmEnabled,
      farmEveryMs: loop.farmEveryMs,
      lastFarmAt: loop.lastFarmAt,
      radarEnabled: loop.radarEnabled,
      radarEveryMs: loop.radarEveryMs,
      radarRepairBelow: loop.radarRepairBelow,
      lastRadarAt: loop.lastRadarAt,
      // 海盗讨伐（真出战）：开关 / 间隔 / 上次执行 / 是否刷已通关等级。
      pirateEnabled: loop.pirateEnabled !== false,
      pirateEveryMs: loop.pirateEveryMs,
      lastPirateAt: loop.lastPirateAt,
      pirateRepeat: loop.pirateRepeat === true,
      forgeEnabled: loop.forgeEnabled,
      forgeEveryMs: loop.forgeEveryMs,
      lastForgeAt: loop.lastForgeAt,
      petEnabled: loop.petEnabled,
      petEveryMs: loop.petEveryMs,
      lastPetAt: loop.lastPetAt,
      petMaxQuality: loop.petMaxQuality,
      petFeed: loop.petFeed !== false,
      idleEnabled: loop.idleEnabled,
      idleEveryMs: loop.idleEveryMs,
      lastIdleAt: loop.lastIdleAt,
      treasureEnabled: loop.treasureEnabled,
      treasureEveryMs: loop.treasureEveryMs,
      lastTreasureAt: loop.lastTreasureAt,
      treasureMaxFleets: loop.treasureMaxFleets,
      treasureColors: loop.treasureColors,
      // 每日宝藏奖励次数：{ at, dailyLimit, todayRewardTimes, remainingRewards, dailyFull,
      // nextRefreshTime, text }，null = 还没探测过。
      treasureStats: loop.treasureStats,
      cargoEnabled: loop.cargoEnabled,
      cargoEveryMs: loop.cargoEveryMs,
      lastCargoAt: loop.lastCargoAt,
      tradeEnabled: loop.tradeEnabled,
      tradeEveryMs: loop.tradeEveryMs,
      lastTradeAt: loop.lastTradeAt,
      tradeAllowSpeed: loop.tradeAllowSpeed,
      tradePass: loop.tradePass,
      guildShipEnabled: loop.guildShipEnabled,
      guildShipEveryMs: loop.guildShipEveryMs,
      lastGuildShipAt: loop.lastGuildShipAt,
      guildShipSeek: loop.guildShipSeek,
      guildOrderEnabled: loop.guildOrderEnabled,
      guildOrderEveryMs: loop.guildOrderEveryMs,
      lastGuildOrderAt: loop.lastGuildOrderAt,
      minPowerRatio: loop.minPowerRatio,
      // 执行范围也回给页面：运行中回填勾选，避免「页面勾着、服务端其实关着」。
      useSelectPack: loop.useSelectPack !== false,
      maxPackPerRound: loop.maxPackPerRound ?? null,
      packGapMax: loop.packGapMax ?? null,
      allowSpeedUp: loop.allowSpeedUp === true,
      allowReroll: loop.allowReroll === true,
      allowPaid: loop.allowPaid === true,
      // 历史只回「页面真正用得到」的字段：results 里每条动作带着 step.body/label/error，
      // 50 轮 × 二十几条动作的 body 每 3 秒传一遍纯属浪费（页面只显示 text、读耗时与货轮门控）。
      history: loop.history.map((summary) => ({
        round: summary.round,
        startedAt: summary.startedAt,
        elapsedMs: summary.elapsedMs,
        stopped: summary.stopped === true,
        link: summary.link,
        gates: summary.gates,
        text: formatLoopRound(summary),
      })),
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
