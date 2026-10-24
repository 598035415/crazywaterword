import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GameClient } from './client.mjs';
import { attach, ARCHIVE_ROOT, dayOf, listDays, summarizeDay } from './archive.mjs';
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
import { surveyFactories, viewFactories, factoryRecipes, startProduce, gainAllProducts } from './factories.mjs';
import { runAction } from './actions.mjs';
import { loadStore, saveStore, upsertAccount, removeAccount, setActive, pickAccount, describeAccount, revealAccount, DATA_DIR } from './accounts.mjs';
import { startCapture, stopCapture, captureState, DEFAULT_PROXY_PORT } from './capture.mjs';
import { iconIndex, atlasFile, itemIcon, resourceIcon, materialIcon, heroIcon, heroCard, buildingIcon } from './art.mjs';

const LOG_LIMIT = 400;
// 协议帧不再进界面，但仍然要能事后查：时序流水在 data/protocol.log，
// 完整回包按接口分文件存在 data/responses/<日期>/ —— 两套都由 archive.mjs 负责。

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

  function emit(session, level, message, extra) {
    const entry = { t: Date.now(), level, message, extra, account: session?.id ?? null };
    const list = session ? session.log : globalLog;
    list.push(entry);
    logLimit(list);
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of streams) {
      if (res.account && res.account !== entry.account && entry.account !== null) continue;
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
        const day = parsed.searchParams.get('day') || dayOf();
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
          plan: after.plan, text: after.text, population: after.population,
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
        loop.rounds = Number(payload.rounds ?? 1);
        loop.completed = 0;
        loop.everyMs = Number(payload.everySeconds ?? 60) * 1000;
        // 0 或负数 = 不节流（旧行为）。负数按 0 处理，免得写成 -1 时被当成「永远不做」。
        loop.pickEveryMs = Math.max(0, Number(payload.pickEverySeconds ?? 0)) * 1000;
        loop.lastPickAt = null;
        // 农田默认开，前端取消勾选才关；间隔同样 0 = 不限制。
        loop.farmEnabled = payload.farm !== false;
        loop.farmEveryMs = Math.max(0, Number(payload.farmEverySeconds ?? 120)) * 1000;
        loop.lastFarmAt = null;
        // 情报默认开；powerRatio 前端可调（默认 1.2，越大越保守）；间隔默认 60 秒。
        loop.radarEnabled = payload.radar !== false;
        loop.radarEveryMs = Math.max(0, Number(payload.radarEverySeconds ?? 60)) * 1000;
        loop.lastRadarAt = null;
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
        emit(session, 'info', `自动挂机开始：${loop.rounds} 轮，每轮间隔 ${payload.everySeconds ?? 60} 秒；${gateText}；${farmText}；${radarText}`);
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
          minPowerRatio: loop.minPowerRatio,
          stop: loop.stop,
          onRound: (summary) => {
            loop.completed = summary.round;
            loop.lastPickAt = summary.gates?.pick?.lastAt ?? loop.lastPickAt;
            loop.lastFarmAt = summary.gates?.farm?.lastAt ?? loop.lastFarmAt;
            loop.lastRadarAt = summary.gates?.radar?.lastAt ?? loop.lastRadarAt;
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
      minPowerRatio: loop.minPowerRatio,
      history: loop.history.map((summary) => ({ ...summary, text: formatLoopRound(summary) })),
      error: loop.error,
    };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handle(req, res, body));
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
    captureState: () => capture,
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
