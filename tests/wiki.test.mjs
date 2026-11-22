import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { WikiEngine, LocalStore, formatIndexLine, removeIndexEntry, upsertIndexEntry } from '../lib/index.js';

const TEST_WIKI_DIR = path.resolve('tmp/test-llmwiki');

test('WIKI-01 & STORE-01: llmwiki 文件生成、索引单行维护与本地持久化检索', async () => {
  // 清理测试目录
  await fs.rm(TEST_WIKI_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_WIKI_DIR, { recursive: true });

  const engine = new WikiEngine({ wikiDir: TEST_WIKI_DIR });
  const store = new LocalStore({ wikiDir: TEST_WIKI_DIR });

  const mockEntry1 = {
    id: '2026-10-25-ai-debate',
    title: '大模型思维链与系统二架构之争',
    channelId: 'qq-group-1001',
    date: '2026-10-25',
    status: 'verified',
    tags: ['AI架构', '思维链', 'System2'],
    summary: '群友围绕 OpenAI o1 系列与传统 CoT 的本质差异展开激烈讨论，达成推理时间换准确率的共识。',
    background: '群友转发了关于推理模型的新论文，引发对未来 Agent 底层范式的思考。',
    participants: ['群友A', '群友B', '群友C', 'Yellow D'],
    debateMatrix: [
      {
        viewpoint: '强化学习 Search 是通向通用推理的必经之路',
        proponents: ['群友A', '群友B'],
        opponents: ['Yellow D'],
        arguments: ['测试时计算量扩增能显著打破预训练 Scaling Law 瓶颈'],
        counterArguments: ['纯搜索面临搜索空间爆炸，缺乏真实物理先验支持'],
      },
      {
        viewpoint: '符号逻辑系统与大模型神经系统融合才是终局',
        proponents: ['群友C'],
        opponents: ['群友B'],
        arguments: ['形式验证器能给不确定性神经网络兜底'],
      },
    ],
    consensus: [
      '单纯堆叠预训练语料边际效应递减，推理时计算（Inference-time Compute）成为新杠杆',
    ],
    openQuestions: [
      '如何在端侧小模型上低功耗蒸馏 System2 搜索能力？',
    ],
    keyQuotes: [
      { author: '群友A', quote: '不是模型变聪明了，是它把思考的时间借给你了。' },
      { author: '群友C', quote: '没有形式逻辑约束的概率连想终究是海市蜃楼。' },
    ],
    metadata: {
      messageCount: 38,
      participantCount: 6,
      durationMinutes: 24,
      peakRate: 18.5,
    },
  };

  // 0. 本轮讨论的原始会话（真理源 dump 的输入）
  const session = {
    sessionId: 'sess-ai-debate-0001',
    channelId: 'qq-group-1001',
    startTime: 1792934000000,
    endTime: 1792935440000,
    peakRate: 18.5,
    triggerReason: 'burst-then-quiescence',
    messages: [
      {
        id: 'msg-1',
        channelId: 'qq-group-1001',
        userId: 'u-1',
        userName: '群友A',
        content: '测试时计算量扩增能打破预训练 Scaling Law 瓶颈',
        timestamp: 1792934000000,
        raw: { event: '不可序列化的 Koishi 事件占位' },
      },
      {
        id: 'msg-2',
        channelId: 'qq-group-1001',
        userId: 'u-2',
        userName: 'Yellow D',
        content: '纯搜索面临搜索空间爆炸',
        timestamp: 1792934060000,
      },
      {
        id: 'msg-3',
        channelId: 'qq-group-1001',
        userId: 'u-3',
        userName: '群友C',
        content: '形式验证器能给不确定性神经网络兜底',
        timestamp: 1792934120000,
      },
    ],
  };

  // 1. 验证落盘生成（词条落在 wiki/debates/，原始会话落在 raw/sessions/）
  const writeRes1 = await engine.saveEntry(mockEntry1, { session });
  assert.ok(
    writeRes1.entryPath.endsWith(path.join('wiki', 'debates', '2026-10-25-ai-debate.md')),
    `词条必须落在 <wikiDir>/wiki/debates/ 下，实际: ${writeRes1.entryPath}`,
  );
  assert.ok(
    writeRes1.rawSessionPath.endsWith(path.join('raw', 'sessions', '2026-10-25-ai-debate.json')),
    `原始会话必须落在 <wikiDir>/raw/sessions/ 下，实际: ${writeRes1.rawSessionPath}`,
  );
  assert.equal(writeRes1.rawSessionCreated, true, '首次沉淀必须新建原始会话 dump');
  assert.ok(writeRes1.indexLineInserted);

  // 检查原始会话 dump 结构（真理源：保留消息事实，剥离 Koishi 事件对象）
  const rawDump = JSON.parse(await fs.readFile(writeRes1.rawSessionPath, 'utf8'));
  assert.equal(rawDump.version, 1);
  assert.equal(rawDump.id, '2026-10-25-ai-debate');
  assert.equal(rawDump.sessionId, 'sess-ai-debate-0001');
  assert.equal(rawDump.channelId, 'qq-group-1001');
  assert.equal(rawDump.messageCount, 3);
  assert.equal(rawDump.messages.length, 3);
  assert.equal(rawDump.messages[1].userName, 'Yellow D');
  assert.equal(rawDump.messages[1].content, '纯搜索面临搜索空间爆炸');
  assert.equal('raw' in rawDump.messages[0], false, '原始 dump 不得写入 Koishi 事件对象');

  // 检查 Markdown 内容规范
  const mdContent = await fs.readFile(writeRes1.entryPath, 'utf8');
  assert.ok(mdContent.includes('# 大模型思维链与系统二架构之争'));
  assert.ok(mdContent.includes('Status: verified'));
  assert.ok(mdContent.includes('Tags: [[AI架构]], [[思维链]], [[System2]]'));
  assert.ok(mdContent.includes('Source: raw/sessions/2026-10-25-ai-debate.json'), '头部必须标注真理源相对路径');
  assert.ok(
    mdContent.includes('Participants: [[群友A]], [[群友B]], [[群友C]], [[Yellow D]]'),
    '头部必须渲染完整 Participants 双链名单',
  );
  assert.ok(mdContent.includes('## 摘要'));
  assert.ok(mdContent.includes('## 背景'), '章节名必须与 llmwiki 规范一致（## 背景）');
  assert.ok(!mdContent.includes('## 讨论背景'), '不得保留旧章节名 ## 讨论背景');
  assert.ok(!mdContent.includes('Metrics:'), '头部规模信息改由 store.json / log.md 承载');
  assert.ok(mdContent.includes('## 观点碰撞矩阵'));
  assert.ok(mdContent.includes('### 论据细分'));
  assert.ok(mdContent.includes('## 共识与结论'));
  assert.ok(mdContent.includes('## 未决分歧与开放思考'));
  assert.ok(mdContent.includes('## 原始言论 / 金句采撷'), '章节名必须与 llmwiki 规范一致');
  assert.ok(mdContent.includes('强化学习 Search 是通向通用推理的必经之路'));
  assert.ok(
    mdContent.includes('(质疑者: Yellow D)'),
    '观点碰撞矩阵必须显示反驳方发言人',
  );
  assert.ok(
    mdContent.includes('- **质疑/反驳** (质疑者: Yellow D)：'),
    '细分小节必须标注质疑者',
  );
  assert.ok(mdContent.includes('> **群友A**：不是模型变聪明了，是它把思考的时间借给你了。'));

  // 2. 检查 index.md 单行索引不变量 (LESSONS L-03)
  const indexContent = await fs.readFile(writeRes1.indexPath, 'utf8');
  const indexLines = indexContent.split('\n').filter((l) => l.includes('[[大模型思维链与系统二架构之争]]'));
  assert.equal(indexLines.length, 1, 'index.md 中该词条必须有且仅有唯一一行');
  assert.ok(indexLines[0].startsWith('- [[大模型思维链与系统二架构之争]] - 2026-10-25'));

  // 3. 检查 log.md 流水
  const logContent = await fs.readFile(writeRes1.logPath, 'utf8');
  assert.ok(logContent.includes('[qq-group-1001] 沉淀条目 [[大模型思维链与系统二架构之争]] (共 38 条消息)'));

  // 4. 重复写入同一 ID（更新场景）：断言原地更新、严禁重复行，且真理源不被覆写
  const updatedEntry = {
    ...mockEntry1,
    summary: '群友对 System2 的讨论进一步收敛，补充了端侧蒸馏论述。',
  };
  const sessionWithExtraMessage = {
    ...session,
    messages: [...session.messages, {
      id: 'msg-4',
      channelId: 'qq-group-1001',
      userId: 'u-1',
      userName: '群友A',
      content: '迟到的补充发言',
      timestamp: 1792935440000,
    }],
  };
  const writeRes2 = await engine.saveEntry(updatedEntry, { session: sessionWithExtraMessage });
  assert.equal(writeRes2.indexLineInserted, false, '已存在词条更新时 indexLineInserted 必须为 false');
  assert.equal(writeRes2.rawSessionCreated, false, 'raw/ 是真理源：已存在的会话 dump 绝不覆写');

  const rawDumpAfter = JSON.parse(await fs.readFile(writeRes1.rawSessionPath, 'utf8'));
  assert.equal(rawDumpAfter.messages.length, 3, '重复沉淀不得改写原始会话内容');

  const indexContentAfter = await fs.readFile(writeRes1.indexPath, 'utf8');
  const indexLinesAfter = indexContentAfter.split('\n').filter((l) => l.includes('[[大模型思维链与系统二架构之争]]'));
  assert.equal(indexLinesAfter.length, 1, '原地更新后依然严格保持单行');
  assert.ok(indexLinesAfter[0].includes('补充了端侧蒸馏论述'));

  // 5. 写入 LocalStore 并执行检索测试
  await store.saveEntry(mockEntry1, writeRes1.entryPath);

  // 检索关键词
  const searchHit = await store.searchEntries('思维链', 'qq-group-1001');
  assert.equal(searchHit.length, 1);
  assert.equal(searchHit[0].id, '2026-10-25-ai-debate');

  // 获取最近
  const recents = await store.getRecentEntries('qq-group-1001', 5);
  assert.equal(recents.length, 1);
  assert.equal(recents[0].title, '大模型思维链与系统二架构之争');
  assert.deepEqual(recents[0].participants, ['群友A', '群友B', '群友C', 'Yellow D']);

  // 自适应节奏快照持久化与恢复测试
  await store.saveCadenceState({
    channelId: 'qq-group-1001',
    options: { burstMultiplier: 3.2, quiescenceSeconds: 240 },
    metrics: {
      currentRate: 1.2,
      baselineRate: 2.8,
      baselineDeviation: 0.5,
      burstRatio: 0.43,
      lastMessageTime: Date.now(),
      phase: 'IDLE',
      bufferedCount: 0,
    },
    updatedAt: Date.now(),
  });

  const snapshots = await store.listCadenceStates();
  const groupSnap = snapshots.find((s) => s.channelId === 'qq-group-1001');
  assert.ok(groupSnap);
  assert.equal(groupSnap.options.burstMultiplier, 3.2);
  assert.equal(groupSnap.options.quiescenceSeconds, 240);

  // 清理临时文件
  await fs.rm(TEST_WIKI_DIR, { recursive: true, force: true });
});

test('STORE-02: 首次加载与首次 commit 并发时不得用旧快照覆盖新写入', async () => {
  const dir = path.resolve('tmp/store-race');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const entry = (id, title) => ({
    id,
    title,
    channelId: 'g1',
    date: '2026-01-01',
    status: 'verified',
    tags: [],
    summary: '摘要',
    participants: [],
    metadata: {},
  });

  const bootstrap = new LocalStore({ wikiDir: dir });
  await bootstrap.saveEntry(entry('entry-a', '甲'));

  // 全新实例：snapshot 为空，第一次读盘就是竞态现场。
  const store = new LocalStore({ wikiDir: dir });
  assert.equal(bootstrap.path, store.path);

  // 把第一次读盘做成「内容早已读出、恢复却晚于 commit」：这正是丢写入的时序。
  const original = fs.readFile;
  let captured;
  let release;
  const capturedOnce = new Promise((resolve) => {
    captured = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  fs.readFile = async (...args) => {
    const text = await original(...args);
    if (first) {
      first = false;
      captured();
      await gate;
    }
    return text;
  };

  try {
    const staleRead = store.listEntriesByStatus('verified');
    await capturedOnce;
    // 并发的首次 commit：写入 entry-b 并落盘。
    await store.saveEntry(entry('entry-b', '乙'));
    release();

    const raced = await staleRead;
    assert.deepEqual(
      raced.map((record) => record.id).sort(),
      ['entry-a', 'entry-b'],
      '读路径恢复后不得丢掉 commit 刚写入的词条',
    );
    const recent = await store.getRecentEntries('g1', 10);
    assert.ok(
      recent.some((record) => record.id === 'entry-b'),
      '内存快照不得被读盘拿到的旧内容覆盖',
    );
  } finally {
    fs.readFile = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('STORE-03: 加载时清理崩溃残留的陈旧 .tmp，但不误删新鲜写入', async () => {
  const dir = path.resolve('tmp/store-tmp-sweep');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const store = new LocalStore({ wikiDir: dir });
  const dbDir = path.dirname(store.path);
  await fs.mkdir(dbDir, { recursive: true });
  const base = path.basename(store.path);
  const stale = path.join(dbDir, `${base}.111.1700000000000.tmp`);
  const fresh = path.join(dbDir, `${base}.222.${Date.now()}.tmp`);
  await fs.writeFile(stale, '{"half":', 'utf8');
  await fs.writeFile(fresh, '{"half":', 'utf8');
  const oldSeconds = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  await fs.utimes(stale, oldSeconds, oldSeconds);

  try {
    await store.getRecentEntries('g1');
    const names = await fs.readdir(dbDir);
    assert.ok(!names.includes(path.basename(stale)), '超过 1 小时的孤儿临时文件必须被清掉');
    assert.ok(names.includes(path.basename(fresh)), '新鲜临时文件可能是活跃写入，不得误删');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('INDEX-01: 摘要里引用其它 `[[词条]]` 不得覆盖或删除对方的索引行', () => {
  const base = '# Patchouli Knowledge Index\n\n## 沉淀词条\n\n';
  // 甲词条的摘要在正文里提到了乙词条
  const lineA = formatIndexLine({ title: '甲词条', date: '2026-11-01', summary: '讨论中详见 [[乙词条]] 的结论' });
  const lineB = formatIndexLine({ title: '乙词条', date: '2026-11-02', summary: '缓存淘汰策略的分层设计' });

  const first = upsertIndexEntry(base, lineA, '甲词条', '2026-11-01');
  const second = upsertIndexEntry(first.content, lineB, '乙词条', '2026-11-02');
  assert.ok(second.content.includes('[[甲词条]]'), '甲的索引行必须保留');
  assert.ok(second.content.includes('[[乙词条]]'), '乙的索引行必须写入');

  // 删除甲：乙的行不得被连带删除（旧实现按 includes 匹配，摘要引用会误伤）
  const removed = removeIndexEntry(second.content, '甲词条');
  assert.equal(removed.includes('[[甲词条]]'), false, '甲的行应删除');
  assert.ok(removed.includes('[[乙词条]]'), '乙的行必须保留');
});
