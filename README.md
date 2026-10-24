# crazywaterword

微信小游戏《疯狂水世界》的**协议侧挂机工具**：不开游戏界面，直接用游戏自己的 WebSocket 协议完成
日常任务、领奖、英雄养成、海面世界的收成品/排产/交单/建造/升级，并附带一个本地网页控制台。

不是模拟器、不是图像识别、不是内存修改 —— 全程只收发游戏客户端本来就会发的那些报文。

---

## 免责声明

**本项目仅供协议分析与学习研究。使用它会违反游戏的用户协议，账号可能被处罚或封禁。**

- 所有请求都由你**自己的账号、自己的凭证**发出，作者不为任何后果负责。
- 请只用你自己的账号测试，**不要**用于批量、代练、工作室或任何形式的牟利。
- 项目刻意保留了一批「不做」的边界（见下方「安全边界」），例如不花钻石、不买付费礼包、
  不使用 `LoginRequest` 里 `testAccount` / `superToken` 这类开发者后门字段。
- 如果你不接受这些，请不要使用本项目。

---

## 它是什么

| 能力 | 说明 |
|---|---|
| 登录 | 用抓包拿到的真实凭证连接网关，支持多账号 |
| 任务 | 主线、支线、成就、每日订单档位奖励的自动领取 |
| 日常 | 17 项日常任务的自动完成 + 任务奖励 + 活跃度宝箱 + 每日免费赠礼 |
| 英雄 | 升级、升星、升技能（判定条件照抄客户端红点逻辑） |
| 海面世界 | 收成品、竣工、建造新建筑、交居民订单、给空闲工厂按订单缺口排产（瞬成配方一次排满队列）、收农田并重新播种、余料升级、加速 |
| 联盟情报 | 读情报事件，按舰队战力筛能打过的，派空闲舰队去打，回来领奖励；循环里默认开启 |
| 自动循环 | 上面三块按轮执行，可只读探测、可长期挂机 |
| 回包归档 | 每条请求/推送按接口全量落盘到 `data/responses/<日期>/`，时序流水另存 `data/protocol.log` |
| 网页控制台 | 本地页面，中文业务视图，一键领取 / 一键完成 / 自动循环 / 账号与凭证管理 |

## 它不是什么

- 不做手机端抓包，不做云端同步。
- 不做资源田之外的地图争夺（占田需要舰队，多数账号不满足前置条件）。
- 不为没有图标的美术资源做手工绘制或猜测映射，找不到就退回纯文字。

---

## 环境要求

- **Node.js >= 20.11**（用到 `import.meta.dirname`），实测于 Node 22。
- Windows（微信 PC 端抓包走 HKCU 系统代理 + 当前用户根证书）。
- 唯一的运行时依赖：`protobufjs`。

```bash
npm install
```

---

## 快速开始

### 0. 补齐本地数据（首次必做）

`work/` 与 `data/` 都在 `.gitignore` 里，克隆下来是空的。运行前要从**本机的微信小游戏缓存**
和 CDN 重新生成这些数据：

```bash
node tools/sync-config.mjs    # 591 张配置表 -> work/cdn/config_cn_pack.json
node tools/sync-art.mjs       # UI 图标索引 -> work/cdn/art/（缺图集页加 --fetch 从 CDN 补）
node tools/fetch-map.mjs      # 世界地图 -> work/cdn/world_map.*.json
```

还有一项不能少：**协议表**。`src/proto.mjs` 直接读
`work/extracted/_src_chunks_/src/chunks/game.js`，它只能由 `tools/wxapkg.mjs`
从微信小程序包里解密 + 解包出来（包目录与完整命令见下方「数据来源」）。
缺了它程序直接起不来（不是降级，是抛 `ENOENT`）。

**前置条件**：电脑上**打开过一次《疯狂水世界》**，微信才会有本地小程序包与资源缓存。

### 1. 抓一份登录凭证

游戏不会把凭证交给外部程序，只能由本机代理从真实会话里抓：

```bash
node tools/capture-credentials.mjs
```

这一步会改动系统设置，所以**会先问你确认**，且改动全部限定在当前用户、随时可回滚：

- 起一个只监听 `127.0.0.1:17322` 的本地 MITM 代理；
- 把本地 CA 装进**当前用户**的根证书区（`certutil -user`）；
- 设置 **HKCU** 的 `Internet Settings` 代理。

确认之后，在电脑版微信里打开《疯狂水世界》，代理抓到 `LoginRequest` 就自动收工并回滚
（关代理、撤 CA），凭证写到 `data/credentials.json`。

也可以跳过 CLI，直接在网页控制台「账号」页点扫码添加 —— 同样的流程，带二维码与进度显示。

### 2. 启动控制台

```bash
node src/app.mjs            # 默认就是这个
```

浏览器打开 `http://127.0.0.1:17321`。页面上：

- **总览** —— 账号卡、资源与库存（带游戏自己的图标）、一键领取；
- **挂机** —— 只放自动化：轮数、循环间隔、加速/重刷开关，下面是运行记录；再往下是各自动模块自己的开关与
  **时间间隔**（「自动联盟情报」默认 60s、「拾荒」默认 300s、「农田」默认 120s）——
  自动循环每轮都会看一次，但只有「距上次执行」超过这个间隔才真的发请求，其余轮次直接跳过并说明还差多久
  （状态显示成「上次 3 分钟前 · 还差 1 分 20 秒」）；
- **英雄** —— 英雄卡片与养成计划；
- **日常** —— 手动操作统一放这页：日常任务表（中文，并说明「为什么不可做」）、任务奖励、海面（探测计划 / 执行一轮，
  含工厂、订单、仓库、资源田）、联盟情报（读取情报 / 领奖 + 派兵，含舰队表与事件表）；
  自动循环照样每轮顺带做这些，开关在「挂机」页；
- **账号** —— 多账号切换、扫码添加、凭证查看（默认打码）；
- **工厂** —— 每座工厂的制造队列（队首倒计时、后面的排队项）、囤积成品，以及这个等级能造的配方：
  点一下配方选中，再点「制造」就直接排产（不二次确认）。配方上直接标「满」（持有量 = 仓库 + 工厂待收/在造，
  到 `产品存量初始上限`）和「缺料」；造不了时点「制造」**不发请求**，而是把卡在哪写成红字：
  未解锁要几级、缺哪个材料（现有/需要）、哪一处堆到上限、该怎么解（工厂囤满 → 收成；仓库满 → 得先消耗，
  收成只会更满）。服务端的英文 prompt（`storage full` / `not enough` / `feature locked`）也会翻成人话。
  顶部「一键收成」把每座工厂的囤积成品一次收完（逐座 `GainFactoryProduceRequest`，收益按产品名合并）。
- **排产：只补空闲工厂** —— 判据是 `factoryQ` 为空。队列里还有东西在造，这座工厂一轮都不碰
  （提前排只会把料先烧掉，也不会把你手动排的队插花）。空闲时从「第一个能造的产品」开始排：
  订单缺口优先、其余按生产时间短的先排；已到存量上限 / 缺料 / 等级不够的会被过滤掉，
  所以排到的天然就是「第一个还没满的产品」。**当这座工厂下所有产品都满了，它就空着** —— 这是正常状态。
- **瞬成排产** —— 英雄委任会减少生产时间（`AppointEffectCfg`「生产时间」，本账号实测 840 秒），
  所以 90 秒的鱼/淡水、300 秒的布匹/救生衣/烤鱼、780 秒的海藻泥都是 **0 秒完成**。这类配方
  空闲时**一次把制造位排满（最多 6 个）**，不用每分钟回来补 —— 循环间隔也就可以调大。
  配方格子上会标「瞬成」，工厂页顶部显示当前减免秒数。非瞬成的（木头 1380 秒以上）空闲时只排 1 个。
- **农田（默认开，`--no-farm` 关）** —— 熟了一片全收、空出来的地同一轮补种。协议两个请求本身就支持批量
  （`FarmHarvestRequest.buildingId` 与 `FarmPlantRequest.args` 都是 repeated），所以一轮各发一条。
  播种顺序是**价值从高到低**：作物配置里没有价格字段、`produceNum` 又全是 5，唯一变量就是成熟时间，
  所以橡胶（15600s）> 花菜（7200s）> 大豆/南瓜（4800s）> 小麦/玉米（1800s），同一时长内订单缺的优先。
  种子按库存扣，不够的地块会在跳过原因里逐块列出来。
  作物最快也要 30 分钟才熟，所以它跟拾荒一样有**独立的判断间隔**（默认 120 秒，`--farm-every` 改，
  填 0 = 每轮都看）；只有真的排了收/种动作才计时，没熟也没空地时不占用间隔。
  游戏内「自动种植」（VIP 功能）开着时不重复播种，只收 —— 页面上会标出来。
- **联盟情报（默认开，`--no-radar` 关）** —— 读 `RadarInfoResponse` 的事件列表，按**舰队战力**筛：
  只有 `舰队战力 ≥ 敌方战力 × 战力余量`（默认 1.2）才派，战败会掉舰船耐久，所以宁可少打别硬上。
  先把 `state=4`（待领奖）的一次性 `RadarGetAllRewardsRequest` 全领，再把**每一艘空闲船各派一个事件**
  （一艘船同时只能打一个点，所以空闲船数就是并发上限；同一事件不会被派两次）。排序是颜色（紫 > 蓝 > 绿）→ 敌方战力 → 奖励件数。
  配对是贪心：最强的那艘先挑（拿优先级最高、通常奖励最好的），弱船顺延挑剩下能打赢的；战力不够的事件不硬派。
  `--max N` 可以限制最多派几艘（默认不限 = 有多少空闲船就派多少）。
  敌方战力来自 `WorldPirateCfg`（海盗 type/level）与 `RadarFixedEventCfg`（固定事件自带 power）。
  客户端自带的「自动雷达」不看战力、非月卡还只能派一次，我们这套是「按战力挑 + 能连续派」。
  跟拾荒/农田一样有**独立间隔**（默认 60 秒，`--radar-every` 改，0 = 每轮都看）：
  没到点就整段跳过（连探测请求都不发）；到点跑一整套「读取情报 → 领奖 → 派兵」。
  计时只在探测成功时更新 —— 探测失败不占用间隔，下一轮立刻重试。

---

## 命令行

```bash
node src/app.mjs <子命令> [参数]
```

| 子命令 | 作用 |
|---|---|
| `console`（默认） | 起本地网页控制台 |
| `selftest` | 离线自检（协议帧 / LZ4 / 账号仓库 / 素材索引 / 二维码 / 海面计划 / 活跃度宝箱 / 每日赠礼） |
| `probe` | 连接并长连，只观察服务端推送，不发任何业务请求 |
| `connect [秒]` | 连接并保持指定秒数 |
| `state` | 采集一遍只读状态集（`--raw` 原样、`--out` 写 `data/state.json`） |
| `worlds [worldId\|all]` | 账号下的区服列表与角色位置 |
| `accounts <list\|use\|label\|remove\|show>` | 多账号管理 |
| `config [表名]` | 列出本地配置表 / 打印某张表 |
| `actions` | 列出所有动作及其协议消息名 |
| `act <id> [k=v …]` | 手动发一条动作（改状态的要 `--yes`） |
| `loot [--dry]` | 一键领取：邮件、任务、成就、挂机、建筑产物/成品、活跃度宝箱、每日赠礼 |
| `tasks [--dry]` | 主线 / 支线 / 成就 / 每日订单档位 |
| `dailies [--dry] [--paid]` | 日常任务闭环 |
| `heroes [--dry]` | 英雄养成 |
| `world [--dry] [--speed-up] [--reroll] [--no-pack] [--max-pack N] [--pick] [--no-farm]` | 海面世界一轮 |
| `radar [--dry] [--power-ratio N] [--max N]` | 联盟情报：领奖 + 每艘空闲船各派一个事件（战力余量默认 1.2，`--max` 默认不限） |
| `field [gridIdx]` | 资源田报告 / 占田 / 弃田 |
| `loop [--rounds N] [--every 秒] [--no-pack] [--max-pack N] [--pick] [--pick-every 秒] [--no-farm] [--farm-every 秒] [--no-radar] [--radar-every 秒] [--power-ratio N]` | 自动循环（`--rounds 0` = 一直跑；`--pick-every` / `--farm-every` / `--radar-every` 见下） |

**任何会改变账号状态的命令都必须显式授权**：CLI 加 `--yes` 或 `CW_ALLOW_MUTATE=1`，
网页请求体里带 `confirm: true`。不加就只打印计划，一个字节都不发出去。

常用环境变量：`CW_ACCOUNT`（选账号）、`CW_PORT`（控制台端口）、`CW_DATA_DIR`、
`CW_CONFIG_PACK`、`CW_PROXY_PORT`、`CW_NO_BROWSER`、`CW_DEBUG`、
`CW_ARCHIVE=0`（关掉回包归档）、`CW_TRACE_MAX`（协议流水单文件上限，默认 32MB）、
`CW_ARCHIVE_MAX`（单条回包归档上限，默认 16MB，超了只留元信息）。

---

## 工作原理

### 通信

- 网关 `wss://dhyaoj-gate.khlgamen.com/ws`，首次连接直接发 `LoginRequest`，没有独立的挑战握手。
- 自定义帧：`int32 BE 长度` + `uint8 版本=2` + `int32 BE 序号` + `uint8 名称长度` + `ASCII 名称`
  + `uint8 标志`（0 = 原始，非零 = LZ4）+ protobuf 载荷。
- 协议定义来自客户端自带的 protobufjs **static module** 产物 —— 它没有任何反射元数据，
  字段号和字段名只能从生成的 `encode` / `decode` 函数体里读回来（`tools/describe.mjs`）。
- 每条收发都落盘，分两套（`src/archive.mjs`）：
  - `data/protocol.log` —— 时序流水，看「这一轮先发什么、后回什么」。一行一眼能看完，所以 body
    截到 400 字符（截断带 `…` 标记），心跳/序号确认（`PingRequest`/`PingResponse`/`Ack`/`Nack`）
    不进、`LoginRequest` 的 body 永不进。单文件超过 32MB 自动轮转成 `protocol.log.1`。
  - `data/responses/<本地日期>/<消息名>.jsonl` —— 原始回包档案，**全量、不截断**，一行一条
    `{"t":…,"dir":"in","seq":…,"acc":"…","body":{…}}`，191 个接口各一个文件。
    重建背包/海面/任务快照这类离线分析从这里读，别再从 47MB 的流水里 grep。
- 想查「这一轮到底排产了哪个产品」，就看
  `-> [StartFactoryProduceRequest] seq=… {"buildingId":"1食品厂","productId":"烤鱼"}` 这一行
  （流水和 `StartFactoryProduceRequest.jsonl` 里都有）。
- 落盘是**同步写**（`openSync` + `writeSync`，不留异步缓冲）：CLI 里 `state` 这种命令连一次、
  打几条就退出，`createWriteStream` 会丢掉尾巴上那几条 —— 而那几条往往正是你想看的。


### 回包归档怎么查

```bash
node tools/archive.mjs days                     # 有归档的日期
node tools/archive.mjs list                     # 今天每个接口的条数 / 入站 / 出站 / 体积
node tools/archive.mjs tail AllItemResponse 1   # 某接口最后 1 条完整回包
node tools/archive.mjs path AllItemResponse     # 文件路径（配合 grep / jq）
```

控制台另有一个只读接口：`GET /api/archive?day=2026-10-23`（不碰网关、不带 `?account`）。

老的 `data/protocol.log` 里入站 body 曾被截到 400 字符，可以回填成结构化档案：

```bash
node tools/archive-backfill.mjs --dry    # 先看统计，不写盘
node tools/archive-backfill.mjs          # 增量回填，断点记在 data/responses/.backfill.json
node tools/archive-backfill.mjs --reset  # 忽略断点重导
```

被截断的半条不会丢：标 `"partial":true`，原文放进 `body.raw` —— 半条也比没有强，
但要能一眼看出它不是完整回包。目录按本地日期切，清旧档案就是删一个日期目录。
流水轮转过的话会把 `protocol.log.1` 一起读（先 .1 后主文件，各存各的 offset），
不会因为一次轮转把上一代数据漏掉。

### 账号与区服

- 账号身份是 `login.eworldParams.openId`；机密是同一处的 `token` / `sign` / `timestamp`。
- 网关不区分区服：一个 socket 服务整个账号，区服由 `LoginRequest.worldId` 选择。
- 选服界面的键是 `GameWorldInfo.worldId`（角色**出生**服），`roleInfo.worldId` 是**当前**服；
  合服之后两者不同，服务端会把出生服键解析到承接服 —— 不了解这一点会把合服误读成 bug。
- **一个账号同时只能有一条连接**：第二条会话登录会把第一条顶掉（`SCChannelExpired`）。多账号各一条。

### 数据来源

- **协议表**：客户端自带的 protobufjs static module，在微信小程序包的
  `_src_chunks_` 分卷里（`src/chunks/game.js`）。`tools/wxapkg.mjs` 解密并解包后落到
  `work/extracted/`，`src/proto.mjs` 从里面把 `encode` / `decode` 函数体读回字段号与字段名。
  包目录形如 `%APPDATA%\Tencent\xwechat\radium\users\<id>\applet\packages\wx2ea52a972ea18e5e\<ver>\`：

  ```bash
  SRC="$APPDATA/Tencent/xwechat/radium/users/<id>/applet/packages/wx2ea52a972ea18e5e/<ver>"
  for f in "$SRC"/*.wxapkg; do
    n=$(basename "$f" .wxapkg)
    node tools/wxapkg.mjs decrypt wx2ea52a972ea18e5e "$f" "work/wxapkg/$n.wxapkg"
    node tools/wxapkg.mjs unpack "work/wxapkg/$n.wxapkg" "work/extracted/$n"
  done
  ```

- **配置表**：客户端运行时从 CDN 拉独立 bundle `config_cn`（591 张表）。微信缓存里有副本，
  `tools/sync-config.mjs` 把它快照到 `work/cdn/`。游戏里的 itemId / heroId / buildingType
  本身就是中文字符串（`生鱼片`、`杰森`、`食品厂`）。
- **素材**：Cocos 远程 bundle 里的 FairyGUI 图集。`tools/sync-art.mjs` 从微信缓存还原文件名并镜像，
  `src/fgui.mjs` 从 `FGUI` 二进制里解出「名字 → 图集矩形」，页面直接用 CSS `background-position`
  裁切，不需要任何图像处理依赖。
- **地图**：资源田的 grid 数据只在地图 bundle `world_map` 的 JsonAsset 里（协议和配置表都没有）。
  `tools/fetch-map.mjs` 按 `work/extracted` 里 `settings.json` 的 `bundleVers` 定位、
  解压 uuid 后下到 `work/cdn/world_map.*.json`；`--list` 只看远端清单不下载。
- 这些都在 `.gitignore` 里，不进仓库。缺配置表/素材/地图时程序会如实降级而不是编造；
  缺协议表则是硬失败（`ENOENT`）。

---

## 目录结构

```
src/
  app.mjs        CLI 入口与各子命令
  client.mjs     网关连接、心跳、请求/推送的路由与 prompt 归属
  archive.mjs    落盘层：protocol.log 流水 + responses/<日期>/<接口>.jsonl 全量回包
  codec.mjs      自定义帧 + protobuf 编解码
  proto.mjs      协议表加载
  accounts.mjs   多账号存储（data/accounts.json）
  config.mjs     配置表加载与资源名映射
  game.mjs       只读状态集
  tasks.mjs      主线/支线/成就/订单档位
  dailies.mjs    日常任务、活跃度宝箱、每日赠礼
  heroes.mjs     英雄养成
  world.mjs      海面世界：建造/工厂/订单/资源田
  factories.mjs  工厂页：制造队列、配方解锁判定、手动排产
  loop.mjs       自动循环
  actions.mjs    动作目录（请求名、参数、是否改状态）
  server.mjs     HTTP + SSE，多会话
  page.mjs       控制台页面（单文件：CSS + HTML + 内联 JS）
  art.mjs        实体 → 图标名 → 图集矩形
  fgui.mjs       FairyGUI 二进制解析
  lz4.mjs        LZ4 解压
  selftest.mjs   离线自检
  vendor/        第三方单文件（二维码编码器，MIT）
tools/
  capture-credentials.mjs  抓凭证（CLI，带确认与回滚）
  mitm-proxy.mjs           本地 MITM 代理（CLI 与网页共用）
  mitm-ca.mjs              本地 CA 生成/安装/卸载
  proxy-settings.mjs       HKCU 代理读写与还原
  sync-config.mjs          镜像 config_cn
  sync-art.mjs             镜像 UI 贴图并建索引
  fetch-map.mjs            下载 world_map 地图 JsonAsset
  describe.mjs             从 static module 里读回字段
  build-names.mjs          抠出内联的 id→名字枚举
  archive.mjs              回包归档的查看器（days / list / tail / path）
  archive-backfill.mjs     把老的 protocol.log 回填成结构化归档（增量、可 --dry）
  wxapkg.mjs               解密并解包 PC 微信小程序包
  probe-*.mjs              只读探针
  selftest-*.mjs           工具侧自检
docs/
  gameplay.md    协议与玩法的详细记录（哪条结论是从哪段客户端代码/哪张表得来的）
```

---

## 安全边界

这些边界是**有意保留**的，不是还没做：

- 写操作一律要 `--yes` / `CW_ALLOW_MUTATE=1` / 网页 `confirm: true`，且在连网关**之前**就检查。
- **不花钻石**。加速只花「加速器」道具（`SpeedUpCostParam.type` 恒为 2；1 = 钻石、3 = 广告都不使用）；
  而且**默认关闭** —— 网页要勾「允许花加速器」、CLI 要加 `--speed-up` 才会用。
  点金与折扣店默认跳过，要勾 `--paid` 才做。
- **不买任何付费礼包**（含 12 元那个「自动生产」礼包）。
- 建造/升级/交订单材料不齐时，客户端会弹「用钻石补」——本工具**永远不用钻石**，改为：
  ① 先用 `原料自选包` / `工事材料自选包` 兑出来补。兑换关系在 `SelectPackLibCfg`
     （`itemId` = 包，`selectItemId` = 能换的材料，`num` = 每包产出），协议 `SelectPackRequest`。
     因为一包只顶一个单位，它只够补零头（比如订单差 3 个木材），补不了「玻璃差 500」；
     每轮默认上限 20 个包，`--no-pack` 关掉、`--max-pack N` 调整，网页请求体用 `selectPack:false` / `maxPack`。
  ② 包不够、或该材料不在任何自选包的覆盖范围里，才跳过等下一轮。
- **只动这两类包**：原料自选包可换 鱼 / 塑料 / 木材 / 碎布 / 金属 / 玻璃 / 海藻，
  工事材料自选包可换 耐火砖 / 高温合金 / 炮弹 / 压电陶瓷 / 碳纤维 / 液态金属。
  `SelectPackLibCfg` 里另外 18 种（装备材料包、宠物基因自选包、英雄万能碎片、赛季钥匙自选包…）
  **永远不会被自动消耗** —— 白名单是 `world.mjs` 的 `AUTO_PACK_ALLOWLIST`，
  `planWorld({ allowPacks })` 还能进一步收窄。
- **拾荒网页默认勾选**（CLI 需显式 `--pick`，与 `--speed-up` 同一套约定）。它只捡海面漂浮物，不消耗任何资源；
  `PickUpFloaterRequest.floaterId` 是 **repeated string**，所以一轮最多 50 件会打成**一个请求**提交
  （传单个字符串会被 protobufjs 按字符拆成 N 个单字 id，服务端回 `invalid floater id`），
  捡完按 `PickUpFloaterResponse.reward` 汇总，**件数按提交的 `floaterId` 个数算**（不是按请求数 ——
  一个请求能装 50 件）；藏品碎片会抹掉编号按品质合并成「藏品蓝碎片×8」，其余超过 12 种折叠成「等 N 种」。
- 循环每轮除了汇总数字，还会按动作类型列出**成功明细**、逐条列出失败原因、按原因聚合跳过数，
  例如「成功 收成品×6  排产×6  加速生产×5 / 失败 加速生产 1服装厂：invalid speed-up count」。
- **拾荒的节奏跟循环分开**：循环默认 60s 一轮，但海面漂浮物是慢慢刷出来的，每 60s 发一次拾荒
  既没收益，也更容易让服务端看出「请求频率过于规整」。所以它有一个**时间间隔**：
  网页在「拾荒」区块里填秒数（默认 300），CLI 用 `--pick-every`。循环每轮只判断
  「距上次执行是否已超过间隔」，没到就这轮不发，并在日志里写明还差多久。
  计时只在请求**真的排进计划**时才更新 —— 海面没有漂浮物时空跑一轮不会白等一个间隔。
  间隔填 `0` = 不限制（等于旧行为：每轮都试）；手动「执行一轮」不看间隔。
  **农田用的是同一套节流**（`--farm-every`，默认 120 秒，网页在「自动循环」控制条里），
  语义完全一致：没排出收/种动作就不计时。
- **潜水与打捞都不做，将来也不做**。这两个玩法的请求体不是「发条命令」而是
  **「上报这一局你实际捡到了什么」**：`DivingRequest.reward.asset` 由客户端 `finishDive()`
  把小游戏里捡到的东西塞进去（空手时客户端根本不发），`EndSalvageRequest.pickedFloaters` 同理。
  发空体只会拿回空奖励（实测 `{"reward":{"asset":[]}}`），想拿到东西只能伪造战利品清单 ——
  那是往服务端谎报，属于作弊。完整证据链、实测回包、以及「2026-10-22 曾误判成空体请求并实现过一版」
  的教训都记在 [`docs/gameplay.md` 第 14 节](docs/gameplay.md)，`selftest` 有禁令断言锁死。
  **要改这块先读那一节。**
- 默认**不拒单**（`--reroll` 才开，且跟客户端一样拒绝重刷）。
- **不使用** `LoginRequest` 的 `testAccount` / `superToken` —— 那是绕过鉴权的开发者后门。
- 抓包的系统改动只在**当前用户**范围内（`certutil -user`、HKCU），必须在网页上显式点确认，
  `try/finally` + 进程退出钩子保证回滚。
- 凭证是本机明文文件，「显示凭证」要在页面上点一次，默认打码。
- 账号的自动循环**每轮都是「先只读探测 → 算计划 → 再执行」**，所以没什么可做时计划自然为空，
  不会重复发同样的请求；被服务端拒过的动作会跨轮记住不再重试。

---

## 自检

```bash
node src/selftest.mjs
```

40 组离线检查，覆盖协议帧编解码、LZ4、账号仓库（迁移/选中/替换）、配置表与素材索引、
二维码、海面计划器（含建造与竣工互斥）、工厂视图（配方解锁/排队项与队首的区分/材料与存量上限）、
活跃度宝箱（日/周两套门槛）、每日赠礼、日志脱敏与回包归档（同步落盘、轮转、噪音过滤、目录切分）。
工具侧另有 `tools/selftest-mitm.mjs`、`tools/selftest-describe.mjs`、`tools/selftest-registry.mjs`。

---

## 文档

深入细节都在 [`docs/gameplay.md`](docs/gameplay.md)：帧格式、协议表面统计、每一条结论背后的
客户端代码位置与配置表依据、以及踩过的坑（比如日/周活跃宝箱是两张不同门槛的表、
「每日赠礼」的 packId 在客户端里硬编码、建造与升级是两个不同的请求）。

---

## 许可

ISC（见 `package.json`）。`src/vendor/qrcode.mjs` 为第三方单文件，保留其原始版权头。
