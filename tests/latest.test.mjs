import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  LATEST_ENTRIES_LIMIT,
  LATEST_MESSAGE_MAX_CHARS,
  PatchouliKnowledgeSystem,
  registerWebUi,
} from '../lib/index.js';

const TMP_ROOT = path.resolve('tmp');

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
const offlineFetch = {
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
};

function makeSystem(wikiDir, channels = ['group-a'], enabled = true) {
  return new PatchouliKnowledgeSystem(
    {
      enabled,
      channels,
      notifyOnSummarized: false,
      trigger: { windowSizeSeconds: 60, burstMultiplier: 2, minBurstRate: 5, quiescenceSeconds: 3600 },
      dispatcher: { provider: 'custom', apiKey: 'mock-key', baseURL: 'https://mock.api/v1', customModel: 'gpt-4o-mini' },
      storage: { wikiDir },
    },
    quietLogger,
    undefined,
    offlineFetch,
  );
}

/** 注册路由并返回 `GET <base><route>` 处理器。 */
function mountRoutes(system, base = '/patchouli') {
  const routes = new Map();
  const middlewares = [];
  const router = {
    // 管理面守卫挂在 `use` 上；缺了它插件会 fail closed 跳过全部 /api 路由，这里照实记录。
    use: (route, middleware) => middlewares.push({ route, middleware }),
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };
  registerWebUi({ router }, system, base);
  return {
    status: routes.get(`GET ${base}/api/status`),
    latest: routes.get(`GET ${base}/api/latest`),
  };
}

function koaContext(query = {}) {
  return { params: {}, query, request: {}, status: 200, body: null, type: undefined, set: () => {} };
}

function entryFixture(index, channelId = 'group-a') {
  const day = String(index).padStart(2, '0');
  return {
    id: `latest-entry-${day}`,
    title: `最新轮播词条 ${day}`,
    channelId,
    date: `2026-01-${day}`,
    status: 'verified',
    tags: ['轮播'],
    summary: `第 ${day} 天的沉淀摘要`,
    background: '测试背景',
    participants: ['甲'],
    debateMatrix: [],
    consensus: ['共识'],
    openQuestions: [],
    keyQuotes: [],
    metadata: { messageCount: 12, participantCount: 1, durationMinutes: 5, peakRate: 3 },
  };
}

test('LATEST-01: /api/status 的最新消息只缓存被接受的群，无消息回传 null', async () => {
  const dir = path.join(TMP_ROOT, 'latest-status');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const system = makeSystem(dir, ['group-a']);
  const routes = mountRoutes(system);

  // 1. 尚无被接受消息：字段存在且严格为 null
  const emptyCtx = koaContext({ channelId: 'group-a' });
  await routes.status(emptyCtx);
  assert.ok('latestMessage' in emptyCtx.body, 'latestMessage 字段必须恒定存在');
  assert.equal(emptyCtx.body.latestMessage, null, '尚无被接受消息的群必须回传 null');
  assert.equal(system.getLatestMessage('group-a'), null);

  // 2. 白名单外的群消息连缓存都不产生（走 onIncomingMessage 实际接受路径）
  await system.onIncomingMessage({
    id: 'outside-1',
    channelId: 'group-b',
    userId: 'u9',
    userName: '乙',
    content: '白名单外的消息',
    timestamp: 1_700_000_001_000,
  });
  const outsideCtx = koaContext({ channelId: 'group-b' });
  await routes.status(outsideCtx);
  assert.equal(outsideCtx.body.latestMessage, null, '白名单外群聊不得进入最新消息缓存');
  assert.equal(system.getLatestMessage('group-b'), null);

  // 3. 白名单群：每群至多 1 条，后到者按接受顺序覆盖
  await system.onIncomingMessage({
    id: 'accepted-1',
    channelId: 'group-a',
    userId: 'u1',
    userName: '甲',
    content: '<img src="http://example.com/a.png"/> 第一条',
    timestamp: 1_700_000_002_000,
  });
  await system.onIncomingMessage({
    id: 'accepted-2',
    channelId: 'group-a',
    userId: 'u2',
    userName: '乙',
    content: '第二条',
    timestamp: 1_700_000_003_000,
  });

  const aCtx = koaContext({ channelId: 'group-a' });
  await routes.status(aCtx);
  assert.equal(aCtx.body.latestMessage.id, 'accepted-2', '最新消息必须是被接受的最后一条');
  assert.equal(aCtx.body.latestMessage.channelId, 'group-a', '最新消息必须跟随群筛选');
  assert.equal(aCtx.body.latestMessage.userName, '乙');
  assert.equal(aCtx.body.latestMessage.content, '第二条');
  assert.equal(aCtx.body.latestMessage.timestamp, 1_700_000_003_000);

  // 4. 缺省群 = 宿主配置的第一个频道；回传的必须属于该群，绝不串味
  const defaultCtx = koaContext({});
  await routes.status(defaultCtx);
  assert.equal(defaultCtx.body.channelId, 'group-a', '缺省群取宿主配置的第一个频道');
  assert.equal(defaultCtx.body.latestMessage.channelId, 'group-a', '缺省查询不得回传他群消息');
  assert.equal(defaultCtx.body.latestMessage.id, 'accepted-2');

  // 5. 全局关闭时接受路径直接短路
  const disabledDir = path.join(TMP_ROOT, 'latest-disabled');
  await fs.rm(disabledDir, { recursive: true, force: true });
  await fs.mkdir(disabledDir, { recursive: true });
  const disabled = makeSystem(disabledDir, ['group-a'], false);
  await disabled.onIncomingMessage({
    id: 'disabled-1',
    channelId: 'group-a',
    userId: 'u1',
    userName: '甲',
    content: '未启用时的消息',
    timestamp: 1_700_000_004_000,
  });
  assert.equal(disabled.getLatestMessage('group-a'), null, 'enabled=false 时不得缓存任何消息');

  // 6. 无持久化：即便仓储文件已落盘，最新消息也只驻留内存
  await system.localStore.saveEntry(
    entryFixture(1),
    path.join(dir, 'wiki', 'debates', 'latest-entry-01.md'),
  );
  await fs.access(system.localStore.path);
  const storeText = await fs.readFile(system.localStore.path, 'utf8');
  assert.ok(!storeText.includes('第二条'), '最新消息正文不得写入本地存储');
  assert.ok(!storeText.includes('accepted-2'), '最新消息 ID 不得写入本地存储');

  // 7. dispose 清空缓存（纯内存，无持久化）
  system.dispose();
  assert.equal(system.getLatestMessage('group-a'), null, 'dispose 后必须清空最新消息缓存');

  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(disabledDir, { recursive: true, force: true });
});

test('LATEST-02: 预览剥离 markup 给出纯文本提示，读取返回副本且不含 userId/raw', async () => {
  const dir = path.join(TMP_ROOT, 'latest-preview');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const system = makeSystem(dir, ['group-a']);
  const routes = mountRoutes(system);

  await system.onIncomingMessage({
    id: 'rich-1',
    channelId: 'group-a',
    userId: 'u-42',
    userName: '小明',
    content:
      '<at id="10001" name="小明"/> 看这个 <img src="http://example.com/huge.png"/> 加 <face id="14"/> ' +
      '<at type="all"/> <audio url="http://example.com/a.amr"/> <video url="http://example.com/v.mp4"/> ' +
      '<file name="report.pdf"/> <quote id="9"/> 完了 <b>粗体</b> <message id="7"><img src="http://example.com/f.png"/></message>',
    timestamp: 1_700_000_005_000,
    raw: { secret: 'koishi 事件对象' },
  });

  const latest = system.getLatestMessage('group-a');
  assert.equal(latest.userName, '小明', '必须保留发送者显示名');
  assert.equal(latest.timestamp, 1_700_000_005_000, '必须保留消息时间戳');
  assert.ok(latest.content.includes('@小明'), 'at 元素必须降级为 @名字');
  assert.ok(latest.content.includes('[图片]'), '图片必须降级为 [图片] 提示');
  assert.ok(latest.content.includes('[表情]'), '表情必须降级为 [表情] 提示');
  assert.ok(latest.content.includes('@全体成员'), 'at type=all 必须降级为 @全体成员');
  assert.ok(latest.content.includes('[语音]'), '语音必须降级为 [语音] 提示');
  assert.ok(latest.content.includes('[视频]'), '视频必须降级为 [视频] 提示');
  assert.ok(latest.content.includes('[文件]'), '文件必须降级为 [文件] 提示');
  assert.ok(latest.content.includes('[引用]'), '引用必须降级为 [引用] 提示');
  assert.ok(latest.content.includes('[合并转发]'), '合并转发必须降级为 [合并转发] 提示');
  assert.ok(latest.content.includes('粗体'), '成对标签内的正文必须保留');
  assert.ok(latest.content.includes('看这个'), '正文文本必须保留');
  assert.ok(!latest.content.includes('<'), '预览不得残留 markup 标签');
  assert.ok(!latest.content.includes('http://example.com'), '预览不得携带原始资源 URL');

  assert.deepEqual(
    Object.keys(latest).sort(),
    ['channelId', 'content', 'elements', 'id', 'timestamp', 'userName'],
    '最新消息只暴露 id / channelId / userName / content / timestamp / elements',
  );
  assert.equal('userId' in latest, false, '不得暴露 userId');
  assert.equal('raw' in latest, false, '不得保存 raw 事件对象');

  // 富元素：JSON 安全 AST，结构完整且绝不携带 userId / 原始 segment
  assert.ok(Array.isArray(latest.elements) && latest.elements.length > 0, 'elements 必须是非空数组');
  assert.ok(
    latest.elements.some((element) => element.type === 'text' && element.text.includes('@小明')),
    'at 元素必须归一化为文本元素',
  );
  assert.ok(
    latest.elements.some((element) => element.type === 'image'),
    '图片必须保留为 image 元素（而非只降级成文本）',
  );
  assert.ok(
    latest.elements.some((element) => element.type === 'forward'),
    '合并转发必须保留为 forward 元素',
  );
  assert.ok(
    latest.elements.some((element) => element.type === 'quote' && element.targetMessageId === '9'),
    '引用必须保留 targetMessageId',
  );
  const serialized = JSON.stringify(latest.elements);
  assert.ok(!serialized.includes('u-42'), '元素 AST 不得泄漏 userId');
  assert.ok(!serialized.includes('"attrs"'), '元素 AST 不得残留 Koishi 原始 attrs');
  assert.deepEqual(JSON.parse(serialized), latest.elements, '元素 AST 必须可无损 JSON 往返');

  // 实体反转义与空白折叠（前端以 textContent 渲染，字面 < 是安全的）
  await system.onIncomingMessage({
    id: 'rich-2',
    channelId: 'group-a',
    userId: 'u-43',
    userName: '小红',
    content: '  第一行\n第二行 &lt;b&gt; &amp; 收尾  ',
    timestamp: 1_700_000_006_000,
  });
  assert.equal(system.getLatestMessage('group-a').content, '第一行 第二行 <b> & 收尾');

  // 读取必须返回副本：外部修改不得污染内部缓存
  const first = system.getLatestMessage('group-a');
  const second = system.getLatestMessage('group-a');
  assert.notEqual(first, second, '每次读取都必须返回新的副本对象');
  first.content = '被污染的文本';
  first.userName = '被污染的名字';
  assert.equal(system.getLatestMessage('group-a').content, '第一行 第二行 <b> & 收尾', '外部修改不得污染缓存');
  assert.equal(system.getLatestMessage('group-a').userName, '小红', '外部修改不得污染缓存');

  // 同一份副本也经过 HTTP 层：篡改响应体不得影响下一次轮询
  const ctx = koaContext({ channelId: 'group-a' });
  await routes.status(ctx);
  ctx.body.latestMessage.content = 'HTTP 层被污染';
  ctx.body.latestMessage.elements[0] = { type: 'text', text: 'HTTP 层被污染的富元素' };
  const again = koaContext({ channelId: 'group-a' });
  await routes.status(again);
  assert.equal(again.body.latestMessage.content, '第一行 第二行 <b> & 收尾', '响应中的最新消息必须是副本');
  assert.notEqual(
    again.body.latestMessage.elements[0].text,
    'HTTP 层被污染的富元素',
    '响应中的富元素必须每次重新构造，篡改不得污染缓存',
  );

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('LATEST-03: 超长 markup 预览截断到上限且不撕裂代理对', async () => {
  const dir = path.join(TMP_ROOT, 'latest-truncate');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const system = makeSystem(dir, ['group-a']);

  // 1. 超长图片 markup + 超长正文：恰好截到上限，图片提示保留在开头
  await system.onIncomingMessage({
    id: 'huge-1',
    channelId: 'group-a',
    userId: 'u1',
    userName: '甲',
    content: `<img src="http://example.com/${'a'.repeat(5000)}.png"/>${'长'.repeat(3000)}`,
    timestamp: 1_700_000_007_000,
  });
  const huge = system.getLatestMessage('group-a').content;
  assert.equal(Array.from(huge).length, LATEST_MESSAGE_MAX_CHARS, '超长预览必须恰好截到上限');
  assert.ok(huge.startsWith('[图片]长'), '截断必须保留开头的占位提示');
  assert.ok(huge.endsWith('…'), '截断必须以省略号收尾');
  assert.ok(!huge.includes('http://'), '截断后不得残留图片原始 markup');

  // 2. 代理对安全：按码点截断，不产生孤立代理项
  await system.onIncomingMessage({
    id: 'huge-2',
    channelId: 'group-a',
    userId: 'u1',
    userName: '甲',
    content: '😀'.repeat(2000),
    timestamp: 1_700_000_008_000,
  });
  const emoji = system.getLatestMessage('group-a').content;
  assert.equal(Array.from(emoji).length, LATEST_MESSAGE_MAX_CHARS, '代理对必须按码点计数');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(emoji), '不得产生孤立代理项');

  // 3. 上限之内的文本原样保留（不无谓加省略号）
  await system.onIncomingMessage({
    id: 'short-1',
    channelId: 'group-a',
    userId: 'u1',
    userName: '甲',
    content: '短消息',
    timestamp: 1_700_000_009_000,
  });
  assert.equal(system.getLatestMessage('group-a').content, '短消息');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('LATEST-04: /api/latest 按最新排序、limit 收敛转交、不受群筛选与关键词影响', async () => {
  const dir = path.join(TMP_ROOT, 'latest-entries');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const system = makeSystem(dir, ['group-a']);
  // 25 条词条，日期递增（01 最旧、25 最新），跨两个群聊交替沉淀
  for (let index = 1; index <= 25; index += 1) {
    const channelId = index % 2 === 0 ? 'group-b' : 'group-a';
    await system.localStore.saveEntry(entryFixture(index, channelId), path.join(dir, 'wiki', 'debates', `latest-entry-${index}.md`));
  }

  const routes = mountRoutes(system);

  // 1. 缺省 limit：全局最新在前，且跨群（不受群筛选影响）
  const defaultCtx = koaContext();
  await routes.latest(defaultCtx);
  const defaultIds = defaultCtx.body.map((record) => record.id);
  assert.ok(Array.isArray(defaultCtx.body), '/api/latest 必须直接回传词条数组');
  assert.equal(defaultIds.length, LATEST_ENTRIES_LIMIT, '缺省 limit 必须为 20');
  assert.deepEqual(
    defaultIds,
    Array.from({ length: LATEST_ENTRIES_LIMIT }, (_, offset) => `latest-entry-${String(25 - offset).padStart(2, '0')}`),
    '必须按最新时间倒序',
  );
  assert.ok(defaultCtx.body.some((record) => record.channelId === 'group-b'), '必须独立于群筛选（跨群汇总）');

  // 2. 查询串里的群聊与关键词一律被忽略（独立于词条索引的筛选）
  const filteredCtx = koaContext({ channelId: 'group-a', keyword: '完全不相关的关键词', scope: 'meta' });
  await routes.latest(filteredCtx);
  assert.deepEqual(filteredCtx.body.map((record) => record.id), defaultIds, 'latest 必须独立于关键词与群过滤');

  // 3. limit 实际转交：截取最近 N 条
  const threeCtx = koaContext({ limit: '3' });
  await routes.latest(threeCtx);
  assert.deepEqual(
    threeCtx.body.map((record) => record.id),
    ['latest-entry-25', 'latest-entry-24', 'latest-entry-23'],
    'limit=3 必须截取最近 3 条',
  );

  // 4. limit 越界收敛：上限 20、下限 1、非法值回落 20
  const overCtx = koaContext({ limit: '9999' });
  await routes.latest(overCtx);
  assert.equal(overCtx.body.length, LATEST_ENTRIES_LIMIT, 'limit 上限必须收敛为 20');

  const zeroCtx = koaContext({ limit: '0' });
  await routes.latest(zeroCtx);
  assert.deepEqual(zeroCtx.body.map((record) => record.id), ['latest-entry-25'], 'limit 下限必须收敛为 1');

  const garbageCtx = koaContext({ limit: 'abc' });
  await routes.latest(garbageCtx);
  assert.equal(garbageCtx.body.length, LATEST_ENTRIES_LIMIT, '非法 limit 必须回落为 20');

  // 5. 重复沉淀同一 id 不得在轮播里出现两行
  await system.localStore.saveEntry(entryFixture(25, 'group-a'));
  const refreshed = koaContext({ limit: '20' });
  await routes.latest(refreshed);
  const refreshedIds = refreshed.body.map((record) => record.id);
  assert.equal(new Set(refreshedIds).size, refreshedIds.length, '轮播不得出现重复词条');
  assert.equal(refreshedIds[0], 'latest-entry-25', '重复沉淀后最新词条仍排首位');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

