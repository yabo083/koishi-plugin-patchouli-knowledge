import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { registerWebUi } from '../lib/index.js';
import { renderEntryMarkdown } from '../lib/wiki/engine.js';
import { plainText } from '../lib/wiki/plain-text.js';
import { toPublicView } from '../lib/wiki/public-view.js';

const TEST_ROOT = path.resolve('tmp/test-plain-text');
const BASE = '/patchouli';

const LEAKY_ARGUMENT = '敌方导弹和雷暴无法锁定隐匿目标 $\\rightarrow$ 攻击全部转移至可见队友 $\\rightarrow$ 队友承受双倍压力';

function createEntry(overrides = {}) {
  return {
    id: '2026-11-16-plain-text',
    title: '隐匿状态会对队友造成额外的生存压力',
    channelId: 'qq-group-100000001',
    date: '2026-11-16',
    status: 'tentative',
    tags: ['隐匿状态'],
    summary: '隐匿会让敌方攻击转移给队友。',
    background: '由队友输出骤降引起。',
    participants: ['汐见琴音'],
    debateMatrix: [
      {
        viewpoint: '隐匿状态会对队友造成额外的生存压力',
        proponents: ['汐见琴音'],
        opponents: [],
        arguments: [LEAKY_ARGUMENT],
        counterArguments: [],
      },
    ],
    consensus: ['严格不等式 $a \\le b$ 与同义写法 $a \\geq b$'],
    openQuestions: [],
    keyQuotes: [{ author: '汐见琴音', quote: '队友吃双倍雷暴' }],
    metadata: { messageCount: 14, participantCount: 1, durationMinutes: 6, peakRate: 3 },
    ...overrides,
  };
}

function createRouter() {
  const routes = new Map();
  const router = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
    use: () => {},
  };
  return { router, routes };
}

async function callRoute(routes, key, params = {}) {
  const handler = routes.get(key);
  assert.ok(handler, `路由 ${key} 必须注册`);
  const kCtx = { params, query: {}, request: {}, status: 200, body: undefined, set: () => {} };
  await handler(kCtx);
  return kCtx;
}

test.after(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('PLAIN-01: 内联数学摊平成 Unicode，成对美元之间的普通文本原样保留', () => {
  assert.equal(
    plainText('敌方导弹无法锁定隐匿目标 $\\rightarrow$ 攻击转移'),
    '敌方导弹无法锁定隐匿目标 → 攻击转移',
  );
  assert.equal(plainText('$\\le$ 20 且 $\\times$ 2'), '≤ 20 且 × 2');
  assert.equal(plainText('$$\\alpha \\times \\beta$$'), 'α × β');
  assert.equal(plainText('\\(x^{2} + H_2O\\)'), 'x^2 + H_2O');
  assert.equal(plainText('$\\text{空集}$ 记作 $\\varnothing$'), '空集 记作 ∅');
  // 成对美元之间没有 LaTeX 记号 ⇒ 视为普通文本（价格 / 变量），不动美元符
  assert.equal(plainText('价格 $5 到 $6 之间'), '价格 $5 到 $6 之间');
  assert.equal(plainText('没有数学内容'), '没有数学内容');
  const once = plainText(LEAKY_ARGUMENT);
  assert.equal(plainText(once), once, 'plainText 必须幂等');
});

test('PLAIN-02: 沉淀落盘时箭头已摊平，词条 Markdown 不再含 LaTeX', () => {
  const md = renderEntryMarkdown(createEntry({ narrative: '讨论由 $A \\to B$ 推进。' }));

  assert.ok(md.includes('→ 攻击全部转移'), '论据里的箭头必须落成 Unicode');
  assert.ok(md.includes('讨论由 A → B 推进。'), '脉络里的命令同样要摊平');
  assert.ok(!md.includes('\\rightarrow'), '正文不得残留 LaTeX 命令');
  assert.ok(!md.includes('\\to'), '正文不得残留 LaTeX 命令');
  assert.ok(!/\$\$?/u.test(md), '正文不得残留数学定界符');
});

test('PLAIN-03: 卡片视图（toPublicView）拿到的是纯文本论据', () => {
  const md = renderEntryMarkdown(createEntry());
  const view = toPublicView(
    {
      id: '2026-11-16-plain-text',
      title: '隐匿状态会对队友造成额外的生存压力',
      channelId: 'qq-group-100000001',
      date: '2026-11-16',
      status: 'tentative',
      tags: ['隐匿状态'],
      summary: '隐匿会让敌方攻击转移给队友。',
      participants: ['汐见琴音'],
      metadata: { messageCount: 14, participantCount: 1, durationMinutes: 6, peakRate: 3 },
      createdAt: 1,
      updatedAt: 2,
    },
    md,
  );

  const argument = view.debate?.[0]?.arguments?.[0] ?? '';
  assert.ok(argument.includes('→'), `论据应含 Unicode 箭头：${argument}`);
  assert.ok(!argument.includes('\\'), `论据不得残留 LaTeX：${argument}`);
  assert.deepEqual(view.consensus, ['严格不等式 a ≤ b 与同义写法 a ≥ b']);
});

test('PLAIN-04: 展厅详情接口（GET /api/entries/:id）同样摊平 LaTeX', async (t) => {
  const dir = path.join(TEST_ROOT, 'detail');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const mdPath = path.join(dir, '2026-11-16-plain-text.md');
  await fs.writeFile(mdPath, renderEntryMarkdown(createEntry()), 'utf8');

  const record = {
    id: '2026-11-16-plain-text',
    title: '隐匿状态会对队友造成额外的生存压力',
    channelId: 'qq-group-100000001',
    date: '2026-11-16',
    status: 'tentative',
    tags: ['隐匿状态'],
    summary: '隐匿会让敌方攻击转移给队友。',
    participants: ['汐见琴音'],
    metadata: { messageCount: 14, participantCount: 1, durationMinutes: 6, peakRate: 3 },
    path: mdPath,
    createdAt: 1,
    updatedAt: 2,
  };

  const { router, routes } = createRouter();
  registerWebUi(
    { router },
    { config: { channels: [] }, localStore: { getEntry: async (id) => (id === record.id ? record : undefined) }, wikiEngine: {} },
    BASE,
  );

  const kCtx = await callRoute(routes, `GET ${BASE}/api/entries/:id`, { id: record.id });
  const payload = kCtx.body;
  const argument = payload.debateMatrix?.[0]?.arguments?.[0] ?? '';
  assert.ok(argument.includes('→'), `详情论据应含 Unicode 箭头：${argument}`);
  assert.ok(!argument.includes('\\'), `详情论据不得残留 LaTeX：${argument}`);
  assert.deepEqual(payload.consensus, ['严格不等式 a ≤ b 与同义写法 a ≥ b']);
});
