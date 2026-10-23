// 把 CDN 上的 world_map bundle 里的地图 JsonAsset 下到 work/cdn/。
//
// 为什么需要它：哪些 gridIdx 是资源田、属于哪座城，协议里没有、591 张配置表里也没有，
// 只存在于 Cocos 远程 bundle `world_map` 的 JsonAsset 里。缺了它 field 报告只能退化成纯文字。
//
// 用法：
//   node tools/fetch-map.mjs            # 下 world_map 里所有 world_mapN / museum_mapN
//   node tools/fetch-map.mjs --list     # 只列出远端有哪些，不下载
//
// 资源定位三步（全部从本地解包产物推导，不猜 URL）：
//   1. work/extracted/__APP__/src/settings.*.json 拿 assets.server 与 bundleVers.world_map
//   2. <server>remote/world_map/config.<ver>.json 拿 uuids / paths / versions
//   3. <server>remote/world_map/import/<uuid前2位>/<解压后的uuid>.<ver>.json
//
// 注意 CDN 会对 json 做 gzip，用 fetch 拿（会自动解压），别用裸 curl 存盘。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// uuid 解压和默认 CDN 前缀跟 sync-art 共用一份，别在这里再造一遍 —— 两处实现漂移了很难查。
import { decodeUuid, SERVER } from './sync-art.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'work/cdn');
const BUNDLE = 'world_map';

function findSettings() {
  const dir = path.join(ROOT, 'work/extracted/__APP__/src');
  if (!fs.existsSync(dir)) {
    throw new Error(`没找到解包产物 ${dir}\n先按 README 用 tools/wxapkg.mjs 解包微信小程序`);
  }
  const name = fs.readdirSync(dir).find((n) => /^settings\..*\.json$/.test(n));
  if (!name) throw new Error(`${dir} 里没有 settings.*.json`);
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function importVersion(versions, index) {
  // versions.import 是扁平的 [索引, 版本, 索引, 版本, ...]
  const flat = versions?.import ?? [];
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === index) return flat[i + 1];
  }
  return null;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON（可能是 gzip 没解压）: ${url}`);
  }
}

async function main() {
  const listOnly = process.argv.includes('--list');
  const settings = findSettings();
  const assets = settings.assets ?? {};
  const server = assets.server ?? SERVER;
  const ver = assets.bundleVers?.[BUNDLE];
  if (!ver) throw new Error(`settings.assets.bundleVers 里没有 ${BUNDLE}`);

  const base = `${server}remote/${BUNDLE}`;
  console.log(`server  ${server}`);
  console.log(`bundle  ${BUNDLE}@${ver}`);

  const config = await getJson(`${base}/config.${ver}.json`);
  const targets = [];
  for (const [index, entry] of Object.entries(config.paths ?? {})) {
    const name = entry?.[0];
    const type = entry?.[1]; // 1 = cc.JsonAsset（见 config.types）
    if (type !== 1) continue;
    if (!/^(world_map|museum_map)\d+$/i.test(name)) continue;
    targets.push({ index: Number(index), name, uuid: config.uuids[Number(index)] });
  }

  if (!targets.length) throw new Error('config 里没找到 world_mapN / museum_mapN 资源');
  console.log(`找到 ${targets.length} 张地图: ${targets.map((t) => t.name).join(', ')}`);
  if (listOnly) return;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  for (const t of targets) {
    const version = importVersion(config.versions, t.index);
    if (!version) {
      console.log(`  跳过 ${t.name}: 没有版本号`);
      continue;
    }
    const plain = decodeUuid(t.uuid);
    const url = `${base}/import/${plain.slice(0, 2)}/${plain}.${version}.json`;
    try {
      const raw = await getJson(url);
      const data = raw?.[5]?.[0]?.[2];
      if (!data?.mapData) throw new Error('结构不对，raw[5][0][2].mapData 为空');
      const dest = path.join(OUT_DIR, `${BUNDLE}.${t.name}.json`);
      fs.writeFileSync(dest, JSON.stringify(raw));
      const w = data.mapInfo?.width ?? 0;
      const h = data.mapInfo?.height ?? 0;
      const cities = Object.keys(data.cityInfo ?? {}).length;
      const fields = data.mapData.reduce((n, v) => n + (Math.floor(v / 10000) % 10 ? 1 : 0), 0);
      console.log(`  ${t.name}: ${w}x${h}, 城池 ${cities}, 资源田 ${fields} -> ${path.relative(ROOT, dest)}`);
      ok++;
    } catch (error) {
      console.log(`  ${t.name} 失败: ${error.message}`);
    }
  }
  console.log(`\n完成 ${ok}/${targets.length} 张。`);
  if (ok === 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('失败:', error.message);
    process.exit(1);
  });
}
