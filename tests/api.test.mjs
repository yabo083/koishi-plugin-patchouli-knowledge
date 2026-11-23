import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  Config,
  ModelDispatcher,
  PatchouliKnowledgeSystem,
  PATCHOULI_SYSTEM_PROMPT,
  PATCHOULI_SYSTEM_PROMPT_CONCISE,
  TOPIC_CURATOR_SYSTEM_PROMPT,
  normalizeCardSettingsPatch,
  normalizeTopicSettingsPatch,
  registerWebUi,
  resolveSystemPrompt,
  resolveTopicSystemPrompt,
  TRAFFIC_CAPACITY,
  TRAFFIC_SAMPLE_MS,
  WikiEngine,
} from '../lib/index.js';
import { persistCustomPrompt, persistTopicPrompt } from '../lib/plugin/custom-prompt.js';

const TEST_WIKI_DIR = path.resolve('tmp/test-api-wiki');

/**
 * Koa Router 替身：`use` 与 `get/post` 一样是真实注册入口。
 *
 * 插件把管理面守卫挂在 `<base>/api` 的 `use` 上；替身缺 `use` 时插件会按 fail closed
 * 跳过全部 `/api/*` 路由。因此这里记录中间件，`request()` 把命中的中间件串进请求链，
 * 守卫与线上一样真实生效——绝不在测试里旁路它。
 */
function createRouterDouble() {
  const routes = new Map();
  const middlewares = [];
  const router = {
    use: (prefix, middleware) => { middlewares.push({ prefix, middleware }); },
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };

  /** 按 `"GET /path"` 走完整中间件链；路由未注册（被闸门丢弃）时返回 undefined。 */
  const request = async (key, kCtx) => {
    const handler = routes.get(key);
    if (handler === undefined) return undefined;
    const path = key.slice(key.indexOf(' ') + 1);
    const applicable = middlewares.filter(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`));
    let index = -1;
    const dispatch = async () => {
      index += 1;
      if (index < applicable.length) return applicable[index].middleware(kCtx, dispatch);
      return handler(kCtx);
    };
    return dispatch();
  };

  return { router, routes, middlewares, request };
}

test('API-ENTRY-01: 词条详情接口回传 participants 与反驳方发言人', async () => {
  await fs.rm(TEST_WIKI_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_WIKI_DIR, { recursive: true });

  const engine = new WikiEngine({ wikiDir: TEST_WIKI_DIR });
  const entry = {
    id: '2026-10-25-speaker-chain',
    title: '发言人链路完整性之辩',
    channelId: 'qq-group-9001',
    date: '2026-10-25',
    status: 'tentative',
    tags: ['发言人', '记录链路'],
    summary: '群友检验词条是否完整记录支持者与质疑者。',
    background: '测试背景。',
    participants: ['Yellow A', 'Yellow B', 'Yellow D'],
    debateMatrix: [
      {
        viewpoint: '词条必须记录完整发言人',
        proponents: ['Yellow A', 'Yellow B'],
        opponents: ['Yellow D'],
        arguments: ['只写观点而不写人，词条就无法追溯'],
        counterArguments: ['完整记录会提高生成成本'],
      },
    ],
    consensus: ['发言人名单必须写入词条头部'],
    openQuestions: ['如何在长讨论中控制人名噪声'],
    keyQuotes: [{ author: 'Yellow D', quote: '没有署名的观点等于没有发生过。' }],
    metadata: { messageCount: 12, participantCount: 3, durationMinutes: 5, peakRate: 3.2 },
  };
  const written = await engine.saveEntry(entry);

  const record = {
    id: entry.id,
    title: entry.title,
    channelId: entry.channelId,
    date: entry.date,
    status: entry.status,
    tags: [...entry.tags],
    summary: entry.summary,
    participants: [...entry.participants],
    metadata: { ...entry.metadata },
    path: written.entryPath,
    createdAt: 1,
    updatedAt: 2,
  };

  const { router, routes } = createRouterDouble();
  const system = {
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    config: { channels: [] },
    localStore: { getEntry: async (id) => (id === entry.id ? record : undefined) },
    detector: { getStatus: () => ({}), getOptions: () => ({}) },
    dispatcher: { route: 'chatluna', model: '', hasExplicitModel: false, chatUrl: '', probe: async () => ({}) },
  };
  registerWebUi({ router }, system, '/patchouli');

  const handler = routes.get('GET /patchouli/api/entries/:id');
  assert.ok(handler, '详情路由必须注册');

  const kCtx = { params: { id: entry.id }, query: {}, request: {}, status: 200, body: undefined, set: () => {} };
  await handler(kCtx);

  assert.equal(kCtx.status, 200);
  const payload = kCtx.body;
  assert.deepEqual(payload.participants, ['Yellow A', 'Yellow B', 'Yellow D']);
  assert.equal(payload.debateMatrix.length, 1);
  assert.deepEqual(payload.debateMatrix[0].proponents, ['Yellow A', 'Yellow B']);
  assert.deepEqual(payload.debateMatrix[0].opponents, ['Yellow D']);
  assert.deepEqual(payload.debateMatrix[0].counterArguments, ['完整记录会提高生成成本']);
  assert.deepEqual(payload.consensus, ['发言人名单必须写入词条头部']);
  assert.deepEqual(payload.openQuestions, ['如何在长讨论中控制人名噪声']);
  assert.equal(payload.keyQuotes[0].author, 'Yellow D');
  assert.ok(payload.markdown.includes('Participants: [[Yellow A]], [[Yellow B]], [[Yellow D]]'));

  await fs.rm(TEST_WIKI_DIR, { recursive: true, force: true });
});

test('API-TRAFFIC-01: /api/status 与 /api/series 回传 traffic + sampleMs + serverTime', async () => {
  const traffic = [
    { timestamp: 1_700_000_000_000, count: 0 },
    { timestamp: 1_700_000_005_000, count: 3 },
    { timestamp: 1_700_000_010_000, count: 1 },
  ];
  const calls = [];
  const latestCalls = [];
  const latestMessage = {
    id: 'msg-status-1',
    channelId: '100000000',
    userName: '甲',
    content: '[图片] 只读横条',
    timestamp: 1_700_000_012_000,
    elements: [{ type: 'text', text: '[图片] 只读横条' }],
  };

  const { router, routes } = createRouterDouble();
  const system = {
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    config: { channels: ['100000000'] },
    localStore: { listChannels: async () => [] },
    detector: {
      getStatus: () => ({ currentRate: 6, baselineRate: 2, phase: 'BURSTING', bufferedCount: 3 }),
      getOptions: () => ({ burstMultiplier: 2.5 }),
    },
    dispatcher: { route: 'chatluna', model: '', hasExplicitModel: false, chatUrl: '', probe: async () => ({}) },
    shadowLedger: { stats: () => ({ written: 0, failed: 0, lastWriteAt: null }) },
    getTraffic: (channelId, limit = TRAFFIC_CAPACITY) => {
      calls.push({ channelId, limit });
      return traffic.slice(-limit);
    },
    getLatestMessage: (channelId) => {
      latestCalls.push(channelId);
      return { ...latestMessage };
    },
  };
  registerWebUi({ router }, system, '/patchouli');

  // 1. /api/status：指标 + traffic + sampleMs + serverTime，且旧 series 字段彻底消失
  const statusCtx = { params: {}, query: { channelId: '100000000' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET /patchouli/api/status')(statusCtx);

  assert.equal(statusCtx.body.channelId, '100000000');
  assert.equal(statusCtx.body.phase, 'BURSTING');
  assert.equal(statusCtx.body.options.burstMultiplier, 2.5);
  assert.deepEqual(statusCtx.body.traffic, traffic, '状态响应必须携带真实 5 秒流量桶');
  assert.equal(statusCtx.body.sampleMs, TRAFFIC_SAMPLE_MS, '必须声明固定采样节拍');
  assert.equal(typeof statusCtx.body.serverTime, 'number', '必须回传服务器墙钟供前端对齐时间轴');
  assert.ok(Math.abs(statusCtx.body.serverTime - Date.now()) < 5000, 'serverTime 必须为当前服务器墙钟');
  assert.deepEqual(statusCtx.body.latestMessage, latestMessage, '状态响应必须附带当前群最新消息预览');
  assert.equal(latestCalls[0], '100000000', 'latestMessage 必须按请求群取值');
  assert.equal('series' in statusCtx.body, false, '旧 series 字段必须彻底移除');

  // 2. /api/series：同新契约，limit 截取最近 N 点
  const seriesCtx = { params: {}, query: { channelId: '100000000', limit: '2' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET /patchouli/api/series')(seriesCtx);
  assert.equal(seriesCtx.body.channelId, '100000000');
  assert.equal(seriesCtx.body.limit, 2);
  assert.deepEqual(seriesCtx.body.traffic, traffic.slice(-2), 'limit 必须截取最近 N 个流量桶');
  assert.equal(seriesCtx.body.sampleMs, TRAFFIC_SAMPLE_MS);
  assert.equal(typeof seriesCtx.body.serverTime, 'number');
  assert.equal('series' in seriesCtx.body, false, '旧 series 字段必须彻底移除');

  // 3. limit 越界收敛：上限 60，下限 1
  const capCtx = { params: {}, query: { channelId: '100000000', limit: '9999' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET /patchouli/api/series')(capCtx);
  assert.equal(capCtx.body.limit, TRAFFIC_CAPACITY, 'limit 上限必须收敛到 60 点');
  assert.equal(calls[calls.length - 1].limit, TRAFFIC_CAPACITY, '必须以收敛后的 limit 调用 getTraffic');

  const zeroCtx = { params: {}, query: { channelId: '100000000', limit: '0' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET /patchouli/api/series')(zeroCtx);
  assert.equal(zeroCtx.body.limit, 1, 'limit 下限必须收敛到 1 点');

  // 4. 缺省 channelId 回落到内测群
  const defaultCtx = { params: {}, query: {}, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET /patchouli/api/status')(defaultCtx);
  assert.equal(defaultCtx.body.channelId, '100000000');
  assert.equal(calls[calls.length - 1].channelId, '100000000');
  assert.deepEqual(defaultCtx.body.traffic, traffic, '缺省群同样返回完整流量桶');
});


/** 提示词测试用的知识库根目录：自定义提示词必须真实落盘到 `<wikiDir>/.patchouli/custom-prompt.txt`。 */
const PROMPT_WIKI_DIR = path.resolve('tmp/test-prompt-wiki');
const PROMPT_FILE = path.join(PROMPT_WIKI_DIR, '.patchouli', 'custom-prompt.txt');
const TOPIC_PROMPT_FILE = path.join(PROMPT_WIKI_DIR, '.patchouli', 'custom-topic-prompt.txt');

/** 提示词路由的宿主：真实可变的 dispatcher 配置对象 + 真实知识库目录。 */
async function createPromptHost() {
  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
  await fs.mkdir(PROMPT_WIKI_DIR, { recursive: true });

  const dispatcherConfig = { provider: 'standalone', apiKey: 'sk-test', model: 'gpt-4o-mini' };
  const { router, routes } = createRouterDouble();
  const topics = { enabled: true, hour: 4, minute: 0, lookbackDays: 30, mergeThreshold: 0.5, minEntries: 1 };
  const cardSettings = { maskNames: true };
  // 提示词的运行时覆盖：真实系统挂在 `ModelDispatcher` 上，这里用同形状替身，
  // 让「保存 → 读取」走与生产一致的路径（不再依赖写入宿主 config）。
  const dispatcher = {
    customSystemPromptText: '',
    topicPrompt: '',
    get systemPrompt() {
      return resolveSystemPrompt(this.customSystemPromptText.trim() || undefined);
    },
  };
  const system = {
    dispatcher,
    saveCustomPrompt: async (prompt) => {
      dispatcher.customSystemPromptText = await persistCustomPrompt(PROMPT_WIKI_DIR, prompt);
    },
    saveTopicPrompt: async (prompt) => {
      dispatcher.topicPrompt = await persistTopicPrompt(PROMPT_WIKI_DIR, prompt);
    },
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    config: { channels: [], dispatcher: dispatcherConfig, topics },
    wikiDir: PROMPT_WIKI_DIR,
    localStore: {},
    detector: { getStatus: () => ({}), getOptions: () => ({}) },
    lastTopicRun: null,
    shadowLedger: { stats: () => ({ written: 0, failed: 0, lastWriteAt: null }) },
    getTopicSettings: () => ({ ...topics }),
    updateTopicSettings: async (patch) => {
      const normalized = normalizeTopicSettingsPatch(patch);
      Object.assign(topics, normalized);
      return { ...topics };
    },
    getCardSettings: () => ({ ...cardSettings }),
    updateCardSettings: async (patch) => {
      Object.assign(cardSettings, normalizeCardSettingsPatch(patch));
      return { ...cardSettings };
    },
  };
  registerWebUi({ router }, system, '/patchouli');
  return { dispatcher, dispatcherConfig, routes, system, topics };
}

function promptCtx(body) {
  return { params: {}, query: {}, request: body === undefined ? {} : { body }, status: 200, body: null, set: () => {} };
}

/** 读取落盘文件；不存在时返回 null（不抛错，便于断言「已删除」）。 */
async function readPromptFile() {
  try {
    return await fs.readFile(PROMPT_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

test('API-PROMPT-01: GET /api/prompt 回传默认 / 精简 / 当前生效提示词', async () => {
  const { routes, dispatcher } = await createPromptHost();
  const handler = routes.get('GET /patchouli/api/prompt');
  assert.ok(handler, '提示词查阅路由必须注册');

  const ctx = promptCtx();
  await handler(ctx);

  assert.equal(ctx.body.defaultPrompt, PATCHOULI_SYSTEM_PROMPT, '必须回传默认帕秋莉提示词全文');
  assert.equal(ctx.body.concisePrompt, PATCHOULI_SYSTEM_PROMPT_CONCISE, '必须回传精简提示词全文');
  assert.equal('preset' in ctx.body, false, '命名预设字段必须彻底移除（配置表单不再暴露预设）');
  assert.equal(ctx.body.customPrompt, '', '未配置自定义提示词时为空串');
  assert.equal(ctx.body.isCustom, false);
  assert.equal(ctx.body.effectivePrompt, PATCHOULI_SYSTEM_PROMPT, '无自定义时实际生效的就是内置提示词');
  assert.equal(dispatcher.customSystemPromptText, '', 'GET 必须是纯读，不得写入配置');
  assert.equal(await readPromptFile(), null, 'GET 必须是纯读，不得创建落盘文件');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-PROMPT-02: POST /api/prompt 落盘 + 热更新，调度器下一轮即时生效', async () => {
  const { routes, dispatcher: hostDispatcher, dispatcherConfig } = await createPromptHost();
  const handler = routes.get('POST /patchouli/api/prompt');
  assert.ok(handler, '提示词写入路由必须注册');

  const customPrompt = '你是测试用帕秋莉提示词，只依据消息原文沉淀知识。';
  const saved = promptCtx({ customPrompt });
  await handler(saved);

  assert.equal(saved.body.ok, true);
  assert.equal(hostDispatcher.customSystemPromptText, customPrompt, '必须写回运行时覆盖');
  assert.equal(saved.body.customPrompt, customPrompt);
  assert.equal(saved.body.isCustom, true);
  assert.ok(saved.body.effectivePrompt.startsWith(customPrompt), '自定义提示词必须整段生效');
  assert.ok(saved.body.effectivePrompt.includes('shouldDiscard'), '自定义提示词必须自动补齐输出契约');
  assert.equal(await readPromptFile(), customPrompt, '自定义提示词必须原子落盘到 .patchouli/custom-prompt.txt');

  // 热生效：调度器读取同一份配置对象，无需重建实例即可换用新提示词
  const requests = [];
  const dispatcher = new ModelDispatcher(dispatcherConfig, {
    fetch: async (url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp_prompt',
          object: 'response',
          status: 'completed',
          output_text: JSON.stringify({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.1 }),
          usage: { total_tokens: 10 },
        }),
        text: async () => '',
      };
    },
  });

  // 真实系统的 saveCustomPrompt 会把覆盖推给同一个 dispatcher 实例；替身宿主里手工对齐。
  dispatcher.setPromptOverrides({ system: hostDispatcher.customSystemPromptText });
  assert.equal(dispatcher.systemPrompt, saved.body.effectivePrompt, '调度器与 API 必须共享同一条提示词解析路径');

  const session = {
    sessionId: 'session-prompt',
    channelId: 'qq-group-prompt',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_600_000,
    messages: [
      { id: 'p1', channelId: 'c', userId: 'u1', userName: 'A', content: '向量检索的召回率取决于分块粒度。', timestamp: 1 },
      { id: 'p2', channelId: 'c', userId: 'u2', userName: 'B', content: '分块过细会让上下文断裂，需要重叠窗口。', timestamp: 2 },
    ],
    peakRate: 9,
    triggerReason: '突发',
  };
  await dispatcher.dispatch(session);

  assert.equal(requests.length, 1, '必须真实发起一次模型请求');
  assert.equal(requests[0].instructions, saved.body.effectivePrompt, '请求系统指令必须使用热更新后的提示词');
  assert.equal(requests[0].input[0].role, 'user');

  // 一键恢复默认：清空内存、删除落盘文件，并回落到内置提示词
  const restored = promptCtx({ customPrompt: '' });
  await handler(restored);

  assert.equal(restored.body.ok, true);
  assert.equal(hostDispatcher.customSystemPromptText, '', '恢复默认必须清空自定义提示词');
  assert.equal(restored.body.isCustom, false);
  assert.equal(restored.body.customPrompt, '');
  assert.equal(restored.body.effectivePrompt, PATCHOULI_SYSTEM_PROMPT, '恢复默认后必须立即回落到内置提示词');
  dispatcher.setPromptOverrides({ system: hostDispatcher.customSystemPromptText });
  assert.equal(dispatcher.systemPrompt, PATCHOULI_SYSTEM_PROMPT, '调度器必须跟随恢复默认');
  assert.equal(await readPromptFile(), null, '恢复默认必须删除落盘文件，绝不留空文件');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-PROMPT-04: 两套提示词独立持久化，主题提示词只影响主题聚合', async () => {
  const { routes, dispatcher, system } = await createPromptHost();
  const getHandler = routes.get('GET /patchouli/api/prompt');
  const postHandler = routes.get('POST /patchouli/api/prompt');

  const initial = promptCtx();
  await getHandler(initial);
  assert.equal(initial.body.topicDefaultPrompt, TOPIC_CURATOR_SYSTEM_PROMPT);
  assert.equal(initial.body.topicCustomPrompt, '');
  assert.equal(initial.body.isTopicCustom, false);
  assert.equal(initial.body.topicEffectivePrompt, resolveTopicSystemPrompt());

  const topicPrompt = '你是测试用主题聚合提示词，只输出一个 JSON 对象。';
  const saved = promptCtx({ customTopicPrompt: topicPrompt });
  await postHandler(saved);
  assert.equal(saved.body.ok, true);
  assert.equal(dispatcher.topicPrompt, topicPrompt, '主题提示词必须写回运行时覆盖');
  assert.equal(dispatcher.customSystemPromptText, '', '保存主题提示词不得改动词条提示词');
  assert.equal(saved.body.isTopicCustom, true);
  assert.ok(saved.body.topicEffectivePrompt.startsWith(topicPrompt));
  assert.ok(saved.body.topicEffectivePrompt.includes('JSON'), '主题提示词必须自动补齐输出契约');
  assert.equal(await fs.readFile(TOPIC_PROMPT_FILE, 'utf8'), topicPrompt);

  const restored = promptCtx({ customTopicPrompt: '' });
  await postHandler(restored);
  assert.equal(dispatcher.topicPrompt, '', '空主题提示词等同恢复默认');
  assert.equal(await fs.readFile(TOPIC_PROMPT_FILE, 'utf8').catch(() => null), null, '恢复默认必须删除落盘文件');
  assert.equal(system.config.dispatcher.customTopicPrompt, undefined, '宿主 config 不得被写入');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-TOPIC-01: 主题校准参数读写、夹紧与只读状态', async () => {
  const { routes, topics } = await createPromptHost();
  const getHandler = routes.get('GET /patchouli/api/topics/settings');
  const postHandler = routes.get('POST /patchouli/api/topics/settings');

  const read = promptCtx();
  await getHandler(read);
  assert.deepEqual(read.body.settings, topics);
  assert.equal(read.body.dispatcher.provider, 'custom', '历史 standalone 在只读状态里归一化为 custom');
  assert.equal(read.body.lastRun, null);

  const write = promptCtx({ hour: 99, minute: -5, lookbackDays: 999, mergeThreshold: 2, minEntries: 0 });
  await postHandler(write);
  assert.equal(write.body.ok, true);
  assert.equal(write.body.settings.hour, 23);
  assert.equal(write.body.settings.minute, 0);
  assert.equal(write.body.settings.lookbackDays, 90);
  assert.equal(write.body.settings.mergeThreshold, 1);
  assert.equal(write.body.settings.minEntries, 1);
  assert.equal(topics.hour, 23, '热更新必须写入同一配置对象');

  const unknown = promptCtx({ hour: 6, apiKey: 'leak-attempt' });
  await postHandler(unknown);
  assert.equal(unknown.body.settings.hour, 6);
  assert.equal('apiKey' in unknown.body.settings, false, '面板接口不得接受部署面凭据字段');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-CARD-01: 图片匿名化开关读写——默认开启、可关闭、未知字段丢弃', async () => {
  const { routes, system } = await createPromptHost();
  const getHandler = routes.get('GET /patchouli/api/card/settings');
  const postHandler = routes.get('POST /patchouli/api/card/settings');
  assert.ok(getHandler && postHandler, '出图选项路由必须注册');

  const initial = promptCtx();
  await getHandler(initial);
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.settings.maskNames, true, '默认必须脱敏');

  const off = promptCtx({ settings: { maskNames: false } });
  await postHandler(off);
  assert.equal(off.body.ok, true);
  assert.equal(off.body.settings.maskNames, false);
  assert.equal(system.getCardSettings().maskNames, false, '必须写入实时配置（下次出图即生效）');

  const junk = promptCtx({ settings: { maskNames: false, apiKey: 'leak' } });
  await postHandler(junk);
  assert.equal('apiKey' in junk.body.settings, false, '未知字段不得进入设置');
  assert.equal(junk.body.settings.maskNames, false);

  const bad = promptCtx({ settings: 'nope' });
  await postHandler(bad);
  assert.equal(bad.status, 400, '非法体型必须拒绝');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-PROMPT-03: POST /api/prompt 缺省 customPrompt 等同清空，非法体型被拒绝', async () => {
  const { routes, dispatcher } = await createPromptHost();
  const handler = routes.get('POST /patchouli/api/prompt');

  const noFields = promptCtx({});
  await handler(noFields);
  assert.equal(noFields.status, 400, '两个提示词字段都缺省时必须拒绝，避免静默清空');
  assert.equal(noFields.body.ok, false);

  const presetOnly = promptCtx({ customPrompt: '' });
  await handler(presetOnly);
  assert.equal(presetOnly.body.ok, true);
  assert.equal(dispatcher.customSystemPromptText, '', '空白 customPrompt 必须收敛为空串');
  assert.equal(presetOnly.body.effectivePrompt, PATCHOULI_SYSTEM_PROMPT);

  const blank = promptCtx({ customPrompt: '  \n\t  ' });
  await handler(blank);
  assert.equal(blank.body.ok, true);
  assert.equal(dispatcher.customSystemPromptText, '', '仅含空白的提交必须收敛为空串（等同恢复默认）');
  assert.equal(await readPromptFile(), null, '仅含空白的提交不得留下落盘文件');

  const invalid = promptCtx('not-an-object');
  const before = dispatcher.customSystemPromptText;
  await handler(invalid);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.ok, false);
  assert.equal(dispatcher.customSystemPromptText, before, '非法请求不得改动现有配置');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-PROMPT-05: 单次提示词上限 64 KiB，超限 400 且不落盘', async () => {
  const { routes, dispatcher } = await createPromptHost();
  const handler = routes.get('POST /patchouli/api/prompt');
  const LIMIT = 64 * 1024;

  // 恰好 64 KiB（ASCII 一字符一字节）必须放行：上限是闭区间。
  const exact = 'a'.repeat(LIMIT);
  const accepted = promptCtx({ customPrompt: exact });
  await handler(accepted);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.ok, true);
  assert.equal(await readPromptFile(), exact);

  // 超 1 字节 → 400；磁盘与运行时都保持上一次的值。
  const overEntry = promptCtx({ customPrompt: 'b'.repeat(LIMIT + 1) });
  await handler(overEntry);
  assert.equal(overEntry.status, 400);
  assert.equal(overEntry.body.ok, false);
  assert.match(overEntry.body.error, /customPrompt/u);
  assert.equal(await readPromptFile(), exact, '超限不得改动已落盘提示词');
  assert.equal(dispatcher.customSystemPromptText, exact, '超限不得写回运行时');

  // 主题提示词独立计：多字节字符按 UTF-8 字节数判（21846 × 3 = 65538 > 65536）。
  const overTopic = promptCtx({ customTopicPrompt: '啊'.repeat(21846) });
  await handler(overTopic);
  assert.equal(overTopic.status, 400);
  assert.match(overTopic.body.error, /customTopicPrompt/u);
  assert.equal(dispatcher.topicPrompt, '', '超限不得写回运行时');
  assert.equal(await fs.readFile(TOPIC_PROMPT_FILE, 'utf8').catch(() => null), null, '超限不得落盘');

  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
});

test('API-PROMPT-04: 服务重启后自动回灌 .patchouli/custom-prompt.txt，恢复默认即删除文件', async () => {
  await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
  await fs.mkdir(PROMPT_WIKI_DIR, { recursive: true });

  const persisted = '落盘帕秋莉提示词：只依据消息原文沉淀，遇到噪声一律舍弃。\n第二行保持缩进与换行。';
  await fs.mkdir(path.dirname(PROMPT_FILE), { recursive: true });
  await fs.writeFile(PROMPT_FILE, persisted, 'utf8');

  const config = Config({
    storage: { wikiDir: PROMPT_WIKI_DIR },
    dispatcher: { provider: 'standalone', apiKey: 'sk-test', model: 'gpt-4o-mini' },
  });
  const system = new PatchouliKnowledgeSystem(config, { info: () => {}, warn: () => {}, error: () => {} });

  try {
    await system.ready;

    assert.equal(system.dispatcher.customSystemPromptText, persisted, '启动必须回灌落盘的自定义提示词（含换行缩进）');
    assert.equal(config.dispatcher.customSystemPrompt, undefined, '回灌不得写宿主 config（ADR-022）');
    assert.equal(system.dispatcher.systemPrompt, resolveSystemPrompt(persisted), '回灌后调度器必须立刻使用该提示词');

    // 保存默认内容 -> 删除落盘文件 + 清空内存
    await system.saveCustomPrompt('');
    assert.equal(system.dispatcher.customSystemPromptText, '');
    assert.equal(system.dispatcher.systemPrompt, PATCHOULI_SYSTEM_PROMPT, '恢复默认后调度器回落到内置提示词');
    assert.equal(await readPromptFile(), null, '恢复默认必须删除落盘文件');

    // 再写入一次，模拟「面板保存 -> 重启」的完整闭环
    await system.saveCustomPrompt(persisted);
    assert.equal(await readPromptFile(), persisted, '保存必须原子落盘');
    assert.equal(system.dispatcher.customSystemPromptText, persisted, '保存必须同时热更新内存配置');

    await fs.rm(PROMPT_FILE, { force: true });
    await system.restoreCustomPrompt();
    assert.equal(system.dispatcher.customSystemPromptText, '', '文件缺失时回灌必须收敛为内置提示词');

    // 空白文件同样视为「未自定义」
    await fs.writeFile(PROMPT_FILE, '  \n\n  ', 'utf8');
    await system.restoreCustomPrompt();
    assert.equal(system.dispatcher.customSystemPromptText, '', '仅含空白的文件必须视为未自定义');
  } finally {
    system.dispose();
    await fs.rm(PROMPT_WIKI_DIR, { recursive: true, force: true });
  }
});

test('API-TOPIC-02: 手动主题校准按白名单群扇出、force 透传并返回逐群结果', async () => {
  const { router, routes } = createRouterDouble();
  const calls = [];
  const system = {
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    config: { channels: ['g1', 'g2'] },
    localStore: { listChannels: async () => ['g1', 'g2'] },
    mediaRegistry: { resolve: () => undefined },
    runTopics: async (channelId, options) => {
      calls.push({ channelId, options });
      return { channelId, dayKey: '2026-11-02', createdTopicIds: [], updatedTopicIds: [], assignedEntryIds: [] };
    },
  };
  registerWebUi({ router }, system, '/patchouli');

  const handler = routes.get('POST /patchouli/api/topics');
  assert.equal(typeof handler, 'function');
  const koa = { request: { body: { force: true } }, query: {}, status: 0, body: null };
  await handler(koa);

  assert.equal(koa.status, 0, '成功路径不写 status，交由框架默认 200');
  assert.equal(koa.body.ok, true);
  assert.equal(koa.body.force, true);
  assert.deepEqual(koa.body.results.map((item) => item.channelId), ['g1', 'g2']);
  assert.deepEqual(calls, [
    { channelId: 'g1', options: { force: true } },
    { channelId: 'g2', options: { force: true } },
  ]);

  // 指定单群 + force:false
  calls.length = 0;
  const single = { request: { body: { channelId: 'g2', force: false } }, query: {}, status: 0, body: null };
  await handler(single);
  assert.deepEqual(calls, [{ channelId: 'g2', options: { force: false } }]);
});

test('TUNE-API-03: /api/tune 夹紧 thetaMin（[10,60]，3 位小数）并在 tuning 中回传', async () => {
  const options = {
    windowSizeSeconds: 60,
    burstMultiplier: 2.5,
    minBurstRate: 6,
    quiescenceSeconds: 300,
    coolingRatioThreshold: 1.1,
    minDiscussionMessages: 12,
    maxBufferMessages: 200,
    baselineEwmaAlpha: 0.05,
    triggerMode: 'shadow',
    thetaMin: 20,
    rhoMin: 1.2,
  };
  const { router, routes } = createRouterDouble();
  const saves = [];
  const system = {
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    shadowLedger: { stats: () => ({ written: 0, failed: 0, lastWriteAt: null }) },
    config: { channels: ['tune-channel'] },
    detector: {
      getStatus: () => ({ currentRate: 0, baselineRate: 0, phase: 'IDLE', bufferedCount: 0 }),
      getOptions: () => ({ ...options }),
      updateOptions: (channelId, patch) => {
        Object.assign(options, patch);
      },
    },
    localStore: {
      listChannels: async () => ['tune-channel'],
      saveCadenceState: async (snapshot) => {
        saves.push(snapshot);
        return snapshot;
      },
    },
    getTraffic: () => [],
    getLatestMessage: () => null,
    dispatcher: { route: 'chatluna', model: '', hasExplicitModel: false, chatUrl: '', probe: async () => ({}) },
  };
  registerWebUi({ router }, system, '/patchouli');

  const tune = routes.get('POST /patchouli/api/tune');
  assert.equal(typeof tune, 'function', '/api/tune 必须注册');
  const submit = async (payload) => {
    const ctx = { params: {}, query: {}, request: { body: payload }, status: 200, body: null, set: () => {} };
    await tune(ctx);
    return ctx;
  };

  // 上界：99.1234 → 60，越界键进 clamped，响应同时回传新视图
  const over = await submit({ channelId: 'tune-channel', options: { thetaMin: 99.1234 } });
  assert.equal(over.status, 200);
  assert.equal(over.body.ok, true);
  assert.equal(over.body.options.thetaMin, 60, '上界必须夹到 60');
  assert.ok(over.body.clamped.includes('thetaMin'), `越界键必须回传，实际 ${over.body.clamped.join(',')}`);
  assert.equal(over.body.tuning.parameters.thetaMin, 60, 'tuning 视图必须反映夹紧后的值');
  assert.deepEqual(over.body.tuning.limits.thetaMin, [10, 60], 'tuning.limits 必须带 thetaMin 区间');
  assert.equal(over.body.options.triggerMode, 'shadow', '非法夹紧不影响其余参数');

  // 下界：1 → 10
  const under = await submit({ channelId: 'tune-channel', options: { thetaMin: 1 } });
  assert.equal(under.body.options.thetaMin, 10);
  assert.ok(under.body.clamped.includes('thetaMin'));

  // 区间内 3 位小数原样下发：不进 clamped
  const precise = await submit({ channelId: 'tune-channel', options: { thetaMin: 21.234 } });
  assert.equal(precise.body.options.thetaMin, 21.234);
  assert.deepEqual(precise.body.clamped, []);

  // 超过 3 位小数：按既有连续值口径四舍五入后下发
  const rounded = await submit({ channelId: 'tune-channel', options: { thetaMin: 21.23456 } });
  assert.equal(rounded.body.options.thetaMin, 21.235, '保留 3 位小数');
  assert.ok(rounded.body.clamped.includes('thetaMin'), '被改写的值必须如实回传');
  assert.equal(saves.length, 4, '每次下发都要落盘节奏快照');
  assert.equal(saves[3].options.thetaMin, 21.235);

  // /api/status 的 tuning 结构同样带 thetaMin（含从未校准过的群）
  const statusCtx = { params: {}, query: { channelId: 'tune-channel' }, request: {}, status: 200, body: null, set: () => {} };
  await routes.get('GET /patchouli/api/status')(statusCtx);
  assert.equal(statusCtx.body.tuning.parameters.thetaMin, 21.235);
  assert.deepEqual(statusCtx.body.tuning.limits.thetaMin, [10, 60]);
});

/** 最小可用的 `/api/status` 宿主：只提供状态接口真正读取的字段。 */
function statusHost(extra = {}) {
  return {
    media: { stats: async () => ({ pending: 0, used: 0 }), metrics: { produced: 0, failed: 0, consumed: 0, swept: 0 } },
    config: { channels: [] },
    localStore: { listChannels: async () => [] },
    detector: { getStatus: () => ({ phase: 'IDLE' }), getOptions: () => ({}) },
    dispatcher: { route: 'chatluna', model: '', hasExplicitModel: false, chatUrl: '', probe: async () => ({}) },
    getTraffic: () => [],
    getLatestMessage: () => null,
    ...extra,
  };
}

function statusCtx(query = {}) {
  return { params: {}, query, request: {}, status: 200, body: null, set: () => {} };
}

test('API-AUTH-01: 宿主 router 没有 use 时不注册任何 /api/* 路由（fail closed）', () => {
  const routes = new Map();
  const noUseRouter = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    registerWebUi({ router: noUseRouter }, statusHost(), '/patchouli');
  } finally {
    console.warn = originalWarn;
  }

  for (const key of [
    'GET /patchouli/api/status',
    'GET /patchouli/api/entries',
    'GET /patchouli/api/channels',
    'GET /patchouli/api/prompt',
    'POST /patchouli/api/tune',
    'POST /patchouli/api/clear',
    'POST /patchouli/api/topics',
  ]) {
    assert.equal(routes.has(key), false, `${key} 在守卫挂不上时绝不能注册`);
  }

  // 非 /api 入口只返回 JSON 或自带鉴权，照常注册；独立页 HTML 已删除，不再有页面壳
  assert.equal(routes.has('GET /patchouli'), false, '独立页 HTML 路由必须删除（UI 只在 Console 浮窗）');
  assert.equal(routes.has('GET /patchouli/'), false, '独立页根路径同样不得注册');
  assert.equal(routes.has('GET /patchouli/session'), true, '会话自检照常注册');
  assert.equal(routes.has('POST /patchouli/login'), true, '登录照常注册');
  assert.equal(routes.has('POST /patchouli/bootstrap'), true, '首次初始化照常注册');

  assert.ok(
    warnings.some((message) => message.includes('/patchouli/api') && message.includes('use')),
    '跳过硬保护路由必须留下告警，不能静默降级',
  );
});

test('API-AUTH-02: 守卫真实参与请求链——无凭据 401，带令牌放行', async () => {
  const { router, middlewares, request } = createRouterDouble();
  const API_TOKEN = 'router-guard-test-token';
  registerWebUi({ router }, statusHost({ config: { channels: [], security: { apiToken: API_TOKEN } } }), '/patchouli');

  assert.equal(middlewares.length, 1, '守卫必须以 use 中间件挂载一次');
  assert.equal(middlewares[0].prefix, '/patchouli/api');

  const anonymous = statusCtx();
  await request('GET /patchouli/api/channels', anonymous);
  assert.equal(anonymous.status, 401, '未认证请求必须在中间件层被拦下');
  assert.deepEqual(anonymous.body, { error: 'unauthorized', reason: 'missing' });

  const authorized = { ...statusCtx(), headers: { 'x-api-token': API_TOKEN } };
  await request('GET /patchouli/api/channels', authorized);
  assert.deepEqual(authorized.body, { channels: [], configured: [] }, '带令牌必须穿透守卫到业务处理器');
});

test('API-OBS-01: 宿主缺 shadowLedger 时 /api/status 回零值而不是 500', async () => {
  const { router, routes } = createRouterDouble();
  registerWebUi({ router }, statusHost(), '/patchouli');

  const ctx = statusCtx({ channelId: '100000000' });
  await routes.get('GET /patchouli/api/status')(ctx);

  assert.equal(ctx.status, 200, '缺可观测性切片不得把监控页打成 500');
  assert.deepEqual(ctx.body.observability, { written: 0, failed: 0, lastWriteAt: null });

  // 有台账时照旧透传真实计数（探测不得把真实值抹平成零）
  const withLedger = createRouterDouble();
  registerWebUi(
    { router: withLedger.router },
    statusHost({ shadowLedger: { stats: () => ({ written: 7, failed: 1, lastWriteAt: 1234 }) } }),
    '/patchouli',
  );
  const realCtx = statusCtx({ channelId: '100000000' });
  await withLedger.routes.get('GET /patchouli/api/status')(realCtx);
  assert.deepEqual(realCtx.body.observability, { written: 7, failed: 1, lastWriteAt: 1234 });
});

test('API-TUNE-04: /api/tune 把宿主抛出的 RangeError 归为 400，其余异常仍是 500', async () => {
  const build = (updateOptions) => {
    const { router, routes } = createRouterDouble();
    registerWebUi(
      { router },
      {
        config: { channels: ['tune-channel'] },
        detector: {
          getStatus: () => ({ phase: 'IDLE' }),
          getOptions: () => ({ thetaMin: 20 }),
          updateOptions,
        },
        localStore: { saveCadenceState: async (snapshot) => snapshot },
      },
      '/patchouli',
    );
    return routes.get('POST /patchouli/api/tune');
  };

  const submit = async (handler) => {
    const ctx = { params: {}, query: {}, request: { body: { channelId: 'tune-channel', options: { thetaMin: 22 } } }, status: 200, body: null, set: () => {} };
    await handler(ctx);
    return ctx;
  };

  const invalid = await submit(build(() => { throw new RangeError('thetaMin out of range'); }));
  assert.equal(invalid.status, 400, '非法取值属于请求错误');
  assert.equal(invalid.body.ok, false);
  assert.match(invalid.body.error, /out of range/u);

  const failure = await submit(build(() => { throw new Error('磁盘写失败'); }));
  assert.equal(failure.status, 500, '真正的服务端故障仍是 500');
  assert.equal(failure.body.ok, false);
});
