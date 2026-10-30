// 国战（联盟攻城）：每天 20:00–21:00 一场，联盟最多宣战 3 座相邻城，成员把舰队派过去打。
//
// ---- 这个模块只做一件事：把闲置舰队「搬到」联盟今天宣战的那几座城 ----
// 不需要自己写战斗逻辑，也不需要战期内反复派兵。客户端配置表 `TipsDescCfg.舰队委任` 的原话是
// 「开启舰队委任后，城战期间会自动派出队伍进攻宣战城市」，而舰队进城后在 `CityDefenceResponse`
// 里就直接算守军/攻方的一员，战期内由服务端排进战斗点。2026-10-28 实盘验证：
//   19:52 发一次 `MoveFleetsToCityRequest{buildingId:['2远征船'],cityId:73}`
//   → state 立刻 MOVING，20:00 到达，21:48 复查仍然 `IDLE / cityId=73`，
//   并且出现在城 73 的守军名单里；联盟 3 个宣战城（68/73/74）全部占领。
// 所以本模块的动作只有两类：`MoveFleetsToCityRequest`（派兵）与 `RepairFleetRequest`（修船）。
//
// ---- 协议（全部在 proto bundle 里，已用实盘回包核对字段名）----
//   GuildInfoRequest {}            -> GuildInfoResponse { guild{guildId,name,level,memberCount}, myTitle }
//   WarDeclarationRequest {}       -> WarDeclarationResponse { declarations[WarDeclaration], startTime, endTime, assembleCityId }
//     WarDeclaration { attackGuildIdx, defenceGuildIdx, cityId }   —— **idx 不是 guildId**
//   MyFleetsRequest {}             -> MyFleetsResponse { fleets[WorldFleet] }
//     WorldFleet { buildingId, state, cityId, targetCityId, durability, maxDura, power, repairing, autoFight{isOn,todayTimes} }
//   CityDefenceRequest { cityId }  -> CityDefenceResponse { fleets[DefenceFleetInfo] }
//     DefenceFleetInfo { name, guildIdx, avatar, power, multiple, isNpc }   （守军，含我方派去的船）
//   GuildCityInfoRequest {}        -> GuildCityInfoResponse { cities[DispGuildCity{cityId,recommended,defenceNum,fort}] }
//   MoveFleetsToCityRequest { buildingId: repeated string, cityId }   **无 Response** → 走 sendWatch
//   RepairFleetRequest      { buildingId }                            **无 Response**
//   FleetRepairParamRequest { buildingId } -> FleetRepairParamResponse { unitRepairTime, unitRepairCost }
//
// ---- 三个必须知道的坑 ----
// 1. **联盟身份是 idx 不是 guildId**：客户端 `guildIndex(e) = e % 1000`。我们 guildId
//    `2001014410003` → idx **3**，所以只有 `attackGuildIdx === 3` 的那几条宣战才是我们联盟的战场。
//    直接拿 guildId 去比永远对不上，会把别的联盟的城当成自己的去打（白烧汽油）。
// 2. **宣战权限**：客户端 `isDeclare(title) = title===PRESIDENT(5) || title===VICE_PRESIDENT(4)`。
//    本模块**不宣战**（脚本账号是普通成员，而且取消宣战要 200 钻石，属于禁区）——
//    只跟随联盟已经宣好的城。
// 3. **汽油按「出生城 → 目标城」算，不是按舰队当前位置**：客户端
//    `getAttackCityPetrolCost(bornCityId(), targetCityId)`，距离 = 两座城格子中心的像素欧氏距离，
//    单价查 `AttackCityConsumeCfg`（<6000 像素 0.4，之后每 2400 像素 +0.1），花费 = `ceil(单价 × 距离)`。
//
// ---- 安全边界 ----
// 不宣战、不取消宣战（200 钻石）、不募兵（CityRecruitDefenceRequest 是防守方道具）、
// 不花钻石加速维修。派兵与修船只消耗「汽油」，且派兵前先校验汽油够不够（默认留 2 万备用）。
import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, loadMapAsset } from './world.mjs';
import { bigNum } from './guildShip.mjs';

// 舰队状态（客户端 FleetState）：1 空闲 / 2 行军 / 3 战斗 / 4 维修 / 5 排队。
export const CW_STATE_IDLE = 1;
export const CW_STATE_MOVING = 2;
export const CW_STATE_TEXT = { 1: '空闲', 2: '行军', 3: '战斗', 4: '维修', 5: '排队' };

// 联盟职位（DispGuildDetail.myTitle）：4 副盟主 / 5 盟主 才有宣战权。
export const CW_TITLE_TEXT = { 1: '黑名单', 2: '成员', 3: '精英', 4: '副盟主', 5: '盟主' };
export const CW_DECLARE_TITLE = new Set([4, 5]);
// 联盟同时宣战上限（客户端 MAX_DECLARE_CITIES）。
export const CW_MAX_DECLARE = 3;

export const DURABY_ITEM = '汽油';
// 战前提前多久布署。10 分钟够修一次船（2000 耐久约 5 分钟）+ 走完一段行军。
export const DEFAULT_CW_PREP_LEAD_SEC = 600;
// 耐久低于 80% 就修：`LoadingTipsCfg` 原话「城战中舰船耐久度低于 1600 会降低输出、增加受到的伤害」
// （本账号 maxDura=2000 → 1600/2000 = 80%）。
export const DEFAULT_CW_REPAIR_BELOW = 0.8;
// 派兵的最低战力比：0 = 不拦（进城就能参与战斗点，打不过也拿功勋）。
// 设成 1.2 之类会让「守军看着比我们强」的城一个兵都不派，反而错过占领。
export const DEFAULT_CW_MIN_POWER_RATIO = 0;
// 派兵后至少留这么多汽油，别把修理/回程的余量烧光。
export const DEFAULT_CW_PETROL_RESERVE = 20_000;
// 每座城最多派几艘（同一座城排队上限远大于此，这里只是防止全压一城）。
export const DEFAULT_CW_MAX_FLEETS_PER_CITY = 3;

const num = (v) => Number(v ?? 0) || 0;

// guildId → 世界里的联盟下标（客户端 guildIndex(e)=e%1e3）。
export function guildIndex(guildId) {
  const id = bigNum(guildId);
  if (!(id > 0)) return 0;
  return ((id % 1000) + 1000) % 1000;
}

// 本国（我方 idx）的出生城 —— 派兵汽油按这座城算距离，不是按舰队所在城。
export function bornCityOf(config, myIdx) {
  const row = rowsOf(config, 'CityCfg').find((r) => num(r.guildIndex) === num(myIdx));
  if (!row) return null;
  return { cityId: num(row.id), name: String(row.name ?? '') };
}

export function cityNameOf(config, cityId) {
  const row = rowsOf(config, 'CityCfg').find((r) => num(r.id) === num(cityId));
  return row ? String(row.name ?? `城${cityId}`) : `城${cityId}`;
}

// 格子下标 → 像素坐标。照抄客户端 `coordToPosition`：
//   x = row%2===0 ? col*tileWidth + tileWidth/2 : (col+1)*tileWidth
//   y = -(row+1)*tileHeight/2 - tileHeight/2        （客户端还减了 mapSize.height，常数项不影响距离）
function tilePosition(gridIdx, map) {
  const w = num(map?.width);
  const tw = num(map?.tileWidth);
  const th = num(map?.tileHeight);
  if (!(w > 0) || !(tw > 0) || !(th > 0)) return null;
  const col = gridIdx % w;
  const row = Math.floor(gridIdx / w);
  const x = row % 2 === 0 ? col * tw + tw / 2 : (col + 1) * tw;
  const y = -((row + 1) * th) / 2 - th / 2;
  return { x, y };
}

// 两座城之间的像素距离（客户端 worldMap.calCityDistance）。地图没下载就返回 null。
export function cityDistance(map, fromCityId, toCityId) {
  if (!map?.cityInfo) return null;
  const a = map.cityInfo[String(fromCityId)];
  const b = map.cityInfo[String(toCityId)];
  if (!a || !b) return null;
  const p1 = tilePosition(num(a.gridIdx), map);
  const p2 = tilePosition(num(b.gridIdx), map);
  if (!p1 || !p2) return null;
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// 攻城汽油单价（客户端 getAttackCityPetrolCostUnit 同款、同样带 bug 兼容）：
// 从第一档开始，`dist < row.dist` 就 break，否则取该档 cost。
export function attackPetrolUnit(config, dist) {
  const rows = rowsOf(config, 'AttackCityConsumeCfg');
  if (!rows.length) return 0.4;
  let unit = num(rows[0].cost) || 0.4;
  for (const row of rows) {
    if (dist < num(row.dist)) break;
    unit = num(row.cost) || unit;
  }
  return unit;
}

// 派兵要烧多少汽油。距离未知（没地图）时返回 null，调用方据此降级。
export function attackPetrolCost(config, map, fromCityId, toCityId) {
  const dist = cityDistance(map, fromCityId, toCityId);
  if (dist == null) return null;
  return Math.ceil(attackPetrolUnit(config, dist) * dist);
}

// 战期阶段：waiting（还没到布署时间）/ prep（战前布署窗）/ live（战中）/ unknown（不知道战期）。
//
// ⚠ 必须先把窗口「滚动到当前这场」，否则跨天以后必错：
// 服务端只在 0 点推一次 `SCCityWarTime`，而 `WarDeclarationResponse.startTime/endTime` 实测会
// **停在上一场**（2026-10-28 22:40 复查：战期仍是当天 20:00–21:00，但宣战列表已经是新一场的城 86）。
// 如果直接拿它跟 now 比，明天 19:50 会被判成「今日已结束」→ 睡一整天 → 整场国战错过。
// 战期是每天同一时刻，所以按 86400 秒整日往前滚，滚到今天/下一场为止。
export function rollWarWindow(startAt, endAt, nowSec) {
  let start = num(startAt);
  let end = num(endAt);
  if (!(start > 0) || !(end > start)) return { startAt: start, endAt: end, days: 0 };
  const now = num(nowSec);
  let days = 0;
  while (end <= now && days < 400) {
    start += 86_400;
    end += 86_400;
    days += 1;
  }
  return { startAt: start, endAt: end, days };
}

export function phaseOf(startAt, endAt, nowSec, prepLead = DEFAULT_CW_PREP_LEAD_SEC) {
  const { startAt: start, endAt: end } = rollWarWindow(startAt, endAt, nowSec);
  const now = num(nowSec);
  if (start <= 0 || end <= 0) return 'unknown';
  if (now > end) return 'done';
  if (now >= start) return 'live';
  if (now >= start - num(prepLead)) return 'prep';
  return 'waiting';
}

// 下一场战期的开始时刻（秒）。loop 用它算「睡到什么时候」。
export function nextWarStartAt(startAt, endAt, nowSec) {
  return rollWarWindow(startAt, endAt, nowSec).startAt;
}

// 舰队一条的归一化。`repairing` 有值 = 正在修，别再发 RepairFleetRequest。
function toFleet(raw) {
  const maxDura = assetCount(raw?.maxDura) || 0;
  const durability = assetCount(raw?.durability);
  return {
    buildingId: String(raw?.buildingId ?? ''),
    state: num(raw?.state),
    cityId: num(raw?.cityId),
    targetCityId: num(raw?.targetCityId),
    power: assetCount(raw?.power),
    durability,
    maxDurability: maxDura,
    duraPct: maxDura > 0 ? durability / maxDura : 1,
    repairing: raw?.repairing
      ? { startTs: num(raw.repairing.startTs), endTs: num(raw.repairing.endTs), endDura: assetCount(raw.repairing.endDura) }
      : null,
    autoFight: raw?.autoFight?.isOn === true,
    todayFightTimes: num(raw?.autoFight?.todayTimes),
  };
}

// 守军一条。⚠ `multiple` 不是战力倍率：客户端 DefenseTroopPop 里它是
// `_lbl_name.text = cityDefenseName(cityId) + " x" + multiple`，也就是「城防兵 x1000」的**单位数**，
// 战力单独显示 `power`。按 power×multiple 算会把守军放大 1000 倍（实测城 86：power 370000、multiple 1000），
// 于是一个兵都派不出去。所以总战力只用 power 求和，multiple 只作为「兵力几队」参考。
function toDefence(raw) {
  return {
    name: String(raw?.name ?? ''),
    guildIdx: num(raw?.guildIdx),
    power: assetCount(raw?.power),
    units: Math.max(1, num(raw?.multiple) || 1),
    isNpc: raw?.isNpc === true,
  };
}

export async function surveyCityWar(client, protocol, {
  config = null,
  stock = null,
  player = null,
  timeout = 10_000,
  prepLead = DEFAULT_CW_PREP_LEAD_SEC,
  repairBelow = DEFAULT_CW_REPAIR_BELOW,
  now = Date.now(),
  // force：即使不在布署窗也把守军查出来（只读，用于白天摸清目标强弱）。
  force = false,
} = {}) {
  const get = async (name, body = {}) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, body, responseName, timeout));
    } catch {
      return null;
    }
  };

  const [guildInfo, warDecl, fleetList, itemList] = await Promise.all([
    get('GuildInfoRequest'),
    get('WarDeclarationRequest'),
    get('MyFleetsRequest'),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
  ]);
  if (!warDecl) throw new Error('拿不到 WarDeclarationResponse，读不了国战状态');

  const bag = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bag.set(id, (bag.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
  }

  const myGuildId = bigNum(player?.guildId) || bigNum(guildInfo?.guild?.guildId);
  const myIdx = guildIndex(myGuildId);
  const myTitle = num(guildInfo?.myTitle);

  const nowSec = Math.floor(now / 1000);
  // 把服务端给的（可能停在上一场的）窗口滚动到当前/下一场，见 rollWarWindow 注释。
  const rawStart = num(warDecl.startTime);
  const rawEnd = num(warDecl.endTime);
  const rolled = rollWarWindow(rawStart, rawEnd, nowSec);
  const startAt = rolled.startAt;
  const endAt = rolled.endAt;
  const phase = phaseOf(rawStart, rawEnd, nowSec, prepLead);
  // 「要不要查守军/修船参数」跟 phase 不完全一样：--force / 手动查看时即使不在窗内也想看。
  const active = phase === 'prep' || phase === 'live' || force === true;

  const declarations = (warDecl.declarations ?? [])
    .map((raw) => ({
      cityId: num(raw?.cityId),
      attackIdx: num(raw?.attackGuildIdx),
      defenceIdx: num(raw?.defenceGuildIdx),
      // 我们在进攻 / 我们在防守。两者的「守军」含义不同，view 里分开算。
      attacking: myIdx > 0 && num(raw?.attackGuildIdx) === myIdx,
      defending: myIdx > 0 && num(raw?.defenceGuildIdx) === myIdx,
    }))
    .filter((row) => row.cityId > 0);
  const ours = declarations.filter((row) => row.attacking || row.defending);

  const fleets = (fleetList?.fleets ?? []).map(toFleet).filter((fleet) => fleet.buildingId);

  // 守军只在「布署窗/战中」且有我们参与的城才查：每个城一条请求，平时查纯属浪费。
  const defence = new Map();
  if (active && ours.length > 0 && protocol.CityDefenceRequest && protocol.CityDefenceResponse) {
    await Promise.all(ours.map(async (decl) => {
      const res = await get('CityDefenceRequest', { cityId: decl.cityId });
      if (!res) return;
      const list = (res.fleets ?? []).map(toDefence).filter((row) => row.name || row.power > 0);
      defence.set(decl.cityId, {
        count: list.length,
        npcCount: list.filter((row) => row.isNpc).length,
        playerCount: list.filter((row) => !row.isNpc).length,
        // 总战力 = Σ power（**不乘 multiple**，见 toDefence 注释）。
        totalPower: list.reduce((sum, row) => sum + row.power, 0),
        totalUnits: list.reduce((sum, row) => sum + row.units, 0),
        fleets: list,
      });
    }));
  }

  // 修船参数只给「现在真能修」的船查（空闲 + 没在修 + 耐久低于阈值）。
  const repairParams = new Map();
  const wantRepair = fleets.filter((fleet) => fleet.state === CW_STATE_IDLE
    && !fleet.repairing
    && fleet.maxDurability > 0
    && fleet.duraPct < Math.min(1, num(repairBelow) || 0));
  if (active && wantRepair.length > 0 && protocol.FleetRepairParamRequest && protocol.FleetRepairParamResponse) {
    await Promise.all(wantRepair.map(async (fleet) => {
      const res = await get('FleetRepairParamRequest', { buildingId: fleet.buildingId });
      if (!res) return;
      repairParams.set(fleet.buildingId, {
        unitRepairTime: num(res.unitRepairTime),
        unitRepairCost: num(res.unitRepairCost),
      });
    }));
  }

  return {
    now,
    nowSec,
    phase,
    startAt,
    endAt,
    // 滚动了几整天（0 = 这场就是服务端给的那一场，1+ = 回包还停在几天前）。
    rolledDays: rolled.days,
    rawStart,
    rawEnd,
    assembleCityId: num(warDecl.assembleCityId),
    myGuildId,
    myIdx,
    myTitle,
    declarations,
    ours,
    fleets,
    defence,
    repairParams,
    petrol: bag.get(DURABY_ITEM) ?? 0,
    stock: bag,
    repairBelow,
    prepLead,
    config,
  };
}

// 视图：把「今天打哪几座城、每座守军多强、我每艘船在哪、派过去要烧多少汽油」摊平。
export function viewCityWar(survey, { config = null, player = null, now = Date.now(), minPowerRatio = DEFAULT_CW_MIN_POWER_RATIO } = {}) {
  const cfg = config ?? survey.config;
  const nowSec = Math.floor(now / 1000);
  const startAt = num(survey.startAt);
  const endAt = num(survey.endAt);
  const phase = phaseOf(startAt, endAt, nowSec, survey.prepLead ?? DEFAULT_CW_PREP_LEAD_SEC);
  const scenarioId = num(player?.scenarioId) || 1;
  const map = loadMapAsset(scenarioId);
  const born = bornCityOf(cfg, survey.myIdx);

  const targets = survey.ours.map((decl) => {
    const def = survey.defence.get(decl.cityId) ?? null;
    const defencePower = def ? def.totalPower : 0;
    const cost = born ? attackPetrolCost(cfg, map, born.cityId, decl.cityId) : null;
    return {
      cityId: decl.cityId,
      name: cityNameOf(cfg, decl.cityId),
      kind: decl.attacking ? 'attack' : 'defend',
      defencePower,
      defenceCount: def ? def.count : 0,
      defenceNpc: def ? def.npcCount : 0,
      // 兵力队数（客户端那条「城防兵 x1000」），只做展示，不参与战力比较。
      defenceUnits: def ? def.totalUnits : 0,
      defenceKnown: def != null,
      petrolCost: cost,
    };
  });

  const fleets = survey.fleets.map((fleet) => ({
    ...fleet,
    atTargetCity: targets.some((t) => t.cityId === fleet.cityId),
    movingToTargetCity: fleet.state === CW_STATE_MOVING && targets.some((t) => t.cityId === fleet.targetCityId),
    needsRepair: fleet.state === CW_STATE_IDLE && !fleet.repairing && fleet.maxDurability > 0
      && fleet.duraPct < Math.min(1, num(survey.repairBelow) || 0),
  }));

  return {
    now,
    phase,
    startAt,
    endAt,
    rolledDays: num(survey.rolledDays),
    secondsToStart: startAt > nowSec ? startAt - nowSec : 0,
    secondsToEnd: endAt > nowSec ? endAt - nowSec : 0,
    myIdx: survey.myIdx,
    myTitle: survey.myTitle,
    canDeclare: CW_DECLARE_TITLE.has(survey.myTitle),
    assembleCityId: survey.assembleCityId,
    assembleCityName: survey.assembleCityId ? cityNameOf(cfg, survey.assembleCityId) : '',
    bornCity: born,
    mapKnown: map != null,
    targets,
    fleets,
    idleFleets: fleets.filter((f) => f.state === CW_STATE_IDLE),
    petrol: survey.petrol,
    repairParams: survey.repairParams,
    repairBelow: survey.repairBelow,
    minPowerRatio: num(minPowerRatio) || 0,
  };
}

// 计划器：先修船（耐久低于阈值、且闲着），再派兵（挑守军弱的城，每城最多 N 艘）。
// 只返回「现在真该发」的请求；没到布署窗/没有宣战城时返回空计划 + 一句原因。
export function planCityWar(view, {
  repair = true,
  minPowerRatio = view.minPowerRatio ?? DEFAULT_CW_MIN_POWER_RATIO,
  petrolReserve = DEFAULT_CW_PETROL_RESERVE,
  maxFleetsPerCity = DEFAULT_CW_MAX_FLEETS_PER_CITY,
} = {}) {
  const actions = [];
  const notes = [];
  if (view.phase !== 'prep' && view.phase !== 'live') {
    return { actions, notes };
  }
  if (view.targets.length === 0) {
    notes.push('联盟今天没有宣战城市（宣战要盟主/副盟主，脚本不代宣）');
    return { actions, notes };
  }
  if (view.fleets.length === 0) {
    notes.push('一艘舰队都没有，国战派不了兵');
    return { actions, notes };
  }
  if (view.mapKnown === false) {
    notes.push('没有本地地图资源，算不出派兵汽油（先跑 node tools/fetch-map.mjs）');
  }

  let petrolLeft = num(view.petrol);
  // 这一轮已经排了维修的船：修船会把它置成 REPAIRING，同一轮再派兵必被拒（客户端也不允许）。
  const repairing = new Set();

  // ---- 1. 修船 ----
  // 客户端硬规则：只有 IDLE 能修（航行/战斗中发 RepairFleetRequest 会被拒），修是「修满」。
  if (repair) {
    for (const fleet of view.fleets) {
      if (!fleet.needsRepair) continue;
      const params = view.repairParams?.get?.(fleet.buildingId);
      if (!params) continue;
      const gap = Math.max(0, fleet.maxDurability - fleet.durability);
      const cost = Math.ceil(gap * (num(params.unitRepairCost) || 0));
      if (petrolLeft - cost < num(petrolReserve)) {
        notes.push(`${fleet.buildingId} 耐久 ${fleet.durability}/${fleet.maxDurability} 该修，但要 ${cost} 汽油，留备用后不够`);
        continue;
      }
      petrolLeft -= cost;
      repairing.add(fleet.buildingId);
      const minutes = Math.ceil((gap * (num(params.unitRepairTime) || 0)) / 60);
      actions.push({
        kind: 'cityWarRepair',
        request: 'RepairFleetRequest',
        body: { buildingId: fleet.buildingId },
        key: `cityWarRepair:${fleet.buildingId}:${Math.round(fleet.durability)}`,
        // 修完耐久变满，key 里带耐久度 → 下次真的要修时是新 key，不会被上一轮的失败永久拉黑。
        transient: true,
        group: `cityWarRepair:${fleet.buildingId}`,
        label: `修 ${fleet.buildingId}（${fleet.durability}→${fleet.maxDurability}，`
          + `${cost} 汽油，约 ${minutes} 分钟）`,
      });
    }
  }

  // ---- 2. 派兵 ----
  // 目标顺序：能打的先打「守军最弱」的（攻下的概率高），守城排后面。
  const targets = view.targets
    .slice()
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'attack' ? -1 : 1)
      || (a.defencePower - b.defencePower)
      || (a.cityId - b.cityId));
  const assigned = new Map();
  // 已经在目标城 / 正在去目标城的船占掉名额，避免同一座城被反复派。
  for (const fleet of view.fleets) {
    if (fleet.state === CW_STATE_IDLE && fleet.cityId) {
      const hit = targets.find((t) => t.cityId === fleet.cityId);
      if (hit) assigned.set(hit.cityId, (assigned.get(hit.cityId) ?? 0) + 1);
    } else if (fleet.state === CW_STATE_MOVING && fleet.targetCityId) {
      const hit = targets.find((t) => t.cityId === fleet.targetCityId);
      if (hit) assigned.set(hit.cityId, (assigned.get(hit.cityId) ?? 0) + 1);
    }
  }

  const idle = view.fleets
    .filter((fleet) => fleet.state === CW_STATE_IDLE && !fleet.repairing && !repairing.has(fleet.buildingId) && fleet.durability > 0)
    .sort((a, b) => b.power - a.power);

  let underpowered = 0;
  let noFuel = 0;
  let weaker = 0;
  for (const fleet of idle) {
    // 已经在某座目标城里 → 驻守中，不用动。
    if (targets.some((t) => t.cityId === fleet.cityId)) continue;
    // 开了委任的船由服务端托管，别抢它的控制权。
    if (fleet.autoFight) continue;

    const pick = targets.find((t) => (assigned.get(t.cityId) ?? 0) < num(maxFleetsPerCity)
      // 战力闸：守军已知且配了比例才拦（默认 0 = 不拦）。
      && (num(minPowerRatio) <= 0 || t.defencePower <= 0 || fleet.power >= t.defencePower * num(minPowerRatio))
      && (t.petrolCost == null || petrolLeft - t.petrolCost >= num(petrolReserve)));
    if (!pick) {
      // 分不清是「名额满了 / 战力不够 / 汽油不够」，逐条给个准话。
      const anySlot = targets.some((t) => (assigned.get(t.cityId) ?? 0) < num(maxFleetsPerCity));
      if (!anySlot) notes.push(`${fleet.buildingId} 没派：每座城都够 ${maxFleetsPerCity} 艘了`);
      else if (targets.some((t) => (assigned.get(t.cityId) ?? 0) < num(maxFleetsPerCity)
        && num(minPowerRatio) > 0 && t.defencePower > 0 && fleet.power < t.defencePower * num(minPowerRatio))) {
        underpowered += 1;
      } else {
        noFuel += 1;
      }
      continue;
    }
    const cost = pick.petrolCost ?? 0;
    petrolLeft -= cost;
    assigned.set(pick.cityId, (assigned.get(pick.cityId) ?? 0) + 1);
    // 战力比守军低也照派（进城就能拿战斗点），但要在日志里说一句，免得以为是稳赢。
    if (pick.defenceKnown && pick.defencePower > 0 && fleet.power < pick.defencePower) weaker += 1;
    actions.push({
      kind: 'cityWarMove',
      request: 'MoveFleetsToCityRequest',
      body: { buildingId: [fleet.buildingId], cityId: pick.cityId },
      key: `cityWarMove:${fleet.buildingId}:${pick.cityId}`,
      // 舰队状态每轮都在变（刚打完/刚回来），单次被拒不该永久拉黑。
      transient: true,
      group: `cityWarMove:${fleet.buildingId}`,
      label: `派 ${fleet.buildingId} → ${pick.name}(${pick.cityId})`
        + `${pick.kind === 'defend' ? ' 守城' : ' 攻城'}`
        + `（战力 ${fleet.power} vs ${pick.defenceKnown ? `守军 ${pick.defencePower}` : '守军未知'}`
        + `，约 ${cost} 汽油，耐久 ${fleet.durability}/${fleet.maxDurability}）`,
    });
  }

  if (underpowered > 0) notes.push(`${underpowered} 艘战力不够（守军 × ${minPowerRatio}），留在港里`);
  if (noFuel > 0) notes.push(`${noFuel} 艘没派：汽油不够（留 ${petrolReserve} 备用后连单程都付不起）`);
  if (weaker > 0) notes.push(`${weaker} 艘战力低于守军总战力，派出去大概率打不动（要拦就设战力余量 >0）`);
  // 一艘都没派、也没有任何解释 → 说明船本来就都在目标城（或全被委任托管），说清楚免得看成没生效。
  if (actions.length === 0 && notes.length === 0) {
    const atTarget = view.fleets.filter((f) => targets.some((t) => t.cityId === f.cityId)).length;
    const appointed = view.fleets.filter((f) => f.autoFight).length;
    const bits = [];
    if (atTarget > 0) bits.push(`${atTarget} 艘已在目标城`);
    if (appointed > 0) bits.push(`${appointed} 艘由舰队委任托管`);
    notes.push(bits.length > 0 ? `无需派兵：${bits.join('，')}` : '没有可派的空闲舰队');
  }
  return { actions, notes };
}

function hhmm(sec) {
  const n = num(sec);
  if (!n) return '—';
  const d = new Date(n * 1000);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 战期文案：同一天就只写一次日期（国战每天固定 20:00–21:00，写两遍日期反而占地方）。
function windowText(startAt, endAt) {
  const s = new Date(num(startAt) * 1000);
  const e = new Date(num(endAt) * 1000);
  const p = (v) => String(v).padStart(2, '0');
  const clock = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (s.toDateString() === e.toDateString()) {
    return `${s.getMonth() + 1}/${s.getDate()} ${clock(s)}–${clock(e)}`;
  }
  return `${hhmm(startAt)}–${hhmm(endAt)}`;
}

const PHASE_TEXT = {
  waiting: '未到布署时间',
  prep: '战前布署',
  live: '战期中',
  done: '今日已结束',
  unknown: '战期未知',
};

const fmtPower = (n) => {
  const v = num(n);
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(2)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(v);
};

// 一行概览。用「战期 20:00–21:00 · 战前布署 · 我方宣战 3 城 · 舰队 1/2 空闲 · 汽油 67.6万」
export function formatCityWarSummary(view) {
  const parts = [];
  parts.push(`战期 ${windowText(view.startAt, view.endAt)}`);
  parts.push(PHASE_TEXT[view.phase] ?? view.phase);
  const attacking = view.targets.filter((t) => t.kind === 'attack').length;
  const defending = view.targets.length - attacking;
  parts.push(`我方 ${attacking} 攻${defending ? ` ${defending} 守` : ''}`);
  if (view.targets.length > 0) {
    const weakest = view.targets.slice().sort((a, b) => a.defencePower - b.defencePower)[0];
    parts.push(`最弱 ${weakest.name}(${weakest.cityId}) 守军 ${weakest.defenceKnown ? fmtPower(weakest.defencePower) : '未知'}`);
  }
  parts.push(`舰队 ${view.idleFleets.length}/${view.fleets.length} 空闲`);
  parts.push(`汽油 ${view.petrol}`);
  return parts.join(' · ');
}

// 明细里「派了哪几艘、修了哪几艘」由 detailLines 按 kind 聚合，这里只补一句战况提示。
export function formatCityWarGain(results) {
  const failed = (results ?? []).filter((entry) => entry.ok === false && !entry.skipped);
  if (failed.length === 0) return '';
  return `失败 ${failed.length} 条：${failed[0].error ?? ''}`;
}

// ---- 战期内的轮询节奏 ----
//
// 舰队一波打完是「服务端送回后方城 → 修满 → 再派」，一轮完整循环实测 9–10 分钟
// （10/29：20:01 派 → 20:03 交战 → 20:04 回城 85 → 20:08 修满 → 20:10 再派）。
// 原来统一 180 秒的间隔下，每波要白等最多 3 分钟；一场只有 1 小时（≈6 波），
// 等于白丢 10 分钟以上 —— 少打整整一波。
//
// 抽成纯函数是为了能单测：loop 里那段同时在算 skip / gate / 退避，改动容易互相踩。
export const CW_LIVE_MIN_MS = 30_000;
export const CW_LIVE_DEFAULT_MS = 60_000;

export function warPollInterval(baseMs, liveMs, window, nowSec) {
  const base = Math.max(0, num(baseMs));
  const live = Math.max(CW_LIVE_MIN_MS, num(liveMs) || CW_LIVE_DEFAULT_MS);
  const inWindow = window != null
    && num(window.startAt) > 0
    && num(nowSec) >= num(window.startAt)
    && num(nowSec) <= num(window.endAt);
  if (!inWindow) return base;
  // 取 min：用户把常规间隔调得更短（如 30 秒）时不能被战期节奏拖长。
  return base > 0 ? Math.min(base, live) : live;
}

// ---- 城战在线奖励（WorldOnlineRwdCfg，7 档）----
//
// 规则（`TipsDescCfg.城战规则`）：战期内在线即可领取，**前置档领完才开下一档的倒计时**。
// 档位是累计在线 1 / 60 / 120 / 180 / 240 / 300 / 300 秒，也就是开战 5 分钟就全解锁。
//
// 为什么必须自己补：客户端 `WarOnlineReward` 里是**自动发**的 —
//   `n.stage == s + 1 && t.isTimeOver` → `GotWorldOnlineRwdRequest`，
// 无头挂机不跑那段 UI 逻辑，所以整场一个奖都不会领。
// 2026-10-29 实测：`grep -c GotWorldOnlineRwd data/protocol.log` = 0，7 档全漏，
// 白丢汽油 6 万 / RUBY 210 / 功勋 4.6 万 / 橙卡万能碎片 1 / 藏品券 1 / 抽卡券 1 / 橙技能书 1。
//
// 请求是**空消息**（无参数）。服务端满足一档就回一条 `GotRewardResponse`（带 reward.asset），
// 没有可领的档位时回 `PromptResponse` → 用「被拒」当收手信号，别无限打。
export const CW_ONLINE_TRIES = 4;
export const CW_ONLINE_TIMEOUT = 2500;

export async function claimWarOnlineReward(client, protocol, {
  maxTries = CW_ONLINE_TRIES,
  timeout = CW_ONLINE_TIMEOUT,
} = {}) {
  const req = 'GotWorldOnlineRwdRequest';
  const res = 'GotRewardResponse';
  if (!protocol?.[req] || !protocol?.[res]) {
    return { supported: false, rounds: 0, gifts: [], stoppedBy: 'unsupported', error: '' };
  }
  const gifts = [];
  let rounds = 0;
  let stoppedBy = 'maxTries';
  let error = '';
  for (let i = 0; i < Math.max(1, num(maxTries)); i += 1) {
    try {
      const body = normalize(await client.request(req, {}, res, timeout));
      rounds += 1;
      const assets = (body?.reward?.asset ?? [])
        .map((a) => ({ id: String(a?.id ?? ''), num: assetCount(a?.num) }))
        .filter((a) => a.id && a.num > 0);
      // 空包裹也不用继续打：说明这一档就是空的（或已领过）。
      if (assets.length === 0) {
        stoppedBy = 'empty';
        break;
      }
      gifts.push(...assets);
    } catch (e) {
      stoppedBy = 'rejected';
      error = String(e?.message ?? e);
      break;
    }
  }
  return { supported: true, rounds, gifts, stoppedBy, error };
}

// 把一次领奖结果压成一行：`在线奖励 汽油×7000 + RUBY×30`。没领到返回空串。
export function formatOnlineReward(result) {
  const list = result?.gifts ?? [];
  if (list.length === 0) return '';
  const merged = new Map();
  for (const gift of list) merged.set(gift.id, (merged.get(gift.id) ?? 0) + num(gift.num));
  return `在线奖励 ${[...merged].map(([id, count]) => `${id}×${count}`).join(' + ')}`;
}

// 战期结束后「下一步该干嘛」——网页/日志共用一句。
// 舰队不用手动撤回：城战结束后它们留在城里当驻守，下一次布署会自己开去新目标城。
export function cityWarNextHint(view) {
  return view.phase === 'done' ? '今日国战结束，舰队留在城里驻守，不必手动撤回' : '';
}

// 埋点用：把「为什么这一轮什么都没派」压成一句（方便 loop 的判断与日志）。
export function cityWarBlockedReason(view) {
  if (view.phase === 'waiting') {
    return `还没到布署时间（${hhmm(view.startAt)} 开战，提前 ${DEFAULT_CW_PREP_LEAD_SEC / 60} 分钟才派兵）`;
  }
  if (view.phase === 'unknown') return '服务端没给战期（今天没宣战 / 还没到 0 点推送）';
  if (view.phase === 'done') return '今日战期已过';
  return '';
}

