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
窗口内没动静即成功），`GameClient.attributePrompt()` 按上面的顺序规则认领。

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
5 秒内该队列项消失并出现在 `finishedProducts` —— 即这条请求一次只产 1 件且**即时完成**，
`BuildingProduceCfg.produceTime`（90/300 秒）在界面上是倒计时展示，不是这条请求的等待时间。
所以循环里每轮「收成品 + 排产」是正常的一进一出，不是重复发同一个请求：
只有当队列里已经有同一个 `productId` 时计划器才会跳过（此时它会去挑别的配方）。

实测（制造位是**串行**的，2026-10-23 做工厂页时确认）：`factoryQ` 里**只有队首带 `finishTime`**，
后面的排队项 `finishTime` 是 `0` —— 实测 `1食品厂` 排了 6 个「刺身拼盘」，只有第 1 项有完成时间，
`1服装厂` 的 5 项里同样只有队首有。所以：

- `finishTime = 0` 要读成**排队中**，不能当成「已完成」，否则六个格子会一起亮成「可收取」；
- 队首的 `finishTime - now` 才是真实剩余秒数（实测 499 → 392 → 379 递减），
  `BuildingProduceCfg.produceTime` 是这条配方的总时长，两个值不相等是正常的；
- **同一配方可以重复排队**（6 个刺身拼盘就是证据），工厂页只标注「队列×N」，不阻止用户继续排；
- 制造位上限（6）是队列长度上限，不是并行数。

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
  `POST /api/loop/start`（重复开启报「循环已经在跑」，缺 `confirm` 报「需要确认才会开自动循环」）、
  `GET /api/loop`、`POST /api/loop/stop`（停止后 `running` 翻回 false）。

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

**建造与升级是两个请求。** 客户端 `_toBuildOrUpgradeRequest` 的分支是
`0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`，判据是
`BuildingUpgradeCfg` 的 level 1 行（49 种建筑这一行全是 `costTime:0 / consume:[] / condition:[]`，
只卡 `playerLevel`）。计划器里的两个陷阱：

1. `level === 0` 且 `buildFinishTime` 在**将来** = 正在盖，重发只会被拒，跳过；
2. `level === 0` 且 `buildFinishTime` **已过** = 本轮要先发 `FinishUpgradeBuildingRequest`，
   收尾后它已经是 level 1，同一轮**不能再排建造**（`planWorld` 用 `finishing` 集合挡掉）。

材料不齐时客户端会先弹「用钻石补」，本工具不这么做，记一笔
「建造材料不足（X a/b），不买材料，等下一轮」；等级不够也记明「建造要等级 N，当前 M，先推主线」。

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

