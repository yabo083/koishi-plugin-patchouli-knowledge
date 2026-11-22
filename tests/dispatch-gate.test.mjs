/**
 * 调度质量门回归测试（`trigger.dispatchMargin`，GATE-06 ~ GATE-08）。
 *
 * 锁死契约：
 *  - 完整结算（`partial !== true`）且 `potentialPeak.quality < Θ_burst × dispatchMargin` 时，
 *    **不调 judge、不调 dispatcher**，只留 info 日志 + `recordDiscard(kind:'GATE')`；
 *  - `dispatchMargin === 0`（默认）与软切片（`partial === true`）一律不受影响；
 *  - `GATE` 进 discard dump 文档并可被 `readDiscardDump` 原样读出。
 *
 * 用例直接驱动 `handleQuiescence`（运行期可访问的类方法）并手工构造 `potentialPeak`，
 * 因此不依赖探测器侧的峰值填充实现——门限比较是纯插件层行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  Config,
  PatchouliKnowledgeSystem,
  listDiscardDumps,
  readDiscardDump,
} from '../lib/index.js';

const BASE_TIME = 1_700_000_000_000;
const TMP_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../tmp',
);

/** Windows 上插件后台写盘可能与清理并发：rm 自带重试，不让收尾噪音掩盖用例结论。 */
async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function tempDir(label) {
  return path.join(TMP_ROOT, `dispatch-gate-${label}-${process.pid}`);
}

function makeMessage(channelId, index, timestamp) {
  return {
    id: `${channelId}-${index}`,
    channelId,
    userId: `user-${index % 4}`,
    userName: `辩友${index % 4}`,
    content: `论点交锋 #${index}：我认为这个取舍取决于写入仲裁成本与副本一致性`,
    timestamp,
  };
}

const MODEL_BODY = {
  shouldDiscard: false,
  title: '分片复制与仲裁写入的取舍',
  summary: '群友讨论了副本一致性与写入仲裁成本之间的边界。',
  background: '讨论源于一次存储选型的争论。',
  status: 'verified',
  tags: ['分布式', '一致性'],
  debateMatrix: [],
  consensus: ['一致性级别应随业务读写比例分级配置'],
  openQuestions: [],
  keyQuotes: [],
  qualityScore: 0.9,
  discardReason: null,
};

function makeConfig(wikiDir, channels, judge) {
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
      /** 势能突发门限：与手工构造的 `potentialPeak.burstThreshold` 同一口径。 */
      thetaMin: 20,
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

const JUDGE_ON = { enabled: true, baseURL: 'http://judge.local', apiKey: 'judge-key', model: 'jev-local', timeoutMs: 1000 };

function makeSystem(wikiDir, channels, judge = JUDGE_ON) {
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
    const payload = {
      id: 'resp_dispatch_gate',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(MODEL_BODY) }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 900 },
    };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const system = new PatchouliKnowledgeSystem(makeConfig(wikiDir, channels, judge), logger, undefined, {
    fetch: mockFetch,
  });
  return { system, logs, dispatchCount: () => dispatchCount };
}

/** 完整一轮讨论（`partial: false`）+ 手工注入的峰值观测。 */
function makeSession(channelId, peak, overrides = {}) {
  const messages = Array.from({ length: 14 }, (_, i) =>
    makeMessage(channelId, i + 1, BASE_TIME + i * 1000),
  );
  return {
    sessionId: `session-${channelId}`,
    channelId,
    startTime: BASE_TIME,
    endTime: BASE_TIME + 600_000,
    messages,
    peakRate: 12,
    triggerReason: '势能突发',
    partial: false,
    potentialPeak: peak,
    ...overrides,
  };
}

async function withJudgeStub(run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ answers: { valuable: { type: 'noul', noul: 0.9 } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** 峰值 21 vs Θ_burst 20：margin=1.3 时门限 26，属「过阈但勉强」。 */
const MARGINAL_PEAK = { quality: 21, density: 1.4, burstThreshold: 20 };

test('GATE-06: margin=1.3 且 peakQ 勉强过阈时跳过调度并留 GATE 证据', async () => {
  const wikiDir = tempDir('skip');
  const channelId = 'group-gate-margin';
  await removeDir(wikiDir);

  await withJudgeStub(async (judgeCalls) => {
    const { system, logs, dispatchCount } = makeSystem(wikiDir, [channelId]);
    // 消费侧读该群生效 options（`detector.getOptions(channelId).dispatchMargin`）：
    // 生产上是面板 `POST /api/tune` 写入的路径，测试走同一个 `updateOptions` 入口。
    system.detector.updateOptions(channelId, { dispatchMargin: 1.3 });
    try {
      await system.handleQuiescence(makeSession(channelId, MARGINAL_PEAK));

      assert.equal(dispatchCount(), 0, '门限之下不得调用云端调度器');
      assert.equal(judgeCalls.length, 0, '质量门位于 judge 门控之前，不得调用本地裁判');

      const log = logs.find((line) => line.includes('峰值质量未达调度门限'));
      assert.ok(log, `必须留一条 info 日志：${logs.join(' | ')}`);
      assert.match(log, /^INFO:/);
      assert.match(log, /peakQ=21\.000/);
      assert.match(log, /26\.000/);
      assert.match(log, /Θ_burst 20\.000 × 1\.3/);

      // 自家闸门不构成证据：不做 AIMD 步进、不写快照。
      assert.equal(system.detector.getOptions(channelId).minBurstRate, 6);
      assert.equal(system.detector.getOptions(channelId).thetaMin, 20);
      assert.equal(system.detector.getOptions(channelId).minDiscussionMessages, 12);
      assert.ok(
        !logs.some((line) => line.includes('AIMD 调节')),
        '质量门跳过不得触发 AIMD 步进',
      );
      assert.equal(await system.localStore.loadCadenceState(channelId), undefined);

      const debatesDir = path.join(wikiDir, 'wiki', 'debates');
      const names = await fs.readdir(debatesDir).catch(() => []);
      assert.deepEqual(names, [], '跳过轮次不得产出词条');
    } finally {
      system.dispose();
    }
  });

  await removeDir(wikiDir);
});

test('GATE-07: margin=0 与软切片会话都不受质量门影响', async () => {
  const offDir = tempDir('off');
  const sliceDir = tempDir('slice');
  const offChannel = 'group-gate-off';
  const sliceChannel = 'group-gate-slice';
  await removeDir(offDir);
  await removeDir(sliceDir);

  await withJudgeStub(async (judgeCalls) => {
    // ① 默认关闭：同一份「勉强过阈」的峰值照常调度（判据只在 margin > 0 时生效）。
    const off = makeSystem(offDir, [offChannel]);
    try {
      assert.equal(off.system.config.trigger.dispatchMargin, undefined, '未配置即未启用');
      await off.system.handleQuiescence(makeSession(offChannel, MARGINAL_PEAK));
      assert.equal(off.dispatchCount(), 1, 'margin=0 必须照常调度');
      assert.equal(judgeCalls.length, 1, 'judge 门控照常参与');
      assert.ok(!off.logs.some((line) => line.includes('峰值质量未达调度门限')));
    } finally {
      off.system.dispose();
    }

    // ② 软切片：语义不完整，质量门与 judge 门控一起跳过。
    const slice = makeSystem(sliceDir, [sliceChannel]);
    slice.system.detector.updateOptions(sliceChannel, { dispatchMargin: 1.3 });
    try {
      await slice.system.handleQuiescence(makeSession(sliceChannel, MARGINAL_PEAK, { partial: true }));
      assert.equal(slice.dispatchCount(), 1, '软切片不受质量门拦截');
      assert.ok(!slice.logs.some((line) => line.includes('峰值质量未达调度门限')));
      assert.ok(
        slice.logs.some((line) => line.includes('软切片交付不参与 AIMD 门限调节')),
        '软切片仍走原有 AIMD 隔离',
      );
    } finally {
      slice.system.dispose();
    }
  });

  // ③ Schema 默认值 = 0（关闭），因此旧配置升级后行为逐位不变。
  assert.equal(Config({}).trigger.dispatchMargin, 0);
  assert.equal(Config({ trigger: { dispatchMargin: 1.3 } }).trigger.dispatchMargin, 1.3);

  await removeDir(offDir);
  await removeDir(sliceDir);
});

test('GATE-08: GATE 进留证文档且可被回放读出', async () => {
  const wikiDir = tempDir('dump');
  const channelId = 'group-gate-dump';
  await removeDir(wikiDir);

  await withJudgeStub(async () => {
    const { system } = makeSystem(wikiDir, [channelId]);
    system.detector.updateOptions(channelId, { dispatchMargin: 1.3 });
    try {
      const session = makeSession(channelId, MARGINAL_PEAK);
      await system.handleQuiescence(session);

      const dir = path.join(wikiDir, '.patchouli', 'discards');
      const files = await listDiscardDumps(dir);
      assert.equal(files.length, 1, '跳过一轮必须留一份证据');

      const dump = await readDiscardDump(files[0]);
      assert.equal(dump.verdict.kind, 'GATE');
      assert.equal(dump.verdict.qualityScore, MARGINAL_PEAK.quality);
      assert.equal(dump.verdict.discardReason, undefined, 'GATE 不是模型判定，不得伪造归因');
      assert.equal(typeof dump.verdict.recordedAt, 'number');
      assert.equal(dump.messageCount, session.messages.length);
      assert.equal(dump.sessionId, session.sessionId);
      assert.equal(dump.messages.length, session.messages.length);
      assert.ok(files[0].includes(session.sessionId), '文件名仍为 <date>-<sessionId>');
    } finally {
      system.dispose();
    }
  });

  await removeDir(wikiDir);
});
