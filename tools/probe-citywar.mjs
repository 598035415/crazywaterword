// 只读探测：国战（联盟攻城）。
//
// 全部是信息类请求，不改账号状态、不消耗任何资源、不发任何宣战/委任/派兵动作。
// 用法: node tools/probe-citywar.mjs [--account <id|昵称|序号>] [--force]
//   --force 只是把「战期阶段」当成布署窗来算（这样才看得到守军与燃油估算），**不会执行任何动作**。
//
// 想真跑请用：node src/app.mjs citywar --dry（只看） / node src/app.mjs citywar --yes（真派兵）
//
// 逻辑全部走 src/cityWar.mjs，这里只负责打印 —— 以前这套判断抄过一份，两处容易走偏。
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadTables } from '../src/config.mjs';
import { loadStore, pickAccount, describeAccount } from '../src/accounts.mjs';
import { assetCount } from '../src/world.mjs';
import {
  surveyCityWar,
  viewCityWar,
  planCityWar,
  formatCityWarSummary,
  cityWarBlockedReason,
  cityNameOf,
  CW_STATE_TEXT,
  CW_TITLE_TEXT,
} from '../src/cityWar.mjs';

const store = loadStore();
if (!store.accounts.length) throw new Error('还没有任何账号，先跑 node tools/capture-credentials.mjs');
const at = process.argv.indexOf('--account');
const selector = at >= 0 ? process.argv[at + 1] : null;
const account = selector ? pickAccount(store, selector) : pickAccount(store, null);
const force = process.argv.includes('--force');
console.log(`账号: ${describeAccount(account).title}`);

const config = { tables: loadTables() };
const protocol = loadProtocol();
const client = new GameClient({ url: account.url, protocol });
client.on('warn', (message) => console.log(`warn: ${message}`));

const login = await client.connect(account.login);
const player = login.playerInfo ?? {};

const survey = await surveyCityWar(client, protocol, { config, player, force });
const view = viewCityWar(survey, { config, player });
// --force 只影响「要不要查守军/算计划」，不发任何写请求。
const plan = planCityWar(force ? { ...view, phase: 'prep' } : view, {});

console.log(`\n${formatCityWarSummary(view)}`);
console.log(`  我的联盟 idx=${view.myIdx}  职位=${CW_TITLE_TEXT[view.myTitle] ?? view.myTitle}`
  + `${view.canDeclare ? '（有宣战权）' : '（不能宣战，只跟随联盟已宣的城）'}`);
console.log(`  出生城 ${view.bornCity ? `${view.bornCity.name}(${view.bornCity.cityId})` : '未配置'}`);
if (view.assembleCityId) console.log(`  集结城 ${view.assembleCityName}(${view.assembleCityId})`);

console.log('\n=== 联盟宣战 ===');
const all = survey.declarations;
if (all.length === 0) console.log('  （一条都没有：今天联盟没宣战，或还没到 0 点的推送）');
for (const decl of all) {
  const mark = decl.attacking ? ' ← 我方进攻' : (decl.defending ? ' ← 我方防守' : '');
  console.log(`  ${cityNameOf(config, decl.cityId)}(${decl.cityId})  攻 idx=${decl.attackIdx} 守 idx=${decl.defenceIdx}${mark}`);
}

console.log('\n=== 目标（我方的城）===');
if (view.targets.length === 0) console.log('  没有要打的城');
for (const target of view.targets) {
  console.log(`  ${target.name}(${target.cityId}) ${target.kind === 'defend' ? '守城' : '攻城'}`
    + `  守军 ${target.defenceKnown ? `${target.defenceCount} 支（NPC ${target.defenceNpc}，兵力 x${target.defenceUnits}）/ 战力 ${target.defencePower}` : '未知（不在布署窗，没查守军）'}`
    + `  单程约 ${target.petrolCost == null ? '?（缺地图）' : `${target.petrolCost} 汽油`}`);
}

console.log('\n=== 舰队 ===');
if (view.fleets.length === 0) console.log('  一艘都没有');
for (const fleet of view.fleets) {
  console.log(`  ${fleet.buildingId}  ${CW_STATE_TEXT[fleet.state] ?? `状态${fleet.state}`}`
    + `  位于 ${fleet.cityId ? cityNameOf(config, fleet.cityId) : '—'}`
    + `  耐久 ${fleet.durability}/${fleet.maxDurability}（${Math.round(fleet.duraPct * 100)}%）`
    + `  战力 ${assetCount(fleet.power)}`
    + `${fleet.autoFight ? '  委任中' : ''}${fleet.needsRepair ? '  该修' : ''}`);
}
console.log(`  汽油 ${view.petrol}（派兵按「出生城 → 目标城」扣，修船 = 缺口 × 服务端单价）`);

console.log(`\n=== 计划（${force ? '强制按布署窗计算' : '按当前时间'}）===`);
if (plan.actions.length === 0) {
  const why = cityWarBlockedReason(view) || plan.notes[0] || '没有要做的';
  console.log(`  0 条：${why}`);
} else {
  for (const action of plan.actions) console.log(`  ${action.label}`);
}
const notes = force ? plan.notes.filter((note) => !note.startsWith('联盟今天')) : plan.notes;
for (const note of notes) console.log(`  跳过 ${note}`);

client.close?.();
console.log('\n完成（未发送任何写操作）。');
