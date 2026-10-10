// 把游戏自己的 UI 贴图镜像到 work/cdn/art/，并生成「图标名 → 图集矩形」索引。
//
// 贴图不是按名字存在磁盘上的：微信缓存里的文件名是一串数字，真正的身份写在 bundle 配置里
// （`paths` 给名字、`uuids` 给压缩过的 uuid、`versions.native/import` 给哈希），
// 拼出的 URL 与 cacheList.json 里的原始 URL 完全一致，所以能精确对上，不靠猜。
// 矩形在 FGUI 二进制里，解析见 src/fgui.mjs。
//
// 用法:
//   node tools/sync-art.mjs           # 只用微信缓存里已有的，缺的页面列出来
//   node tools/sync-art.mjs --fetch   # 缺的页面从 CDN 下载
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePackage, ITEM_TYPE } from '../src/fgui.mjs';

export const APPID = 'wx2ea52a972ea18e5e';
export const SERVER = 'https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/wx/';
export const ART_DIR = path.resolve(import.meta.dirname, '../work/cdn/art');

// 真的要用到的包，按「界面会显示什么」挑的，贡献与体积见 work/tmp/probe-art-value.mjs：
//   ui_iconlib/ui_iconlib2 道具与资源图标  ui_iconequip 装备  ui_herohead/ui_herohead2 英雄头像
//   ui_building 建筑与工厂  ui_iconaccess 少数建筑与要塞  ui_iconchip 芯片
//   ui_iconworker 工人  ui_preset 预设  ui_chat_iframe 聊天头像框
// 砍掉的：ui_common（9.0M，核心图标一个都不落在这里）、ui_head_frame（3.8M，头像框界面不显示）。
export const BUNDLES = [
  'ui_iconlib',
  'ui_iconlib2',
  'ui_herohead',
  'ui_herohead2',
  'ui_iconequip',
  'ui_building',
  'ui_iconchip',
  'ui_iconaccess',
  'ui_preset',
  'ui_chat_iframe',
  'ui_iconworker',
];

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64 = new Map([...BASE64_KEYS].map((c, i) => [c, i]));
const HEX = '0123456789abcdef'.split('');

// 与 Cocos core/utils/decode-uuid 同款：保留前两位，其余 base64 对折成十六进制，插回短横线模板。
export function decodeUuid(uuid) {
  const raw = String(uuid).split('@')[0];
  if (raw.length !== 22) return raw;
  const hex = [raw[0], raw[1]];
  for (let i = 2; i < 22; i += 2) {
    const lhs = B64.get(raw[i]);
    const rhs = B64.get(raw[i + 1]);
    if (lhs === undefined || rhs === undefined) return raw;
    hex.push(HEX[lhs >> 2], HEX[((lhs & 3) << 2) | (rhs >> 4)], HEX[rhs & 15]);
  }
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// 微信给小游戏单独划了一块缓存目录，目录名是账号哈希，这里挨个找哪个里面有 cacheList。
export function findCacheDir() {
  const users = path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium', 'users');
  if (!fs.existsSync(users)) return null;
  for (const user of fs.readdirSync(users)) {
    const dir = path.join(users, user, 'applet', 'local', APPID, 'usr', 'gamecaches');
    if (fs.existsSync(path.join(dir, 'cacheList.json'))) return dir;
  }
  return null;
}

export function readCacheList(cacheDir) {
  const list = JSON.parse(fs.readFileSync(path.join(cacheDir, 'cacheList.json'), 'utf8'));
  const byUrl = new Map();
  for (const [url, info] of Object.entries(list.files ?? {})) {
    const local = info.url?.startsWith('wxfile://usr/gamecaches/') ? path.join(cacheDir, info.url.slice('wxfile://usr/gamecaches/'.length)) : null;
    byUrl.set(url, { bundle: info.bundle, local });
  }
  return byUrl;
}

export function readBundleConfig(cacheDir, bundle) {
  const dir = path.join(cacheDir, bundle);
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    if (fs.statSync(full).size < 500) continue;
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (parsed?.paths && parsed?.uuids) return parsed;
  }
  return null;
}

// 每个资源在 CDN 上的真实地址：native 优先（贴图 .png、二进制 .bin），没有才回落到 import 的 .json。
export function assetUrl(bundle, cfg, index, typeName) {
  const uuid = decodeUuid(cfg.uuids[index]);
  const nativeVer = new Map();
  for (let i = 0; i + 1 < (cfg.versions.native ?? []).length; i += 2) nativeVer.set(cfg.versions.native[i], cfg.versions.native[i + 1]);
  const importVer = new Map();
  for (let i = 0; i + 1 < (cfg.versions.import ?? []).length; i += 2) importVer.set(cfg.versions.import[i], cfg.versions.import[i + 1]);
  const ext = typeName === 'cc.ImageAsset' ? 'png' : 'bin';
  if (nativeVer.has(index)) return `${SERVER}remote/${bundle}/native/${uuid.slice(0, 2)}/${uuid}.${nativeVer.get(index)}.${ext}`;
  return `${SERVER}remote/${bundle}/import/${uuid.slice(0, 2)}/${uuid}.${importVer.get(index)}.json`;
}

async function materialize(url, target, byUrl, allowFetch) {
  if (fs.existsSync(target)) return fs.statSync(target).size;
  const cached = byUrl.get(url);
  if (cached?.local && fs.existsSync(cached.local)) {
    fs.copyFileSync(cached.local, target);
    return fs.statSync(target).size;
  }
  if (!allowFetch) return 0;
  const res = await fetch(url);
  if (!res.ok) return -1;
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  return fs.statSync(target).size;
}

async function main() {
  const allowFetch = process.argv.includes('--fetch');
  const cacheDir = findCacheDir();
  if (!cacheDir) {
    console.error('没找到微信小游戏缓存目录，先在电脑上打开过一次游戏再试');
    process.exit(1);
  }
  const byUrl = readCacheList(cacheDir);
  const icons = {};
  const pages = {};
  const missing = [];
  const stats = [];

  for (const bundle of BUNDLES) {
    const cfg = readBundleConfig(cacheDir, bundle);
    if (!cfg) {
      stats.push(`${bundle}: 缓存里没有这个包`);
      continue;
    }
    const dir = path.join(ART_DIR, bundle);
    fs.mkdirSync(dir, { recursive: true });

    // 名字 -> 本地文件。ImageAsset 是图集页，BufferAsset 是 FGUI 二进制。
    const pageFiles = new Map();
    let declaredPages = 0;
    let binFile = null;
    for (const [key, [name, type]] of Object.entries(cfg.paths)) {
      const typeName = cfg.types[type];
      if (typeName !== 'cc.ImageAsset' && typeName !== 'cc.BufferAsset') continue;
      if (typeName === 'cc.ImageAsset') declaredPages += 1;
      const index = Number(key);
      const isBin = typeName === 'cc.BufferAsset';
      const target = path.join(dir, `${name}.${isBin ? 'bin' : 'png'}`);
      const size = await materialize(assetUrl(bundle, cfg, index, typeName), target, byUrl, allowFetch);
      if (size <= 0) {
        missing.push(`${bundle}/${name}`);
        continue;
      }
      if (isBin) binFile = target;
      else pageFiles.set(name, `${name}.png`);
    }
    if (!binFile) {
      stats.push(`${bundle}: 没有 FGUI 二进制`);
      continue;
    }

    const pkg = parsePackage(fs.readFileSync(binFile), bundle);
    fs.writeFileSync(path.join(dir, `${pkg.name}.package.json`), `${JSON.stringify({ name: pkg.name, id: pkg.id, version: pkg.version, items: pkg.items.length, sprites: pkg.sprites.size }, null, 1)}\n`);

    // 图集页：FGUI 里写的是 atlas0.png 这种裸名，Cocos 里的名字是 <包名>_atlas0，两边对一下。
    const resolvePage = (rawFile) => {
      const stem = path.basename(rawFile ?? '').replace(/\.[^.]*$/, '');
      const exact = pageFiles.get(`${pkg.name}_${stem}`);
      if (exact) return exact;
      const candidates = [...pageFiles.keys()].filter((key) => key.endsWith(`_${stem}`));
      return candidates.length === 1 ? pageFiles.get(candidates[0]) : null;
    };

    let withRect = 0;
    let noPage = 0;
    for (const item of pkg.items) {
      if (item.type !== ITEM_TYPE.IMAGE || !item.name) continue;
      const sprite = pkg.sprites.get(item.id);
      if (!sprite) continue;
      const page = resolvePage(sprite.atlas?.rawFile ?? sprite.atlas?.file);
      if (!page) {
        noPage += 1;
        continue;
      }
      icons[item.name] = { bundle, page, x: sprite.rect.x, y: sprite.rect.y, w: sprite.rect.width, h: sprite.rect.height, rotated: sprite.rotated };
      pages[`${bundle}/${page}`] = true;
      withRect += 1;
    }
    stats.push(`${bundle}: 图标 ${withRect} 个，图集页 ${pageFiles.size}/${declaredPages}，落在缺页上的图标 ${noPage} 个`);
  }

  const index = { generatedAt: new Date().toISOString(), icons, pages: Object.keys(pages) };
  fs.mkdirSync(ART_DIR, { recursive: true });
  fs.writeFileSync(path.join(ART_DIR, 'index.json'), JSON.stringify(index));
  const size = (fs.statSync(path.join(ART_DIR, 'index.json')).size / 1024).toFixed(0);
  console.log(`索引已写入 ${path.join(ART_DIR, 'index.json')} (${size} KB, ${Object.keys(icons).length} 个图标)`);
  for (const line of stats) console.log(`  ${line}`);
  if (missing.length) {
    console.log(`缺 ${missing.length} 个图集页${allowFetch ? '（已尝试下载）' : '，加 --fetch 从 CDN 补'}:`);
    console.log(`  ${missing.join(', ')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
