// 今日收益统计（网页「统计」页的数据源）。
//
// 数据**不从内存拿，全部从归档回包里重新算**：data/responses/<日期>/ 是按接口分文件的
// 原始回包档案（见 archive.mjs），所以：
//   ① 页面刷新、进程重启、甚至当天下午才开页面，都能看到从 0 点起的完整统计；
//   ② 想知道「某一项是怎么算出来的」，直接去那个 jsonl 里 grep，不用信这里的代码。
//
// 只有一处例外：邮件奖励是从 EmailBoxResponse 的**最后一行**（= 当前邮件全量快照）里
// 挑「今天发出且已领取」的邮件。请求本身没有回包（QuickGotReadEmailRequest 是 sendWatch），
// 拿不到"这一批领了什么"，只能靠快照，所以它只在查「今天」时给数据。
//
// 统计口径一律是「**收进仓库的量**」：工厂造完但还堆在工厂里的不算（那是待收，不是收益），
// 收的时候 GainFactoryProduceResponse 才把 products 报回来。所以「今日制造」= 今天从工厂
// 收走多少成品 —— 这也正是能用来回答"这些料够不够交订单"的数。

import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_ROOT, dayOf } from './archive.mjs';

// protobuf int64 → number（{low,high} 形状，或已经是普通数字）。
function int64(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof value === 'object') return Number(value.low ?? 0) + Number(value.high ?? 0) * 2 ** 32;
  return Number(value ?? 0) || 0;
}

// 资产数组 → [[id, num]]。回包里 asset 的形状统一是 {type,id,num}，
// 但邮件附件叫 assets.asset、工厂叫 products.asset，所以路径由各自的 pick 负责。
function pairsOf(assets) {
  if (!Array.isArray(assets)) return [];
  const out = [];
  for (const asset of assets) {
    const id = asset?.id ?? asset?.itemId ?? asset?.res;
    const num = int64(asset?.num ?? asset?.amount ?? asset?.count);
    if (id !== undefined && id !== null && num > 0) out.push([typeof id === 'string' ? id : String(id), num]);
  }
  return out;
}

// ---- 收益来源 --------------------------------------------------------------
// label 是页面上那一栏的标题；note 是给人看的口径说明（鼠标悬停显示）。
// pick(body) 必须返回「这一条回包里到手的资产数组」，拿不到就返回空。
export const LOOT_SOURCES = [
  {
    key: 'factory',
    label: '制造',
    note: '工厂成品收取（GainFactoryProduceResponse.products）',
    name: 'GainFactoryProduceResponse',
    pick: (body) => body?.products?.asset,
  },
  {
    key: 'building',
    label: '建筑产出',
    note: '非工厂建筑的囤积产物：训练营的英雄经验、精铁厂的精铁、民居的金币等（CollectBuildingProductResponse.reward[].product）',
    name: 'CollectBuildingProductResponse',
    pick: (body) => (body?.reward ?? []).flatMap((entry) => entry?.product?.asset ?? []),
  },
  {
    key: 'floater',
    label: '拾荒',
    note: '海面漂浮物（PickUpFloaterResponse.reward）',
    name: 'PickUpFloaterResponse',
    pick: (body) => body?.reward?.asset,
  },
  {
    key: 'order',
    label: '居民订单',
    note: '交订单拿到的经验与金币（FinishWorkerOrderResponse.reward）',
    name: 'FinishWorkerOrderResponse',
    pick: (body) => body?.reward?.asset,
  },
  {
    key: 'afk',
    label: '挂机收益',
    note: '领取挂机时段的收益（DrawAfkRewardResponse.reward.assetPackage）',
    name: 'DrawAfkRewardResponse',
    pick: (body) => body?.reward?.assetPackage?.asset,
  },
  {
    // 一开始以为货轮港口只有请求没有回包（DrawShipRewardRequest），实测是有
    // DrawShipRewardResponse 的，reward.asset 就是返航奖励 —— 只取这一层，
    // 同一条回包里的 ship.orderItem[].reward 是**下一单的预览**，不是到手的。
    key: 'ship',
    label: '货轮港口',
    note: '货轮返航领的奖励（DrawShipRewardResponse.reward）',
    name: 'DrawShipRewardResponse',
    pick: (body) => body?.reward?.asset,
  },
];

// 今日活动次数：数的是**请求**条数（out 行），不是回包 —— 有些段（农田、海盗、情报、
// 海兽、货轮港口）压根没有回包，但"今天做了几次"仍然是挂机干活的最直接证据。
// 只列真正会变动的，探测类（OnWaterRequest 之类每轮必发）不算活动。
export const ACTIVITY_SOURCES = [
  // 生产
  { key: 'produce', label: '排产', name: 'StartFactoryProduceRequest' },
  { key: 'gain', label: '收成品', name: 'GainFactoryProduceRequest' },
  { key: 'collect', label: '收建筑产物', name: 'CollectBuildingProductRequest' },
  { key: 'pack', label: '兑自选包', name: 'SelectPackRequest' },
  // 海面
  { key: 'pick', label: '拾荒', name: 'PickUpFloaterRequest' },
  { key: 'harvest', label: '收农田', name: 'FarmHarvestRequest' },
  { key: 'plant', label: '播种', name: 'FarmPlantRequest' },
  { key: 'order', label: '交订单', name: 'FinishWorkerOrderRequest' },
  { key: 'build', label: '建造', name: 'BuildBuildingRequest' },
  { key: 'upgrade', label: '升级建筑', name: 'UpgradeBuildingRequest' },
  { key: 'finish', label: '竣工', name: 'FinishUpgradeBuildingRequest' },
  // 战斗
  { key: 'pirate', label: '海盗出战', name: 'ChallengePirateRequest' },
  { key: 'sweep', label: '免战扫荡', name: 'PirateSweepRequest' },
  { key: 'radar', label: '派情报舰队', name: 'RadarSendFleetsRequest' },
  { key: 'radarLoot', label: '领情报奖励', name: 'RadarGetAllRewardsRequest' },
  // 远征 / 贸易
  { key: 'cargo', label: '货轮装货', name: 'FillCargoShipRequest' },
  { key: 'shipLoot', label: '货轮领奖', name: 'DrawShipRewardRequest' },
  { key: 'pet', label: '海兽培育', name: 'PetBreedRequest' },
  { key: 'petTake', label: '收海兽', name: 'GetMaturePetRequest' },
  { key: 'tradeBuy', label: '海商王买货', name: 'TradeBuyRequest' },
  { key: 'tradeSell', label: '海商王卖货', name: 'TradeSellRequest' },
  { key: 'tradeMove', label: '海商王起航', name: 'TradeMoveRequest' },
  // 锻造
  { key: 'forge', label: '锻造装备', name: 'MakeEquipRequest' },
  { key: 'forgeTake', label: '收装备', name: 'PickMadeEquipRequest' },
  { key: 'speedup', label: '花加速器', name: 'SpeedUpFactoryProduceRequest' },
];

// ---- 读盘（带缓存）-------------------------------------------------------
// 挂机一天下来，单个接口也就几百 KB（最大的 GainFactoryProduceResponse 一天 100~200 KB），
// 全量重读一遍是毫秒级。缓存只为省重复工作：页面 30 秒刷一次、7 天趋势每次都要重算，
// 用「mtime + size」当 key，文件没长就不重新解析。
const CACHE_LIMIT = 64;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

function pathOf(name, day, root = ARCHIVE_ROOT) {
  return path.join(root, day, `${name}.jsonl`);
}

// 一行一行地喂给 onLine：只解析 dir/t/acc/body 四个字段，别的字段（seq/src/partial）用不上。
// 半行（写到一半进程被杀）解析失败就跳过 —— 统计是旁路，不能因为一条坏行整页空白。
function eachLine(text, onLine) {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    onLine(entry);
  }
}

// 把一份 jsonl 按账号聚合成 {acc: {count, items, total, hours}}。
// count = 回包条数（= 触发了几次），total = 件数合计，hours[24] = 按小时的件数。
function aggregateLoot(name, day, pick, root = ARCHIVE_ROOT) {
  const file = pathOf(name, day, root);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `loot|${file}|${stat.mtimeMs}|${stat.size}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const byAcc = new Map();
  const bucket = (acc) => {
    if (!byAcc.has(acc)) byAcc.set(acc, { count: 0, total: 0, items: new Map(), hours: new Array(24).fill(0) });
    return byAcc.get(acc);
  };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  eachLine(text, (entry) => {
    if (entry?.dir !== 'in') return;
    const pairs = pairsOf(pick(entry.body));
    if (pairs.length === 0) return;
    const acc = entry.acc ?? '';
    const target = bucket(acc);
    target.count += 1;
    const hour = new Date(Number(entry.t) || Date.now()).getHours();
    for (const [id, num] of pairs) {
      target.items.set(id, (target.items.get(id) ?? 0) + num);
      target.total += num;
      target.hours[hour] += num;
    }
  });
  return cacheSet(key, byAcc);
}

// 活动次数：只数请求（out），按 acc 分组。没有回包、甚至服务端拒了的请求也算
// —— 那是"挂机试过几次"，跟"拿到多少收益"是两件事，页面上分开显示。
function aggregateActivity(name, day, root = ARCHIVE_ROOT) {
  const file = pathOf(name, day, root);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `act|${file}|${stat.mtimeMs}|${stat.size}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const byAcc = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  eachLine(text, (entry) => {
    if (entry?.dir !== 'out') return;
    const acc = entry.acc ?? '';
    byAcc.set(acc, (byAcc.get(acc) ?? 0) + 1);
  });
  return cacheSet(key, byAcc);
}

// ---- 邮件奖励 --------------------------------------------------------------
// 服务端**不给"什么时候领的"**：QuickGotReadEmailRequest 没有回包，邮件里只有
// `got`（当前是否已领）和 `sendTime`（发信时间）。曾经按「sendTime 落在今天 + 已领」
// 来算，实测两头都错（2026-10-28 核对）：
//   ① 漏：10-27 23:59 发的 6 封是 10-28 才领的，按发信日两天都统计不到；
//   ② 少：10-28 实际领了 7 封 240497 件，旧口径只算出 2 封 136539 件。
// 所以改成**看快照变化**：同一封邮件在相邻两次 EmailBoxResponse 里 got 由 false 变 true，
// 就是在这两次之间领的，归到那一天。第一次见到就已经是 true 的，说明是更早领的，不计。
//
// EmailBoxResponse 是**全量快照**，一天能堆到 74MB（10-27 实测 13464 条快照）。
// 文件只增不减，所以按**字节偏移增量扫**（记住上次读到哪），只有当天第一次才全扫。
const mailStates = new Map(); // file -> { offset, byAcc: Map<acc, bucket> }
const MAIL_STATE_LIMIT = 8;

function mailKey(emailId) {
  if (emailId && typeof emailId === 'object') return `${emailId.low}:${emailId.high}`;
  return String(emailId ?? '');
}

function mailBucket(state, acc) {
  if (!state.byAcc.has(acc)) state.byAcc.set(acc, { count: 0, total: 0, items: new Map(), seen: new Map() });
  return state.byAcc.get(acc);
}

// 吃掉一段已归档的 email 快照。state.seen 记住「这封邮件有没有被领过」，
// 只在 false → true 那一次记账，领过的永远记 true（服务端偶尔把已领的邮件再推一遍 got=false，
// 认了它就会重复计数）。
function eatMailChunk(text, state) {
  eachLine(text, (entry) => {
    if (entry?.dir !== 'in') return;
    const list = entry.body?.email;
    if (!Array.isArray(list)) return;
    const bucket = mailBucket(state, entry.acc ?? '');
    for (const mail of list) {
      const key = mailKey(mail?.emailId);
      if (!key) continue;
      const got = mail?.got === true;
      const before = bucket.seen.get(key);
      if (got && before === false) {
        const pairs = pairsOf(mail?.attachment?.assets?.asset);
        if (pairs.length > 0) {
          bucket.count += 1;
          for (const [id, num] of pairs) {
            bucket.items.set(id, (bucket.items.get(id) ?? 0) + num);
            bucket.total += num;
          }
        }
      }
      if (got || before === undefined) bucket.seen.set(key, got);
    }
  });
}

// 增量读：文件被截断/轮转（size 变短）就整份重扫，否则只读上次 offset 之后的部分。
// 末尾那半行（进程被杀或正在写）留到下次 —— 半截 JSON 解析失败会被丢掉，等于永久漏一条。
function emailLoot(day, acc, root = ARCHIVE_ROOT) {
  const file = pathOf('EmailBoxResponse', day, root);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let state = mailStates.get(file);
  if (!state || stat.size < state.offset) {
    state = { offset: 0, byAcc: new Map() };
    mailStates.set(file, state);
    while (mailStates.size > MAIL_STATE_LIMIT) mailStates.delete(mailStates.keys().next().value);
  }
  if (stat.size > state.offset) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const len = stat.size - state.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.offset);
      // 在 Buffer 上找最后一个换行（按字节，别用字符串索引 —— 中文是多字节）。
      const cut = buf.lastIndexOf(0x0a);
      if (cut >= 0) {
        eatMailChunk(buf.subarray(0, cut + 1).toString('utf8'), state);
        state.offset += cut + 1;
      }
    } catch {
      /* 读不了就用已经攒下的部分，下一次再补 */
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return state.byAcc.get(acc ?? '') ?? null;
}

// ---- 对外：一天的统计 ------------------------------------------------------
// items 已按数量降序；icon 由 server 那边补（stats.mjs 不碰图片，避免和 art.mjs 互相拉依赖）。
function sortItems(map) {
  return [...map.entries()]
    .filter(([, num]) => num > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, num]) => ({ id, num }));
}

// 最近 N 天的制造总量（只取"制造"这一类，趋势图看一条线就够了；
// 7 天里每天读一个几百 KB 的文件，缓存后基本不花时间）。
export function factoryTrend({ days = 7, acc = null, endDay = dayOf(), root = ARCHIVE_ROOT } = {}) {
  const out = [];
  const [y, m, d] = String(endDay).split('-').map(Number);
  const end = new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = dayOf(end - back * 86400000);
    const agg = aggregateLoot('GainFactoryProduceResponse', day, LOOT_SOURCES[0].pick, root);
    // 给了 acc 就只认这个账号：查不到必须是 0。
    // 以前用 `agg?.values().next().value` 兜底，多账号时会把别人的数画到自己头上。
    const entry = acc === null ? agg?.values().next().value ?? null : agg?.get(acc) ?? null;
    out.push({ day, total: entry?.total ?? 0, count: entry?.count ?? 0 });
  }
  return out;
}

export function collectStats({ day = dayOf(), acc = null, trendDays = 7, root = ARCHIVE_ROOT } = {}) {
  const sources = [];
  for (const source of LOOT_SOURCES) {
    const agg = aggregateLoot(source.name, day, source.pick, root);
    const entry = acc === null ? null : agg?.get(acc) ?? null;
    const picked = acc === null ? agg?.values().next().value ?? null : entry;
    sources.push({
      key: source.key,
      label: source.label,
      note: source.note,
      count: picked?.count ?? 0,
      total: picked?.total ?? 0,
      items: sortItems(picked?.items ?? new Map()),
      hours: picked?.hours ?? new Array(24).fill(0),
    });
  }

  // 邮件：QuickGotReadEmailRequest 没有回包，靠当天 EmailBoxResponse 快照里
  // 「got 由 false 变 true」反推领取时刻（口径见 emailLoot 上面的注释）。
  // 历史日期一样算得出，所以不再限制只有今天。
  const isToday = day === dayOf();
  const mail = emailLoot(day, acc, root);
  sources.push({
    key: 'mail',
    label: '邮件奖励',
    note: '当天领取的邮件附件：靠 EmailBoxResponse 两次快照之间「未领→已领」的变化反推（没有回包能给领取时刻）',
    count: mail?.count ?? 0,
    total: mail?.total ?? 0,
    items: sortItems(mail?.items ?? new Map()),
    hours: null,
  });

  const activity = ACTIVITY_SOURCES.map((source) => ({
    key: source.key,
    label: source.label,
    count: aggregateActivity(source.name, day, root)?.get(acc ?? '') ?? 0,
  })).filter((entry) => entry.count > 0);

  const factory = sources.find((entry) => entry.key === 'factory');
  return {
    day,
    isToday,
    acc,
    sources,
    activity,
    // 页面顶部那几个大数字直接用这里的，省得前端再算一遍口径。
    kpi: {
      made: factory?.total ?? 0,
      madeKinds: factory?.items.length ?? 0,
      produced: sources.find((entry) => entry.key === 'building')?.total ?? 0,
      looted: sources.find((entry) => entry.key === 'floater')?.total ?? 0,
      mails: sources.find((entry) => entry.key === 'mail')?.count ?? 0,
      acts: activity.reduce((sum, entry) => sum + entry.count, 0),
    },
    hours: factory?.hours ?? new Array(24).fill(0),
    trend: factoryTrend({ days: trendDays, acc, endDay: day, root }),
  };
}
