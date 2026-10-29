// 酆都诡事（捞尸人联动）：只读探测 + 计划预览。
//
// 默认**只读**：拉 4 个板块的状态、按配置算出计划，一条写请求都不发。
// 想真跑请用：node src/app.mjs youdu --yes（或网页控制台 / 自动循环第 14 段）
// 用法: node tools/probe-youdu.mjs [--account <id|昵称|序号>] [--plan]
//   --plan 会把「如果真跑会发哪些请求」逐条列出来（仍然不发）
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadTables } from '../src/config.mjs';
import { loadStore, pickAccount, describeAccount } from '../src/accounts.mjs';
import {
  surveyYoudu,
  viewYoudu,
  planYoudu,
  formatYouduSummary,
  YOUDU_ACTIVITY_ID,
} from '../src/youdu.mjs';

const store = loadStore();
if (!store.accounts.length) throw new Error('还没有任何账号，先跑 node tools/capture-credentials.mjs');
const at = process.argv.indexOf('--account');
const account = pickAccount(store, at >= 0 ? process.argv[at + 1] : null);
console.log(`账号: ${describeAccount(account).title}`);

const config = { tables: loadTables() };
const protocol = loadProtocol();
const client = new GameClient({ url: account.url, protocol });
client.on('warn', (m) => console.log(`warn: ${m}`));

const login = await client.connect(account.login);
console.log(`登录 ${login.playerInfo?.nickname ?? ''}  活动 id=${YOUDU_ACTIVITY_ID}`);

const survey = await surveyYoudu(client, { config });
const view = viewYoudu(survey, { config });

console.log(`\n=== 状态 ===`);
console.log(formatYouduSummary(view));

if (view.open) {
  console.log('\n=== 驱邪除祟 ===');
  console.log(`  基地 ${view.evil.alive} 只 / 今日 ${view.evil.todayKill} / 累计 ${view.evil.killTotal} / 已领到「累计 ${view.evil.claimed} 只」那一档（claimed 是累计杀数，不是档位号）`);
  console.log(`  可领档位: ${view.evil.claimable.map((r) => `#${r.id}(${r.totalCount}只)`).join(' ') || '无'}`);
  console.log(`  下一档: ${view.evil.next ? `#${view.evil.next.id} 需累计 ${view.evil.next.totalCount} 只（还差 ${Math.max(0, view.evil.next.totalCount - view.evil.killTotal)}）` : '已领满'}`);

  console.log('\n=== 龙王罗盘 ===');
  console.log(`  积分 ${view.wheel.score}（累计抽 ${view.wheel.times} 次）已领到第 ${view.wheel.claimedId} 档`);
  console.log(`  单抽 ${view.wheel.costId}×${view.wheel.costNum}，持有 ${view.wheel.coinHeld} → 可转 ${view.wheel.spins} 次`);
  console.log(`  保底还剩 ${view.wheel.dragonIn} 抽（pity=${view.wheel.pity}，mustDraw=${view.wheel.dragonMustDraw}，最早第 ${view.wheel.dragonMinDraw} 抽才可能出）`);
  console.log(`  外圈已得: ${view.wheel.outerGot.join(',') || '无'}`);
  console.log(`  可领积分档位: ${view.wheel.claimable.map((r) => `#${r.id}(${r.score}分)`).join(' ') || '无'}`);

  console.log('\n=== 酆都法旨 ===');
  console.log(`  开一局要 ${view.edict.ticketId}×${view.edict.ticketNum}，持有 ${view.edict.ticketHeld}`);
  console.log(`  进行中: ${view.edict.session ? JSON.stringify(view.edict.session) : '无'}`);
  console.log(`  耐心 ${view.edict.patienceTotal} / 显化 -${view.edict.askCost} / 猜错 -${view.edict.receiveCost}`);
  console.log(`  奖励档: ${view.edict.rewards.map((r) => `耐心≥${r.patience}→${JSON.stringify(r.rewards)}`).join('  ')}`);

  console.log('\n=== 其他活动道具 ===');
  for (const id of ['活动26捞尸人_入场券', '活动26捞尸人_抽奖券', '活动26捞尸人_货币', '打雪仗体力']) {
    console.log(`  ${id}: ${view.stock.get(id) ?? 0}`);
  }
}

if (process.argv.includes('--plan')) {
  const plan = planYoudu(view, { config });
  console.log(`\n=== 计划（${plan.actions.length} 条，预览不发） ===`);
  for (const action of plan.actions) console.log(`  ${action.label}`);
  for (const note of plan.notes) console.log(`  跳过：${note}`);
}

client.stop();
console.log('\n完成（只读，未发送任何写操作）。');
