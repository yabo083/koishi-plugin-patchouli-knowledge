import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { PatchouliKnowledgeSystem, TRAFFIC_CAPACITY, TRAFFIC_SAMPLE_MS } from '../lib/index.js';

function responsesPayload(text, tokens = 10) {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: tokens },
  };
}

const E2E_WIKI_DIR = path.resolve('tmp/e2e-llmwiki');

test('SYSTEM-E2E: 端到端完整链路 (消息流 -> 突发感应 -> 迟智平息 -> 知识沉淀 -> llmwiki/存储 -> 参数自适应)', async () => {
  await fs.rm(E2E_WIKI_DIR, { recursive: true, force: true });
  await fs.mkdir(E2E_WIKI_DIR, { recursive: true });

  const notifications = [];
  const logMessages = [];

  const mockModelResponse = responsesPayload(
    JSON.stringify({
            shouldDiscard: false,
            title: '微服务与单体架构演进的边界',
            summary: '群友讨论了业务初期单体向微服务拆分的时机与隐形成本。',
            background: '讨论源于某中台重构引发的运维链路剧增问题。',
            status: 'verified',
            tags: ['微服务', '单体架构', '系统演进'],
            debateMatrix: [
              {
                viewpoint: '过早拆分微服务是架构灾难',
                proponents: ['小明'],
                arguments: ['网络分区与分布式事务大幅抬高开发调试成本'],
                counterArguments: ['单体在团队规模膨胀时合并冲突更难解'],
              },
            ],
            consensus: ['组织架构未达到两披萨团队规模前，模块化单体是更优解'],
            openQuestions: ['如何低成本制定服务边界切分标准？'],
            keyQuotes: [
              { author: '小明', quote: '先做单体并不丢人，把单体做成不可拆分的泥潭才丢人。' },
            ],
            qualityScore: 0.9,
            discardReason: null,
  }),
    1800,
  );

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockModelResponse,
    text: async () => JSON.stringify(mockModelResponse),
  });

  const config = {
    enabled: true,
    channels: ['group-e2e-test'],
    notifyOnSummarized: true,
    trigger: {
      triggerMode: 'rate',
      windowSizeSeconds: 60,
      burstMultiplier: 2.0,
      minBurstRate: 5,
      quiescenceSeconds: 60, // 60 秒平息
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 5,
      maxBufferMessages: 200,
      baselineEwmaAlpha: 0.1,
    },
    dispatcher: {
      provider: 'custom',
      apiKey: 'mock-key',
      baseURL: 'https://mock.api/v1',
      customModel: 'gpt-4o-mini',
      enableAutoTuning: true,
    },
    storage: {
      wikiDir: E2E_WIKI_DIR,
    },
  };

  const logger = {
    info: (m) => logMessages.push(`INFO: ${m}`),
    warn: (m) => logMessages.push(`WARN: ${m}`),
    error: (m) => logMessages.push(`ERROR: ${m}`),
  };

  const onNotify = async (ch, text) => {
    notifications.push({ channelId: ch, text });
  };

  const system = new PatchouliKnowledgeSystem(config, logger, onNotify, { fetch: mockFetch });

  const channelId = 'group-e2e-test';
  let now = 1700000000000;

  // 1. 模拟密集争论爆发 (10 条消息，每 3 秒 1 条)
  for (let i = 1; i <= 10; i++) {
    now += 3000;
    await system.onIncomingMessage({
      id: `e2e-msg-${i}`,
      channelId,
      userId: `user-${i % 2}`,
      userName: i % 2 === 0 ? '小明' : '小红',
      content: `关于架构拆分的激烈争论观点 ${i}：单体与微服务的权衡`,
      timestamp: now,
    });
  }

  // 验证当前状态处于 BURSTING
  const m1 = system.detector.getStatus(channelId, now);
  assert.equal(m1.phase, 'BURSTING');
  assert.equal(notifications.length, 0, '讨论高峰不发通知');

  // 2. 模拟平息：跳过 100 秒无次级突发 (超过 60 秒 quiescenceSeconds)
  now += 100_000;
  // 注入触发心跳
  await system.onIncomingMessage({
    id: 'e2e-quiescent-trigger',
    channelId,
    userId: 'user-0',
    userName: '小明',
    content: '差不多得出结论了吧？',
    timestamp: now,
  });

  // 等待微任务异步沉淀完成
  await new Promise((r) => setTimeout(r, 100));

  // 3. 验证轻量播报已产生
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].text.includes('《微服务与单体架构演进的边界》'));
  assert.ok(notifications[0].text.includes('patchouli.show'));

  // 4. 验证 llmwiki 落盘布局：wiki/debates/<id>.md + raw/sessions/<id>.json + index.md + log.md
  const entryDir = path.join(E2E_WIKI_DIR, 'wiki', 'debates');
  const rawDir = path.join(E2E_WIKI_DIR, 'raw', 'sessions');
  for (const dir of [entryDir, rawDir, path.join(E2E_WIKI_DIR, '.patchouli')]) {
    assert.ok((await fs.stat(dir)).isDirectory(), `缺失 llmwiki 骨架目录: ${dir}`);
  }

  const wikiFiles = await fs.readdir(entryDir);
  assert.ok(wikiFiles.length >= 1);
  const entryFilePath = path.join(entryDir, wikiFiles[0]);
  const entryId = path.basename(entryFilePath, '.md');
  const entryMd = await fs.readFile(entryFilePath, 'utf8');
  assert.ok(entryMd.includes('# 微服务与单体架构演进的边界'));
  assert.ok(entryMd.includes('过早拆分微服务是架构灾难'));
  assert.ok(entryMd.includes('> **小明**：先做单体并不丢人，把单体做成不可拆分的泥潭才丢人。'));
  assert.ok(entryMd.includes('## 背景'));
  assert.ok(entryMd.includes('## 原始言论 / 金句采撷'));
  assert.ok(entryMd.includes(`Source: raw/sessions/${entryId}.json`), 'Source 必须指向 raw/sessions 下的原始会话');

  // 真理源：原始会话 dump 必须包含本轮真实消息（平息心跳触发消息不计入会话）
  const rawFiles = await fs.readdir(rawDir);
  assert.deepEqual(rawFiles, [`${entryId}.json`], 'raw/sessions 下必须恰好一份同名会话 dump');
  const rawDump = JSON.parse(await fs.readFile(path.join(rawDir, `${entryId}.json`), 'utf8'));
  assert.equal(rawDump.version, 1);
  assert.equal(rawDump.id, entryId);
  assert.equal(rawDump.channelId, channelId);
  assert.equal(rawDump.messageCount, 10);
  assert.ok(rawDump.messages.some((m) => m.content.includes('关于架构拆分的激烈争论观点 10')));
  assert.ok(rawDump.messages.every((m) => !('raw' in m)), '原始 dump 不得写入 Koishi 事件对象');

  // 5. 验证 index.md 与 log.md
  const indexMd = await fs.readFile(path.join(E2E_WIKI_DIR, 'index.md'), 'utf8');
  assert.ok(indexMd.includes('[[微服务与单体架构演进的边界]]'));

  const logMd = await fs.readFile(path.join(E2E_WIKI_DIR, 'log.md'), 'utf8');
  assert.ok(logMd.includes('沉淀条目 [[微服务与单体架构演进的边界]]'));

  // 6. 验证 LocalStore 检索
  const searchResults = await system.localStore.searchEntries('微服务', channelId);
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].title, '微服务与单体架构演进的边界');

  // 7. 验证宿主非对称 AIMD 控制器（调度器返回 qualityScore: 0.9 >= 0.8 高质量讨论，触发放宽）
  const currentOptions = system.detector.getOptions(channelId);
  assert.equal(currentOptions.burstMultiplier, 2.0, '触发倍率保持配置基准');
  assert.equal(currentOptions.quiescenceSeconds, 60, '动态平息期在检测器内动态生效，不改写基础配置');
  assert.equal(currentOptions.minBurstRate, 4.85, '高质量讨论使最低突发速率加性放宽 0.15 (5 -> 4.85)');
  assert.equal(currentOptions.minDiscussionMessages, 6, '最低消息数放宽 0.5 并被硬下界 6 夹紧 (5 - 0.5 = 4.5 -> 6)');
  assert.equal(currentOptions.thetaMin, 20, 'rate 模式下 AIMD 不得移动势能门限 Θ_min');

  // 验证快照持久化
  const savedSnapshots = await system.localStore.listCadenceStates();
  const snap = savedSnapshots.find((s) => s.channelId === channelId);
  assert.ok(snap);
  assert.equal(snap.options.minBurstRate, 4.85);
  assert.equal(snap.options.minDiscussionMessages, 6);
  assert.equal(snap.options.thetaMin, 20);
  assert.equal(snap.options.burstMultiplier, 2.0);
  assert.equal(snap.options.quiescenceSeconds, 60);

  // `tuning` 只读视图必须同时暴露 Θ_min 与它的硬限幅区间
  const tuningView = system.getTuningSnapshot(channelId);
  assert.equal(tuningView.parameters.thetaMin, 20);
  assert.deepEqual(tuningView.limits.thetaMin, [10, 60]);
  system.dispose();
  await fs.rm(E2E_WIKI_DIR, { recursive: true, force: true });
});

test('TRAFFIC-01: 5 秒墙钟桶统计被接受消息数、静默真实 0、60 点上限 (getTraffic)', async (t) => {
  const trafficDir = path.resolve('tmp/e2e-traffic');
  await fs.rm(trafficDir, { recursive: true, force: true });
  await fs.mkdir(trafficDir, { recursive: true });

  assert.equal(TRAFFIC_SAMPLE_MS, 5000, '采样节拍必须为 5 秒');
  assert.equal(TRAFFIC_CAPACITY, 60, '窗口必须为 60 点 (5 分钟)');

  // 固定服务器墙钟到 5 秒整刻度，消除测试抖动并让桶边界可精确断言
  const BASE = 1_700_000_000_000;
  assert.equal(BASE % TRAFFIC_SAMPLE_MS, 0, '基准时刻必须落在 5 秒边界上');
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(BASE);

  const system = new PatchouliKnowledgeSystem(
    {
      enabled: true,
      channels: ['traffic-channel', 'quiet-channel'],
      notifyOnSummarized: false,
      trigger: { triggerMode: 'rate', windowSizeSeconds: 60, burstMultiplier: 2, minBurstRate: 5, quiescenceSeconds: 3600 },
      dispatcher: { provider: 'custom', apiKey: 'mock-key', baseURL: 'https://mock.api/v1', customModel: 'gpt-4o-mini' },
      storage: { wikiDir: trafficDir },
    },
    { info: () => {}, warn: () => {}, error: () => {} },
    undefined,
    {
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      }),
    },
  );

  const channelId = 'traffic-channel';
  const quietChannel = 'quiet-channel';
  const send = (id) =>
    system.onIncomingMessage({
      id,
      channelId,
      userId: 'u1',
      userName: '甲',
      content: '流量采样链路自检',
      timestamp: Date.now(),
    });

  // 1. 启动瞬间：尚无任何闭合桶
  assert.deepEqual(system.getTraffic(channelId), [], '尚无闭合桶时不得产出数据点');
  assert.deepEqual(system.getTraffic('untracked-channel'), [], '未跟踪群聊不得伪造历史');

  // 2. 同一桶内两条真实消息
  await send('traffic-msg-1');
  await send('traffic-msg-2');

  // 3. 推进一个节拍：桶 BASE 闭合
  t.mock.timers.tick(TRAFFIC_SAMPLE_MS);
  assert.deepEqual(
    system.getTraffic(channelId),
    [{ timestamp: BASE, count: 2 }],
    '闭合桶必须精确统计 onIncomingMessage 接受的消息数',
  );
  assert.deepEqual(
    system.getTraffic(quietChannel),
    [{ timestamp: BASE, count: 0 }],
    '白名单静默群必须是真实 0，而不是缺失或永久等待',
  );

  // 4. 下一桶再来一条消息：桶边界固定、无漂移
  await send('traffic-msg-3');
  t.mock.timers.tick(TRAFFIC_SAMPLE_MS);
  assert.deepEqual(system.getTraffic(channelId), [
    { timestamp: BASE, count: 2 },
    { timestamp: BASE + TRAFFIC_SAMPLE_MS, count: 1 },
  ]);

  // 5. 静默 3 个节拍：补真实 0，且节拍严格等距、对齐 5 秒刻度
  t.mock.timers.tick(3 * TRAFFIC_SAMPLE_MS);
  const filled = system.getTraffic(channelId);
  assert.equal(filled.length, 5, '已监测周期必须逐桶补真实 0');
  assert.deepEqual(filled.slice(2), [
    { timestamp: BASE + 2 * TRAFFIC_SAMPLE_MS, count: 0 },
    { timestamp: BASE + 3 * TRAFFIC_SAMPLE_MS, count: 0 },
    { timestamp: BASE + 4 * TRAFFIC_SAMPLE_MS, count: 0 },
  ]);
  assert.ok(
    filled.every((point, index) => index === 0 || point.timestamp - filled[index - 1].timestamp === TRAFFIC_SAMPLE_MS),
    '相邻桶必须严格相差一个采样节拍（无漂移）',
  );
  assert.ok(filled.every((point) => point.timestamp % TRAFFIC_SAMPLE_MS === 0), '桶边界必须对齐服务器墙钟 5 秒刻度');
  assert.ok(filled.every((point) => Number.isInteger(point.count) && point.count >= 0), '计数必须为非负整数');

  // 6. 滚动窗口上限 60 点，且无重复桶
  t.mock.timers.tick((TRAFFIC_CAPACITY + 14) * TRAFFIC_SAMPLE_MS);
  const windowed = system.getTraffic(channelId);
  assert.equal(windowed.length, TRAFFIC_CAPACITY, '窗口上限必须为 60 点');
  assert.equal(new Set(windowed.map((point) => point.timestamp)).size, windowed.length, '不得出现重复桶');
  const nowBucket = Math.floor(Date.now() / TRAFFIC_SAMPLE_MS) * TRAFFIC_SAMPLE_MS;
  assert.equal(windowed[windowed.length - 1].timestamp, nowBucket - TRAFFIC_SAMPLE_MS, '最后一点必须是最近一个闭合桶');
  assert.equal(windowed[0].timestamp, nowBucket - TRAFFIC_CAPACITY * TRAFFIC_SAMPLE_MS, '窗口必须恰好覆盖 5 分钟');

  // 7. limit 截取最近 N 点，越界收敛
  assert.deepEqual(system.getTraffic(channelId, 5), windowed.slice(-5), 'limit 必须截取最近 N 点');
  assert.deepEqual(system.getTraffic(channelId, 0), windowed.slice(-1), 'limit 下限收敛为 1 点');
  assert.deepEqual(system.getTraffic(channelId, 9999), windowed, 'limit 上限收敛为 60 点');

  // 8. 返回副本，外部修改不得污染内部缓冲
  windowed[0].count = -999;
  assert.notEqual(system.getTraffic(channelId)[0].count, -999, 'getTraffic 必须返回副本');

  // 9. 读取是纯函数：不推进 detector 状态机、不为其建态
  const trackedBefore = system.detector.channelIds().sort();
  for (let i = 0; i < 3; i += 1) system.getTraffic(channelId);
  assert.deepEqual(system.detector.channelIds().sort(), trackedBefore, '读取流量不得改变 detector 的跟踪集合');
  assert.equal(system.detector.hasChannel('untracked-channel'), false, '读取未跟踪群不得在 detector 中建立状态');

  // 10. 白名单外的群聊连流量都不统计
  await system.onIncomingMessage({
    id: 'traffic-msg-outside',
    channelId: 'not-whitelisted',
    userId: 'u9',
    userName: '乙',
    content: '白名单外消息',
    timestamp: Date.now(),
  });
  t.mock.timers.tick(TRAFFIC_SAMPLE_MS);
  assert.deepEqual(system.getTraffic('not-whitelisted'), [], '白名单外群聊不得进入流量统计');

  // 11. dispose 清空缓冲
  system.dispose();
  assert.deepEqual(system.getTraffic(channelId), [], 'dispose 后必须清空流量缓冲');
  t.mock.timers.reset();

  await fs.rm(trafficDir, { recursive: true, force: true });
});

test('TRAFFIC-02: 未监测周期为缺失，首条消息才开启监测（无白名单）', async (t) => {
  const openDir = path.resolve('tmp/e2e-traffic-open');
  await fs.rm(openDir, { recursive: true, force: true });
  await fs.mkdir(openDir, { recursive: true });

  const BASE = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(BASE);

  const system = new PatchouliKnowledgeSystem(
    {
      enabled: true,
      channels: [],
      notifyOnSummarized: false,
      trigger: { triggerMode: 'rate', windowSizeSeconds: 60, burstMultiplier: 2, minBurstRate: 5, quiescenceSeconds: 3600 },
      dispatcher: { provider: 'custom', apiKey: 'mock-key', baseURL: 'https://mock.api/v1', customModel: 'gpt-4o-mini' },
      storage: { wikiDir: openDir },
    },
    { info: () => {}, warn: () => {}, error: () => {} },
    undefined,
    {
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      }),
    },
  );

  const channelId = 'free-group';

  // 未监测：缺失而非伪造的 0 历史
  assert.deepEqual(system.getTraffic(channelId), [], '未监测群聊必须缺失，不得伪造历史零值');
  assert.equal(system.detector.hasChannel(channelId), false, '未监测群聊不得在 detector 中建态');

  // 半桶处来第一条消息：监测从该桶开始
  t.mock.timers.setTime(BASE + 2000);
  await system.onIncomingMessage({
    id: 'free-msg-1',
    channelId,
    userId: 'u1',
    userName: '甲',
    content: '自由群首条消息',
    timestamp: BASE + 2000,
  });

  assert.deepEqual(system.getTraffic(channelId), [], '桶尚未闭合时不得产出数据点');

  t.mock.timers.tick(3000); // now = BASE + 5000 → 桶 BASE 闭合
  const traffic = system.getTraffic(channelId);
  assert.deepEqual(traffic, [{ timestamp: BASE, count: 1 }], '只产出被监测的闭合桶，且计数真实');
  assert.ok(traffic.every((point) => point.timestamp >= BASE), '监测开启前的周期不得被回溯伪造');

  // 读取两次不得推进状态机
  assert.deepEqual(system.getTraffic(channelId), traffic, '重复读取必须稳定幂等');

  system.dispose();
  t.mock.timers.reset();

  await fs.rm(openDir, { recursive: true, force: true });
});

test('TRAFFIC-03: 启动半桶边界 — 无消息不伪造 0，有消息保留真实计数', async (t) => {
  const partialDir = path.resolve('tmp/e2e-traffic-partial');
  await fs.rm(partialDir, { recursive: true, force: true });
  await fs.mkdir(partialDir, { recursive: true });

  const BASE = 1_700_000_000_000; // 5 秒整刻度
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(BASE + 2000); // 启动于半桶：整桶起点应推迟到 BASE + 5000

  const system = new PatchouliKnowledgeSystem(
    {
      enabled: true,
      channels: ['active-group', 'silent-group'],
      notifyOnSummarized: false,
      trigger: { triggerMode: 'rate', windowSizeSeconds: 60, burstMultiplier: 2, minBurstRate: 5, quiescenceSeconds: 3600 },
      dispatcher: { provider: 'custom', apiKey: 'mock-key', baseURL: 'https://mock.api/v1', customModel: 'gpt-4o-mini' },
      storage: { wikiDir: partialDir },
    },
    { info: () => {}, warn: () => {}, error: () => {} },
    undefined,
    {
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      }),
    },
  );

  assert.deepEqual(system.getTraffic('silent-group'), [], '启动半桶尚未闭合，不得产出数据点');

  // 半桶内真实到达一条消息
  await system.onIncomingMessage({
    id: 'partial-msg-1',
    channelId: 'active-group',
    userId: 'u1',
    userName: '甲',
    content: '启动半桶内的首条消息',
    timestamp: Date.now(),
  });

  // 半桶 BASE 闭合
  t.mock.timers.tick(3000); // now = BASE + 5000
  assert.deepEqual(
    system.getTraffic('active-group'),
    [{ timestamp: BASE, count: 1 }],
    '半桶内到达的消息必须保留真实计数，不得被排除',
  );
  assert.deepEqual(
    system.getTraffic('silent-group'),
    [],
    '静默群的半截启动桶不得被伪造成 0',
  );

  // 下一个整刻度闭合：静默群从整桶起算，不回溯补齐半桶
  t.mock.timers.tick(TRAFFIC_SAMPLE_MS); // now = BASE + 10000
  const silentTraffic = system.getTraffic('silent-group');
  assert.deepEqual(silentTraffic, [{ timestamp: BASE + TRAFFIC_SAMPLE_MS, count: 0 }], '静默群首个采样点应为整桶真实 0');
  assert.ok(silentTraffic.every((point) => point.timestamp !== BASE), '不得伪造启动半桶的零值');
  assert.deepEqual(system.getTraffic('active-group'), [
    { timestamp: BASE, count: 1 },
    { timestamp: BASE + TRAFFIC_SAMPLE_MS, count: 0 },
  ]);

  system.dispose();
  t.mock.timers.reset();

  await fs.rm(partialDir, { recursive: true, force: true });
});

