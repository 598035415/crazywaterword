// 批量兑换礼包码：一条连接顺序发、逐条判定结果。
//
// 为什么单独写成一个工具而不是塞进 `act`：兑换是「一码一发 + 立刻看回包」的串行流程，
// 而且候选码大多来自第三方汇总、命中率低，需要一次跑几十条并留下可核对的清单。
//
// 判定口径（2026-10-26 实测确认）：
//   - 成功：紧随其后会推 `GotRewardResponse`（奖励明细），`GotGiftCodeRequest` 本身没有 Response；
//   - 失败（无效 / 已兑换 / 过期）：只推 `PromptResponse`，client 的 sendWatch 会 reject；
//   - 两者都没有：连接被打断或服务端完全静默，记为「未知」，不猜成功。
//
// 用法：
//   node tools/gift-codes.mjs VIP666,VIP777
//   node tools/gift-codes.mjs --file work/tmp/codes.txt [--delay 800] [--account 2]
// 写操作，必须显式 CW_ALLOW_MUTATE=1 或 --yes（和 src/actions.mjs 的约定一致）。

import fs from 'node:fs';
import path from 'node:path';
import { GameClient, toNumber } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadStore, pickAccount, describeAccount } from '../src/accounts.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hasFlag(name) {
  return process.argv.includes(name);
}

function valueOf(flag) {
  const at = process.argv.indexOf(flag);
  if (at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')) return process.argv[at + 1];
  const hit = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

// 服务端拒绝时只推 PromptResponse{prompt:<枚举值>, args:[]}，不给文案。这几个码是本工具
// 唯一会遇到的取值，取自客户端 Prompt 枚举（chunks:///_virtual/proto-bundle.js）。
const PROMPT_TEXT = {
  63: '码已过期',
  64: '码无效',
  65: '该码已兑换过',
  66: '该批次码已被用完',
  67: '该码已被他人使用',
  70: '操作过于频繁',
};

function describePrompt(raw) {
  const text = String(raw ?? '').replace(/^server prompt:\s*/, '');
  const match = text.match(/prompt=(\d+)/);
  if (!match) return text;
  const label = PROMPT_TEXT[Number(match[1])];
  return label ? `${label}（prompt=${match[1]}）` : text;
}

function collectCodes() {
  const raw = process.argv.slice(2);
  // `--flag value` 的形式要把 value 从「码」里剔掉，否则 `--file x.txt` 的文件名、
  // `--delay 600` 的 600 都会被当成礼包码发出去（会浪费两次请求，日志也很乱）。
  const valueIndexes = new Set();
  for (const flag of ['--file', '--account', '--delay', '--window']) {
    const at = raw.indexOf(flag);
    if (at >= 0) valueIndexes.add(at + 1);
  }
  const inline = raw
    .filter((arg, index) => !arg.startsWith('--') && !valueIndexes.has(index))
    .flatMap((arg) => arg.split(','))
    .map((code) => code.trim())
    .filter(Boolean);

  const file = valueOf('--file');
  const fromFile = file
    ? fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
    : [];

  const seen = new Set();
  const codes = [];
  for (const code of [...inline, ...fromFile]) {
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function describeAsset(asset) {
  return `${asset.id}×${toNumber(asset.num)}`;
}

// GotRewardResponse 的形状：{ hero[], antique[], equipIds[], badge[], tickets[], reward:{ asset[] } }
function formatReward(body) {
  const parts = [];
  for (const asset of body?.reward?.asset ?? []) parts.push(describeAsset(asset));
  for (const hero of body?.hero ?? []) parts.push(`英雄:${hero.id ?? hero.heroId ?? '?'}`);
  for (const antique of body?.antique ?? []) parts.push(`藏品:${antique.id ?? '?'}`);
  for (const badge of body?.badge ?? []) parts.push(`徽章:${badge.id ?? '?'}`);
  for (const ticket of body?.tickets ?? []) parts.push(`券:${ticket.id ?? '?'}`);
  if (body?.equipIds?.length) parts.push(`装备×${body.equipIds.length}`);
  return parts.join(' ') || '(空奖励)';
}

function loadCredentials() {
  const store = loadStore();
  if (!store.accounts.length) throw new Error('还没有任何账号，先跑 node tools/capture-credentials.mjs 或在网页控制台扫码添加');
  const account = pickAccount(store, valueOf('--account') ?? process.env.CW_ACCOUNT ?? null);
  if (!account) throw new Error('选不出账号，用 --account <id|昵称|序号> 指定一个');
  return { account, url: account.url, login: account.login };
}

async function main() {
  const allowMutate = process.env.CW_ALLOW_MUTATE === '1' || hasFlag('--yes');
  if (!allowMutate) throw new Error('兑换会改变账号状态，重跑时加 --yes（或设 CW_ALLOW_MUTATE=1）');

  const codes = collectCodes();
  if (!codes.length) throw new Error('没有要兑换的码。用法：node tools/gift-codes.mjs VIP666,VIP777 或 --file codes.txt');

  const delayMs = Number(valueOf('--delay') ?? 800);
  const window = Number(valueOf('--window') ?? 900);
  const { account, url, login } = loadCredentials();
  const protocol = loadProtocol();
  console.log(`账号 ${describeAccount(account).title}（${account.id.slice(0, 8)}…），待兑 ${codes.length} 个码`);

  let client = null;
  const connect = async () => {
    if (client) client.stop();
    client = new GameClient({ url, protocol });
    client.on('warn', (message) => console.log(`warn: ${message}`));
    client.on('error', (error) => console.log(`warn: ${error.message}`));
    await client.connect(login);
  };
  await connect();

  const results = [];
  for (const [index, code] of codes.entries()) {
    const tag = `[${String(index + 1).padStart(2, '0')}/${codes.length}] ${code}`;
    // 连接被另一条进程挤掉时（网页控制台的挂机循环会抢同一条会话）先重连再发，
    // 但**已经发出去的那条不重试**：重试会拿到「已兑换」，把成功误判成失败。
    if (!client.connected) {
      console.log(`${tag} → 连接已断，重连后继续`);
      await connect();
    }

    const rewards = [];
    const onMessage = ({ name, body }) => {
      if (name === 'GotRewardResponse') rewards.push(body);
    };
    client.on('message', onMessage);

    let rejected = null;
    let sent = false;
    try {
      await client.sendWatch('GotGiftCodeRequest', { giftCode: code }, { window });
      sent = true;
    } catch (error) {
      rejected = error.message;
      sent = !/client stopped/i.test(error.message);
    }
    // 奖励推送可能比 prompt 窗口晚一点到，多等一小会儿再收网。
    await sleep(400);
    client.off('message', onMessage);

    let status;
    let detail;
    if (rewards.length) {
      status = '成功';
      detail = rewards.map(formatReward).join(' + ');
    } else if (rejected) {
      status = '失败';
      detail = describePrompt(rejected);
    } else if (client.connected) {
      status = '无回执';
      detail = '未收到 prompt 也没收到奖励（多为无效码）';
    } else {
      status = '未知';
      detail = '发出去后连接被挤断，没等到回执';
    }

    console.log(`${tag} → ${status}${detail ? ` ${detail}` : ''}`);
    results.push({ code, status, detail, sent, at: new Date().toISOString() });
    await sleep(delayMs);
  }

  client.stop();

  const ok = results.filter((entry) => entry.status === '成功');
  const failed = results.filter((entry) => entry.status !== '成功');
  console.log(`\n汇总：成功 ${ok.length} / ${results.length}，失败或未知 ${failed.length}`);
  if (ok.length) console.log(`可用码：${ok.map((entry) => entry.code).join(', ')}`);

  const stamp = new Date();
  const date = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`;
  const outDir = path.resolve(import.meta.dirname, '../outputs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `gift-codes-${date}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.md`);
  const lines = [
    `# 礼包码兑换结果（${date}）`,
    '',
    `账号：${describeAccount(account).title}`,
    `尝试 ${results.length} 个码，成功 ${ok.length} 个。`,
    '',
    '| # | 礼包码 | 结果 | 详情 |',
    '| --- | --- | --- | --- |',
    ...results.map((entry, index) => `| ${index + 1} | ${entry.code} | ${entry.status} | ${(entry.detail || '').replace(/\|/g, '/')} |`),
    '',
  ];
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`清单：${outPath}`);

  if (!ok.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
