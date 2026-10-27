// 只读探测：贸易港口（建筑「货轮港口」）的 3 条货船实时状态 + 交货/领奖的计划试算。
// 只发 CargoShipsRequest / AllItemRequest / AllResourceRequest，不改账号状态。
// 用法: node tools/probe-cargo.mjs [账号id或昵称片段] [--run]
//   不带 --run：只打印探测结果和「如果挂机会发哪些请求」。
//   带 --run：真的执行（需要 CW_ALLOW_MUTATE=1，会改变账号状态）。
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadStore, pickAccount, toCredential } from '../src/accounts.mjs';
import { assetCount } from '../src/world.mjs';
import {
  surveyCargo, viewCargo, planCargo, formatCargoSummary, summarizeCargo, formatCargoGain, CARGO_SLOTS,
} from '../src/tradePort.mjs';

const args = process.argv.slice(2);
const run = args.includes('--run');
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
  const responseName = `${name.slice(0, -7)}Response`;
  try {
    return await client.request(name, body, responseName, 8000);
  } catch (error) {
    console.log(`! ${name} 失败: ${error.message}`);
    return null;
  }
};

const stock = new Map();
for (const item of (await get('AllItemRequest'))?.items ?? []) {
  stock.set(item.itemId ?? item.id, (stock.get(item.itemId ?? item.id) ?? 0) + assetCount(item.num ?? item.count));
}

const survey = await surveyCargo(client, protocol, { stock });
const view = viewCargo(survey);

console.log(`\n=== ${formatCargoSummary(view)}`);
for (const ship of view.ships) {
  console.log(
    `货船#${ship.index} ${ship.statusText}(status=${ship.status}) 已交 ${ship.filledCount}/${CARGO_SLOTS}`
    + (ship.phase === 'sailing' ? ` 返航剩 ${Math.ceil(ship.leftSeconds / 60)} 分` : '')
    + (ship.phase === 'arrived' ? ' 可领奖' : '')
    + (ship.statusMismatch ? ' ⚠ 状态不一致' : ''),
  );
  for (const slot of ship.slots) {
    console.log(
      `   [${slot.slot}] ${slot.id}×${slot.num} ${slot.filled ? '已交' : `未交（库存 ${slot.have}）`}`
      + ` → ${slot.reward.map((r) => `${r.id}×${r.num}`).join(' ')}`,
    );
  }
  if (ship.reward.length) console.log(`   返航奖励池 ${ship.reward.map((r) => `${r.id}×${r.num}`).join(' ')}`);
}

const plan = planCargo(view);
console.log(`\n=== 计划 ${plan.actions.length} 条`);
for (const action of plan.actions) console.log(`  ${action.request} ${JSON.stringify(action.body)}  ${action.label}`);
for (const note of plan.notes) console.log(`  跳过 ${note}`);

if (run && plan.actions.length > 0) {
  if (process.env.CW_ALLOW_MUTATE !== '1') throw new Error('真的执行需要 CW_ALLOW_MUTATE=1');
  const { runWorld } = await import('../src/world.mjs');
  const { results } = await runWorld(client, protocol, plan, { allowMutate: true });
  for (const entry of results) {
    console.log(`${entry.ok ? 'OK ' : 'FAIL'} ${entry.step.label}${entry.ok ? '' : ` → ${entry.error}`}`);
  }
  console.log(formatCargoGain(summarizeCargo(results)));
}

await client.close?.();
process.exit(0);
