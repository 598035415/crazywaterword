// 只读探测：海商王（活动 Trade）实时状态 + 各城商品价格 + 联盟雷达。
// 只发 TradeInfoRequest / TradeCityRequest / TradeGuildRadarRequest，不改账号状态。
// 用法: node tools/probe-trade.mjs [账号id或昵称片段]
import fs from 'node:fs';
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadStore, pickAccount, toCredential } from '../src/accounts.mjs';
import { assetCount } from '../src/world.mjs';

const args = process.argv.slice(2);
const selector = args.find((a) => !a.startsWith('--')) ?? null;

const store = loadStore();
const account = pickAccount(store, selector);
if (!account) throw new Error('accounts.json 里没有可用账号');
const credential = toCredential(account);
const protocol = loadProtocol();
const client = new GameClient({ url: credential.url, protocol });
client.on('warn', (message) => console.log(`warn: ${message}`));

const login = await client.connect(credential.login);
console.log(`login ok: ${login.playerInfo?.nickname} lv${login.playerInfo?.level}`);

const get = async (name, body = {}) => {
  const responseName = name.replace(/Request$/, 'Response');
  try {
    return await client.request(name, body, responseName, 8000);
  } catch (error) {
    console.log(`! ${name} ${JSON.stringify(body)} 失败: ${error.message}`);
    return null;
  }
};

const out = {};

const info = await get('TradeInfoRequest');
out.info = info;
if (info) {
  console.log('\n=== TradeInfo');
  console.log('period', info.period, 'gotAchieveRwdId', info.gotAchieveRwdId, 'gotReportRwdId', info.gotReportRwdId, 'guildReportNum', info.guildReportNum);
  console.log('player', JSON.stringify(info.player));
  console.log('cargo', JSON.stringify(info.cargo));
  console.log('worldCargo', JSON.stringify(info.worldCargo));
  console.log('guildTask', JSON.stringify(info.guildTask));
}

const radar = await get('TradeGuildRadarRequest');
out.radar = radar;
if (radar) console.log('\n=== Radar', JSON.stringify(radar));

const cities = {};
for (let cityId = 1; cityId <= 12; cityId += 1) {
  const city = await get('TradeCityRequest', { cityId });
  if (!city || !Array.isArray(city.goods) || city.goods.length === 0) continue;
  cities[cityId] = city;
  console.log(`\n=== City ${cityId} spec=${city.specGoodsId} rare=${city.rareGoodsId} isReport=${city.isReport}`);
  console.log(city.goods.map((g) => `${g.goodsId}:p${g.price}/s${g.stock}`).join(' '));
}
out.cities = cities;

const items = await get('AllItemRequest');
const stock = {};
for (const item of items?.items ?? []) {
  const id = item.itemId ?? item.id;
  if (!id) continue;
  stock[id] = (stock[id] ?? 0) + assetCount(item.num ?? item.count);
}
out.stock = stock;

fs.writeFileSync('work/tmp/trade-live.json', JSON.stringify(out, null, 1));
console.log('\n写入 work/tmp/trade-live.json');

await client.close?.();
process.exit(0);
