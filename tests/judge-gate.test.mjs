/**
 * 本地 System-1 裁判装配回归测试（roadmap §4.4 / §7.3 / §7.5.10）。
 *
 * 锁死契约：
 *  - `PreDispatchGate`：高概率放行、低概率 → `MODEL` / `LOW_DENSITY` 舍弃且不调云端大模型；
 *    `available: false` 一律 fail-open（服务故障绝不翻译成丢弃）；
 *  - `BoundaryAnnotator`：同群 10 分钟冷却 + 单在途请求；带编号的 tail 与 1 起候选编号
 *    （语义为「该编号消息即新话题首条」，切在它之前）正确映射回绝对时间戳；
 *  - 两条路径的任何异常都不冒泡到 `onMessage` / `onIncomingMessage`。
 *
 * 全部使用注入的假 `JudgeClient`（零真实网络）；插件级用例把 `globalThis.fetch`
 * 临时替换为裁判桩，并在 `finally` 中还原。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { JudgeClient } from '../lib/judge/client.js';
import {
  BoundaryAnnotator,
  DEFAULT_BOUNDARY_COOLDOWN_MS,
  LOW_DENSITY_REASON,
  PreDispatchGate,
} from '../lib/judge/gate.js';
import { PatchouliKnowledgeSystem } from '../lib/index.js';

const BASE_TIME = 1_700_000_000_000;
const TMP_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../tmp',
);

function tempDir(label) {
  return path.join(TMP_ROOT, `judge-gate-${label}-${process.pid}`);
}

/** Windows 上插件后台写盘可能与清理并发：rm 自带重试，不让收尾噪音掩盖用例结论。 */
async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 裁判桩：记录每次请求体，由 `handler` 决定响应。 */
function judgeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return handler(url, init, calls.length);
  };
  return { impl, calls };
}

async function withGlobalFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------------------ *
 * 插件级夹具（触发器 + 调度器）
 * ------------------------------------------------------------------ */

function makeMessage(overrides = {}) {
  return {
    id: 'msg',
    channelId: 'group-judge',
    userId: 'u1',
    userName: '群友1',
    content: '讨论内容各不相同',
    timestamp: BASE_TIME,
    ...overrides,
  };
}

/** 多发言人 + 内容互异：满足突发判定的物理门限。 */
function debateMessage(channelId, index, timestamp) {
  return makeMessage({
    id: `${channelId}-${index}`,
    channelId,
    userId: `user-${index % 4}`,
    userName: `辩友${index % 4}`,
    content: `论点交锋 #${index}：我认为这个取舍取决于写入仲裁成本与副本一致性`,
    timestamp,
  });
}

const MODEL_BODY = {
  shouldDiscard: false,
  title: '分片复制与仲裁写入的取舍',
  summary: '群友讨论了副本一致性与写入仲裁成本之间的边界。',
  background: '讨论源于一次存储选型的争论。',
  status: 'verified',
  tags: ['分布式', '一致性'],
  debateMatrix: [
    {
      viewpoint: '强一致优先',
      proponents: ['辩友0'],
      arguments: ['仲裁写入把冲突前移到写入路径，读路径更简单'],
      counterArguments: ['跨区仲裁的尾延迟难以接受'],
    },
  ],
  consensus: ['一致性级别应随业务读写比例分级配置'],
  openQuestions: ['如何量化仲裁写入的尾延迟代价？'],
  keyQuotes: [{ author: '辩友0', quote: '一致性不是开关，是预算。' }],
  qualityScore: 0.9,
  discardReason: null,
};

function makePluginConfig(wikiDir, channels, judge) {
  return {
    enabled: true,
    channels,
    notifyOnSummarized: false,
    trigger: {
      triggerMode: 'rate',
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 12,
      maxBufferMessages: 500,
      baselineEwmaAlpha: 0.05,
    },
    dispatcher: {
      provider: 'custom',
      apiKey: 'mock-key',
      baseURL: 'https://mock.api/v1',
      customModel: 'gpt-4o-mini',
      enableAutoTuning: true,
    },
    storage: { wikiDir },
    observability: { discardDumps: true },
    judge,
  };
}

function makePluginSystem(wikiDir, channels, judge) {
  const logs = [];
  const logger = {
    debug: (m) => logs.push(`DEBUG: ${m}`),
    info: (m) => logs.push(`INFO: ${m}`),
    warn: (m) => logs.push(`WARN: ${m}`),
    error: (m) => logs.push(`ERROR: ${m}`),
  };
  let dispatchCount = 0;
  const mockFetch = async () => {
    dispatchCount += 1;
    const body = JSON.stringify(MODEL_BODY);
    const payload = {
      id: 'resp_judge_gate',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 900 },
    };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  const system = new PatchouliKnowledgeSystem(
    makePluginConfig(wikiDir, channels, judge),
    logger,
    undefined,
    { fetch: mockFetch },
  );
  return { system, logs, dispatchCount: () => dispatchCount };
}

async function feedBurst(system, channelId, count, stepMs, startAt) {
  let timestamp = startAt;
  for (let i = 1; i <= count; i++) {
    timestamp += stepMs;
    await system.onIncomingMessage(debateMessage(channelId, i, timestamp));
  }
  return timestamp;
}

/** 触发一次完整平息结算（session.partial === false）。 */
async function settleSession(system, channelId, endAt) {
  await system.onIncomingMessage(debateMessage(channelId, 99, endAt + 400_000));
}

async function readDiscardVerdicts(wikiDir) {
  const dir = path.join(wikiDir, '.patchouli', 'discards');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const verdicts = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    verdicts.push(JSON.parse(text).verdict);
  }
  return verdicts;
}

/* ------------------------------------------------------------------ *
 * GATE-01：门控判决与低密度舍弃
 * ------------------------------------------------------------------ */

test('GATE-01: 高概率放行、低概率舍弃（MODEL/LOW_DENSITY）、不可用 fail-open', async () => {
  const session = {
    sessionId: 's1',
    channelId: 'c1',
    startTime: BASE_TIME,
    endTime: BASE_TIME,
    peakRate: 12,
    triggerReason: 'test',
    partial: false,
    messages: Array.from({ length: 12 }, (_, i) =>
      makeMessage({ id: `m${i}`, userId: `u${i % 3}`, userName: `群友${i % 3}`, content: `第 ${i} 条讨论内容`, timestamp: BASE_TIME + i * 1000 }),
    ),
  };

  const high = new PreDispatchGate({ gate: async () => ({ probability: 0.9, available: true }) });
  const highVerdict = await high.evaluate(session);
  assert.deepEqual(highVerdict, { valuable: true, probability: 0.9, available: true });

  const low = new PreDispatchGate({ gate: async () => ({ probability: 0.2, available: true }) });
  const lowVerdict = await low.evaluate(session);
  assert.equal(lowVerdict.valuable, false);
  assert.equal(lowVerdict.available, true);
  assert.equal(lowVerdict.probability, 0.2);
  assert.equal(lowVerdict.reason, LOW_DENSITY_REASON);

  const down = new PreDispatchGate({
    gate: async () => ({ probability: 1, available: false, reason: 'judge HTTP 500' }),
  });
  const downVerdict = await down.evaluate(session);
  assert.equal(downVerdict.valuable, true, '服务故障必须 fail-open');
  assert.equal(downVerdict.available, false);
  assert.equal(downVerdict.reason, 'judge HTTP 500');

  // 阈值可注入：0.95 时 0.9 判低密度。
  const strict = new PreDispatchGate({ gate: async () => ({ probability: 0.9, available: true }) }, {
    threshold: 0.95,
  });
  assert.equal((await strict.evaluate(session)).valuable, false);
});

test('GATE-01-PLUGIN: 低概率时跳过云端调度并落 MODEL/LOW_DENSITY 留证', async () => {
  const wikiDir = tempDir('low-density');
  const channelId = 'group-gate-low';
  await removeDir(wikiDir);

  const { impl, calls } = judgeFetch(() => jsonResponse({ answers: { valuable: { type: 'noul', noul: 0.1 } } }));

  await withGlobalFetch(impl, async () => {
    const { system, logs, dispatchCount } = makePluginSystem(wikiDir, [channelId], { enabled: true });
    try {
      const end = await feedBurst(system, channelId, 14, 1000, BASE_TIME);
      await settleSession(system, channelId, end);
      await waitFor(
        () => logs.some((line) => line.includes('本地门控判定低密度')),
        '门控低密度日志',
      );
      await waitFor(async () => (await readDiscardVerdicts(wikiDir)).length > 0, '低密度丢弃留证');

      assert.equal(dispatchCount(), 0, '低密度不得调用云端大模型');
      const gateCall = calls.find((call) => call.body.questions?.valuable !== undefined);
      assert.ok(gateCall, '必须发生一次门控请求');
      assert.equal(gateCall.body.questions.valuable.type, 'noul');
      assert.ok(gateCall.body.state.includes('辩友0:'), `门控 state 应为「昵称: 文本」：${gateCall.body.state}`);

      const log = logs.find((line) => line.includes('本地门控判定低密度'));
      assert.match(log, /P=0\.100/);
      assert.match(log, /LOW_DENSITY/);

      const verdicts = await readDiscardVerdicts(wikiDir);
      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0].kind, 'MODEL');
      assert.equal(verdicts[0].discardReason, 'LOW_DENSITY');
      assert.equal(verdicts[0].qualityScore, 0.1);

      // 门控判丢弃同样进入 AIMD 闭环：门限朝收紧方向步进并落盘。
      await waitFor(
        async () => Boolean(await system.localStore.loadCadenceState(channelId)),
        '低密度舍弃后的 AIMD 快照',
      );
    } finally {
      system.dispose();
    }
  });

  await removeDir(wikiDir);
});

test('GATE-01-PLUGIN: 高概率与不可用都必须照常调度云端大模型', async () => {
  const highDir = tempDir('high-density');
  const downDir = tempDir('judge-down');
  await removeDir(highDir);
  await removeDir(downDir);

  const highFetch = judgeFetch(() => jsonResponse({ answers: { valuable: { type: 'noul', noul: 0.9 } } }));
  await withGlobalFetch(highFetch.impl, async () => {
    const { system, dispatchCount } = makePluginSystem(highDir, ['group-gate-high'], { enabled: true });
    try {
      const end = await feedBurst(system, 'group-gate-high', 14, 1000, BASE_TIME);
      await settleSession(system, 'group-gate-high', end);
      await waitFor(() => dispatchCount() >= 1, '高概率放行后调度大模型');
      assert.equal(highFetch.calls.length, 1);
    } finally {
      system.dispose();
    }
  });

  const downFetch = judgeFetch(() => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5070');
  });
  await withGlobalFetch(downFetch.impl, async () => {
    const { system, logs, dispatchCount } = makePluginSystem(downDir, ['group-judge-down'], { enabled: true });
    try {
      const end = await feedBurst(system, 'group-judge-down', 14, 1000, BASE_TIME);
      await settleSession(system, 'group-judge-down', end);
      await waitFor(() => dispatchCount() >= 1, '裁判不可用时 fail-open 调度');
      assert.ok(
        logs.some((line) => line.includes('本地门控不可用')),
        '不可用必须留一条调试告警',
      );
      assert.deepEqual(await readDiscardVerdicts(downDir), [], '服务故障不得产生 MODEL 丢弃留证');
    } finally {
      system.dispose();
    }
  });

  await removeDir(highDir);
  await removeDir(downDir);
});

/* ------------------------------------------------------------------ *
 * GATE-02：opt-in 关闭时零裁判调用
 * ------------------------------------------------------------------ */

test('GATE-02: judge.enabled === false 时不发起任何裁判请求（门控直通）', async () => {
  const wikiDir = tempDir('disabled');
  const channelId = 'group-judge-off';
  await removeDir(wikiDir);

  const { impl, calls } = judgeFetch(() => {
    throw new Error('裁判关闭时不应有请求');
  });

  await withGlobalFetch(impl, async () => {
    const { system, dispatchCount, logs } = makePluginSystem(wikiDir, [channelId], { enabled: false });
    try {
      // 直接 spy 两个装配点：任何一次调用都算失败，而不只是「没发出 HTTP」。
      let gateCalls = 0;
      let boundaryCalls = 0;
      system.gate.client.gate = async () => {
        gateCalls += 1;
        return { probability: 0.1, available: true };
      };
      system.judgeClient.boundary = async () => {
        boundaryCalls += 1;
        return { index: null, probabilities: {}, available: true };
      };

      const end = await feedBurst(system, channelId, 14, 1000, BASE_TIME);
      await settleSession(system, channelId, end);
      await waitFor(() => dispatchCount() >= 1, '关闭时照常调度');
      assert.equal(gateCalls, 0, 'judge.enabled === false 时不得调用门控');
      assert.equal(boundaryCalls, 0, 'judge.enabled === false 时不得触发边界裁决');
      assert.equal(calls.length, 0, 'judge.enabled === false 时裁判调用次数必须为 0');
      assert.ok(!logs.some((line) => line.includes('本地门控判定低密度')));
    } finally {
      system.dispose();
    }
  });

  await removeDir(wikiDir);
});

/* ------------------------------------------------------------------ *
 * GATE-03：冷却期与单在途请求
 * ------------------------------------------------------------------ */

const TOPIC_A_STEM =
  '落地窗采光方案讨论纱帘和蜂巢帘的取舍还有玻璃面积对室温的影响阳台打通之后的进深光线均匀性';
const TOPIC_A_TAILS = [
  '白天直射还是偏刺眼',
  '西晒隔热膜是刚需',
  '进深采光反而均匀',
  '超白玻透光率明显',
  '遮光隔热都顾到了',
  '断桥铝顺带隔音',
  '绿植沿窗摆一圈',
  '深色地板吃掉进光',
  '白天不用开主灯',
  '空调负荷跟着上升',
];
const TOPIC_B_STEM =
  'kubernetes cluster cni network plugin setup for pod networking stack and overlay configuration';
const TOPIC_B_TAILS = [
  'calico vxlan latency',
  'cilium ebpf proxy',
  'cni kubelet sandbox',
  'networkpolicy dns rules',
  'bgp peering misconfig',
  'weave sleeve throughput',
  'pod cidr conflict',
  'mtu fragmentation tuning',
  'ipvs conntrack table',
  'egress gateway latency',
];

function topicMessage(index, topic) {
  if (topic === 'A') return `${TOPIC_A_STEM}${TOPIC_A_TAILS[index % TOPIC_A_TAILS.length]}`;
  return `${TOPIC_B_STEM} ${TOPIC_B_TAILS[index % TOPIC_B_TAILS.length]}`;
}

/** 相对消息序号 → 观测输入；绝对时间戳 = BASE_TIME + index 秒。 */
function observation(channelId, index, topic) {
  return {
    channelId,
    id: `${channelId}-${index}`,
    userId: `user-${index % 4}`,
    userName: `群友${index % 4}`,
    text: topicMessage(index, topic),
    at: BASE_TIME + index * 1000,
  };
}

/** 20 条 A + 20 条 B：L0 在消息 10 与 20 处各报一个候选。 */
function twoCandidateSequence(channelId) {
  const sequence = [];
  for (let i = 0; i < 40; i += 1) {
    sequence.push(observation(channelId, i, i < 10 || (i >= 20 && i < 30) ? 'A' : 'B'));
  }
  return sequence;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('GATE-03: 冷却期内不重复裁决，在途期间不并发', async () => {
  const channelId = 'group-cooldown';
  const dropped = [];
  const boundaries = [];
  const pending = [];
  const first = deferred();
  let attempts = 0;

  const client = new JudgeClient(
    { enabled: true, baseURL: 'http://127.0.0.1:5999' },
    {
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) return first.promise;
        return jsonResponse({
          answers: { boundary: { type: 'choice', choice: '11', probabilities: { '11': 0.8 } } },
        });
      },
    },
  );
  const annotator = new BoundaryAnnotator(client, {
    noteBoundary: (channel, at, confidence) => boundaries.push({ channel, at, confidence }),
    logger: { info: (message) => dropped.push(message) },
  });

  for (const input of twoCandidateSequence(channelId)) {
    pending.push(annotator.observe(input));
  }
  // 让已同步进入的裁决请求完成一次握手：此时第二个候选（消息 20）必然撞上在途标记。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1, '在途期间第二个候选不得发起第二次裁决');
  assert.ok(
    dropped.some((line) => line.includes('仍在途')),
    `在途丢弃必须计数留痕：${dropped.join(' | ')}`,
  );

  first.resolve(
    jsonResponse({ answers: { boundary: { type: 'choice', choice: '11', probabilities: { '11': 0.8 } } } }),
  );
  await Promise.all(pending);
  assert.deepEqual(boundaries, [{ channel: channelId, at: BASE_TIME + 10_000, confidence: 0.8 }]);

  // 冷却期：继续 20 条（消息 40..59）→ 候选落在消息 45，距上次裁决仅 26s。
  const afterCooldownWindow = [];
  for (let i = 40; i < 60; i += 1) {
    afterCooldownWindow.push(annotator.observe(observation(channelId, i, i < 50 ? 'A' : 'B')));
  }
  await Promise.all(afterCooldownWindow);
  assert.equal(attempts, 1, '冷却期内不得再次裁决');
  assert.ok(
    dropped.some((line) => line.includes('冷却期内')),
    `冷却丢弃必须计数留痕：${dropped.join(' | ')}`,
  );
  assert.equal(boundaries.length, 1);
  assert.equal(DEFAULT_BOUNDARY_COOLDOWN_MS, 600_000);

  // reset 后状态归零：同一序列可以重新裁决（cooldown 也随之清空）。
  annotator.reset();
  const replay = twoCandidateSequence(channelId);
  const replayed = [];
  for (const input of replay) replayed.push(annotator.observe(input));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, 'reset 后应重新发起裁决');
  await Promise.all(replayed);
});

/* ------------------------------------------------------------------ *
 * GATE-04：相对下标 → 绝对时间戳映射
 * ------------------------------------------------------------------ */

test('GATE-04: 候选编号 4（1 起）映射回 tail 内第 4 条消息的绝对时间戳', async () => {
  const channelId = 'group-mapping';
  const boundaries = [];
  const { impl, calls } = judgeFetch(() =>
    jsonResponse({
      answers: { boundary: { type: 'choice', choice: '4', probabilities: { '4': 0.77, none: 0.23 } } },
    }),
  );
  const client = new JudgeClient({ enabled: true, baseURL: 'http://127.0.0.1:5999' }, { fetch: impl });
  const annotator = new BoundaryAnnotator(client, {
    // tail 收到 13 条时，L0 候选（消息 10）正好落在相对下标 3。
    tailSize: 13,
    noteBoundary: (channel, at, confidence) => boundaries.push({ channel, at, confidence }),
  });

  const pending = [];
  for (let i = 0; i < 20; i += 1) pending.push(annotator.observe(observation(channelId, i, i < 10 ? 'A' : 'B')));
  await Promise.all(pending);

  assert.equal(calls.length, 1);
  const [call] = calls;
  const question = call.body.questions.boundary;
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria).sort(), ['4', 'none']);
  assert.equal(question.criteria['4'], '在编号 4 的消息之前发生话题切换');
  assert.match(question.instructions, /序号从 1 开始/);
  assert.equal(call.body.state.split('\n').length, 13, 'tail 必须恰好 13 条');
  assert.match(call.body.state.split('\n')[0], /^1\. 群友\d: /u, 'tail 每行必须带 1 起编号');

  assert.equal(boundaries.length, 1);
  // 绝对下标 10 ↔ 相对下标 3 ↔ 编号 4；旁证：tail 快照第 4 行就是这条消息。
  assert.equal(boundaries[0].at, BASE_TIME + 10_000);
  assert.equal(boundaries[0].confidence, 0.77);
  assert.equal(boundaries[0].channel, channelId);
  assert.equal(call.body.state.split('\n')[3], `4. 群友2: ${topicMessage(10, 'B')}`);
});

test('GATE-04: 概率缺失时置信度回落 0.6', async () => {
  const channelId = 'group-mapping-default';
  const boundaries = [];
  const { impl } = judgeFetch(() =>
    jsonResponse({ answers: { boundary: { type: 'choice', choice: '4', probabilities: {} } } }),
  );
  const client = new JudgeClient({ enabled: true, baseURL: 'http://127.0.0.1:5999' }, { fetch: impl });
  const annotator = new BoundaryAnnotator(client, {
    tailSize: 13,
    noteBoundary: (channel, at, confidence) => boundaries.push({ at, confidence }),
  });

  const pending = [];
  for (let i = 0; i < 20; i += 1) pending.push(annotator.observe(observation(channelId, i, i < 10 ? 'A' : 'B')));
  await Promise.all(pending);

  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].confidence, 0.6);
});

/* ------------------------------------------------------------------ *
 * GATE-05：异常永不冒泡
 * ------------------------------------------------------------------ */

test('GATE-05: 裁判抛错不冒泡到 onIncomingMessage / onMessage', async () => {
  const session = {
    sessionId: 's-throw',
    channelId: 'c-throw',
    startTime: BASE_TIME,
    endTime: BASE_TIME,
    peakRate: 12,
    triggerReason: 'test',
    partial: false,
    messages: [makeMessage({ content: '这一轮只有一条消息' })],
  };
  const throwingClient = {
    gate: async () => {
      throw new Error('judge boom');
    },
    boundary: async () => {
      throw new Error('judge boom');
    },
  };

  const verdict = await new PreDispatchGate(throwingClient).evaluate(session);
  assert.equal(verdict.valuable, true, '调用异常必须 fail-open');
  assert.equal(verdict.available, false);
  assert.match(verdict.reason, /judge boom/);

  const boundaries = [];
  const annotator = new BoundaryAnnotator(throwingClient, {
    noteBoundary: (channel, at, confidence) => boundaries.push(at),
  });
  const pending = [];
  for (let i = 0; i < 20; i += 1) pending.push(annotator.observe(observation('group-throw', i, i < 10 ? 'A' : 'B')));
  await assert.doesNotReject(() => Promise.all(pending));
  assert.deepEqual(boundaries, []);

  // 插件级：把在途裁判方法替换成抛错版本，onIncomingMessage / 状态机照常推进。
  const wikiDir = tempDir('throwing');
  await removeDir(wikiDir);
  const { impl, calls } = judgeFetch(() => jsonResponse({ answers: {} }));
  await withGlobalFetch(impl, async () => {
    const { system, dispatchCount } = makePluginSystem(wikiDir, ['group-judge-throw'], { enabled: true });
    try {
      system.judgeClient.boundary = async () => {
        throw new Error('boundary boom');
      };
      system.gate.client.gate = async () => {
        throw new Error('gate boom');
      };

      let timestamp = BASE_TIME;
      for (let i = 1; i <= 14; i += 1) {
        timestamp += 1000;
        await assert.doesNotReject(() =>
          system.onIncomingMessage(
            makeMessage({
              id: `throw-${i}`,
              channelId: 'group-judge-throw',
              userId: `user-${i % 4}`,
              userName: `辩友${i % 4}`,
              content: `抛错回归 #${i}：写入仲裁成本与副本一致性的取舍`,
              timestamp,
            }),
          ),
        );
      }
      await assert.doesNotReject(() => settleSession(system, 'group-judge-throw', timestamp));

      await waitFor(() => dispatchCount() >= 1, '门控抛错后仍照常调度');
      assert.equal(calls.length, 0, '抛错路径不应产生真实网络请求');
    } finally {
      system.dispose();
    }
  });

  await removeDir(wikiDir);
});
