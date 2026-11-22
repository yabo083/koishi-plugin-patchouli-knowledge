import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import * as path from 'node:path';

import {
  MediaRegistry,
  PatchouliKnowledgeSystem,
  collectMediaUrls,
  createMediaProxyHandler,
  isAllowedMediaType,
  isPrivateOrLocalHost,
  isProxyRequiredMediaUrl,
  mapElementMediaUrls,
  parseRichElements,
  registerWebUi,
  sanitizeMediaUrl,
  summarizeRichElements,
  textFallbackElements,
} from '../lib/index.js';

const TMP_ROOT = path.resolve('tmp');
const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeSystem(wikiDir, channels = ['group-a']) {
  return new PatchouliKnowledgeSystem(
    {
      enabled: true,
      channels,
      notifyOnSummarized: false,
      trigger: { windowSizeSeconds: 60, burstMultiplier: 2, minBurstRate: 5, quiescenceSeconds: 3600 },
      dispatcher: { provider: 'custom', apiKey: 'mock-key', baseURL: 'https://mock.api/v1', customModel: 'gpt-4o-mini' },
      storage: { wikiDir },
    },
    quietLogger,
    undefined,
    { fetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }) },
  );
}

async function makeTmpSystem(name, channels = ['group-a']) {
  const dir = path.join(TMP_ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return { system: makeSystem(dir, channels), dir };
}

function message(overrides = {}) {
  return {
    id: 'msg-1',
    channelId: 'group-a',
    userId: 'u-1',
    userName: '甲',
    content: '你好',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** 注册路由并返回处理器映射（含媒体代理路由）。 */
function mountRoutes(system, options = {}, base = '/patchouli') {
  const routes = new Map();
  const middlewares = [];
  const router = {
    // 管理面守卫挂在 `use` 上；缺了它插件会 fail closed 跳过全部 /api 路由，这里照实记录。
    use: (route, middleware) => middlewares.push({ route, middleware }),
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };
  registerWebUi({ router }, system, base, options);
  return {
    status: routes.get(`GET ${base}/api/status`),
    media: routes.get(`GET ${base}/api/media/:id`),
  };
}

function koaContext({ query = {}, params = {}, headers = {} } = {}) {
  const responseHeaders = {};
  return {
    ctx: {
      params,
      query,
      headers,
      request: { headers, body: undefined },
      req: { headers },
      res: {},
      status: 200,
      body: null,
      type: undefined,
      set: (name, value) => {
        responseHeaders[name.toLowerCase()] = value;
      },
    },
    responseHeaders,
  };
}

function jsonSegment(payload) {
  return { type: 'json', data: { data: JSON.stringify(payload) } };
}

/* ------------------------------------------------------------------ *
 * RICH-01 元素归一化（原始 OneBot 段优先）
 * ------------------------------------------------------------------ */

test('RICH-01: 原始 OneBot 段归一化为 JSON 安全元素 AST，且不暴露 userId', async () => {
  const { system, dir } = await makeTmpSystem('rich-normalize');
  const rawMessage = [
    { type: 'text', data: { text: '你好&#91;CQ&#93;' } },
    { type: 'at', data: { qq: '10001', name: '小明' } },
    { type: 'at', data: { qq: 'all' } },
    { type: 'at', data: { qq: '10002' } },
    { type: 'face', data: { id: '14', name: '微笑' } },
    { type: 'image', data: { url: 'https://gchat.qpic.cn/a.png', file: 'a.image' } },
    { type: 'image', data: { file: 'b.image' } },
    { type: 'record', data: { url: 'https://cdn.example.com/a.silk', duration: '3' } },
    { type: 'video', data: { url: 'https://cdn.example.com/v.mp4', cover: 'https://cdn.example.com/v.jpg' } },
    { type: 'file', data: { name: 'report.pdf', url: 'https://cdn.example.com/report.pdf' } },
    { type: 'reply', data: { id: '9001' } },
    { type: 'forward', data: { id: 'resid-1' } },
    jsonSegment({
      app: 'com.tencent.structmsg',
      meta: { news: { title: '新闻标题', desc: '新闻摘要', jumpUrl: 'https://example.com/news', preview: 'https://example.com/p.png' } },
    }),
    { type: 'share', data: { title: '分享标题', content: '分享内容', url: 'https://example.com/s' } },
    { type: 'music', data: { type: 'custom', title: '歌名', url: 'https://example.com/music' } },
    { type: 'location', data: { title: '某地', content: '某街道 1 号', lat: 31.2, lon: 121.5 } },
    { type: 'contact', data: { type: 'group', name: '测试群' } },
    { type: 'dice', data: { result: 4 } },
    { type: 'rps', data: { result: 2 } },
    { type: 'poke', data: { name: '小红' } },
    { type: 'markdown', data: { content: '正文标题' } },
    { type: 'mystery', data: {} },
  ];

  await system.onIncomingMessage(message({ id: 'rich-1', content: '你好' }), { rawMessage });
  const latest = system.getLatestMessage('group-a');

  assert.deepEqual(
    latest.elements.map((element) => element.type),
    [
      'text',
      'text',
      'text',
      'text',
      'face',
      'image',
      'image',
      'record',
      'video',
      'file',
      'quote',
      'forward',
      'card',
      'card',
      'card',
      'card',
      'card',
      'text',
      'text',
      'text',
      'text',
      'unknown',
    ],
    '每种 OneBot 段都必须映射到契约内的元素类型',
  );

  const [greeting, atName, atAll, atAnon, face, image, fileOnly, record, video, file] = latest.elements;
  assert.equal(greeting.text, '你好[CQ]', 'CQ 实体必须反转义');
  assert.equal(atName.text, '@小明');
  assert.equal(atAll.text, '@全体成员');
  assert.equal(atAnon.text, '@成员', '只有 QQ 号时不得暴露 userId');
  assert.equal(face.text, '[表情 微笑]');
  assert.equal(image.url, 'https://gchat.qpic.cn/a.png');
  assert.equal(image.text, '[图片]');
  assert.equal(fileOnly.url, undefined, '无 url 且无 resolver 时不得伪造图片地址');
  assert.equal(fileOnly.text, '[图片]');
  assert.equal(record.url, 'https://cdn.example.com/a.silk');
  assert.equal(record.duration, 3);
  assert.equal(video.url, 'https://cdn.example.com/v.mp4');
  assert.equal(video.imageUrl, 'https://cdn.example.com/v.jpg');
  assert.equal(file.text, '[文件] report.pdf');
  assert.equal(file.url, 'https://cdn.example.com/report.pdf');
  assert.equal(latest.elements[10].targetMessageId, '9001');
  assert.equal(latest.elements[11].title, '合并转发');
  assert.equal(latest.elements[12].title, '新闻标题');
  assert.equal(latest.elements[12].url, 'https://example.com/news');
  assert.equal(latest.elements[12].imageUrl, 'https://example.com/p.png');
  assert.equal(latest.elements[13].source, 'share');
  assert.equal(latest.elements[14].source, 'music');
  assert.equal(latest.elements[15].source, 'location');
  assert.match(latest.elements[15].url, /^https:\/\/www\.openstreetmap\.org\//u);
  assert.equal(latest.elements[16].title, '[推荐群聊]');
  assert.equal(latest.elements[17].text, '[骰子 4]');
  assert.equal(latest.elements[18].text, '[猜拳 剪刀]');
  assert.equal(latest.elements[19].text, '[戳一戳 小红]');
  assert.equal(latest.elements[21].text, '[消息]');

  const serialized = JSON.stringify(latest.elements);
  assert.ok(!serialized.includes('10001'), '元素 AST 不得泄漏 at 的 QQ 号');
  assert.ok(!serialized.includes('10002'), '元素 AST 不得泄漏裸 QQ 号');
  assert.ok(Object.isFrozen(latest.elements), '缓存中的元素树必须深冻结');
  assert.equal(summarizeRichElements(latest.elements).includes('你好[CQ]'), true);

  // 兜底：无任何输入时 elements 仍为非空数组，且 content 摘要保留
  await system.onIncomingMessage(message({ id: 'rich-2', content: '纯文本兜底' }));
  const plain = system.getLatestMessage('group-a');
  assert.deepEqual(plain.elements, [{ type: 'text', text: '纯文本兜底' }]);
  assert.equal(plain.content, '纯文本兜底');

  await system.onIncomingMessage(message({ id: 'rich-3', content: '<img src="https://gchat.qpic.cn/x.png"/>' }));
  const imageOnly = system.getLatestMessage('group-a');
  assert.equal(imageOnly.content, '[图片]', '纯图片消息的 content 摘要必须可读');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-02 媒体地址安全
 * ------------------------------------------------------------------ */

test('RICH-02: 媒体地址只放行公网 http(s)，拒绝 data/file/本地/私网/端口/凭据', () => {
  assert.equal(sanitizeMediaUrl('https://gchat.qpic.cn/a.png'), 'https://gchat.qpic.cn/a.png');
  assert.equal(sanitizeMediaUrl('  http://198.51.100.7/a.png  '), 'http://198.51.100.7/a.png');

  for (const blocked of [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/1234',
    'file:///path/to/koishi/data/a.png',
    'C:\\Users\\x\\a.png',
    '/path/to/koishi/data/a.png',
    '../secret.png',
    'abc.image',
    '//example.com/a.png',
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://192.168.1.5/a.png',
    'http://10.0.0.1/a.png',
    'http://172.16.3.4/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://198.18.1.1/benchmark.png',
    'http://100.64.1.1/cgnat.png',
    'http://[::1]/a.png',
    'http://nuc/a.png',
    'https://desktop.local/a.png',
    'https://internal.lan/a.png',
    'http://example.com:8443/a.png',
    'http://user:pass@example.com/a.png',
  ]) {
    assert.equal(sanitizeMediaUrl(blocked), undefined, `${blocked} 必须被拒绝`);
  }

  assert.equal(isPrivateOrLocalHost('93.184.216.34'), false);
  assert.equal(isPrivateOrLocalHost('127.0.0.1'), true);
  assert.equal(isPrivateOrLocalHost('desktop'), true);

  assert.equal(isProxyRequiredMediaUrl('http://198.51.100.7/a.png'), true);
  assert.equal(isProxyRequiredMediaUrl('https://gchat.qpic.cn/a.png'), false);
  assert.equal(isProxyRequiredMediaUrl('javascript:alert(1)'), false);

  const registry = new MediaRegistry(4);
  assert.equal(registry.register('group-a', 'http://127.0.0.1/a.png'), undefined, '私网地址不得进入登记表');
  assert.equal(registry.register('group-a', 'data:image/png;base64,AAAA'), undefined);
  assert.equal(registry.size, 0);
  assert.equal(registry.resolve('deadbeefdeadbeefdeadbeefdeadbeef'), undefined);

  assert.equal(isAllowedMediaType('image/png'), true);
  assert.equal(isAllowedMediaType('video/mp4'), true);
  assert.equal(isAllowedMediaType('application/octet-stream'), true);
  assert.equal(isAllowedMediaType('image/svg+xml'), false, 'SVG 是 active content，必须拒绝');
  assert.equal(isAllowedMediaType('text/html'), false);
  assert.equal(isAllowedMediaType('text/plain'), false);

  assert.deepEqual(textFallbackElements('   '), [{ type: 'unknown', text: '[消息]' }]);
  assert.deepEqual(mapElementMediaUrls([{ type: 'image', url: 'http://a.example.com/x.png' }], () => '/proxy/1'), [
    { type: 'image', url: '/proxy/1' },
  ]);
  assert.deepEqual(mapElementMediaUrls([{ type: 'image', url: 'http://a.example.com/x.png' }], () => undefined), [
    { type: 'image' },
  ]);
});

/* ------------------------------------------------------------------ *
 * RICH-03 只读 resolver（forward / quote / image）
 * ------------------------------------------------------------------ */

function readonlyBot(overrides = {}) {
  return {
    get_image: async (file) => ({ url: `https://cdn.example.com/${file}.png`, file }),
    get_msg: async (id) => ({
      message: [{ type: 'text', data: { text: `被引用的消息 ${id}` } }],
      sender: { nickname: '小刚' },
    }),
    get_forward_msg: async (id) => [
      { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: `转发一 ${id}` } }] },
      {
        sender: { nickname: '乙' },
        message: [{ type: 'text', data: { text: '转发二' } }, { type: 'image', data: { url: 'https://cdn.example.com/f.png' } }],
      },
    ],
    ...overrides,
  };
}

test('RICH-03: 只读 action 展开图片 / 引用 / 合并转发，失败给出可见 error 文本', async () => {
  const { system, dir } = await makeTmpSystem('rich-resolve');

  const rawMessage = [
    { type: 'image', data: { file: 'pic1' } },
    { type: 'reply', data: { id: 'm-1' } },
    { type: 'forward', data: { id: 'f-1' } },
  ];
  const calls = [];
  const bot = readonlyBot({
    get_image: async (file) => {
      calls.push(['get_image', file]);
      return { url: `https://cdn.example.com/${file}.png` };
    },
    get_msg: async (id) => {
      calls.push(['get_msg', id]);
      return { message: [{ type: 'text', data: { text: `被引用的消息 ${id}` } }], sender: { nickname: '小刚' } };
    },
    get_forward_msg: async (id) => {
      calls.push(['get_forward_msg', id]);
      return [
        { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: `转发一 ${id}` } }] },
        {
          sender: { nickname: '乙' },
          message: [
            { type: 'text', data: { text: '转发二' } },
            { type: 'image', data: { url: 'https://cdn.example.com/f.png' } },
          ],
        },
      ];
    },
  });

  await system.onIncomingMessage(message({ id: 'rich-resolve-1' }), {
    onebot: bot,
    rawMessage,
    quote: { id: 'q-1', content: '引用正文', user: { name: '小蓝' } },
  });
  const latest = system.getLatestMessage('group-a');
  const [quote, image, reply, forward] = latest.elements;

  assert.equal(quote.type, 'quote');
  assert.equal(quote.title, '小蓝');
  assert.equal(quote.text, '引用正文');
  assert.equal(quote.targetMessageId, 'q-1');

  assert.equal(image.type, 'image');
  assert.equal(image.url, 'https://cdn.example.com/pic1.png', 'file 必须经只读 get_image 解析为真实 URL');

  assert.equal(reply.type, 'quote');
  assert.equal(reply.title, '小刚');
  assert.equal(reply.text, '被引用的消息 m-1');
  assert.equal(reply.targetMessageId, 'm-1');

  assert.equal(forward.type, 'forward');
  assert.equal(forward.items.length, 2);
  assert.equal(forward.items[0].title, '甲');
  assert.deepEqual(forward.items[0].elements, [{ type: 'text', text: '转发一 f-1' }]);
  assert.equal(forward.items[1].elements[1].url, 'https://cdn.example.com/f.png');
  assert.ok(forward.text.includes('甲：转发一 f-1'), 'forward.text 必须给出可读摘要');
  assert.deepEqual(
    calls.map(([action]) => action).sort(),
    ['get_forward_msg', 'get_image', 'get_msg'],
    '只调用白名单内的只读 action',
  );
  assert.ok(!JSON.stringify(latest.elements).includes('user_id'), '展开结果不得携带 OneBot 原始 sender 字段');

  // 失败路径：resolver 抛错 → 元素保留类型 + 可见 error 文本，绝不造假 URL
  const failing = readonlyBot({
    get_image: async () => {
      throw new Error('get_image 失败');
    },
    get_msg: async () => {
      throw new Error('get_msg 失败');
    },
    get_forward_msg: async () => {
      throw new Error('get_forward_msg 失败');
    },
  });
  const warnings = [];
  const elements = await parseRichElements(
    { onebot: failing, rawMessage, content: '' },
    { warn: (text) => warnings.push(text) },
  );
  assert.equal(elements[0].type, 'image');
  assert.equal(elements[0].text, '[图片]（解析失败）');
  assert.equal(elements[0].url, undefined);
  assert.equal(elements[1].text, '[引用]（解析失败）');
  assert.equal(elements[2].text, '[合并转发]（展开失败）');
  assert.equal(warnings.length, 3, '失败必须被记录（不吞错假成功）');

  // 只读通道缺失时保持摘要，不抛错
  const withoutResolver = await parseRichElements({ rawMessage, content: '' });
  assert.equal(withoutResolver[2].text, '[合并转发]');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('RICH-03b: 只读通道白名单拒绝写操作，_request 校验 retcode', async () => {
  const { system, dir } = await makeTmpSystem('rich-readonly');
  const invoked = [];
  const bot = {
    _get: async (action, params) => {
      invoked.push([action, params]);
      if (action === 'get_forward_msg') return { messages: [{ sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: 'ok' } }] }] };
      return { url: 'https://cdn.example.com/x.png' };
    },
    send_msg: async () => {
      throw new Error('只读通道不得发送消息');
    },
    _request: async () => {
      throw new Error('_request 不应被调用');
    },
  };

  await system.onIncomingMessage(message({ id: 'readonly-1' }), {
    onebot: bot,
    rawMessage: [{ type: 'image', data: { file: 'x' } }, { type: 'forward', data: { id: 'f' } }],
  });
  const latest = system.getLatestMessage('group-a');
  assert.equal(latest.elements[0].url, 'https://cdn.example.com/x.png');
  assert.equal(latest.elements[1].items[0].elements[0].text, 'ok');
  assert.deepEqual(invoked.map(([action]) => action), ['get_image', 'get_forward_msg']);
  assert.equal(invoked[0][1].file, 'x');
  assert.equal(invoked[1][1].id, 'f', 'get_forward_msg 必须用标准 id 参数（兼容非数字 resid）');

  // _request 回退：retcode 非 0 必须视为失败而不是假成功
  const retcodeBot = {
    _request: async () => ({ status: 'failed', retcode: 1404, data: null }),
  };
  const elements = await parseRichElements(
    { onebot: retcodeBot, rawMessage: [{ type: 'image', data: { file: 'y' } }], content: '' },
    { warn: () => {} },
  );
  assert.equal(elements[0].text, '[图片]（解析失败）');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-04 上限与截断（明示，不假成功）
 * ------------------------------------------------------------------ */

test('RICH-04: 转发节点 / 递归深度 / 顶层元素 / 文本长度上限均明示截断', async () => {
  const { system, dir } = await makeTmpSystem('rich-caps');

  const manyNodes = Array.from({ length: 5 }, (_, index) => ({
    sender: { nickname: `群友${index}` },
    message: [{ type: 'text', data: { text: `第 ${index} 条` } }],
  }));
  const capped = await parseRichElements(
    { onebot: { get_forward_msg: async () => manyNodes }, rawMessage: [{ type: 'forward', data: { id: 'f' } }], content: '' },
    { maxForwardNodes: 2 },
  );
  assert.equal(capped[0].items.length, 3, '2 条节点 + 1 条截断提示');
  assert.match(capped[0].items[2].elements[0].text, /共 5 条转发，仅展开前 2 条/u);

  // 递归深度：top(1) → f1(2) → f2(3) → f3 拒绝展开
  const nested = {
    get_forward_msg: async (id) => [
      {
        sender: { nickname: '甲' },
        message: id === 'f3' ? [{ type: 'text', data: { text: '最深层' } }] : [{ type: 'forward', data: { id: id === 'f1' ? 'f2' : 'f3' } }],
      },
    ],
  };
  const deep = await parseRichElements({ onebot: nested, rawMessage: [{ type: 'forward', data: { id: 'f1' } }], content: '' });
  assert.match(JSON.stringify(deep), /层级过深/u, '超过深度上限必须明示未展开');

  const manySegments = Array.from({ length: 100 }, (_, index) => ({ type: 'text', data: { text: `第${index}段` } }));
  const cappedTop = await parseRichElements({ rawMessage: manySegments, content: '' }, { maxElements: 10 });
  assert.equal(cappedTop.length, 10);
  assert.match(cappedTop[9].text, /已截断，共 100 段元素/u);

  const longText = await parseRichElements({ rawMessage: [{ type: 'text', data: { text: '长'.repeat(5000) } }], content: '' }, { textLimit: 100 });
  assert.equal(Array.from(longText[0].text).length, 100);
  assert.ok(longText[0].text.endsWith('…'));

  // 只读 action 总次数上限：超限的解析按失败处理（不静默假成功）
  const budgeted = await parseRichElements(
    {
      onebot: { get_image: async (file) => ({ url: `https://cdn.example.com/${file}.png` }) },
      rawMessage: [{ type: 'image', data: { file: 'a' } }, { type: 'image', data: { file: 'b' } }],
      content: '',
    },
    { maxResolves: 1, warn: () => {} },
  );
  assert.equal(budgeted[0].url, 'https://cdn.example.com/a.png');
  assert.equal(budgeted[1].url, undefined);
  assert.equal(budgeted[1].text, '[图片]（解析失败）');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-05 ark 合并转发资源 id 展开
 * ------------------------------------------------------------------ */

test('RICH-05: json ark（com.tencent.multimsg）用 resid 走 get_forward_msg 展开', async () => {
  const { system, dir } = await makeTmpSystem('rich-ark');
  const seen = [];
  const bot = {
    get_forward_msg: async (id) => {
      seen.push(id);
      return [
        { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '合并转发内文' } }] },
      ];
    },
  };

  await system.onIncomingMessage(message({ id: 'ark-1' }), {
    onebot: bot,
    rawMessage: [
      jsonSegment({ app: 'com.tencent.multimsg', view: 'contact', meta: { detail_1: { resid: 'RESID-123' } } }),
      jsonSegment({ app: 'com.tencent.structmsg', meta: { news: { title: '普通卡片', desc: '描述' } } }),
    ],
  });
  const [ark, plainCard] = system.getLatestMessage('group-a').elements;

  assert.deepEqual(seen, ['RESID-123'], '必须用 ark resid 调用 get_forward_msg');
  assert.equal(ark.type, 'forward');
  assert.equal(ark.source, 'com.tencent.multimsg');
  assert.equal(ark.items[0].elements[0].text, '合并转发内文');
  assert.equal(plainCard.type, 'card');
  assert.equal(plainCard.title, '普通卡片', '普通 ark 卡片不得被误当成合并转发');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-06 同源媒体代理
 * ------------------------------------------------------------------ */

function mediaFetch(handler) {
  return async (target, options) => await handler(target, options);
}

function streamBody(text) {
  return Readable.from([Buffer.from(text)]);
}

test('RICH-06: 同源媒体代理只服务已登记 opaqueId，支持 Range / 拒绝 active content 与私网重定向', async () => {
  const { system, dir } = await makeTmpSystem('rich-proxy');
  const requests = [];
  const aborted = [];
  const fetchImpl = mediaFetch(async (target, options) => {
    requests.push({ url: target.toString(), range: options.range, address: options.address });
    if (target.pathname === '/redirect-private.png') {
      return { status: 302, headers: { location: 'http://127.0.0.1/secret.png' }, body: streamBody(''), abort: () => aborted.push(target.pathname) };
    }
    if (target.pathname === '/loop.png') {
      return { status: 302, headers: { location: 'http://198.51.100.7/loop.png' }, body: streamBody(''), abort: () => aborted.push(target.pathname) };
    }
    if (target.pathname === '/html.png') {
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: streamBody('<script>alert(1)</script>'),
        abort: () => aborted.push(target.pathname),
      };
    }
    if (options.range) {
      return {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/1024', 'content-length': '2', 'accept-ranges': 'bytes' },
        body: streamBody('ab'),
        abort: () => {},
      };
    }
    return { status: 200, headers: { 'content-type': 'image/png', 'content-length': '6' }, body: streamBody('PNGDAT'), abort: () => {} };
  });

  const routes = mountRoutes(system, {
    mediaFetch: fetchImpl,
    mediaLookup: async (hostname) => {
      if (hostname === 'media.example.test') return [{ address: '10.1.2.3', family: 4 }];
      if (hostname === 'reserved.example.test') return [{ address: '198.18.1.1', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });

  await system.onIncomingMessage(message({ id: 'proxy-1' }), {
    rawMessage: [
      { type: 'image', data: { url: 'http://198.51.100.7/pic.png' } },
      { type: 'video', data: { url: 'http://198.51.100.7/movie.mp4' } },
      { type: 'image', data: { url: 'http://198.51.100.7/redirect-private.png' } },
      { type: 'image', data: { url: 'http://198.51.100.7/loop.png' } },
      { type: 'image', data: { url: 'http://198.51.100.7/html.png' } },
      { type: 'image', data: { url: 'http://media.example.test/private-dns.png' } },
      { type: 'image', data: { url: 'http://reserved.example.test/benchmark.png' } },
      { type: 'image', data: { url: 'https://gchat.qpic.cn/direct.png' } },
    ],
  });

  const statusCtx = koaContext({ query: { channelId: 'group-a' } });
  await routes.status(statusCtx.ctx);
  const urls = statusCtx.ctx.body.latestMessage.elements.map((element) => element.url ?? null);
  const idOf = (value) => String(value).split('/').pop();

  assert.match(urls[0], /^\/patchouli\/api\/media\/[a-f0-9]{32}$/u, 'http 源必须改写为同源代理地址');
  assert.equal(urls[7], 'https://gchat.qpic.cn/direct.png', '公网 https 必须保留真实直链');
  assert.equal(system.getLatestMessage('group-a').elements[0].url, 'http://198.51.100.7/pic.png', '缓存内保留真实地址');

  // 1. 正常图片：200 + 媒体头 + nosniff
  const okCtx = koaContext({ params: { id: idOf(urls[0]) } });
  await routes.media(okCtx.ctx);
  assert.equal(okCtx.ctx.status, 200);
  assert.equal(okCtx.responseHeaders['content-type'], 'image/png');
  assert.equal(okCtx.responseHeaders['x-content-type-options'], 'nosniff');
  assert.equal(okCtx.responseHeaders['content-disposition'], 'inline');
  assert.equal(requests[0].address, '198.51.100.7', '上游必须固定到已校验 IP');
  assert.equal(okCtx.ctx.body.readable, true, '响应体必须是流（不整文件缓存）');

  // 2. 视频 Range：透明返回 206 + Content-Range
  const rangeCtx = koaContext({ params: { id: idOf(urls[1]) }, headers: { range: 'bytes=0-1' } });
  await routes.media(rangeCtx.ctx);
  assert.equal(rangeCtx.ctx.status, 206);
  assert.equal(rangeCtx.responseHeaders['content-range'], 'bytes 0-1/1024');
  assert.equal(rangeCtx.responseHeaders['accept-ranges'], 'bytes');
  assert.equal(requests[1].range, 'bytes=0-1');

  // 3. 非法 Range 不得被透传
  const badRangeCtx = koaContext({ params: { id: idOf(urls[1]) }, headers: { range: 'bytes=0-1\r\nx: y' } });
  await routes.media(badRangeCtx.ctx);
  assert.equal(requests[2].range, undefined, '非法 Range 必须丢弃');

  // 4. 未登记 / 非法 id
  const unknownCtx = koaContext({ params: { id: 'a'.repeat(32) } });
  await routes.media(unknownCtx.ctx);
  assert.equal(unknownCtx.ctx.status, 404);
  assert.deepEqual(unknownCtx.ctx.body, { error: '媒体已失效或未登记' });

  const badIdCtx = koaContext({ params: { id: 'not-a-hash' } });
  await routes.media(badIdCtx.ctx);
  assert.equal(badIdCtx.ctx.status, 400);

  // 5. 重定向到私网必须被拒绝
  const redirectCtx = koaContext({ params: { id: idOf(urls[2]) } });
  await routes.media(redirectCtx.ctx);
  assert.equal(redirectCtx.ctx.status, 403);

  // 6. 重定向环 → 超过跳数上限
  const loopCtx = koaContext({ params: { id: idOf(urls[3]) } });
  await routes.media(loopCtx.ctx);
  assert.equal(loopCtx.ctx.status, 502);
  assert.match(loopCtx.ctx.body.error, /重定向过多/u);

  // 7. HTML 必须被拒绝（绝不透传为本站内容）
  const htmlCtx = koaContext({ params: { id: idOf(urls[4]) } });
  await routes.media(htmlCtx.ctx);
  assert.equal(htmlCtx.ctx.status, 415);
  assert.equal(htmlCtx.responseHeaders['x-content-type-options'], 'nosniff');
  assert.equal(typeof htmlCtx.ctx.body, 'object', '拒绝时只返回 JSON 错误，不透传 HTML');

  // 8. 公网域名解析到私网 IP（DNS 重绑）→ 拒绝
  const dnsCtx = koaContext({ params: { id: idOf(urls[5]) } });
  await routes.media(dnsCtx.ctx);
  assert.equal(dnsCtx.ctx.status, 403);

  // 8b. 解析到 RFC 2544 基准段等保留地址同样拒绝（无任何例外段）
  const reservedCtx = koaContext({ params: { id: idOf(urls[6]) } });
  await routes.media(reservedCtx.ctx);
  assert.equal(reservedCtx.ctx.status, 403);

  // 9. 消息被覆盖后，旧媒体 opaqueId 立即失效
  await system.onIncomingMessage(message({ id: 'proxy-2', content: '下一条' }));
  const staleCtx = koaContext({ params: { id: idOf(urls[0]) } });
  await routes.media(staleCtx.ctx);
  assert.equal(staleCtx.ctx.status, 404, '旧消息的媒体 id 必须随缓存覆盖而失效');

  assert.deepEqual(
    [...new Set(aborted)].sort(),
    ['/html.png', '/loop.png', '/redirect-private.png'],
    '被拒绝的上游响应必须立即放弃（不留下悬挂连接）',
  );

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('RICH-06b: 登记表按（频道, URL）隔离，两群共享同一张图互不误删', async () => {
  const registry = new MediaRegistry();
  const handler = createMediaProxyHandler(registry, { fetch: mediaFetch(async () => ({ status: 200, headers: {}, body: null })) });
  const ctx = koaContext({ params: { id: 'f'.repeat(32) } });
  await handler(ctx.ctx);
  assert.equal(ctx.ctx.status, 404);

  const shared = 'http://198.51.100.7/ok.png';
  const idA = registry.register('group-a', shared);
  const idB = registry.register('group-b', shared);
  assert.match(idA, /^[a-f0-9]{32}$/u);
  assert.notEqual(idA, idB, '不同群引用同一 URL 必须持有各自独立的 opaqueId');
  assert.equal(registry.resolve(idA), shared);
  assert.equal(registry.resolve(idB), shared);
  assert.equal(registry.idFor('group-a', shared), idA);
  assert.equal(registry.idFor('group-b', shared), idB);

  registry.clearChannel('group-a');
  assert.equal(registry.idFor('group-a', shared), undefined);
  assert.equal(registry.resolve(idA), undefined, '被覆盖频道的 id 必须立即失效');
  assert.equal(registry.resolve(idB), shared, '他群仍在引用的同一张图不得被误删');
  assert.equal(registry.idFor('group-b', shared), idB);

  registry.clearChannel('group-b');
  assert.equal(registry.size, 0);

  // 端到端：真实系统 + 两群共享同图，覆盖一群不得影响另一群
  const { system, dir } = await makeTmpSystem('rich-cross-channel', ['group-a', 'group-b']);
  const routes = mountRoutes(system, {
    mediaFetch: mediaFetch(async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: streamBody('PNG'), abort: () => {} })),
  });
  const rawMessage = [{ type: 'image', data: { url: 'http://198.51.100.7/shared.png' } }];
  await system.onIncomingMessage(message({ id: 'a-1', channelId: 'group-a' }), { rawMessage });
  await system.onIncomingMessage(message({ id: 'b-1', channelId: 'group-b' }), { rawMessage });

  const aCtx = koaContext({ query: { channelId: 'group-a' } });
  await routes.status(aCtx.ctx);
  const bCtx = koaContext({ query: { channelId: 'group-b' } });
  await routes.status(bCtx.ctx);
  const proxyIdA = aCtx.ctx.body.latestMessage.elements[0].url.split('/').pop();
  const proxyIdB = bCtx.ctx.body.latestMessage.elements[0].url.split('/').pop();
  assert.notEqual(proxyIdA, proxyIdB, '两群的代理地址必须彼此独立');

  await system.onIncomingMessage(message({ id: 'a-2', channelId: 'group-a', content: '新消息' }));
  const staleA = koaContext({ params: { id: proxyIdA } });
  await routes.media(staleA.ctx);
  assert.equal(staleA.ctx.status, 404, 'group-a 覆盖后其旧 id 必须失效');
  const liveB = koaContext({ params: { id: proxyIdB } });
  await routes.media(liveB.ctx);
  assert.equal(liveB.ctx.status, 200, 'group-b 仍在引用的同一张图必须继续可代理');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-08 导航字段 vs 子资源字段
 * ------------------------------------------------------------------ */

test('RICH-08: card/file 导航字段保留原始安全直链，仅子资源字段走同源代理与登记', async () => {
  const { system, dir } = await makeTmpSystem('rich-nav');
  const routes = mountRoutes(system, {
    mediaFetch: mediaFetch(async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: streamBody('PNG'), abort: () => {} })),
  });

  await system.onIncomingMessage(message({ id: 'nav-1' }), {
    rawMessage: [
      {
        type: 'share',
        data: {
          title: '新闻标题',
          content: '新闻摘要',
          url: 'http://198.51.100.7/news.html',
          image: 'http://198.51.100.7/cover.png',
        },
      },
      { type: 'file', data: { name: 'report.pdf', url: 'http://198.51.100.7/report.pdf' } },
      { type: 'image', data: { url: 'http://198.51.100.7/pic.png' } },
      { type: 'video', data: { url: 'http://198.51.100.7/movie.mp4', cover: 'http://198.51.100.7/poster.png' } },
    ],
  });

  const ctx = koaContext({ query: { channelId: 'group-a' } });
  await routes.status(ctx.ctx);
  const [card, file, image, video] = ctx.ctx.body.latestMessage.elements;

  assert.equal(card.url, 'http://198.51.100.7/news.html', 'card.url 是网页导航目标，必须保留原始安全直链（否则点击会被媒体代理 415 拒绝）');
  assert.match(card.imageUrl, /^\/patchouli\/api\/media\/[a-f0-9]{32}$/u, 'card 预览图是子资源，必须走同源代理');
  assert.equal(file.url, 'http://198.51.100.7/report.pdf', 'file.url 是下载目标，保留原始安全直链');
  assert.match(image.url, /^\/patchouli\/api\/media\/[a-f0-9]{32}$/u);
  assert.match(video.url, /^\/patchouli\/api\/media\/[a-f0-9]{32}$/u);
  assert.match(video.imageUrl, /^\/patchouli\/api\/media\/[a-f0-9]{32}$/u);

  // 登记表只登记子资源，导航目标不得被登记为媒体（否则等价于开放任意 URL 代理）
  const registered = collectMediaUrls(system.getLatestMessage('group-a').elements).sort();
  assert.deepEqual(registered, ['http://198.51.100.7/cover.png', 'http://198.51.100.7/pic.png', 'http://198.51.100.7/poster.png', 'http://198.51.100.7/movie.mp4'].sort());
  assert.ok(!registered.includes('http://198.51.100.7/news.html'));
  assert.ok(!registered.includes('http://198.51.100.7/report.pdf'));

  // 代理地址只覆盖子资源：card 的导航 URL 用原始地址直接可访问
  const cardNav = card.url;
  assert.equal(new URL(cardNav).pathname, '/news.html');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-09 逐层切片与跨层节点总预算
 * ------------------------------------------------------------------ */

test('RICH-09: 嵌套层级先切片再遍历，跨层转发节点总预算生效', async () => {
  const { system, dir } = await makeTmpSystem('rich-slice');

  // 1. 单个转发条目内含 100 段：只解析前 maxElements-1 段 + 可见截断提示
  const heavyNode = {
    sender: { nickname: '甲' },
    message: Array.from({ length: 100 }, (_, index) => ({ type: 'text', data: { text: `段${index}` } })),
  };
  const capped = await parseRichElements(
    { onebot: { get_forward_msg: async () => [heavyNode] }, rawMessage: [{ type: 'forward', data: { id: 'f' } }], content: '' },
    { maxElements: 4 },
  );
  assert.equal(capped[0].items[0].elements.length, 4, '嵌套条目必须先切片到上限 + 1 条提示');
  assert.match(capped[0].items[0].elements[3].text, /已截断，共 100 段元素/u);
  assert.ok(!JSON.stringify(capped).includes('段99'), '上限之外的段不得进入结果');

  // 2. 顶层列表同样先切片
  const topLevel = await parseRichElements(
    { rawMessage: Array.from({ length: 50 }, (_, index) => ({ type: 'text', data: { text: `t${index}` } })), content: '' },
    { maxElements: 3 },
  );
  assert.equal(topLevel.length, 3);
  assert.match(topLevel[2].text, /已截断，共 50 段元素/u);

  // 3. 跨层节点总预算：两层各 5 条、总预算 3 → 第一层 3 条（+提示），嵌套层只剩 1 条（+提示）
  const tree = {
    get_forward_msg: async (id) =>
      Array.from({ length: 5 }, (_, index) => ({
        sender: { nickname: `n${id}-${index}` },
        message:
          id === 'f1' && index === 0
            ? [{ type: 'forward', data: { id: 'f2' } }]
            : [{ type: 'text', data: { text: '正文' } }],
      })),
  };
  const budgeted = await parseRichElements(
    { onebot: tree, rawMessage: [{ type: 'forward', data: { id: 'f1' } }], content: '' },
    { maxForwardItems: 3, maxForwardNodes: 5 },
  );
  const items = budgeted[0].items;
  assert.equal(items.length, 4, '3 条节点 + 1 条截断提示');
  assert.match(items[3].elements[0].text, /共 5 条转发，仅展开前 3 条/u);
  const nested = items[0].elements[0];
  assert.equal(nested.type, 'forward');
  assert.equal(nested.items.length, 2, '嵌套层只剩 1 条节点 + 1 条提示（跨层预算已被上层用尽）');
  assert.match(nested.items[1].elements[0].text, /仅展开前 1 条/u);

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * RICH-07 最新消息接口契约与竞态
 * ------------------------------------------------------------------ */

test('RICH-07: 晚到的富解析不得覆盖新消息，且 /api/status 元素为浏览器就绪副本', async () => {
  const { system, dir } = await makeTmpSystem('rich-race');
  const routes = mountRoutes(system, { mediaFetch: mediaFetch(async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: streamBody('PNG'), abort: () => {} })) });

  let release;
  const slowBot = {
    get_image: () =>
      new Promise((resolve) => {
        release = () => resolve({ url: 'https://cdn.example.com/slow.png' });
      }),
  };

  const first = system.onIncomingMessage(message({ id: 'race-1', content: '第一条', userName: '甲' }), {
    onebot: slowBot,
    rawMessage: [{ type: 'image', data: { file: 'slow' } }],
  });
  await system.onIncomingMessage(message({ id: 'race-2', content: '第二条', userName: '乙' }), {
    rawMessage: [{ type: 'text', data: { text: '第二条' } }],
  });
  release();
  await first;

  const latest = system.getLatestMessage('group-a');
  assert.equal(latest.id, 'race-2', '最新消息必须仍是后到的那条');
  assert.equal(latest.userName, '乙');
  assert.ok(!JSON.stringify(latest.elements).includes('slow.png'), '旧消息的富解析结果不得回灌缓存');

  // 浏览器就绪副本：http 源 → 同源代理；https 源 → 真实直链
  await system.onIncomingMessage(message({ id: 'race-3', content: '第三条' }), {
    rawMessage: [
      { type: 'image', data: { url: 'http://198.51.100.7/a.png' } },
      { type: 'image', data: { url: 'https://gchat.qpic.cn/b.png' } },
    ],
  });
  const ctx = koaContext({ query: { channelId: 'group-a' } });
  await routes.status(ctx.ctx);
  const elements = ctx.ctx.body.latestMessage.elements;
  assert.match(elements[0].url, /^\/patchouli\/api\/media\/[a-f0-9]{32}$/u);
  assert.equal(elements[1].url, 'https://gchat.qpic.cn/b.png');
  assert.equal(ctx.ctx.body.latestMessage.content, '第三条');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test('RICH-10: OneBot reply 后面自动附加的被回复内容镜像文本不被重复渲染', async () => {
  const { system, dir } = await makeTmpSystem('rich-reply');
  const rawMessage = [
    { type: 'reply', data: { id: '929647569' } },
    { type: 'text', data: { text: '到时候找个理由跟码头异格或者空降一起出\n' } },
    { type: 'at', data: { qq: '1113935787' } },
    { type: 'text', data: { text: ' 马头是莱塔尼亚线人了' } },
  ];
  await system.onIncomingMessage(
    message({ id: 'msg-reply-1', content: '@成员 马头是莱塔尼亚线人了', userName: '猫' }),
    {
      rawMessage,
      quote: {
        id: '929647569',
        user: { name: 'Vader' },
        content: '到时候找个理由跟码头异格或者空降一起出',
      },
    },
  );
  const latest = system.getLatestMessage('group-a');
  assert.ok(latest);
  // 必须只包含 quote + at + text，绝不包含重复的“到时候找个理由...”单独文本段
  assert.equal(latest.elements.length, 3);
  assert.equal(latest.elements[0].type, 'quote');
  assert.equal(latest.elements[0].title, 'Vader');
  assert.equal(latest.elements[0].text, '到时候找个理由跟码头异格或者空降一起出');
  assert.equal(latest.elements[1].type, 'text');
  assert.equal(latest.elements[1].text, '@成员');
  assert.equal(latest.elements[2].type, 'text');
  assert.equal(latest.elements[2].text, '马头是莱塔尼亚线人了');

  system.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});
