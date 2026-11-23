/**
 * 运行时热更新 / 卸载竞态回归（HOT-01 ~ HOT-04）。
 *
 * 锁死四条契约：
 *  - HOT-01 保存一段无关设置**不得重放**整段落盘的 `trigger`（否则每次保存都把每个群
 *    AIMD 学到的门限按老快照改回去）；真正改 `trigger` 时仍要热更新到所有群。
 *  - HOT-02 旧开关 `albumDelivery.entryEnabled=false` 只在新表**不生效**时起作用；
 *    新表生效时由行（与 `features.entries`）决定，勾了「词条」就必须投。
 *  - HOT-03 `features.topics=false` 时手动校准（`runTopicsDirect`）也早退，一次模型都不调。
 *  - HOT-04 相册探测每个 `await` 之后都重查 `disposed`：卸载后不得写模块级候选 / 解析表。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { PatchouliKnowledgeSystem, formatDate, refreshAlbumCandidates } from '../lib/index.js';

const BASE_TIME = 1_700_000_000_000;
const TMP_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../tmp',
);

async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function tempDir(label) {
  return path.join(TMP_ROOT, `hot-update-${label}-${process.pid}`);
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

function makeConfig(wikiDir, extra = {}) {
  return {
    enabled: true,
    channels: [],
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
    observability: { discardDumps: false },
    judge: { enabled: false, baseURL: 'http://judge.local', apiKey: 'judge-key', model: 'jev-local', timeoutMs: 1000 },
    ...extra,
  };
}

function makeSystem(wikiDir, extra = {}) {
  const logs = [];
  const logger = {
    debug: (m) => logs.push(`DEBUG: ${m}`),
    info: (m) => logs.push(`INFO: ${m}`),
    warn: (m) => logs.push(`WARN: ${m}`),
    error: (m) => logs.push(`ERROR: ${m}`),
  };
  let dispatchCount = 0;
  const fetch = async () => {
    dispatchCount += 1;
    const payload = {
      id: 'resp_hot_update',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(MODEL_BODY) }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 900 },
    };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const system = new PatchouliKnowledgeSystem(makeConfig(wikiDir, extra), logger, undefined, { fetch });
  return { system, logs, dispatchCount: () => dispatchCount };
}

/** 完整一轮讨论（`partial: false`、无峰值观测 → 不触发调度质量门）。 */
function makeSession(channelId) {
  const messages = Array.from({ length: 14 }, (_, i) => ({
    id: `${channelId}-${i + 1}`,
    channelId,
    userId: `user-${i % 4}`,
    userName: `辩友${i % 4}`,
    content: `论点交锋 #${i + 1}：我认为这个取舍取决于写入仲裁成本与副本一致性`,
    timestamp: BASE_TIME + i * 1000,
  }));
  return {
    sessionId: `session-${channelId}`,
    channelId,
    startTime: BASE_TIME,
    endTime: BASE_TIME + 600_000,
    messages,
    peakRate: 12,
    triggerReason: '势能突发',
    partial: false,
  };
}

test('HOT-01: 保存无关设置不重放整段 trigger——逐群 AIMD 值不被落盘快照改回', async () => {
  const wikiDir = tempDir('trigger-replay');
  const channelId = 'group-hot-trigger';
  await removeDir(wikiDir);
  const { system } = makeSystem(wikiDir, { channels: [channelId] });
  try {
    await system.ready;
    // 上一次面板保存把 trigger 段里的 minBurstRate 写进覆盖层（落盘的值是累积的）。
    assert.equal((await system.updateSettings('trigger', { minBurstRate: 6 })).ok, true);
    // AIMD 已把这个群调到更低的门限（逐群运行态，不在覆盖层里）。
    system.detector.updateOptions(channelId, { minBurstRate: 3.5 });
    assert.equal(system.detector.getOptions(channelId).minBurstRate, 3.5);

    // 保存一个无关段：整段重放会把 3.5 改回覆盖层里的 6。
    const saved = await system.updateSettings('query', { cardMaxHeight: 8000 });
    assert.equal(saved.ok, true);
    assert.equal(
      system.detector.getOptions(channelId).minBurstRate,
      3.5,
      '保存 query 不得把 trigger 的落盘值重放到已建状态的群',
    );
    assert.equal(system.detector.getOptions('group-untouched').minBurstRate, 6, '全局默认值仍是上次保存的值');

    // 真正改 trigger：仍然热更新到所有群。
    assert.equal((await system.updateSettings('trigger', { minBurstRate: 5 })).ok, true);
    assert.equal(system.detector.getOptions(channelId).minBurstRate, 5, '变化的键必须落到已建状态的群');
  } finally {
    system.dispose();
    await removeDir(wikiDir);
  }
});

test('HOT-05: potential 模式 AIMD 锚点用运行期覆盖的 thetaMin，不被时间衰减拉回 yml 基线', async () => {
  const wikiDir = tempDir('aimd-anchor');
  await removeDir(wikiDir);
  const channelId = 'group-aimd-anchor';
  const potential = {
    trigger: {
      triggerMode: 'potential',
      windowSizeSeconds: 60,
      burstMultiplier: 2.5,
      minBurstRate: 6,
      quiescenceSeconds: 300,
      coolingRatioThreshold: 1.1,
      minDiscussionMessages: 12,
      maxBufferMessages: 500,
      baselineEwmaAlpha: 0.05,
      thetaMin: 20,
    },
  };

  // ① 造一份「一小时前校准过」的逐群快照：时间向心力衰减到 ≈0.9，锚点开始决定终值。
  const seed = makeSystem(wikiDir, { channels: [channelId], ...potential });
  try {
    await seed.system.ready;
    seed.system.detector.updateOptions(channelId, { thetaMin: 22 });
    await seed.system.localStore.saveCadenceState({
      channelId,
      options: seed.system.detector.getOptions(channelId),
      metrics: seed.system.detector.getStatus(channelId, undefined, { settle: false }),
      updatedAt: Date.now() - 3_600_000,
    });
  } finally {
    seed.system.dispose();
  }

  const { system, logs } = makeSystem(wikiDir, { channels: [channelId], ...potential });
  try {
    await system.ready;
    // 启动期的快照回灌是异步 `void`：等它把该群选项与 AIMD 时间基准落到一小时前。
    for (let i = 0; i < 200 && system.detector.getOptions(channelId).thetaMin !== 22; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(system.detector.getOptions(channelId).thetaMin, 22, '前提：一小时前的快照已回灌');

    // 面板把势能门限改到 28（覆盖层 > yml 的 20）。
    assert.equal((await system.updateSettings('trigger', { thetaMin: 28 })).ok, true);
    assert.equal(system.detector.getOptions(channelId).thetaMin, 28, '前提：覆盖值已热更新到该群');

    // 高质量讨论触发一轮 AIMD：锚点 28 → 28 - 1.0 = 27；
    // 若锚点错用 yml 的 20，一小时衰减（×0.85）会把值拉到 20 + 8×0.85 - 1 = 25.8。
    await system.handleQuiescence(makeSession(channelId));
    assert.equal(system.detector.getOptions(channelId).thetaMin, 27, 'AIMD 必须围绕运行期覆盖值收敛');

    // 衰减必须真的生效（×1 时锚点不参与运算，这条用例就测不到回漂）。
    const aimdLog = logs.find((line) => line.includes('AIMD 调节'));
    assert.ok(aimdLog, '必须产生一轮 AIMD 日志');
    const decay = Number(/时间衰减 ×([0-9.]+)/u.exec(aimdLog)?.[1]);
    assert.ok(decay > 0.8 && decay < 0.95, `时间衰减必须生效，实际 ×${decay}`);
  } finally {
    system.dispose();
    await removeDir(wikiDir);
  }
});

test('HOT-02: 旧 entryEnabled=false 不压制新表；表为空时旧开关仍然有效', async () => {
  const tableDir = tempDir('entry-table');
  const legacyDir = tempDir('entry-legacy');
  const offDir = tempDir('entry-feature-off');
  const channelId = 'group-hot-entry';
  await removeDir(tableDir);
  await removeDir(legacyDir);
  await removeDir(offDir);

  // ① 新表生效（表内 @chat 行）+ 旧开关关闭 → 照常投递。
  const tableSystem = makeSystem(tableDir, {
    albumDelivery: { entryEnabled: false },
    subscriptions: [{ source: channelId, targets: ['@chat'], entry: true, weekly: false }],
  });
  const tableDelivered = [];
  tableSystem.system.setEntryCardSink(async (entryId, sourceChannelId) => {
    tableDelivered.push({ entryId, sourceChannelId });
  });
  try {
    await tableSystem.system.ready;
    assert.equal(tableSystem.system.subscriptions().active, true, '前提：新表生效');
    await tableSystem.system.handleQuiescence(makeSession(channelId));
    assert.equal(tableDelivered.length, 1, '表里勾了「词条」就必须投，旧开关不再压制');
    assert.equal(tableDelivered[0].sourceChannelId, channelId);
    assert.equal(tableSystem.dispatchCount(), 1);
  } finally {
    tableSystem.system.dispose();
    await removeDir(tableDir);
  }

  // ② 表为空（回退旧配置）+ 旧开关关闭 → 不投（旧语义不变）。
  const legacySystem = makeSystem(legacyDir, { albumDelivery: { entryEnabled: false } });
  const legacyDelivered = [];
  legacySystem.system.setEntryCardSink(async (entryId) => {
    legacyDelivered.push(entryId);
  });
  try {
    await legacySystem.system.ready;
    assert.equal(legacySystem.system.subscriptions().active, false, '前提：表为空回退旧配置');
    await legacySystem.system.handleQuiescence(makeSession(channelId));
    assert.deepEqual(legacyDelivered, [], '表不生效时 entryEnabled=false 依旧关掉词条投递');
  } finally {
    legacySystem.system.dispose();
    await removeDir(legacyDir);
  }

  // ③ 功能总闸优先级最高：表生效也一律不投。
  const offSystem = makeSystem(offDir, {
    features: { entries: false },
    subscriptions: [{ source: channelId, targets: ['@chat'], entry: true, weekly: false }],
  });
  const offDelivered = [];
  offSystem.system.setEntryCardSink(async (entryId) => {
    offDelivered.push(entryId);
  });
  try {
    await offSystem.system.ready;
    await offSystem.system.handleQuiescence(makeSession(channelId));
    assert.deepEqual(offDelivered, [], 'features.entries=false 是总闸');
  } finally {
    offSystem.system.dispose();
    await removeDir(offDir);
  }
});

test('HOT-03: features.topics=false 时手动校准也早退，一次模型都不调', async () => {
  const offDir = tempDir('topics-off');
  const onDir = tempDir('topics-on');
  await removeDir(offDir);
  await removeDir(onDir);

  const off = makeSystem(offDir, { features: { topics: false } });
  try {
    await off.system.ready;
    const result = await off.system.runTopicsDirect('group-hot-topics', { now: BASE_TIME });
    assert.equal(result.skippedReason, 'disabled', '关闭时返回既有的 disabled 结果');
    assert.deepEqual(result.createdTopicIds, []);
    assert.deepEqual(result.assignedEntryIds, []);
    assert.equal(result.dayKey, formatDate(new Date(BASE_TIME)));
    assert.equal(off.dispatchCount(), 0, '总闸关闭后不得调用模型');
    assert.deepEqual(off.system.lastTopicRun, result, '状态面同样记录这次 disabled');
  } finally {
    off.system.dispose();
    await removeDir(offDir);
  }

  // 对照组：总闸开着 → 走聚合器（窗口内无词条 = no-entries，不是 disabled）。
  const on = makeSystem(onDir, {});
  try {
    await on.system.ready;
    const ran = await on.system.runTopicsDirect('group-hot-topics', { now: BASE_TIME });
    assert.equal(ran.skippedReason, 'no-entries');
  } finally {
    on.system.dispose();
    await removeDir(onDir);
  }
});

test('HOT-04: 探测每个 await 之后都重查 disposed——卸载后不得安装模块级候选表', async () => {
  const albums = [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' }];

  /** 一组可断言的副作用出口。 */
  function recorder() {
    const calls = { schema: [], installed: [] };
    return {
      calls,
      applySchema: (list) => calls.schema.push(list),
      install: (values, groupIds) => calls.installed.push({ values, groupIds }),
    };
  }

  // ① dispose 发生在探测进行中（OneBot 调用可跨秒，这就是真实时序）。
  {
    const sink = recorder();
    let disposed = false;
    let resolveProbe;
    const pending = refreshAlbumCandidates({
      disposed: () => disposed,
      scope: async () => ({ bots: [], groupIds: ['1'] }),
      probe: () => new Promise((resolve) => {
        resolveProbe = resolve;
      }),
      readCache: async () => [],
      writeCache: async () => true,
      applySchema: sink.applySchema,
      install: sink.install,
      configured: () => [],
      bindings: () => ({}),
      log: () => undefined,
    });
    while (resolveProbe === undefined) await Promise.resolve();
    disposed = true;
    resolveProbe(albums);
    assert.equal(await pending, 'disposed');
    assert.deepEqual(sink.calls.schema, [], '卸载后不得注入控制台候选');
    assert.deepEqual(sink.calls.installed, [], '卸载后不得安装解析 / 展示表');
  }

  // ② dispose 发生在「探测已回、缓存还没读完」之间：写 schema / 写缓存同样要挡住。
  {
    const sink = recorder();
    let disposed = false;
    let resolveCache;
    const pending = refreshAlbumCandidates({
      disposed: () => disposed,
      scope: async () => ({ bots: [], groupIds: ['1'] }),
      probe: async () => albums,
      readCache: () => new Promise((resolve) => {
        resolveCache = resolve;
      }),
      writeCache: async () => true,
      applySchema: sink.applySchema,
      install: sink.install,
      configured: () => [],
      bindings: () => ({}),
      log: () => undefined,
    });
    while (resolveCache === undefined) await Promise.resolve();
    disposed = true;
    resolveCache([]);
    assert.equal(await pending, 'disposed');
    assert.deepEqual(sink.calls.schema, []);
    assert.deepEqual(sink.calls.installed, []);
  }

  // ③ 对照组：同样的时序、不 dispose → 恰好安装一次（守卫不能变成永不执行）。
  {
    const sink = recorder();
    const outcome = await refreshAlbumCandidates({
      disposed: () => false,
      scope: async () => ({ bots: [], groupIds: ['1'] }),
      probe: async () => albums,
      readCache: async () => [],
      writeCache: async () => true,
      applySchema: sink.applySchema,
      install: sink.install,
      configured: () => [],
      bindings: () => ({ 词条: '1/a' }),
      log: () => undefined,
    });
    assert.equal(outcome, 'installed');
    assert.equal(sink.calls.schema.length, 1);
    assert.equal(sink.calls.installed.length, 1);
    assert.deepEqual(sink.calls.installed[0].values.albums, albums);
    assert.deepEqual(sink.calls.installed[0].values.bindings, { 词条: '1/a' });
    assert.deepEqual(sink.calls.installed[0].groupIds, ['1']);
  }
});
