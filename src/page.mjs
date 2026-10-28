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
  .cell.zero { opacity: .42; }
  .mat-group { margin-bottom: 10px; }
  .mat-group .gname { font-size: 11px; color: #7c8695; letter-spacing: .6px; margin-bottom: 4px; }
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
  .fac { border: 1px solid #262a31; border-radius: 6px; background: #191c21; padding: 10px 12px; margin-bottom: 10px; }
  .fac .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .fac .name { font-size: 14px; }
  .fac .meta { color: #7c8695; font-size: 12px; }
  .fac .cols { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 10px; align-items: flex-start; }
  .fac .col { min-width: 260px; flex: 1 1 300px; }
  .fac .col-title { font-size: 11px; color: #7c8695; letter-spacing: .6px; margin-bottom: 5px; }
  .job { display: flex; align-items: center; gap: 8px; border: 1px solid #262a31; border-radius: 5px; background: #12151a; padding: 4px 8px; margin-bottom: 4px; }
  .job .naming { min-width: 92px; font-size: 12px; }
  .job .left { font-variant-numeric: tabular-nums; font-size: 12px; color: #8fb8f0; min-width: 62px; text-align: right; }
  .job .pbar { flex: 1; height: 4px; min-width: 36px; border-radius: 2px; background: #262a31; overflow: hidden; }
  .job .pbar i { display: block; height: 100%; background: #4f8a5c; }
  .recipes { display: flex; flex-wrap: wrap; gap: 6px; }
  .recipe { display: flex; align-items: center; gap: 6px; border: 1px solid #262a31; border-radius: 5px; background: #12151a; padding: 4px 8px 4px 4px; cursor: pointer; }
  .recipe:hover { border-color: #4a5364; }
  .recipe.on { border-color: #3f6b4a; background: #1d2a1f; }
  .recipe.locked { opacity: .38; cursor: not-allowed; }
  .recipe.lack { opacity: .6; }
  .recipe .nm { font-size: 12px; display: block; line-height: 1.3; }
  .recipe .sub { font-size: 11px; color: #7c8695; display: block; line-height: 1.3; }
  .recipe .sub .miss { color: #f08a8a; }
  .pick { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #262a31; }
  /* 英雄养成：勋章/装备一格里可能有好几条，压成定高两行 + 「另 N 项」，
     不然一条「换装备 武器：蓝武器2 lv1 4星 → 蓝武器1 lv1 3星」就能把整张表撑乱。 */
  #hero-table td { vertical-align: top; }
  .grow-lines { max-width: 320px; }
  .grow-line { font-size: 12px; color: #b9c2ce; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grow-more { font-size: 11px; color: #7c8695; }
  .hero-stock { font-variant-numeric: tabular-nums; }
  /* 统计页：一日收益的大数字 + 每种东西的占比条 + 近 7 天柱子。
     .track 故意不叫 .bar —— 全局 .bar 是「一行控件」的样式（flex + margin-bottom），
     同名会把占比条撑成两行。 */
  .kpi { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-end; }
  .kpi .item { display: flex; flex-direction: column; min-width: 88px; }
  .kpi .item .k { font-size: 11px; color: #7c8695; }
  .kpi .item .v { font-size: 20px; line-height: 1.3; font-variant-numeric: tabular-nums; }
  .kpi .item .s { font-size: 11px; color: #7c8695; }
  .share { display: flex; align-items: center; gap: 8px; min-width: 130px; }
  .share .track { flex: 1; height: 6px; min-width: 50px; border-radius: 3px; background: #262a31; overflow: hidden; }
  .share .track i { display: block; height: 100%; background: #4f8a5c; }
  .share .pct { font-size: 11px; color: #7c8695; font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .acts .act { border: 1px solid #262a31; border-radius: 5px; background: #12151a; padding: 4px 10px; font-size: 12px; }
  .acts .act b { font-size: 13px; font-variant-numeric: tabular-nums; }
  .trend { display: flex; gap: 10px; align-items: flex-end; justify-content: flex-start; height: 104px; margin-top: 4px; }
  .trend .col { flex: 1 1 0; max-width: 58px; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 3px; }
  .trend .col i { display: block; width: 100%; background: #4f8a5c; border-radius: 2px 2px 0 0; min-height: 2px; }
  .trend .col.today i { background: #6fd08c; }
  /* 那天没有归档（新装的、或者那天没挂机）：画成一根暗色刻度，别用亮绿横条抢眼 */
  .trend .col.flat i { background: #3a4150; width: 40%; }
  .trend .col .val { font-size: 10px; color: #b9c2ce; font-variant-numeric: tabular-nums; }
  .trend .col .lab { font-size: 10px; color: #7c8695; }
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
    <button data-tab="factory">工厂</button>
    <button data-tab="stats">统计</button>
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
    <h2>仓库材料</h2><div id="materials"><span class="dim">连接后显示</span></div>
    <h2>库存</h2><div class="icons" id="items"><span class="dim">连接后显示</span></div>
    <h2>主力英雄</h2><div class="icons" id="hero-strip"><span class="dim">连接后显示</span></div>
    <h2>运行记录</h2>
    <div id="log"></div>
  </section>

  <section id="tab-idle" class="hidden">
    <div class="bar">
      <span class="k">自动循环</span>
      <label class="dim">轮数 <input id="loop-rounds" value="0" style="width:56px"></label>
      <label class="dim" title="瞬成配方（生产时间被英雄委任压到 0）会一次把 6 个制造位排满，所以间隔可以放宽到 180~300 秒">间隔秒 <input id="loop-every" value="60" style="width:64px"></label>
      <label class="dim"><input type="checkbox" id="world-speedup"> 允许花加速器</label>
      <label class="dim"><input type="checkbox" id="world-reroll"> 拒绝重刷订单</label>
      <button id="loop-start" class="primary">开始挂机</button>
      <button id="loop-stop" class="danger">停止</button>
      <span id="loop-hint" class="warn"></span>
    </div>
    <pre id="loop-view">轮数填 0 表示一直跑。每轮按「任务领取 → 日常 → 海面 → 挂机领取 → 货轮 → 情报 → 海盗 → 锻造 → 海兽培育 → 贸易港口」的顺序重新探测后再执行。钻石与付费礼包永不动，加速只花加速器。
运行中改完设置**不用停掉重开**：按钮会变成「应用设置」，点一下下一轮就生效（轮数除外，那个要重开）。
间隔按「本轮开始 → 下一轮开始」算，不会因为某一轮跑得久就整体往后漂；填 0（或小于 5 秒）会按 5 秒处理。
点「停止」后不会硬中断：当前这一段跑完就退出，所以状态会先显示「正在停止」。
这里只放自动化：要手动点一次的「任务奖励」「海面」「联盟情报」都在「日常」页。</pre>

    <h2>搁浅的货轮（世界宝藏）</h2>
    <div class="bar">
      <label class="dim" title="整点刷新的货轮，派舰队占领到 100% 结算奖励。已经有人占着的也派（打赢守军就换我们占）">
        <input type="checkbox" id="treasure-on" checked> 自动抢货轮
      </label>
      <span class="k">抢哪些</span>
      <label class="dim" title="小型货轮（蓝）：进度推得快，奖励是蓝装材料自选包">
        <input type="checkbox" id="treasure-color-3"> 小型
      </label>
      <label class="dim" title="中型货轮（紫）：奖励是紫装材料自选包">
        <input type="checkbox" id="treasure-color-4"> 中型
      </label>
      <label class="dim" title="万吨货轮（橙）：全服 1 艘，奖励最厚（默认只抢这个）">
        <input type="checkbox" id="treasure-color-5" checked> 万吨
      </label>
      <label class="dim">时间间隔 <input id="treasure-every" value="60" style="width:64px"> 秒</label>
      <span class="k" title="每日上限来自 TreasureLootParamCfg「每日宝藏奖励次数」，已领次数来自 TreasureLootStatsResponse。满了挂机就不再发探测请求">每日宝藏奖励</span>
      <span id="treasure-count" class="dim">还没探测过</span>
      <button id="treasure-run">立刻抢一次</button>
      <span id="treasure-state" class="dim">还没跑过</span>
    </div>
    <pre id="treasure-view">货轮每天 8:00~22:00 的**每个整点**刷新（万吨 1 艘、中型、小型各若干），派舰队占领到 100% 就结算奖励，
每人每天最多拿 3 次（TreasureLootParamCfg「每日宝藏奖励次数」）。抢的是刷新后那几十秒，所以默认 60 秒看一次 ——
与情报同节奏，但**排在情报前面**：两边抢的是同一批空闲舰队，情报事件挂 6 小时还在，货轮错过就没了。
**等级是多选的**（协议 color：3 蓝小型 / 4 紫中型 / 5 橙万吨），默认只抢**万吨（大货轮）**；
想顺手把中型/小型也扫掉就勾上，三个都不勾 = 不派船（日志里会说明）。
**已经有人占领的也派**：打赢守军就换成我们占（协议里没有守军战力，输赢看战报，进了邮件会一起领）。
代价是赌输会掉舰船耐久（维修按服务端下发的单价，本服 5.76 汽油/点）—— 所以无人占领的排在前面优先派，被占着的排后面。
**耐久低于「挂机」页设的阈值（默认 80%）的船不参与抢占**：配置表 LoadingTipsCfg 明确「耐久低于 1600 会降低输出、
增加受到的伤害」（本账号 2000 上限 = 80%），打守军是拿低输出去挨打，输了白掉耐久。这类船留在港里，
由「自动情报」那一段统一发维修请求（修满再派）。阈值填 0 = 不拦（旧行为）。
一次只打一个货轮（优先级：等级高的先派 → 同等级里 无人占领 → 我方在推 → 别人占着；
同档再按物品件数 → 资源），把空闲船压上去推快 —— 同联盟最多 10 支能占同一个，默认派 3 支。
单支消耗汽油 500（WorldParamCfg「进攻宝藏消耗汽油」），汽油不够会自动少派。奖励没有领取请求，结算后进邮件，
由上面的「自动领取」一并收掉。间隔填 0 = 每轮都看。
**每日奖励次数**：上面那行「已领 x/N」就是今天的进度（N 来自 TreasureLootParamCfg「每日宝藏奖励次数」，默认 3），
挂机探测一次就更新一次，手动「立刻抢一次」也会更新 —— 不用为了看个数字多发请求。
**今日没机会了就暂停探测**：奖励次数满了（到明天 0 点重置）或勾选等级里一个可抢的都没有（等到下一个整点刷新），
挂机连探测请求都不发，日志里只每 30 分钟提一句「暂停探测：…，x 后再试」。
其余情况（没空闲船、汽油不够、船还在航行）都是几分钟内自己会变，不会暂停。
**活动有效期**：世界宝藏没有独立的活动时间，边界是**赛季结束** —— 服务端 SeasonRankInfoResponse.endTime
（拿不到就按 worldOpenTime + SeasonTaskCfg 的赛季天数复算，两者实测完全相等）。赛季结束前 1 小时连船都派不了
（游戏内「合服计划」说明），所以真正的截止是 endTime − 1 小时。到点后本模块**自动停手**，日志与这里都会打印
「活动已结束」——那时把 src/treasure.mjs 和几处接线删掉即可。</pre>

    <h2>自动联盟情报</h2>
    <div class="bar">
      <label class="dim" title="联盟情报：领已完成的奖励 + 派舰队打情报事件。默认开，默认 60 秒扫一次">
        <input type="checkbox" id="loop-radar" checked> 自动情报
      </label>
      <label class="dim">时间间隔 <input id="radar-every" value="60" style="width:64px"> 秒</label>
      <label class="dim" title="战力余量 1.2 = 舰队战力要比敌方高 20% 才派，战败会掉舰船耐久">战力余量 <input id="radar-ratio" value="1.2" style="width:48px"></label>
      <label class="dim" title="耐久低于这个百分比就不派去打架（货轮/情报/海盗三段共用），留在港里修满再派。依据：配置表 LoadingTipsCfg「耐久低于 1600 会降低输出、增加受到的伤害」，本账号 2000 上限 = 80%。填 0 = 不修也不拦（旧行为）">耐久 &lt; <input id="radar-repair" value="80" style="width:48px"> %</label>
      <span id="radar-state" class="dim">还没跑过</span>
    </div>
    <pre id="radar-gate-view">跟拾荒、农田同一套节奏：自动循环每轮都会看一眼，只有「距上次执行」超过间隔才真的跑一次
「读取情报 → 领已完成奖励 → 派兵（耐久达标的船）→ 修船（耐久低于阈值的船）」，其余轮次整段跳过（连探测请求都不发）。
战力余量越大越保守：1.2 表示舰队战力至少是敌方的 1.2 倍才派；战败会掉舰船耐久，修船要资源。
耐久阈值（默认 80%）是**三段共用**的：货轮（抢被占的要打守军）、情报派兵、海盗讨伐都先过这道闸，
低于它的船不派出去，改成在港里修满（花汽油，耗时按服务端下发的单位代价算）。
依据是配置表 LoadingTipsCfg 的官方提示「城战中舰船耐久度低于 1600 会降低输出，增加受到的伤害」（本账号 2000 上限 = 80%）。
修船要船是空闲的（航行/战斗中修不了），修理期间这艘船也派不出去 —— 这就是留余量的意义。
状态「上次 3 分钟前 · 还差 20 秒」里的时间只在这轮真的探测成功后才更新 —— 探测失败不占用间隔，下一轮立刻重试。</pre>

    <h2>自动海盗讨伐</h2>
    <div class="bar">
      <label class="dim" title="派空闲舰队真出战打世界地图上的海盗。每次烧 300 汽油、不掉耐久，收益是首杀奖励 + 固定掉落">
        <input type="checkbox" id="pirate-on" checked> 自动讨伐海盗
      </label>
      <label class="dim">时间间隔 <input id="pirate-every" value="60" style="width:64px"> 秒</label>
      <label class="dim" title="默认只打「下一个没打过的等级」（有首杀奖励）。勾上才会重复刷已通关等级，那种只有固定掉落">
        <input type="checkbox" id="pirate-repeat"> 刷已通关等级
      </label>
      <button id="pirate-run">立刻讨伐一次</button>
      <span id="pirate-state" class="dim">还没跑过</span>
    </div>
    <pre id="pirate-view">派空闲舰队**真出战**打世界地图上的海盗部队（ChallengePirateRequest）：一艘船打一个海盗，打完击杀记录 +1。
**跟「免战扫荡」不是一回事**：扫荡是每日任务「累计击败野怪」那条（PirateSweepRequest，一天 10 次，不动舰队也不烧汽油，
在「日常」页里自动做）；这里是真的把船开出去打。
**跟「联盟情报」也不是一回事**：情报事件是雷达里刷出来的，有 6 小时时效；这里打的是地图上常驻的海盗部队。
成本 300 汽油/次（WorldParamCfg「打野怪消耗汽油」），**不掉耐久**（「打野怪消耗耐久」= 0）。
但耐久 <80% 会「降低输出、增加受到的伤害」（LoadingTipsCfg）—— 打起来更容易输、白烧 300 汽油，
所以**耐久低于「挂机」页设的阈值（默认 80%）的船不出战**，留在港里由「自动情报」那一段修满再派（阈值 0 = 不拦）。
收益 = 首杀奖励（firstKillReward + 首件装备）+ 每次固定掉落（GOLD 250 + 材料），所以**默认只打没打过的下一个等级**，
照客户端自动讨伐的口径：每种类型从「已击杀最高等级 + 1」往上找，地图上没有这一级就等刷新。
勾上「刷已通关等级」才会去打打过的那几级 —— 那种只剩固定掉落，值不值自己判断。
战力余量沿用「自动情报」那栏那个数（默认 1.2），敌方战力按 **赛季 + 类型 + 等级** 查 WorldPirateCfg
（同等级不同赛季战力能差 40 倍）。赛季从角色所在的 worldId 算，算不出来时会取各赛季最高战力，宁可不派也不打输。
**排在货轮和情报后面**：三段抢的是同一批空闲船 —— 货轮错过就没了、情报挂 6 小时还在、海盗没人抢，
所以它经常看到「0 艘空闲船，这轮不派」，那是正常的。</pre>

    <h2>拾荒</h2>
    <div class="bar">
      <label class="dim"><input type="checkbox" id="world-pick" checked> 自动拾荒</label>
      <label class="dim">时间间隔 <input id="pick-every" value="300" style="width:64px"> 秒</label>
      <span id="pick-state" class="dim">还没跑过</span>
    </div>
    <pre id="gate-view">拾荒的节奏跟循环间隔无关，所以单独给一个时间间隔：自动循环每轮都会看一眼，只有「距上次执行」超过间隔才真的发请求，其余轮次直接跳过。
拾荒：扫海面漂浮物，一次全捡（不消耗任何资源）。间隔填 0 表示不限制（每轮都试）；手动「执行一轮」不受间隔限制。</pre>

    <h2>农田</h2>
    <div class="bar">
      <label class="dim" title="农田默认开：成熟的作物一次性收掉，空出来的地同一轮补种（分散铺开：库存少的先种）">
        <input type="checkbox" id="world-farm" checked> 自动农田
      </label>
      <label class="dim">时间间隔 <input id="farm-every" value="120" style="width:64px"> 秒</label>
      <span id="farm-state" class="dim">还没跑过</span>
    </div>
    <pre id="farm-view">农田跟拾荒一样按自己的节奏跑，但方向相反：默认就开着，只有命令行加 --no-farm 才关。
作物最快 30 分钟成熟，所以默认 120 秒看一眼就够；只有**真的排出了收/种动作**才记时间，地里没熟、也没空地时不占用间隔。
收：熟一片全收（一条 FarmHarvestRequest）；种：空地和刚收的地同一轮补种，**一种作物一条 FarmPlantRequest**（土豆被拒不会连累小麦）。
选种策略是**分散铺开 + 目标水位**：每放一块地就重挑一次「离水位最远的那种」——
订单/货船有缺口的最优先（可以突破水位），其余按「安全水位 − 当前库存」降序，一轮之内每种作物先各占一块地。
安全水位按这种作物被几条成品配方用来分档（小麦/番茄各 6 条 → 200，南瓜/茄子只有 1 条 → 40）：
**到水位就不种了，地块宁可空着**。因为只按「库存少的先种」会把十来种作物一起推向单种上限 250，
然后上限过滤把每一种都剔掉，地块永久空着 —— 而仓库里全是工厂吃不掉的存货。
空着不是故障：工厂把这些库存吃下去之后水位自动让出来，下一轮就恢复种（闭环）。
服务端对单种作物有库存上限（实测土豆 245 能种、260 起回 item limit reached，取 250），而**收获不校验上限**，
所以播种前还会算「种下去会不会超线」：会超就跳过；真被拒过的作物歇 30 分钟再试。
地块空着时日志会写明是「没种子」还是「作物都到安全水位」，别再混着理解。
游戏内「自动种植」（VIP 功能）开着时只收不种 —— 那时服务端自己播，重复播只是白费种子。
**过剩作物怎么消化**：库存超过水位的作物会折成「这条配方还能做几份」喂给工厂排产（每种成品最多 3 份），
只喂**料已经齐**的配方 —— 料不齐还给需求的话，工厂会拿自选包去兑，那就破了「无需求不烧包」这条线。
**种子从哪来**：农田缺哪种作物（库存 < 40）且它的种子不足 8 个，就把「该种子」当成排产需求喂给种子厂；
种子厂的存量上限留 5 个余量（50 → 排到 45 就停），接近上限的种子不再占队列位，让给真正缺的那种。
种子厂等级决定能产哪几种种子（每级解锁一种，当前 Lv4 = 小麦/玉米/土豆/番茄），产一炉只出 1 个。</pre>

    <h2>挂机收益 / 邮件</h2>
    <div class="bar">
      <label class="dim" title="邮件附件 + 挂机本段收益 + 挂机等级奖励/升级：四件都免费，不发就白放着（收益 8 小时封顶后产出停摆）">
        <input type="checkbox" id="idle-on" checked> 自动领取
      </label>
      <label class="dim">时间间隔 <input id="idle-every" value="300" style="width:64px"> 秒</label>
      <button id="idle-run">立刻领取一次</button>
      <span id="idle-state" class="dim">还没跑过</span>
    </div>
    <pre id="idle-view">跟拾荒、农田、情报、锻造同一套节奏：自动循环每轮都会看一眼，只有「距上次执行」超过间隔才真的探测一次。
领的四样：邮件附件（一键领取，all:true）、挂机本段收益（到封顶才领）、挂机等级奖励（OfflineLvRewardCfg 里下一个有奖的等级）、
挂机等级升级（消耗「挂机徽章」，一次能连升 10/5/1 级就取最高的那档）。
升级**会重置本段计时**，所以只有「本段刚开」或「这一轮先把本段收益领了」才升级，不会把累积的收益扔掉。
升级受主线关卡限制：OfflineCfg 里 stage ≤ 主线关卡-1 的最高等级就是上限。间隔填 0 = 每轮都看。</pre>

    <h2>装备锻造</h2>
    <div class="bar">
      <label class="dim" title="装备厂：造好了收取，收完按部位件数最少的排下一件（武器/防具/饰品成套，英雄每个部位只能穿一件）">
        <input type="checkbox" id="forge-on" checked> 自动锻造
      </label>
      <label class="dim">时间间隔 <input id="forge-every" value="180" style="width:64px"> 秒</label>
      <button id="forge-run">立刻锻造一次</button>
      <span id="forge-state" class="dim">还没跑过</span>
    </div>
    <pre id="forge-view">装备厂同一时间只能造一件，**造好不收 = 整座工厂停产**，所以它比农田更值得勤看（一件蓝装约 25 分钟，默认 180 秒看一眼）。
排产按「背包 + 打造中」的件数算：哪个部位少就补哪个（英雄每个部位只能穿一件，三个部位要成套）；件数相同时按 武器 → 防具 → 饰品 轮转。
部位内先试品质最高的配方，材料或金币不够就自动降级 —— 所以紫材料攒够 160 时会自动改造紫装，不用改设置。
已穿在英雄身上的不计入（那是「已在用」，不是「可分配」）。**永不动钻石、不加速**（SpeedMakeEquipRequest 需要花钻石）。</pre>

    <h2>贸易港口（货轮港口）</h2>
    <div class="bar">
      <label class="dim" title="港口最多停靠 3 艘货船，每艘采购 4 种物品。交一格立得玩家经验 + 金币，4 格交完船就出发，几小时后返航、领 4 份藏品奖励">
        <input type="checkbox" id="cargo-on" checked> 自动贸易
      </label>
      <label class="dim">时间间隔 <input id="cargo-every" value="60" style="width:64px"> 秒</label>
      <button id="cargo-run">立刻交一次货</button>
      <span id="cargo-state" class="dim">还没跑过</span>
    </div>
    <pre id="cargo-view">建筑在 BuildingCfg 里叫「货轮港口」（界面显示「贸易港口」），建好解锁 3 个船位。
每艘船采购 4 种物品，界面上那个「全部交货」= FillCargoShipRequest{shipIndex, cargoIndex[]}，
cargoIndex 是**从 1 开始的槽位号**，一条请求能把这一船攒够的格子一起交掉。
供货完成即可得玩家经验 + 金币（奖励写在每个槽位的 reward 上），**4 格交满船就出发**；
返航时间在 DispCargoShip.arriveTime（**秒**，不是毫秒），到点用 DrawShipRewardRequest{index} 领
4 份藏品奖励（大师徽章 / 稀有·史诗·传说藏品经验 / 藏品碎片）。
缺料的格子只提示缺口、**不买货**（客户端那里会弹「购买补齐」，我们不买）；等工厂/农田慢慢补，下一轮自然够。
**缺的货会通知工厂排产**：货船缺口会并进工厂排产的「需求」（跟居民订单缺口同一张表），
所以工厂空位会优先产货船要的东西，不用等它自己排到。船都出海时这份需求自动清空。
**永不动钻石、不用加速器**（SpeedUpShipRequest 要花加速器，没做）。
排在挂机最后一段：前面几段（交单/排产）先把材料用掉，剩下的才拿来贸易，避免互相抢料。
间隔填 0 = 每轮都看。</pre>

    <!-- 海商王（活动 Trade）2026-10-28 已下线：loop.mjs 里第 10 段整段注释停用，这里默认不勾。
         活动重开时：把 loop.mjs 那段解注释、勾上这个开关即可，控件与接口都还在。 -->
    <h2>海商王（港口贸易 · 活动已下线）</h2>
    <div class="bar">
      <label class="dim" title="每天 10~22 点的港口贸易活动。⚠ 活动已于 2026-10-28 下线，挂机里那一段已注释停用">
        <input type="checkbox" id="trade-on"> 自动跑海商王（已下线）
      </label>
      <label class="dim">时间间隔 <input id="trade-every" value="60" style="width:64px"> 秒</label>
      <label class="dim" title="商会指针（免费道具，联盟任务/战令产出）每个缩短 30 分钟航程。关掉就老实等 2 小时一趟">
        <input type="checkbox" id="trade-speed" checked> 用商会指针
      </label>
      <button id="trade-run">立刻跑一段</button>
      <span id="trade-state" class="dim">还没跑过</span>
    </div>
    <pre id="trade-view">⚠ 2026-10-28 活动已下线，这段代码整段注释停用，不再探测也不再发请求。
   下面规则留档，活动重开时按「loop.mjs 解注释 + 勾上开关」即可恢复。

17 个港口，每个港口有一种「特产」（固定不变，价格最低）和一种「紧缺货物」（每天 10 点变，价格最高）。
赚钱的路子：**在「特产 = g」的港口买 g → 开到「紧缺 = g」的港口卖掉**，单趟价差约 +25~30%，再乘商船加成（lv1 +3%）。
⚠ 紧缺货每天 10 点重置，雷达里只有「今天有人到过并共享过」的港口才有值 —— 所以要边跑边把未知港口点亮。
- 库存全联盟共享、先到先得，每 2 小时（10/12/14/16/18/20 点）刷价格与库存 → 刷新后越快抢到越好。
- 10 点前买不了（server prompt: not trade time），但**能开船和用指针**，所以可以先就位、开门就抢。
- 资金上限 = 初始 10000 + 累计利润（利润直接变下一趟本金，滚得很快）。
- 只花活动内的商会币，**不花钻石**：升船（300/600/1200/2000 钻）和买指针（50 钻/次）都不做。
- 顺手领：个人累计利润成就、联盟任务、商情共享奖励、海商王战令免费档。
- 一趟「卖 + 买 + 起航」算一轮，间隔填 0 = 每轮都跑；在航且没指针、不在 10~22 点时会静默，不白打请求。</pre>

    <h2>联盟商船</h2>
    <div class="bar">
      <label class="dim" title="全联盟一起凑货舱：给已有船长的船补一个货舱（材料得够，缺料绝不买），顺带应聘没人当的船长">
        <input type="checkbox" id="guild-ship-on" checked> 自动跑联盟商船
      </label>
      <label class="dim">时间间隔 <input id="guild-ship-every" value="120" style="width:64px"> 秒</label>
      <label class="dim" title="没人当船长的船可以直接应聘（零成本：凑不齐只遣返船长，不扣资源）。船长不能给自己那条船补货，所以船位有限时优先做船员">
        <input type="checkbox" id="guild-ship-seek" checked> 应聘船长
      </label>
      <button id="guild-ship-run">立刻跑一段</button>
      <span id="guild-ship-state" class="dim">还没跑过</span>
    </div>
    <pre id="guild-ship-view">联盟商船是**全联盟一起凑货舱**的日常：商船停在联盟码头，凑齐所有货舱就立刻启航，
船长和登船成员拿**一样**的奖励（水姆币 / 专武材料 / GOLD / RUBY / 英雄经验…）。
- 三档规格：史诗 2.5 小时（2 舱）／传说 5 小时（4 舱）／超凡 9 小时（6 舱），规格越高奖励越好。
- 刷新：每天 8／11／14／17／20／23 点，史诗与传说各补满 2 艘并重置船长与货舱；超凡每天 2 艘、港口同时只停 1 艘。
- 补货窗口只有 **30 分钟**，到点没达标的船会被重置并遣返船长（已交的商品退还）。达标线：史诗 1 舱／传说 2 舱／超凡 3 舱。
- **两条硬限制**：船长不能给自己那条船补货；每人最多同时登 2 艘，而且一旦上船就被锁到船到港（2.5~9 小时）才释放名额。
- 所以策略是「**船员优先 + 挑空舱少的船**（快启航、名额释放快）」，剩余名额才去当船长。
- **缺料一律不补、绝不花钻石买料**（客户端那条路会弹「购买」，这里不接），等工厂产出来再说。</pre>

    <h2>联盟订单</h2>
    <div class="bar">
      <label class="dim" title="每天 0 点刷一单：交齐 3 种物品换公会经验 + 功勋（外加联盟城市兵力）。请求体只有 cityId，不花货币/钻石">
        <input type="checkbox" id="guild-order-on" checked> 自动交联盟订单
      </label>
      <label class="dim">时间间隔 <input id="guild-order-every" value="600" style="width:64px"> 秒</label>
      <span id="guild-order-state" class="dim">还没跑过</span>
    </div>
    <pre id="guild-order-view">联盟订单是「联盟城市驻军」弹窗里的那一单，**每天 0 点刷新，一天一单**。
- 要什么：3 种物品（实测 2026-10-28 是 日用品×4、海藻汁×6、木板×3），数量由服务端随机，配置表里查不到。
  物品池 135 条：**加工品 123 条 + 农产品 12 条**（小麦/玉米/土豆/番茄/…/可可豆，没有橡胶）。
- 花什么：**什么都不额外花**。FinishGuildOrderRequest 只有 cityId 一个必填字段，
  没有物品清单、没有货币、没有钻石，服务端按订单要求直接从仓库扣那 3 样货。
- 给什么：按 GuildOrderCfg 每种物品一份公会经验 + 功勋（小麦 25/45、土豆 40/65、番茄 45/70…），
  另外交单会给联盟城市加兵力。
- 次数：GuildOrderNumCfg 按赛季/等级给上限（-1 = 不限），今天交过几次看计数器
  DAILY_FINISH_GUILD_ORDER。交成功后本机就睡到次日 00:00 刷新点。
- 料不齐就跳过并写明缺什么（缺料会等你工厂补齐，**不会去商店买**）。
- 间隔 600 秒的理由：订单料多是加工品，工厂一炉 30~300 分钟，看太勤只是白打 3 个请求
  （GuildOrder + GuildCityInfo + CounterInfo），看太慢又会错过刚补齐那一刻。</pre>

    <h2>海兽培育</h2>
    <div class="bar">
      <label class="dim" title="海兽培育室：成熟的一次领走，队列空位按「材料够的里面品质最高」排满（基因是该物种专属的，攒着没有任何别的用途）">
        <input type="checkbox" id="pet-on" checked> 自动培育
      </label>
      <label class="dim">时间间隔 <input id="pet-every" value="300" style="width:64px"> 秒</label>
      <label class="dim" title="红配方要 season 2 且 100 万金币，常态打不开；想给金币留余地就往下调">
        品质上限
        <select id="pet-quality">
          <option value="BLUE">蓝</option>
          <option value="PURPLE">紫</option>
          <option value="ORANGE" selected>橙</option>
          <option value="RED">红</option>
        </select>
      </label>
      <label class="dim" title="投喂该队列位要求的材料（鱼肠线/粗铁/烤鱼这类），每次把剩余时间往前推 4 小时（PetParamCfg「投喂减少培育时间」）。不花钻石、不用加速器、不看广告；材料不够就跳过，不会去买">
        <input type="checkbox" id="pet-feed" checked> 材料加速
      </label>
      <button id="pet-run">立刻培育一次</button>
      <span id="pet-state" class="dim">还没跑过</span>
    </div>
    <pre id="pet-view">海兽培育室（BuildingCfg 里叫「宠物培育室」）能排几个以服务端给的 maxQLength 为准，0 表示队列还没开（建筑没建成）。
成熟的一次领走（GetMaturePetRequest 没有 body，跟客户端一样一下收全部）；队列空着的位子按「品质从高到低、同品质先补编号小的物种」排满。
材料（基因 + 金币）不够就自动降一级 —— 所以紫基因攒够 400 时会自动从蓝升到紫，不用改设置。
基因是该物种专属的（「宠物3蓝基因」只用于宠物3），攒着没有别的用途，所以有就排；**永不动钻石**。
**材料加速（投喂）默认开**：PetFeedRequest{jobIdx} 消耗该队列位 feedRequirements 里的材料
（实测「鱼肠线×12 + 粗铁×4 + 烤鱼×40」），每次把剩余时间往前推 PetParamCfg「投喂减少培育时间」= 4 小时。
判据与客户端 _onBtnFood 一致：材料够才喂，不够就跳过（客户端那里会弹「购买补齐」，我们不买）。
一轮每个队列位只喂一次 —— 喂完由服务端刷新 finishTime，下一轮按新状态再判断；剩不到 5 分钟不喂（材料白花）。
不碰钻石、不用加速器、不看广告。</pre>

    <pre class="dim" style="color:#7c8695">潜水与打捞**没有做，也不会做**：它们的请求体要求上报「这一局你在水下/海里实际捡到了什么」，纯协议只能伪造战利品，属于谎报。详见 README「安全边界」。</pre>
  </section>

  <section id="tab-heroes" class="hidden">
    <div class="bar">
      <button id="hero-plan">探测</button>
      <button id="hero-grow" class="primary">全部养成</button>
      <label class="dim"><input type="checkbox" id="hero-bench"> 含未上阵英雄</label>
      <span id="hero-hint" class="warn"></span>
      <span id="hero-stock" class="dim hero-stock"></span>
    </div>
    <div class="bar" id="hero-switches"><span class="k">执行范围</span></div>
    <pre id="hero-view">默认只列主战英雄 —— 当前主线出战阵容（GetFormationResponse 的 5 个位置）里的那几个，材料也只给他们。
勾上「含未上阵英雄」才把整本英雄册摊开（未上阵的一般只做「戴上闲置装备/勋章」这类不花材料的动作）。

每个英雄能看到现在能提升什么：等级、升星、技能，以及勋章的强化/替换和装备的升级/精炼/升星/替换。
每一项都按客户端自己的公式算（上限、材料、金币都逐条核对），材料不够的不会出现在计划里。
「养成」= 只对这一个英雄执行，「全部养成」= 按战力从高到低吃材料；执行前会重新探测一遍，不看这份旧快照。
恒定边界：不花钻石、不分解任何勋章（只用「徽章经验」道具）、不看广告、不用加速器。</pre>
    <div id="hero-table"></div>
  </section>

  <section id="tab-dailies" class="hidden">
    <pre class="dim" style="color:#7c8695">手动操作都在这页：想立刻做一次就点按钮，不用开挂机。自动循环照样每轮会顺带做这些（开关在「挂机」页）。</pre>

    <h2>日常任务</h2>
    <div class="bar">
      <button id="dailies-plan">探测</button>
      <button id="dailies-run" class="primary">一键完成</button>
      <label class="dim"><input type="checkbox" id="dailies-paid"> 允许花钻石（默认关闭）</label>
      <span id="dailies-hint" class="warn"></span>
    </div>
    <pre id="dailies-view">先「探测」看看现在能做哪些、为什么不能做。点金与折扣店默认跳过，勾上才会花钻石。</pre>
    <div id="dailies-table"></div>

    <h2>任务奖励</h2>
    <div class="bar">
      <button id="tasks-plan">检查可领</button>
      <button id="tasks-run" class="primary">领取任务奖励</button>
      <span id="tasks-hint" class="warn"></span>
    </div>
    <pre id="tasks-view">主线、支线、成就、每日订单档位。算不出目标值的会跳过。</pre>

    <h2>海面</h2>
    <div class="dim">收成品、竣工、交单、给空闲工厂排产、收农田/播种、余料升级。按「挂机」页的「农田」「拾荒」勾选执行（加速、重刷订单开关也在那边）。</div>
    <div class="bar">
      <button id="world-plan">探测计划</button>
      <button id="world-run" class="primary">执行一轮</button>
      <span id="world-hint" class="warn"></span>
    </div>
    <pre id="world-view">收成品 → 竣工 → 交单 → 给空闲工厂排产（按需求缺口：居民订单缺的 + 贸易港口货船缺的；队列空时瞬成配方一次排满）→ 收农田 → 播种 → 余料升级建筑。
「空闲」= 这座工厂的制造队列为空；队列里还有东西在造就完全不碰，所有产品都到存量上限时它就该空着。</pre>
    <div id="world-factories"></div>
    <div id="world-orders"></div>
    <h2>仓库</h2><div class="icons" id="world-stock"></div>
    <h2>资源田</h2><pre id="world-fields"></pre>

    <h2>联盟情报</h2>
    <div class="bar">
      <button id="radar-refresh">读取情报</button>
      <button id="radar-run" class="primary">领奖 + 派兵 + 修船</button>
      <span id="radar-hint" class="warn"></span>
    </div>
    <pre id="radar-view">按舰队战力筛情报事件：每艘空闲船各派去打一个能打过的，打完的领奖励。战力余量取「挂机」页那个（默认 1.2），越大越保守 —— 战败会掉舰船耐久。
耐久低于「挂机」页设的阈值（默认 80%）的船不派出去，改成留在港里修满（花汽油，修船期间这艘船派不出去）；阈值填 0 = 不修船。
自动挂机里也有这套（「挂机」页的「自动联盟情报」，默认每 60 秒跑一次），这里点按钮是不等间隔、立刻跑一次。</pre>
    <div id="radar-events"></div>
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

  <section id="tab-factory" class="hidden">
    <div class="bar">
      <button id="factory-refresh" class="primary">刷新工厂</button>
      <button id="factory-gain" disabled>一键收成</button>
      <label class="dim"><input type="checkbox" id="factory-auto" checked> 停在这个页面时每 5 秒自动刷新</label>
      <span id="factory-hint" class="warn"></span>
      <span id="factory-summary" class="dim"></span>
    </div>
    <pre id="factory-view">队列的倒计时是服务端给的完成时间，本地每秒自己走，不额外发请求。
制造：点一下配方选中，再点「制造」就直接排产（不二次确认）。
配方上的「满」= 这个产品的持有量（仓库 + 工厂待收/在造）到上限了；「缺料」= 配方材料不够。造不了时点「制造」不会发请求，而是把卡在哪写在上面那行（红字）。
缺料且能用「原料自选包 / 工事材料自选包」补齐时，按钮会变成「兑料并制造」——点它才会真的花包（一包换一个单位，按钮上写着要花几个），不点就一个包都不动。
一键收成：把每座工厂囤积的成品一次收完（逐座发 GainFactoryProduceRequest，收益按产品名合并显示）。
非工厂建筑（民居、指标楼）的产物不在这里收，那些走「挂机 → 执行一轮」。</pre>
    <div id="factory-list"><span class="dim">还没读。点「刷新工厂」，或先在右上角「连接」。</span></div>
  </section>

  <section id="tab-stats" class="hidden">
    <div class="bar">
      <button id="stats-refresh" class="primary">刷新</button>
      <button id="stats-prev" class="tiny">前一天</button>
      <input id="stats-day" type="date" style="width:150px">
      <button id="stats-next" class="tiny">后一天</button>
      <button id="stats-today" class="tiny">回到今天</button>
      <label class="dim"><input type="checkbox" id="stats-auto" checked> 停在这一页时每 30 秒自动刷新</label>
      <span id="stats-hint" class="warn"></span>
      <span id="stats-stamp" class="dim"></span>
    </div>
    <div class="kpi" id="stats-kpi"><span class="dim">还没读。点「刷新」。</span></div>

    <h2><span id="stats-made-title">今日制造</span> <span class="dim" id="stats-made-note"></span></h2>
    <div id="stats-made"><span class="dim">连接后显示</span></div>

    <h2>建筑产出 <span class="dim" id="stats-building-note"></span></h2>
    <div id="stats-building"><span class="dim">连接后显示</span></div>

    <h2>其他收益</h2>
    <div id="stats-other"><span class="dim">连接后显示</span></div>

    <h2>今日活动次数</h2>
    <div id="stats-acts"><span class="dim">连接后显示</span></div>

    <h2>近 7 天制造</h2>
    <div class="trend" id="stats-trend"><span class="dim">连接后显示</span></div>

    <pre id="stats-view">数据不是从内存里读的，而是每次打开这一页都重新扫一遍归档回包 data/responses/&lt;日期&gt;/：
所以刷新页面、重启进程、下午才打开，看到的都是当天从 0 点起的完整统计，跟挂机当时在不在跑无关。

「制造」= 今天从工厂收走的成品（GainFactoryProduceResponse.products）。还堆在工厂里没收的不算 ——
那是待收，不是到手。同一张表也能回答「这些料够不够交订单」，因为交单扣的就是这份仓库。
「建筑产出」是训练营的英雄经验、精铁厂的精铁、民居的金币这些非工厂建筑（CollectBuildingProductResponse）。

拾荒、居民订单、挂机收益、货轮港口、邮件奖励各有各的回包，逐条加起来的。邮件那栏是反推的：
QuickGotReadEmailRequest 没有回包，只能靠邮件快照里「未领 → 已领」的变化判断领取时刻 ——
所以它算的是「当天真领到手」几封，跟邮件哪天发的无关：昨天发、今天领的，归今天。
第一次打开某一天会把这天的邮件快照整份扫一遍（实测 74MB 约 1 秒），之后只读新增的部分。
情报 / 海盗的奖励走邮件，落到邮件那栏；农田收获、海兽成熟、免战扫荡这些协议只有请求没有回包，
只能靠「今日活动次数」看做了几次 —— 次数是请求条数，像不像"收益"要自己判断。

「今日活动次数」数的是请求条数，不是收益 —— 服务端拒了的请求也在里面，它说明的是「挂机试过几次」。
查历史日期时，趋势图仍然按那一天往前数 7 天，方便跟今天对比。</pre>
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
  if (activeTab === 'stats') refreshStats();
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

  // 仓库材料：按「原料 / 工事材料 / 农产品」分组，数量 0 的也留着（只是变暗）——
  // 缺什么正是这一栏要看的信息，藏起来就白做了。
  const mats = clear($('materials'));
  for (const group of data.materials || []) {
    if (!group.items || !group.items.length) continue;
    const wrap = el('div', 'mat-group');
    const title = el('div', 'gname', group.name);
    // 工厂产品有 158 种，只列仓库里真有的，标题上说明一下，免得以为漏了。
    if (group.onlyOwned) title.appendChild(el('span', 'dim', '  只列仓库里有的'));
    wrap.appendChild(title);
    const row = el('div', 'icons');
    for (const item of group.items) {
      const node = cell(item.icon, 30, item.id, fmt(item.num));
      if (!item.num) node.classList.add('zero');
      row.appendChild(node);
    }
    wrap.appendChild(row);
    mats.appendChild(wrap);
  }
  if (!mats.childElementCount) mats.appendChild(el('span', 'dim', '暂无数据'));

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

// 秒数说人话：40 秒 / 5 分 20 秒 / 1 小时 3 分。
function dur(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return total + ' 秒';
  const m = Math.floor(total / 60);
  const rest = total % 60;
  if (m < 60) return rest > 0 ? m + ' 分 ' + rest + ' 秒' : m + ' 分';
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM > 0 ? h + ' 小时 ' + restM + ' 分' : h + ' 小时';
}

function clock(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

// 相对时间（「上次 3 分钟前」）：看的是体感，具体钟点塞进 title 不占版面。
function ago(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 10) return '刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? h + ' 小时 ' + m + ' 分钟前' : h + ' 小时前';
}

// 拾荒 / 农田 / 情报共用的门控状态：上次什么时候做的、离下次还差多久。
// running=false 时不能说「已到间隔」——那看起来像「到点了却不执行」，
// 实际是循环根本没在跑，所以直接点明「未在挂机」。
function renderGate(nodeId, lastAt, everyMs, enabled, running = true) {
  const node = $(nodeId);
  node.title = '';
  if (!enabled) {
    node.textContent = '未勾选，不会执行';
    return;
  }
  if (!lastAt) {
    node.textContent = running ? '上次：还没执行（首次跑就做一次）' : '还没执行过（未在挂机）';
    return;
  }
  node.title = '上次执行 ' + clock(lastAt);
  const waited = Math.max(0, Date.now() / 1000 - lastAt);
  const base = '上次 ' + ago(waited);
  if (!running) {
    node.textContent = base + ' · 未在挂机，不会执行';
    return;
  }
  // 跟服务端 gateDue 用同一套容差（间隔的 10%，最多 2 秒，最少 200ms）：
  // 轮首时刻与「真的执行时刻」天然差几秒，不扣容差页面会一直显示「还差 2 秒」，
  // 而服务端其实已经在跑了 —— 两边显示对不上就会被当成 bug。
  const slackMs = everyMs > 0 ? Math.min(2_000, Math.max(200, everyMs * 0.1)) : 0;
  const left = Math.max(0, Math.ceil((lastAt * 1000 + (everyMs || 0) - slackMs - Date.now()) / 1000));
  node.textContent = !(everyMs > 0) ? base + '（不限间隔，每轮都试）'
    : base + ' · ' + (left > 0 ? '还差 ' + dur(left) : '已到间隔');
}

// 每日宝藏奖励次数：数值来自服务端最近一次探测（挂机每轮更新，手动「立刻抢一次」也更新），
// 所以页面只显示缓存值，绝不为了「看个数字」在轮询里多发请求。
// 暂停探测（奖满 / 活动结束 / 没有可抢的）也标在这一行 —— 否则「已领 3/3」配着「上次 30 秒前」
// 会让人以为挂机还在傻跑探测。
function treasureCountOf(stats, gate) {
  if (!stats) return { text: '还没探测过', title: '还没探测过：点「立刻抢一次」或开始挂机就会读到次数' };
  const tail = gate && gate.skipped
    ? (gate.skipForever ? ' · 已暂停探测' : ' · 暂停探测，' + dur(gate.skipLeftSeconds) + '后再试')
    : '';
  return {
    text: (stats.text || '—') + (stats.at ? '（' + clock(stats.at) + ' 探测）' : '') + tail,
    title: '每日上限 ' + stats.dailyLimit + ' 次（TreasureLootParamCfg「每日宝藏奖励次数」），已领 '
      + (stats.todayRewardTimes == null ? '?' : stats.todayRewardTimes) + ' 次'
      + (stats.dailyFull ? '，今日已满，明天 0 点重置' : '')
      + (gate && gate.skipped ? '；挂机暂停探测：' + gate.skipReason : ''),
  };
}

function renderTreasureCount(data, lastRound) {
  const node = $('treasure-count');
  const view = treasureCountOf(data && data.treasureStats, lastRound && lastRound.gates && lastRound.gates.treasure);
  node.textContent = view.text;
  node.title = view.title;
}

// 页面刚打开、挂机也没跑过时，服务端一个数字都没有 —— 补一次，
// 之后都靠 /api/loop 里带回来的缓存，不在 3 秒轮询里重复问。
// 失败（没选账号 / 没连上）不写死：每分钟最多再试一次，不会有请求风暴。
// 按「天」记：以前成功一次就永久不再取，页面挂到第二天还显示昨天的「已领 3/3」。
let treasureCountDay = '';
let treasureCountAt = 0;
async function fetchTreasureCountOnce() {
  const today = new Date().toDateString();
  if (treasureCountDay === today) return;
  if (Date.now() - treasureCountAt < 60_000) return;
  treasureCountAt = Date.now();
  try {
    const data = await call('/api/treasure');
    treasureCountDay = today;
    renderTreasureCount({
      treasureStats: {
        at: Math.floor(Date.now() / 1000),
        text: data.rewardText,
        dailyLimit: data.dailyLimit,
        todayRewardTimes: data.todayRewardTimes,
        dailyFull: data.dailyFull,
      },
    }, null);
  } catch {
    /* 没选账号 / 没连上：保持「还没探测过」，下一分钟再试 */
  }
}

// 挂机表单的「用户改过」标记。3 秒轮询会把服务端值回填到控件上（为了切账号/刷新后对齐），
// 但用户刚改的那一项被回填回去就永远改不动了 —— 运行中把间隔从 60 改成 300，
// 松手 3 秒后又变回 60，用户只会以为「这破页面改不了」。
// 所以：改动即标脏，标脏的项不再回填；点「应用设置」成功后清空（那时服务端已经是新值）。
const loopDirty = new Set();
const LOOP_FIELDS = [
  'loop-rounds', 'loop-every', 'world-speedup', 'world-reroll',
  'world-pick', 'pick-every', 'world-farm', 'farm-every',
  'loop-radar', 'radar-every', 'radar-ratio', 'radar-repair',
  'pirate-on', 'pirate-every', 'pirate-repeat',
  'forge-on', 'forge-every', 'pet-on', 'pet-every', 'pet-quality', 'pet-feed',
  'idle-on', 'idle-every', 'treasure-on', 'treasure-every',
  'treasure-color-3', 'treasure-color-4', 'treasure-color-5',
  'cargo-on', 'cargo-every',
  'trade-on', 'trade-every', 'trade-speed', 'guild-ship-on', 'guild-ship-every', 'guild-ship-seek',
  'guild-order-on', 'guild-order-every',
];
for (const id of LOOP_FIELDS) {
  const node = $(id);
  if (!node) continue;
  const mark = () => {
    loopDirty.add(id);
    refreshLoop();
  };
  node.addEventListener('input', mark);
  node.addEventListener('change', mark);
}

function renderLoop(data) {
  // 运行中按钮变成「应用设置」：服务端支持热更新（下一轮生效），不用停掉重开。
  $('loop-start').disabled = false;
  $('loop-start').textContent = data.running ? '应用设置' : '开始挂机';
  $('loop-stop').disabled = !data.running;
  const last = data.history && data.history.length ? data.history[data.history.length - 1] : null;
  const spent = last && last.elapsedMs ? '，上一轮耗时 ' + dur(Math.round(last.elapsedMs / 1000)) : '';
  const state = data.stopping ? '正在停止（这一段跑完就退）' : data.running ? '挂机中' : '未在挂机';
  $('loop-hint').textContent = state + '，' + (data.running ? '已完成 ' : '累计 ') + data.completed + ' 轮'
    + spent + (data.error ? '，中止: ' + data.error : '');
  // 运行中把服务端实际生效的间隔回填到输入框（标脏的项 = 用户刚改过，不回填）。
  const syncInterval = (id, everyMs) => {
    if (loopDirty.has(id)) return;
    const input = $(id);
    if (data.running && document.activeElement !== input) input.value = String(Math.round((everyMs || 0) / 1000));
  };
  syncInterval('pick-every', data.pickEveryMs);
  syncInterval('farm-every', data.farmEveryMs);
  syncInterval('radar-every', data.radarEveryMs);
  // 修船阈值是百分数（不是毫秒），单独回填：跟间隔一样，用户刚改过（标脏）就不覆盖。
  if (data.running && typeof data.radarRepairBelow === 'number' && !loopDirty.has('radar-repair')
    && document.activeElement !== $('radar-repair')) {
    $('radar-repair').value = String(Math.round(data.radarRepairBelow));
  }
  syncInterval('pirate-every', data.pirateEveryMs);
  syncInterval('forge-every', data.forgeEveryMs);
  syncInterval('pet-every', data.petEveryMs);
  syncInterval('idle-every', data.idleEveryMs);
  syncInterval('treasure-every', data.treasureEveryMs);
  syncInterval('cargo-every', data.cargoEveryMs);
  syncInterval('trade-every', data.tradeEveryMs);
  syncInterval('guild-ship-every', data.guildShipEveryMs);
  syncInterval('guild-order-every', data.guildOrderEveryMs);
  // 状态行一律按**服务端实际生效**的开关算（未挂机时才看页面勾选）——
  // 页面勾着但服务端关着时，写「还差 20 秒」会误导。
  const gateOn = (id, serverValue) => (data.running && typeof serverValue === 'boolean' ? serverValue : $(id).checked);
  renderGate('pick-state', data.lastPickAt, data.pickEveryMs, gateOn('world-pick', data.pickEnabled), data.running);
  renderGate('farm-state', data.lastFarmAt, data.farmEveryMs, gateOn('world-farm', data.farmEnabled), data.running);
  renderGate('radar-state', data.lastRadarAt, data.radarEveryMs, gateOn('loop-radar', data.radarEnabled), data.running);
  renderGate('pirate-state', data.lastPirateAt, data.pirateEveryMs, gateOn('pirate-on', data.pirateEnabled), data.running);
  // 运行中把「刷已通关等级」回填（默认关），标脏的不动。
  if (data.running && typeof data.pirateRepeat === 'boolean' && !loopDirty.has('pirate-repeat')) {
    $('pirate-repeat').checked = data.pirateRepeat;
  }
  renderGate('forge-state', data.lastForgeAt, data.forgeEveryMs, gateOn('forge-on', data.forgeEnabled), data.running);
  renderGate('pet-state', data.lastPetAt, data.petEveryMs, gateOn('pet-on', data.petEnabled), data.running);
  // 运行中把服务端实际生效的「材料加速」回填（默认开），标脏的不动。
  if (data.running && typeof data.petFeed === 'boolean' && !loopDirty.has('pet-feed')) $('pet-feed').checked = data.petFeed;
  renderGate('idle-state', data.lastIdleAt, data.idleEveryMs, gateOn('idle-on', data.idleEnabled), data.running);
  renderGate('treasure-state', data.lastTreasureAt, data.treasureEveryMs, gateOn('treasure-on', data.treasureEnabled), data.running);
  renderGate('cargo-state', data.lastCargoAt, data.cargoEveryMs, gateOn('cargo-on', data.cargoEnabled), data.running);
  renderGate('trade-state', data.lastTradeAt, data.tradeEveryMs, gateOn('trade-on', data.tradeEnabled), data.running);
  renderGate('guild-ship-state', data.lastGuildShipAt, data.guildShipEveryMs, gateOn('guild-ship-on', data.guildShipEnabled), data.running);
  if (data.running && typeof data.guildShipSeek === 'boolean' && !loopDirty.has('guild-ship-seek')) {
    $('guild-ship-seek').checked = data.guildShipSeek;
  }
  renderGate('guild-order-state', data.lastGuildOrderAt, data.guildOrderEveryMs, gateOn('guild-order-on', data.guildOrderEnabled), data.running);
  // 运行中把「用商会指针」回填（默认开），标脏的不动。
  if (data.running && typeof data.tradeAllowSpeed === 'boolean' && !loopDirty.has('trade-speed')) {
    $('trade-speed').checked = data.tradeAllowSpeed;
  }
  renderTreasureCount(data, data.history[data.history.length - 1]);
  if (!data.treasureStats) fetchTreasureCountOnce();
  // 运行中把「抢哪些」回填到多选框（默认只勾万吨），标脏的不动。
  if (data.running && Array.isArray(data.treasureColors)) {
    for (const color of [3, 4, 5]) {
      const id = 'treasure-color-' + color;
      const box = $(id);
      if (box && !loopDirty.has(id)) box.checked = data.treasureColors.indexOf(color) >= 0;
    }
  }
  // 执行范围同理：回填加速器/拒单勾选（标脏的不动）。
  if (data.running) {
    if (!loopDirty.has('world-speedup')) $('world-speedup').checked = data.allowSpeedUp === true;
    if (!loopDirty.has('world-reroll')) $('world-reroll').checked = data.allowReroll === true;
  }
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
    const data = await call('/api/loop/start', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        rounds: Number($('loop-rounds').value || 0),
        everySeconds: Number($('loop-every').value || 60),
        speedUp: $('world-speedup').checked,
        reroll: $('world-reroll').checked,
        pickFloaters: $('world-pick').checked,
        pickEverySeconds: Number($('pick-every').value || 0),
        // 农田默认开，跟拾荒一样有独立间隔（作物最快 30 分钟熟，默认 2 分钟看一次）。
        farm: $('world-farm').checked,
        farmEverySeconds: Number($('farm-every').value || 0),
        // 情报默认开，跟拾荒/农田一样有独立间隔（默认 60 秒）；战力余量越小越激进（战败掉耐久）。
        radar: $('loop-radar').checked,
        radarEverySeconds: Number($('radar-every').value || 0),
        // 修船阈值（百分数，默认 80）：耐久低于它就留在港里修，不派出去。0 = 不修船。
        radarRepairBelow: Number($('radar-repair').value || 0),
        // 海盗讨伐（真出战）：默认开，60 秒看一眼；只打首杀等级，勾了才刷已通关的。
        pirate: $('pirate-on').checked,
        pirateEverySeconds: Number($('pirate-every').value || 0),
        pirateRepeat: $('pirate-repeat').checked,
        // 锻造默认开，默认 3 分钟看一眼（一件蓝装约 25 分钟；造好不收等于停产）。
        forge: $('forge-on').checked,
        forgeEverySeconds: Number($('forge-every').value || 0),
        // 海兽培育默认开，默认 5 分钟看一眼（蓝配方 4 小时、橙 36 小时）。
        pet: $('pet-on').checked,
        petEverySeconds: Number($('pet-every').value || 0),
        petMaxQuality: $('pet-quality').value,
        // 材料加速（投喂）默认开：只花队列要求的培育材料，每次减 4 小时。
        petFeed: $('pet-feed').checked,
        // 挂机领取（邮件 / 本段收益 / 等级奖励 / 升级）默认开，默认 5 分钟看一眼。
        idle: $('idle-on').checked,
        idleEverySeconds: Number($('idle-every').value || 0),
        // 搁浅的货轮（世界宝藏）默认开，默认 60 秒看一次（整点刷新，抢的是刷新后那几十秒）。
        // 等级是多选：默认只勾万吨（3 蓝小型 / 4 紫中型 / 5 橙万吨），全不勾 = 不派船。
        treasure: $('treasure-on').checked,
        treasureEverySeconds: Number($('treasure-every').value || 0),
        treasureColors: [3, 4, 5].filter((color) => $('treasure-color-' + color).checked),
        // 贸易港口（建筑「货轮港口」）默认开，默认 60 秒看一眼：交货换经验金币、返航领藏品奖励。
        cargo: $('cargo-on').checked,
        cargoEverySeconds: Number($('cargo-every').value || 0),
        // 海商王：默认开、60 秒一段、商会指针全用（免费道具）。
        // 联盟商船：默认开、120 秒一段、允许应聘船长。
        guildShip: $('guild-ship-on').checked,
        guildShipEverySeconds: Number($('guild-ship-every').value || 0),
        guildShipSeek: $('guild-ship-seek').checked,
        trade: $('trade-on').checked,
        tradeEverySeconds: Number($('trade-every').value || 0),
        tradeSpeed: $('trade-speed').checked,
        // 联盟订单：默认开、600 秒看一眼（料是加工品，工厂一炉 30~300 分钟）。
        guildOrder: $('guild-order-on').checked,
        guildOrderEverySeconds: Number($('guild-order-every').value || 0),
        powerRatio: Number($('radar-ratio').value || 1.2),
      }),
    });
    // 已经挂机时这一下是「应用设置」（服务端热更新，下一轮生效），不是重启。
    // 设置既然被服务端采纳了，就清掉标脏 —— 之后回填的是刚提交的值，不会再打架。
    loopDirty.clear();
    refreshLoop();
    if (data.hot) $('loop-hint').textContent = '设置已应用，下一轮生效';
  } catch (error) {
    $('loop-hint').textContent = error.message;
  }
};
$('loop-stop').onclick = async () => {
  try {
    await call('/api/loop/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    // 停了之后页面上的值就是「下次开始」的值，标脏没有意义了。
    loopDirty.clear();
    $('loop-hint').textContent = '正在停止（这一段跑完就退出）';
    refreshLoop();
  } catch (error) {
    $('loop-hint').textContent = error.message;
  }
};

// 勾选 / 间隔的变更由上面的 LOOP_FIELDS 统一处理（标脏 + 立刻重画状态），
// 这里不再逐个绑 onchange —— 两套绑定会让每次改动触发两次 /api/loop。

// 手动「立刻领取一次」：不看间隔，跟挂机里那套完全一样。
$('idle-run').onclick = async () => {
  $('idle-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/idle/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : '';
    $('idle-view').textContent = (data.text || '') + tail;
    $('idle-state').textContent = results.length ? '执行完成' : '没有可领的';
    refreshLoop();
  } catch (error) {
    $('idle-state').textContent = error.message;
  }
};

// 手动「立刻抢一次」：不看间隔，跟挂机里那套完全一样（探测 → 按勾选的等级抢货轮，被占着的也派）。
// 勾选的等级一起带上：服务端会先存进 session.loop，面板与之后启动的挂机看到的是同一份选择。
// 手动「立刻讨伐一次」：判据跟挂机里那一段完全一样（战力余量取「自动情报」那栏），只是不等间隔。
$('pirate-run').onclick = async () => {
  $('pirate-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/pirates/run', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, repeat: $('pirate-repeat').checked }),
    });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const done = results.filter((entry) => entry.ok).length;
    // 注意：这一段在外层模板字符串里，不能写美元大括号或反引号（会被 Node 先求值），
    // 换行要写成两个反斜杠加 n（输出到浏览器才是换行符）。
    $('pirate-view').textContent = (data.text || '') + (results.length
      ? '\\n\\n本次派出 ' + done + ' 艘' + (failed ? '，失败 ' + failed + ' 条（明细见下方日志）' : '')
      : '\\n\\n这轮没有可派的目标');
    $('pirate-state').textContent = results.length ? '派出 ' + done + ' 艘' : '没有可打的';
  } catch (error) {
    $('pirate-state').textContent = error.message;
  }
};

$('treasure-run').onclick = async () => {
  $('treasure-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/treasure/run', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        treasureColors: [3, 4, 5].filter((color) => $('treasure-color-' + color).checked),
      }),
    });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : String.fromCharCode(10, 10) + '这一轮没有可抢的货轮';
    $('treasure-view').textContent = (data.text || '') + tail;
    $('treasure-state').textContent = results.length ? '执行完成' : '没有可抢的';
    refreshLoop();
  } catch (error) {
    $('treasure-state').textContent = error.message;
  }
};

// 手动「立刻锻造一次」：不看间隔，跟挂机里的那套完全一样（探测 → 收取 → 排产）。
$('forge-run').onclick = async () => {
  $('forge-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/forge/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    // 注意：整个页面是一段模板字符串，这里不能写反引号，换行用 String.fromCharCode。
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : '';
    $('forge-view').textContent = (data.text || '') + tail;
    $('forge-state').textContent = results.length ? '执行完成' : '没有要做的事';
    refreshLoop();
  } catch (error) {
    $('forge-state').textContent = error.message;
  }
};

// 手动「立刻培育一次」：探测 → 收成熟 → 材料加速 → 给空位排产，跟挂机里那套完全一样。
// 「材料加速」勾选一起带上：服务端先存进 session.loop，手动/面板/挂机看到的是同一份设置。
$('pet-run').onclick = async () => {
  $('pet-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/pet/run', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, petFeed: $('pet-feed').checked }),
    });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : '';
    $('pet-view').textContent = (data.text || '') + tail;
    $('pet-state').textContent = results.length ? '执行完成' : '没有要做的事';
    refreshLoop();
  } catch (error) {
    $('pet-state').textContent = error.message;
  }
};

// 手动「立刻交一次货」：探测 → 攒够的格子一次交掉 → 到点的船领奖，跟挂机里那套完全一样。
$('cargo-run').onclick = async () => {
  $('cargo-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/cargo/run', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : String.fromCharCode(10, 10) + '没有可交的货（料没攒够 / 船在航行 / 还没到返航时间）';
    $('cargo-view').textContent = (data.text || '') + tail;
    $('cargo-state').textContent = results.length ? '执行完成' : '没有可交的';
    refreshLoop();
  } catch (error) {
    $('cargo-state').textContent = error.message;
  }
};

// 手动「立刻跑一段海商王」：卖 → 共享商情 → 买本港特产 → 起航 → 用指针，跟挂机里那套完全一样。
$('trade-run').onclick = async () => {
  $('trade-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/trade/run', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, allowSpeed: $('trade-speed').checked }),
    });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : String.fromCharCode(10, 10) + '这一段没有要做的事（航行中 / 不在贸易时间 / 没货可买）';
    $('trade-view').textContent = (data.text || '') + tail;
    $('trade-state').textContent = results.length ? '执行完成' : '没有要做的事';
    refreshLoop();
  } catch (error) {
    $('trade-state').textContent = error.message;
  }
};

// 手动「立刻跑一段联盟商船」：补货 → 应聘船长，跟挂机里那套完全一样。
$('guild-ship-run').onclick = async () => {
  $('guild-ship-state').textContent = '执行中 ...';
  try {
    const data = await call('/api/guildship/run', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, allowSeek: $('guild-ship-seek').checked }),
    });
    const results = data.results || [];
    const failed = results.filter((entry) => entry.ok === false && !entry.skipped).length;
    const tail = results.length
      ? String.fromCharCode(10, 10) + '执行 ' + results.length + ' 个动作' + (failed ? '，失败 ' + failed : '')
      : String.fromCharCode(10, 10) + '这一段没有要做的事（船位满 / 缺料 / 没有空舱 / 本期末开启）';
    $('guild-ship-view').textContent = (data.text || '') + tail;
    $('guild-ship-state').textContent = results.length ? '执行完成' : '没有要做的事';
    refreshLoop();
  } catch (error) {
    $('guild-ship-state').textContent = error.message;
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
      { cell: { icon: b.icon, id: b.buildingId } },
      b.type || '未知类型',
      b.building ? { chip: 'waiting', text: '施工中' } : { chip: 'ready', text: '待建' },
    ])));
  }
  if ((data.factories || []).length) {
    fbox.appendChild(el('h2', null, '工厂'));
    fbox.appendChild(table(['建筑', '类型', '等级', '队列', '自动生产'], data.factories.map((b) => [
      { cell: { icon: b.icon, id: b.buildingId } },
      b.type,
      'lv' + b.level,
      String(b.queue),
      b.auto ? '自动: ' + b.auto : '',
    ])));
  }
  // 农田：熟 / 生长中 / 空闲（要播种）。游戏内「自动种植」开着时只收不种，这里也标出来。
  if ((data.farms || []).length) {
    fbox.appendChild(el('h2', null, '农田' + (data.autoFarming ? '（游戏内自动种植已开，只收不种）' : '')));
    fbox.appendChild(table(['农田', '作物', '状态'], data.farms.map((f) => [
      { cell: { icon: f.icon, id: f.buildingId } },
      f.productId ? { cell: { icon: f.cropIcon, id: f.productId } } : '空',
      f.ripe ? { chip: 'ready', text: '可收' }
        : f.idle ? { chip: 'waiting', text: '空闲，待播种' }
          : { chip: 'waiting', text: '生长中 ' + f.remainSeconds + 's' },
    ])));
  }
  const obox = clear($('world-orders'));
  if ((data.orders || []).length) {
    obox.appendChild(el('h2', null, '居民订单'));
    obox.appendChild(table(['订单', '居民', '需求', '缺口'], data.orders.map((o) => [
      '#' + o.index,
      { cell: null, text: o.workerId + (o.isSpecial ? '（特殊）' : '') },
      { cells: o.requirements },
      (o.missing || []).length === 0 ? { chip: 'done', text: '材料齐' } : { cells: o.missing, prefix: '缺 ' },
    ])));
  }
  const sbox = clear($('world-stock'));
  for (const entry of data.stock || []) sbox.appendChild(cell(entry.icon, 30, entry.id, fmt(entry.num)));
  if (!sbox.childElementCount) sbox.appendChild(el('span', 'dim', '仓库空'));
  $('world-fields').textContent = data.resFields?.text || '';
}

// ---- 联盟情报 --------------------------------------------------------------
// 一张表说清「哪些能打、为什么不能打」。判定全在服务端算好（radar.mjs），前端只画。
function renderRadar(data) {
  $('radar-view').textContent = data.text;
  const box = clear($('radar-events'));
  const fleets = data.fleets || [];
  if (fleets.length) {
    const below = Number(data.repairBelow) || 0;
    box.appendChild(el('h2', null, below > 0 ? '舰队（耐久 <' + Math.round(below * 100) + '% 就留在港里修）' : '舰队'));
    // cell 分支要的是资产对象 {icon, id}（服务端已经把 icon 一起返回了），
    // 之前只传了 cell: fleet.icon（只是个图标对象，没有 id），名字就渲染成 undefined。
    box.appendChild(table(['舰队', '状态', '战力', '耐久', '维修'], fleets.map((fleet) => [
      { cell: { icon: fleet.icon, id: fleet.buildingId } },
      fleet.stateText,
      fmt(fleet.power),
      fleet.maxDurability > 0
        ? fmt(fleet.durability) + '/' + fmt(fleet.maxDurability) + '（' + Math.round((fleet.duraPct || 0) * 100) + '%）'
        : '—',
      // 维修列只报「这轮会做什么」：要修但船不在港（航行/战斗）时如实说，别让人以为排漏了。
      fleet.repairable
        ? '要修（汽油 ' + (fleet.repairCost == null ? '?' : fmt(fleet.repairCost)) + '）'
        : fleet.repairing ? '修理中' : (fleet.needRepair ? '等船回港' : ''),
    ])));
  }
  box.appendChild(el('h2', null, '情报事件'));
  const events = data.events || [];
  if (!events.length) {
    box.appendChild(el('div', 'dim', '情报里现在没有事件'));
    return;
  }
  box.appendChild(table(['事件', '敌方战力', '状态', '奖励'], events.map((event) => [
    // 固定事件来自 fixedEvent 字段，跟随机事件同名同格式地混在一张表里，
    // 不标出来会让人以为「这条怎么一直在、打不掉」。
    event.fixed ? event.name + '（固定）' : event.name,
    event.enemyPower > 0 ? fmt(event.enemyPower) : '无需战斗',
    // 判定由服务端算好（radar.mjs 的 verdict / verdictChip）：页面再自己算一套，
    // 就会漏掉「已派兵」「配置过期」这类新状态，跟文本视图各说各话。
    { chip: event.verdictChip || 'blocked', text: event.verdict || event.stateText || '' },
    (event.reward || []).slice(0, 3).map((asset) => asset.id + '×' + fmt(asset.num)).join('、')
      + ((event.reward || []).length > 3 ? ' 等 ' + (event.reward || []).length + ' 项' : ''),
  ])));
}

async function refreshRadar() {
  $('radar-hint').textContent = '读取中 ...';
  try {
    renderRadar(await call('/api/radar'));
    $('radar-hint').textContent = '';
  } catch (error) {
    $('radar-hint').textContent = error.message;
  }
}

$('radar-refresh').onclick = refreshRadar;
$('radar-run').onclick = () => {
  const ratio = Number($('radar-ratio').value || 1.2);
  const repairBelow = Number($('radar-repair').value || 0);
  openConfirm('联盟情报：领奖 + 派兵 + 修船', [
    el('div', null, '先把已完成（待领奖）的情报奖励一次领掉，再把**每一艘空闲船**各派去打一个能打的事件（船有几艘就派几个，互不重复）。'),
    el('div', null, '战力余量 ' + ratio + '×：舰队战力 ≥ 敌方 × ' + ratio + ' 才派。战败会掉舰船耐久，调小就是拿船去赌。'),
    el('div', null, repairBelow > 0
      ? '耐久 <' + repairBelow + '% 的船不派出去，改成留在港里**修满**（花汽油，耗时按服务端下发的单位代价算；修船期间这艘船派不出去）。'
      : '修船已关闭（阈值 0）：耐久再低也照派，自己承担战损。'),
    el('div', null, '派兵会消耗汽油（余量见下方舰队表）；同一时刻只有一艘船能打一个点。'),
    el('div', null, '不想手动点：回「挂机」页把「自动情报」勾上，它会按设定的间隔自己跑这一套。'),
  ], async () => {
    $('radar-hint').textContent = '执行中 ...';
    try {
      const data = await call('/api/radar/run', { method: 'POST', body: JSON.stringify({ confirm: true, powerRatio: ratio, repairBelow }) });
      const failed = data.results.filter((r) => r.ok === false).length;
      $('radar-hint').textContent = '执行 ' + data.results.length + ' 个动作，失败 ' + failed;
      renderRadar(data);
    } catch (error) {
      $('radar-hint').textContent = error.message;
    }
  });
};

$('world-plan').onclick = async () => {
  $('world-hint').textContent = '探测中 ...';
  try {
    // 计划要跟着勾选状态走，否则「探测计划」比「执行一轮」少几行，看着像 bug。
    renderWorld(await call('/api/world?pick=' + ($('world-pick').checked ? '1' : '0')
      + '&farm=' + ($('world-farm').checked ? '1' : '0')));
    $('world-hint').textContent = '';
  } catch (error) {
    $('world-hint').textContent = error.message;
  }
};
$('world-run').onclick = () => {
  openConfirm('执行一轮海面自动化', [
    el('div', null, '会收成品、竣工、交居民订单、给空闲工厂按缺口排产、收农田并重新播种、把余料拿去升级建筑。'),
    el('div', null, '加速只花加速器（' + ($('world-speedup').checked ? '当前允许' : '当前不允许') + '），钻石与付费礼包永不购买。'),
    el('div', null, $('world-pick').checked ? '会顺带扫海面漂浮物（拾荒），捡完打印所得。' : '未勾「自动拾荒」，不会动海面漂浮物。'),
    el('div', null, $('world-farm').checked ? '会收成熟作物并补种空地（种子按价值高的先用）。' : '未勾「农田」，不碰农田。'),
    el('div', null, '拾荒与农田的「时间间隔」只约束自动循环，手动执行不看间隔。'),
  ], async () => {
    $('world-hint').textContent = '执行中 ...';
    try {
      const body = {
        confirm: true,
        speedUp: $('world-speedup').checked,
        reroll: $('world-reroll').checked,
        pickFloaters: $('world-pick').checked,
        farm: $('world-farm').checked,
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
// 「英雄本体」那一列（等级/升星/技能各升多少）由后端算好放进 kpi，
// 页面只负责摆出来 —— 条件判定留在 heroes.mjs 一处，避免两边漂。
// 养成开关：勾选状态存在页面变量里，重新探测/切换 tab 都不会把它重置回默认值。
const heroSwitches = {};

function heroSwitchBody() {
  const out = {};
  for (const [key, value] of Object.entries(heroSwitches)) out[key] = value !== false;
  return out;
}

function renderHeroSwitches(labels) {
  const bar = clear($('hero-switches'));
  bar.appendChild(el('span', 'k', '执行范围'));
  for (const [key, label] of Object.entries(labels || {})) {
    if (!(key in heroSwitches)) heroSwitches[key] = true;
    const wrap = el('label', 'dim');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = heroSwitches[key] !== false;
    box.onchange = () => { heroSwitches[key] = box.checked; };
    wrap.appendChild(box);
    wrap.appendChild(document.createTextNode(' ' + label));
    bar.appendChild(wrap);
  }
}

// 材料一眼可见：这几样决定了「探测出来的一堆升级到底做不做得动」。
function renderHeroStock(stock) {
  if (!stock) return;
  $('hero-stock').textContent = Object.entries(stock).map(([id, n]) => id + ' ' + fmt(n)).join(' · ');
}

// 英雄本体三件事各占一行，和右边的勋章/装备列一起对齐，读起来是「这个英雄能升什么」的清单。
function heroKpiLines(hero) {
  const out = [];
  if (hero.kpi?.level) out.push('等级 ' + hero.kpi.level);
  if (hero.kpi?.star) out.push('升星 ' + hero.kpi.star);
  if (hero.kpi?.skill) out.push('技能 ' + hero.kpi.skill);
  return out;
}

// 专武那一格：第一行永远是「当前等级 · 星级」（这才是判断卡在哪的依据 ——
// 0 星封顶 50 级、升级还要英雄 15 星），后面才是本轮能升什么。
// hasExclusive=false 的英雄压根没有专武系统，直接显示 —，不要显示成 0 级。
function heroExclusiveLines(hero) {
  if (!hero.hasExclusive) return null;
  const cur = hero.exclusive || { level: 0, star: 0 };
  return ['lv' + (cur.level || 0) + ' · ' + (cur.star || 0) + ' 星'].concat(hero.exclusiveItems || []);
}

// 一格最多两行，剩下的收成「另 N 项」；完整内容挂在 title 上，鼠标停一下能看全。
function heroLines(list, limit) {
  const wrap = el('div', 'grow-lines');
  if (!list || !list.length) {
    wrap.appendChild(el('span', 'dim', '—'));
    return wrap;
  }
  const shown = list.slice(0, limit || 2);
  for (const line of shown) {
    const row = el('div', 'grow-line', line);
    row.title = line;
    wrap.appendChild(row);
  }
  if (list.length > shown.length) wrap.appendChild(el('div', 'grow-more', '另 ' + (list.length - shown.length) + ' 项'));
  return wrap;
}

// 英雄名 + 「主战」标记：默认只看主战英雄，勾了「含未上阵」时才需要靠这枚标记分辨。
function heroWhoCell(hero) {
  const wrap = el('div', 'who-cell');
  wrap.appendChild(iconEl(hero.head || hero.icon, 26, hero.heroId));
  wrap.appendChild(el('span', null, hero.heroId));
  if (hero.front) wrap.appendChild(chip('done', '主战'));
  return wrap;
}

function renderHeroes(data) {
  renderHeroSwitches(data.switchLabels);
  renderHeroStock(data.stock);
  const formation = data.formation || {};
  $('hero-bench').checked = formation.onlyFront === false;
  // 主战人数直接写进材料行，省得用户自己数：材料只给这几个。
  const frontInfo = formation.frontCount != null
    ? '主战 ' + formation.frontCount + '/' + (formation.total ?? '?') + (formation.onlyFront === false ? '（显示全部）' : '')
    : '';
  if (frontInfo) $('hero-stock').textContent = frontInfo + ' · ' + ($('hero-stock').textContent || '');
  // PAGE 是模板字符串，这里的换行转义必须写两个反斜杠，否则会在页面脚本里变成真实换行、直接语法错误。
  $('hero-view').textContent = [data.text, data.growthText].filter(Boolean).join('\\n');
  const box = clear($('hero-table'));
  const rows = (data.heroes || []).map((hero) => {
    const btn = el('button', 'tiny primary', '养成');
    btn.disabled = !hero.actions && !hero.kpi?.level && !hero.kpi?.star && !hero.kpi?.skill;
    btn.onclick = () => growHeroes({ heroId: hero.heroId, name: hero.name || hero.heroId });
    return [
      heroWhoCell(hero),
      'lv' + hero.level,
      hero.star + ' 星',
      { num: true, text: fmt(hero.power) },
      heroLines(heroKpiLines(hero), 3),
      heroLines(hero.badgeItems),
      heroLines(hero.equipItems),
      heroLines(heroExclusiveLines(hero), 3),
      btn,
    ];
  });
  box.appendChild(table(['英雄', '等级', '星级', { label: '战力', num: true }, '英雄本体', '勋章', '装备', '专武', '操作'], rows));
}

// 执行：单个英雄 or 全部主战（战力从高到低吃材料，后端按这个顺序算）。
function growHeroes(target) {
  const bench = $('hero-bench').checked;
  const who = target?.heroId
    ? '「' + (target.name || target.heroId) + '」'
    : (bench ? '全部英雄' : '全部主战英雄');
  openConfirm('英雄养成：' + who, [
    el('div', null, '会对' + who + '执行上方勾选的养成项：勋章强化/替换、装备升级/精炼/升星/替换、专武升级/升星，以及英雄等级、升星、技能。'),
    el('div', 'dim', '材料不够的项不会执行；执行前会重新探测一遍。替换类操作会把身上那件换下来（服务端返还材料），不要把「装备替换」「勋章替换」当成只读开关。'),
    el('div', 'dim', '专武：升级一次一级，最高被「专武星级」卡住（0 星 50 级）；升星只花本英雄自己的碎片，不动万能碎片。'),
    el('div', 'dim', '恒定不做：不花钻石、不分解勋章、不用加速器。'),
  ], async () => {
    $('hero-hint').textContent = '执行中 ...';
    try {
      const body = { confirm: true, switches: heroSwitchBody(), includeBench: bench };
      if (target?.heroId) body.heroId = target.heroId;
      const data = await call('/api/heroes/grow', { method: 'POST', body: JSON.stringify(body) });
      $('hero-hint').textContent = '发出 ' + data.sent + ' 个请求，失败 ' + data.failed + '，耗时 ' + Math.round(data.ms / 1000) + 's';
      $('hero-plan').onclick();
    } catch (error) {
      $('hero-hint').textContent = error.message;
    }
  });
}

$('hero-plan').onclick = async () => {
  $('hero-hint').textContent = '探测中 ...';
  try {
    // bench=1 才把未上阵的英雄也读进来（默认只算主战阵容）。
    renderHeroes(await call('/api/heroes' + ($('hero-bench').checked ? '?bench=1' : '')));
    $('hero-hint').textContent = '';
  } catch (error) {
    $('hero-hint').textContent = error.message;
  }
};
// 切换「含未上阵」直接重读一遍，不用再点探测。
$('hero-bench').onchange = () => $('hero-plan').onclick();
$('hero-grow').onclick = () => growHeroes(null);

// ---- 日常 ------------------------------------------------------------------
const DAILY_LABEL = { ready: '可做', paid: '需付费', partial: '部分可做', waiting: '等待中', done: '已完成', blocked: '不可用', error: '出错', unknown: '未知' };

function renderDailies(data) {
  const box = clear($('dailies-table'));
  box.appendChild(table(['任务', '进度', '状态', '动作 / 原因'], data.tasks.map((entry) => [
    entry.task.title,
    entry.task.progress + '/' + entry.task.targetProgress,
    { chip: entry.status, text: DAILY_LABEL[entry.status] || entry.status },
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
      return [label, chest.activity + ' 活跃', { chip: tiers.length ? 'ready' : 'done', text: tiers.length ? '可领' : '不欠' }, tail];
    };
    box.appendChild(table(['活跃奖励', '活跃度', '状态', '动作 / 原因'], [
      line('每日宝箱', data.chests.daily),
      line('每周宝箱', data.chests.weekly),
    ]));
  }
  if (data.gift) {
    const free = data.gift.freeAvailable;
    box.appendChild(table(['每日礼包', '状态', '动作 / 原因'], [
      ['每日精选赠礼', { chip: free ? 'ready' : 'done', text: free ? '可领' : '已领' },
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

// ---- 工厂 ------------------------------------------------------------------
// 倒计时用服务端给的 finishAt（Unix 秒）在本地每秒重算，不靠轮询；
// 只有「能造什么、材料够不够」这类会变的状态才重新问服务端。
const facState = { data: null, picked: new Map(), ticks: [], loading: false };

// 提示行分三色：成功绿 / 进行中黄 / 出错红。
// 全塞同一个颜色的话，「已排产」和「造不了」看起来一模一样，等于没提醒。
function factoryHint(text, kind) {
  const node = $('factory-hint');
  node.textContent = text || '';
  node.className = kind === 'bad' ? 'bad' : kind === 'ok' ? 'ok' : 'warn';
}

function countdown(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total <= 0) return '可收取';
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return (h > 0 ? h + ':' + pad(m) : pad(m)) + ':' + pad(total % 60);
}

function tickFactories() {
  if (!facState.ticks.length) return;
  const now = Math.floor(Date.now() / 1000);
  for (const tick of facState.ticks) {
    // 队首之外的都是「排队中」：游戏里制造位是串行的，只有正在做的那一项有完成时间。
    if (tick.pending) {
      tick.node.textContent = '排队中';
      tick.fill.style.width = '0%';
      continue;
    }
    const left = Math.max(0, tick.finishAt - now);
    tick.node.textContent = countdown(left);
    // 进度按配方时长算；没有 produceTime（表里查不到这条配方）就只显示倒计时，不画进度。
    const pct = tick.total > 0 ? Math.min(100, Math.max(0, ((tick.total - left) / tick.total) * 100)) : (left > 0 ? 0 : 100);
    tick.fill.style.width = pct.toFixed(1) + '%';
  }
}
setInterval(tickFactories, 1000);

function recipeTitle(recipe) {
  // 瞬成的配方写清楚「原时长 → 0 秒」：这是自动挂机一次性排满队列的前提。
  const parts = [recipe.instant
    ? '生产瞬成（原 ' + dur(recipe.produceTime) + '，减免后 0 秒，排下去就完成）'
    : '生产 ' + dur(recipe.finalSeconds ?? recipe.produceTime)
      + (recipe.finalSeconds != null && recipe.finalSeconds !== recipe.produceTime ? '（原 ' + dur(recipe.produceTime) + '）' : '')];
  if (recipe.costs.length) {
    parts.push('消耗 ' + recipe.costs.map((c) => c.id + ' ' + fmt(c.have) + '/' + c.num + (c.enough ? '' : '（不够）')).join('，'));
  }
  if (!recipe.unlocked) parts.push('要 lv' + recipe.unlockLevel + ' 才解锁');
  if (recipe.limitType) parts.push('限时活动：' + recipe.limitType);
  if (recipe.atCap) parts.push('持有 ' + fmt(recipe.held) + ' 个，到上限了（仓库 ' + fmt(recipe.inStock) + ' + 待收/在造 ' + fmt(recipe.inFactory) + '）');
  if (recipe.queuedCount) parts.push('队列里已有 ' + recipe.queuedCount + ' 个（可以继续排）');
  return parts.join(' ｜ ');
}

// 造不了时把「卡在哪、怎么解决」说成一句人话 —— 服务端只会回一句 storage full。
function blockReason(factory, recipe) {
  const cap = facState.data ? facState.data.stockCap : 0;
  const slots = facState.data ? facState.data.slots : 0;
  const parts = [];
  if (!recipe.unlocked) parts.push('要 ' + factory.buildingId + ' 升到 lv' + recipe.unlockLevel + ' 才解锁');
  if (recipe.atCap) {
    const advice = recipe.capKind === 'stock'
      ? '仓库里这批已经堆到上限了，先把它消耗掉（交订单 / 建造）再来造'
      : '先点「一键收成」把工厂里囤的收走再来造';
    parts.push('持有量到上限了（仓库 ' + fmt(recipe.inStock) + ' + 工厂待收/在造 ' + fmt(recipe.inFactory)
      + ' = ' + fmt(recipe.held) + '，上限 ' + (cap || '?') + '）：' + advice);
  }
  if (!recipe.enough) {
    const lack = recipe.costs.filter((c) => !c.enough).map((c) => c.id + ' ' + fmt(c.have) + '/' + c.num);
    parts.push('材料不够：' + lack.join('、'));
    // 能靠自选包补齐时说清要花几个包；换不出来的材料要说明只能等生产。
    if (recipe.packable) parts.push('可用 ' + recipe.packText + ' 换出来（点「兑料并制造」）');
    else if (recipe.unpackable && recipe.unpackable.length) parts.push(recipe.unpackable.join('、') + ' 没有能换它的自选包，只能等生产/采集');
  }
  if (factory.full) parts.push('制造位满了 ' + factory.queue.length + '/' + (slots || '?') + '，等它做完或收掉');
  return '造不了 ' + recipe.itemId + '：' + parts.join('；');
}

function factoryCard(factory, data) {
  const card = el('div', 'fac');
  const head = el('div', 'head');
  head.appendChild(iconEl(factory.icon, 34, factory.type));
  head.appendChild(el('span', 'name', factory.buildingId));
  head.appendChild(el('span', 'meta', (factory.type || '类型未知') + ' · lv' + factory.level));
  head.appendChild(chip(factory.full ? 'blocked' : 'ready', '制造位 ' + factory.queue.length + '/' + data.slots));
  if (factory.finishedTotal) head.appendChild(chip('done', '待收 ' + factory.finishedTotal));
  if (factory.autoProductId) head.appendChild(chip('waiting', '自动生产 ' + factory.autoProductId));
  card.appendChild(head);

  const cols = el('div', 'cols');

  // 左：正在制造 + 待收成品
  const qcol = el('div', 'col');
  qcol.appendChild(el('div', 'col-title', '正在制造'));
  if (!factory.queue.length) {
    qcol.appendChild(el('div', 'dim', factory.autoProductId ? '队列空着，自动生产会补上' : '空闲中'));
  }
  for (const job of factory.queue) {
    const row = el('div', 'job');
    row.appendChild(iconEl(job.icon, 24, job.productId));
    row.appendChild(el('span', 'naming', job.productId));
    const bar = el('span', 'pbar');
    const fill = el('i');
    bar.appendChild(fill);
    row.appendChild(bar);
    const left = el('span', 'left', job.pending ? '排队中' : countdown(job.remain));
    row.appendChild(left);
    qcol.appendChild(row);
    // 分母用减免后的秒数：840 秒减免下 1200 秒的配方实际 360 秒就完成，
    // 拿原时长当分母的话进度条真做完时只走到三成，然后突然跳满。
    facState.ticks.push({ node: left, fill, finishAt: job.finishAt, total: job.finalSeconds ?? job.produceTime, pending: job.pending });
  }
  if (factory.finished.length) {
    qcol.appendChild(el('div', 'col-title', '待收成品'));
    const done = el('div', 'icons');
    for (const asset of factory.finished) done.appendChild(cell(asset.icon, 24, asset.id, '×' + fmt(asset.num)));
    qcol.appendChild(done);
  }
  cols.appendChild(qcol);

  // 右：可制造配方（未解锁的灰着但保留，好解释「为什么没有」）
  const rcol = el('div', 'col');
  const pickedId = facState.picked.get(factory.buildingId);
  rcol.appendChild(el('div', 'col-title', '可制造 · 点一下选中'));
  const grid = el('div', 'recipes');
  if (!factory.recipes.length) {
    grid.appendChild(el('span', 'dim', factory.type ? '配置表里没有这个工厂类型的配方' : '认不出工厂类型，读不到配方'));
  }
  for (const recipe of factory.recipes) {
    const node = el('div', 'recipe');
    if (!recipe.unlocked) node.classList.add('locked');
    else if (!recipe.enough || recipe.atCap) node.classList.add('lack');
    if (recipe.itemId === pickedId) node.classList.add('on');
    node.appendChild(iconEl(recipe.icon, 24, recipe.itemId));
    const txt = el('div');
    txt.appendChild(el('span', 'nm', recipe.itemId));
    // 状态直接写在副标题上：满 / 缺料 / 已排几个。光把格子变暗，看不出是为什么。
    const sub = el('span', 'sub');
    // 瞬成配方显示「瞬成」而不是原时长：写 5 分 0 秒会让人以为还得等 5 分钟。
    sub.appendChild(document.createTextNode(recipe.instant ? '瞬成' : dur(recipe.finalSeconds ?? recipe.produceTime)));
    if (!recipe.unlocked) sub.appendChild(document.createTextNode(' · lv' + recipe.unlockLevel));
    if (recipe.atCap) sub.appendChild(el('span', 'miss', ' · 满'));
    else if (!recipe.enough) sub.appendChild(el('span', 'miss', ' · 缺料'));
    if (recipe.queuedCount) sub.appendChild(document.createTextNode(' · ×' + recipe.queuedCount));
    txt.appendChild(sub);
    node.appendChild(txt);
    node.title = recipeTitle(recipe);
    node.onclick = () => {
      if (!recipe.unlocked) {
        factoryHint(recipe.itemId + ' 要 ' + factory.buildingId + ' 升到 lv' + recipe.unlockLevel + ' 才解锁', 'bad');
        return;
      }
      if (facState.picked.get(factory.buildingId) === recipe.itemId) facState.picked.delete(factory.buildingId);
      else facState.picked.set(factory.buildingId, recipe.itemId);
      renderFactories(facState.data);
    };
    grid.appendChild(node);
  }
  rcol.appendChild(grid);

  // 选中才出现制造按钮：避免手滑就把材料烧了
  const picked = factory.recipes.find((recipe) => recipe.itemId === pickedId);
  if (picked) {
    const why = [];
    if (!picked.unlocked) why.push('未解锁');
    if (!picked.enough) why.push('材料不够');
    if (picked.atCap) why.push('仓库到上限');
    if (factory.full) why.push('制造位满');
    // 缺料但能用白名单自选包（原料 / 工事材料）补齐 → 给一个明确写着消耗的按钮。
    // 只缺料能兑：未解锁 / 到上限 / 制造位满这几条兑料也解决不了，仍然挡住。
    const packPay = !picked.enough && picked.packable;
    const blockers = why.filter((item) => item !== '材料不够' || !packPay);
    const foot = el('div', 'pick');
    // 缺口写清楚「差多少、花几个包」：只写「材料不够」等于没说。
    const lackText = !picked.enough
      ? ' ｜ 缺 ' + picked.costs.filter((c) => !c.enough).map((c) => c.id + ' ' + fmt(c.have) + '/' + c.num).join('、')
        + (picked.packable ? '，可用 ' + picked.packText + ' 补' : '')
      : '';
    foot.appendChild(el('div', 'dim', '已选 ' + picked.itemId + '：' + dur(picked.finalSeconds ?? picked.produceTime)
      + (picked.costs.length ? '，耗 ' + picked.costs.map((c) => c.id + '×' + c.num).join(' ') : '')
      + (why.length ? '（' + why.join('、') + '）' : '') + lackText));
    const btn = el('button', 'primary tiny', (packPay ? '兑料并制造 ' : '制造 ') + picked.itemId);
    // 按钮**不禁用**：灰着一个没反应的按钮，用户不知道卡在哪。
    // 点下去如果造不了，就在提示行把原因说清楚，别发请求。
    btn.onclick = async () => {
      if (blockers.length) {
        factoryHint(blockReason(factory, picked), 'bad');
        return;
      }
      btn.disabled = true;
      factoryHint((packPay ? '正在用 ' + picked.packText + ' 兑料并排产 ' + picked.itemId + ' ...' : '正在排产 ' + picked.itemId + ' ...'), 'warn');
      try {
        const data = await call('/api/factory/produce', {
          method: 'POST',
          body: JSON.stringify({ confirm: true, buildingId: factory.buildingId, productId: picked.itemId, usePack: packPay }),
        });
        factoryHint(data.note || '', 'ok');
        // 选中状态留着：同一个产品要连排几个时，可以接着点，不用重新选。
        renderFactories(data);
      } catch (error) {
        factoryHint(error.message, 'bad');
        // 被服务端拒通常意味着本地数据过期了（刚被消耗掉 / 刚满），拉一次最新的修正按钮状态。
        refreshFactories();
      }
    };
    foot.appendChild(btn);
    rcol.appendChild(foot);
  }

  cols.appendChild(rcol);
  card.appendChild(cols);
  return card;
}

function renderFactories(data) {
  facState.data = data;
  facState.ticks = [];
  const box = clear($('factory-list'));
  const list = data.factories || [];
  const making = list.reduce((sum, factory) => sum + factory.queue.length, 0);
  const waiting = list.reduce((sum, factory) => sum + factory.finishedTotal, 0);
  // 收成按钮直接带待收数量，为 0 时禁用 —— 省得点了才发现没东西可收。
  $('factory-gain').disabled = waiting === 0;
  $('factory-gain').textContent = waiting ? '一键收成（' + waiting + '）' : '一键收成';
  $('factory-summary').textContent = list.length
    ? list.length + ' 座工厂 · 在造 ' + making + ' 个 · 待收 ' + waiting + ' 个 · 制造位上限 ' + data.slots
      + (data.produceReduce > 0
        ? ' · 生产减免 ' + dur(data.produceReduce) + '（≤此时长的配方瞬成，自动挂机会一次排满）'
        : '')
    : '';
  if (!list.length) {
    box.appendChild(el('div', 'dim', '这个账号还没有工厂建筑。'));
    return;
  }
  for (const factory of list) box.appendChild(factoryCard(factory, data));
  tickFactories();
}

async function refreshFactories() {
  if (facState.loading) return;
  facState.loading = true;
  // 不主动清提示：自动刷新每 5 秒来一次，清了的话「收成 XX×N」这种结果刚出来就没了。
  // 想清空的场景只有用户手点「刷新工厂」，那个入口自己清。
  try {
    renderFactories(await call('/api/factory'));
  } catch (error) {
    factoryHint(error.message, 'bad');
  } finally {
    facState.loading = false;
  }
}

$('factory-refresh').onclick = () => {
  factoryHint('', 'warn');
  refreshFactories();
};

// 一键收成：一次把所有工厂的囤积成品收掉，回来直接刷新视图（响应里已经带新状态）。
$('factory-gain').onclick = async () => {
  $('factory-gain').disabled = true;
  factoryHint('正在收取所有工厂的成品 ...', 'warn');
  try {
    const data = await call('/api/factory/gain', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    factoryHint(data.note || '', 'ok');
    renderFactories(data);
  } catch (error) {
    factoryHint(error.message, 'bad');
    $('factory-gain').disabled = false;
  }
};

// 页面停在工厂时才轮询，别的页不看它，省得跟总览抢连接。
setInterval(() => {
  if (activeTab !== 'factory') return;
  if (!$('factory-auto').checked) return;
  if (!current || !snapshot.connected) return;
  refreshFactories();
}, 5000);

// ---- 统计 ------------------------------------------------------------------
// 数全部在服务端按归档回包算好（src/stats.mjs），这里只负责摆位置。
// statsDay 空串 = 今天：这样跨 0 点不用手动改，仍然是"当前这天"。
let statsDay = '';

function dayString(ms) {
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 占比条：数量 / 这一类合计。全是 0 时给 0%，不留一根满格的假条。
function shareCell(num, total) {
  const wrap = el('div', 'share');
  const track = el('div', 'track');
  const fill = el('i');
  fill.style.width = total > 0 ? Math.max(1, Math.round((num / total) * 100)) + '%' : '0%';
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el('span', 'pct', total > 0 ? Math.round((num / total) * 100) + '%' : '-'));
  return wrap;
}

// 一种东西一行：图标+名字 / 数量 / 占比。数量单独一列，不然「淡水 x346」看不出排序感。
function lootTable(source) {
  return table(
    ['物品', { label: '数量', num: true }, '占比'],
    source.items.map((entry) => [
      { cell: { id: entry.id, icon: entry.icon } },
      { num: true, text: fmt(entry.num) },
      shareCell(entry.num, source.total),
    ]),
  );
}

function renderStatsSource(id, noteId, source, emptyText) {
  const box = clear($(id));
  const note = $(noteId);
  if (note) note.textContent = source ? '（' + source.count + ' 次 · ' + source.items.length + ' 种）' : '';
  if (!source || !source.items.length) {
    box.appendChild(el('span', 'dim', emptyText));
    return;
  }
  box.appendChild(lootTable(source));
}

function renderStats(data) {
  const kpi = clear($('stats-kpi'));
  const kpiItem = (key, value, sub) => {
    const box = el('div', 'item');
    box.appendChild(el('span', 'k', key));
    box.appendChild(el('span', 'v', value));
    if (sub) box.appendChild(el('span', 's', sub));
    return box;
  };
  const of = (key) => (data.sources || []).find((entry) => entry.key === key);
  const made = of('factory');
  const building = of('building');
  const floater = of('floater');
  const mail = of('mail');
  kpi.appendChild(kpiItem('制造件数', fmt(data.kpi.made), data.kpi.madeKinds + ' 种产品'));
  // 「收了几次」用请求数（activity 里的 gain），「成功几次」用回包数：两者差出来的就是被服务端拒掉的。
  const gainAct = (data.activity || []).find((act) => act.key === 'gain');
  kpi.appendChild(kpiItem('收成品', fmt(gainAct ? gainAct.count : 0) + ' 次', '成功 ' + fmt(made ? made.count : 0) + ' 次'));
  kpi.appendChild(kpiItem('建筑产出', fmt(data.kpi.produced), (building ? building.items.length : 0) + ' 种'));
  kpi.appendChild(kpiItem('拾荒', fmt(data.kpi.looted), floater ? floater.items.length + ' 种' : ''));
  kpi.appendChild(kpiItem('邮件奖励', fmt(data.kpi.mails) + ' 封', '含货轮/情报/海盗'));
  kpi.appendChild(kpiItem('活动', fmt(data.kpi.acts) + ' 次', '挂机请求条数'));

  $('stats-made-title').textContent = data.isToday ? '今日制造' : data.day + ' 制造';
  renderStatsSource('stats-made', 'stats-made-note', made, data.day + ' 没有收到成品');
  renderStatsSource('stats-building', 'stats-building-note', building, data.day + ' 没有建筑产出');

  // 其他收益：每类一行图标格 —— 拾荒品种多但每样就几个，用表格反而占满一屏。
  const other = clear($('stats-other'));
  for (const source of data.sources.filter((entry) => ['floater', 'order', 'afk', 'ship', 'mail'].includes(entry.key))) {
    if (!source.items.length) continue;
    const group = el('div', 'mat-group');
    group.appendChild(el('div', 'gname', source.label + ' · ' + source.count + ' 笔 · ' + fmt(source.total) + ' 件'));
    const row = el('div', 'icons');
    for (const entry of source.items) row.appendChild(cell(entry.icon, 30, entry.id, fmt(entry.num)));
    group.appendChild(row);
    group.title = source.note || '';
    other.appendChild(group);
  }
  if (!other.childElementCount) other.appendChild(el('span', 'dim', '这一天没有拾荒 / 订单 / 挂机 / 邮件收益'));

  const acts = clear($('stats-acts'));
  if (!data.activity.length) {
    acts.appendChild(el('span', 'dim', '这一天没有活动记录'));
  } else {
    const row = el('div', 'acts');
    for (const act of data.activity) {
      const node = el('div', 'act');
      node.appendChild(document.createTextNode(act.label + ' '));
      node.appendChild(el('b', null, fmt(act.count)));
      node.appendChild(document.createTextNode(' 次'));
      row.appendChild(node);
    }
    acts.appendChild(row);
  }

  // 趋势：柱高按本次最大值归一，最高 68px。数量为 0 也画 2px 底线，看得出"这天没跑"。
  const trendBox = clear($('stats-trend'));
  const trend = data.trend || [];
  const max = Math.max(1, ...trend.map((entry) => entry.total));
  const today = dayString(Date.now());
  for (const entry of trend) {
    const col = el('div', 'col' + (entry.day === today ? ' today' : '') + (entry.total ? '' : ' flat'));
    col.appendChild(el('span', 'val', entry.total ? fmt(entry.total) : '-'));
    const bar = el('i');
    bar.style.height = Math.round((entry.total / max) * 68) + 'px';
    col.appendChild(bar);
    col.appendChild(el('span', 'lab', entry.day.slice(5)));
    col.title = entry.day + '：制造 ' + fmt(entry.total) + ' 件（收 ' + fmt(entry.count) + ' 次）';
    trendBox.appendChild(col);
  }
}

async function refreshStats() {
  // 第一次打开某一天要把它一整天的邮件快照扫一遍（实测 74MB 约 1 秒），
  // 不提示一下会以为按钮没反应。
  $('stats-stamp').textContent = '读取中…';
  try {
    const query = statsDay ? '?day=' + encodeURIComponent(statsDay) : '';
    const data = await call('/api/stats' + query);
    renderStats(data);
    // 看"今天"时服务端可能已经跨到新的一天，把日期框同步过来，免得页面上写着昨天。
    if (!statsDay && $('stats-day').value !== data.day) $('stats-day').value = data.day;
    $('stats-hint').textContent = data.isToday ? '' : '看的是历史（' + data.day + '）';
    $('stats-stamp').textContent = '数据截至 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) {
    $('stats-hint').textContent = error.message;
  }
}

function statsSetDay(day) {
  const today = dayString(Date.now());
  statsDay = day && day !== today ? day : '';
  if ($('stats-day').value !== day) $('stats-day').value = day || today;
  refreshStats();
}

function shiftStatsDay(delta) {
  const base = $('stats-day').value || dayString(Date.now());
  const [y, m, d] = base.split('-').map(Number);
  const next = new Date(y, (m || 1) - 1, (d || 1) + delta);
  // 往后翻不能翻过今天：以后的日期归档里根本没有，翻过去只会看到一页 0。
  if (next.getTime() > Date.now()) return;
  statsSetDay(dayString(next.getTime()));
}

$('stats-day').value = dayString(Date.now());
$('stats-refresh').onclick = () => refreshStats();
$('stats-prev').onclick = () => shiftStatsDay(-1);
$('stats-next').onclick = () => shiftStatsDay(1);
$('stats-today').onclick = () => statsSetDay(dayString(Date.now()));
$('stats-day').onchange = () => { if ($('stats-day').value) statsSetDay($('stats-day').value); };
setInterval(() => {
  if (activeTab !== 'stats' || !$('stats-auto').checked) return;
  refreshStats();
}, 30000);


// ---- 表格 ------------------------------------------------------------------
// 单元格可以是字符串、{num}、{chip}、{cell: 图标项}、{cells: [图标项]}
function putCell(td, spec) {
  if (spec == null) return;
  // 操作列要放按钮，直接给节点即可（其余分支都是数据描述）。
  if (typeof spec === 'object' && spec.nodeType === 1) {
    td.appendChild(spec);
    return;
  }
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
// 记住当前在看哪一页：工厂页的自动刷新只在它被选中时才跑。
let activeTab = 'overview';
document.querySelectorAll('#tabs button').forEach((button) => {
  button.onclick = () => {
    activeTab = button.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((other) => other.classList.toggle('on', other === button));
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + button.dataset.tab);
    }
    if (activeTab === 'account') {
      renderAccounts();
      pollCapture();
    }
    if (activeTab === 'idle') refreshLoop();
    if (activeTab === 'factory') refreshFactories();
    if (activeTab === 'stats') refreshStats();
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
