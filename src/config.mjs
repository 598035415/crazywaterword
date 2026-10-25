import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 客户端的配置表不在游戏包里，而是运行时从 CDN 拉取的独立 bundle `config_cn`，
// 整包被 Cocos 打成单个 JSON。微信小游戏会把它缓存在本地，这里直接读缓存。
// 缓存失效时用 `node tools/fetch-config.mjs` 重新下载。
export const APPID = 'wx2ea52a972ea18e5e';
export const CONFIG_PACK_PATH = path.resolve(import.meta.dirname, '../work/cdn/config_cn_pack.json');

// 资源是服务端数字枚举，数字到字符串 id 的映射只存在于客户端的生成代码里。
export const RESOURCE = { 1: 'EXP', 3: 'GOLD', 4: 'RUBY', 5: 'ARENA_POINT', 6: 'LEAGUE_POINT' };

function cachedPackCandidates() {
  const users = path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium', 'users');
  if (!fs.existsSync(users)) return [];
  const found = [];
  for (const user of fs.readdirSync(users)) {
    const dir = path.join(users, user, 'applet', 'local', APPID, 'usr', 'gamecaches', 'config_cn');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) found.push(path.join(dir, file));
    }
  }
  return found;
}

// 缓存目录里同时躺着 bundle 描述文件和打包好的资源，取最大的那个就是资源包。
export function findConfigPack() {
  if (process.env.CW_CONFIG_PACK && fs.existsSync(process.env.CW_CONFIG_PACK)) return process.env.CW_CONFIG_PACK;
  if (fs.existsSync(CONFIG_PACK_PATH)) return CONFIG_PACK_PATH;
  const candidates = cachedPackCandidates().filter((file) => fs.statSync(file).size > 1_000_000);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

// 打包格式是嵌套数组，每张表都是 [索引, "表名", {data: [...]}]。递归把带名字的对象捞出来。
export function extractTables(pack) {
  const tables = {};
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 3 &&
      typeof node[0] === 'number' &&
      typeof node[1] === 'string' &&
      node[2] !== null &&
      typeof node[2] === 'object' &&
      !Array.isArray(node[2])
    ) {
      tables[node[1]] = node[2];
    }
    for (const child of node) walk(child);
  };
  walk(pack);
  return tables;
}

export function loadTables(file = findConfigPack()) {
  if (!file) throw new Error('找不到配置表缓存，先运行 node tools/fetch-config.mjs');
  return extractTables(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const rows = (tables, name) => (Array.isArray(tables?.[name]?.data) ? tables[name].data : []);

// 挂机等级上限：OfflineCfg 里 stage <= 主线关卡-1 的最高 level（客户端 AfkModel.maxLevel() 同款）。
//
// 独立导出而不是只做方法，是因为 idle.mjs（挂机等级升级）也要这一份判断 ——
// 两处各写一份迟早会漂。第一个参数收「像 config 的东西」（只要有 tables），
// 所以单测可以直接喂一张合成表。
export function afkMaxLevelOf(config, mainlineStage) {
  // 拿不到主线关卡时返回 null，不能退化成「第 0 关」（升级全禁却不说明原因），
  // 更不能退化成「无上限」（盲发一批必被服务端拒的请求）。
  if (mainlineStage == null || mainlineStage === '') return null;
  const stage = Number(mainlineStage);
  if (!Number.isFinite(stage)) return null;
  const limit = stage - 1;
  let best = 0;
  for (const row of rows(config?.tables, 'OfflineCfg')) {
    const level = Number(row.level) || 0;
    if ((Number(row.stage) || 0) <= limit && level > best) best = level;
  }
  return best;
}

// 下一个有奖励的挂机等级：reward 为空的等级不产出，客户端 nextLvRewardCfg 会跳过。
export function nextAfkRewardLevelOf(config, rewardedLevel) {
  for (const row of rows(config?.tables, 'OfflineLvRewardCfg')) {
    const level = Number(row.level) || 0;
    if (level > Number(rewardedLevel) && (row.reward ?? []).length > 0) return level;
  }
  return null;
}

export function loadConfig({ file } = {}) {
  const tables = loadTables(file);
  const resourceCfg = new Map(rows(tables, 'ResourceCfg').map((row) => [row.id, row]));

  return {
    tables,
    names: Object.keys(tables).sort(),
    // 数字枚举先转字符串 id，再从 ResourceCfg 取展示名。
    resourceName(res) {
      const id = typeof res === 'number' ? RESOURCE[res] ?? String(res) : res;
      return resourceCfg.get(id)?.show_name ?? id;
    },
    resourceId(res) {
      return typeof res === 'number' ? RESOURCE[res] ?? String(res) : res;
    },
    // 挂机等级上限由主线进度决定：取 stage <= mainlineStage-1 的最高等级。
    // 拿不到主线关卡时按 0 处理（老调用方的契约：返回数字）。
    afkMaxLevel(mainlineStage) {
      return afkMaxLevelOf(this, mainlineStage) ?? 0;
    },
    // 下一个有奖励的挂机等级；reward 为空的等级不产出，客户端会跳过。
    nextAfkRewardLevel(rewardedLevel) {
      return nextAfkRewardLevelOf(this, rewardedLevel);
    },
  };
}

let cached = null;
export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}
