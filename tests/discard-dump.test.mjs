import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  DISCARD_DUMP_LIMIT,
  DISCARD_DUMP_MAX_BYTES,
  DISCARD_MESSAGE_MAX_CHARS,
  PatchouliKnowledgeSystem,
  discardDumpName,
  listDiscardDumps,
  pruneDiscardDumps,
  readDiscardDump,
  resolveWikiLayout,
  saveDiscardDump,
} from '../lib/index.js';

const TMP_ROOT = path.resolve('tmp/discard-dump');

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSession(overrides = {}) {
  return {
    sessionId: 'session-alpha',
    channelId: 'group-1',
    startTime: new Date(2026, 9, 27, 22, 9, 1).getTime(),
    endTime: new Date(2026, 9, 27, 22, 9, 40).getTime(),
    messages: [
      { id: 'm1', channelId: 'group-1', userId: 'u1', userName: '甲', content: '王牌对王牌啊', timestamp: 1 },
      { id: 'm2', channelId: 'group-1', userId: 'u2', userName: '乙', content: '主播咬字不清晰', timestamp: 2 },
    ],
    peakRate: 26,
    triggerReason: '瞬时速率超过门限',
    partial: false,
    ...overrides,
  };
}

test('DISCARD-DUMP-01: 留证文档与 raw/sessions 同构并附带判定依据', async () => {
  const dir = path.join(TMP_ROOT, 'shape', '.patchouli', 'discards');
  await fs.rm(path.join(TMP_ROOT, 'shape'), { recursive: true, force: true });

  const session = makeSession();
  const saved = await saveDiscardDump({
    dir,
    session,
    verdict: { kind: 'MODEL', discardReason: 'LOW_DENSITY', qualityScore: 0.15 },
    now: () => 1793000000000,
  });

  assert.equal(path.basename(saved.path), `${discardDumpName(session, 1793000000000)}.json`);
  assert.ok(path.basename(saved.path).startsWith('2026-10-27-'), '文件名必须以会话起始日期为前缀');
  assert.deepEqual(saved.pruned, []);

  const dump = await readDiscardDump(saved.path);
  assert.equal(dump.version, 1);
  assert.equal(dump.channelId, 'group-1');
  assert.equal(dump.messageCount, 2);
  assert.equal(dump.peakRate, 26);
  assert.equal(dump.messages[1].content, '主播咬字不清晰');
  assert.ok(dump.messages.every((m) => !('raw' in m)), '留证不得写入 Koishi 事件对象');
  assert.equal(dump.verdict.kind, 'MODEL');
  assert.equal(dump.verdict.discardReason, 'LOW_DENSITY');
  assert.equal(dump.verdict.qualityScore, 0.15);
  assert.equal(dump.verdict.recordedAt, 1793000000000);

  await fs.rm(path.join(TMP_ROOT, 'shape'), { recursive: true, force: true });
});

test('DISCARD-DUMP-02: 超出保留上限时按写入时间滚动删除最旧文件', async () => {
  const dir = path.join(TMP_ROOT, 'rotate', 'discards');
  await fs.rm(path.join(TMP_ROOT, 'rotate'), { recursive: true, force: true });

  const written = [];
  for (let i = 0; i < 4; i++) {
    const session = makeSession({ sessionId: `session-${i}` });
    const saved = await saveDiscardDump({
      dir,
      session,
      verdict: { kind: 'FLOOR', minDiscussionMessages: 16 },
      limit: 2,
    });
    written.push(saved.path);
    await sleep(10);
  }

  const remaining = await listDiscardDumps(dir);
  assert.equal(remaining.length, 2, '保留上限必须生效');
  assert.deepEqual(remaining, written.slice(-2), '保留的必须是最新写入的两份');

  await pruneDiscardDumps(dir, { limit: 1 });
  assert.deepEqual(await listDiscardDumps(dir), [written[3]]);
  assert.equal(DISCARD_DUMP_LIMIT, 40, '默认保留上限为 40 份');
  assert.equal(DISCARD_DUMP_MAX_BYTES, 8 * 1024 * 1024, '默认字节预算为 8 MiB');

  await fs.rm(path.join(TMP_ROOT, 'rotate'), { recursive: true, force: true });
});

test('DISCARD-DUMP-03: 目录不存在时读取为空且轮转不抛错', async () => {
  const dir = path.join(TMP_ROOT, 'missing', 'discards');
  await fs.rm(path.join(TMP_ROOT, 'missing'), { recursive: true, force: true });
  assert.deepEqual(await listDiscardDumps(dir), []);
  assert.deepEqual(await pruneDiscardDumps(dir, { limit: 5 }), []);

  const layout = resolveWikiLayout(path.join(TMP_ROOT, 'missing', 'llmwiki'));
  assert.equal(layout.discardsDir, path.join(layout.patchouliDir, 'discards'));
});

function buildConfig(wikiDir, extra = {}) {
  return {
    enabled: true,
    channels: ['group-dump'],
    notifyOnSummarized: false,
    trigger: {
      windowSizeSeconds: 60,
      burstMultiplier: 2.0,
      minBurstRate: 5,
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
    storage: { wikiDir },
    observability: { discardDumps: true },
    ...extra,
  };
}

function decisionResponse(payload) {
  const text = JSON.stringify(payload);
  const body = {
    id: 'resp_discard_dump',
    object: 'response',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 10 },
  };
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** 触发一轮突发并越过平息期，返回本次会话的缓冲条数。 */
async function burstThenQuiesce(system, channelId, count = 10) {
  let now = 1700000000000;
  for (let i = 1; i <= count; i++) {
    now += 3000;
    await system.onIncomingMessage({
      id: `dump-${channelId}-${i}`,
      channelId,
      userId: `user-${i % 2}`,
      userName: i % 2 === 0 ? '甲' : '乙',
      content: `关于节点部署成本的争论观点 ${i}：自建与托管之间的权衡`,
      timestamp: now,
    });
  }
  now += 100_000;
  await system.onIncomingMessage({
    id: `dump-${channelId}-heartbeat`,
    channelId,
    userId: 'user-0',
    userName: '甲',
    content: '差不多可以收尾了',
    timestamp: now,
  });
  await sleep(150);
  return now;
}

test('DISCARD-DUMP-04: 模型判定舍弃时整轮消息留证（kind=MODEL）', async () => {
  const wikiDir = path.join(TMP_ROOT, 'model', 'llmwiki');
  await fs.rm(path.join(TMP_ROOT, 'model'), { recursive: true, force: true });

  const fetchImpl = decisionResponse({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.15 });
  const system = new PatchouliKnowledgeSystem(buildConfig(wikiDir), quietLogger, undefined, { fetch: fetchImpl });
  try {
    await system.ready;
    const channelId = 'group-dump';
    await burstThenQuiesce(system, channelId);

    const dir = resolveWikiLayout(wikiDir).discardsDir;
    const files = await listDiscardDumps(dir);
    assert.equal(files.length, 1, '舍弃轮次必须留证');

    const dump = await readDiscardDump(files[0]);
    assert.equal(dump.verdict.kind, 'MODEL');
    assert.equal(dump.verdict.discardReason, 'LOW_DENSITY');
    assert.equal(dump.verdict.qualityScore, 0.15);
    assert.equal(dump.channelId, channelId);
    assert.equal(dump.messageCount, 10, '留证必须覆盖本轮缓冲的全部消息');
    assert.ok(dump.messages.some((m) => m.content.includes('观点 10')));
    assert.equal(await fs.readdir(path.join(wikiDir, 'wiki', 'debates')).then((f) => f.length), 0, '舍弃不得产出词条');
  } finally {
    system.dispose();
    await fs.rm(path.join(TMP_ROOT, 'model'), { recursive: true, force: true });
  }
});

test('DISCARD-DUMP-05: 缓冲不足丢弃同样留证（kind=FLOOR，含下限口径）', async () => {
  const wikiDir = path.join(TMP_ROOT, 'floor', 'llmwiki');
  await fs.rm(path.join(TMP_ROOT, 'floor'), { recursive: true, force: true });

  // 下限抬到 50：本轮缓冲必然不足，且根本不会调用模型。
  let modelCalls = 0;
  const config = buildConfig(wikiDir);
  config.trigger.minDiscussionMessages = 50;
  const fetchImpl = async () => {
    modelCalls += 1;
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };

  const system = new PatchouliKnowledgeSystem(config, quietLogger, undefined, { fetch: fetchImpl, maxRetries: 0 });
  try {
    await system.ready;
    await burstThenQuiesce(system, 'group-dump');
    assert.equal(modelCalls, 0, '缓冲不足不得调用模型');

    const files = await listDiscardDumps(resolveWikiLayout(wikiDir).discardsDir);
    assert.equal(files.length, 1, '缓冲不足丢弃必须留证');
    const dump = await readDiscardDump(files[0]);
    assert.equal(dump.verdict.kind, 'FLOOR');
    assert.equal(dump.verdict.minDiscussionMessages, 50);
    assert.equal(dump.messageCount, 10);
  } finally {
    system.dispose();
    await fs.rm(path.join(TMP_ROOT, 'floor'), { recursive: true, force: true });
  }
});

test('DISCARD-DUMP-06: 调度失败与「判定为噪声」区分留证（kind=FAILURE，带失败说明）', async () => {
  const wikiDir = path.join(TMP_ROOT, 'failure', 'llmwiki');
  await fs.rm(path.join(TMP_ROOT, 'failure'), { recursive: true, force: true });

  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'upstream down' }),
    text: async () => '{"error":"upstream down"}',
  });

  const system = new PatchouliKnowledgeSystem(buildConfig(wikiDir), quietLogger, undefined, {
    fetch: fetchImpl,
    maxRetries: 0,
  });
  try {
    await system.ready;
    await burstThenQuiesce(system, 'group-dump');

    const files = await listDiscardDumps(resolveWikiLayout(wikiDir).discardsDir);
    assert.equal(files.length, 1, '调度失败必须留证');
    const dump = await readDiscardDump(files[0]);
    assert.equal(dump.verdict.kind, 'FAILURE');
    assert.equal(dump.verdict.discardReason, undefined, '失败不是模型判定，不得伪造归因');
    assert.ok(
      typeof dump.verdict.failureReason === 'string' && dump.verdict.failureReason.length > 0,
      '失败留证必须带人类可读说明',
    );
    assert.equal(dump.messageCount, 10);
  } finally {
    system.dispose();
    await fs.rm(path.join(TMP_ROOT, 'failure'), { recursive: true, force: true });
  }
});

test('DISCARD-DUMP-07: 字节预算优先保留最新证据，且至少保留一份', async () => {
  const dir = path.join(TMP_ROOT, 'bytes', 'discards');
  await fs.rm(path.join(TMP_ROOT, 'bytes'), { recursive: true, force: true });

  const paths = [];
  for (let i = 0; i < 3; i++) {
    const saved = await saveDiscardDump({
      dir,
      session: makeSession({
        sessionId: `bytes-${i}`,
        messages: [
          { id: `b-${i}`, channelId: 'group-1', userId: 'u1', userName: '甲', content: 'z'.repeat(2000), timestamp: i },
        ],
      }),
      verdict: { kind: 'MODEL', discardReason: 'LOW_DENSITY', qualityScore: 0.2 },
      maxMessageChars: 0, // 不截断，让体积可控地变大
      limit: 10,
      maxBytes: 64 * 1024 * 1024,
      now: () => 1793000000000 + i * 1000,
    });
    paths.push(saved.path);
    await sleep(10);
  }

  const sizes = await Promise.all(paths.map(async (p) => (await fs.stat(p)).size));
  assert.ok(sizes.every((size) => size > 2000), '前置条件：每份体积必须由长消息撑起来');

  // 预算恰好只够最新两份
  const pruned = await pruneDiscardDumps(dir, { limit: 40, maxBytes: sizes[1] + sizes[2] });
  assert.deepEqual(pruned, [paths[0]], '最旧的一份必须被预算淘汰');
  assert.deepEqual(await listDiscardDumps(dir), paths.slice(-2));

  // 预算连一份都装不下：仍然保留最新一份，绝不删空
  const prunedAll = await pruneDiscardDumps(dir, { limit: 40, maxBytes: 1 });
  assert.deepEqual(prunedAll, [paths[1]]);
  assert.deepEqual(await listDiscardDumps(dir), [paths[2]], '最新一份禁止被预算删除');

  await fs.rm(path.join(TMP_ROOT, 'bytes'), { recursive: true, force: true });
});

test('DISCARD-DUMP-08: 单条消息按码点截断，短消息不受影响', async () => {
  const dir = path.join(TMP_ROOT, 'clamp', 'discards');
  await fs.rm(path.join(TMP_ROOT, 'clamp'), { recursive: true, force: true });

  const long = '𠮷'.repeat(3000); // 代理对安全：按码点而不是 UTF-16 码元截断
  const saved = await saveDiscardDump({
    dir,
    session: makeSession({
      messages: [
        { id: 'c1', channelId: 'group-1', userId: 'u1', userName: '甲', content: long, timestamp: 1 },
        { id: 'c2', channelId: 'group-1', userId: 'u2', userName: '乙', content: '短句', timestamp: 2 },
      ],
    }),
    verdict: { kind: 'MODEL', discardReason: 'LOW_DENSITY', qualityScore: 0.2 },
  });

  const dump = await readDiscardDump(saved.path);
  const clamped = [...dump.messages[0].content];
  assert.equal(clamped.length, DISCARD_MESSAGE_MAX_CHARS, '长消息必须截到上限长度');
  assert.equal(clamped[clamped.length - 1], '…', '截断必须以省略号收尾');
  assert.ok(clamped.slice(0, -1).every((ch) => ch === '𠮷'), '不得截出半个代理对');
  assert.equal(dump.messages[1].content, '短句', '短消息不得被改写');

  await fs.rm(path.join(TMP_ROOT, 'clamp'), { recursive: true, force: true });
});

test('DISCARD-DUMP-09: 开关关闭时一个字节都不写，也不建目录', async () => {
  const wikiDir = path.join(TMP_ROOT, 'off', 'llmwiki');
  await fs.rm(path.join(TMP_ROOT, 'off'), { recursive: true, force: true });

  const fetchImpl = decisionResponse({ shouldDiscard: true, discardReason: 'LOW_DENSITY', qualityScore: 0.15 });
  const config = buildConfig(wikiDir);
  config.observability = { discardDumps: false };
  const system = new PatchouliKnowledgeSystem(config, quietLogger, undefined, { fetch: fetchImpl });
  try {
    await system.ready;
    await burstThenQuiesce(system, 'group-dump');

    const dir = resolveWikiLayout(wikiDir).discardsDir;
    assert.deepEqual(await listDiscardDumps(dir), [], '关闭时不得留证');
    await assert.rejects(fs.stat(dir), /ENOENT/, '关闭时不得创建留证目录');
  } finally {
    system.dispose();
    await fs.rm(path.join(TMP_ROOT, 'off'), { recursive: true, force: true });
  }
});
