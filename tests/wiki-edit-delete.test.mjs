import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WikiEngine,
  LocalStore,
  PatchouliKnowledgeSystem,
  removeIndexEntry,
  removeLogEntry,
} from '../lib/index.js';

const TEST_ROOT = fileURLToPath(new URL('../tmp/test-wiki-edit-delete', import.meta.url));

const INDEX_SCAFFOLD = '# Patchouli Knowledge Index\n\n## 沉淀词条\n';
const LOG_SCAFFOLD = '# Patchouli Knowledge Log\n';

function makeEntry(overrides = {}) {
  return {
    id: 'entry-a',
    title: '词条甲',
    channelId: 'g-1001',
    date: '2026-10-01',
    status: 'verified',
    tags: ['架构', '讨论'],
    summary: '甲组围绕架构边界达成共识。',
    background: '甲组讨论的触发背景。',
    participants: ['甲', '乙'],
    debateMatrix: [
      {
        viewpoint: '先做模块化单体',
        proponents: ['甲'],
        opponents: ['乙'],
        arguments: ['降低分布式事务成本'],
        counterArguments: ['团队扩张后合并冲突增加'],
      },
    ],
    consensus: ['两披萨团队规模前优先模块化单体'],
    openQuestions: ['服务边界如何量化？'],
    keyQuotes: [{ author: '甲', quote: '先别拆，先量。' }],
    metadata: { messageCount: 12, participantCount: 2, durationMinutes: 8, peakRate: 6.5 },
    ...overrides,
  };
}

function makeSession(sessionId, channelId = 'g-1001') {
  return {
    sessionId,
    channelId,
    startTime: 1790000000000,
    endTime: 1790000060000,
    peakRate: 6.5,
    triggerReason: 'burst-then-quiescence',
    messages: [
      {
        id: `${sessionId}-m1`,
        channelId,
        userId: 'u-1',
        userName: '甲',
        content: '先把边界量清楚。',
        timestamp: 1790000000000,
      },
    ],
  };
}

function makeCadence(channelId = 'g-1001') {
  return {
    channelId,
    options: { burstMultiplier: 2.6, minBurstRate: 5, quiescenceSeconds: 240 },
    metrics: {
      currentRate: 0.5,
      baselineRate: 2.4,
      baselineDeviation: 0.6,
      burstRatio: 0.2,
      lastMessageTime: 1790000000000,
      phase: 'IDLE',
      bufferedCount: 0,
    },
    updatedAt: 1790000000000,
  };
}

async function freshDir(name) {
  const dir = path.join(TEST_ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function countLines(text, needle) {
  return text.split('\n').filter((line) => line.includes(needle)).length;
}

/* ------------------------------------------------------------------ *
 * 纯函数：索引 / 流水托管行删除
 * ------------------------------------------------------------------ */

test('WIKI-EDIT-01: removeIndexEntry 删除全部同标题托管行并保留脚手架与用户分区', () => {
  const indexText = [
    '# Patchouli Knowledge Index',
    '',
    '## 沉淀词条',
    '',
    '- [[词条甲]] - 2026-10-03 甲最新摘要',
    '- [[词条乙]] - 2026-09-30 乙摘要',
    '- [[词条甲]] - 2026-08-01 历史重复行',
    '',
    '## 用户自留',
    '',
    '手写说明必须保留',
    '',
  ].join('\n');

  const cleaned = removeIndexEntry(indexText, '  词条甲  ');

  assert.equal(countLines(cleaned, '[[词条甲]]'), 0, '同标题的托管行必须全部删除');
  assert.equal(countLines(cleaned, '[[词条乙]]'), 1, '其他词条行不得被误删');
  assert.ok(cleaned.includes('## 用户自留'), '用户分区必须保留');
  assert.ok(cleaned.includes('手写说明必须保留'), '用户内容必须保留');
  assert.ok(cleaned.startsWith('# Patchouli Knowledge Index'), '索引标题脚手架必须保留');
  assert.ok(cleaned.includes('## 沉淀词条'), '沉淀词条分区必须保留');
  assert.ok(cleaned.endsWith('\n'), '索引文本必须以单个换行收尾');

  // 标题不存在时仅做规范化，不动任何行
  const untouched = removeIndexEntry(indexText, '不存在的词条');
  assert.ok(untouched.includes('[[词条甲]]'));
  assert.ok(untouched.includes('[[词条乙]]'));

  // 空文本也必须产出完整脚手架
  assert.equal(removeIndexEntry('', '任意标题'), INDEX_SCAFFOLD);
  // 空标题不得误删任意托管行
  assert.ok(removeIndexEntry(indexText, '   ').includes('[[词条甲]]'));

  // 实例门面与模块级纯函数等价
  const engine = new WikiEngine({ wikiDir: path.join(TEST_ROOT, 'facade-unused') });
  assert.equal(engine.removeIndexEntry(indexText, '词条甲'), cleaned);
});

test('WIKI-EDIT-02: removeLogEntry 删除全部同标题流水行并保留标题脚手架', () => {
  const logText = [
    '# Patchouli Knowledge Log',
    '',
    '- 2026-10-03 10:00 [g-1] 沉淀条目 [[词条甲]] (共 12 条消息)',
    '- 2026-09-30 09:00 [g-1] 沉淀条目 [[词条乙]] (共 8 条消息)',
    '- 2026-08-01 08:00 [g-1] 沉淀条目 [[词条甲]] (共 3 条消息)',
    '',
  ].join('\n');

  const cleaned = removeLogEntry(logText, '词条甲');

  assert.equal(countLines(cleaned, '[[词条甲]]'), 0);
  assert.equal(countLines(cleaned, '[[词条乙]]'), 1);
  assert.ok(cleaned.startsWith('# Patchouli Knowledge Log'));
  assert.ok(cleaned.includes('沉淀条目 [[词条乙]]'));
  assert.equal(removeLogEntry('', '任意标题'), LOG_SCAFFOLD);

  const engine = new WikiEngine({ wikiDir: path.join(TEST_ROOT, 'facade-unused-log') });
  assert.equal(engine.removeLogEntry(logText, '词条甲'), cleaned);
});

/* ------------------------------------------------------------------ *
 * WikiEngine.deleteEntry
 * ------------------------------------------------------------------ */

test('WIKI-DELETE-01: deleteEntry 精确删除单个词条的文件/原始 dump/索引/流水，且幂等', async () => {
  const dir = await freshDir('delete-single');
  const engine = new WikiEngine({ wikiDir: dir });

  const entryA = makeEntry({ id: 'entry-a', title: '词条甲', date: '2026-10-01' });
  const entryB = makeEntry({ id: 'entry-b', title: '词条乙', date: '2026-09-30' });
  const savedA = await engine.saveEntry(entryA, { session: makeSession('sess-a') });
  const savedB = await engine.saveEntry(entryB, { session: makeSession('sess-b') });

  assert.ok(await fs.stat(savedA.entryPath));
  assert.ok(await fs.stat(savedB.entryPath));

  const result = await engine.deleteEntry('entry-a', '词条甲');
  assert.deepEqual(result, { ok: true, deletedFile: true, deletedRaw: true });

  // 目标产物必须消失
  await assert.rejects(fs.access(savedA.entryPath), /ENOENT/);
  await assert.rejects(fs.access(savedA.rawSessionPath), /ENOENT/);

  // 另一个词条必须原样保留
  assert.ok((await fs.readFile(savedB.entryPath, 'utf8')).includes('# 词条乙'));
  assert.ok(await fs.stat(savedB.rawSessionPath));

  const index = await fs.readFile(savedA.indexPath, 'utf8');
  const log = await fs.readFile(savedA.logPath, 'utf8');
  assert.equal(countLines(index, '[[词条甲]]'), 0, '索引中该词条的行必须删除');
  assert.equal(countLines(index, '[[词条乙]]'), 1, '索引中其他词条必须保留');
  assert.ok(index.includes('## 沉淀词条'), '删除后索引脚手架必须保留');
  assert.equal(countLines(log, '[[词条甲]]'), 0, '流水中该词条的行必须删除');
  assert.equal(countLines(log, '[[词条乙]]'), 1, '流水中其他词条必须保留');
  assert.ok(log.startsWith('# Patchouli Knowledge Log'));

  // 重复删除：幂等返回 false，且不再写盘
  const indexBefore = await readOrNull(savedA.indexPath);
  const repeat = await engine.deleteEntry('entry-a', '词条甲');
  assert.deepEqual(repeat, { ok: false, deletedFile: false, deletedRaw: false });
  assert.equal(await readOrNull(savedA.indexPath), indexBefore, '无匹配行时不得改写索引');
});

test('WIKI-DELETE-02: deleteEntry 省略 title 时从词条 H1 反推标题', async () => {
  const dir = await freshDir('delete-infer-title');
  const engine = new WikiEngine({ wikiDir: dir });

  const entry = makeEntry({ id: 'entry-infer', title: '可反推的标题', date: '2026-10-02' });
  const saved = await engine.saveEntry(entry, { session: makeSession('sess-infer') });

  const result = await engine.deleteEntry('entry-infer');
  assert.equal(result.ok, true);
  assert.equal(result.deletedFile, true);
  assert.equal(result.deletedRaw, true);

  const index = await fs.readFile(saved.indexPath, 'utf8');
  const log = await fs.readFile(saved.logPath, 'utf8');
  assert.equal(countLines(index, '[[可反推的标题]]'), 0, '必须按 H1 标题清理索引行');
  assert.equal(countLines(log, '[[可反推的标题]]'), 0, '必须按 H1 标题清理流水行');
});

test('WIKI-DELETE-03: 删除不存在的词条不创建 index.md / log.md / 目录', async () => {
  const dir = path.join(TEST_ROOT, 'delete-ghost');
  await fs.rm(dir, { recursive: true, force: true });

  const engine = new WikiEngine({ wikiDir: dir });
  const result = await engine.deleteEntry('ghost');

  assert.deepEqual(result, { ok: false, deletedFile: false, deletedRaw: false });
  await assert.rejects(fs.access(path.join(dir, 'index.md')), /ENOENT/);
  await assert.rejects(fs.access(path.join(dir, 'log.md')), /ENOENT/);
  await assert.rejects(fs.access(path.join(dir, 'wiki', 'debates')), /ENOENT/);
  await assert.rejects(fs.access(path.join(dir, 'raw', 'sessions')), /ENOENT/);
});

test('WIKI-DELETE-04: 并发删除与写入走同一串行队列，索引不丢更新', async () => {
  const dir = await freshDir('delete-concurrent');
  const engine = new WikiEngine({ wikiDir: dir });

  const entries = [
    makeEntry({ id: 'entry-a', title: '并发甲', date: '2026-10-01' }),
    makeEntry({ id: 'entry-b', title: '并发乙', date: '2026-10-02' }),
    makeEntry({ id: 'entry-c', title: '并发丙', date: '2026-10-03' }),
  ];
  let index = '';
  for (const entry of entries) {
    const saved = await engine.saveEntry(entry, { session: makeSession(`sess-${entry.id}`) });
    index = saved.indexPath;
  }

  const entryD = makeEntry({ id: 'entry-d', title: '并发丁', date: '2026-10-04' });
  const [deleteA, deleteB, saveD] = await Promise.all([
    engine.deleteEntry('entry-a', '并发甲'),
    engine.deleteEntry('entry-b', '并发乙'),
    engine.saveEntry(entryD, { session: makeSession('sess-d') }),
  ]);

  assert.equal(deleteA.ok, true);
  assert.equal(deleteB.ok, true);
  assert.equal(saveD.indexLineInserted, true);

  const indexContent = await fs.readFile(index, 'utf8');
  assert.equal(countLines(indexContent, '[[并发甲]]'), 0);
  assert.equal(countLines(indexContent, '[[并发乙]]'), 0);
  assert.equal(countLines(indexContent, '[[并发丙]]'), 1);
  assert.equal(countLines(indexContent, '[[并发丁]]'), 1);

  // 同一 id 并发删除：串行队列保证只有一次真正删除
  const [first, second] = await Promise.all([
    engine.deleteEntry('entry-c', '并发丙'),
    engine.deleteEntry('entry-c', '并发丙'),
  ]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1, '并发重复删除只允许一次成功');

  // 类型守卫
  await assert.rejects(() => engine.deleteEntry(''), TypeError);
  await assert.rejects(() => engine.deleteEntry('entry-d', 42), TypeError);
});

test('WIKI-DELETE-05: 标题漂移时同时清理新旧标题的索引 / 流水行', async () => {
  const dir = await freshDir('delete-title-drift');
  const engine = new WikiEngine({ wikiDir: dir });

  const entry = makeEntry({ id: 'entry-drift', title: '旧标题', date: '2026-10-01' });
  const saved = await engine.saveEntry(entry);
  const markdown = await engine.readEntry('entry-drift');
  assert.equal(typeof markdown, 'string');

  // 模拟 Web API「只改标题」路径：正文 H1 保持旧标题，仅索引换成新标题
  await engine.updateEntryMarkdown('entry-drift', markdown, { title: '新标题' });
  const driftedIndex = await fs.readFile(saved.indexPath, 'utf8');
  const driftedLog = await fs.readFile(saved.logPath, 'utf8');
  assert.equal(countLines(driftedIndex, '[[旧标题]]'), 0);
  assert.equal(countLines(driftedIndex, '[[新标题]]'), 1);
  assert.equal(countLines(driftedLog, '[[旧标题]]'), 1, '更新路径只维护索引，流水仍是旧标题');

  // 连续第二次改名：正文 H1 仍是旧标题，索引已漂移到「新标题」；引擎须记住进程内最近标题
  await engine.updateEntryMarkdown('entry-drift', markdown, { title: '新标题二号' });
  const renamedAgain = await fs.readFile(saved.indexPath, 'utf8');
  assert.equal(countLines(renamedAgain, '[[新标题]]'), 0, '连续改名不得残留上一次的索引行');
  assert.equal(countLines(renamedAgain, '[[新标题二号]]'), 1);

  const result = await engine.deleteEntry('entry-drift', '新标题二号');
  assert.equal(result.ok, true);
  assert.equal(result.deletedFile, true);

  const index = await fs.readFile(saved.indexPath, 'utf8');
  const log = await fs.readFile(saved.logPath, 'utf8');
  assert.equal(countLines(index, '[[新标题二号]]'), 0);
  assert.equal(countLines(index, '[[新标题]]'), 0);
  assert.equal(countLines(index, '[[旧标题]]'), 0);
  assert.equal(countLines(log, '[[旧标题]]'), 0, '正文 H1 的旧标题流水行必须一并清除');
});

/* ------------------------------------------------------------------ *
 * WikiEngine.clearAllEntries
 * ------------------------------------------------------------------ */

test('WIKI-CLEAR-01: clearAllEntries 清空词条与 raw，重置索引/流水，保留目录与非托管文件', async () => {
  const dir = await freshDir('clear-all');
  const engine = new WikiEngine({ wikiDir: dir });

  const entryA = makeEntry({ id: 'entry-a', title: '清空甲', date: '2026-10-01' });
  const entryB = makeEntry({ id: 'entry-b', title: '清空乙', date: '2026-10-02' });
  const savedA = await engine.saveEntry(entryA, { session: makeSession('sess-a') });
  await engine.saveEntry(entryB, { session: makeSession('sess-b') });

  // 非托管文件：必须原样保留
  const keepTxt = path.join(savedA.entryPath, '..', 'notes.txt');
  const keepRaw = path.join(savedA.rawSessionPath, '..', 'keep.txt');
  const nestedDir = path.join(savedA.entryPath, '..', 'nested');
  const nestedMd = path.join(nestedDir, 'inner.md');
  const patchouliMarker = path.join(dir, '.patchouli', 'marker.json');
  await fs.writeFile(keepTxt, 'keep me', 'utf8');
  await fs.writeFile(keepRaw, 'keep me too', 'utf8');
  await fs.mkdir(nestedDir, { recursive: true });
  await fs.writeFile(nestedMd, '# nested', 'utf8');
  await fs.mkdir(path.dirname(patchouliMarker), { recursive: true });
  await fs.writeFile(patchouliMarker, '{"kept":true}', 'utf8');

  const result = await engine.clearAllEntries();
  assert.deepEqual(result, { clearedDebatesCount: 2, clearedRawsCount: 2 });

  const debates = await fs.readdir(path.join(dir, 'wiki', 'debates'));
  const raws = await fs.readdir(path.join(dir, 'raw', 'sessions'));
  assert.deepEqual(debates.sort(), ['nested', 'notes.txt'], '仅删除 .md 直接文件，目录与非 md 文件保留');
  assert.deepEqual(raws.sort(), ['keep.txt'], '仅删除 .json 直接文件');
  assert.ok(await fs.stat(nestedMd), '不递归删除子目录内容');
  assert.ok(await fs.stat(patchouliMarker), '.patchouli 仓储不得被清理');
  assert.ok((await fs.stat(path.join(dir, 'wiki', 'debates'))).isDirectory());
  assert.ok((await fs.stat(path.join(dir, 'raw', 'sessions'))).isDirectory());

  assert.equal(await fs.readFile(path.join(dir, 'index.md'), 'utf8'), INDEX_SCAFFOLD);
  assert.equal(await fs.readFile(path.join(dir, 'log.md'), 'utf8'), LOG_SCAFFOLD);

  // 幂等：再次清空计数为 0，脚手架保持不变
  const again = await engine.clearAllEntries();
  assert.deepEqual(again, { clearedDebatesCount: 0, clearedRawsCount: 0 });
  assert.equal(await fs.readFile(path.join(dir, 'index.md'), 'utf8'), INDEX_SCAFFOLD);
  assert.equal(await fs.readFile(path.join(dir, 'log.md'), 'utf8'), LOG_SCAFFOLD);
});

test('WIKI-CLEAR-02: 空目录 clearAllEntries 会建全骨架并返回 0', async () => {
  const dir = path.join(TEST_ROOT, 'clear-fresh');
  await fs.rm(dir, { recursive: true, force: true });

  const engine = new WikiEngine({ wikiDir: dir });
  const result = await engine.clearAllEntries();

  assert.deepEqual(result, { clearedDebatesCount: 0, clearedRawsCount: 0 });
  for (const sub of ['wiki/debates', 'raw/sessions']) {
    assert.ok((await fs.stat(path.join(dir, sub))).isDirectory(), `${sub} 目录必须存在`);
  }
  assert.equal(await fs.readFile(path.join(dir, 'index.md'), 'utf8'), INDEX_SCAFFOLD);
  assert.equal(await fs.readFile(path.join(dir, 'log.md'), 'utf8'), LOG_SCAFFOLD);
});

/* ------------------------------------------------------------------ *
 * WikiEngine.updateEntryMarkdown
 * ------------------------------------------------------------------ */

test('WIKI-UPDATE-01: updateEntryMarkdown 写正文并按元数据同步索引（含标题迁移）', async () => {
  const dir = await freshDir('update-markdown');
  const engine = new WikiEngine({ wikiDir: dir });

  const entry = makeEntry({ id: 'entry-a', title: '原始标题', date: '2026-10-01', summary: '原始摘要' });
  const saved = await engine.saveEntry(entry);
  assert.equal(countLines(await fs.readFile(saved.indexPath, 'utf8'), '[[原始标题]]'), 1);

  const rewritten = [
    '# 更新后的标题',
    '',
    'Status: open',
    'Date: 2026-10-05',
    'Tags: [[更新]]',
    'Channel: g-1001',
    'Source: raw/sessions/entry-a.json',
    'Participants: [[甲]]',
    '',
    '## 摘要',
    '',
    '正文里的新摘要',
    '',
    '## 背景',
    '',
    '正文背景',
    '',
  ].join('\n');

  // 只给 summary：title / date 必须从正文反推，且旧标题行被迁移
  await engine.updateEntryMarkdown('entry-a', rewritten, { summary: '外部覆盖摘要' });

  assert.equal(await fs.readFile(saved.entryPath, 'utf8'), rewritten, '正文必须原样落盘（保留换行）');
  const index = await fs.readFile(saved.indexPath, 'utf8');
  assert.equal(countLines(index, '[[原始标题]]'), 0, '旧标题索引行必须清除');
  assert.equal(countLines(index, '[[更新后的标题]]'), 1, '新标题索引行必须唯一');
  assert.ok(
    index.includes('- [[更新后的标题]] - 2026-10-05 外部覆盖摘要'),
    `索引行必须采用显式 summary 与正文 Date，实际索引：\n${index}`,
  );

  // 不提供 metadata 时只写正文，索引/流水不变
  const indexBefore = await fs.readFile(saved.indexPath, 'utf8');
  const logBefore = await readOrNull(saved.logPath);
  await engine.updateEntryMarkdown('entry-a', rewritten.replace('正文背景', '改动后的背景'));
  assert.ok((await fs.readFile(saved.entryPath, 'utf8')).includes('改动后的背景'));
  assert.equal(await fs.readFile(saved.indexPath, 'utf8'), indexBefore, '无 metadata 不得触碰索引');
  assert.equal(await readOrNull(saved.logPath), logBefore, '无 metadata 不得触碰流水');

  // 新 id：给出完整元数据 → 新增索引行，并按日期倒序排列
  const freshMarkdown = ['# 新建条目', '', 'Date: 2026-10-03', '', '## 摘要', '', '新摘要正文', ''].join('\n');
  await engine.updateEntryMarkdown('entry-b', freshMarkdown, {
    title: '新建条目',
    summary: '新摘要',
    date: '2026-10-03',
  });
  const updatedIndex = await fs.readFile(saved.indexPath, 'utf8');
  assert.equal(countLines(updatedIndex, '[[新建条目]]'), 1);
  assert.ok(updatedIndex.includes('- [[新建条目]] - 2026-10-03 新摘要'));
  assert.ok(
    updatedIndex.indexOf('[[更新后的标题]]') < updatedIndex.indexOf('[[新建条目]]'),
    '日期倒序不变量：2026-10-05 必须排在 2026-10-03 之前',
  );

  // 参数守卫
  await assert.rejects(() => engine.updateEntryMarkdown('', rewritten), TypeError);
  await assert.rejects(() => engine.updateEntryMarkdown('entry-a', 42), TypeError);
  await assert.rejects(
    () => engine.updateEntryMarkdown('entry-a', rewritten, { date: '2026/10/05' }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => engine.updateEntryMarkdown('entry-a', rewritten, { title: '   ' }),
    TypeError,
  );
  await assert.rejects(
    () => engine.updateEntryMarkdown('entry-a', rewritten, { summary: 1 }),
    TypeError,
  );
});

/* ------------------------------------------------------------------ *
 * LocalStore.deleteEntry
 * ------------------------------------------------------------------ */

test('STORE-DELETE-01: deleteEntry 删除单条元数据并持久化，保留 cadence 与其他词条', async () => {
  const dir = await freshDir('store-delete');
  const store = new LocalStore({ wikiDir: dir }, { now: () => 1000 });

  await store.saveEntry(makeEntry({ id: 'store-a', title: '仓储甲' }), 'wiki/debates/store-a.md');
  await store.saveEntry(makeEntry({ id: 'store-b', title: '仓储乙' }), 'wiki/debates/store-b.md');
  await store.saveCadenceState(makeCadence());

  assert.equal(await store.deleteEntry('store-a'), true);
  assert.equal(await store.getEntry('store-a'), undefined);
  assert.ok(await store.getEntry('store-b'));

  // 落盘校验：重开实例仍读到删除结果
  const reopened = new LocalStore({ wikiDir: dir });
  assert.equal(await reopened.getEntry('store-a'), undefined);
  assert.equal((await reopened.getEntry('store-b')).title, '仓储乙');
  assert.equal((await reopened.listCadenceStates()).length, 1, '删除词条不得丢失节奏快照');

  const document = JSON.parse(await fs.readFile(store.path, 'utf8'));
  assert.deepEqual(Object.keys(document.entries).sort(), ['store-b']);
  assert.ok(document.cadence['g-1001']);

  // 键不存在：false 且不写盘
  const mtimeBefore = (await fs.stat(store.path)).mtimeMs;
  assert.equal(await store.deleteEntry('store-a'), false);
  assert.equal((await fs.stat(store.path)).mtimeMs, mtimeBefore, '不存在的键不得触发写盘');

  await assert.rejects(() => store.deleteEntry(''), TypeError);
  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * LocalStore.updateEntry
 * ------------------------------------------------------------------ */

test('STORE-UPDATE-01: updateEntry 局部更新字段、刷新 updatedAt 并原子持久化', async () => {
  const dir = await freshDir('store-update');
  let clock = 1000;
  const store = new LocalStore({ wikiDir: dir }, { now: () => clock });

  const created = await store.saveEntry(makeEntry({ id: 'store-a', title: '原题' }), 'wiki/debates/store-a.md');
  assert.equal(created.createdAt, 1000);
  assert.equal(created.updatedAt, 1000);
  assert.equal(created.path, 'wiki/debates/store-a.md');

  clock = 5000;
  const updated = await store.updateEntry('store-a', {
    title: '改后标题',
    summary: '改后摘要',
    status: 'open',
    tags: ['新标签'],
    participants: ['丙', '丁'],
  });

  assert.equal(updated.id, 'store-a');
  assert.equal(updated.title, '改后标题');
  assert.equal(updated.summary, '改后摘要');
  assert.equal(updated.status, 'open');
  assert.deepEqual(updated.tags, ['新标签']);
  assert.deepEqual(updated.participants, ['丙', '丁']);
  assert.equal(updated.channelId, 'g-1001', '未给出的字段必须保持原值');
  assert.equal(updated.date, '2026-10-01');
  assert.deepEqual(updated.metadata, makeEntry().metadata);
  assert.equal(updated.path, 'wiki/debates/store-a.md', 'path 必须保留');
  assert.equal(updated.createdAt, 1000, 'createdAt 必须保留');
  assert.equal(updated.updatedAt, 5000, 'updatedAt 必须刷新');

  // 返回值是深拷贝：外部修改不污染仓储
  updated.tags.push('外部污染');
  updated.participants.push('外部污染');
  const reread = await store.getEntry('store-a');
  assert.deepEqual(reread.tags, ['新标签']);
  assert.deepEqual(reread.participants, ['丙', '丁']);

  // 局部补丁：未给出的字段保持现状
  clock = 9000;
  const patched = await store.updateEntry('store-a', { summary: '仅改摘要' });
  assert.equal(patched.title, '改后标题');
  assert.equal(patched.status, 'open');
  assert.deepEqual(patched.tags, ['新标签']);
  assert.equal(patched.updatedAt, 9000);

  // 重开实例校验磁盘
  const reopened = new LocalStore({ wikiDir: dir });
  const persisted = await reopened.getEntry('store-a');
  assert.equal(persisted.title, '改后标题');
  assert.equal(persisted.summary, '仅改摘要');
  assert.equal(persisted.updatedAt, 9000);

  const document = JSON.parse(await fs.readFile(store.path, 'utf8'));
  assert.equal(document.entries['store-a'].title, '改后标题');
  assert.equal(document.entries['store-a'].updatedAt, 9000);

  // 参数与存在性守卫
  await assert.rejects(() => store.updateEntry('', {}), TypeError);
  await assert.rejects(() => store.updateEntry('store-missing', {}), /不存在/);
  await assert.rejects(() => store.updateEntry('store-a', { title: '   ' }), TypeError);
  await assert.rejects(() => store.updateEntry('store-a', { status: 'bogus' }), TypeError);
  await assert.rejects(() => store.updateEntry('store-a', { tags: 'not-array' }), TypeError);
  await assert.rejects(() => store.updateEntry('store-a', { participants: [1] }), TypeError);
  await assert.rejects(() => store.updateEntry('store-a', { summary: 1 }), TypeError);

  await fs.rm(dir, { recursive: true, force: true });
});

test('STORE-UPDATE-02: 并发 update / delete 在串行队列内不互相覆盖', async () => {
  const dir = await freshDir('store-concurrent');
  const store = new LocalStore({ wikiDir: dir }, { now: () => 2000 });

  await store.saveEntry(makeEntry({ id: 'store-a', title: '并发甲' }));
  await store.saveEntry(makeEntry({ id: 'store-b', title: '并发乙' }));
  await store.saveCadenceState(makeCadence());

  const [updated, deleted] = await Promise.all([
    store.updateEntry('store-a', { summary: '并发更新' }),
    store.deleteEntry('store-b'),
  ]);

  assert.equal(updated.summary, '并发更新');
  assert.equal(deleted, true);

  const reopened = new LocalStore({ wikiDir: dir });
  assert.equal((await reopened.getEntry('store-a')).summary, '并发更新');
  assert.equal(await reopened.getEntry('store-b'), undefined);
  assert.equal((await reopened.listCadenceStates()).length, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * LocalStore.clearEntries
 * ------------------------------------------------------------------ */

test('STORE-CLEAR-01: clearEntries 清空词条但完整保留 cadence 调优参数', async () => {
  const dir = await freshDir('store-clear');
  const store = new LocalStore({ wikiDir: dir });

  await store.saveEntry(makeEntry({ id: 'store-a' }), 'wiki/debates/store-a.md');
  await store.saveEntry(makeEntry({ id: 'store-b', channelId: 'g-2002' }));
  const cadence = makeCadence();
  await store.saveCadenceState(cadence);
  await store.saveCadenceState(makeCadence('g-2002'));

  await store.clearEntries();

  assert.deepEqual(await store.queryEntries(), []);
  assert.deepEqual(await store.getRecentEntries(undefined, 50), []);
  assert.deepEqual(await store.listChannels(), []);
  assert.equal(await store.getEntry('store-a'), undefined);

  const snapshots = await store.listCadenceStates();
  assert.equal(snapshots.length, 2, 'cadence 必须原样保留');
  const kept = snapshots.find((item) => item.channelId === 'g-1001');
  assert.deepEqual(kept.options, cadence.options);
  assert.deepEqual(kept.metrics, cadence.metrics);
  assert.equal(kept.updatedAt, cadence.updatedAt);

  const document = JSON.parse(await fs.readFile(store.path, 'utf8'));
  assert.deepEqual(document.entries, {});
  assert.ok(document.cadence['g-1001']);
  assert.ok(document.cadence['g-2002']);

  // 重开实例同样保持空词条 + cadence
  const reopened = new LocalStore({ wikiDir: dir });
  assert.deepEqual(await reopened.queryEntries(), []);
  assert.equal((await reopened.listCadenceStates()).length, 2);

  // 幂等
  await store.clearEntries();
  assert.deepEqual(await store.queryEntries(), []);
  assert.equal((await store.listCadenceStates()).length, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * PatchouliKnowledgeSystem 门面
 * ------------------------------------------------------------------ */

function makePluginConfig(wikiDir) {
  return {
    enabled: false,
    channels: [],
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
      provider: 'standalone',
      apiKey: 'test-key',
      baseURL: 'https://mock.invalid/v1',
      model: 'test-model',
    },
    storage: { wikiDir },
  };
}

test('SYSTEM-DELETE-01: PatchouliKnowledgeSystem.deleteEntry / clearKnowledgeBase 编排全链路', async () => {
  const dir = await freshDir('system-delete');
  const system = new PatchouliKnowledgeSystem(makePluginConfig(dir));

  try {
    const entryA = makeEntry({ id: 'entry-a', title: '系统甲', date: '2026-10-01' });
    const entryB = makeEntry({ id: 'entry-b', title: '系统乙', date: '2026-10-02' });
    const savedA = await system.wikiEngine.saveEntry(entryA, { session: makeSession('sess-a') });
    const savedB = await system.wikiEngine.saveEntry(entryB, { session: makeSession('sess-b') });
    await system.localStore.saveEntry(entryA, savedA.entryPath);
    await system.localStore.saveEntry(entryB, savedB.entryPath);
    await system.localStore.saveCadenceState(makeCadence());

    assert.equal(await system.deleteEntry('entry-a'), true);
    assert.equal(await system.wikiEngine.readEntry('entry-a'), undefined);
    assert.equal(await system.wikiEngine.readSessionDump('entry-a'), undefined);
    assert.equal(await system.localStore.getEntry('entry-a'), undefined);
    assert.ok(await system.localStore.getEntry('entry-b'), '其他词条元数据不得被删除');
    assert.equal((await system.localStore.listCadenceStates()).length, 1, 'cadence 不得被删除');

    const index = await fs.readFile(savedA.indexPath, 'utf8');
    assert.equal(countLines(index, '[[系统甲]]'), 0);
    assert.equal(countLines(index, '[[系统乙]]'), 1);

    assert.equal(await system.deleteEntry('entry-a'), false, '重复删除必须幂等');
    await assert.rejects(() => system.deleteEntry(''), TypeError);

    // 清空：产物与元数据全空，脚手架重置，cadence 保留
    await system.clearKnowledgeBase();
    assert.deepEqual(await system.localStore.queryEntries(), []);
    assert.equal(await system.wikiEngine.readEntry('entry-b'), undefined);
    assert.equal(await system.wikiEngine.readSessionDump('entry-b'), undefined);
    assert.equal(await fs.readFile(savedA.indexPath, 'utf8'), INDEX_SCAFFOLD);
    assert.equal(await fs.readFile(savedA.logPath, 'utf8'), LOG_SCAFFOLD);
    assert.equal((await system.localStore.listCadenceStates()).length, 1, '清空知识库必须保留 cadence');

    const debates = await fs.readdir(path.join(dir, 'wiki', 'debates'));
    const raws = await fs.readdir(path.join(dir, 'raw', 'sessions'));
    assert.deepEqual(debates, []);
    assert.deepEqual(raws, []);
    assert.ok((await fs.stat(path.join(dir, '.patchouli'))).isDirectory());
  } finally {
    system.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
