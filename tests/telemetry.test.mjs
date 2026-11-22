import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  BASELINE_LEDGER_WINDOW_MS,
  BaselineEstimator,
  BaselineLedger,
  BurstQuiescenceDetector,
  MOMENTUM_RSI_PERIOD,
  ModelDispatcher,
  MomentumTracker,
  PatchouliInspector,
  PatchouliKnowledgeSystem,
  RingBuffer,
  TELEMETRY_TRACE_CAPACITY,
  attachTelemetry,
  burstThreshold,
  createEmptyTelemetrySnapshot,
  potentialBurstThreshold,
  potentialCoolThreshold,
  registerWebUi,
} from '../lib/index.js';

function responsesPayload(text, tokens = 10) {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: tokens },
  };
}

const TELEMETRY_WIKI_DIR = path.resolve('tmp', 'telemetry-llmwiki');
const CHANNEL = 'telemetry-channel';
const BASE_TIME = 1_700_000_000_000;

function makeMessage(overrides = {}) {
  return {
    id: 'msg',
    channelId: CHANNEL,
    userId: 'u1',
    userName: '甲',
    content: '讨论内容足够长以通过物理层滤波',
    timestamp: BASE_TIME,
    ...overrides,
  };
}

const MODEL_RESPONSE = responsesPayload(
  JSON.stringify({
          shouldDiscard: false,
          title: '微服务与单体架构演进的边界',
          summary: '群友讨论了业务初期单体向微服务拆分的时机与隐形成本。',
          background: '讨论源于某中台重构引发的运维链路剧增问题。',
          status: 'verified',
          tags: ['微服务', '单体架构'],
          debateMatrix: [
            {
              viewpoint: '过早拆分微服务是架构灾难',
              proponents: ['甲'],
              arguments: ['网络分区与分布式事务大幅抬高开发调试成本'],
              counterArguments: ['单体在团队规模膨胀时合并冲突更难解'],
            },
          ],
          consensus: ['模块化单体是更优解'],
          openQuestions: ['如何低成本制定服务边界切分标准？'],
          keyQuotes: [{ author: '甲', quote: '先做单体并不丢人。' }],
          qualityScore: 0.9,
          discardReason: null,
  }),
  1200,
);

const mockFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => MODEL_RESPONSE,
  text: async () => JSON.stringify(MODEL_RESPONSE),
});

function silentLogger() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(`INFO: ${m}`),
    warn: (m) => lines.push(`WARN: ${m}`),
    error: (m) => lines.push(`ERROR: ${m}`),
  };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    channels: [CHANNEL],
    notifyOnSummarized: false,
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 60,
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
    storage: { wikiDir: TELEMETRY_WIKI_DIR },
    ...overrides,
  };
}

/** 关停台账并排空写队列：异步 append 若在 `rm` 之后落盘会把目录重建（ENOTEMPTY 竞态）。 */
async function stopLedger(system) {
  const ledger = system?.shadowLedger;
  if (ledger && typeof ledger.close === 'function') {
    ledger.close();
    if (typeof ledger.flush === 'function') await ledger.flush();
  }
}

function channelSnapshotOf(system, channelId = CHANNEL) {
  const snapshot = system.inspector.getTelemetrySnapshot();
  return { snapshot, channel: snapshot.channels.find((item) => item.channelId === channelId) };
}

/** 造一个只登记 get / post 的宿主路由替身（与既有 WebUI 测试同构）。 */
function createRouter() {
  const routes = new Map();
  const middlewares = [];
  return {
    routes,
    middlewares,
    // 管理面守卫挂在 `use` 上；缺了它插件会 fail closed 跳过全部 /api 路由，这里照实记录。
    use(prefix, middleware) {
      middlewares.push({ prefix, middleware });
    },
    get(pathname, handler) {
      routes.set(pathname, handler);
    },
    post(pathname, handler) {
      routes.set(pathname, handler);
    },
  };
}

function createKoaContext() {
  return {
    params: {},
    query: {},
    headers: {},
    request: {},
    status: 200,
    body: null,
    type: undefined,
    set() {},
  };
}

test('TELEMETRY-01: RingBuffer 定容 300、溢出 FIFO 覆盖、toArray 副本隔离', () => {
  const buffer = new RingBuffer();
  assert.equal(buffer.capacity, TELEMETRY_TRACE_CAPACITY);
  assert.equal(TELEMETRY_TRACE_CAPACITY, 300);
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.toArray(), []);

  for (let i = 0; i < 300; i += 1) {
    buffer.push(i);
  }
  assert.equal(buffer.size, 300);
  assert.equal(buffer.full, true);
  const filled = buffer.toArray();
  assert.equal(filled.length, 300);
  assert.equal(filled[0], 0);
  assert.equal(filled[299], 299);

  buffer.push(300);
  assert.equal(buffer.size, 300, '溢出后容量恒为上限');
  const overflowed = buffer.toArray();
  assert.equal(overflowed[0], 1, '最旧条目被 FIFO 覆盖');
  assert.equal(overflowed[299], 300, '最新条目位于尾部');

  // 副本隔离：外部修改不影响内部
  overflowed[0] = -1;
  assert.equal(buffer.toArray()[0], 1);

  const small = new RingBuffer(3);
  small.push('a');
  small.push('b');
  small.push('c');
  small.push('d');
  assert.deepEqual(small.toArray(), ['b', 'c', 'd']);

  small.clear();
  assert.equal(small.size, 0);
  assert.deepEqual(small.toArray(), []);

  assert.throws(() => new RingBuffer(0), RangeError);
  assert.throws(() => new RingBuffer(-5), RangeError);
  assert.throws(() => new RingBuffer(1.5), RangeError);
});

test('TELEMETRY-02: MomentumTracker 动量与 14 步 RSI（无 NaN、除零安全）', () => {
  const tracker = new MomentumTracker();
  assert.equal(tracker.snapshot().rsi, null);
  assert.equal(tracker.snapshot().samples, 0);

  tracker.observe(1, 0);
  let metrics = tracker.snapshot();
  assert.equal(metrics.samples, 0, '首个样本只建立基线，不产生 Δr');
  assert.equal(metrics.velocity, 0);
  assert.equal(metrics.lastRate, 1);
  assert.equal(metrics.rsi, null);

  tracker.observe(3, 10);
  metrics = tracker.snapshot();
  assert.equal(metrics.samples, 1);
  assert.equal(metrics.velocity, 2);
  assert.equal(metrics.netMomentum, 2);
  assert.equal(metrics.rsi, null, '样本不足一个周期绝不伪造 RSI');

  // 非有限 / 负值输入一律忽略，绝不污染状态
  const beforeInvalid = tracker.snapshot();
  tracker.observe(Number.NaN, 20);
  tracker.observe(-1, 20);
  tracker.observe(Number.POSITIVE_INFINITY, 20);
  assert.deepEqual(tracker.snapshot(), beforeInvalid);

  // 单调上行 → RSI 逼近 100
  const up = new MomentumTracker();
  let rate = 0;
  for (let i = 0; i <= MOMENTUM_RSI_PERIOD; i += 1) {
    rate += 2;
    up.observe(rate, i * 1000);
  }
  metrics = up.snapshot();
  assert.equal(metrics.samples, MOMENTUM_RSI_PERIOD);
  assert.equal(metrics.avgLoss, 0);
  assert.ok(Number.isFinite(metrics.rsi));
  assert.ok(metrics.rsi > 99, `单调上行 RSI 应逼近 100，实际 ${metrics.rsi}`);
  assert.equal(metrics.netMomentum, 2 * MOMENTUM_RSI_PERIOD);

  // 单调下行 → RSI 0
  const down = new MomentumTracker();
  rate = 100;
  for (let i = 0; i <= MOMENTUM_RSI_PERIOD; i += 1) {
    rate -= 2;
    down.observe(rate, i * 1000);
  }
  metrics = down.snapshot();
  assert.equal(metrics.rsi, 0);
  assert.ok(metrics.netMomentum < 0);

  // 完全平直 → 中性 50（除零安全）
  const flat = new MomentumTracker();
  for (let i = 0; i <= MOMENTUM_RSI_PERIOD + 3; i += 1) {
    flat.observe(7, i * 1000);
  }
  metrics = flat.snapshot();
  assert.equal(metrics.rsi, 50);
  assert.equal(metrics.netMomentum, 0);
  assert.equal(metrics.velocity, 0);
  assert.ok(Number.isFinite(metrics.avgGain) && Number.isFinite(metrics.avgLoss));

  flat.clear();
  assert.equal(flat.snapshot().rsi, null);
  assert.equal(flat.snapshot().samples, 0);
});

test('TELEMETRY-03: BaselineLedger 聚合、非法输入隔离与 1 小时窗口裁剪', () => {
  const ledger = new BaselineLedger('ledger-channel');
  ledger.recordSample(1000, 2, 1.5); // 下行
  ledger.recordSample(2000, 1.5, 2.0); // 上行
  ledger.recordSample(3000, 2.0, 2.0); // 写入但未移动
  ledger.recordDecay(4000, 2.0, 1.2); // 时间衰减
  ledger.recordRejection(5000, 'hysteresis');
  ledger.recordRejection(6000, 'prewarm');

  const snapshot = ledger.snapshot(6000);
  assert.equal(snapshot.channelId, 'ledger-channel');
  assert.equal(snapshot.windowMs, BASELINE_LEDGER_WINDOW_MS);
  assert.equal(snapshot.events, 6);
  assert.equal(snapshot.acceptedDown, 1);
  assert.ok(Math.abs(snapshot.downwardDelta + 0.5) < 1e-9);
  assert.equal(snapshot.acceptedUp, 1);
  assert.ok(Math.abs(snapshot.upwardDelta - 0.5) < 1e-9);
  assert.ok(Math.abs(snapshot.decayDelta + 0.8) < 1e-9);
  assert.equal(snapshot.rejectedHysteresis, 1);
  assert.equal(snapshot.rejectedPrewarm, 1);
  assert.equal(snapshot.firstAt, 1000);
  assert.equal(snapshot.lastAt, 6000);
  assert.ok(Math.abs(snapshot.netDelta + 0.8) < 1e-9);
  assert.ok(Number.isFinite(snapshot.netDelta));

  // 非法输入不进入账本
  ledger.recordSample(Number.NaN, 1, 2);
  ledger.recordDecay(7000, Number.NaN, 2);
  ledger.recordRejection(Number.NaN, 'prewarm');
  assert.equal(ledger.snapshot(6000).events, 6);

  // 窗口裁剪：1 小时后全部滑出
  const expired = ledger.snapshot(6000 + BASELINE_LEDGER_WINDOW_MS);
  assert.equal(expired.events, 0);
  assert.equal(expired.firstAt, null);
  assert.equal(expired.lastAt, null);
  assert.equal(expired.netDelta, 0);
  assert.equal(expired.acceptedUp + expired.acceptedDown, 0);

  // 有界事件缓冲：窗口内事件数超过容量时按 FIFO 覆盖
  const bounded = new BaselineLedger('bounded-channel', 2);
  bounded.recordRejection(1, 'prewarm');
  bounded.recordRejection(2, 'prewarm');
  bounded.recordRejection(3, 'prewarm');
  assert.equal(bounded.snapshot(3).events, 2);

  bounded.clear();
  assert.equal(bounded.snapshot(3).events, 0);
});

test('TELEMETRY-04: 生命周期端到端拦截（IDLE 账本 → PHASE_CHANGE → SESSION_FINALIZED → DISPATCH_RESULT 事件链连续）', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const logger = silentLogger();
  const system = new PatchouliKnowledgeSystem(baseConfig(), logger, undefined, { fetch: mockFetch });
  assert.ok(system.inspector, '系统构造即挂载 Inspector');
  assert.equal(system.inspector.attachedTo, system);

  let now = BASE_TIME;
  const send = async (id, content, userId, stepMs) => {
    now += stepMs;
    await system.onIncomingMessage({
      id,
      channelId: CHANNEL,
      userId,
      userName: userId === 'user-1' ? '甲' : '乙',
      content,
      timestamp: now,
    });
  };

  // 1) IDLE 期慢速闲聊：基线双向学习闸门落账（下行 / 上行样本至少其一被接受）
  await send('idle-1', '先聊聊今天的技术栈选择吧', 'user-1', 0);
  await send('idle-2', '我觉得单体架构更适合当前阶段', 'user-2', 30_000);
  await send('idle-3', '微服务的运维成本确实被低估了', 'user-1', 30_000);

  let { channel } = channelSnapshotOf(system);
  assert.ok(channel, 'IDLE 期消息即应建立频道遥测运行时');
  assert.equal(channel.gate.phase, 'IDLE');
  assert.ok(
    channel.baseline.acceptedDown + channel.baseline.acceptedUp >= 1,
    `IDLE 闸门账本应有已接受样本，实际 ${JSON.stringify(channel.baseline)}`,
  );
  assert.ok(channel.baseline.events >= 1);
  assert.ok(Number.isFinite(channel.momentum.velocity));
  assert.equal(channel.counters.observedMessages, 3);

  // 2) 静默 5 分钟后密集争论：进入 BURSTING 并产生 PHASE_CHANGE
  now += 300_000;
  for (let i = 1; i <= 10; i += 1) {
    await send(
      `burst-${i}`,
      `关于架构拆分的激烈争论观点 ${i}：单体与微服务的权衡`,
      i % 2 === 0 ? 'user-2' : 'user-1',
      3000,
    );
  }
  assert.equal(system.detector.getStatus(CHANNEL, now).phase, 'BURSTING');

  ({ channel } = channelSnapshotOf(system));
  const burstTrace = channel.traces.find((trace) => trace.kind === 'PHASE_CHANGE' && trace.data.to === 'BURSTING');
  assert.ok(burstTrace, '进入 BURSTING 必须留下 PHASE_CHANGE');
  assert.equal(burstTrace.data.from, 'IDLE');
  assert.equal(burstTrace.gate.phase, 'BURSTING');
  assert.ok(burstTrace.gate.threshold > 0);
  assert.ok(burstTrace.gate.speakers >= 2);
  assert.ok(burstTrace.gate.entropy >= 0.6);
  assert.equal(burstTrace.data.threshold, burstTrace.gate.threshold);

  // 3) 静默超过平息期后注入心跳：平息结算 → 调度 → AIMD
  now += 100_000;
  await system.onIncomingMessage(makeMessage({ id: 'settle-heartbeat', timestamp: now }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  ({ channel } = channelSnapshotOf(system));
  const traces = channel.traces;
  const finalized = traces.find((trace) => trace.kind === 'SESSION_FINALIZED');
  const dispatched = traces.find((trace) => trace.kind === 'DISPATCH_RESULT');
  const tuned = traces.find((trace) => trace.kind === 'AIMD_TUNED');
  assert.ok(finalized, '平息结算必须留下 SESSION_FINALIZED');
  assert.ok(dispatched, '调度回执必须留下 DISPATCH_RESULT');
  assert.ok(tuned, 'AIMD 调参必须留下 AIMD_TUNED');

  assert.equal(finalized.data.partial, false, '平息结算交付的是完整一轮讨论');
  assert.equal(finalized.data.messages, 10, '缓冲区应恰好装载 10 条突发消息');
  assert.ok(finalized.data.peakRate > 0);
  assert.ok(finalized.data.durationSeconds > 0);

  assert.equal(dispatched.data.success, true);
  assert.ok(dispatched.data.qualityScore >= 0.8);
  assert.equal(dispatched.data.discardReason, null);
  assert.ok(dispatched.data.durationMs >= 0);

  // 事件链连续：突发 → 结算 → 调度回执 → AIMD 全部共享同一 traceId
  assert.equal(finalized.traceId, burstTrace.traceId, 'SESSION_FINALIZED 必须沿用突发开启的事件链 ID');
  assert.equal(dispatched.traceId, finalized.traceId, 'DISPATCH_RESULT 的 traceId 必须与结算连续');
  assert.equal(dispatched.data.traceId, finalized.traceId);
  assert.equal(tuned.traceId, finalized.traceId);
  assert.notEqual(finalized.eventId, dispatched.eventId, '同一事件链内各事件 eventId 必须唯一');

  // AIMD：高质量讨论触发放宽，且 minDiscussionMessages 被硬下界夹回
  assert.equal(tuned.data.action, 'HIGH_QUALITY');
  assert.equal(tuned.data.beforeMinBurstRate, 6);
  assert.equal(tuned.data.afterMinBurstRate, 5.85);
  assert.equal(tuned.data.beforeMinDiscussionMessages, 5);
  assert.equal(tuned.data.afterMinDiscussionMessages, 6);
  assert.equal(tuned.data.clamped, 'minDiscussionMessages');

  assert.ok(channel.counters.observedMessages >= 13);
  assert.equal(channel.counters.sessionsFinalized, 1);
  assert.equal(channel.counters.dispatches, 1);
  assert.equal(channel.counters.aimdTunes, 1);
  assert.ok(system.inspector.getTelemetrySnapshot().totals.traces >= 5);

  // 全局 trace 与频道 trace 同源、可 JSON 序列化
  const payload = system.inspector.getTelemetrySnapshot();
  assert.ok(payload.traces.length >= channel.traces.length);
  assert.doesNotThrow(() => JSON.stringify(payload));

  system.dispose();
  await stopLedger(system);
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-05: NEAR_MISS 擦肩而过正常记录并带 3 分钟频控', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const config = baseConfig({
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 12,
      maxBufferMessages: 200,
      baselineEwmaAlpha: 0.05,
    },
  });
  const system = new PatchouliKnowledgeSystem(config, silentLogger(), undefined, { fetch: mockFetch });

  let now = BASE_TIME;
  let speakerSeq = 0;
  const send = async (id, stepMs) => {
    speakerSeq += 1;
    now += stepMs;
    await system.onIncomingMessage({
      id,
      channelId: CHANNEL,
      userId: speakerSeq % 2 === 0 ? 'user-2' : 'user-1',
      userName: speakerSeq % 2 === 0 ? '乙' : '甲',
      content: `擦肩而过的讨论内容 ${id}`,
      timestamp: now,
    });
  };

  // 5 条消息 / 60 秒：有效速率 5 条/分 ≥ 0.7 × 门限 6，但未达门限 → 擦肩而过
  for (let i = 1; i <= 5; i += 1) {
    await send(`near-${i}`, 12_000);
  }
  let { channel } = channelSnapshotOf(system);
  assert.equal(channel.gate.phase, 'IDLE', '擦肩而过必须停留在 IDLE');
  assert.equal(channel.gate.threshold, 6);
  assert.equal(channel.gate.rate, 5);
  assert.equal(channel.gate.nearMiss, true);
  assert.equal(channel.counters.nearMiss, 1);

  const first = channel.traces.find((trace) => trace.kind === 'NEAR_MISS');
  assert.ok(first, '擦肩而过必须留下 NEAR_MISS');
  assert.equal(first.data.rate, 5);
  assert.equal(first.data.threshold, 6);
  assert.equal(first.data.speakers, 2);
  assert.ok(first.data.distance > 0);
  assert.equal(first.gate.nearMiss, true);
  assert.equal('quality' in first.data, false, 'rate 模式的 NEAR_MISS 载荷不得凭空写出势能向量');
  assert.equal('quality' in first.gate, false, 'rate 模式的闸门向量不得凭空写出势能字段');

  // 3 分钟频控内：第 6 条（速率 6 条/分，仍未越门限）只累加压制计数
  await send('near-6', 12_000);
  ({ channel } = channelSnapshotOf(system));
  assert.equal(channel.counters.nearMiss, 1, '频控窗口内不得重复上报');
  assert.ok(channel.counters.nearMissSuppressed >= 1);
  assert.equal(channel.traces.filter((trace) => trace.kind === 'NEAR_MISS').length, 1);
  assert.equal(channel.gate.phase, 'IDLE');

  // 越过频控窗口后再次逼近门限 → 第二条 NEAR_MISS
  now += 200_000;
  for (let i = 7; i <= 11; i += 1) {
    await send(`near-${i}`, 12_000);
  }
  ({ channel } = channelSnapshotOf(system));
  assert.equal(channel.counters.nearMiss, 2, '越过 3 分钟频控后应重新上报');
  const nearMisses = channel.traces.filter((trace) => trace.kind === 'NEAR_MISS');
  assert.equal(nearMisses.length, 2);
  assert.ok(nearMisses[1].at - nearMisses[0].at >= 180_000, '两次上报间隔不得小于频控窗口');
  assert.equal(channel.gate.phase, 'IDLE');

  system.dispose();
  await stopLedger(system);
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-06: dispose 后猴子补丁完全还原，主流程方法不受影响', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const system = new PatchouliKnowledgeSystem(baseConfig(), silentLogger(), undefined, { fetch: mockFetch });
  const detector = system.detector;
  const baseline = detector.baseline;
  const dispatcher = system.dispatcher;

  const patches = [
    [detector, 'onMessage'],
    [detector, 'startBurst'],
    [detector, 'enterCooling'],
    [detector, 'finalize'],
    [detector, 'invokeHandler'],
    [baseline, 'record'],
    [baseline, 'decay'],
    [dispatcher, 'dispatch'],
    [system, 'applyAimdTuning'],
  ];
  for (const [target, name] of patches) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(target, name),
      true,
      `${name} 应以实例自有属性遮蔽原型方法`,
    );
  }

  system.dispose();
  system.dispose(); // 幂等

  for (const [target, name] of patches) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(target, name),
      false,
      `${name} 的自有属性必须被彻底删除`,
    );
  }
  assert.equal(detector.onMessage, BurstQuiescenceDetector.prototype.onMessage);
  assert.equal(detector.startBurst, BurstQuiescenceDetector.prototype.startBurst);
  assert.equal(detector.enterCooling, BurstQuiescenceDetector.prototype.enterCooling);
  assert.equal(detector.finalize, BurstQuiescenceDetector.prototype.finalize);
  assert.equal(detector.invokeHandler, BurstQuiescenceDetector.prototype.invokeHandler);
  assert.equal(baseline.record, BaselineEstimator.prototype.record);
  assert.equal(baseline.decay, BaselineEstimator.prototype.decay);
  assert.equal(dispatcher.dispatch, ModelDispatcher.prototype.dispatch);
  assert.equal(system.inspector.attachedTo, null);

  // 还原后原方法照常工作（不再产生任何遥测）
  const metrics = detector.onMessage(makeMessage({ id: 'post-dispose', channelId: 'post-dispose-channel' }));
  assert.equal(metrics.phase, 'IDLE');
  assert.equal(baseline.record('post-dispose-channel', BASE_TIME, { sampleRate: 1 }).learned, true);

  const empty = system.inspector.getTelemetrySnapshot();
  assert.equal(empty.attached, false);
  assert.deepEqual(empty.traces, []);
  assert.deepEqual(empty.channels, []);
  assert.equal(empty.totals.observedMessages, 0);

  // 重新挂载 → 再次织入 → 再次完整还原
  system.inspector.attachTelemetry(system);
  assert.equal(Object.prototype.hasOwnProperty.call(detector, 'onMessage'), true);
  await system.onIncomingMessage(makeMessage({ id: 're-attached' }));
  const reattached = system.inspector.getTelemetrySnapshot();
  assert.equal(reattached.attached, true);
  assert.equal(reattached.channels.length, 1);
  assert.equal(reattached.channels[0].channelId, CHANNEL);
  system.inspector.dispose();
  assert.equal(Object.prototype.hasOwnProperty.call(detector, 'onMessage'), false);
  assert.equal(system.inspector.getTelemetrySnapshot().attached, false);

  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-07: attachTelemetry 语法糖幂等挂载与自定义阈值生效', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const config = baseConfig({
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 12,
      maxBufferMessages: 200,
      baselineEwmaAlpha: 0.05,
    },
  });
  const system = new PatchouliKnowledgeSystem(config, silentLogger(), undefined, { fetch: mockFetch });
  // 先卸下系统自带的 Inspector，再以自定义参数挂载，避免双重织入
  system.inspector.dispose();

  const inspector = new PatchouliInspector();
  assert.equal(inspector.attachedTo, null);
  assert.equal(inspector.getTelemetrySnapshot().attached, false);
  assert.equal(inspector.attachTelemetry(system), inspector);
  assert.equal(inspector.attachTelemetry(system), inspector, '重复挂载同一系统必须幂等');
  assert.equal(inspector.attachedTo, system);

  const direct = attachTelemetry(system);
  assert.notEqual(direct, inspector, 'attachTelemetry 每次创建独立检查器');

  // 自定义 nearMissRatio = 0.5：3 条/分即触发擦肩而过（默认 0.7 需要 4.2 条/分）
  const custom = new PatchouliInspector({ nearMissRatio: 0.5, nearMissCooldownMs: 60_000 });
  direct.dispose();
  inspector.dispose();
  custom.attachTelemetry(system);

  let now = BASE_TIME;
  for (let i = 1; i <= 3; i += 1) {
    now += 12_000;
    await system.onIncomingMessage({
      id: `ratio-${i}`,
      channelId: CHANNEL,
      userId: i % 2 === 0 ? 'user-2' : 'user-1',
      userName: '甲',
      content: `自定义阈值下的擦肩而过 ${i}`,
      timestamp: now,
    });
  }

  const snapshot = custom.getTelemetrySnapshot();
  const channel = snapshot.channels.find((item) => item.channelId === CHANNEL);
  assert.ok(channel);
  assert.equal(channel.gate.rate, 3);
  assert.equal(channel.gate.threshold, 6);
  const nearMiss = channel.traces.find((trace) => trace.kind === 'NEAR_MISS');
  assert.ok(nearMiss, '自定义比例下 3 条/分即应判定擦肩而过');
  assert.equal(nearMiss.data.ratio, 0.5);
  assert.equal(nearMiss.data.cooldownMs, 60_000);

  custom.dispose();
  assert.equal(Object.prototype.hasOwnProperty.call(system.detector, 'onMessage'), false);
  assert.equal(custom.getTelemetrySnapshot().attached, false);
  assert.equal(createEmptyTelemetrySnapshot().attached, false);

  system.dispose();
  await stopLedger(system);
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-08: GET /api/telemetry 契约（已挂载 / 测试替身两种宿主）', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const system = new PatchouliKnowledgeSystem(baseConfig(), silentLogger(), undefined, { fetch: mockFetch });
  const router = createRouter();
  registerWebUi({ router }, system, '/patchouli');

  const handler = router.routes.get('/patchouli/api/telemetry');
  assert.equal(typeof handler, 'function');

  const ctx = createKoaContext();
  await handler(ctx);
  assert.equal(ctx.type, 'application/json');
  assert.equal(ctx.body.attached, true);
  assert.deepEqual(ctx.body.channels, []);
  assert.equal(ctx.body.totals.observedMessages, 0);
  assert.ok(Number.isInteger(ctx.body.errors));
  assert.ok(ctx.body.generatedAt > 0);

  await system.onIncomingMessage(makeMessage({ id: 'api-1' }));
  const ctx2 = createKoaContext();
  await handler(ctx2);
  assert.equal(ctx2.body.channels.length, 1);
  assert.equal(ctx2.body.channels[0].channelId, CHANNEL);
  assert.equal(ctx2.body.channels[0].gate.phase, 'IDLE');
  assert.equal(ctx2.body.totals.observedMessages, 1);
  assert.doesNotThrow(() => JSON.stringify(ctx2.body));

  system.dispose();

  // 宿主替身（无 inspector）：形状恒定的基础空结构
  const stubRouter = createRouter();
  registerWebUi({ router: stubRouter }, {}, '/patchouli');
  const stubHandler = stubRouter.routes.get('/patchouli/api/telemetry');
  assert.equal(typeof stubHandler, 'function');
  const stubCtx = createKoaContext();
  await stubHandler(stubCtx);
  assert.equal(stubCtx.type, 'application/json');
  assert.equal(stubCtx.body.attached, false);
  assert.deepEqual(stubCtx.body.traces, []);
  assert.deepEqual(stubCtx.body.channels, []);

  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-09: shadow 模式闸门向量与 NEAR_MISS / PHASE_CHANGE 载荷带势能五元组', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const config = baseConfig({
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 5,
      maxBufferMessages: 200,
      baselineEwmaAlpha: 0.05,
      triggerMode: 'shadow',
      thetaMin: 20,
      rhoMin: 1.2,
    },
  });
  const system = new PatchouliKnowledgeSystem(config, silentLogger(), undefined, { fetch: mockFetch });

  const vectorKeys = ['quality', 'density', 'interaction', 'baselineQuality', 'coolThreshold'];
  let now = BASE_TIME;
  let seq = 0;
  const send = async (id, stepMs) => {
    seq += 1;
    now += stepMs;
    await system.onIncomingMessage({
      id,
      channelId: CHANNEL,
      userId: seq % 2 === 0 ? 'user-2' : 'user-1',
      userName: seq % 2 === 0 ? '乙' : '甲',
      content: `影子模式样本 ${id}：围绕分布式一致性协议取舍的长段论述与反例`,
      timestamp: now,
    });
  };

  // 1) 速率判据仍主席裁决：5 条/分低于门限 6 但越过 0.7 倍 → NEAR_MISS
  for (let i = 1; i <= 5; i += 1) {
    await send(`shadow-near-${i}`, 12_000);
  }
  let { channel } = channelSnapshotOf(system);
  const nearMiss = channel.traces.find((trace) => trace.kind === 'NEAR_MISS');
  assert.ok(nearMiss, 'shadow 模式相位仍由速率裁决，擦肩而过照常上报');
  assert.equal(nearMiss.gate.phase, 'IDLE');
  assert.equal(nearMiss.gate.threshold, 6, 'shadow 的相位由速率裁决，遥测门限必须仍是速率门限');
  assert.equal(nearMiss.data.threshold, 6, 'NEAR_MISS 的距离口径同样取速率门限');
  assert.equal(channel.gate.rhoMin, undefined, 'shadow 不参与 Q/ρ 裁决，闸门不得伪造 ρ_min');
  for (const key of vectorKeys) {
    assert.equal(typeof nearMiss.data[key], 'number', `NEAR_MISS.data.${key} 必须是数值`);
    assert.ok(Number.isFinite(nearMiss.data[key]), `NEAR_MISS.data.${key} 必须有限`);
    assert.equal(nearMiss.data[key], nearMiss.gate[key], `data.${key} 必须与同一闸门同源`);
    assert.equal(typeof channel.gate[key], 'number', `闸门向量必须带 ${key}`);
  }
  assert.ok(nearMiss.data.quality > 0, '有效讨论势能 Q = E · S_turn 应为正');
  assert.ok(
    nearMiss.data.interaction >= 0 && nearMiss.data.interaction <= 1 + 1e-9,
    `S_turn 必须归一化到 [0,1]，实际 ${nearMiss.data.interaction}`,
  );
  assert.equal(
    nearMiss.data.coolThreshold,
    potentialCoolThreshold(system.detector.getOptions(CHANNEL), nearMiss.data.baselineQuality),
    'Θ_cool 必须来自状态机同一个门限函数（不得另立第二套口径）',
  );

  // 2) 密度上升 → 速率判据进入 BURSTING，PHASE_CHANGE 载荷同样带五元组
  for (let i = 1; i <= 6; i += 1) {
    await send(`shadow-burst-${i}`, 3_000);
  }
  ({ channel } = channelSnapshotOf(system));
  const burstTrace = channel.traces.find(
    (trace) => trace.kind === 'PHASE_CHANGE' && trace.data.to === 'BURSTING',
  );
  assert.ok(burstTrace, 'shadow 模式必须记录速率判据的相位迁移');
  assert.equal(burstTrace.data.from, 'IDLE');
  for (const key of vectorKeys) {
    assert.equal(typeof burstTrace.data[key], 'number', `PHASE_CHANGE.data.${key} 必须是数值`);
    assert.equal(burstTrace.data[key], burstTrace.gate[key], `data.${key} 与闸门同源`);
  }
  assert.ok(channel.gate.quality > 0, '快照闸门必须持续带势能观测');
  assert.equal(typeof channel.gate.speakers, 'number', '速率判据字段不因新增向量而丢失');

  // 3) 平息结算 → AIMD：shadow 的相位仍由速率裁决，步进必须落在真正生效的速率门限上，
  //    不得去动不参与决策的 Θ_min（§7.5.8「旧状态机照常裁决」）。
  now += 400_000;
  await send('shadow-settle-heartbeat', 0);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const afterAimd = system.detector.getOptions(CHANNEL);
  assert.equal(afterAimd.thetaMin, 20, 'shadow 模式下 AIMD 不得移动不参与决策的 Θ_min');
  assert.equal(afterAimd.minBurstRate, 5.85, '高质量讨论使速率门限放宽 0.15 (6 -> 5.85)');
  assert.equal(afterAimd.minDiscussionMessages, 6, '完整度门限照常放宽 0.5 并被硬下界 6 夹紧');

  const tuned = channelSnapshotOf(system).channel.traces.find((trace) => trace.kind === 'AIMD_TUNED');
  assert.ok(tuned, 'AIMD 调参必须留下 AIMD_TUNED');
  assert.equal(tuned.data.target, 'rate', 'trace 必须标明步进作用在速率判据层');
  assert.equal(tuned.data.beforeThetaMin, 20);
  assert.equal(tuned.data.afterThetaMin, 20);
  assert.equal(tuned.data.beforeMinBurstRate, 6);
  assert.equal(tuned.data.afterMinBurstRate, 5.85);
  assert.equal(system.getTuningSnapshot(CHANNEL).parameters.thetaMin, 20);
  assert.equal(system.getTuningSnapshot(CHANNEL).parameters.minBurstRate, 5.85);

  system.dispose();
  await stopLedger(system);
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-10: potential 模式闸门读 Θ_burst 与 ρ_min（不退回速率门限）', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const content = [
    '把每条消息折算成可以被比较的信息量，再放进同一个衰减核里积分，大小群的差异就被抹平了。',
    '大群靠频率，小群靠深度，两条路径在势能上收敛到同一量级；真正要小心的只有伪互动。',
    '一个人在演讲另一个人在附和时，交互熵会明显偏低，即使总势能很高也不该误判成讨论。',
    '旧触发器只看单位时间内的条数，于是复读群和讨论群在全序关系上完全一样。',
    '换成漏桶以后，复读群的消息权重接近零，讨论群的消息权重更高，长度再被对数压缩一次。',
  ];
  const config = baseConfig({
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      // 速率门限远高于实际速率：若遥测仍读速率门限，下面的等式必然不成立。
      minBurstRate: 20,
      quiescenceSeconds: 300,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 5,
      maxBufferMessages: 200,
      baselineEwmaAlpha: 0.05,
      triggerMode: 'potential',
      thetaMin: 12,
      rhoMin: 1.2,
    },
  });
  const system = new PatchouliKnowledgeSystem(config, silentLogger(), undefined, { fetch: mockFetch });

  let now = BASE_TIME;
  for (let i = 0; i < content.length; i += 1) {
    now += 12_000;
    await system.onIncomingMessage({
      id: `potential-telemetry-${i}`,
      channelId: CHANNEL,
      userId: i % 2 === 0 ? 'user-1' : 'user-2',
      userName: i % 2 === 0 ? '甲' : '乙',
      content: content[i],
      timestamp: now,
    });
  }

  const { channel } = channelSnapshotOf(system);
  const options = system.detector.getOptions(CHANNEL);
  assert.equal(channel.gate.threshold, potentialBurstThreshold(options, channel.gate.baselineQuality),
    'potential 模式的 gate.threshold 必须是状态机同一个 Θ_burst 口径');
  assert.notEqual(channel.gate.threshold, burstThreshold(options, 0),
    '不得退回速率门限（minBurstRate=20 与 Θ_burst=12 必须可区分）');
  assert.equal(channel.gate.rhoMin, 1.2, '闸门必须带 ρ_min');
  assert.equal(typeof channel.gate.density, 'number');

  // 就绪口径同样按 Q/ρ：擦肩而过 = IDLE 且 Q ≥ 0.7·Θ_burst 且 ρ ≥ ρ_min。
  const expectNearMiss =
    channel.gate.phase === 'IDLE' &&
    channel.gate.threshold > 0 &&
    channel.gate.quality >= 0.7 * channel.gate.threshold &&
    channel.gate.density >= channel.gate.rhoMin;
  assert.equal(channel.gate.nearMiss, expectNearMiss, 'NEAR_MISS 判定必须走 Q/ρ 而不是有效速率');
  const nearMiss = channel.traces.find((trace) => trace.kind === 'NEAR_MISS');
  if (nearMiss !== undefined) {
    assert.equal(nearMiss.data.threshold, nearMiss.gate.threshold);
    assert.match(nearMiss.detail, /Θ_burst/u, '势能模式的擦肩而过文案必须写 Θ_burst');
  }

  system.dispose();
  await stopLedger(system);
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('TELEMETRY-12: shadow 模式下裁决点与会话结算落盘（两套判据并列 + 沉淀口径）', async () => {
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await fs.mkdir(TELEMETRY_WIKI_DIR, { recursive: true });

  const config = baseConfig({
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 60,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 5,
      maxBufferMessages: 200,
      baselineEwmaAlpha: 0.1,
      triggerMode: 'shadow',
    },
  });
  const system = new PatchouliKnowledgeSystem(config, silentLogger(), undefined, { fetch: mockFetch });
  system.inspector.dispose();

  const records = [];
  const inspector = attachTelemetry(system, { onRecord: (record) => records.push(record) });

  // 三个发言人、密集到足以让频率判据 ready：两条判据的结论都要落同一条 decision。
  const users = ['u1', 'u2', 'u3'];
  for (let index = 0; index < 24; index += 1) {
    await system.onIncomingMessage(
      makeMessage({
        id: `shadow-${index}`,
        userId: users[index % 3],
        userName: users[index % 3],
        content: `第 ${index} 条：不同发言人给出异质论据，用于判据对照`,
        timestamp: BASE_TIME + index * 1200,
      }),
    );
  }

  const decisions = records.filter((record) => record.kind === 'decision');
  assert.ok(decisions.length > 0, 'shadow 模式必须落决策记录');
  for (const record of decisions) {
    assert.equal(record.triggerMode, 'shadow');
    assert.equal(typeof record.agree, 'boolean');
    assert.ok(Number.isFinite(record.rate.threshold), '频率侧门限必须是数值');
    assert.ok(Number.isFinite(record.potential.burstThreshold), '势能侧门限必须是数值');
    assert.ok(Number.isFinite(record.potential.quality), '势能侧必须带 Q');
  }
  assert.ok(
    decisions.some((record) => record.rate.ready),
    '密集三发言人消息必须让频率判据 ready 并被记录',
  );
  // 参数快照每进程每群只记一条，且必须带上两侧门限（标定的前提）。
  const configs = records.filter((record) => record.kind === 'config');
  assert.equal(configs.length, 1, '参数快照每群每进程只记一条，不随小时重复');
  assert.equal(configs[0].reason, 'startup');
  assert.ok(Number.isFinite(configs[0].thetaMin) && Number.isFinite(configs[0].rhoMin));

  // 摘要按小时落盘：24 条消息都落在同一小时时不应产出 digest（尚未跨小时）。
  assert.equal(
    records.filter((record) => record.kind === 'digest').length,
    0,
    '同一小时内不落 digest，跨小时才落',
  );

  // 跨小时必须落一条 digest（标定分布），且极值来自本小时累计。
  await system.onIncomingMessage(
    makeMessage({
      id: 'shadow-next-hour',
      userId: 'u1',
      userName: 'u1',
      content: '下一小时的第一条：触发摘要落盘',
      timestamp: BASE_TIME + 24 * 1200 + 3_600_000,
    }),
  );
  const digests = records.filter((record) => record.kind === 'digest');
  assert.equal(digests.length, 1, '跨小时落一条 digest');
  assert.ok(digests[0].messages >= 1, 'digest 必须带该小时的消息计数');
  assert.ok(Number.isFinite(digests[0].maxQuality), 'digest 必须带 Q 极值（标定口径）');

  // 结论跳变才记：同一次 ready 不能每条消息刷一条。
  const readyKeys = decisions.map((record) => `${record.phase}|${record.rate.ready}|${record.potential.ready}`);
  assert.equal(new Set(readyKeys).size, readyKeys.length, '同一结论不得重复落盘');

  inspector.dispose();
  system.dispose();
  await stopLedger(system);
  await fs.rm(TELEMETRY_WIKI_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});
