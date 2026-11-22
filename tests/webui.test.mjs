import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  renderLibraryHtml,
  registerWebUi,
  renderTacticalDockComponent,
} from '../lib/web/api.js';
import { Config, registerConsoleEntry } from '../lib/plugin/index.js';
import { buildTrafficPath, organicIcon, ORGANIC_ICONS } from '../lib/web/organic.js';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const CLIENT_SOURCE = fs.readFileSync(new URL('../client/dist/index.js', import.meta.url), 'utf8');

function countMatches(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** 抽取内联 <script> 正文（页面与内嵌组件均由同一运行时注入）。 */
function inlineScript(html) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  return match ? match[1] : '';
}

test('WEBUI-01: HTML 模板渲染与 llmwiki 术语要素检验', () => {
  const html = renderLibraryHtml('/patchouli');
  assert.ok(html.includes('LLMWiki 知识阅读器'), '标题应为 LLMWiki 知识阅读器');
  assert.ok(html.includes('争点对照') && html.includes('讨论脉络'), '详情页必须以讨论脉络为主体、争点对照为索引');
  // 公开产物不得预置任何真实群号：作用域由宿主配置与频道列表决定
  assert.equal(html.includes("'100000000'"), false, '页面不得硬编码真实群号');
  assert.equal((html.match(/class="ptx-tab[" ]/g) || []).length, 3, '恰好三个核心页签（词条 / 主题 / 监控）');
  assert.ok(html.includes('data-stage="topics"') && html.includes('主题'), '第二个核心页签必须是主题');
  assert.ok(html.includes('跨时间主题聚合'), '主题页签须说明它是跨时间的聚合视图');
  assert.ok(!/fonts\.googleapis/.test(html), '页面不得依赖任何外部字体或资源');
});

test('WEBUI-03: 阅读器内嵌组件结构与拖拽收回引擎检验', () => {
  const dockHtml = renderTacticalDockComponent('/patchouli');
  assert.ok(dockHtml.includes('ptx-window'), '应包含有机未来主义外骨骼视窗');
  assert.ok(dockHtml.includes('ptx-rail'), '应包含左侧细胞膜脊柱 Rail');
  assert.ok(dockHtml.includes('ptx-pill'), '应包含自动收回后的呼吸胶囊徽章');
  assert.ok(dockHtml.includes('ptx-tab'), '页签必须为图标按键');
  assert.equal((dockHtml.match(/class="ptx-tab[" ]/g) || []).length, 3, '恰好三个核心页签（词条 / 主题 / 监控）');
  assert.ok(dockHtml.includes('data-stage="topics"') && dockHtml.includes('主题'), '内嵌组件的第二个页签必须是主题');
  assert.ok(dockHtml.includes('pointerdown'), '应包含自由拖拽引擎');
  assert.ok(dockHtml.includes('function clampPosition'), '应包含视口钳制');
  assert.ok(dockHtml.includes('function floatWindow'), '内嵌组件首次拖拽必须转为浮动层');
  assert.ok(dockHtml.includes('IDLE_MS = 5000'), '静置 5 秒应自动收回');
  assert.ok(dockHtml.includes('data-tip'), '说明文字必须收敛于 hover 浮层');
  assert.equal(dockHtml.includes("'100000000'"), false, '内嵌组件不得硬编码真实群号');
  assert.ok(dockHtml.includes('LLMWiki 知识阅读器'), '大标题应为 LLMWiki 知识阅读器');
  assert.ok(dockHtml.includes('ptxDockRoot'), '必须以独立根节点隔离样式');
});

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

  // 1. 验证 HTML 页面
  assert.ok(routes.has('GET:/patchouli'));
  const htmlCtx = { params: {}, query: {}, request: {}, status: 200, body: '', set: () => {} };
  await routes.get('GET:/patchouli')(htmlCtx);

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



test('WEBUI-11: 极简 UI 契约 (清除长段文案 / 图标替代文字 / 说明收进 hover 浮层)', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  const removedCopy = [
    '读取 wikiDir 下的 llmwiki 词条：摘要、背景、观点碰撞矩阵、共识与结论、未决分歧、原始引用',
    'llmwiki 解析查看器',
    '自动收回: 开',
    '查阅索引 index.md 与流水日志',
  ];
  for (const copy of removedCopy) {
    assert.ok(!CLIENT_SOURCE.includes(copy), `客户端不得残留长段文案「${copy}」`);
    assert.ok(!html.includes(copy), `页面不得残留长段文案「${copy}」`);
    assert.ok(!dock.includes(copy), `内嵌组件不得残留长段文案「${copy}」`);
  }

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    assert.ok(!source.includes('ptx-hero'), `${name}: 巨型 Hero 宣传区块必须移除`);
    assert.ok(!source.includes('hero-desc'), `${name}: 不得保留长段描述容器`);
    assert.ok(source.includes('[data-tip]:hover::after'), `${name}: 浮层必须由 :hover 触发`);
  }

  assert.ok(countMatches(html, 'data-tip=') >= 10, '页面所有操作与状态均应携带浮层说明');
  assert.ok(countMatches(dock, 'data-tip=') >= 10, '内嵌组件所有操作与状态均应携带浮层说明');
});




test('WEBUI-15: 内联运行时语法自洽 (页面 / 内嵌组件 / 客户端)', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  for (const [name, source] of [['独立页面', inlineScript(html)], ['内嵌组件', inlineScript(dock)]]) {
    assert.ok(source.length > 2000, `${name}: 运行时脚本不得为空`);
    assert.doesNotThrow(() => new Function(source), `${name}: 运行时脚本必须语法自洽`);
  }

  const clientBody = CLIENT_SOURCE.replace('export default function applyPatchouliWikiReader', 'function applyPatchouliWikiReader');
  assert.doesNotThrow(() => new Function(clientBody), '客户端产物必须语法自洽');
});

test('WEBUI-16: 图标统一为 Lucide 图标集（24px 网格 / 2px 圆头描边 / 全内联）', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    assert.ok(
      source.includes('stroke-linecap="round" stroke-linejoin="round" stroke-width="2"'),
      `${name}: 图标必须统一为 Lucide 的 2px 圆头描边规格`,
    );
    assert.ok(source.includes('fill="none" stroke="currentColor"'), `${name}: 图标必须以 currentColor 继承语义色`);
    assert.ok(source.includes('viewBox="0 0 24 24"'), `${name}: 图标必须为 24px 网格内联 SVG`);
    assert.ok(!/https?:\/\//i.test(source), `${name}: 图标不得引用任何外链或图标字体`);
  }

  for (const [name, source] of [['独立页面', html], ['内嵌组件', dock]]) {
    assert.ok(countMatches(source, 'viewBox="0 0 24 24"') >= 8, `${name}: 全部图标必须就地内联渲染色`);
  }
  assert.ok(CLIENT_SOURCE.includes('function organicIcon('), '客户端必须以内联 SVG 渲染图标');
});

test('WEBUI-19: 卡片 / 列表视图模式切换块（双端同步）', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  // 图标：Lucide layout-grid / list，与图标集其它成员同一规格，且两枚图形必须不同
  for (const name of ['grid', 'list']) {
    assert.ok(ORGANIC_ICONS[name], `图标集必须包含 ${name}`);
    assert.ok(ORGANIC_ICONS[name].includes('stroke-width="2"'), `${name} 必须保持 2px 圆头描边`);
    assert.ok(organicIcon(name, 12).includes('viewBox="0 0 24 24"'), `${name} 必须为 24px 网格内联 SVG`);
  }
  assert.notEqual(ORGANIC_ICONS.grid, ORGANIC_ICONS.list, '卡片 / 列表必须使用两枚不同图形');
  assert.ok(CLIENT_SOURCE.includes('grid: `<g ${LUCIDE}'), '客户端图标表必须同步 grid');
  assert.ok(CLIENT_SOURCE.includes('list: `<g ${LUCIDE}'), '客户端图标表必须同步 list');

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    // 结构：标题行右端的分段胶囊 + 两枚各带 data-mode 的按钮
    assert.ok(source.includes('class="ptx-view-mode"'), `${name}: 必须渲染视图切换块`);
    assert.ok(source.includes('data-act="view-mode"'), `${name}: 切换按钮必须走 data-act="view-mode"`);
    assert.ok(source.includes('data-mode="'), `${name}: 模式按钮必须声明 data-mode`);
    assert.ok(source.includes('aria-pressed='), `${name}: 模式按钮必须暴露 aria-pressed 状态`);
    assert.ok(/btn\(['"]card['"], ['"]grid['"]/.test(source), `${name}: 卡片按钮必须使用 grid 图标`);
    assert.ok(/btn\(['"]list['"], ['"]list['"]/.test(source), `${name}: 列表按钮必须使用 list 图标`);
    assert.ok(/词条索引[\s\S]{0,80}renderViewToggle\(\)/.test(source), `${name}: 切换块必须注入词条索引标题行`);

    // 状态：默认卡片、持久化键 patchouli-view-mode、列表模式给 .ptx-spores 挂 is-list
    assert.ok(/raw === ['"]list['"] \? ['"]list['"] : ['"]card['"]/.test(source), `${name}: 持久化值必须容错收敛到 card | list`);
    assert.ok(source.includes('patchouli-view-mode'), `${name}: 必须使用持久化键 patchouli-view-mode`);
    assert.ok(source.includes('localStorage.setItem(VIEW_KEY'), `${name}: 切换模式必须落库`);
    assert.ok(/ptx-spores[\s\S]{0,120}is-list/.test(source), `${name}: 列表模式必须挂 is-list 类`);

    // 样式：26px 底槽 / 24×22 按钮 / 单列紧凑条
    assert.ok(source.includes('.ptx-view-mode {'), `${name}: 必须定义 .ptx-view-mode`);
    assert.ok(source.includes('height: 26px;'), `${name}: 底槽高度必须为 26px`);
    assert.ok(source.includes('.ptx-view-btn.is-active'), `${name}: 激活态必须独立定义`);
    assert.ok(source.includes('background: var(--surface-track);'), `${name}: 底槽必须使用 --surface-track`);
    assert.ok(source.includes('.ptx-spores.is-list { grid-template-columns: 1fr;'), `${name}: 列表模式必须单列`);
    assert.ok(source.includes('min-height: 46px;'), `${name}: 列表条目最小高度必须为 46px`);
    assert.ok(source.includes('text-overflow: ellipsis;'), `${name}: 列表标题必须单行截断省略`);
    assert.ok(source.includes('.ptx-spore-sum,'), `${name}: 列表模式必须隐藏多行大摘要`);
  }
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


test('WEBUI-20: 底栏双槽位滑入 / 群聊范围持久化 / 设置页视图模式 / 核心页签收敛', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    // 1. 双槽位滑入：单一裁切容器 + 绝对定位同槽交替，长轨道与累加位移彻底消失
    assert.ok(!source.includes('ptx-ticker-track'), `${name}: 外层长轨道必须彻底移除`);
    assert.ok(!source.includes('TICKER_ROW'), `${name}: 旧的行高累加位移常量必须移除`);
    assert.ok(source.includes('class="ptx-ticker" id="'), `${name}: 容器自身必须就是唯一裁切槽位`);
    assert.ok(source.includes('.ptx-trow.is-active { transform: translateY(0); opacity: 1; }'), `${name}: 静止态必须回到 0 位移`);
    assert.ok(source.includes('transform: translateY(-100%);'), `${name}: 离场节点必须向上滑出`);
    assert.ok(source.includes('.ptx-trow.is-entering { transform: translateY(100%); opacity: 0; }'), `${name}: 入场节点必须自下方滑入`);
    assert.ok(source.includes('is-entering') && source.includes('is-leaving'), `${name}: 必须使用进入 / 离开两个过渡态`);
    assert.ok(/TICKER_SWAP_MS = 400/.test(source), `${name}: 旧节点必须在 400ms 后移出 DOM`);

    // 2. 群聊范围持久化
    assert.ok(source.includes('patchouli-channel-scope'), `${name}: 必须使用持久化键 patchouli-channel-scope`);
    assert.ok(source.includes('localStorage.setItem(CHANNEL_SCOPE_KEY'), `${name}: 选择群聊必须落库`);
    assert.ok(/pickChannel[\s\S]{0,400}setChannelScope\(next\)/.test(source), `${name}: 选中群聊必须写入本地记忆`);

    // 3. 设置页索引视图配置项（与顶栏胶囊共用同一份持久化状态）
    assert.ok(source.includes('索引视图'), `${name}: 设置页必须提供索引视图配置项`);
    assert.ok(/索引视图[\s\S]{0,260}renderViewToggle\(\)/.test(source), `${name}: 设置页必须复用同一枚视图切换胶囊`);

    // 4. 侧栏只剩词条 / 监控两个核心页签，详情页仍完整保留矩阵与引用
    assert.ok(!source.includes('data-stage="matrix"'), `${name}: 侧栏不得再暴露观点碰撞矩阵页签`);
    assert.ok(!source.includes('data-stage="quotes"'), `${name}: 侧栏不得再暴露原始引用页签`);
    assert.ok(source.includes('争点对照') && source.includes('摘句'), `${name}: 词条详情页必须继续展示争点对照与摘句`);
  }

  assert.ok(!CLIENT_SOURCE.includes("key: 'matrix'"), '客户端页签表不得残留 matrix');
  assert.ok(!CLIENT_SOURCE.includes("key: 'quotes'"), '客户端页签表不得残留 quotes');
});

test('WEBUI-21: 系统提示词复用原生 ptx-editor 组件（双端同步，旧样式彻底清除）', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    // 1. 原生组件结构：ptx-editor 卡片 + ptx-editor-field/label + ptx-input 三件套
    assert.ok(source.includes('<div class="ptx-editor">'), `${name}: 必须复用 ptx-editor 卡片`);
    assert.ok(source.includes('<label class="ptx-editor-field">'), `${name}: 必须复用 ptx-editor-field`);
    assert.ok(source.includes('帕秋莉系统提示词 (SYSTEM PROMPT)'), `${name}: 必须呈现等宽字段标签`);
    assert.ok(
      source.includes('class="ptx-input ptx-editor-area ptx-editor-md"'),
      `${name}: 提示词编辑区必须是 ptx-input + ptx-editor-area + ptx-editor-md`,
    );
    assert.ok(source.includes('data-role="system-prompt"'), `${name}: 编辑区必须暴露 data-role="system-prompt"`);
    assert.ok(source.includes('class="ptx-editor-foot"'), `${name}: 操作行必须复用 ptx-editor-foot`);
    assert.ok(source.includes('class="ptx-editor-hint"'), `${name}: 必须复用 ptx-editor-hint 说明`);
    assert.ok(source.includes('在悬浮窗内即时热生效，可随时一键恢复默认'), `${name}: 必须说明即时热生效`);
    assert.ok(source.includes('data-action="save-prompt"'), `${name}: 必须保留保存按钮`);
    assert.ok(source.includes('data-action="reset-prompt"'), `${name}: 必须保留恢复默认按钮`);
    assert.ok(/['"]check['"], 13/.test(source), `${name}: 保存按钮必须带 Lucide check 图标`);

    // 2. 旧的一次性样式与结构彻底移除
    assert.equal(source.includes('ptx-prompt-editor'), false, `${name}: 旧 .ptx-prompt-editor 必须彻底移除`);
    assert.equal(source.includes('ptx-prompt-actions'), false, `${name}: 旧 .ptx-prompt-actions 必须彻底移除`);
    assert.equal(source.includes('ptx-prompt-desc'), false, `${name}: 旧 .ptx-prompt-desc 必须彻底移除`);
    assert.equal(source.includes('.ptx-prompt {'), false, `${name}: 旧 .ptx-prompt 卡片必须彻底移除`);

    // 3. 状态行仍使用等宽小字，自定义生效时转向主绿
    assert.ok(source.includes('.ptx-prompt-status {'), `${name}: 必须保留状态行样式`);
    assert.ok(source.includes('.ptx-prompt-status.is-custom'), `${name}: 必须保留自定义生效态`);
  }
});

test('WEBUI-22: 拖拽走合成层平移 + 主题原语先于 state 初始化（双端同源）', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    // 1. 拖拽帧只搬 transform：绝不写 left / top（每帧写布局=整窗重排重光栅=边缘撕裂）
    const from = source.indexOf('function applyDrag');
    const to = source.indexOf('function flushPending', from);
    assert.ok(from > 0 && to > from, `${name}: 必须存在 applyDrag 且紧随 flushPending`);
    const body = source.slice(from, to);
    assert.ok(body.includes('translate3d'), `${name}: 拖拽帧必须写 translate3d`);
    assert.equal(body.includes('style.left'), false, `${name}: 拖拽帧不得写 left`);
    assert.equal(body.includes('style.top'), false, `${name}: 拖拽帧不得写 top`);

    // 2. 手势类：拖拽提升合成层，缩放明确不提升，两者都不得重写材质
    assert.ok(
      /\.ptx-window\.is-dragging \{[^}]*will-change: transform/.test(source),
      `${name}: is-dragging 必须提升为独立合成层`,
    );
    assert.equal(
      /\.ptx-window\.is-resizing \{[^}]*will-change/.test(source),
      false,
      `${name}: 缩放不得提升合成层（尺寸变化本来就要重光栅）`,
    );
    const gestureBlock = /\/\* =+ 手势态[\s\S]{0,900}?\.ptx-window\.is-resizing \{ transition: none; \}/.exec(source);
    assert.ok(gestureBlock, `${name}: 必须保留手势态声明块`);
    assert.equal(/background:|backdrop-filter:|box-shadow:/.test(gestureBlock[0]), false, `${name}: 手势态不得重写材质`);

    // 3. 几何对齐设备像素：125% / 150% 缩放下边框与字形不再逐帧重算抗锯齿
    assert.ok(source.includes('function snapPx'), `${name}: 必须提供 snapPx`);
    assert.ok(source.includes('snapPx(next.left)'), `${name}: 位置提交必须经过 snapPx`);

    // 4. 主题令牌是 var 声明，必须早于 state 初始化：否则 detectHostDark()（state 首屏即
    //    调用）读到 undefined 数组，tokenTheme 取 .length 抛 TypeError，整个运行时停摆。
    const tokenAt = source.indexOf('DARK_TOKENS');
    const useAt = source.indexOf('detectHostDark() ?');
    assert.ok(tokenAt > 0 && useAt > 0, `${name}: 必须存在主题令牌与 state 初始化`);
    assert.ok(tokenAt < useAt, `${name}: DARK_TOKENS 必须先于 state 的 detectHostDark() 调用声明`);
  }
});

test('WEBUI-23: 相关线索 / 附录 / 名词注无外框发丝线结构，主题时间轴双端同源', () => {
  const styleSource = fs.readFileSync(new URL('../src/web/organic-style.ts', import.meta.url), 'utf8');
  const runtimeSource = fs.readFileSync(new URL('../src/web/organic-runtime.ts', import.meta.url), 'utf8');
  for (const [name, source, scope] of [
    ['runtime', styleSource, '\\$\\{S\\}'],
    ['client', CLIENT_SOURCE, '#patchouli-organic-root'],
  ]) {
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-related \\{[^}]*border-top: 1px solid var\\(--hairline\\)`, 'u'),
      `${name}: 相关线索必须是无外框的分隔线列表`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-gloss-row \\{[^}]*display: grid`, 'u'),
      `${name}: 名词注必须使用两列释义网格`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-table \\{[^}]*table-layout: fixed`, 'u'),
      `${name}: 附录争点必须使用固定列宽的对照表`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-node\\.is-inline \\{[^}]*font-size: 0\\.95em`, 'u'),
      `${name}: 正文内联昵称必须放大到 0.95em`,
    );
    assert.equal(
      /<ul class="ptx-related"/.test(source),
      false,
      `${name}: 相关线索不得再使用 ul/li（会继承宿主的列表卡片样式）`,
    );

    // 主题时间轴：左侧一条发丝竖线 + 节点圆点，不做卡片堆叠
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-timeline \\{[^}]*list-style: none`, 'u'),
      `${name}: 时间轴必须是无序号的竖排列表`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-tl::before \\{[^}]*width: 1px[^}]*background: var\\(--hairline-strong\\)`, 'u'),
      `${name}: 时间轴左栏必须是 1px 发丝竖线`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-tl-dot \\{[^}]*border-radius: 50%[^}]*background: var\\(--bio-cyan\\)`, 'u'),
      `${name}: 时间轴节点必须是主绿圆点`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-tl-date \\{[^}]*font-family: var\\(--bio-mono\\)`, 'u'),
      `${name}: 时间轴日期必须走等宽字体`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-tl-title \\{[^}]*font-size: 13px[^}]*font-weight: 600`, 'u'),
      `${name}: 时间轴标题必须是 13px / 600`,
    );
    assert.match(
      source,
      new RegExp(`${scope} \\.ptx-tl-note \\{[^}]*font-size: 11\\.5px`, 'u'),
      `${name}: 时间轴摘要必须是 11.5px 静音小字`,
    );
  }

  // 双端结构：主题判定 + 时间轴渲染 + 页签过滤（同一份语义，两处实现）
  for (const [name, source] of [
    ['runtime', runtimeSource],
    ['client', CLIENT_SOURCE],
  ]) {
    assert.ok(/key:\s*['"]topics['"]/.test(source), `${name}: 页签表必须以主题取代回想`);
    assert.equal(/key:\s*['"]recalls['"]/.test(source), false, `${name}: 不得再暴露回想页签`);
    assert.ok(source.includes('isTopicEntry'), `${name}: 必须提供主题判定助手`);
    assert.ok(/stage === ['"]topics['"]/.test(source), `${name}: 列表必须按主题页签过滤`);
    assert.equal(/stage === ['"]recalls['"]/.test(source), false, `${name}: 不得再按回想页签过滤列表`);
    assert.ok(/class="ptx-timeline"/.test(source), `${name}: 详情必须渲染竖向时间轴容器`);
    assert.ok(source.includes('ptx-tl-dot') && source.includes('ptx-tl-date'), `${name}: 时间轴须含节点与等宽日期`);
    assert.ok(source.includes('ptx-tl-title'), `${name}: 时间轴标题须可点击`);
    assert.match(
      source,
      /data-id="(?:'\s*\+\s*esc\(entryId\)|\$\{escapeHtml\(entryId\)\})/,
      `${name}: 时间轴标题必须携带来源词条 id`,
    );
    assert.ok(/section\(['"]时间轴['"]/.test(source) || /Section\(['"]时间轴['"]/.test(source), `${name}: 时间轴小节必须独立成段`);
    assert.match(source, /isTopic\s*\?\s*['"]主题综述['"]/, `${name}: 主题叙事小节标题必须是「主题综述」`);
    assert.ok(source.includes('条相关词条'), `${name}: 主题卡须标记相关词条条数`);
    assert.equal(/ptx-spore-status is-superseded/.test(source), false, `${name}: 主题卡不得展示 superseded 状态`);
  }

  assert.equal('recalls' in ORGANIC_ICONS, false, '回想图标必须彻底移除');
});

test('WEBUI-24: 主题校准 / 沉淀下限 / 主题提示词三块设置能力双端同源', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');

  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    // 1. 主题校准：固定时刻开关 + 三个参数 + 只读状态 + 保存动作 + 端点
    assert.ok(source.includes('主题校准'), `${name}: 设置页必须有「主题校准」区块`);
    assert.ok(source.includes('data-action="toggle-topic-enabled"'), `${name}: 主题校准必须提供每日开关`);
    assert.ok(source.includes('固定 04:00'), `${name}: 触发时刻必须固定 04:00`);
    for (const role of ['topic-lookback', 'topic-threshold', 'topic-min-entries']) {
      assert.ok(source.includes(`data-role="${role}"`), `${name}: 缺少 ${role} 输入`);
    }
    assert.ok(source.includes('data-action="save-topic-settings"'), `${name}: 缺少「保存主题参数」按钮`);
    assert.ok(source.includes('/api/topics/settings'), `${name}: 主题参数必须走 /api/topics/settings`);
    assert.ok(/topicDispatch\.provider/.test(source), `${name}: 只读状态须展示 provider`);
    assert.ok(/topicDispatch\.protocol/.test(source) && /topicDispatch\.model/.test(source), `${name}: 只读状态须展示 protocol / model`);
    assert.ok(/createdTopicIds/.test(source) && /updatedTopicIds/.test(source) && /assignedEntryIds/.test(source), `${name}: 只读状态须带上轮创建 / 更新 / 归入计数`);
    assert.ok(/state\.topicSettings/.test(source), `${name}: 必须有 topicSettings 状态位`);
    assert.ok(/lookbackDays/.test(source) && /mergeThreshold/.test(source) && /minEntries/.test(source), `${name}: 提交体字段名必须与后端契约一致`);
    assert.ok(source.includes("loadTopicSettings"), `${name}: 进入设置页必须拉取主题参数`);
    assert.ok(/loadPrompt\(\); loadTopicSettings\(\);/.test(source), `${name}: 进入设置页须同时拉取提示词与主题参数`);

    // 2. 触发器引擎区的沉淀下限（6–16），tune 提交 minDiscussionMessages。
    //    字段由 renderEngineSettings 的 field() 生成（参数化模板，不出现字面 data-role="…"），
    //    因此按字段 token 与限幅参数断言——字面 markup 校验已由 WEBUI-15 的语法检查兜底。
    assert.ok(source.includes("'tune-min-messages'"), `${name}: 触发器引擎缺少沉淀下限字段`);
    assert.ok(
      /['"]tune-min-messages['"], ['"]沉淀下限['"], 6, 16/.test(source) || source.includes('min="6" max="16"'),
      `${name}: 沉淀下限必须硬限幅 6–16`,
    );
    assert.ok(/minDiscussionMessages/.test(source), `${name}: 校准提交必须带 minDiscussionMessages`);

    // 3. 主题聚合提示词编辑区
    assert.ok(source.includes('主题聚合提示词'), `${name}: 设置页必须有主题聚合提示词区块`);
    assert.ok(source.includes('data-role="topic-system-prompt"'), `${name}: 缺少主题提示词编辑区`);
    assert.ok(source.includes('ptx-topic-prompt-status'), `${name}: 缺少主题提示词状态行`);
    assert.ok(source.includes('data-action="save-topic-prompt"') && source.includes('data-action="reset-topic-prompt"'), `${name}: 缺少主题提示词保存 / 恢复默认按钮`);
    assert.ok(/customTopicPrompt/.test(source), `${name}: 主题提示词必须走 customTopicPrompt 字段`);
    assert.ok(/topicEffectivePrompt/.test(source) && /topicDefaultPrompt/.test(source) && /isTopicCustom/.test(source), `${name}: 主题提示词必须回填服务端真值`);
    assert.ok(/topicField\.value = state\.prompt\.data\.topicEffectivePrompt/.test(source), `${name}: syncPromptUI 必须回填主题提示词`);
    assert.ok(/action === ["']save-topic-prompt["']/.test(source), `${name}: handleAction 必须分派主题提示词保存`);
    assert.ok(/action === ["']reset-topic-prompt["']/.test(source), `${name}: handleAction 必须分派主题提示词恢复默认`);
    assert.ok(/action === ["']save-topic-settings["']/.test(source), `${name}: handleAction 必须分派主题参数保存`);

    // 4. 连接凭据不进设置页：只读展示 provider / protocol / model，绝无输入框
    assert.equal(
      /data-role="[^"]*(?:provider|apikey|baseurl|model)[^"]*"/i.test(source),
      false,
      `${name}: 设置页不得出现 provider / apiKey / baseURL / model 输入`,
    );
    assert.equal(/data-role="[^"]*channel[^"]*"/i.test(source) && /data-role="[^"]*api-key/i.test(source), false, `${name}: 不得把凭据输入放进设置页`);
  }

  // 双端 DOM 名称逐字一致（同一批 data-role / data-action 在两处都出现）
  for (const token of [
    'data-action="toggle-topic-enabled"',
    'data-role="topic-lookback"',
    'data-role="topic-threshold"',
    'data-role="topic-min-entries"',
    'tune-min-messages',
    'data-role="topic-system-prompt"',
    'data-action="save-topic-prompt"',
    'data-action="reset-topic-prompt"',
    'ptx-topic-prompt-status',
    // 引擎切换契约（F1/F4 护栏）：双端必须同时出现这些 token，缺任一侧即回归。
    'engine-mode',
    'toggle-engine-autotune',
    'triggerMode',
    'potentialAutoTuning',
    'tune-dispatch-margin',
    'tune-density-mult',
    'tune-peak-cool',
    // 图片匿名化开关：设置页分区 + 开关动作 + 端点，三端必须同时存在
    '图片脱敏',
    'toggle-card-mask',
    '/api/card/settings',
  ]) {
    assert.ok(CLIENT_SOURCE.includes(token), `客户端缺少 ${token}`);
    assert.ok(html.includes(token) && dock.includes(token), `运行时缺少 ${token}`);
  }
});

test('WEBUI-25: 设置页大纲 / 单栏折叠 / 紫色辅助标签 / 表格无底色（双端同源）', () => {
  const html = renderLibraryHtml('/patchouli');
  const dock = renderTacticalDockComponent('/patchouli');
  for (const [name, source] of [['客户端组件', CLIENT_SOURCE], ['独立页面', html], ['内嵌组件', dock]]) {
    assert.ok(source.includes('ptx-settings-shell'), `${name}: 设置页必须有左栏大纲容器`);
    assert.ok(source.includes('ptx-settings-outline'), `${name}: 设置页必须有左栏大纲`);
    assert.ok(source.includes('toggle-section'), `${name}: 每个栏位必须可折叠`);
    assert.ok(source.includes('jump-section'), `${name}: 大纲必须可快捷跳转`);
    assert.ok(source.includes('decorateSettings'), `${name}: 大纲与折叠必须由运行时装饰`);
    assert.ok(source.includes('collapsedSections'), `${name}: 折叠态必须持久化`);
    assert.ok(source.includes('--bio-violet-strong'), `${name}: 必须定义紫色点睛令牌`);
    assert.ok(source.includes('--bio-slate'), `${name}: 必须定义青黛灰青令牌`);
    assert.ok(source.includes('--bio-cyan'), `${name}: 必须定义天水碧令牌`);
    assert.ok(/ptx-cause-l[^}]*var\(--bio-slate\)/.test(source), `${name}: 起因标签必须回落到青黛灰青`);
    assert.ok(/ptx-outcome-col\.is-open[^}]*var\(--bio-violet-strong\)/.test(source), `${name}: 仅未决落点保留紫色点睛`);
    assert.ok(/ptx-table th[^}]*var\(--bio-slate\)/.test(source), `${name}: 表头文字必须使用青黛灰青`);
    assert.ok(source.includes('background: transparent'), `${name}: 表头 / 行标题不得有底色`);
  }
});
