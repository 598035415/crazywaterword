# 疯狂水世界 玩法与协议地图

本文档记录通过纯协议观察到的游戏玩法结构。所有数据来自真实账号的一次只读采集，不是从客户端源码推断的猜测。

- 采集方式：`node src/app.mjs state --out`，登录后一次性发出真实客户端进主界面时的全部只读查询。
- 采集结果：47 条响应全部成功，0 失败，耗时 106ms。
- 原始快照：`data/state.json`（含登录信息与该账号的全部响应体）。
- 字段布局来源：`tools/describe.mjs` 从游戏自带的 protobuf 生成代码中还原，未使用任何 `.proto` 描述符。

合规说明：协议挂机违反游戏用户协议，存在封号风险。本文档只做只读观察，不涉及任何状态变更。

## 1. 身份、区服与登录

网关 `wss://dhyaoj-gate.khlgamen.com/ws`。首次连接直接发 `LoginRequest`，没有独立的挑战握手；`LoginResponse.result === 1` 即鉴权成功。

网关不区分区服：一个 socket 服务整个账号，区服由 `LoginRequest.worldId` 选择，`worldId=0` 表示进入账号上次所在的区服。

- 选服界面的键是 `GameWorldInfo.worldId`，即角色**出生**的区服。
- `roleInfo.worldId` 是角色**当前**所在的区服。
- 合服后两者不同，服务端会把请求的出生服键解析到承接服。本账号实例：请求 `2001001001`，返回角色的 `worldId=2004001001`、`bornWorldId=2001001001`。不了解这一点会把合服误读成 bug。

本账号实测身份：

| 字段 | 值 |
|---|---|
| id | 55059310000001 |
| nickname | 示例玩家1001 |
| level | 11 |
| power | 40889 |
| worldId | 2004001001 |
| bornWorldId | 2001001001 |
| appId | 14021170 |
| channelId | 1400 |
| newRole | false |

账号下 2 个区服，所属分组 137 共 98 个区服。

## 2. 进入世界后的只读状态集

真实客户端登录后会在一次突发里发出 47 个查询，服务端全部一次返回。两个信号没有对应的 `*Response` 类型，走推送或通用 `OkResponse` 应答，以即发即弃方式发送。

查询按客户端顺序（`src/game.mjs` 的 `ENTRY_QUERIES`）：

```
AllItem              AllResource          AllHero              GetFormation(module=1)
EmailBox(pageNo=0)   Equips               Badges               RecruitInfo
AchievementInfo      DailyTaskInfo        MainTaskInfo         GuideInfo
AfkInfo              MonthCard            AllAntique           OnWater
FishEncyclopedia     CargoShips           AppointInfo          ChatRecord(channel=1)
GameEffect           AllGuildAbstraction  MyFleets             PirateKillRecord
MyResFields          GuildTechInfo        GuildOrder           MyFormationPreset
SeasonTaskStage      WorldBossInfo        LimitedBossOpen      AllPet
SeasonRankInfo       WeekInfo             PassStageState       WeekOrderInfo
CounterInfo          RadarInfo            EnvSkinList          ChannelRewardInfo
LimitTicket          SeasonCard           AllPirate            PlayerFrame
ChurnInfo            UltraOpen            BlackList
```

信号（`ENTRY_SIGNALS`）：`ExitWorldMapRequest`、`RedPointRequest`。

`collectState()` 一次发出全部查询，按请求名收集结果；`summarize()` 把它归约成玩家视角的状态；`formatState()` 负责渲染，CLI 与网页控制台共用同一个渲染器。

## 3. 系统地图

下面每个系统给出：玩家可见的玩法、对应的协议入口、以及本账号的实测值。

### 3.1 资源与道具

- 协议：`AllResourceRequest`、`AllItemRequest`。
- 资源是服务端数字枚举，道具 ID 是中文字符串，自描述。

资源实测：

| res | 枚举名 | 展示名 | amount |
|---|---|---|---|
| 3 | GOLD | 金币 | 67070 |
| 4 | RUBY | 钻石 | 5785 |
| 5 | ARENA_POINT | 挑战券 | 10 |
| 6 | LEAGUE_POINT | 积分赛挑战券 | 10 |

数字枚举到字符串 id 的映射只存在于客户端生成代码里：`Resource = {1:"EXP", 3:"GOLD", 4:"RUBY", 5:"ARENA_POINT", 6:"LEAGUE_POINT"}`（2 被跳过）。展示名再经 CDN 的 `ResourceCfg` 表解析。

道具实测：共 52 种、308650 个。数量靠前的有 `英雄经验` 290020、`木材` 1200、`玻璃` 1200、`加速器` 801、`建筑蓝图` 74、`橙卡万能碎片` 26、`抽卡券` 9。

### 3.2 英雄、阵型与任命

- 协议：`AllHeroRequest`、`GetFormationRequest{module}`、`MyFormationPresetRequest`、`AppointInfoRequest`。
- 英雄 ID 是中文字符串，另有 `showName` 展示名与 `skinId` 皮肤。

实测 7 个英雄，总战力 45280：

| heroId | 展示名 | level | star | power |
|---|---|---|---|---|
| 杰森 | 鬼火杰森 | 45 | 0 | 11658 |
| 蜜雪 | 蜜雪儿 | 45 | 1 | 11240 |
| 赏金猎人 | 赏金猎人 | 45 | 2 | 7117 |
| 棒球手 | 重炮琼斯 | 45 | 0 | 6320 |
| 弓箭手 | 珍妮 | 45 | 3 | 4554 |
| 机器警察 | 警员鲍勃 | 1 | 2 | 2473 |
| 小布 | 小布 | 1 | 2 | 1918 |

每个英雄带 `attributes` 数组，`attr` 是服务端数字枚举。观察到的 attr 值：1、2、3、4、6、7、8、9、12、14、16、18、19。`attr=1` 数值最大，与 `power` 量级一致，是最可能的攻击或战力主属性；`attr=4` 是小数，取值 0.6/0.75，像暴击率或类似百分比。名称表由 CDN 下发，包内没有。

`skillLevels` 是长度为 4 的数组，本账号英雄全部为 `[1,0,0,0]`，即只解锁了第一个技能。另有 `equips`、`badges`、`chips`、`heroFates`、`skillUpgrades` 五条独立的养成线。

`AppointInfoRequest` 返回 `heroes[]`，元素为 `{heroId, posId}`，是英雄任命到职位的配置。

### 3.3 招募与藏品

- 协议：`RecruitInfoRequest`、`AllAntiqueRequest`。
- 免费招募有冷却时间，招募有保底计数。

实测：

| 类别 | 已招募 | 下次保底 | 免费冷却结束 |
|---|---|---|---|
| 英雄 | 52 | 48 | 1786632105 |
| 藏品 | 21 | 9 | 1786591840 |

已拥有：藏品 7 件、大师等级 1、套装 0；宠物 0；装备 0。

### 3.4 水上建筑与工厂生产线

- 协议：`OnWaterRequest`。
- 响应有 11 个字段：`building[]`、`floater[]`、`workerOrder[]`、`fishingLevel`、`salvageLevel`、`divingLevel`、`autoProduceEndTime`、`autoProduceForever`、`orderOfTheDay`、`autoFarming`、`adv[]`。
- 建筑 ID 是中文字符串，形如 `1训练营`、`1切鱼厂`、`2A民居`，前缀数字是等级段，后缀是品类。

`DispWaterBuilding` 有 15 个字段。除建筑本身外，还挂了工厂 `factory`、装备制造 `equipMaking`、舰队 `fleet`、农田 `farm`、宠物培育 `petBreed`、宠物服务 `petServe` 六种功能，同一张建筑表承载了全部水上设施。

`DispFactory` 三个字段：`factoryQ[]` 生产队列、`finishedProducts[]` 已完成的成品、`autoProductId` 自动生产的产品。

`DisplayAsset` 形状为 `{type, id, num}`，`type=0` 是道具、`type=1` 是资源，`id` 为字符串。

实测 22 座建筑。可操作的信号：

- 待竣工，`buildFinishTime` 已过：`1训练营`、`1食品厂`。
- 工厂有成品未收：`1切鱼厂` 有 `鱼肠线`x4、`生鱼片`x2；`1材料厂` 有 `布匹`x4；`1食品厂` 有 `烤鱼`x5；`1服装厂` 有 `救生衣`x4。

产出链是真实的生产链：`1食品厂` 用鱼做 `烤鱼`，`1切鱼厂` 把鱼切成 `鱼肠线`/`生鱼片`，`1服装厂` 出 `救生衣`，`1材料厂` 出 `布匹`。

### 3.5 挂机（离线收益）

- 协议：`AfkInfoRequest`。
- 响应结构：`AfkInfoResponse { afkInfo: DispAfkInfo, clickGoldInfo: DispClickGoldInfo }`。

`DispAfkInfo` 四个字段，全部是 int32：

| 字段 | 含义 |
|---|---|
| level | 当前挂机等级 |
| afkStartTime | 本段收益开始时间 |
| afkFinishTime | 收益封顶时间 |
| rewardedLevel | 已领奖到的等级 |

机制：收益在 `afkFinishTime` 之前持续累积，到点后停止增长（封顶）。领奖会把收益结算掉并开启新的时间段。

等级奖励不是"level 减 rewardedLevel"，而是由配置表决定，两条规则都在客户端代码里：

- 可领的等级 = `OfflineLvRewardCfg` 中第一个 `level > rewardedLevel` 且 `reward` 非空的条目。
- 只有该等级 `<= afkInfo.level` 时才允许领取；否则客户端只弹提示，根本不发请求。

实测：`level=1`、`rewardedLevel=0`。`OfflineLvRewardCfg` 的 1 级 `reward` 为空，下一个有奖励的是 2 级，而挂机等级只有 1，所以当前没有可领的等级奖励。服务端对 `DrawAfkLevelRewardRequest{level:1}` 回 `PromptResponse{args:["no claimable afk reward"]}`，对 `level:2` 回 `"afk level too low"`，与上述规则一致。

`DispClickGoldInfo` 是点金玩法：`freeTimes`、`paidTimes`、`minGold=7500`、`resetTime`、`maxPaidTimes=7`。

### 3.6 日常：每日任务、成就、活跃宝箱、邮件

- 协议：`DailyTaskInfoRequest`、`AchievementInfoRequest`、`EmailBoxRequest{pageNo}`、`ChurnInfoRequest`、`ChannelRewardInfoRequest`。

`DailyTaskInfoRequest` 字段：`dailyTask[]`、`dailyRewardClaimed[]`、`weeklyRewardClaimed[]`、`dailyActivity`、`weeklyActivity`、`dailyResetTime`。

任务元素 `{id, progress, targetProgress, rewardClaimed}`。完成判定是 `progress >= targetProgress`；已完成且未领奖的就是可领项。

实测：任务 ID 从 1001 起，`1001` 已完成未领、`1002`/`1003` 未完成；`dailyActivity=0`。

`EmailBoxRequest` 返回 `{email[], total}`，元素含 `emailId`、`subject`、`emailType`、`status`、`sender`、`sendTime`、`content`、`attachment`、`got`、`scenarioId`。附件 `attachment.assets.asset[]` 是 `DisplayAsset` 数组。实测 1 封系统邮件「新赛季开始」，附件含 `抽卡券`x10、`汽油`x150000、`种子`x50000、`RUBY`x200、`公会科技点`x50000，未领取。

`ChurnInfoRequest` 含 `task`、`gotTaskId`、`gotPaidGift`、`paidPack`、`type`，是流失召回与付费礼包的运营投放。

### 3.7 世界地图：资源田、舰队、货船、海盗、世界 Boss

- 协议：`MyResFieldsRequest`、`MyFleetsRequest`、`CargoShipsRequest`、`AllPirateRequest`、`PirateKillRecordRequest`、`WorldBossInfoRequest`、`LimitedBossOpenRequest`、`RadarInfoRequest`。

实测：资源田 `0/10`（上限 10）、舰队 0、货船 0、海盗 0（扫荡次数 0）、世界 Boss `raidId=0`、雷达 `raidId=0`。这些是世界服玩法，本账号等级尚低，基本未参与。

### 3.8 公会

- 协议：`AllGuildAbstractionRequest`、`GuildTechInfoRequest`、`GuildOrderRequest`。

实测返回 4 个公会条目，ID 形如 `2004001001004`，前缀与世界 ID 一致，说明公会 ID 在世界内分配。每条含 `flagBackground`、`flagPattern`、`level`。本账号未入会。

日常计数 `CounterInfoRequest.counters[]` 是本账号的活跃度计数：

| type | num |
|---|---|
| DAILY_WORLD_BOSS_TIMES | 0 |
| DAILY_GUILD_AID | 0 |
| DAILY_WORLD_ONLINE_RWD | 0 |
| DAILY_FINISH_GUILD_ORDER | 0 |

### 3.9 赛季、周活动、月卡

- 协议：`SeasonRankInfoRequest`、`SeasonTaskStageRequest`、`SeasonCardRequest`、`WeekInfoRequest`、`WeekOrderInfoRequest`、`MonthCardRequest`、`BattlePassRequest`、`PassStageStateRequest`。

赛季实测：`startTime=1791561600`、`midEndTime=1793375973`、`endTime=1795449570`、`seasonTaskStage=1`，另有 `midAutoGrantTime`、`autoGrantTime` 两个自动发奖时间点。

周活动实测 5 条，每条 `{type, period, startTime, endTime}`，type 取值 1、2、4、5、6，period 是区分同类活动的周期编号（4021、104001、140011、4001、4001）。

月卡 `MonthCardRequest.cardItem[]`，元素含 `type`、`endTime`、`gotDailyReward`；`endTime > now` 即生效。

### 3.10 引导与主线

- 协议：`GuideInfoRequest`、`MainTaskInfoRequest`、`GameEffectRequest`、`EnvSkinListRequest`、`PlayerFrameRequest`、`LimitTicketRequest`、`BlackListRequest`。

引导实测 `{triggerGuideId: [1,2,3,4,36,5,6,8,9,10,43,12,14,15,16,17,18,20,22], guide: {stage: 2, step: 1}}`，即引导进度停在第 2 阶段第 1 步。

## 4. 挂机收益闭环

这是本阶段最有价值的发现。全部免战斗的收益入口都已定位：

### 4.1 离线挂机

```
AfkInfoRequest              -> AfkInfoResponse { afkInfo{level, afkStartTime, afkFinishTime, rewardedLevel}, clickGoldInfo }
DrawAfkRewardRequest        -> DrawAfkRewardResponse { reward, afkStartTime, afkFinishTime }   领取本段收益并重置时间段
UpgradeAfkLevelRequest{level}  ->  提升挂机等级，消耗 OfflineCfg 里该等级声明的物品
DrawAfkLevelRewardRequest{level}  ->  领取等级奖励，level 取自 OfflineLvRewardCfg
```

实测一次 `DrawAfkRewardRequest` 返回 `reward.assetPackage.asset = [{type:1,id:"GOLD",num:800}, {type:0,id:"加速器",num:8}]`，并把时间段重置为 start=1791612415、finish=1791641215（8 小时）。`type:1` 是资源、`type:0` 是道具。

`DrawAfkRewardRequest` 的响应会回传新的 `afkStartTime`、`afkFinishTime`，客户端据此刷新倒计时，不需要额外查询。

### 4.2 建筑与工厂生产

```
GainFactoryProduceRequest{buildingId}        -> GainFactoryProduceResponse        收取工厂成品
CollectBuildingProductRequest{buildingId}    -> CollectBuildingProductResponse    收取建筑产物
FinishUpgradeBuildingRequest{buildingId}     竣工，仅在 buildFinishTime 已过时有效，无响应类型
SetBuildingAutoWorkRequest{buildingId, isOn}    开关自动工作，无响应类型
SetFactoryAutoProduceRequest{buildingId, productId}   设置工厂自动生产的产品，无响应类型
```

四个无响应类型的请求由推送或通用 `OkResponse` 应答，实现上以即发即弃方式发送。

### 4.3 扫荡

以下请求的响应直接携带 `reward`，无需本地战斗推演：

```
ArenaSweepRequest           CatcherSweepRequest        ExpeditionSweepRequest
PirateSweepRequest          TrialRaidBuySweepRequest
```

配合 `ChallengeStageRequest`、`ChallengeWorldBossRequest`、`ChallengeResFieldRequest`、`ChallengePirateRequest`、`ArenaChallengeRequest`、`TrialRaidChallengeRequest` 等直接挑战的入口。战斗为服务端结算：`ChallengeStageResponse` 同时返回 `initialData`、`stats.isLeftWin`、`reward`，本地战斗推演只用于动画回放。挂机不需要复刻战斗引擎。

### 4.4 日常领取

```
DrawDailyRewardRequest{index}        领取每日活跃宝箱，无响应类型
DrawDailyTaskRewardRequest{id}       领取每日任务奖励
GotAchievementRewardRequest{id}      领取成就奖励，无响应类型
QuickGotReadEmailRequest{all}        一键领取已读邮件附件，无响应类型
MonthCardDailyRewardRequest          领取月卡每日奖励，无响应类型
```

### 4.5 采集侧与发放侧的对应关系

采集用 `AfkInfoRequest` / `OnWaterRequest` / `DailyTaskInfoRequest` 判断"有没有可领的"，发放用 4.1 到 4.4 的请求执行。判定与执行完全解耦，这正是挂机客户端需要的形状：轮询采集，条件满足才发发放请求。

本账号当前实际可执行的操作：

- 挂机有 1 个待领等级，本段收益已封顶。
- `1训练营`、`1食品厂` 待竣工。
- `1切鱼厂`、`1材料厂`、`1食品厂`、`1服装厂` 有工厂成品待收。
- 1 封系统邮件附件未领，每日任务 `1001` 已完成未领奖。

## 5. 协议表面统计

- 协议表共 1558 个键：约 1495 个消息类型、62 个枚举、1 个 `BattleService`。
- `tools/describe.mjs` 已从生成代码中还原 1506 个类型的字段布局。
- 扫荡类请求 8 个，战斗与挑战类请求 16 个。
- 已实现的动作目录（`src/actions.mjs`）13 个，全部是状态变更动作，全部带门控。

## 6. 配置表

配置表不在游戏包里，是 Cocos 的独立远程 bundle `config_cn`，运行时从 `https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/wx/remote/config_cn/` 下载，整包被打成单个 JSON，共 **591 张表**。三个来源按优先级：环境变量 `CW_CONFIG_PACK`、`work/cdn/config_cn_pack.json`、微信缓存 `%APPDATA%\Tencent\xwechat\radium\users\*\applet\local\wx2ea52a972ea18e5e\usr\gamecaches\config_cn\*.json`。

`src/config.mjs` 负责加载，`node tools/sync-config.mjs` 把缓存快照到 `work/cdn/`，`node src/app.mjs config [表名]` 查看。

几个关键表：

| 表 | 行数 | 用途 |
|---|---|---|
| ResourceCfg | 5 | 资源数字枚举到展示名 |
| OfflineCfg | 601 | 挂机每级的主线门槛 `stage` 与消耗 |
| OfflineLvRewardCfg | 133 | 挂机等级奖励，`reward` 为空的等级不产出 |
| DailyTaskCfg | - | 每日任务目标与奖励 |
| AchievementTaskCfg | - | 成就目标与奖励 |
| BuildingCfg / BuildingProduceCfg | - | 建筑与生产链 |

## 7. 已知未解

- `PromptResponse` 只带 `style`/`prompt`/`args`，`prompt` 是数字、`args` 是文案。数字到提示类型的映射表尚未定位，目前直接展示 `args` 文本。
- 英雄 `attributes[].attr` 是服务端数字枚举，取值 1/2/3/4/6/7/8/9/12/14/16/18/19，名称表（`HeroAttributeCfg`）已在配置表里，但数字到枚举的映射还没从客户端代码里抠出来。
- 其余 CDN bundle（美术、音频、地图）尚未获取，挂机用不到。

## 8. 安全边界与门控

- 本阶段的全部采集都是只读请求，不改变账号任何状态。
- 状态变更动作集中在 `src/actions.mjs`，共 24 个，全部标记 `mutate: true`。
- 门控在连接之前生效：`assertAllowed` 与 `buildBody` 在 `client.connect` 之前调用，未显式授权时不会打开任何会话。
- 授权方式：命令行加 `--yes`，或环境变量 `CW_ALLOW_MUTATE=1`；网页控制台另需请求体里带 `confirm: true`。
- 已对真实账号执行过的变更：一轮 `loot --yes`（见第 10 节）、日常任务一轮（见 11.4）、
  英雄养成两轮（见 11.4）、进度任务领取与海面排产各若干轮（见 12.6）。
- 付费动作单独门控：点金/折扣商店这类要花钻石的，还要 `--paid` 才执行，默认跳过。
  实现上由 `dailies.mjs` 的 `needsPaid()` 判三段：驱动的 `status === 'paid'`、动作上的
  `paid: true`、或 `cost` 文案里含「钻石」，任一命中就整条驱动跳过。新加付费驱动必须标其中之一 ——
  2026-10-25 之前折扣店（1007）标的是 `ready`，`runDailies` 只认 `status === 'paid'`，
  于是没开 `--paid` 也照样买（归档实证：`DiscountShopBuyRequest{id:5}`，RUBY 9742→9730）。
- 加速与拒单各有独立开关（`--speed-up` / `--reroll`），默认关闭；加速**只花「加速器」道具**，
  `SpeedUpCostParam.type` 永远发 2，钻石(1)与广告(3)不碰。
- 不使用 `LoginRequest` 里的 `testAccount` / `superToken` 等开发者字段（鉴权后门，不在范围内）。
- 账号选择（`--account` / `CW_ACCOUNT` / 网页 `?account=`）只是挑「用哪份已有凭证」，
  不会放宽任何一项授权要求，也不会顺带连接：连接仍然要显式动作。
- 网页「一键扫码 + 抓包」会动系统设置（HKCU 代理 + 当前用户根证书）。它比普通写操作门控更重：
  必须先在页面上确认，且改动随时可完整回滚（见 13.2）。
- **潜水与打捞永久不做**：两者的请求体都是「这一局你实际捡到了什么」的上报体，纯协议只能伪造战利品。
  证据链、实测回包与历史误判都记在第 14 节，`selftest` 有对应的禁令断言。

## 9. 复现命令

```bash
node src/app.mjs state --out        # 采集状态并写入 data/state.json
node src/app.mjs state --out a.json # 同上，写到指定文件（不给文件名就是 data/state.json）
node src/app.mjs state --raw        # 采集并打印原始响应体
node src/app.mjs worlds             # 列出账号区服与登录区服的用户信息
node src/app.mjs worlds <worldId>   # 进入指定区服并打印其用户信息
node src/app.mjs actions            # 列出动作目录
node src/app.mjs act <id> k=v --yes # 执行单个动作，需显式授权
node src/app.mjs loot --dry         # 预览一键领取计划，不发任何请求
node src/app.mjs loot --yes         # 执行一键领取，需显式授权
node src/app.mjs heroes --dry       # 预览英雄养成计划，不发任何请求
node src/app.mjs heroes --yes       # 执行英雄升级/升星/技能，需显式授权
node src/app.mjs dailies --dry      # 调研 17 项日常任务各能不能做
node src/app.mjs dailies --yes      # 自动完成能做的日常并领奖，需显式授权
node src/app.mjs dailies --yes --paid  # 允许花钻石的日常（点金/折扣商店）
node src/app.mjs tasks --dry        # 预览主线/支线/成就/订单档位的可领清单
node src/app.mjs tasks --yes        # 领取全部可领任务奖励，需显式授权
node src/app.mjs world --dry        # 预览海面计划（收成品/竣工/交单/排产/升级）
node src/app.mjs world --yes        # 执行海面计划，需显式授权
node src/app.mjs world --yes --speed-up --reroll   # 额外允许花加速器与拒单重刷
node src/app.mjs field              # 只读报告：资源田、城市、舰队与占田可行性
node src/app.mjs field occupy <gridIdx> --fleets a,b --yes   # 派舰队占田
node src/app.mjs field giveup <gridIdx> --yes                # 放弃资源田
node src/app.mjs loop --rounds 3 --every 60 --yes            # 定时循环：任务+日常+海面
node src/app.mjs config [表名]      # 查看本地配置表
node src/app.mjs accounts           # 列出本机存了哪些账号，当前账号前面带 *
node src/app.mjs state --account 示例玩家1001   # 按昵称/序号/id 前缀挑账号，也可用 CW_ACCOUNT=...
node tools/sync-config.mjs          # 把配置表缓存快照到 work/cdn
node tools/sync-art.mjs             # 把界面要用的图集从微信缓存镜像到 work/cdn/art
node src/art.mjs                    # 打印素材覆盖率；带个名字就查它对应哪个图标
node work/tmp/crop-icon.mjs 图标名   # 只读探针：把某个图标裁成 PNG，用来核对旋转贴图
node src/app.mjs selftest           # 离线自检
node tools/selftest-describe.mjs    # 字段布局还原自检
```

## 10. 本次实际执行的一次领取

已对真实账号执行过一轮 `loot --yes`，共 12 项计划，11 项成功：

| 动作 | 结果 |
|---|---|
| 邮件一键领取 | 附件入账（汽油 15 万、种子 5 万、公会科技点 5 万、紫藏品经验 4400） |
| 每日任务 1001 | 领取成功 |
| 成就 1010 / 1011 | 已提交 |
| 挂机本段收益 | 金币 800 + 加速器 8，时间段重置为 8 小时 |
| 挂机等级 1 | 服务端回 `no claimable afk reward`，符合配置表规则 |
| 四个工厂成品 | 鱼肠线、生鱼片、布匹、烤鱼、救生衣全部入账 |
| 1训练营 / 1食品厂 竣工 | 均已完成 |

前后对比：金币 66270 变 67070、钻石 5585 变 5785、道具 52 种变 56 种、邮件未领 1 变 0、成就完成 9 变 11。

## 11. 英雄养成与日常任务（协议侧自动化）

新增两个模块：`src/heroes.mjs`（升级 / 升星 / 技能）与 `src/dailies.mjs`（每日任务驱动注册表）。
两者都是「只读探测 → 算出计划 → 显式授权后逐条执行」，网页控制台对应「英雄养成」与「日常任务」两个页签。

### 11.1 升星一次只涨一星

`HeroStarUpRequest{heroId, universal}` 的成功响应是 `HeroStarUpResponse.nextStar`，
一次只推进一颗星；客户端 `_onBtnStarUp` 点一次也只发一条。所以 0 星升到 8 星是 **8 条请求**，
计划器必须按星逐条展开（早期把它当成一条请求发，结果只涨了 1 星）。
`universal:true` 等价于面板上的「自动兑换」，允许用 `HeroCfg.universalItemId` 的万能碎片补差额。

### 11.2 技能升级的门槛是星级，不是当前星级的技能上限

客户端里有两套不同的判定，很容易搞混：

- `HeroSkillUtil.isSkillLevelUp(hero, slot, level)`（红点用）
  `cap = HeroStarCfg[当前星级].maxSkillLevel[slot]`。
- `HeroSkillPanel._showFromHero()`（按钮能不能点，服务端也按这套校验收到的请求）
  `cap = HeroStarCfg[最大星级].maxSkillLevel[slot]`，
  并且要求 `hero.star >= HeroUtil.heroStarBySkillLv(slot, 目标等级)` ——
  即 HeroStarCfg 里第一条 `maxSkillLevel[slot] >= 目标等级` 的记录的 star。

按红点那套算出来的计划会被服务端以 `PromptResponse{"args":["upgrade condition unmet"]}` 拒掉。
本机实测：技能槽 1 升到 2 级需要 5 星、升到 3 级需要 10 星。
消耗取 `HeroSkillUpCfg[品质_目标等级].costArr[槽位]`，和客户端 `skillUpCost` 一致。

### 11.3 PromptResponse 的归属规则

服务端在业务拒绝时不回 `*Response`，只推一条 `PromptResponse{style, prompt, args[]}`，
而这条消息**不带我们发出去的 seq**，无法直接对应请求。

`HeroLevelUpRequest` / `HeroSkillLevelUpRequest` / `DiscountShopBuyRequest` 这类请求
没有配套 Response：成功时服务端一声不吭，被拒时只有那条 PromptResponse。
一次英雄养成有 160+ 条这样的请求，归错一条就会把同时段在飞的无关请求拒掉 ——
实测中一条技能升级被拒的 PromptResponse 拒掉了当时在飞的 `AllHeroRequest`，
整个 HTTP 调用变成 400。

规则：**服务端按请求到达顺序应答，所以一条 prompt 属于最早那条还没被应答的发送**。
`GameClient.sendWatch(name, body, {window})` 为无响应请求开一个观察窗口（守到 prompt 即被拒，
窗口内没动静即成功），`GameClient.attributePrompt()` 按上面的顺序规则认领 ——
观察者按发送顺序排队，在飞的 `request()` 用 `pending[0]`（最早一条）。
2026-10-25 之前这里取的是 `pending[最后一条]`，并发场景（`collectState` 一次 48 条只读请求）
下会拒错对象，与本节规则不符，已修正并有自检断言。

同类请求还包括 `StartFactoryProduceRequest`、`UpgradeBuildingRequest`、`BuildBuildingRequest`、
`SelectPackRequest`（自选包兑换）等。**完整清单维护在 `src/selftest.mjs` 的 `SILENT` 集合里**，
并在那里做集合比对：新增动作如果把某个没有 Response 的请求写成有 Response，自检会直接失败。

### 11.4 本轮实测结果

英雄养成：7 个英雄全部从 lv45 升到玩家等级允许的上限 lv55；蜜雪 2→8 星、杰森 1→2 星
（共 24 个万能碎片）；蜜雪技能 1、2 各升到 2 级（20 本橙技能书）。共 9 条请求，全部成功，
之后计划器剩余步骤为 0。

日常任务：17 项里 10 项可协议完成（1001-1007 全部完成并领奖），消耗钻石 18。
其余 7 项阻塞原因：1008 地图上没货轮/世界货物、1009 试炼副本需要玩家等级 14（当前 11）、
1010 地图上没有海盗、1011-1017 需要联盟身份 / 限时时段 / 功能未开放。

### 11.5 勋章与装备：主战英雄的第二层养成

`src/heroGrow.mjs`（2026-10-26 加）。`heroes.mjs` 只管英雄本体的等级/升星/技能，这一层管
**勋章（强化、替换）** 与 **装备（升级、精炼、升星、替换）**，网页「英雄」页的表格就是它的输出。

数据在同一个回包里：

- `GetFormationResponse.formation`：`{ heroPositions:[{heroId, pos{x,y}}], presetId, petUid }`，
  `GetFormationRequest{module}` 的 `FormationModule` **只有 MAINLINE=1** 一个值 ——
  也就是「主线出战阵容」，页面上说的**主战英雄**就是这 5 个位置上的英雄。
  拉不到阵型时不报错，退化成「全部英雄」（否则整页一条动作都排不出来）。
- `AllHeroResponse.heroes[].badges[]`：`{pos 1..4, uid, badgeId, level, star, attr{attr,value,rating}}`
- `AllHeroResponse.heroes[].equips[]`：`{uid, equipId, level, star, refineLv, attr, rerollAttrs}`
- `BadgesResponse.badge[]` / `EquipsResponse.equip[]`：背包。**勋章背包里包含已佩戴的那些**
  （同一个 uid 池，34 条里 19 条在身上），装备背包则只放没穿的 —— 所以判断「闲置」必须按 uid 差集，不能按列表长度。

**徽章等级上限只由「徽章 id + 星级」决定**：`HeroBadgeAttrCfg[id_star].maxLevel`
（蓝坦克 1 星 40 级、5 星 60 级）。每级消耗 `HeroBadgeLevelCfg[level]`：`exp` 点经验 +
`exp × goldExpRadio` 金币 —— 两个系数**逐级不同**（1 级 0，2 级 20，3 级 23…），
所以「还剩多少金币能升几级」只能逐级推进，不能用某一级的单价乘总数。

`EnhanceBadgeRequest{uid, decomposeUid[], expItemNum}`：

- `expItemNum` 是**实际投入的经验点数**（不是道具件数），客户端弹窗里由
  `calBadgeEnhanceExpAndGoldInLimit(badge, "徽章经验"持有量, GOLD)` 算出来；
- `decomposeUid` 是「额外分解掉换经验」的闲置徽章。**本模块恒发空数组**：
  分解不可逆，且没有收益判断依据（随机属性类型不同不可比），只花背包里的「徽章经验」道具。
- 徽章**升星**（`BadgeStarRequest{uid, decomposeUid[], starItemNum}`）要分解
  `HeroBadgeStarCfg[star].upBadgeNum` 个徽章（高等级徽章按 `equalBadgeNum` 折算），
  同样是不可逆操作 —— 只探测、不自动执行。

**替换方向**（实证 `BadgeReplaceRequest` / `EquipReplaceRequest` 的调用点）：
`downUid` = 要穿上的那件（背包里更好的），`upUid` = 身上被换下的那件。
空位则是 `PutOnBadgeRequest{uid, heroId, pos}` / `PutOnEquipRequest{uid, heroId}`（都没有 Response）。

装备有三条独立请求，**别把升级写成 EquipLevelUp，那张表里没有这个名字**：

| 操作 | 请求 | 消耗 | 上限 |
| --- | --- | --- | --- |
| 升级 level | `EnhanceEquipRequest{uid}` | `EquipUpDecomposeCfg[level+1].upgradeCost` 精铁 | `EquipAttrCfg[id_star].maxLv` |
| 精炼 refineLv | `EquipRefineRequest{uid}` | `EquipRefineCfg[refineLv+1]`：精铁×costItem1 + 精炼石×costItem2 | `EquipAttrCfg[id_star].maxRefineLv`（多数 0，橙红装 10~60） |
| 升星 star | `EquipStarUpRequest{uid}` | `EquipUpStarCfg[star+1].upCosts`（装备升星石 + 精铁） | 5 星 |

三者都**没有 Response**（成功静默、被拒推 PromptResponse），所以走 `sendWatch`（见 11.3）。

计划器的两条硬规则：

1. **预算表全局共享**：精铁 / 徽章经验 / 精炼石 / 装备升星石 / GOLD 在英雄之间按战力从高到低分，
   一件装备升 6 级就拆成 6 条请求、每条各扣一次 —— 不共享的话每个英雄都会按「满库存」算一遍，
   实际发出去的第 2 个英雄开始就是必被拒的请求。
2. **替换先于强化**：先把更好的件换上，再花材料，同样的经验/精铁落在更好的底子上。
   替换的取舍只做三级比较（品质 → 星级 → 等级），且新件等级低于旧件 60% 时挡在候选池外
   （属性 = baseAttrs + growAttrs × level，紫装 lv1 换下蓝装 lv45 是掉战力）。

接口：`GET /api/heroes` 返回每个英雄的 `kpi`（本体）与 `badgeItems` / `equipItems`（这一层），
**默认只列主战阵容里的英雄**（`?bench=1` 才带未上阵的，页面上的复选框就是它）；
`POST /api/heroes/grow {confirm, heroId?, switches?, includeBench?}` 先重新探测再执行；
`switches` 对应页面上的复选框（勋章强化 / 勋章替换 / 装备升级 / 装备精炼 / 装备升星 / 装备替换）。

## 12. 任务领取与海面自动化

新增三个模块：`src/tasks.mjs`（任务领取闭环）、`src/world.mjs`（海面探测 / 计划 / 执行 / 资源田）、
`src/loop.mjs`（把任务、日常、海面串成定时循环）。网页控制台对应「自动循环」页签。

### 12.1 三类任务，三种结构

| 任务 | 响应 | 字段 | 领取请求 |
|---|---|---|---|
| 主线（成长） | `MainTaskInfoResponse.task`（单条） | `DispMainTask{taskId, progress, rewardClaimed}` | `DrawMainTaskRewardRequest{taskId}` |
| 支线 | `MainTaskInfoResponse.branch[]` | `DispBranchTask{taskId, progress}`，**没有 rewardClaimed** | `GotBranchTaskRewardRequest{taskId}` |
| 成就 | `AchievementInfoResponse.task[]` | `DispAchievementTask{id, progress, targetProgress, rewardClaimed}`，**自带目标** | `GotAchievementRewardRequest{id}` |

主线与支线的响应里没有目标值，只能从 `MainTaskCfg` / `BranchTaskCfg` 的 `params` 取
（`{taskId, type, desc, params:[...], reward}`）。取法对齐客户端 `TaskUtil.taskProgress()`：

- 大部分类型的目标值是 `params[0]`；
- `拥有指定资源` / `获取资源` / `生产物品` / `种植作物` / `占领资源地` / `击败野怪` /
  `英雄升星` / `英雄万能升星` / `藏品万能升星` / `强化装备` / `分解装备` / `分解海兽`
  这 12 类取 **`params[1]`**（`params[0]` 是物品名或类型名）；
- `升级建筑` 的 `params[1]` 形如 `"1|1"`（数量|等级），取竖线前那段；
- `试炼挑战` 的目标值客户端写死为 1。

取不出目标值（`params` 缺失或太短）的任务返回 `null`，**不排进计划**，只在 notes 里写明，
宁可漏领也不猜。

每日订单进度奖励：`OnWaterResponse.orderOfTheDay = {orderNum, rewardedNum}`，
`rewardedNum` 是「最后一个已领档位的 reqNum」，所以下一档是第一个大于它的
`OrderDailyRewardCfg.reqNum`（6/12/18/24/30/40 …），领取用空体 `GetNextOrderOTDRewardRequest{}`，
一次领一档。

### 12.2 建筑 ID 与工厂队列

`buildingId` 是 `<序号><可选字母><建筑类型>`（`1食品厂`、`1A民居`、`1指标楼A`）。
匹配类型时按**最长后缀**去比 `BuildingCfg.buildingType`（58 种），否则「海水厂」会被
更短的「水厂」之类抢先匹配。

- 人口不是协议字段，是客户端算的：`population = Σ BuildingUpgradeCfg[type][level].effect 里「人口增加」`，
  `maxPopulation = GameParamCfg 初始人口上限(10) + Σ「人口上限」`。协议里没有，计划器只能按同样口径离线复算。
- `DispFactory{factoryQ:[{idx, productId, finishTime}], finishedProducts[], autoProductId}`。
- 常量散在几张 param 表里：`制造位上限=6` 在 `BuildingProduceParamCfg`，
  `产品存量初始上限=50`、`初始人口上限=10` 在 `GameParamCfg`，`订单每日上限=40` 在 `OrderParamCfg`。
  按名字查时要跨表查，只查一张表会拿到 0（本轮踩过：制造位上限读成 0，导致所有工厂都被判定为队列已满）。
- `AllResourceResponse.list[].res` 是数字（`{EXP:1, GOLD:3, RUBY:4, ARENA_POINT:5, LEAGUE_POINT:6}`），
  而配置表的消耗项写的是名字（`GOLD`、`木材`），两边要分开对待。

### 12.3 收成品、排产与升级的实测时序

| 请求 | 配套 Response | 说明 |
|---|---|---|
| `GainFactoryProduceRequest{buildingId}` | 有 | 领工厂囤积的成品，回 `products.asset[]` |
| `CollectBuildingProductRequest{buildingId:[]}` | 有 | 非工厂建筑的产物，可一次传多个 |
| `StartFactoryProduceRequest{buildingId, productId}` | 无 | 只有这 2 个字段 |
| `FinishWorkerOrderRequest{index}` | 有 | 交居民订单 |
| `UpgradeBuildingRequest{buildingId}` | 无 | 升级建筑 |
| `SpeedUpUpgradeBuildingRequest{buildingId, speedUp}` | 无 | 加速建造 |
| `SpeedUpFactoryProduceRequest{buildingId, speedUp, index}` | 无 | 加速生产，`index` 是队列下标 |

`SpeedUpCostParam{type, useNum}`，`type`: 1=钻石 2=加速器 3=广告；本工具**只用 2**。
`useNum` 按客户端 `new SpeedUpResult(!0, SPEED_UP_ITEM, min(ceil(剩余秒/60), 持有量))` 算，最少 1。

实测（收成品）：对 4 栋有囤积成品的工厂各发一条 `GainFactoryProduceRequest`，
`finishedProducts` 立刻清空，`生鱼片 18→19`、`淡水 15→16`、`布匹 12→13`、`救生衣 9→10`，
响应体是 `{"products":{"asset":[{"type":0,"id":"生鱼片","num":1}]}}`。

实测（排产）：`StartFactoryProduceRequest` 入队时 `finishTime` 就是当前时刻，
5 秒内该队列项消失并出现在 `finishedProducts`。当时（2026-10 早期）把这条读成
「所有排产都即时完成」，**2026-10-23 修正**：真正的解释是英雄委任的
「生产时间减少」把这条短配方压到了 0 秒（见 12.3.1），长配方照样要排队等。
所以循环里每轮「收成品 + 排产」是正常的一进一出，不是重复发同一个请求。
现行规则更保守：**只要 `factoryQ` 非空就整座工厂跳过**（有活就不碰，见 12.3.1）。

#### 12.3.1 生产时间减免与「瞬成排满」

客户端 `BuildingProduceUtil.produceFinalTime` 的公式（不是原样用 `produceTime`）：

```
finalSeconds = ceil( max(0, produceTime - reduce) / (1 + speedUp) )
```

- `reduce` = `GameEffectId.PRODUCE_TIME_REDUCTION`（「生产时间减少」，单位**秒**）。
  大头是英雄委任：`AppointPosCfg` 里 `posId` 1/2/3 三条效果都是「生产时间」，
  单个英雄的贡献 = `AppointEffectCfg.heroAdd[qualityIndex-1] + starAdd[qualityIndex-1] × 星级`
  （客户端 `AppointUtil.getAppointEffect` 同款；`qualityIndex` 取自 `HeroCfg`，1蓝 2紫 3橙 4红）。
  实测本账号 3 个橙色 9 星：`(80 + 28×9) × 3 = 774` 秒。
- `speedUp` = `GameEffectId.PRODUCE_SPEED_UP`（百分比提速），只由服务端 effect 推送，
  591 张配置表里没有，本工具按 0 处理（偏保守：算出来的时间只会比实际长）。

774 秒减免下，90 秒的鱼/淡水、300 秒的布匹/救生衣/烤鱼全是 **0 秒 = 瞬成**；
780 秒的木板剩 6 秒、2100 秒的刺身拼盘剩 1326 秒。所以：

- **只在工厂空闲时补**：判据是 `factoryQ` 为空。队列里还有东西在造 → 这座工厂一轮都不碰
  （提前排只会把料先烧掉，也容易把用户手动排的队插花）。
- **瞬成配方**：空闲时一次把制造位排满（6 个）。每个都独立扣一次材料、占一个存量上限名额。
- **非瞬成配方**：空闲时只排 1 个（队列是串行的，多排只是提前烧料）。
- **所有产品都到存量上限**（`产品存量初始上限`）→ 工厂空着，这是正常状态；
  `planWorld` 会写一条 `空闲：没有能排的配方（产品到存量上限 / 缺材料 / 等级不够）`。
- 选哪个产品：`score = 订单缺口 × 1e6 - produceTime` 降序 —— 订单缺的优先，其余短的先排，
  所以「从第一个产品开始」= 第一个还没满、料够、等级够的配方。
- **不要用「原时长 - 剩余时间」反推减免**：那个差值里混着已经流逝的时间。
  实测拿一个做到一半的 13500 秒配方反推，得到 12500 秒，直接把 780 秒的木板也误判成瞬成。
  观测只能用来抓「队首还剩 0~2 秒」的瞬成证据（`observedInstantRecipes`），不能出数值。

**缺料时用自选包兜底（2026-10-26 加）**：以前 `cover()` 只接在建造 / 交单 / 升级三处，
排产缺料就整座空转 —— 实测 `1切鱼厂` 的鱼油要 `鱼×50 + 玻璃×30`，仓库只有 `鱼 7`，
而原料自选包有 25 万个，却一个都不兑。现在排产也接了兜底，规则刻意保守：

- **能免费排的先排**：先按 `score` 找「料够」的配方，有就照平时排，不为高档配方烧包。
  实测同一座切鱼厂：`鱼 7` 够 `生鱼片`（鱼×6）时，挂机排生鱼片，不会去兑 43 个鱼做鱼油。
- 一条都排不上时，才按 `score` 顺序找**第一条缺口全部有包可换**的配方给它兑料。
  只要有一个材料换不出来（比如布匹只存在稀有的蓝装材料包里）→ 整条配方跳过，连别的料也不兑，
  否则会白兑一堆料去排一条注定排不上的配方。
- **分轮累积**：缺口大于 `maxPackPerRound`（默认 20）时，本轮只兑到额度上限、**照常落账**，下一轮接着补。
  不落账的话「缺口 43 / 额度 20」会永远停在兑不出，鱼油这类配方再也排不上。
  实测：`鱼 7 → 兑 20（不排）→ 兑 20（不排）→ 剩 3 个缺口时兑 3 并开排`。
- 兑换动作（`selectPack`）排在排产动作之前（`actions` 数组顺序即执行顺序），标 `transient`
  —— 兑换被拒多半是「包数记错了 / 这个材料突然不能换」，不该被 `rejected` 记一辈子。

工厂页手动排产走另一条路：缺料且能用这两类包补齐时，按钮变成**「兑料并制造」**，
写明要花几个包（`原料自选包×43`），点它才真的兑 —— 一次补齐全部缺口、不受每轮 20 的限制
（这是单次显式授权）。不点的话一个包都不动，直接点「制造」只会被告知缺口、不发请求。

实测（制造位是**串行**的，2026-10-23 做工厂页时确认）：`factoryQ` 里**只有队首带 `finishTime`**，
后面的排队项 `finishTime` 是 `0` —— 实测 `1食品厂` 排了 6 个「刺身拼盘」，只有第 1 项有完成时间，
`1服装厂` 的 5 项里同样只有队首有。所以：

- `finishTime = 0` 要读成**排队中**，不能当成「已完成」，否则六个格子会一起亮成「可收取」；
- 队首的 `finishTime - now` 才是真实剩余秒数（实测 499 → 392 → 379 递减），
  `BuildingProduceCfg.produceTime` 是这条配方的总时长，两个值不相等是正常的；
- **同一配方可以重复排队**（6 个刺身拼盘就是证据），工厂页只标注「队列×N」，不阻止用户继续排；
- 制造位上限（6）是队列长度上限，不是并行数。

#### 12.3.2 农田：播种与收获

农田不是工厂，产物也不走 `product.asset`（农田这一项**恒为空**），状态全在 `building.farm` 里：

```json
"farm": { "productId": "玉米", "plantTime": 1792735168, "ripeTime": 1792736870 }
```

- `productId` 为空 = 空地（要播种）；`ripeTime <= now` = 成熟（要收）；否则生长中。
- 收获：`FarmHarvestRequest { buildingId: repeated string }` —— **一次能装多块地**（客户端框选批量走的就是它）。
- 播种：`FarmPlantRequest { args: repeated PlantArg }`，`PlantArg = { buildingId, productId }`，
  同样一次能种多块；也能混种（args 里每项各带自己的 productId）。
- 作物表 `FarmlandPlantCfg`：`{ id, time, produceNum, res, material }`，13 种作物。
  **`material` 是一对 `[种子名, 份数]`，不是 `[[id,num], …]` 的列表** ——
  当成列表取 `[0]` 会拿到字符串「玉米种子」，解构出「玉」「米」两个字，种子永远扣不到（实测踩过）。
- 收获给 `produceNum`（5）+ 成熟时间：小麦/玉米 1800 秒、土豆/番茄 2400、胡萝卜/卷心菜 3600、大豆/南瓜 4800。
- 加速：`FarmSpeedUpRequest { buildingId, param: SpeedUpCostParam }`（`type=2` 加速器），本工具不用。
- 游戏内「自动种植」：`SetAutoFarmingRequest { isOn }` + `water.autoFarming`，需要 VIP 功能「农田自动种植」。
  开着时服务端自己播种，计划器**只收不种**（`survey.autoFarming` 为 true 就跳过播种并写 notes）。

计划器的取舍：
- **播种顺序按「价值从高到低」**。作物表没有价格字段、`produceNum` 全是 5，唯一能当价值的量就是
  `time`（时间越长越贵：橡胶 15600s > 花菜 7200 > 大豆/南瓜 4800 > 胡萝卜/卷心菜 3600 >
  土豆/番茄 2400 > 小麦/玉米 1800），所以用 `time` 降序。同一时长内订单缺的优先。
- 种子按库存扣，扣不到的地块逐块写进 notes（「还有 N 块没种子可种」），不会种到一半才发现没种子。
- 开关 + 节流：计划器只认 `planWorld({ farm })`，循环按 `farmEveryMs`（默认 120 秒）调 `gateDue` 决定这轮做不做。
  只有真的排出收/种动作才更新 `lastFarmAt`，跟拾荒同一套语义。

### 12.4 资源田：静态数据在客户端地图 bundle 里

`MyResFieldsResponse.info = {fields:[{gridIdx, cityId, type}], maxNum}` 只描述**已经占下的**田。
哪些 `gridIdx` 是田来自客户端静态地图数据（`worldModelMgr.getResourceModel(gridIdx)`），
591 张配置表里没有任何 grid→田 的映射。地图 bundle 已从 CDN 取下并解码：

- `world_map1`：240x640，97 城，717 块田；`world_map2`：408x1088，281 城，2531 块田。
- `mapData[gridIdx] = resType * 10000 + cityId`；`cityInfo[cityId] = {gridIdx, fort, res:[田的 gridIdx...], neighbors, monsters}`。
- 读取入口 `src/world.mjs` 的 `loadMapAsset(scenarioId)`，文件在 `work/cdn/world_map.world_map1.json`。

占田用 `ChallengeResFieldRequest{resFieldGridIdx, fleetBuildingIds}`、放弃用
`GiveUpResFieldRequest{resFieldGridIdx}`，两者都无 Response。

**实测本账号不可自动占田**：`MyFleetsResponse.fleets` 是空数组，占田的前置条件
（有闲置且 `durability>0` 的舰队）不满足；账号 `guildId=0` 也没有联盟。
因此 `field` 模式只做只读报告（`src/world.mjs` 的 `formatFieldReport` 会如实打印
「没有舰队，占田的前置条件不满足」），占田 / 弃田必须手动指名 `gridIdx` 并显式 `--yes`。

### 12.5 循环与门控

`runLoop` 每轮顺序执行：任务（`surveyTasks` → `runTasks`）→ 日常（`surveyDailies` → `runDailies`）
→ 海面（`surveyWorld` → `planWorld` → `runWorld`）。每轮都是「先只读探测，再算计划，再执行」，
所以第二轮起没什么可做时计划自然为空，不会重复发同样的请求。被服务端拒过的具体动作记在
跨轮的 `rejected` 集合里，同类动作失败后不再重试。

门控延续既有边界，未放宽：写请求要 `--yes` 或 `CW_ALLOW_MUTATE=1`，网页要 `confirm: true`；
`DenyOrder`（拒单消耗订单名额）与加速各有独立开关（`--reroll` / `--speed-up`），默认关闭；
加速只花「加速器」道具，**不花钻石**；`--rounds 0` 表示一直跑到 Ctrl-C / 网页停止按钮。

#### 12.5.1 循环的节奏：对齐、容差、热更新、段级停止（2026-10-26 修）

这四个都是「跑起来才发现不对」的问题，改之前用户看到的现象写在括号里：

- **间隔按「轮首 → 下一轮轮首」对齐**（现象：设 60 秒，日志时间戳却每次往后漂十几秒）。
  原来是轮尾 `sleep(间隔)`，而一轮要跑 8 段、耗时几秒到几十秒，于是周期 = 间隔 + 耗时。
  现在轮尾等的是 `间隔 - 本轮已耗时`，最后一轮不等待（否则 `--rounds 1` 会白等一个间隔才退出）。
- **主循环间隔下限 5 秒**（现象：把间隔填 0「想让它快点」，结果一小时几千次探测）。
  其它 gate 的 `everyMs = 0` 意思是「每轮最多做一次」，主循环填 0 却是「上一轮结束立刻开下一轮」，
  两者语义不同，所以 `loopGap()` 里钳到 `MIN_LOOP_GAP_MS`。
- **gate 判定留容差**（现象：「货轮/情报也是 60 秒，怎么老是两轮才跑一次」）。
  `tickAt` 是轮首，`lastAt` 是轮内某段真正执行的时刻，两者天然差几秒；间隔正好等于轮间隔时，
  每轮都会「差一点点」。容差取间隔的 10%、最多 2 秒（`gateSlack`）。
- **网页热更新**（现象：改完间隔要点停止再开始，前面跑的轮次白等；更糟的是 3 秒轮询会把刚改的
  输入框写回旧值，让人以为改不动）。服务端把参数都存在 `session.loop` 上，`runLoop` 收一个
  `live: () => loop`，**每轮开头重读一次**（间隔、各段开关、抢哪些等级、材料加速、执行范围都算）；
  `/api/loop/start` 在运行中不再报错，而是把这批参数应用上去并返回 `{hot:true}`。
  页面侧配合两件事：运行中按钮变「应用设置」；用户改过的控件打「脏」标记，轮询不再回填它。
- **段级停止**（现象：点「停止」像没反应，因为要等整轮几十个请求跑完）。每段开头检查
  `stop.aborted`，命中就收尾退出（`summary.stopped = true`，日志写「已按要求停止」）；
  页面另有 `stopping` 状态显示「正在停止（这一段跑完就退）」。

配套：`summary.elapsedMs` 记每轮耗时（页面显示「上一轮耗时 12 秒」），`finish()` 统一收尾，
保证断线跳过 / 被停止 / 海面失败 / 正常结束四条路的 summary 字段都齐（缺段会让格式化撞 null）。

### 12.6 本轮实测结果

- `tasks`：主线 62 领取成功，下一轮立刻出现主线 63，说明成长任务是链式的（领完当前才解锁下一条）。
- `world`：一次计划 8 条（4 收成品 + 4 排产），8/8 成功，材料按配方扣减
  （木材 -5、塑料 -15、玻璃 -10、海藻 -20、碎布 -30）；再探测时订单 #1-#4 仍是材料不足，
  按「不重刷」策略保留等待生产。
- `loop --rounds 1 --every 5 --yes`：任务 1/1、海面 6/6，全成功零失败，人口 30/40。
- 升级动作在本账号（lv11）不会触发，这是正确行为而非缺陷：切鱼厂/食品厂已 lv2，
  海水厂 lv2 需要人口 45（当前 30），材料厂 lv2 需要玩家等级 13，服装厂 lv2 需要 12，
  训练营 lv2 需要 28 —— 全部被 `BuildingUpgradeCfg` 的等级/人口门槛挡住，计划器已按门槛判定。
- 网页控制台「自动循环」页签背后的接口全部用 curl 验证过一遍：
  `GET /api/tasks`、`GET /api/world`、`POST /api/tasks/run`、`POST /api/world/run`、
  `POST /api/loop/start`（缺 `confirm` 报「需要确认才会开自动循环」；运行中重复调用 = 热更新设置，
  返回 `{hot:true}` 而不是报错，见 12.5.1）、
  `GET /api/loop`、`POST /api/loop/stop`（停止后 `running` 翻回 false，收尾期间 `stopping:true`）。

### 12.7 活跃度宝箱、每日赠礼与自动建造

**日活跃度宝箱和周活跃度宝箱是两张表，门槛差很远。** 客户端也是分开取的
（`AchievementUtil.allDailyActiveRewardCfg / allWeeklyActiveRewardCfg`）：

| | 表 | 门槛 | 奖励示例（第 1 档） |
|---|---|---|---|
| 每日 | `DailyActivityRewardCfg` | 20/40/60/80/100 | 加速器 120 |
| 每周 | `WeeklyActivityRewardCfg` | 120/240/360/480/600 | 藏品券 10 |

两张表都是 4 个 season × 5 档，`id` 在季节之间重复，只有第 5 档的奖励随赛季变，
所以判「哪几档可领」只用 `id`，不用挑季节。领法：`DrawDailyRewardRequest{index:[…]}` /
`DrawWeeklyRewardRequest{index:[…]}`，都是 repeated int32、都无 Response。

> 踩过的坑：一开始拿 `DailyActivityRewardCfg` 去算周宝箱，85 周活跃被算成「可领 1-4 档」，
> 发出去服务端回 `prompt=38` 全拒。`src/dailies.mjs` 的 `CHEST_TABLE` 现在把
> 「kind → 表名」写死，`selftest` 会拿真实配置表断言「80 日活跃够 1-4 档、80 周活跃一档都不够」。

**「每日赠礼」不是宝箱，也不在配置表里。** 它是「福利 → 每日特惠 → 每日精选」面板里那档免费礼包：

- packId 是客户端**硬编码的字面量**（`DailyPackBuyPanel` 的字段初值）：
  `freePackId="赠礼"`、`wholePackId="合并礼包"`、`packIdArr=["礼包1","礼包2","礼包3"]`。
  后两个要走充值（或先买过礼包 1/2/3），本工具不碰。
- 可领性看 `DailyGiftPackResponse.drawnPack` 里有没有 `"赠礼"`；`resetTime` 是次日 0 点。
- 领取用 `GotFreeDailyPackRequest{packId:"赠礼"}`，**协议表里没有配套 Response**，
  所以发完必须重新拉一次 `DailyGiftPackResponse` 确认 `drawnPack` 真的多了它 ——
  「没被 prompt 打回」不等于成功。

**礼包码兑换**（公告/补偿码，如 `VIP666`/`VIP777`/`VIP888`）走设置里的 `GiftCodePop`：

- 请求体只有一个字段：`GotGiftCodeRequest{giftCode:"VIP666"}`（客户端把输入框原文直接发，
  不做大小写归一）。协议表里**没有 `GotGiftCodeResponse`**，但服务端**不是完全静默**：
  兑换成功会推 `SCUpdateItem`/`SCUpdateResource` + 一条 `GotRewardResponse`（奖励明细），
  码无效/已使用时只推 `PromptResponse`。所以失败判据照旧用 `sendWatch` 守窗口，
  而"真的到账了没有"要看紧接着的 `GotRewardResponse`（`data/responses/<日期>/GotRewardResponse.jsonl`）。
- CLI：`node src/app.mjs act giftCode giftCode=VIP666 --yes`。
- 批量兑：`node tools/gift-codes.mjs --file codes.txt --yes`（一条连接顺序发，逐条按回包判结果，
  结果写 `outputs/gift-codes-<日期>.md`）。服务端拒绝时的 `PromptResponse.args` 是**空的**，
  只有 `prompt` 枚举值，含义在客户端 `Prompt` 枚举里：63=码已过期、64=码无效、65=已兑换、
  66=该批次用完、67=已被他人使用、70=操作过频。工具会把数字翻成人话。
- 2026-10-26 实测（`灭世丶天空6778`）：VIP666 = RUBY100+抽卡券2+加速器100，
  VIP777 = RUBY100+藏品券2+加速器100，VIP888 = RUBY100+GOLD10000+保险箱钥匙3，三码全部到账。
  随后把网上汇总的 299 个码跑了一遍（分四批：通用清单 / 9game 大清单 / TapTap 周礼包 / 10.26 微信批次），
  **89 个到账**，明细在 `outputs/gift-codes-2026-10-26.md`（第三方汇总表里大量码已过期或根本不存在，
  `prompt=63/64` 占七成，属正常）。经验：**中文口令码**（水世界上线礼 / 水世界琥珀玩家礼 / 益世界关注礼 /
  小春666-999）和 **`yxz` 前缀码**命中率最高；TapTap 上那些「周礼包码」列表基本全是过期的。
- **`prompt=63` 和 `prompt=64` 是两种完全不同的东西**（2026-10-26 第二轮 139 个码实测确认，判据记牢）：
  - `63` = 服务端**有这个码**、但已过兑换期 → 真码，只是来晚了；
  - `64` = 服务端**根本没有这个码** → 采集站编造、OCR 抄错，或者干脆是别家游戏的码。
  实测样本：7724 的「抖音小程序官方发布篇 + 明星人名系列」（`WARM888` `WJDR2026F` `朱芳雨666`
  `吴镇宇888` `呆妹888` …）81 个**全是 64**，因为它搬的是另一款末日 SLG 的码（奖励写「寒晶 /
  陷阱零件 / 兵营加速卡 / 防寒药剂」，本游戏没有这些道具）；而今日头条历史 CDK 归档里
  `YXZ*` `MRY*` `dw*` `Mozz*` `zb*` 前缀 39 个是 63 —— 证明这些前缀**确实是真实码池**，只是公开样本全过期了。
  所以「大批量跑码」时看 63 的比例就能判断这批来源是不是本游戏的：清一色 64 直接换源。
- **公开渠道已兑干（2026-10-26）**：累计试 438 个码、89 个到账。再想拿新码只有官方公众号周推文
  （后台回「礼包」）、游戏内公告/补偿邮件两条路，都是限时限量，看到就得兑 —— 有效码的生命周期实测
  只有几天（10.20–10.25 发的 `SSJGTG83`/`WYHML9O6`/`yxzRNS3T32`/`SJ3SS7` 当天有效，一周后同批全 63）。
- 游戏内邮件**不带码**：23 封邮件的 `subject` + `content` 全文正则扫过，零命中。别再重复这个思路。
  邮件结构：`EmailBoxRequest{pageNo}` → `EmailBoxResponse{email[], total}`，单封是 `EmailDetail`
  （`subject` / `content` / `sender` / `attachment` / `got` / `status`）。

**建造与升级是两个请求。** 客户端 `_toBuildOrUpgradeRequest` 的分支是
`0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`，判据是
`BuildingUpgradeCfg` 的 level 1 行（49 种建筑这一行全是 `costTime:0 / consume:[] / condition:[]`，
只卡 `playerLevel`）。计划器里的两个陷阱：

1. `level === 0` 且 `buildFinishTime` 在**将来** = 正在盖，重发只会被拒，跳过；
2. `level === 0` 且 `buildFinishTime` **已过** = 本轮要先发 `FinishUpgradeBuildingRequest`，
   收尾后它已经是 level 1，同一轮**不能再排建造**（`planWorld` 用 `finishing` 集合挡掉）。

材料不齐时客户端会先弹「用钻石补」，本工具不这么做，记一笔
「建造材料不足（X a/b），不买材料，等下一轮」；等级不够也记明「建造要等级 N，当前 M，先推主线」。

### 12.8 联盟情报（雷达）：按舰队战力派兵

游戏里的「联盟情报」就是客户端的 `RADAR_VIEW`，数据来自 `RadarInfoRequest`：

```
radarInfo = { events[], level, exp, storedNum, nextRefreshTime, fixedEvent? }
events[]  = { uid, eventId, color, gridIdx, reward:{asset[]}, pirate?:{type,level},
              refugee?:{requirements[]}, createTime, state }
fixedEvent = { eventId, gridIdx, startTime, createTime, state }   ← 第 6 个字段，不在 events 里
```

**固定事件在单独的 `fixedEvent` 字段（单数，一次只有一个），只遍历 `events` 会整条看不见。**
客户端 `WorldRadarModel._updateRadar` 是这么做的：`var f = [].concat(e.events); if (e.fixedEvent) f.push(e.fixedEvent);`
—— 追加进同一份列表，再用同一个模型类包装，靠 `eventData instanceof RadarFixedEvent` 区分
（本地 uid 固定成 `RadarUtil.FIXED_UID = 1`）。「路易斯的行踪」就是固定事件。

- **`state`** 是 `RadarEventState`：`1 INIT`（可派兵）/ `2 LOCKED`（被占）/ `3 START`（我方在打）/ `4 FINISHED`（可领奖）。
  实测抓包时 10 个事件全是 `1`。
- **`pirate{type, level}`** 决定敌方战力，查 `WorldPirateCfg`（3 种海盗 × 550 级）：
  type 1/2/3 = 海盗先锋/精锐/头目，lv1 分别是 84200 / 123000 / 118000。
  `eventId >= 10000` 的才是随机事件表 `RadarRandEventCfg` 里的类型；`eventId < 10000` 是固定事件
  （`RadarFixedEventCfg`，150 档，自带 `power`，最小 155000、最大 4 亿）。
- **固定事件没有 `reward` / `color` / `pirate`**：奖励要回 `RadarFixedEventCfg.reward`（`[[id,num],…]` 对子）补，
  战力查 `RadarFixedEventCfg.power`。代码里 `fixed` 标记优先信「来自 `fixedEvent` 字段」这个事实，
  `eventId < 10000` 只作兜底（且必须带 `eventId > 0`，否则 events 里 eventId 缺省的畸形条目会被当成固定事件）。
- **固定事件「我方已派兵」有两个信号**：`state` 变 3，以及 `startTime > 0` ——
  客户端 `isBatting() = startTime>0 && (isPirate || isFixed)` 就是这条（专门给海盗和固定事件留的）。
  服务端还会主动推 `SCRadarEventState` 更新 state/startTime，且**只在 state 变 FINISHED 时才
  `removeTrackRadarUid()`**（解除「本会话已派过」的防重）。所以 state 的推送有延迟时，靠 `startTime` 兜住，
  否则挂机会每 60 秒重复派一次、白烧 500 汽油/次。
- **配置查不到战力时不能放行**：`power = 0` 会让 `need = 0`、`fits` 恒真，变成闭眼派船去打。代码标 `powerUnknown`，
  跳过并在文案里写「配置过期」（说明该跑 `tools/sync-config.mjs` 刷配置了）。
- **`refugee.requirements`** 是「解救难民」要交的材料，材料不齐别派（派了也是白跑）。
- 其余事件（打捞宝箱 / 救助海兽 / 收集资源）没有 `pirate` 字段，属于「无需战斗」，但**仍要派舰队**
  —— 客户端所有情报事件都走同一个 `RadarSendFleetsRequest`。

请求（`tools/describe.mjs` + 反编译客户端双重确认）：

| 请求 | 字段 | 说明 |
|---|---|---|
| `RadarSendFleetsRequest` | `uid: int64`, `fleetBuildingIds: repeated string` | 固定事件（`isFixed()`）**不带 uid**，只带舰队 |
| `RadarGetRewardRequest` | `uid: int64` | 按事件领 |
| `RadarGetAllRewardsRequest` | 空体 | 一键全领，本工具用它（固定事件也走这条，因为它没有 uid） |

固定事件派兵的编码实测：不带 uid 的 payload 是 `120a31…`（只有 field 2）；
带 uid 的以 `08` 开头。所以「不带 uid」不是省字段，是服务端靠它认「当前固定事件」。

舰队：`MyFleetsResponse.fleets[] = { buildingId, state, durability, power, maxDura, autoFight, cityId }`。
`FleetState`：`1 IDLE` / `2 MOVING` / `3 BATTLING` / `4 REPAIRING` / `5 QUEUING` —— **只有 IDLE 能派**。
实测本账号 1~2 艘远征船，`power` 48 万～68 万，所以能稳定打过 lv1~lv5 的海盗（≤29 万）。

本工具的做法（`src/radar.mjs`）：
1. **先领奖**：`state === 4` 的事件合成一条 `RadarGetAllRewardsRequest`。
2. **再派兵**：只在有 IDLE 舰队时派，且 `舰队战力 ≥ 敌方战力 × minPowerRatio`（默认 **1.2**）。
   战败会掉舰船耐久、修船要资源，所以宁可少打一个也不拿船去赌。
3. **排序**：固定事件优先 → `color` 降序（4 紫 > 3 蓝 > 2 绿）→ 敌方战力降序 → 奖励件数。
   **固定事件必须排最前**：它没有 `color`（恒为 0），按颜色排会永远垫底，而空闲船少于事件数时
   垫底就等于永远轮不到 —— 「路易斯的行踪」就是这么一次都没被打过的。
   **不能只按奖励件数排** —— 打捞宝箱带 `GOLD 3700`，按件数算会把分数拉得虚高，结果船天天去捞箱子。
4. **每艘空闲船各派一个**：一艘船同一时刻只能打一个点，所以空闲船数就是并发上限；
   同一事件不会被派两次（`taken` 集合按事件 key 去重，固定事件用 `eventId+gridIdx` 兜底 key）。
   配对是贪心：空闲船按战力降序排，最强的先挑优先级最高的事件，弱船顺延挑剩下能打赢的 ——
   战力不够的事件不硬派（打输掉耐久，修船要资源）。派出去后 `state` 变 MOVING，
   下一轮探测自然看不到那几艘船。
   失败隔离按船分组（`group: radarDispatch:<buildingId>`）：一条被拒只停这艘船，别的船照派。
   每个事件的判定文案（`可派` / `已派兵` / `材料不齐` / `战力不够` / `配置过期` / `待领奖`）
   由 `viewRadar` 的 `verdict` / `verdictChip` 统一给出，文本视图和网页只读这两个字段 ——
   以前两边各算一套，加了固定事件后就漂移了（页面不认识「已派兵」）。
5. **按自己的间隔跑**（`runLoop` 的 `radarEveryMs`，默认 60 秒）：这也是后来补的 ——
   事件会随时刷出来，但每轮都探测等于每轮多发 `RadarInfo + MyFleets + AllItem` 三个请求。
   现在跟拾荒/农田共用 `gateDue`：没到点整段跳过（一个请求都不发），到点才跑一整套
   「读取情报 → 领已完成奖励 → 每艘空闲船各派一个事件」。
   计时语义跟拾荒/农田**不同**：那两个是「真的排了动作才计时」，情报是**探测成功就计时**
   —— 因为「读取情报」本身就是这套动作的一部分；探测失败不记时，下一轮立刻重试。

页面上的分工：手动那套（读取情报 / 领奖 + 派兵 + 舰队表 + 事件表）在**日常页**，
自动那套（开关 + 间隔 + 战力余量 + 上次/还差）在**挂机页**的「自动联盟情报」。两处共用同一个
`minPowerRatio`（战力余量仍留在挂机页那个输入框）。

客户端也有内置的「自动雷达」（`AutoRadar.running()`，读 `情报事件消耗汽油` 参数、遍历 `isInit()` 事件、
取第一个 `idleTroopIds()` 派出去），但它**不看战力**，而且非月卡用户派一次就 `stop()`。
本模块的价值就是「按战力挑、能连续派」。

汽油：派兵要消耗（`情报事件消耗汽油` × 舰队数）。实测账号 16.7 万汽油，够用很久；
`surveyRadar` 会把汽油余额读出来给页面看，但**不做余额拦截**（参数名跨表查不到时按 0 处理，拦了反而误伤）。

### 12.9 装备厂（锻造）：收取 + 按部位均衡排产

锻造不挂在 `factory` 上 —— 装备厂是**另一种建筑**，状态在
`DispWaterBuilding.equipMaking = { makeId, equipId, star, finishTime }`，全城 65 座建筑里只有
「1装备厂」带这个字段。所以 `planWorld` 完全不碰它，逻辑独立在 `src/equip.mjs`。

**为什么必须进挂机**：同一时间只能造一件，客户端点「锻造」先判 `_makeUpLeftSeconds() > 0`，
还在造就只弹提示、连排队都不给 → **造好不收 = 整座工厂停产**。
实测代价：`1装备厂` 从 2026-10-24 13:25:45 造好「蓝饰品1」，到 10-25 10:40 的 14007 条回包
一次没变，卡了 21.8 小时。

请求（`tools/describe.mjs` + 反编译客户端双重确认）：

| 请求 | 字段 | 说明 |
|---|---|---|
| `PickMadeEquipRequest` | `buildingId` | 收取，回 `PickMadeEquipResponse { equipId }` |
| `MakeEquipRequest` | `buildingId`, `makeId`, `universal` | 无 Response，结果靠 `SCUpdateWaterBuilding` 推送 |
| `SpeedMakeEquipRequest` | `buildingId`, `speedUp` | **花钻石加速，本项目永不使用** |

`universal` 是客户端的 `_isAutoExchange`（材料不够时自动兑换），我们恒发 `false`。

配方 `BuildingEquipMakeCfg` 12 行 = 3 部位（武器 1xxx / 防具 2xxx / 饰品 3xxx）× 4 品质
（末位 1~4 = 蓝/紫/橙/红），`seconds` 1800 / 7200 / 21600 / 43200，红装标 `season: 2`。
**赛季号在协议里拿不到**（没有哪条状态消息带 season 字段），所以按材料筛 ——
红材料要 800 个，攒够之前不会去试；真攒够了但赛季没开，服务端会拒一次，日志里能看到。

锻造时间有委任减免：`AppointPosCfg posId 13/14/15 =「锻造时间」`（playerLevel 17/22/26）。
本账号海森堡 7 星紫卡占 posId 13 → `76 + 28×7 = 272` 秒 → 蓝装 1800s 实际约 25.5 分钟。
**但不按这个算时长** —— 造没造好以服务端给的 `finishTime` 为准。

排产策略（英雄每个部位只能穿一件，所以「可分配库存」必须成套）：

1. 件数口径 = **背包 + 打造中**（已穿在英雄身上的不算：那是「已在用」，不是「可分配」）；
2. 哪个部位件数少就补哪个；件数相同时按 **武器 → 防具 → 饰品** 固定轮转
   （`Array#sort` 在 V8 里稳定，所以造完一件自然轮到下一个部位）；
3. 部位内先试品质最高的配方，材料或金币不够就**自动降级** ——
   紫材料攒够 160 时会自动改造紫装，不用改代码；
4. 一轮最多一个收取 + 一个排产，两条动作共用 `group: equip:forge:<buildingId>`，
   收取失败时同一轮不再硬排一件（否则两条必然一起失败，日志全是噪音）。

挂机里是第 6 阶段（`forgeEnabled` / `forgeEveryMs`，默认 **180 秒**），复用 world 那一轮已经拉到的
建筑与库存（含 GOLD —— `surveyWorld` 把 `AllResourceResponse` 合进了 `stock`），所以这轮只多一个
`EquipsRequest`。计时语义跟情报一样：**探测成功就计时**。

### 12.10 挂机领取：邮件 / 本段收益 / 等级奖励 / 等级升级

这一节记的是 2026-10-25 补的第 6 个自动模块（`src/idle.mjs`，循环里的 `idleEnabled`）。
起因是一个洞：**挂机本段收益以前只由日常任务 1004 驱动**——服务端那天没下发这条日常，收益就整天没人领，
而 `DrawAfkRewardResponse` 会把时间段重置成新的 8 小时，封顶之后产出等于停摆。

四件事一次探测一起处理，判据全部照抄客户端：

| 动作 | 请求 | 判据（客户端出处） |
|---|---|---|
| 邮件附件 | `QuickGotReadEmailRequest{all:true}` | `MailView._gotAllMail` 的按钮灰化条件：存在 `status==EmailStatus.ES_NEW(2)` 的邮件，或 `attachment != null && !got` |
| 挂机本段收益 | `DrawAfkRewardRequest{}` | `afkFinishTime > 0 && now >= afkFinishTime`（OfflineRewardView 领取按钮） |
| 挂机等级奖励 | `DrawAfkLevelRewardRequest{level}` | `nextLvRewardCfg(rewardedLevel)` = `OfflineLvRewardCfg` 里第一个 `level > rewardedLevel` 且 `reward` 非空的行；再要求 `level <= afkInfo.level` |
| 挂机等级升级 | `UpgradeAfkLevelRequest{level}` | `OfflineRewardView._refreshLevelUpBtn` |

**三条容易踩错的细节：**

1. `EmailStatus` 只有 `ES_READ=1` / `ES_NEW=2` 两个值 —— **没有「已领」状态**，领没领看 `EmailDetail.got`。
   所以判「有没有得领」必须同时看 `status` 和 `got`。
2. `AfkModel.maxLevel()` = `OfflineCfg` 里 `stage <= playerInfo.mainlineStage - 1` 的最大 `level`。
   主线关卡不够时，客户端连按钮都不亮（只弹「达到主线第 X 关解锁 Y 级」）。所以我们同样按等级上限拦，
   不靠服务端拒绝。
3. **`UpgradeAfkLevelRequest.level` 是「升几级」，不是目标等级。** 客户端把 `_jumpLevelUp` 塞进这个字段，
   而 `_jumpLevelUp` 只会是 10 / 5 / 1：先试连升 5 级（累计 `offlineCfg(level+1..level+5).consume[1]`），
   够了再试 10 级，都不够就退回 1 级。`consume` 形如 `["挂机徽章", 1]`，数量在 `consume[1]`。

**升级会重置本段计时** —— `UpgradeAfkLevelResponse { level, afkStartTime, afkFinishTime }` 回传新的
时间段，客户端 `_onLevelUp` 直接 `setAfkInfo` 覆盖。所以「本段已经累积 7 小时、但还没到封顶时升级」
等于把那 7 小时的产出白扔。实现上做了两层保护：

- **计划层**：只有 `afk.fresh`（本段计时不到 2 分钟）或 `afk.ready`（已封顶，这一轮就会领）才排升级；
- **执行层**：升级动作带 `after: 'afkDraw'`，`runIdle` 发现本段收益没成功就跳过升级，
  一个字节都不发（`selftest` 有断言钉住这条）。

顺序固定：邮件 → 本段收益 → 等级奖励 → 升级。概览一行：
`挂机 Lv40（已领到 35） · 本段还剩 42 分 · 挂机徽章 0/1（上限 Lv41） · 邮件 20 封都已领`。

挂机里是第 4 阶段（放在海面之后，直接复用 `worldSurvey.stock`，省一次 `AllItemRequest`），
`idleEnabled` / `idleEveryMs` 默认 **300 秒**：收益 8 小时封顶、等级奖励按级一次，都是小时级节奏。

### 12.11 搁浅的货轮（世界宝藏）：等级多选，被占着的也派，一次压一个

游戏里叫「世界宝藏」（`moduleId = 世界宝藏`，`dispName = 搁浅的货轮`，2026-10-25 起玩家 19 级开放）。
`src/treasure.mjs`，循环里第 5 阶段（`treasureEnabled` / `treasureEveryMs`，默认 **60 秒**）。

**玩法**（游戏内「世界宝藏」说明 + 配置表 + 抓包三方对齐）：

| 事实 | 出处 |
|---|---|
| 每天 8:00~22:00 每个整点刷新 | `SCTreasureLootRefresh.nextRefreshTime` 实测回的就是下一个整点（`1792936000 → 1792936800`） |
| 万吨 1 / 中型 3 / 小型 6（本剧本） | 同一条推送的 `stats: [{color:4,count:3},{color:3,count:6},{color:5,count:1}]` |
| 每人每天最多 3 次奖励 | `TreasureLootParamCfg`「每日宝藏奖励次数」= 3，`TreasureLootStatsResponse.totalRewardTimes` = 3 |
| 进度 100% 结算，前 5 名有奖，满次顺延 | 游戏内说明「货轮奖励」四条 |
| 同联盟最多 10 支占同一个 | 游戏内说明「舰队数量限制」 |
| 单支派兵消耗汽油 500 | `WorldParamCfg`「进攻宝藏消耗汽油」 |

**品质枚举偏移**：协议 `color` 是全局品质枚举（3 蓝 / 4 紫 / 5 橙），`TreasureLootCfg` 用的是
`qualityIndex` 1/2/3，两者**差 2**。抓包验证：`color 3` 的奖励是「蓝装材料自选包」，
`color 4` 是「紫装材料自选包」，`color 5` 是「橙装材料自选包」。代码里按 `color - 2` 反查表，
不硬编码名字（配置表改名不用动代码；查不到就降级成「货轮（品质 N）」而不是丢掉）。

**等级是多选的**（2026-10-26 按用户要求改）：页面上「抢哪些」勾 小型 / 中型 / 万吨，对应协议 `color` 3/4/5，
`DEFAULT_COLORS = [5]` 即**默认只抢万吨（大货轮）**。`colorsOf()` 负责归一：不传 → 默认值；显式空数组 → 空
（三个全不勾 = 一个都不抢，**不能**悄悄回退成默认，否则用户「全取消」会变成「仍抢万吨」）；
只认 `>= 3` 的整数，脏值丢掉。

**已经有人占领的也照派**（同一天按用户要求改，原本只抢 `ownerGuildIdx === 0`）：`ownerGuildIdx != 0`
只说明「被某个联盟占着」，而协议只给联盟编号、拿不到自己的 `guildIdx` —— 自家联盟在推的货轮同样是这个值；
而且整点刷新后几十秒就可能被别人占光，干等着等于当天空手。派过去要先打赢守军才算数
（`TreasureLootInstance.battlePoint.rightFighter` 里**没有战力字段**，只有 name / avatar / isNpc / guildIdx / skinId），
输赢只能看战报（进邮件，由 12.10 的挂机领取一并收）。代价是输了掉舰船耐久（维修 6 汽油/点），
所以**同一等级里无人占领的排在前面**先派。

**优先级 = 等级（万吨 > 中型 > 小型）→ 同等级里 无人占领(0) → 我方在推(1) → 别人占着(2) → 物品件数 → 资源 → uid**。
等级排在「有没有人占」前面是刻意的：让「无人占领的中型」盖过「被占的万吨」，就变成宁愿捡小的也不去抢大的，
与需求相反（`selftest` 有断言锁这条）。

**名额按我方舰队数算**：`slotsLeft = 10 − 我方在该货轮上的舰队数`（`MyFleet.treasureLootUid` 反查）。
不能用 `10 − ownerFleetNum`：那是**占领方联盟**的船数，可能是别人的 —— 别人占满 10 支时会把我们算成 0 支，
永远不派（这正是「只抢无人占领」年代留下的隐患）。

**舰队判据照抄客户端**：`state === 1`（`FleetState.IDLE`）且 `treasureLootUid === 0`。
`MyFleet.treasureLootUid` 是 field 19 int32，为 0 时 protobuf 不编码、字段直接不出现 ——
所以读出来是 `undefined`，统一按 0 处理。客户端 `CmdUtil.autoTreasureLoot` 的原话：
`f.troopState == u.Idle && 0 == f.treasureLootUid`。

**一次只打一个货轮**：一条 `TreasureLootSendFleetsRequest{uid, fleetBuildingIds:[…]}` 把选中的空闲船全塞进去
（客户端「自动抢万吨」也是这么发的）。理由：进度是「所有占领者同速推进」，船越多越快结算；
而每天只有 3 次奖励、一天 14 次刷新，分散到多个货轮只是把每场都拖慢，拖慢就更容易被人抢走。
默认最多 3 支（`DEFAULT_MAX_FLEETS`），汽油不够自动少派（派到一半卡住比不派更糟）。

**排序不能用总件数**：`reward.asset` 里 `type 0` = 物品、`type 1` = 资源。抓包实测有
「GOLD×8300」的金币货轮，按总件数排会永远排第一 —— 跟 12.8 里「带 GOLD 3700 的打捞宝箱把分数拉得虚高」
是同一个坑。`rewardScore` 返回 `{items, resources}`，排序是 等级 → 占领状态 → items → resources → uid，
资源只做同分时的次级比较。

**没有领取请求**：协议里只有 List / SendFleets / Defence / Rank / Stats，结算奖励由服务端自动发
（战报进邮件），由 12.10 的「挂机领取」一并收掉。所以本模块唯一的写操作就是派舰队。

**为什么默认 60 秒**：抢的是整点刷新后那几十秒 —— 万吨全服 1 艘，客户端「自动抢万吨」是
收到 `SCTreasureLootRefresh` 推送立刻抢。固定间隔的架构下，60 秒意味着刷新后最多 1 分钟响应，
与情报同节奏；稳态一轮只多 3 个只读请求（Stats / List / MyFleets，汽油复用海面那一段的库存），
没有可抢的时候一个写请求都不发。

**为什么排在情报之前**：两边抢的是同一批空闲舰队。`planRadar` 是「有多少空闲船就派多少」，
放在前面会把船全派去刷 6 小时才刷一批的情报事件，货轮就永远排不上。所以循环顺序是
海面 → 挂机领取 → **货轮** → 情报 → 锻造。

**没做的那件事**：客户端 `autoTreasureLoot` 在舰队回港且耐久不满时会自动
`RepairFleetRequest`（修完再派回同一个货轮）。本模块不修船 —— 维修按 6 汽油/点，属于
「花资源换收益」的决策，交给人在游戏里判断；只在日志里说明「舰队在修理中」。

#### 12.11.1 活动有效期（赛季窗口）

需求原话是「这个活动是有有效期的，获取一下有效期，过期之后不再进行，并且在日志中打印」。
先把「有效期到底存在哪」这件事查清楚 —— **它不在活动体系里**：

| 查过的地方 | 结论 |
|---|---|
| `SCAllActivity`（18 个字段） | 只有首充 / 七日登录 / 限时礼包 / 皮肤 / 金鱼 / 春分 / 集市 / 节日 / 漫海这些**运营活动**，世界宝藏不在其中 |
| `TreasureLootStatsResponse` | 只有 `nextRefreshTime`（下一个整点），没有起止时间 |
| `ModuleOpenCfg` | `世界宝藏` 只有 `playerLevel: 19`（等级门槛） |
| `GameplayOpenCfg` | `世界宝藏: openDays: [3,1,1,1]` —— 这是**开放条件**：S1 第 3 天开、S2 之后第 1 天开，不是结束时间 |
| 客户端 `TreasureLootPop` | 界面上只有一个倒计时，就是「下次刷新」 |
| `SeasonRankInfoResponse` | ✅ `startTime / midEndTime / endTime / midAutoGrantTime / autoGrantTime` |

所以真正的边界是**赛季结束**（世界宝藏属于 `WorldGameplay`，随赛季存在）：

- 赛季一收，世界重置、货轮清空；
- 新赛季前 1 小时连船都派不了（游戏内「合服计划」说明：
  「进入新赛季前的 1 小时内，玩家将不再能操作舰队参与包括但不限于货轮争夺…」）；
- 新赛季按 `GameplayOpenCfg.openDays` 重新开放。

**两个来源互为兜底，且在 S1 上实测完全相等（差 0 秒）**：

```
① SeasonRankInfoResponse.endTime                    = 1794499170 = 2026-11-12 23:59:30
② playerInfo.worldOpenTime(10-20 00:00) + 24 天      = 1794499170 = 2026-11-12 23:59:30
```

- 赛季从 `worldOpenTime` 的**当天零点**算第 1 天，第 N 天最后一秒是 `23:59:30`（不是 59 秒）。
- 赛季天数取 `SeasonTaskCfg` 里该赛季最大的 `lastDay`：S1~S3 = 24、S4~S7 = 45
  （配置包里 `SeasonTaskCfg` / `1_` / `2_` 三份按服不同，全部扫一遍取最大）。
- 赛季号从 `worldId` 编解码：`Math.floor(worldId / 1e6 % 1000)`，`2001014410 → S1`。

**截止时间 = `endTime − 1 小时`**（`SEASON_CLOSE_GUARD_SECONDS = 3600`），因为最后 1 小时派不了船。

实现要点：

- `seasonWindow()` 请求 `SeasonRankInfoRequest` 拿 `endTime`，**进程内按 worldId 缓存 1 小时**
  （这个值一天最多变一次，60 秒一轮问一次纯浪费；按 worldId 分键防多账号串号）。
- 拿不到服务端值就用 `worldOpenTime + lastDay` 复算；两个都算不出来时 `endAt = 0`，
  此时**按「未结束」处理**（`activity.unknown = true`）—— 算不出来不等于活动结束了，
  不能因为一个接口挂了就把功能停掉。
- 过期后 `planTreasure` 直接返回空计划，`formatTreasureSummary` 只印一句：
  `活动已结束（11-12 23:59 赛季收官），自动化停用 —— src/treasure.mjs 这段可以删了`。
  这句话就是给「活动下线后把整块删掉」用的路标。
- 未过期时每轮概览尾部都带 `有效至 11-12 22:59（还剩 433 小时 5 分）`，CLI 的 `treasure` 子命令
  另起一行写全：`活动有效期：S1 · 赛季结束 11-12 23:59 · 派船截止 11-12 22:59（新赛季前 1 小时封盘）`。

**看到的那个状态也顺手修了**：`[被联盟 3 占]` 在自家舰队已经在推的时候也会出现 ——
协议只给联盟**编号**，我们拿不到自己的 `guildIdx`，所以改用舰队上的 `treasureLootUid` 反查：
`我方在途`（还在航行，货轮 `ownerGuildIdx` 仍是 0）/ `我方在占`（已到达，进度在涨）。
2026-10-26 起状态文案补了三种：`可抢（无人占领）` / `可抢（要先打赢联盟 N 的 M 支守军）` /
`等级没勾（只抢 …）` / `我方已占满 10 支`，每轮概览多一段 `抢 万吨货轮` 便于核对当前配置。

#### 12.11.2 每日奖励次数：页面显示 + 「今日没机会」就不再发请求

需求原话：「① 增加每日宝藏奖励次数/已获取次数显示；② 如果今日没机会了，就不用请求了，避免无效请求」。

**数字从哪来**：`TreasureLootStatsResponse{ todayRewardTimes, totalRewardTimes }`（`totalRewardTimes`
是**每日上限**而不是累计，实测 3，与 `TreasureLootParamCfg`「每日宝藏奖励次数」一致）。
一整套探测要打 4 个只读请求（Stats + List + MyFleets + 赛季），只为了看个数字去轮询完全不划算，
所以：

- 挂机每探测一次就把结果写进 `gates.treasure.stats`，服务端再存到 `session.loop.treasureStats`，
  `/api/loop` 原样带出来 —— 页面的「已领 x/N」读的就是这份缓存，**3 秒轮询零新增请求**；
- 手动「立刻抢一次」（`POST /api/treasure/run`）内部会调 `treasure()`，顺手更新同一份缓存；
- 页面刚打开、挂机没跑过时缓存是 `null`，此时补**一次** `GET /api/treasure`（失败则每分钟最多重试一次），
  拿到数就停，之后全走缓存。
- 文案统一由 `rewardCountText()` 生成（`已领 1/3（还能领 2 次）` / `已领 3/3（已满，明天 0 点重置）` /
  `已领 ?/3（拿不到次数，保守不派）`），页面、CLI、日志同一个说法，避免三处各写一套。

**静默窗（`skipUntilOf()`）** 只认三种「确定要到某个时刻才会变」的状态：

| 状态 | 静默到 | 理由 |
|---|---|---|
| 活动已结束（赛季封盘） | 永远（`forever`） | 本季再也没有货轮 |
| 今日奖励已满 `todayRewardTimes >= 上限` | 次日 `00:00:05` | 期间派船必然白烧 500 汽油/支，探测也不会有动作；留 5 秒避开服务端重置的秒级抖动 |
| 勾选等级里一个可抢的都没有 | `nextRefreshTime`（封顶 12 小时） | 进度只会涨、等级不会变、「我方占满 10 支」也要等结算 —— 这段时间结果稳定 |

反例（**故意不静默**）：没空闲舰队、船还在航行/修理、汽油不够、拿不到 `Stats`。
这些都是几分钟内自己会变的，静默掉就会漏掉刷新窗口（整点刷新错过就是当天空手）。

两个实现细节：

- 静默期间**一个请求都不发**（`treasureDue` 直接为 false），日志只每 30 分钟提一句
  `货轮 暂停探测：今日奖励已满 3/3，9 小时 58 分后再试` —— 否则一夜 600 轮会把日志刷满。
  页面上这一行同时显示在「每日宝藏奖励 · 已领 3/3（已满，明天 0 点重置）· 暂停探测，… 后再试」里。
- 「间隔未到」和「暂停探测」是两种原因，`gates.treasure` 用 `throttled` / `skipped` 分开表示，
  混在一起会看不出为什么一直没请求。
- 静默窗封顶 12 小时：`nextRefreshTime` 是服务端给的，22:00 收摊到次日 8:00 正好 10 小时落在上限内；
  万一服务端给了离谱值，也不会把整段挂机静默死。

### 12.12 海兽培育室：收成熟的 + 材料加速 + 队列空位排产

2026-10-26 补的第 8 个自动模块（`src/pet.mjs`，循环里的 `petEnabled` / `petEveryMs`）。
游戏里 UI 叫「海兽培育室」，**配置表里的 `buildingType` 是「宠物培育室」** —— 按 UI 名去找建筑会一个都匹配不上。

| 事实 | 出处 |
|---|---|
| 培育室是普通水上建筑，`BuildingCfg` 有 6 条宠物类：`宠物` / `宠物B` / `宠物C` / `宠物战备室` / `宠物训练营` / `宠物培育室`（`name` = 海兽培育室，`resPath` = building/PetCultivationRoom） | 本地配置表 `BuildingCfg` |
| 培育状态挂在 **`DispWaterBuilding.petBreed`**：`{ breedQ: DispPetBreedJob[], maturePets: MaturePet[], maxQLength }` | `tools/describe.mjs` 扫全表引用：只有 `DispWaterBuilding` 引用了 `PetBreedBuildingInfo` |
| 队列位数以**服务端给的 `maxQLength`** 为准；客户端显示用 `min(level+1, maxBuildLevel)`，并不可靠 | `PetBreedView.open` 的 `_lst_queue.numItems`，以及 `OnWaterResponse` 里每个建筑都带 `petBreed`（没建成的 `maxQLength=0`） |
| 培育出来的星级由 `PetBreedLevelCfg` 的概率表按培育室等级掷 | `PetBreedLevelCfg`：50 行，`level` / `breedExp` / 每个品质一条 10000 分制权重数组（逐项语义未实测，只当展示用） |

**请求**（客户端 `PetBreedView` 的按钮回调里一条条抠出来的）：

| 动作 | 请求 | 回包 | 客户端判据 |
|---|---|---|---|
| 培育一只 | `PetBreedRequest { petId, universal }` | **无**，结果靠 `SCUpdateWaterBuilding` 推送 | `_onBtnBreed`：该队列位为空 + 基因够（`_isLackFrag`）+ 金币够（`isAssetsEnough([cost[1]], true)`） |
| 收成熟 | `GetMaturePetRequest {}` | **无** | `_onBtnReward`：`maturePets.length != 0` 才发，一次全领 |
| 喂食加速（材料加速） | `PetFeedRequest { jobIdx }` | **无**，结果靠 `SCUpdateWaterBuilding` 推送 | `_onBtnFood`：该队列位 `feedRequirements` 够（`isAssetsEnough(_, false)`）才喂；不够会弹「购买补齐」 |
| 升级培育室 | （走建筑升级那套） | | `_onBtnLevelUp` → `toUpgradeBuilding` —— 不做，跟其它建筑一样需要用户自己决定 |

`universal` 是客户端的 `_isAutoExchange`（缺口用「万能基因」补），跟 `MakeEquipRequest.universal` 同一个意思，
**恒发 false** —— 不拿通用材料去补专用材料。

**配方 `PetBreedCfg`**：6 物种 × 4 品质 = 24 行，`petId` 形如「橙宠物3」，`cost = [[基因, 数量], ["GOLD", 金币]]`：

| 品质 | 时长 | 成本 | 备注 |
|---|---|---|---|
| 蓝 | 4 小时 | 80 基因 + 4000 金 | |
| 紫 | 12 小时 | 400 基因 + 20000 金 | |
| 橙 | 36 小时 | 800 基因 + 250000 金 | |
| 红 | 72 小时 | 1200 基因 + 1000000 金 | 标 `season: 2`，常态打不开 |

基因是**该物种专属**的（「宠物3蓝基因」只用于宠物3），攒着没有任何别的用途，所以「有就排」不会浪费。
物种 5 / 6 标 `season: 4/5`，用材料自然过滤（没开赛季就拿不到那些基因）。

**排产策略**（`planPet`）：

1. 有 `maturePets` 先领 —— 整轮只放**一条** `GetMaturePetRequest`（它是空体、一次领全部，不分建筑）；
2. 材料加速（勾选默认开）：逐个队列位判断 `feedRequirements` 够不够，够就排一条 `PetFeedRequest`；
3. 每座培育室按 `maxQLength - breedQ.length` 算空位，空几个排几个；
4. 空位里挑配方：品质从高到低（受 `maxQuality` 上限约束，**默认橙**），同品质按 `spId` 升序；
5. 选中的配方**就地扣减**共享余额表，跨培育室不会把同一批基因算两遍；同一批里同一个 `petId` 只排一次。

`items` 用「品质+物种名」（如「橙声波海豚」）而不是 `petId`，日志里能直接读。
动作 `key` 带序号（`petBreed:<建筑>:<petId>:<序号>`）—— 一次排满多个空位时，如果不带序号，
后面几条会被第一条的失败记录整片挡住。

**材料加速（投喂，2026-10-26 按用户要求加上，页面「材料加速」勾选默认开）**：

界面上它是培育室里的「投喂」按钮，本质就是买时间：

- 请求 `PetFeedRequest{ jobIdx }`，`jobIdx` = `breedQ[].idx`（不是数组下标，是服务端给的队列位编号）。
- 消耗该队列位 `feedRequirements` 里的材料。抓包实测（`OnWaterResponse` 里蓝宠物3 的那个队列位）：
  `鱼肠线×12 + 粗铁×4 + 烤鱼×40`。**不是钻石、不是加速器、不是广告**，是培育材料本身。
- 减多少：`PetUtil.breedSpeedSeconds()` → `PetParamCfg`「投喂减少培育时间」= **14400 秒（4 小时）**/次。
  所以蓝配方（4 小时）喂一次就完事，紫（12h）要 3 次，橙（36h）要 9 次。
- 判据照抄 `_onBtnFood`：`isAssetsEnough(feedRequirements, false)` 才发；不够时客户端会弹「购买补齐」，
  我们**不买**（买东西属于付费决策，交给人），只写一句 `材料不够加速：缺 烤鱼×30`。
- **一轮每个队列位只喂一次**：喂完服务端会刷新 `finishTime`，下一轮按新状态重算；
  协议里既没有冷却字段也没有 Response，连点等于赌服务端的频率限制。
- `step.key` 必须带 `finishTime`（`petFeed:<建筑>:<idx>:<finishTime>`）：喂一次这个值就变，
  固定 key 的话第一次失败会被 `rejected` 永久跳过，之后再也不加速。
- 剩不到 `FEED_MIN_REMAIN_SECONDS`（5 分钟）不喂：材料是真花掉的，省最后几分钟不值；
  已经到点（`done`）的更不喂 —— 那是「收」的阶段。

**另一条安全边界**：`universal` 恒 false、不动钻石、不用加速器、不看广告。

挂机里是第 8 阶段（在锻造之后，复用 `worldSurvey.buildings` / `worldSurvey.stock`，**零额外请求**），
`petEveryMs` 默认 **300 秒**（蓝配方 4 小时、橙 36 小时，看太勤没意义）。计时语义同情报：
**探测成功就计时**。

## 13. 账号、素材与网页控制台

### 13.1 多账号：一条记录 = 一份凭证

- 身份是 `login.eworldParams.openId`。同一个号反复抓包只会刷新那一条的凭证，不会多出一条。
- 存储 `data/accounts.json`（`{version:1, activeId, accounts:[…]}`）。早期只有一个账号时的
  `data/credentials.json` 仍保留，作为迁移来源与备份：`accounts.json` 不存在时 `loadStore()`
  就地合成一条（**只读，不写盘**），第一次真正的写操作才落盘（先写 `.tmp` 再 rename）。
- 选账号的顺序（`pickAccount`）：id → 昵称 → 1 起的序号 → 唯一的 id 前缀或昵称子串，
  撞到多个就报错而不是随便挑一个。CLI 用 `--account` 或 `CW_ACCOUNT`，网页用顶栏下拉与 `?account=`。
- 并发：每个账号一条独立 WebSocket（`Map<accountId, session>`），互不干扰。但**一个账号同时只有一条连接**——
  第二条会话登录会把第一条顶掉（`SCChannelExpired`），所以自动循环要按账号各开一份，不能两个号共用一个会话。
- 凭证是本机明文文件。网页默认打码（头尾各 4 位），必须显式点一次「显示凭证」才返回全文。

### 13.2 抓包搬进控制台（含扫码）

- `tools/mitm-proxy.mjs` 改成工厂 `createProxy({port,onLogin,log})`，CLI 与网页共用一份实现；
  默认端口 **17322**（`CW_PROXY_PORT` 可覆盖）——原来的 17321 与控制台撞车，这是必须修掉的一处。
- `src/capture.mjs` 是网页侧的编排：装 CA → 设 HKCU 代理 → 监听 → 抓到 `LoginRequest` → 入库 → 立刻回滚。
- 系统改动全部限定在当前用户（`certutil -user`、HKCU），只绑 `127.0.0.1`，`stop()` 幂等，
  进程退出钩子兜底；回滚后逐项比对注册表是否真的还原，结果写进页面日志。
  装 CA 与开代理这两步都必须先在页面上确认（勾选 + 3 秒倒计时）。
- 扫码的物理限制：凭证由微信 SDK 在真实游戏会话里生成，外部程序造不出来。所以二维码只负责
  「让微信把游戏在电脑上打开」，凭证仍然靠本机代理抓。优先级：
  `data/qrcode.png`（用户自己放的码）→ 用 `src/vendor/qrcode.mjs` 把官方跳转链接画成二维码 →
  只留手动步骤。`qrInfo()` 返回 `kind: image | svg | link`，三种页面都能显示。
  跳转链接是 `https://servicewechat.com/wxascheme/jump_wxa?url=<encoded weixin://dl/business/?appid=…>`。

### 13.3 素材：用游戏自己的图标

- 白名单 11 个 bundle 从微信缓存镜像到 `work/cdn/art/`（约 49M）：`ui_iconlib` / `ui_iconlib2`
  道具与资源、`ui_herohead` / `ui_herohead2` 英雄头像、`ui_iconequip` 装备、`ui_building` 建筑与工厂、
  `ui_iconaccess` 要塞、`ui_iconchip` 芯片、`ui_iconworker` 工人、`ui_preset`、`ui_chat_iframe`。
  砍掉了 `ui_common`（9.0M，核心图标一个都不落在这里）与 `ui_head_frame`（3.8M，界面不显示）。
- `src/fgui.mjs` 解 FairyGUI 二进制，`src/art.mjs` 把游戏实体翻成图标名，
  索引落在 `work/cdn/art/index.json`（1352 个图标 / 46 张图集页）。
- 实体 → 图标名：道具 `ItemCfg.pic`、资源 `ResourceCfg.pic`、装备 `EquipCfg.icon`、
  工人 `WorkerBaseCfg.icon`、要塞 `WorldFortCfg.icon`。建筑没有 icon 列，用 `resPath` 末段
  （`building/HomeBase` → `HomeBase`）。英雄头像三层兜底：
  `HeroSkinCfg.headId` → `HeadImageCfg.heroId→icon` → 该英雄碎片物品的 `pic`。
- 实测覆盖率：道具 1104/1145、资源 5/5、装备 36/36、英雄头像 51/115（缺的 64 个是 NPC / boss / 技能展示木头人）、
  建筑 53/58、工人 38/50、联盟工事 1/5。查不到就返回 `null`，界面退回中文文字，不编造。
- **旋转贴图**：索引里 209/1352 是转 90 度打包的。图集里占的是 h 宽、w 高（与显示尺寸 w×h 差一个 90 度）。
  这条结论是从游戏自己的引擎代码核出来的——`SpriteFrame._calculateUV` 的旋转分支用
  `(rect.x + rect.height) / texWidth` 算右边界；也用 `work/tmp/crop-icon.mjs` 把像素裁出来看过，
  ARENA 字牌与英雄头像都能摆正。页面渲染的做法：元素盒按 h×w 铺，
  `translate(0, h*k) rotate(-90deg) scale(k)`，这样四个角与引擎给的 UV 一一对应。
- 服务端 `GET /api/art/atlas/<bundle>/<file>` 直接返回 PNG，靠 CSS 裁切，不需要任何图像处理依赖；
  只允许取镜像目录里真实存在的文件（`..`、斜杠、不存在的文件名一律 404）。

### 13.4 网页控制台

- 五个页签：总览 / 挂机 / 英雄 / 日常 / 账号。删掉了五张协议指标卡片、原始 JSON 视图、
  手动发送页签与 `POST /api/send`、常驻的原始协议日志栏；日志只剩中文业务句
  （「领取主线 62 · 拥有指定资源 1200/20」「排产 1切鱼厂 → 生鱼片」这种）。
- 账号页：账号列表（切换/删除/当前标记）、添加账号（二维码 + 一键抓包）、凭证查看。
- 写操作一律要求请求体带 `confirm: true`，页面上表现为「先勾选、再等 3 秒倒计时」两样都满足才能点确认。

## 14. 不做清单：潜水与打捞（**别再改回来**）

**结论：这两个玩法都不做，将来也不做。** 不是还没实现，是设计上排除。

### 14.1 为什么：请求体是「你捡到了什么」的上报体

| 玩法 | 请求 | 关键字段 | 谁填的 |
|---|---|---|---|
| 潜水 | `DivingRequest` | `1 reward: DisplayAssetPackage{ asset: DisplayAsset[] }` | 客户端 `finishDive()` |
| 打捞 | `EndSalvageRequest` | `1 pickedFloaters: repeated DispWaterFloater` | 客户端小游戏内拾取 |

客户端原文（`work/extracted/_subpackages_main_/subpackages/main/game.js`，`s.finishDive`）：

```js
s.finishDive = function (t) {
  for (...this._getResourceMap.entries()) { if (r > 0) s.push({ type: ITEM, id: o, num: r }); }
  if (s.length > 0) {
    var h = W('DivingRequest', { reward: { asset: s } });   // ← 把本局战利品塞进请求体
    I.instance.sendMessage(h, function (i) { null == t || t(i); });
  } else null == t || t();                                   // ← 一件没捡到就根本不发请求
};
```

也就是说：**产出不是服务端算的，是客户端小游戏里一件件捡出来再上报的**。同一段代码里
`pickUpItem()` 还会乘 `water.divingLevel.criticalRate` 算暴击倍率，全在客户端。

`DiveLayoutCfg` 也对得上：40 层里每层 `pickupMin: 0`、`normalBoxProbability: 2000`(20%)、
`safeBoxProbability: 800`(8%) —— 它描述的是**小游戏里那一局的生成规则**，不是「发个请求就随机给你一份」。

### 14.2 实测：发空体只会拿回空奖励

```
2026-10-23T08:27:36.637Z -> [DivingRequest] seq=5402 24B
2026-10-23T08:27:36.702Z <- [DivingResponse] seq=96619 {"reward":{"asset":[]}}
```

请求成功、服务端不报错，但奖励是空的 —— 因为它如实理解了「你上报 0 件」。
界面上的那句「潜水 1 次：没有回报」就是这个。

### 14.3 为什么这就不能做了

想拿到东西只有一条路：**编一份 `asset` 清单发过去**。那就是往服务端谎报战利品，
与打捞的 `pickedFloaters` 完全同源，属于作弊 —— 本项目从第一版起就把这类动作列在
「安全边界」之外（见第 8 节、README「安全边界」）。伪造成本极低、收益为零、风险最大，没有讨论空间。

### 14.4 历史教训（写给以后的自己）

- 2026-10-22 曾实现过「自动潜水」：当时只看 `describe.mjs` 的字段表，把
  `reward` 误判成「回显字段」，结论写成「`DivingRequest` 是空体，一次请求一次下潜，服务端按层概率随机」，
  还配套做了 `key: diving:日期:N` 的跨天去重、`maxDivings`、`summarizeDiving` 一整套。
- 2026-10-23 实跑发现每轮都是「潜水 1 次：没有回报」，回头读客户端 `finishDive` 才定位到上面的真相，
  当天把功能全部移除（`actions.mjs` / `world.mjs` / `loop.mjs` / `server.mjs` / `page.mjs` / `app.mjs`）。
- **教训**：`describe.mjs` 只能告诉你「字段叫什么、什么类型」，**告诉不了你「谁填、什么语义」**。
  凡是 `*Request` 里出现奖励/战利品形状的字段（`reward`、`asset`、`picked*`、`items`），
  必须回客户端找到**发送点**，看它是常量、回显，还是把本地状态填进去。

### 14.5 防回归

`src/selftest.mjs` 有一组断言专门守这件事：即使按老参数调用
`planWorld(survey, { diving: true, maxDivings: 3 })`，也不许出现
`kind: 'diving'` / `DivingRequest` / `BeginSalvageRequest` / `EndSalvageRequest`。
**要动这组断言，先读完本节。**

