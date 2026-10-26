// 海兽培育室：收成熟的 + 队列空位排新的一轮。
//
// 事实来源（`tools/describe.mjs` 读回字段 + 反编译客户端 `_subpackages_main_/game.js`
// 里 PetBreedView 的业务代码，双重确认，没有推测）：
// - 培育室是普通水上建筑（`BuildingCfg.buildingType = '宠物培育室'`，UI 名「海兽培育室」），
//   状态挂在 `DispWaterBuilding.petBreed = { breedQ, maturePets, maxQLength }`。
//   **它没有 `factory` 字段** —— 所以不走 BuildingProduce 那套排产，`planWorld` 完全不碰它，
//   跟装备厂同一个套路。
// - 队列位数：客户端 `_lst_queue.numItems = min(level + 1, maxBuildLevel)`，但真正能排几个
//   以服务端给的 `maxQLength` 为准（0 = 还没开队列）。这里不自己按等级猜。
// - 请求：
//   `PetBreedRequest { petId, universal }`  → **无 Response**，结果靠 `SCUpdateWaterBuilding` 推送
//   `GetMaturePetRequest {}`                → **无 Response**，一次领走全部成熟海兽（客户端也这么发）
//   `PetFeedRequest { jobIdx }`             → **无 Response**，材料加速/投喂：消耗该队列位的
//     `feedRequirements`，把 `finishTime` 往前推 `PetParamCfg`「投喂减少培育时间」秒（本服 14400 = 4 小时）。
//   `universal` 是客户端的 `_isAutoExchange`（缺口用「万能基因」补），我们恒发 false，
//   和 `MakeEquipRequest.universal` 一致 —— 不碰通用材料。
// - 客户端 `_onBtnBreed` 的判据照抄：该队列位为空 + 基因够 + 金币够 才发请求，
//   缺基因就弹「去获取」（`ACCESS_POP`），不是报错。我们也一样：材料不齐就不排，只写一句原因。
// - 配方 `PetBreedCfg`：6 个物种 × 4 个品质（蓝/紫/橙/红），petId 形如「橙宠物3」；
//   `cost = [[基因, 数量], ['GOLD', 金币]]`。基因是**该物种专属**的（「宠物3蓝基因」只用于宠物3），
//   所以「有基因就培育」不会浪费材料 —— 攒着没有任何别的用途。
//   红配方标 `season: 2` 且要 100 万金币，常态打不开，所以默认品质上限卡在橙（页面可调）。
// - 星级：培育出几星由 `PetBreedLevelCfg` 的概率表按培育室等级掷，我们管不了，
//   所以只按 petId（物种 + 品质）排产，不假装能挑星。

import { normalize } from './worlds.mjs';
import { rowsOf, assetCount, makeTypeResolver, RESOURCE_NAMES } from './world.mjs';

// 培育室的建筑类型名（BuildingCfg.buildingType）。注意不是 UI 名「海兽培育室」。
export const PET_BREED_TYPE = '宠物培育室';

// 品质从高到低。排产时按这个顺序尝试，「材料够的里面取最高的那个」。
export const PET_QUALITIES = ['RED', 'ORANGE', 'PURPLE', 'BLUE'];

const QUALITY_NAME = { RED: '红', ORANGE: '橙', PURPLE: '紫', BLUE: '蓝' };

export function qualityName(quality) {
  return QUALITY_NAME[quality] ?? quality;
}

// 剩余时间只给人看量级，不需要 loop 里那种「1 小时 3 分」的精确格式。
function remainText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时`;
  return `${(s / 86400).toFixed(1)} 天`;
}

// 每次材料加速（投喂）能减掉多少秒：`PetParamCfg`「投喂减少培育时间」，本服 14400 = 4 小时。
// 客户端 `PetUtil.breedSpeedSeconds()` 读的就是这一行，红点提示里也用它算「一次减 X 分钟」。
const FALLBACK_SPEED_SECONDS = 14400;

export function petSpeedSeconds(config) {
  const row = rowsOf(config, 'PetParamCfg').find((entry) => entry?.paramName === '投喂减少培育时间');
  const value = Number(row?.paramValue);
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_SPEED_SECONDS;
}

// 剩余时间比这个还短就不加速了：投喂材料是实打实花掉的，为了省最后几分钟不值。
// （循环默认 300 秒一轮，剩不到 5 分钟的话下一轮本来就收了。）
export const FEED_MIN_REMAIN_SECONDS = 300;

function parseCost(row) {
  return (row?.cost ?? [])
    .filter((pair) => Array.isArray(pair) && pair.length >= 2 && pair[0])
    .map(([id, num]) => ({ id, num: Number(num) || 0 }));
}

// 一个配方 = PetBreedCfg 的一行 + 物种名。
export function describeRecipe(config, row) {
  const species = rowsOf(config, 'PetSpeciesCfg').find((sp) => Number(sp?.spId) === Number(row?.spId));
  return {
    petId: row?.petId ?? '',
    spId: Number(row?.spId) || 0,
    species: species?.name ?? `物种${row?.spId ?? '?'}`,
    quality: row?.quality ?? '',
    qualityName: QUALITY_NAME[row?.quality] ?? row?.quality ?? '',
    qualityIndex: Number(row?.qualityIndex) || 0,
    // 原时长。真正生效的还要减「培育时间」那类委任，但排产不需要算它 ——
    // 培育好没好以服务端给的 finishTime / maturePets 为准。
    seconds: Number(row?.breedTime) || 0,
    season: Number(row?.season) || 1,
    cost: parseCost(row),
  };
}

export function recipesOf(config) {
  return rowsOf(config, 'PetBreedCfg')
    .map((row) => describeRecipe(config, row))
    .filter((recipe) => recipe.petId);
}

// 档位：数组下标越小品质越高（红 = 0）。所以「品质不高于上限」= 下标 >= 上限的下标。
const rankOf = (quality) => {
  const index = PET_QUALITIES.indexOf(quality);
  return index < 0 ? PET_QUALITIES.length : index;
};
const withinCap = (quality, cap) => rankOf(quality) >= rankOf(cap);

// 挑这一批要排的配方（数量 = 队列空位）。
//
// 规则，按优先级：
//   1. 品质不超过 maxQuality（默认橙：红要 season 2 + 100 万金，常态打不开）；
//   2. 材料够（基因 + 金币，全部项都要够）；
//   3. 同品质内按 spId 升序 —— 先补齐编号小的物种，避免全砸在一个物种上；
//   4. 同一个 petId 一批里只排一次（服务端队列位是独立的，重复排同一个没有意义）。
// 选中的配方会**就地扣减**传进来的 stock（调用方持有余额表，跨培育室共享同一份），
// 所以「一次排满 3 个蓝」时按递减后的余额判断，不会 3 条都算「刚好够」。
export function pickRecipes(config, { stock, taken = new Set(), limit = 1, maxQuality = 'ORANGE' } = {}) {
  const pool = recipesOf(config)
    .filter((recipe) => withinCap(recipe.quality, maxQuality))
    .sort((a, b) => rankOf(a.quality) - rankOf(b.quality) || a.spId - b.spId);
  const picked = [];
  for (const recipe of pool) {
    if (picked.length >= limit) break;
    if (taken.has(recipe.petId)) continue;
    const enough = recipe.cost.every((item) => (stock.get(item.id) ?? 0) >= item.num);
    if (!enough) continue;
    for (const item of recipe.cost) stock.set(item.id, (stock.get(item.id) ?? 0) - item.num);
    taken.add(recipe.petId);
    picked.push(recipe);
  }
  return picked;
}

// 从建筑列表（surveyWorld 的产物）里取培育室。也接受原始 OnWater 建筑，方便单独调用。
export function breedBuildingsOf(list, config, { now = Math.floor(Date.now() / 1000) } = {}) {
  const resolveType = makeTypeResolver(config);
  const out = [];
  for (const entry of list ?? []) {
    const buildingId = entry.buildingId;
    if (!buildingId) continue;
    const type = entry.type ?? resolveType(buildingId);
    if (type !== PET_BREED_TYPE) continue;
    const petBreed = entry.petBreed ?? null;
    if (!petBreed) continue;
    const jobs = (petBreed.breedQ ?? []).map((job) => {
      const finishTime = Number(job.finishTime ?? 0) || 0;
      return {
        idx: Number(job.idx ?? 0) || 0,
        petId: job.petId ?? '',
        star: Number(job.star ?? 0) || 0,
        finishTime,
        remainSeconds: Math.max(0, finishTime - now),
        done: finishTime > 0 && finishTime <= now,
        // 喂食用得到，但我们不发 PetFeedRequest（见文件末尾），只用来提示。
        feed: (job.feedRequirements ?? []).map((need) => ({ id: need.id, num: assetCount(need.num) })),
      };
    });
    out.push({
      buildingId,
      level: Number(entry.level) || 0,
      maxQ: Number(petBreed.maxQLength) || 0,
      jobs,
      mature: (petBreed.maturePets ?? []).map((pet) => ({
        petId: pet.petId ?? '',
        star: Number(pet.star) || 0,
      })),
    });
  }
  return out;
}

// 只读探测：培育室 + 库存（含 GOLD）。循环里 world 那一轮已经拉过建筑和库存，传进来就零额外请求。
export async function surveyPet(client, protocol, {
  config = null,
  stock = null,
  buildings = null,
  timeout = 8000,
} = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      return normalize(await client.request(name, {}, responseName, timeout));
    } catch {
      return null;
    }
  };

  const needWater = !buildings;
  const [water, itemList, resourceList] = await Promise.all([
    needWater ? get('OnWaterRequest') : Promise.resolve(null),
    stock ? Promise.resolve(null) : get('AllItemRequest'),
    stock ? Promise.resolve(null) : get('AllResourceRequest'),
  ]);
  if (needWater && !water) throw new Error('拿不到 OnWaterResponse，读不了培育室');

  const bagStock = stock ? new Map(stock) : new Map();
  if (!stock) {
    for (const item of itemList?.items ?? []) {
      const id = item.itemId ?? item.id;
      bagStock.set(id, (bagStock.get(id) ?? 0) + assetCount(item.num ?? item.count));
    }
    // GOLD 在 AllResourceResponse 里，不合并进来的话 `cost` 里的 ["GOLD", 4000] 永远判成不够。
    for (const entry of resourceList?.list ?? []) {
      const id = RESOURCE_NAMES[entry.res] ?? String(entry.res);
      bagStock.set(id, (bagStock.get(id) ?? 0) + assetCount(entry.amount));
    }
  }

  const source = buildings ?? (water?.building ?? []).map((raw) => {
    const item = normalize(raw);
    return {
      buildingId: item.buildingId,
      level: item.level,
      petBreed: item.petBreed
        ? { breedQ: item.petBreed.breedQ ?? [], maturePets: item.petBreed.maturePets ?? [], maxQLength: item.petBreed.maxQLength }
        : null,
    };
  });

  const now = Math.floor(Date.now() / 1000);
  const buildings_ = breedBuildingsOf(source, config, { now });
  const recipes = recipesOf(config);

  return {
    now,
    buildings: buildings_,
    recipes,
    // 成熟的合在一起看：GetMaturePetRequest 没有 body，是一次领走全部，所以不按建筑拆。
    mature: buildings_.flatMap((building) => building.mature.map((pet) => ({ ...pet, buildingId: building.buildingId }))),
    jobs: buildings_.flatMap((building) => building.jobs.map((job) => ({ ...job, buildingId: building.buildingId }))),
    maxQ: buildings_.reduce((sum, building) => sum + building.maxQ, 0),
    stock: bagStock,
    config,
  };
}

function petName(survey, petId) {
  const recipe = (survey.recipes ?? []).find((item) => item.petId === petId);
  return recipe ? `${recipe.qualityName}${recipe.species}` : petId;
}

// 计划：先收成熟的，再材料加速（可选），最后给每座培育室的空位排产。
export function planPet(survey, { config = null, maxQuality = 'ORANGE', allowFeed = true } = {}) {
  const config_ = config ?? survey.config ?? null;
  const actions = [];
  const notes = [];

  if (!survey.buildings?.length) {
    notes.push(`没有「${PET_BREED_TYPE}」建筑，这轮不培育`);
    return { actions, notes };
  }
  const open = survey.buildings.filter((building) => building.maxQ > 0);
  if (!open.length) {
    const detail = survey.buildings.map((building) => `${building.buildingId} lv${building.level}`).join('、');
    notes.push(`培育室还没开队列（maxQLength=0，${detail}），多半是建筑还没建成`);
    return { actions, notes };
  }

  // 领取：一次请求领走全部成熟的，所以整轮只放一条，和培育放同一组（收不到就别急着排新的）。
  if (survey.mature.length > 0) {
    const detail = survey.mature.map((pet) => `${petName(survey, pet.petId)}${pet.star ? ` ${pet.star}星` : ''}`).join('、');
    actions.push({
      kind: 'petPick',
      request: 'GetMaturePetRequest',
      response: null,
      body: {},
      // key 带上这批成熟海兽的指纹：下一批换人了就是新 key，不会被上一批的失败记录挡住。
      key: `petPick:${survey.mature.map((pet) => `${pet.petId}${pet.star}`).sort().join(',')}`,
      group: 'pet:pick',
      transient: true,
      items: survey.mature.map((pet) => [petName(survey, pet.petId), 1]),
      label: `收取成熟海兽：${detail}`,
    });
  }

  const taken = new Set(survey.jobs.map((job) => job.petId));
  // 余额表整轮共享：pickRecipes / 投喂都就地扣，多个培育室不会把同一批材料算两遍。
  const balance = new Map(survey.stock);

  // 材料加速（投喂）：`PetFeedRequest{jobIdx}` 消耗该队列位 `feedRequirements` 里的材料，
  // 把剩余时间往前推 `PetParamCfg`「投喂减少培育时间」（本服 4 小时）。
  // 判据与客户端 `_onBtnFood` 逐字一致：`isAssetsEnough(feedRequirements, false)` 才发 ——
  // 材料不齐时客户端会弹「购买」补齐，我们不买，只写一句原因。
  // **一轮每个队列位最多喂一次**：喂完 finishTime 就变，下一轮按新状态重算；
  // 不猜服务端是否允许连点（协议里没有冷却字段，也没有 Response）。
  if (allowFeed) {
    const speedSec = petSpeedSeconds(config_);
    // `PetFeedRequest` 只带 jobIdx（没有 buildingId，客户端 `_onBtnFood` 也是这么发的），
    // 所以同一个 idx 一轮只能喂一次 —— 真有第二座培育室且 idx 撞了，重复发只会被服务端拒。
    const fedIdx = new Set();
    for (const building of open) {
      for (const job of building.jobs) {
        // 已到点的先收（上面那条 GetMaturePet 已经处理），别再喂。
        if (job.done) continue;
        // 剩不到 5 分钟就不值当：材料是真花掉的，下一轮本来就是收。
        if (job.remainSeconds <= FEED_MIN_REMAIN_SECONDS) continue;
        if (!job.feed.length) continue;
        if (fedIdx.has(job.idx)) continue;
        const lack = job.feed.filter((need) => (balance.get(need.id) ?? 0) < need.num);
        if (lack.length > 0) {
          notes.push(`${building.buildingId} 队列位 ${job.idx}（${petName(survey, job.petId)}）材料不够加速：`
            + `缺 ${lack.map((need) => `${need.id}×${need.num - (balance.get(need.id) ?? 0)}`).join('、')}`);
          continue;
        }
        for (const need of job.feed) balance.set(need.id, (balance.get(need.id) ?? 0) - need.num);
        fedIdx.add(job.idx);
        actions.push({
          kind: 'petFeed',
          request: 'PetFeedRequest',
          response: null,
          body: { jobIdx: job.idx },
          // key 必须带 finishTime：喂一次 finishTime 就变了，下一次应该是新 key；
          // 固定 key 的话第一次失败会被 rejected 永久跳过，之后再也不加速。
          key: `petFeed:${building.buildingId}:${job.idx}:${job.finishTime}`,
          group: `pet:feed:${building.buildingId}`,
          transient: true,
          label: `材料加速「${petName(survey, job.petId)}」（队列位 ${job.idx}，剩 ${remainText(job.remainSeconds)}）`
            + ` · 耗 ${job.feed.map((need) => `${need.id}×${need.num}`).join(' + ')}`
            // 剩余比一次的减免还短就直接到点，别写成「减 4 小时」再让人以为多扣了。
            + (job.remainSeconds <= speedSec ? ' · 一次就完工' : ` · 减 ${remainText(speedSec)}`),
        });
      }
    }
  }

  for (const building of open) {
    const free = Math.max(0, building.maxQ - building.jobs.length);
    if (free <= 0) {
      const running = building.jobs.length
        ? `队列满（${building.jobs.length}/${building.maxQ}），最近一只是 ${petName(survey, building.jobs[0].petId)}`
        : '队列满';
      notes.push(`${building.buildingId} ${running}`);
      continue;
    }
    const group = `pet:breed:${building.buildingId}`;
    const picked = pickRecipes(config_, {
      stock: balance,
      taken,
      limit: free,
      maxQuality,
    });
    if (!picked.length) {
      notes.push(`${building.buildingId} 有 ${free} 个空位，但材料/金币不够排任何一个配方（品质上限 ${qualityName(maxQuality)}）`);
      continue;
    }
    picked.forEach((recipe, index) => {
      const costText = recipe.cost.map((item) => `${item.id}×${item.num}`).join(' + ');
      actions.push({
        kind: 'petBreed',
        request: 'PetBreedRequest',
        response: null,
        body: { petId: recipe.petId, universal: false },
        // 同一座培育室一次能排多个，key 必须带序号，否则后面几条都会被第一条的失败记录挡住。
        key: `petBreed:${building.buildingId}:${recipe.petId}:${index}`,
        group,
        transient: true,
        items: [[`${recipe.qualityName}${recipe.species}`, 1]],
        label: `培育「${recipe.qualityName}${recipe.species}」（${recipe.petId}，${remainText(recipe.seconds)}）· 耗 ${costText}`,
      });
    });
  }

  return { actions, notes };
}

export function formatPetSummary(survey) {
  if (!survey.buildings?.length) return '没有海兽培育室';
  const parts = survey.buildings.map((building) => {
    const running = building.jobs.length
      ? `培育中 ${building.jobs.length}/${building.maxQ}，最近一只是 ${petName(survey, building.jobs[0].petId)}`
        + (building.jobs[0].remainSeconds > 0 ? `（还剩 ${remainText(building.jobs[0].remainSeconds)}）` : '（已到点）')
      : `队列 ${building.jobs.length}/${building.maxQ} 空着`;
    const mature = building.mature.length ? ` · 成熟待收 ${building.mature.length}` : '';
    return `${building.buildingId} lv${building.level} · ${running}${mature}`;
  });
  return parts.join('；');
}

export function formatPetPlan(survey, plan) {
  const lines = [formatPetSummary(survey)];
  for (const action of plan?.actions ?? []) lines.push(`动作 ${action.label}`);
  for (const note of plan?.notes ?? []) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}

// 关于材料加速（PetFeedRequest）的边界，2026-10-26 按用户要求上线，页面「材料加速」勾选默认开：
// - 它是**投喂**：消耗服务端在该队列位下发的 `feedRequirements`（实测「鱼肠线×12 + 粗铁×4 + 烤鱼×40」），
//   每次减 `PetParamCfg`「投喂减少培育时间」= 14400 秒。不是钻石、不是加速器、不是广告。
// - 判据照抄客户端 `_onBtnFood`：`isAssetsEnough(feedRequirements, false)` 才发；
//   材料不齐时客户端会弹「购买补齐」，我们**不买**（买东西属于付费决策，交给人）。
// - 不做连点：一轮每个队列位只喂一次，喂完由服务端刷新 `finishTime`，下一轮按新状态再判断。
//   协议里没有冷却字段也没有 Response，连点等于赌服务端的频率限制。
// - 剩不到 `FEED_MIN_REMAIN_SECONDS`（5 分钟）不喂：材料是真花掉的，省最后几分钟不值。
