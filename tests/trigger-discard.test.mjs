import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  BUFFER_SOFT_SLICE_MESSAGES,
  BurstQuiescenceDetector,
  PatchouliKnowledgeSystem,
} from '../lib/index.js';

const BASE_TIME = 1700000000000;
const DISCARD_WIKI_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../tmp/discard-llmwiki-' + process.pid,
);

function makeMessage(overrides = {}) {
  return {
    id: 'msg',
    channelId: 'group-discard',
    userId: 'u1',
    userName: '群友1',
    content: '讨论内容各不相同',
    timestamp: BASE_TIME,
    ...overrides,
  };
}

/** 群聊消息的固定模板：多发言人 + 内容互异，满足突发判定的物理门限。 */
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

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function makeModelResponse() {
  const body = JSON.stringify(MODEL_BODY);
  return {
    id: 'resp_discard_test',
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: body }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 900 },
  };
}

function makePluginConfig(wikiDir, channels) {
  return {
    enabled: true,
    channels,
    notifyOnSummarized: false,
    trigger: {
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
  };
}

function makePluginSystem(wikiDir, channels) {
  const logs = [];
  const logger = {
    info: (m) => logs.push(`INFO: ${m}`),
    warn: (m) => logs.push(`WARN: ${m}`),
    error: (m) => logs.push(`ERROR: ${m}`),
  };
  const mockFetch = async () => {
    const response = makeModelResponse();
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  const system = new PatchouliKnowledgeSystem(makePluginConfig(wikiDir, channels), logger, undefined, {
    fetch: mockFetch,
  });
  return { system, logs };
}

async function feedBurst(system, channelId, count, stepMs, startAt) {
  let timestamp = startAt;
  for (let i = 1; i <= count; i++) {
    timestamp += stepMs;
    await system.onIncomingMessage(debateMessage(channelId, i, timestamp));
  }
  return timestamp;
}

test('DISCARD-01: 缓冲不足时 onDiscard 上报完整判定依据并回到 IDLE', () => {
  const settled = [];
  const discards = [];
  let currentTime = BASE_TIME;

  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 100,
      minDiscussionMessages: 25,
    },
    now: () => currentTime,
    onQuiescence: (session) => settled.push(session),
    onDiscard: (info) => discards.push(info),
  });

  const channelId = 'group-insufficient';
  for (let i = 1; i <= 15; i++) {
    currentTime += 2000;
    detector.onMessage(debateMessage(channelId, i, currentTime));
  }
  assert.equal(detector.getStatus(channelId).phase, 'BURSTING');

  const buffered = detector.getState(channelId).buffer.length;
  const peakRate = detector.getState(channelId).peakRate;
  assert.ok(buffered < 25, '前置条件：缓冲条数必须低于沉淀下限');

  // 越过平息静默期：结算时缓冲区不足 → 判定丢弃
  currentTime += 120_000;
  detector.onMessage(debateMessage(channelId, 99, currentTime));

  assert.equal(discards.length, 1, '缓冲不足必须上报一次诊断');
  assert.equal(settled.length, 0, '丢弃分支不得交付沉淀会话');

  const info = discards[0];
  assert.equal(info.channelId, channelId);
  assert.equal(info.messageCount, buffered, '诊断里的缓冲条数必须与实际缓冲区一致');
  assert.equal(info.minDiscussionMessages, 25);
  assert.equal(info.peakRate, peakRate, '诊断里的峰值速率必须与本轮一致');
  assert.ok(info.peakRate > 0 && Number.isFinite(info.peakRate));
  assert.equal(typeof info.triggerReason, 'string');
  assert.ok(info.triggerReason.length > 0, '触发依据不得为空');
  assert.ok(
    info.triggerReason.includes('触发门限'),
    `触发依据应说明突发判定口径：${info.triggerReason}`,
  );

  assert.equal(detector.getStatus(channelId).phase, 'IDLE', '丢弃后相位必须回到 IDLE');
  detector.dispose();
});

test('DISCARD-02: 正常 finalize 交付的会话 partial === false', () => {
  const settled = [];
  let currentTime = BASE_TIME;

  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 100,
      minDiscussionMessages: 5,
    },
    now: () => currentTime,
    onQuiescence: (session) => settled.push(session),
  });

  const channelId = 'group-complete';
  for (let i = 1; i <= 10; i++) {
    currentTime += 3000;
    detector.onMessage(debateMessage(channelId, i, currentTime));
  }
  assert.equal(detector.getStatus(channelId).phase, 'BURSTING');

  currentTime += 150_000;
  detector.onMessage(debateMessage(channelId, 11, currentTime));

  assert.equal(settled.length, 1);
  assert.equal(settled[0].partial, false, '正常平息结算必须显式标记 partial: false');
  assert.ok(settled[0].messages.length >= 5);
  detector.dispose();
});

test('DISCARD-03: flushSlice 软切片交付的会话 partial === true 且不改变相位', () => {
  const settled = [];
  let currentTime = BASE_TIME;

  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      minDiscussionMessages: 12,
    },
    now: () => currentTime,
    onQuiescence: (session) => settled.push(session),
  });

  const channelId = 'group-soft-slice';
  const total = BUFFER_SOFT_SLICE_MESSAGES + 10;
  for (let i = 1; i <= total; i++) {
    currentTime += 1000;
    detector.onMessage(debateMessage(channelId, i, currentTime));
  }

  assert.ok(settled.length >= 1, '缓冲达到软切片阈值必须立即交付');
  const slice = settled[0];
  assert.equal(slice.partial, true, '软切片交付必须标记 partial: true');
  assert.ok(slice.messages.length >= BUFFER_SOFT_SLICE_MESSAGES, '软切片应成批交付');
  assert.ok(slice.triggerReason.includes('软切片'), `软切片原因必须留痕：${slice.triggerReason}`);
  assert.notEqual(detector.getStatus(channelId).phase, 'IDLE', '软切片不得结束本轮讨论');
  detector.dispose();
});

test('DISCARD-04: onDiscard 回调抛错被吞掉且状态机照常推进', () => {
  const errors = [];
  let currentTime = BASE_TIME;

  const detector = new BurstQuiescenceDetector({
    options: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 100,
      minDiscussionMessages: 30,
    },
    now: () => currentTime,
    onQuiescence: () => {
      throw new Error('不应触达沉淀回调');
    },
    onDiscard: () => {
      throw new Error('diagnostics boom');
    },
    onError: (error) => errors.push(error),
  });

  const channelId = 'group-throwing-discard';
  for (let i = 1; i <= 12; i++) {
    currentTime += 2000;
    assert.doesNotThrow(() => detector.onMessage(debateMessage(channelId, i, currentTime)));
  }

  currentTime += 120_000;
  assert.doesNotThrow(
    () => detector.onMessage(debateMessage(channelId, 90, currentTime)),
    'onDiscard 抛错不得外溢到消息主循环',
  );

  assert.equal(errors.length, 1, '回调异常应转交 onError');
  assert.ok(String(errors[0].message ?? errors[0]).includes('diagnostics boom'));
  assert.equal(detector.getStatus(channelId).phase, 'IDLE');

  // 状态机仍可用：新一轮突发照常触发
  for (let i = 100; i < 115; i++) {
    currentTime += 2000;
    detector.onMessage(debateMessage(channelId, i, currentTime));
  }
  assert.equal(detector.getStatus(channelId).phase, 'BURSTING', '丢弃后状态机必须可再次进入突发');
  detector.dispose();
});

test('PLUGIN-DISCARD-01: 软切片会话不落 AIMD，非软切片会话照常调节', async () => {
  await fs.rm(DISCARD_WIKI_DIR, { recursive: true, force: true });
  await fs.mkdir(DISCARD_WIKI_DIR, { recursive: true });

  const sliceChannel = 'group-slice-aimd';
  const fullChannel = 'group-full-aimd';
  const shortChannel = 'group-short-discard';
  const { system, logs } = makePluginSystem(DISCARD_WIKI_DIR, [sliceChannel, fullChannel, shortChannel]);

  try {
    // 1) 软切片：持续密集讨论，缓冲区达到 120 条 → partial 会话
    let now = await feedBurst(system, sliceChannel, BUFFER_SOFT_SLICE_MESSAGES + 5, 1000, BASE_TIME);
    await waitFor(
      () => logs.some((m) => m.includes('软切片交付不参与 AIMD 门限调节')),
      '软切片 AIMD 跳过日志',
    );

    const sliceOptions = system.detector.getOptions(sliceChannel);
    assert.equal(sliceOptions.minDiscussionMessages, 12, '软切片不得抬升沉淀下限');
    assert.equal(sliceOptions.minBurstRate, 6, '软切片不得抬升突发下限');
    assert.equal(
      await system.localStore.loadCadenceState(sliceChannel),
      undefined,
      '软切片不得写入 AIMD 节奏快照',
    );
    assert.ok(
      !logs.some((m) => m.includes('AIMD 调节') && m.includes(sliceChannel)),
      '软切片群不应出现 AIMD 调节日志',
    );

    // 2) 完整会话：14 条突发 + 越过平息期 → partial:false → HIGH_QUALITY 放宽门限
    const fullEnd = await feedBurst(system, fullChannel, 14, 1000, BASE_TIME);
    await system.onIncomingMessage(debateMessage(fullChannel, 99, fullEnd + 400_000));
    await waitFor(
      async () => Boolean(await system.localStore.loadCadenceState(fullChannel)),
      '非软切片会话持久化快照',
    );

    const fullOptions = system.detector.getOptions(fullChannel);
    assert.equal(fullOptions.minDiscussionMessages, 11.5, '高质量完整会话应放宽沉淀下限');
    assert.equal(fullOptions.minBurstRate, 5.85, '高质量完整会话应放宽突发下限');

    const snapshot = await system.localStore.loadCadenceState(fullChannel);
    assert.ok(snapshot, '非软切片会话必须持久化节奏快照');
    assert.equal(snapshot.options.minDiscussionMessages, 11.5);
    assert.ok(
      logs.some((m) => m.includes('AIMD 调节') && m.includes(fullChannel)),
      '完整会话应产生 AIMD 调节日志',
    );

    // 3) 缓冲不足：丢弃分支必须留痕，且不写快照
    now = await feedBurst(system, shortChannel, 8, 1000, BASE_TIME);
    await system.onIncomingMessage(debateMessage(shortChannel, 99, now + 400_000));
    await waitFor(
      () => logs.some((m) => m.includes('讨论不足未沉淀') && m.includes(shortChannel)),
      '缓冲不足诊断日志',
    );

    const discardLog = logs.find((m) => m.includes('讨论不足未沉淀') && m.includes(shortChannel));
    assert.match(discardLog, /缓冲 (\d+) 条 < 下限 12 条（峰值 \d+\.\d\/m）/);
    const reported = Number(/缓冲 (\d+) 条/.exec(discardLog)[1]);
    assert.ok(reported > 0 && reported < 12, `缓冲条数必须真实且低于下限：${reported}`);
    assert.equal(system.detector.getOptions(shortChannel).minDiscussionMessages, 12);
    assert.equal(await system.localStore.loadCadenceState(shortChannel), undefined);
  } finally {
    system.dispose();
  }
});
