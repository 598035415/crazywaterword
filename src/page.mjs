export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>疯狂水世界</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.6 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; background: #14161a; color: #d5dae1; }
  header { padding: 10px 16px 0; border-bottom: 1px solid #262a31; }
  .headline { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  h2 { font-size: 12px; margin: 16px 0 6px; color: #7c8695; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  button { font: inherit; padding: 5px 12px; border: 1px solid #3a4150; background: #21252c; color: #d5dae1; border-radius: 4px; cursor: pointer; }
  button:hover:not(:disabled) { background: #2b313a; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { border-color: #3f6b4a; background: #21301f; }
  button.danger { border-color: #6b3f3f; background: #2c1f1f; }
  button.tiny { padding: 2px 8px; font-size: 12px; }
  nav { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
  nav button { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-color: transparent; }
  nav button.on { background: #262b33; border-color: #3a4150; border-bottom-color: #262b33; color: #fff; }
  main { padding: 14px 16px 40px; }
  .ok { color: #6fd08c; } .bad { color: #f08a8a; } .warn { color: #e0bd6a; } .dim { color: #7c8695; }
  select, input { font: inherit; background: #101317; color: #d5dae1; border: 1px solid #2f353f; border-radius: 4px; padding: 5px 8px; }
  select { min-width: 160px; }
  input { width: 220px; }
  input[type=checkbox] { width: auto; }
  section { border: 1px solid #262a31; border-radius: 6px; background: #191c21; padding: 12px 14px; margin-bottom: 14px; }
  section.hidden { display: none; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .bar .k { font-size: 11px; color: #7c8695; letter-spacing: .6px; }
  .who { display: flex; gap: 22px; flex-wrap: wrap; align-items: center; }
  .who .item { display: flex; flex-direction: column; }
  .who .item .k { font-size: 11px; color: #7c8695; }
  .who .item .v { font-size: 16px; }
  .icons { display: flex; flex-wrap: wrap; gap: 8px; }
  .cell { display: flex; align-items: center; gap: 6px; border: 1px solid #262a31; border-radius: 5px; background: #12151a; padding: 4px 8px 4px 4px; min-width: 108px; }
  .cell .txt { display: flex; flex-direction: column; line-height: 1.25; }
  .cell .nm { font-size: 12px; }
  .cell .qty { font-size: 11px; color: #7c8695; }
  .ico { display: inline-block; position: relative; overflow: hidden; flex: none; border-radius: 3px; background: #1d2129; }
  .ico .atlas { position: absolute; top: 0; left: 0; background-repeat: no-repeat; transform-origin: 0 0; }
  .ico .fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #7c8695; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid #22262d; font-weight: 400; vertical-align: middle; }
  th { color: #7c8695; font-size: 11px; letter-spacing: .6px; }
  td.num, th.num { text-align: right; }
  .chip { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 11px; border: 1px solid; }
  .chip.ready, .chip.done { color: #6fd08c; border-color: #2f5b3d; }
  .chip.paid { color: #e0bd6a; border-color: #5f5230; }
  .chip.partial, .chip.waiting { color: #8fb8f0; border-color: #33506b; }
  .chip.blocked, .chip.error, .chip.unknown { color: #8a93a1; border-color: #3a4150; }
  .who-cell { display: flex; align-items: center; gap: 6px; }
  #log { border: 1px solid #262a31; border-radius: 6px; background: #101317; height: 220px; overflow: auto; padding: 6px 8px; }
  .row { white-space: pre-wrap; word-break: break-all; padding: 1px 0; }
  .row .ts { color: #5c6673; }
  .row.state { color: #8fb8f0; } .row.error { color: #f08a8a; } .row.warn { color: #e0bd6a; } .row.info { color: #d5dae1; }
  .acct { border: 1px solid #262a31; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: #12151a; }
  .acct.on { border-color: #3f6b4a; }
  .acct .top { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .acct .title { font-size: 14px; }
  .acct .id { color: #7c8695; font-size: 12px; }
  pre { margin: 8px 0 0; padding: 8px; background: #101317; border: 1px solid #2f353f; border-radius: 4px; white-space: pre-wrap; color: #b8e0a0; max-height: 300px; overflow: auto; }
  .kv { display: grid; grid-template-columns: 120px 1fr; gap: 2px 10px; margin-top: 6px; }
  .kv .k { color: #7c8695; }
  .kv .v { word-break: break-all; }
  .qr { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
  .qr img, .qr svg { width: 220px; height: 220px; background: #fff; padding: 8px; border-radius: 6px; }
  .steps { margin: 6px 0 0; padding-left: 20px; color: #b9c2ce; }
  .steps li { margin: 2px 0; }
  #modal { position: fixed; inset: 0; background: rgba(8,10,13,.72); display: flex; align-items: center; justify-content: center; }
  #modal.hidden { display: none; }
  #modal .sheet { width: min(560px, 92vw); background: #191c21; border: 1px solid #3a4150; border-radius: 8px; padding: 16px 18px; }
  #modal h3 { margin: 0 0 10px; font-size: 15px; }
  #modal .body { color: #b9c2ce; }
  #modal .body code { background: #101317; padding: 1px 4px; border-radius: 3px; }
  #modal .ack { display: block; margin: 12px 0; }
  #modal .foot { display: flex; gap: 10px; align-items: center; }
</style>
</head>
<body>
<header>
  <div class="headline">
    <h1>疯狂水世界</h1>
    <select id="account" title="选择账号"></select>
    <button id="connect" class="primary">连接</button>
    <button id="disconnect">断开</button>
    <span id="busy" class="dim"></span>
    <span id="hint" class="warn"></span>
  </div>
  <nav id="tabs">
    <button data-tab="overview" class="on">总览</button>
    <button data-tab="idle">挂机</button>
    <button data-tab="heroes">英雄</button>
    <button data-tab="dailies">日常</button>
    <button data-tab="account">账号</button>
  </nav>
</header>
<main>
  <section id="tab-overview">
    <div class="who" id="who"><span class="dim">还没连上。点右上角「连接」，或先去「账号」页添加账号。</span></div>
    <h2>一键领取</h2>
    <div class="bar">
      <button id="loot-run" class="primary">领取现在能领的</button>
      <span id="loot-hint" class="warn"></span>
    </div>
    <pre id="loot-view">主线、成就、邮件、挂机收益，能领的都领一遍。不花钻石。</pre>
    <h2>资源</h2><div class="icons" id="res"><span class="dim">连接后显示</span></div>
    <h2>库存</h2><div class="icons" id="items"><span class="dim">连接后显示</span></div>
    <h2>主力英雄</h2><div class="icons" id="hero-strip"><span class="dim">连接后显示</span></div>
    <h2>运行记录</h2>
    <div id="log"></div>
  </section>

  <section id="tab-idle" class="hidden">
    <div class="bar">
      <span class="k">自动循环</span>
      <label class="dim">轮数 <input id="loop-rounds" value="0" style="width:56px"></label>
      <label class="dim">间隔秒 <input id="loop-every" value="60" style="width:64px"></label>
      <label class="dim"><input type="checkbox" id="world-speedup"> 允许花加速器</label>
      <label class="dim"><input type="checkbox" id="world-reroll"> 拒绝重刷订单</label>
      <label class="dim"><input type="checkbox" id="world-pick" checked> 自动拾荒</label>
      <button id="loop-start" class="primary">开始挂机</button>
      <button id="loop-stop" class="danger">停止</button>
      <span id="loop-hint" class="warn"></span>
    </div>
    <pre id="loop-view">轮数填 0 表示一直跑。每轮按「任务领取 → 日常 → 海面」的顺序重新探测后再执行。钻石与付费礼包永不动，加速只花加速器。</pre>

    <h2>任务奖励</h2>
    <div class="bar">
      <button id="tasks-plan">检查可领</button>
      <button id="tasks-run" class="primary">领取任务奖励</button>
      <span id="tasks-hint" class="warn"></span>
    </div>
    <pre id="tasks-view">主线、支线、成就、每日订单档位。算不出目标值的会跳过。</pre>

    <h2>海面</h2>
    <div class="bar">
      <button id="world-plan">探测计划</button>
      <button id="world-run" class="primary">执行一轮</button>
      <span id="world-hint" class="warn"></span>
    </div>
    <pre id="world-view">收成品 → 竣工 → 交单 → 按订单缺口排产 → 余料升级建筑。</pre>
    <div id="world-factories"></div>
    <div id="world-orders"></div>
    <h2>仓库</h2><div class="icons" id="world-stock"></div>
    <h2>资源田</h2><pre id="world-fields"></pre>
  </section>

  <section id="tab-heroes" class="hidden">
    <div class="bar">
      <button id="hero-plan">计算计划</button>
      <button id="hero-run" class="primary">执行养成</button>
      <span id="hero-hint" class="warn"></span>
    </div>
    <pre id="hero-view">升级、升星、升技能的条件取自游戏客户端的红点逻辑；执行前会先算一遍计划。</pre>
    <div id="hero-table"></div>
  </section>

  <section id="tab-dailies" class="hidden">
    <div class="bar">
      <button id="dailies-plan">探测</button>
      <button id="dailies-run" class="primary">一键完成</button>
      <label class="dim"><input type="checkbox" id="dailies-paid"> 允许花钻石（默认关闭）</label>
      <span id="dailies-hint" class="warn"></span>
    </div>
    <pre id="dailies-view">先「探测」看看现在能做哪些、为什么不能做。点金与折扣店默认跳过，勾上才会花钻石。</pre>
    <div id="dailies-table"></div>
  </section>

  <section id="tab-account" class="hidden">
    <h2>账号</h2>
    <div id="accounts"></div>

    <h2>凭证</h2>
    <div class="bar">
      <button id="cred-show">显示凭证</button>
      <button id="cred-hide">收起</button>
      <span class="dim">凭证是本机的明文文件，只在这台电脑上用</span>
    </div>
    <div id="cred"></div>

    <h2>区服</h2>
    <div class="bar">
      <button id="load-worlds">加载区服</button>
      <input id="world-input" placeholder="worldId" style="width:130px">
      <button id="enter-world">进入该区服</button>
      <span id="worlds-hint" class="warn"></span>
    </div>
    <div id="worlds"></div>

    <h2>添加账号</h2>
    <div class="bar">
      <button id="cap-start" class="primary">扫码添加</button>
      <button id="cap-stop" class="danger">停止抓包</button>
      <span id="cap-hint" class="warn"></span>
    </div>
    <div id="cap-box"></div>
  </section>
</main>

<div id="modal" class="hidden">
  <div class="sheet">
    <h3 id="m-title"></h3>
    <div class="body" id="m-body"></div>
    <label class="ack"><input type="checkbox" id="m-ack"> 我明白上面要改的东西，结束时会自动还原</label>
    <div class="foot">
      <button id="m-ok" class="primary" disabled>确认</button>
      <button id="m-cancel">取消</button>
      <span id="m-count" class="dim"></span>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const logEl = $('log');

// 同一个页面只伺候一个账号：所有请求都带 ?account=<当前选中>。
let current = null;
let accounts = [];
let stream = null;

function num(v) {
  if (v == null || typeof v !== 'object') return v;
  return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
}

function fmt(v) {
  const n = num(v);
  if (typeof n !== 'number') return String(n == null ? '-' : n);
  return n.toLocaleString('zh-CN');
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function call(path, options) {
  const opts = options || {};
  let url = path;
  if (current && url.indexOf('/api/') === 0 && url.indexOf('account=') < 0) {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'account=' + encodeURIComponent(current);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  node.textContent = '';
  return node;
}

// ---- 图标 ------------------------------------------------------------------
// 图集页整张给到浏览器，靠 CSS 裁。FGUI 里约 15% 的图是转 90 度打包的，
// 这些要把裁好的矩形转回来再摆正，否则显示出来是躺着的。

function iconEl(entry, size, name) {
  const box = el('span', 'ico');
  box.style.width = size + 'px';
  box.style.height = size + 'px';
  if (!entry) {
    box.appendChild(el('span', 'fallback', (name || '?').slice(0, 1)));
    box.title = name || '';
    return box;
  }
  // 显示尺寸就是矩形本身 w×h，转不转都一样。
  const k = size / Math.max(entry.w, entry.h);
  const wrap = el('span', 'ico');
  wrap.style.width = Math.round(entry.w * k) + 'px';
  wrap.style.height = Math.round(entry.h * k) + 'px';
  const inner = el('i', 'atlas');
  // 但旋转打包的贴图在图集里占的是 h 宽、w 高（跟显示尺寸正好差一个 90 度），
  // 所以元素盒子要按 h×w 铺，再整体转回来：占位 [0,w*k]×[0,h*k] 就是显示尺寸。
  inner.style.width = (entry.rotated ? entry.h : entry.w) + 'px';
  inner.style.height = (entry.rotated ? entry.w : entry.h) + 'px';
  inner.style.backgroundImage = 'url(' + entry.url + ')';
  inner.style.backgroundPosition = '-' + entry.x + 'px -' + entry.y + 'px';
  inner.style.transform = entry.rotated
    ? 'translate(0,' + Math.round(entry.h * k) + 'px) rotate(-90deg) scale(' + k + ')'
    : 'scale(' + k + ')';
  inner.title = name || '';
  wrap.appendChild(inner);
  return wrap;
}

// 一项东西：图标 + 名字 + 数量
function cell(entry, size, name, qty) {
  const node = el('div', 'cell');
  node.appendChild(iconEl(entry, size || 34, name));
  const txt = el('div', 'txt');
  txt.appendChild(el('span', 'nm', name || '?'));
  if (qty != null) txt.appendChild(el('span', 'qty', qty));
  node.appendChild(txt);
  return node;
}

function chip(status, text) {
  return el('span', 'chip ' + status, text);
}

// ---- 弹窗 ------------------------------------------------------------------
// 抓包要改系统设置，所以确认做得重一点：先勾选，再等倒计时，两样都满足才能点。

let modalTimer = null;
function closeModal() {
  $('modal').classList.add('hidden');
  if (modalTimer) clearInterval(modalTimer);
  modalTimer = null;
  $('m-ok').onclick = null;
}
function canConfirm(seconds) {
  return $('m-ack').checked && seconds <= 0;
}
function openConfirm(title, bodyNodes, onOk) {
  $('m-title').textContent = title;
  const body = clear($('m-body'));
  for (const node of bodyNodes) body.appendChild(node);
  $('m-ack').checked = false;
  $('m-ok').disabled = true;
  let left = 3;
  $('m-count').textContent = '请先勾选，' + left + ' 秒后可确认';
  modalTimer = setInterval(() => {
    left -= 1;
    $('m-ok').disabled = !canConfirm(left);
    $('m-count').textContent = left > 0 ? '请先勾选，' + left + ' 秒后可确认' : ($('m-ack').checked ? '' : '还需要勾选上面的选项');
    if (left <= 0) {
      clearInterval(modalTimer);
      modalTimer = null;
    }
  }, 1000);
  $('m-ack').onchange = () => {
    $('m-ok').disabled = !canConfirm(left);
    if (left <= 0 && !$('m-ack').checked) $('m-count').textContent = '还需要勾选上面的选项';
    else if (left <= 0) $('m-count').textContent = '';
  };
  $('m-ok').onclick = async () => {
    const run = onOk;
    closeModal();
    try {
      await run();
    } catch (error) {
      $('hint').textContent = error.message;
    }
  };
  $('modal').classList.remove('hidden');
}
$('m-cancel').onclick = closeModal;

async function confirmRun(title, lines, path, body) {
  openConfirm(title, lines.map((text) => el('div', null, text)), async () => {
    const data = await call(path, { method: 'POST', body: JSON.stringify(body || { confirm: true }) });
    return data;
  });
}

// ---- 运行记录 --------------------------------------------------------------
const seen = new Set();
function appendLog(entry) {
  if (entry.extra && entry.extra.detail) return;
  const row = el('div', 'row ' + entry.level);
  row.appendChild(el('span', 'ts', '[' + new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false }) + '] '));
  row.appendChild(document.createTextNode(entry.message));
  logEl.appendChild(row);
  while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function subscribe() {
  if (stream) stream.close();
  stream = new EventSource('/api/events' + (current ? '?account=' + encodeURIComponent(current) : ''));
  stream.onmessage = (event) => {
    const entry = JSON.parse(event.data);
    const key = entry.t + '|' + entry.message;
    if (seen.has(key)) return;
    seen.add(key);
    appendLog(entry);
  };
}

// ---- 账号 ------------------------------------------------------------------
let snapshot = { connected: false, state: 'IDLE', busy: null, looping: false };

function renderAccountSelect() {
  const box = clear($('account'));
  if (!accounts.length) {
    box.appendChild(new Option('没有账号', ''));
    box.disabled = true;
  } else {
    box.disabled = false;
    for (const account of accounts) {
      const option = new Option(account.title + (account.active ? '（当前）' : ''), account.id);
      box.appendChild(option);
    }
    box.value = current || '';
  }
  $('connect').disabled = snapshot.connected || !accounts.length;
  $('disconnect').disabled = !snapshot.connected;
}

async function loadAccounts(reload) {
  const data = await call('/api/accounts');
  accounts = data.accounts;
  if (!current && data.activeId) current = data.activeId;
  if (current && !accounts.some((a) => a.id === current)) current = data.activeId;
  renderAccountSelect();
  if (reload) {
    subscribe();
    refreshOverview();
  }
}

$('account').onchange = async () => {
  current = $('account').value;
  await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: current }) });
  seen.clear();
  clear(logEl);
  subscribe();
  refreshOverview();
};

$('connect').onclick = async () => {
  $('hint').textContent = '正在连接 ...';
  try {
    await call('/api/connect', { method: 'POST' });
    $('hint').textContent = '';
  } catch (error) {
    $('hint').textContent = error.message;
  }
};
$('disconnect').onclick = async () => {
  await call('/api/disconnect', { method: 'POST' });
};

// ---- 总览 ------------------------------------------------------------------
function renderWho(view) {
  const box = clear($('who'));
  const role = view.player || {};
  const account = view.account || {};
  const status = view.status || {};
  const items = [
    ['账号', account.title || '-'],
    ['角色', role.nickname || '-'],
    ['等级', role.level == null ? '-' : String(role.level)],
    ['战力', fmt(role.power)],
    ['区服', role.worldId == null ? '-' : String(role.worldId)],
    ['状态', status.connected ? '已连接' : '未连接'],
  ];
  for (const [k, v] of items) {
    const cellBox = el('div', 'item');
    cellBox.appendChild(el('span', 'k', k));
    cellBox.appendChild(el('span', 'v', v));
    box.appendChild(cellBox);
  }
  if (view.afk) {
    const afk = el('div', 'item');
    afk.appendChild(el('span', 'k', '挂机'));
    afk.appendChild(el('span', 'v', '等级 ' + (view.afk.level ?? '-') + '，待领 ' + (view.afk.pendingLevels ?? 0)));
    box.appendChild(afk);
  }
}

function renderOverview(data) {
  renderWho(data);
  const res = clear($('res'));
  for (const entry of data.resources || []) res.appendChild(cell(entry.icon, 34, entry.name || String(entry.res), fmt(entry.amount)));
  if (!res.childElementCount) res.appendChild(el('span', 'dim', '暂无数据'));

  const items = clear($('items'));
  for (const entry of (data.items && data.items.top) || []) items.appendChild(cell(entry.icon, 34, entry.itemId, 'x' + fmt(entry.num)));
  if (!items.childElementCount) items.appendChild(el('span', 'dim', '暂无数据'));

  const heroes = clear($('hero-strip'));
  for (const hero of (data.heroes && data.heroes.list) || []) {
    heroes.appendChild(cell(hero.icon, 40, hero.heroId, 'lv' + hero.level + ' · ' + hero.star + '星'));
  }
  if (!heroes.childElementCount) heroes.appendChild(el('span', 'dim', '暂无数据'));
}

async function refreshOverview() {
  try {
    const data = await call('/api/overview');
    snapshot = data.status;
    renderAccountSelect();
    renderOverview(data);
    $('hint').textContent = '';
    $('busy').textContent = data.status.busy ? '执行中: ' + data.status.busy : '';
  } catch (error) {
    $('hint').textContent = error.message;
  }
}

$('loot-run').onclick = () => {
  openConfirm('领取能领的奖励', [
    el('div', null, '会依次处理：主线与支线任务奖励、成就奖励、邮件附件、挂机收益。'),
    el('div', null, '每日任务的免费部分也会顺带做完（竞技场、试炼等）；点金与折扣店不碰，不花钻石。'),
  ], async () => {
    $('loot-hint').textContent = '领取中 ...';
    try {
      const tasks = await call('/api/tasks/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      const daily = await call('/api/dailies/run', { method: 'POST', body: JSON.stringify({ confirm: true, paid: false }) });
      const failed = tasks.results.filter((r) => r.ok === false).length + daily.results.filter((r) => r.ok === false).length;
      $('loot-hint').textContent = '任务 ' + tasks.results.length + ' 条，日常动作 ' + daily.results.length + ' 个，领取奖励 ' + daily.claimed.length + ' 个' + (failed ? '，失败 ' + failed : '');
      $('loot-view').textContent = tasks.text + String.fromCharCode(10) + daily.text;
    } catch (error) {
      $('loot-hint').textContent = error.message;
    }
  });
};

// ---- 挂机 ------------------------------------------------------------------
const HERO_STATUS = { ready: '可做', done: '已完成', blocked: '不可做' };

function renderLoop(data) {
  $('loop-start').disabled = data.running;
  $('loop-stop').disabled = !data.running;
  $('loop-hint').textContent = (data.running ? '挂机中，已完成 ' : '未在挂机，累计 ') + data.completed + ' 轮' + (data.error ? '，中止: ' + data.error : '');
  if (!data.history.length) {
    $('loop-view').textContent = data.running ? '第一轮进行中 ...' : '还没跑过。点「开始挂机」按上面的设置跑起来。';
    return;
  }
  const lines = data.history.map((entry) => entry.text);
  $('loop-view').textContent = lines.join(String.fromCharCode(10, 10));
}

async function refreshLoop() {
  try {
    renderLoop(await call('/api/loop'));
  } catch {
    /* 没连上时静默 */
  }
}

$('loop-start').onclick = async () => {
  try {
    await call('/api/loop/start', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        rounds: Number($('loop-rounds').value || 0),
        everySeconds: Number($('loop-every').value || 60),
        speedUp: $('world-speedup').checked,
        reroll: $('world-reroll').checked,
        pickFloaters: $('world-pick').checked,
      }),
    });
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = error.message;
  }
};
$('loop-stop').onclick = async () => {
  try {
    await call('/api/loop/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = error.message;
  }
};

$('tasks-plan').onclick = async () => {
  $('tasks-hint').textContent = '检查中 ...';
  try {
    const data = await call('/api/tasks');
    $('tasks-hint').textContent = '可领 ' + data.plan.length + ' 条';
    $('tasks-view').textContent = data.text;
  } catch (error) {
    $('tasks-hint').textContent = error.message;
  }
};
$('tasks-run').onclick = () => confirmRun('领取任务奖励', [
  '会领取主线（成长任务）、支线、成就与每日订单档位里已经完成的奖励。',
], '/api/tasks/run', { confirm: true });

function renderWorld(data) {
  $('world-view').textContent = data.text;
  const fbox = clear($('world-factories'));
  // 空位：没盖的（待建）与正在盖的（施工中）。计划器只会建「待建」那些，
  // 施工中的只能等它盖完由竣工步骤收尾，所以两种状态要分开说，不然看不出差在哪。
  const slots = (data.buildings || []).filter((b) => b.level === 0);
  if (slots.length) {
    fbox.appendChild(el('h2', null, '空位'));
    fbox.appendChild(table(['空位', '类型', '状态'], slots.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.type || '未知类型',
      b.building ? chip('waiting', '施工中') : chip('ready', '待建'),
    ])));
  }
  if (data.factories.length) {
    fbox.appendChild(el('h2', null, '工厂'));
    fbox.appendChild(table(['建筑', '类型', '等级', '队列', '自动生产'], data.factories.map((b) => [
      { cell: b.icon, text: b.buildingId },
      b.type,
      'lv' + b.level,
      String(b.queue),
      b.auto ? '自动: ' + b.auto : '',
    ])));
  }
  const obox = clear($('world-orders'));
  if (data.orders.length) {
    obox.appendChild(el('h2', null, '居民订单'));
    obox.appendChild(table(['订单', '居民', '需求', '缺口'], data.orders.map((o) => [
      '#' + o.index,
      { cell: null, text: o.workerId + (o.isSpecial ? '（特殊）' : '') },
      { cells: o.requirements },
      o.missing.length === 0 ? chip('done', '材料齐') : { cells: o.missing, prefix: '缺 ' },
    ])));
  }
  const sbox = clear($('world-stock'));
  for (const entry of data.stock) sbox.appendChild(cell(entry.icon, 30, entry.id, fmt(entry.num)));
  if (!sbox.childElementCount) sbox.appendChild(el('span', 'dim', '仓库空'));
  $('world-fields').textContent = data.resFields.text || '';
}

$('world-plan').onclick = async () => {
  $('world-hint').textContent = '探测中 ...';
  try {
    // 计划要跟着勾选状态走，否则「探测计划」比「执行一轮」少几行，看着像 bug。
    renderWorld(await call('/api/world?pick=' + ($('world-pick').checked ? '1' : '0')));
    $('world-hint').textContent = '';
  } catch (error) {
    $('world-hint').textContent = error.message;
  }
};
$('world-run').onclick = () => {
  openConfirm('执行一轮海面自动化', [
    el('div', null, '会收成品、竣工、交居民订单、按缺口排产、把余料拿去升级建筑。'),
    el('div', null, '加速只花加速器（' + ($('world-speedup').checked ? '当前允许' : '当前不允许') + '），钻石与付费礼包永不购买。'),
    el('div', null, $('world-pick').checked ? '会顺带扫海面漂浮物（拾荒），捡完打印所得。' : '未勾「自动拾荒」，不会动海面漂浮物。'),
  ], async () => {
    $('world-hint').textContent = '执行中 ...';
    try {
      const body = {
        confirm: true,
        speedUp: $('world-speedup').checked,
        reroll: $('world-reroll').checked,
        pickFloaters: $('world-pick').checked,
      };
      const data = await call('/api/world/run', { method: 'POST', body: JSON.stringify(body) });
      const failed = data.results.filter((r) => r.ok === false).length;
      $('world-hint').textContent = '执行 ' + data.results.length + ' 个动作，失败 ' + failed
        + (data.floaterText ? ' ｜ ' + data.floaterText : '');
      renderWorld(data);
    } catch (error) {
      $('world-hint').textContent = error.message;
    }
  });
};

// ---- 英雄 ------------------------------------------------------------------
// 技能是一串等级，原始形状是 [1,0,0,0]，直接摆给用户看没意义，只说练了几项。
function skillText(levels) {
  const list = levels || [];
  if (!list.length) return '—';
  const raised = list.filter((level) => level > 0);
  return raised.length ? '已升 ' + raised.length + '/' + list.length : '未升级';
}

function renderHeroes(data) {
  $('hero-view').textContent = data.text;
  const box = clear($('hero-table'));
  box.appendChild(table(['英雄', '等级', '星级', { label: '战力', num: true }, '技能'], data.heroes.map((hero) => [
    { cell: hero.head || hero.icon, text: hero.heroId },
    'lv' + hero.level,
    hero.star + ' 星',
    { num: true, text: fmt(hero.power) },
    skillText(hero.skillLevels),
  ])));
}

$('hero-plan').onclick = async () => {
  $('hero-hint').textContent = '计算中 ...';
  try {
    renderHeroes(await call('/api/heroes'));
    $('hero-hint').textContent = '';
  } catch (error) {
    $('hero-hint').textContent = error.message;
  }
};
$('hero-run').onclick = () => {
  openConfirm('执行英雄养成计划', [
    el('div', null, '按计算出来的计划升级、升星、升技能，会消耗英雄经验、碎片与技能书。'),
  ], async () => {
    $('hero-hint').textContent = '执行中 ...';
    try {
      const data = await call('/api/heroes/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      $('hero-hint').textContent = '发出 ' + data.sent + ' 个请求，失败 ' + data.failed + '，耗时 ' + Math.round(data.ms / 1000) + 's';
      $('hero-plan').onclick();
    } catch (error) {
      $('hero-hint').textContent = error.message;
    }
  });
};

// ---- 日常 ------------------------------------------------------------------
const DAILY_LABEL = { ready: '可做', paid: '需付费', partial: '部分可做', waiting: '等待中', done: '已完成', blocked: '不可用', error: '出错', unknown: '未知' };

function renderDailies(data) {
  const box = clear($('dailies-table'));
  box.appendChild(table(['任务', '进度', '状态', '动作 / 原因'], data.tasks.map((entry) => [
    entry.task.title,
    entry.task.progress + '/' + entry.task.targetProgress,
    chip(entry.status, DAILY_LABEL[entry.status] || entry.status),
    entry.status === 'ready' || entry.status === 'paid'
      ? (entry.actions || []).map((a) => a.cost || a.request).join('；') || '直接完成'
      : (entry.reason || ''),
  ])));
  if (data.chests) {
    const line = (label, chest) => {
      const tiers = chest.tiers || [];
      const tail = tiers.length
        ? '第 ' + tiers.map((t2) => t2.id).join(' / ') + ' 档'
        : (chest.nextAt == null ? '这一季的档位都领完了' : '下一档要 ' + chest.nextAt + ' 点活跃');
      return [label, chest.activity + ' 活跃', chip(tiers.length ? 'ready' : 'done', tiers.length ? '可领' : '不欠'), tail];
    };
    box.appendChild(table(['活跃奖励', '活跃度', '状态', '动作 / 原因'], [
      line('每日宝箱', data.chests.daily),
      line('每周宝箱', data.chests.weekly),
    ]));
  }
  if (data.gift) {
    const free = data.gift.freeAvailable;
    box.appendChild(table(['每日礼包', '状态', '动作 / 原因'], [
      ['每日精选赠礼', chip(free ? 'ready' : 'done', free ? '可领' : '已领'),
        free ? '免费，一键领取会顺手领掉' : '今天那份已经领过了，明天 0 点重置'],
    ]));
  }
  $('dailies-view').textContent = data.text + String.fromCharCode(10) + '钻石 ' + fmt(data.ruby) + '（本工具不主动花钻石）';
}

$('dailies-plan').onclick = async () => {
  $('dailies-hint').textContent = '探测中 ...';
  try {
    renderDailies(await call('/api/dailies'));
    $('dailies-hint').textContent = '';
  } catch (error) {
    $('dailies-hint').textContent = error.message;
  }
};
$('dailies-run').onclick = () => {
  const paid = $('dailies-paid').checked;
  openConfirm('一键完成日常', [
    el('div', null, '会做完现在能做的日常任务并领取奖励，包含竞技场战斗、主线战斗、试炼挑战。'),
    el('div', null, paid ? '会花钻石：点金与折扣店也在范围内。' : '不花钻石：点金与折扣店会跳过。'),
  ], async () => {
    $('dailies-hint').textContent = '执行中 ...';
    try {
      const data = await call('/api/dailies/run', { method: 'POST', body: JSON.stringify({ confirm: true, paid }) });
      $('dailies-hint').textContent = '完成 ' + data.results.filter((r) => r.ok).length + ' 个动作，失败 ' + data.results.filter((r) => r.ok === false).length + '，领取奖励 ' + data.claimed.length + ' 个，耗时 ' + Math.round(data.ms / 1000) + 's';
      renderDailies(data);
    } catch (error) {
      $('dailies-hint').textContent = error.message;
    }
  });
};

// ---- 表格 ------------------------------------------------------------------
// 单元格可以是字符串、{num}、{chip}、{cell: 图标项}、{cells: [图标项]}
function putCell(td, spec) {
  if (spec == null) return;
  if (typeof spec !== 'object') {
    td.textContent = spec;
    return;
  }
  if (spec.num) {
    td.className = 'num';
    td.textContent = spec.text;
    return;
  }
  if (spec.chip) {
    td.appendChild(chip(spec.chip, spec.text));
    return;
  }
  if (spec.cell !== undefined || spec.cells) {
    const list = spec.cells || [spec.cell];
    if (spec.prefix) td.appendChild(el('span', 'dim', spec.prefix));
    for (const entry of list) {
      const who = el('span', 'who-cell');
      who.appendChild(iconEl(entry && entry.icon, 26, entry ? entry.id : ''));
      who.appendChild(el('span', null, entry ? entry.id + (entry.num != null ? ' x' + fmt(entry.num) : '') : spec.text));
      td.appendChild(who);
      td.appendChild(document.createTextNode(' '));
    }
    if (!list.length) td.appendChild(el('span', 'dim', '齐'));
    return;
  }
  td.textContent = spec.text || '';
}

function table(headers, rows) {
  const box = el('table');
  const head = el('tr');
  for (const h of headers) {
    const th = el('th', typeof h === 'string' ? null : (h.num ? 'num' : null), typeof h === 'string' ? h : h.label);
    head.appendChild(th);
  }
  box.appendChild(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const spec of row) {
      const td = el('td');
      putCell(td, spec);
      tr.appendChild(td);
    }
    box.appendChild(tr);
  }
  return box;
}

// ---- 账号页 ----------------------------------------------------------------
async function renderAccounts() {
  const box = clear($('accounts'));
  if (!accounts.length) {
    box.appendChild(el('div', 'dim', '还没有账号。先在下面用「扫码添加」，或跑 node tools/capture-credentials.mjs。'));
    return;
  }
  for (const account of accounts) {
    const card = el('div', 'acct' + (account.id === current ? ' on' : ''));
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', account.title));
    top.appendChild(el('span', 'id', account.id.slice(0, 10) + '…'));
    if (account.id === current) top.appendChild(chip('done', '当前'));
    const seenInfo = account.lastSeen
      ? '上次 ' + (account.lastSeen.nickname || '?') + ' lv' + (account.lastSeen.level ?? '?') + ' 战力' + fmt(account.lastSeen.power) + ' @' + when(account.lastSeen.at)
      : '还没连过';
    top.appendChild(el('span', 'id', seenInfo));
    const use = el('button', 'tiny', account.id === current ? '已选中' : '切换到它');
    use.disabled = account.id === current;
    use.onclick = async () => {
      current = account.id;
      await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id }) });
      await loadAccounts(true);
      renderAccounts();
    };
    const rename = el('button', 'tiny', '改备注');
    rename.onclick = async () => {
      const label = prompt('给这个账号起个名字', account.title);
      if (label == null) return;
      await call('/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id, label }) });
      await loadAccounts(false);
      renderAccounts();
    };
    const drop = el('button', 'tiny danger', '删除');
    drop.onclick = async () => {
      if (!window.confirm('删掉「' + account.title + '」？只删本机这份凭证，游戏账号不受影响。')) return;
      await call('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ confirm: true, id: account.id }) });
      await loadAccounts(true);
      renderAccounts();
    };
    top.append(use, rename, drop);
    card.appendChild(top);
    box.appendChild(card);
  }
}

$('cred-show').onclick = async () => {
  $('cred-show').disabled = true;
  try {
    const data = await call('/api/accounts/credential?reveal=1');
    const box = clear($('cred'));
    const rows = [
      ['账号', data.title + '（' + data.id + '）'],
      ['openId', data.raw.openId || '-'],
      ['token', data.raw.token || '-'],
      ['sign', data.raw.sign || '-'],
      ['timestamp', data.raw.timestamp == null ? '-' : String(num(data.raw.timestamp))],
      ['网关', data.url],
      ['抓于', when(data.capturedAt)],
    ];
    const kv = el('div', 'kv');
    for (const [k, v] of rows) {
      kv.appendChild(el('div', 'k', k));
      kv.appendChild(el('div', 'v', v));
    }
    box.appendChild(kv);
    box.appendChild(el('div', 'dim', '登录帧原始数据（' + (data.loginFrameHex || '').length + ' 个十六进制字符）'));
    box.appendChild(el('pre', null, data.loginFrameHex || '（没有保存）'));
  } catch (error) {
    $('hint').textContent = error.message;
  }
  $('cred-show').disabled = false;
};
$('cred-hide').onclick = () => clear($('cred')).appendChild(el('span', 'dim', '已收起，点「显示凭证」再看'));

async function renderWorlds() {
  const data = await call('/api/worlds');
  const box = clear($('worlds'));
  for (const world of data.recentWorlds) {
    const role = world.role || {};
    const row = el('div', 'acct');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', String(world.worldId)));
    if (role.worldId && role.worldId !== world.worldId) top.appendChild(el('span', 'id', '合服后 -> ' + role.worldId));
    top.appendChild(el('span', 'id', (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power) + ' 上次登录 ' + when(role.lastLoginTime)));
    const enter = el('button', 'tiny', '进入');
    enter.onclick = () => enterWorld(world.worldId);
    top.appendChild(enter);
    row.appendChild(top);
    box.appendChild(row);
  }
  if (!data.recentWorlds.length) box.appendChild(el('div', 'dim', '这个账号下没有区服'));
  else box.appendChild(el('div', 'dim', '共 ' + data.recentWorlds.length + ' 个区服，分组 ' + data.latestGroupId));
}

async function enterWorld(worldId) {
  $('worlds-hint').textContent = '进入 ' + worldId + ' ...';
  try {
    const data = await call('/api/worlds/enter', { method: 'POST', body: JSON.stringify({ confirm: true, worldId, fromWorldId: 0 }) });
    const role = data.player || {};
    $('worlds-hint').textContent = '已在 ' + worldId + '：' + (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power);
    await loadAccounts(false);
    renderAccounts();
    refreshOverview();
  } catch (error) {
    $('worlds-hint').textContent = error.message;
  }
}

$('load-worlds').onclick = async () => {
  $('worlds-hint').textContent = '加载中 ...';
  try {
    await renderWorlds();
    $('worlds-hint').textContent = '';
  } catch (error) {
    $('worlds-hint').textContent = error.message;
  }
};
$('enter-world').onclick = () => {
  const worldId = Number($('world-input').value.trim());
  if (!worldId) {
    $('worlds-hint').textContent = '先填 worldId';
    return;
  }
  enterWorld(worldId);
};

// ---- 添加账号：二维码 + 一键抓包 -------------------------------------------
let capturePoll = null;

function renderCapture(state) {
  const hint = $('cap-hint');
  const box = clear($('cap-box'));
  $('cap-start').disabled = state.running;
  $('cap-stop').disabled = !state.running;
  hint.textContent = state.error ? state.error : (state.running ? '抓包中：' + (state.phase === 'waiting' ? '等游戏登录' : state.phase) : '');
  hint.className = state.error ? 'bad' : 'warn';

  if (state.running) {
    const steps = el('ol', 'steps');
    const lines = state.qr && state.qr.kind !== 'none'
      ? ['手机上用微信扫下面的码（或在电脑版微信里识别它），让游戏跑起来', '游戏会启动并发登录包，本机代理抓到就算添加成功', '抓到后会自动关掉代理并卸掉证书，不用手动收尾']
      : ['在电脑版微信里打开《疯狂水世界》小游戏', '游戏会启动并发登录包，本机代理抓到就算添加成功', '抓到后会自动关掉代理并卸掉证书，不用手动收尾'];
    for (const text of lines) steps.appendChild(el('li', null, text));
    const qr = el('div', 'qr');
    const side = el('div', null, '');
    if (state.qr && state.qr.kind === 'image') {
      const img = el('img');
      img.src = state.qr.url + '?t=' + Date.now();
      img.alt = '小程序码';
      qr.appendChild(img);
    } else if (state.qr && state.qr.kind === 'svg') {
      const holder = el('div');
      holder.innerHTML = state.qr.svg;
      qr.appendChild(holder);
    } else {
      side.appendChild(el('div', 'dim', '没有可用的二维码。把游戏的小程序码存成 data/qrcode.png 就会显示在这里；现在按下面的步骤手动开游戏就行。'));
    }
    if (state.qr && state.qr.content) {
      side.appendChild(el('div', 'dim', '码里的链接：'));
      const link = el('div', 'v', state.qr.content);
      side.appendChild(link);
      const copy = el('button', 'tiny', '复制链接');
      copy.onclick = () => {
        navigator.clipboard.writeText(state.qr.content);
        copy.textContent = '已复制';
      };
      side.appendChild(copy);
      side.appendChild(el('div', 'dim', state.qr.note || ''));
    }
    side.appendChild(steps);
    qr.appendChild(side);
    box.appendChild(qr);

    const status = el('div', 'kv');
    const rows = [
      ['系统代理', (state.proxyOn ? '已打开 -> 127.0.0.1:' + state.port : '未打开') + '　原值 ' + (state.proxy.ProxyEnable ?? '无') + ' / ' + (state.proxy.ProxyServer ?? '无')],
      ['本地证书', state.caInstalled ? '已装进当前用户根存储（结束后自动移除）' : '未安装'],
      ['抓包代理', state.port ? '127.0.0.1:' + state.port : '-'],
    ];
    for (const [k, v] of rows) {
      status.appendChild(el('div', 'k', k));
      status.appendChild(el('div', 'v', v));
    }
    box.appendChild(status);
  }

  if (state.log && state.log.length) {
    box.appendChild(el('h2', null, '抓包记录'));
    box.appendChild(el('pre', null, state.log.join(String.fromCharCode(10))));
  }
}

async function pollCapture() {
  try {
    const state = await call('/api/capture');
    renderCapture(state);
    if (!state.running && capturePoll) {
      clearInterval(capturePoll);
      capturePoll = null;
      await loadAccounts(true);
      renderAccounts();
    }
  } catch (error) {
    $('cap-hint').textContent = error.message;
  }
}

$('cap-start').onclick = async () => {
  let state;
  try {
    state = await call('/api/capture');
  } catch (error) {
    $('cap-hint').textContent = error.message;
    return;
  }
  const body = [
    el('div', null, '抓包只做两处「仅当前用户」的改动，抓到账号后立刻自动还原：'),
    el('div', null, '1. 把本工具的本地证书装进当前用户根证书区（certutil -user，不是机器级）'),
    el('div', null, '2. 把当前用户的系统代理指向 127.0.0.1:' + state.port + '（原来指向 ' + (state.proxy.ProxyServer ?? '无') + '，结束后写回）'),
    el('div', null, '不改机器级设置，不影响别的程序，随时点「停止抓包」也能回滚。'),
    el('div', null, '点确认后请在电脑上打开《疯狂水世界》，抓到一个登录包就自动结束。'),
  ];
  openConfirm('开始抓包（将修改当前用户的系统设置）', body, async () => {
    $('cap-hint').textContent = '启动中 ...';
    const next = await call('/api/capture/start', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    renderCapture(next);
    if (capturePoll) clearInterval(capturePoll);
    capturePoll = setInterval(pollCapture, 1500);
  });
};

$('cap-stop').onclick = async () => {
  const state = await call('/api/capture/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  renderCapture(state);
  if (capturePoll) {
    clearInterval(capturePoll);
    capturePoll = null;
  }
  await loadAccounts(true);
  renderAccounts();
};

// ---- 启动 ------------------------------------------------------------------
document.querySelectorAll('#tabs button').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((other) => other.classList.toggle('on', other === button));
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + button.dataset.tab);
    }
    if (button.dataset.tab === 'account') {
      renderAccounts();
      pollCapture();
    }
    if (button.dataset.tab === 'idle') refreshLoop();
  };
});

async function boot() {
  try {
    await loadAccounts(true);
  } catch (error) {
    $('hint').textContent = error.message;
    return;
  }
  await refreshOverview();
  pollCapture();
}
boot();
setInterval(refreshOverview, 3000);
setInterval(refreshLoop, 3000);
</script>
</body>
</html>`;
