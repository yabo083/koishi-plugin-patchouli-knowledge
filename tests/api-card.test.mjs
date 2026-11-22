import test from 'node:test';
import assert from 'node:assert/strict';

import { WikiEngine, registerWebUi } from '../lib/index.js';

const ENTRY = {
  id: '2026-11-10-card-entry',
  title: '张三的 123456789 观察',
  channelId: 'qq-group-9001',
  date: '2026-11-10',
  status: 'tentative',
  tags: ['长图导出'],
  summary: '@张三 提出 QQ 123456789 的疑问。',
  background: '背景。',
  participants: ['张三'],
  debateMatrix: [
    {
      viewpoint: '导出必须脱敏',
      proponents: ['张三'],
      opponents: ['李四'],
      arguments: ['出图会离开群聊边界'],
      counterArguments: ['脱敏后指代仍要一致'],
    },
  ],
  consensus: ['导出前统一脱敏'],
  openQuestions: ['昵称与号码的稳定映射如何洗牌'],
  keyQuotes: [{ author: '张三', quote: '出了群就是公开的了。' }],
  metadata: { messageCount: 12, participantCount: 2, durationMinutes: 5, peakRate: 3.2 },
};

const RECORD = {
  id: ENTRY.id,
  title: ENTRY.title,
  channelId: ENTRY.channelId,
  date: ENTRY.date,
  status: ENTRY.status,
  tags: [...ENTRY.tags],
  summary: ENTRY.summary,
  participants: [...ENTRY.participants],
  metadata: { ...ENTRY.metadata },
  path: 'tmp/does-not-exist.md',
  createdAt: 1,
  updatedAt: 2,
};

/** 假页面：记录 setContent 收到的 HTML 与截图参数。 */
function createFakePage(htmls, shots = []) {
  return {
    setContent: async (html) => {
      htmls.push(html);
    },
    setViewport: async () => {},
    evaluate: async () => 1200,
    screenshot: async (options) => {
      shots.push(options ?? {});
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    },
    close: async () => {},
  };
}

function buildHarness({ puppeteer } = {}) {
  const routes = new Map();
  const middlewares = [];
  const router = {
    // 管理面守卫挂在 `use` 上；缺了它插件会 fail closed 跳过全部 /api 路由，这里照实记录。
    use: (route, middleware) => middlewares.push({ route, middleware }),
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };
  const system = {
    config: { channels: [] },
    media: { take: async () => undefined },
    cardSequence: { allocate: async () => 1 },
    localStore: { getEntry: async (id) => (id === ENTRY.id ? RECORD : undefined) },
    wikiEngine: { readEntry: async (id) => (id === ENTRY.id ? '# 标题\n\n正文' : undefined) },
    detector: { getStatus: () => ({}), getOptions: () => ({}) },
    dispatcher: { route: 'chatluna', model: '', hasExplicitModel: false, chatUrl: '', probe: async () => ({}) },
    // 出图选项：默认匿名化开启（与生产一致）
    getCardSettings: () => ({ maskNames: true }),
  };
  const host = { router };
  if (puppeteer !== undefined) host.puppeteer = puppeteer;
  registerWebUi(host, system, '/patchouli');
  return { routes, handler: (path) => routes.get(path) };
}

/** 构造 Koa 上下文的最小面。 */
function koaContext(params) {
  return { params, query: {}, request: {}, status: 200, body: undefined, type: undefined, set: () => {} };
}

test('API-CARD-01: /api/card/:id 校验 id 与词条存在性', async () => {
  const { handler } = buildHarness();
  assert.ok(handler('GET /patchouli/api/card/:id'), '长图路由必须注册在管理面');

  const empty = koaContext({ id: '   ' });
  await handler('GET /patchouli/api/card/:id')(empty);
  assert.equal(empty.status, 400);

  const missing = koaContext({ id: 'nope' });
  await handler('GET /patchouli/api/card/:id')(missing);
  assert.equal(missing.status, 404);
});

test('API-CARD-02: 宿主没有 puppeteer 时返回 503 且不伪造图片', async () => {
  const { handler } = buildHarness();
  const kCtx = koaContext({ id: ENTRY.id });
  await handler('GET /patchouli/api/card/:id')(kCtx);

  assert.equal(kCtx.status, 503);
  assert.match(String(kCtx.type), /text\/plain/u);
  assert.equal(Buffer.isBuffer(kCtx.body), false, '不得返回任何二进制图片');
});

test('API-CARD-03: 有 puppeteer 时出 JPEG 长图，且渲染内容已脱敏', async () => {
  const htmls = [];
  const shots = [];
  const page = createFakePage(htmls, shots);
  const { handler } = buildHarness({ puppeteer: { page: async () => page } });

  const kCtx = koaContext({ id: ENTRY.id });
  await handler('GET /patchouli/api/card/:id')(kCtx);

  assert.equal(kCtx.status, 200);
  assert.equal(kCtx.type, 'image/jpeg', '长图走 JPEG（同画质体积约 PNG 的 1/4）');
  assert.ok(Buffer.isBuffer(kCtx.body), '必须返回图片缓冲区');
  assert.equal(htmls.length, 1, '渲染一次长图 HTML');
  assert.equal(shots[0]?.type, 'jpeg', '截图必须显式要求 jpeg');

  const html = htmls[0];
  assert.ok(!html.includes('张三'), '出图前必须脱敏：真实昵称不得出现在 HTML 里');
  assert.ok(!html.includes('123456789'), '出图前必须脱敏：真实号码不得出现');
  assert.ok(html.includes('>#1<'), '页眉显示独立自然数序号');
  assert.ok(!/<a\s|https?:\/\//u.test(html), '长图不含任何 URL / 锚点');
});
