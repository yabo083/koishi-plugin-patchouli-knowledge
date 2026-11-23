import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerWebUi } from '../lib/web/api.js';
import { Config, registerConsoleEntry } from '../lib/plugin/index.js';
import { buildTrafficPath } from '../lib/web/organic.js';

/**
 * Console 浮窗是唯一 UI（`client/dist/index.js`），服务端不再渲染独立页。
 * 本文件只覆盖与页面渲染无关的契约：路由清单、Console 组件注入、客户端产物与流量绘线内核。
 */
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');

function countMatches(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('WEBUI-02: Web 路由与 API 交互模拟', async () => {
  const routes = new Map();
  const middlewares = [];
  const mockRouter = {
    // 管理面守卫挂在 `use` 上；缺了它插件会 fail closed 跳过全部 /api 路由，这里照实记录。
    use: (route, middleware) => middlewares.push({ route, middleware }),
    get: (route, handler) => routes.set(`GET:${route}`, handler),
    post: (route, handler) => routes.set(`POST:${route}`, handler),
  };

  const mockCtx = { router: mockRouter };

  const mockSystem = {
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    shadowLedger: { stats: () => ({ written: 0, failed: 0, lastWriteAt: null }) },
    detector: {
      getStatus: () => ({
        currentRate: 3.5,
        baselineRate: 2.0,
        baselineDeviation: 0.4,
        burstRatio: 1.75,
        lastMessageTime: Date.now(),
        phase: 'BURSTING',
        bufferedCount: 14,
      }),
      getOptions: () => ({
        burstMultiplier: 2.5,
        quiescenceSeconds: 300,
      }),
      updateOptions: () => {},
    },
    getTraffic: (channelId, limit = 60) =>
      [
        { timestamp: 1700000000000, count: 0 },
        { timestamp: 1700000005000, count: 2 },
        { timestamp: 1700000010000, count: 5 },
      ].slice(-limit),
    getLatestMessage: (channelId) =>
      channelId === '100000000'
        ? { id: 'latest-msg-1', channelId, userName: '甲', content: '[图片] 只读横条', timestamp: 1700000010000, elements: [{ type: 'text', text: '[图片] 只读横条' }] }
        : null,
    localStore: {
      getRecentEntries: async () => [
        {
          id: '2026-10-25-ai-debate',
          title: '大模型思维链与系统二架构之争',
          channelId: '100000000',
          date: '2026-10-25',
          status: 'verified',
          tags: ['AI架构', '思维链'],
          summary: '群友围绕 o1 系列展开讨论。',
          participants: ['阿尔法', '贝塔'],
          metadata: { messageCount: 20, participantCount: 5, peakRate: 12.0 },
        },
      ],
      searchEntries: async () => [],
      getEntry: async () => undefined,
      saveCadenceState: async () => {},
    },
  };

  registerWebUi(mockCtx, mockSystem, '/patchouli');

  // 1. 独立页路由必须不存在：UI 只剩 Console 浮窗，服务端不渲染任何 HTML
  assert.equal(routes.has('GET:/patchouli'), false, '不得再注册独立页 HTML 路由');
  assert.equal(routes.has('GET:/patchouli/'), false, '不得再注册独立页 HTML 根路径');

  // 2. 验证 API: 获取词条
  assert.ok(routes.has('GET:/patchouli/api/entries'));
  const entriesCtx = { params: {}, query: {}, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET:/patchouli/api/entries')(entriesCtx);
  assert.equal(entriesCtx.body.length, 1);
  assert.equal(entriesCtx.body[0].channelId, '100000000');

  // 3. 验证 API: 监控指标
  assert.ok(routes.has('GET:/patchouli/api/status'));
  const statusCtx = { params: {}, query: { channelId: '100000000' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET:/patchouli/api/status')(statusCtx);
  assert.equal(statusCtx.body.channelId, '100000000');
  assert.equal(statusCtx.body.phase, 'BURSTING');
  assert.equal(statusCtx.body.options.burstMultiplier, 2.5);
  assert.deepEqual(
    statusCtx.body.traffic,
    [
      { timestamp: 1700000000000, count: 0 },
      { timestamp: 1700000005000, count: 2 },
      { timestamp: 1700000010000, count: 5 },
    ],
    '状态响应必须携带真实 5 秒流量桶',
  );
  assert.equal(statusCtx.body.sampleMs, 5000, '必须声明 5 秒采样节拍');
  assert.equal(typeof statusCtx.body.serverTime, 'number', '必须回传服务器墙钟供前端对齐时间轴');
  assert.equal(statusCtx.body.latestMessage.content, '[图片] 只读横条', '状态响应必须附带当前群最新消息预览');
  assert.equal(statusCtx.body.latestMessage.userName, '甲', '最新消息必须携带发送者显示名');
  assert.equal('series' in statusCtx.body, false, '旧 series 字段必须彻底移除');

  // 3b. 验证 API: 单独拉取流量序列（limit 截取 + 上限 60）
  assert.ok(routes.has('GET:/patchouli/api/series'));
  const seriesCtx = { params: {}, query: { channelId: '100000000', limit: '2' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET:/patchouli/api/series')(seriesCtx);
  assert.deepEqual(
    seriesCtx.body.traffic,
    [
      { timestamp: 1700000005000, count: 2 },
      { timestamp: 1700000010000, count: 5 },
    ],
    'limit 必须截取最近 N 个流量桶',
  );
  assert.equal(seriesCtx.body.sampleMs, 5000, '采样间隔必须为 5 秒');
  assert.equal(typeof seriesCtx.body.serverTime, 'number');
  assert.equal('series' in seriesCtx.body, false, '旧 series 字段必须彻底移除');
  const seriesCapCtx = { params: {}, query: { channelId: '100000000', limit: '9999' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET:/patchouli/api/series')(seriesCapCtx);
  assert.equal(seriesCapCtx.body.limit, 60, 'limit 上限必须收敛到 60 点');

  // 4. 验证 API: 管理员调参
  assert.ok(routes.has('POST:/patchouli/api/tune'));
  const tuneCtx = {
    params: {},
    query: {},
    request: {
      body: {
        channelId: '100000000',
        options: { burstMultiplier: 3.0, quiescenceSeconds: 180 },
      },
    },
    status: 200,
    body: null,
    set: () => {},
  };
  await routes.get('POST:/patchouli/api/tune')(tuneCtx);
  assert.equal(tuneCtx.body.ok, true);
});
test('WEBUI-04: Console 下属组件注入绝对路径 (node_modules 放行契约)', () => {
  const calls = [];
  const warnings = [];
  const logger = { info: () => {}, warn: (msg) => warnings.push(msg) };
  const ctx = {
    console: {
      addEntry: (files) => {
        calls.push(files);
        return { id: 'e2e1d' };
      },
      config: { uiPath: '/plugins' },
    },
  };

  registerConsoleEntry(ctx, logger);

  assert.equal(calls.length, 1, '应注入且仅注入一个 Console 条目');
  assert.ok(path.isAbsolute(calls[0]), '必须传入绝对路径，否则 plugin-console 静态服务会 403');
  assert.ok(
    fs.existsSync(path.join(calls[0], 'index.js')),
    '注入目录必须包含可被 console 加载的 index.js 产物',
  );
  assert.deepEqual(
    warnings.filter((msg) => !msg.includes('403')),
    [],
    '除 node_modules 越权风险提示外不得产生任何告警',
  );
});

test('WEBUI-05: Console 服务缺失或异常时不注入且不抛错', () => {
  const logger = { info: () => {}, warn: () => {} };
  assert.doesNotThrow(() => registerConsoleEntry({}, logger));
  assert.doesNotThrow(() => registerConsoleEntry({ console: { addEntry: 'not-a-function' } }, logger));
});

test('WEBUI-06: 配置 Schema 已彻底清除 _preview 预览残留', () => {
  const serialized = JSON.stringify(Config.toJSON());
  assert.equal(serialized.includes('_preview'), false, '配置 Schema 不得再声明 _preview 字段');
  assert.equal(serialized.includes('iframe'), false, '配置 Schema 不得残留 iframe 片段');
});


test('WEBUI-15: 客户端产物语法自洽', () => {
  const clientBody = CLIENT_SOURCE.replace('export default function applyPatchouliWikiReader', 'function applyPatchouliWikiReader');
  assert.doesNotThrow(() => new Function(clientBody), '客户端产物必须语法自洽');
});
test('WEBUI-18: 真实时间轴流量绘线内核 (traffic -> path)', () => {
  const W = 516;
  const H = 120;
  const STEP = 5000;
  const SPAN = 300000; // 5 分钟窗口 = 60 × 5 秒
  const END = 1_800_000_000_000; // 服务器墙钟对齐的桶起点
  const START = END - SPAN;
  const point = (stepIndex, count) => ({ timestamp: START + stepIndex * STEP, count });
  const series = (counts) => counts.map((count, index) => point(index, count));
  const xAt = (stepIndex) => Math.round(((stepIndex * STEP) / SPAN) * W * 100) / 100;
  const yAt = (count, maxCount) => Math.round((H - 4 - (count / maxCount) * (H - 8)) * 100) / 100;
  const subpaths = (d) =>
    d
      .split('M')
      .slice(1)
      .map((segment) => segment.trim().split(' L').map((pair) => pair.split(' ').map(Number)));

  assert.equal(buildTrafficPath([], W, H, START, END, 10), '', '未监测到任何周期时不得画线，更不得伪造平直基线');

  // 整窗 61 个连续采样（5 秒一桶）：X 按真实时间戳定位，Y 按条数 / 满刻度
  const zeros = subpaths(buildTrafficPath(series(new Array(61).fill(0)), W, H, START, END, 10));
  assert.equal(zeros.length, 1, '连续采样必须连成一段');
  assert.equal(zeros[0].length, 61, '整窗 61 个采样点必须全部绘制');
  assert.deepEqual(
    [zeros[0][0][0], zeros[0][30][0], zeros[0][60][0]],
    [0, xAt(30), W],
    'X 必须按真实时间戳定位（左端 / 中点 / 右端），而非等宽槽位',
  );
  assert.ok(
    zeros[0].every((pair) => pair[1] === H - 4),
    '已监测但无消息的周期是真实 0，必须落在基线 y = height - 4 上',
  );

  const counts = new Array(61).fill(0);
  counts[30] = 5;
  counts[60] = 10;
  const ramped = subpaths(buildTrafficPath(series(counts), W, H, START, END, 10))[0];
  assert.deepEqual(ramped[30], [xAt(30), yAt(5, 10)], 'Y 必须按条数与满刻度绘制，半刻度落在绘图区中部');
  assert.deepEqual(ramped[60], [xAt(60), yAt(10, 10)], '满刻度采样必须落在绘图区顶部，不得每次把峰值拉满');
  assert.equal(yAt(10, 10), 4, '绘图区上下各留 4 用户单位');

  // 缺失周期断开：相邻采样必须正好相隔 5 秒，缺桶即断段
  const gapped = subpaths(buildTrafficPath([point(0, 1), point(1, 2), point(7, 3), point(8, 4)], W, H, START, END, 10));
  assert.equal(gapped.length, 2, '未监测的周期必须断开，不得跨越缺口连线');
  assert.deepEqual(gapped[0], [[xAt(0), yAt(1, 10)], [xAt(1), yAt(2, 10)]], '缺口前的采样必须按真实坐标成段');
  assert.deepEqual(gapped[1], [[xAt(7), yAt(3, 10)], [xAt(8), yAt(4, 10)]], '缺口后的采样必须另起一段');
  assert.equal(
    countMatches(buildTrafficPath([point(0, 1), point(1, 1), point(3, 1), point(4, 1)], W, H, START, END, 10), 'M'),
    2,
    '仅缺一个 5 秒桶也必须断开',
  );
  assert.equal(
    buildTrafficPath([point(0, 1), point(2, 3)], W, H, START, END, 10),
    'M0 104.8 L3 104.8M14.2 82.4 L20.2 82.4',
    '只有两个相隔两桶的采样时必须断成两段，不得跨越缺失的 5 秒桶连线',
  );

  // count 非有限 = 该周期未监测：同样断开，且不得当成 0 补上
  assert.equal(
    buildTrafficPath([point(0, 3), { timestamp: START + STEP, count: Number.NaN }, point(2, 3)], W, H, START, END, 10),
    'M0 82.4 L3 82.4M14.2 82.4 L20.2 82.4',
    'NaN 采样点必须断开，缺口两侧各自成段（不得补 0 值）',
  );

  // 不足两点：单点画短横线（半宽 3 用户单位），窗口边缘处收敛在绘图区内
  assert.equal(
    buildTrafficPath([point(30, 4)], W, H, START, END, 10),
    'M255 71.2 L261 71.2',
    '单点必须画成短横线，而非不可见的孤立点',
  );
  assert.equal(
    buildTrafficPath([point(0, 4)], W, H, START, END, 10),
    'M0 71.2 L3 71.2',
    '窗口左缘的单点短线不得越出绘图区',
  );

  // 满刻度非法时按 1 处理，保证 0 / 1 条仍可读
  assert.equal(buildTrafficPath([point(0, 0), point(1, 1)], W, H, START, END, 0), 'M0 116 L8.6 4', 'maxCount ≤ 0 时按 1 处理');
  assert.equal(
    buildTrafficPath([point(0, 0), point(1, 1)], W, H, START, END, Number.NaN),
    'M0 116 L8.6 4',
    'maxCount 非有限时按 1 处理',
  );

  // 窗口裁剪：滚动出窗的过期点直接丢弃，不得压到左边界堆积
  assert.equal(
    buildTrafficPath([{ timestamp: START - STEP, count: 9 }, point(1, 1)], W, H, START, END, 10),
    'M5.6 104.8 L11.6 104.8',
    '滚动出窗的旧采样必须丢弃，不得 clamp 到左边界',
  );
  assert.equal(
    buildTrafficPath([{ timestamp: START - STEP, count: 9 }, { timestamp: END + STEP, count: 9 }], W, H, START, END, 10),
    '',
    '整段都在窗口外时不得绘制任何线条',
  );
  assert.equal(
    buildTrafficPath(
      [{ timestamp: START - STEP, count: 9 }, point(30, 4), { timestamp: END + STEP, count: 9 }],
      W,
      H,
      START,
      END,
      10,
    ),
    'M255 71.2 L261 71.2',
    '窗口外的采样不得影响窗内采样的坐标',
  );
});

