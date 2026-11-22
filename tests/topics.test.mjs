import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalStore } from '../lib/wiki/storage.js';
import { TopicCurator } from '../lib/wiki/topics.js';
import { WikiEngine, renderEntryMarkdown } from '../lib/wiki/engine.js';
import { ModelDispatcher } from '../lib/index.js';

const TEST_ROOT = fileURLToPath(new URL('../tmp/test-topics', import.meta.url));

/** 校准运行时刻：2026-11-02 23:30（本地时区）。 */
const NOW = new Date(2026, 10, 2, 23, 30, 0, 0).getTime();
/** 词条沉淀时刻：同日 22:30，确保落在回看窗口内且早于校准时刻。 */
const ENTRY_CLOCK = NOW - 3_600_000;
const DAY_KEY = '2026-11-02';
const CHANNEL_ID = 'g-topic-1';
const TOPIC_TITLE = '并发模型的取舍';

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    hour: 23,
    minute: 30,
    mergeThreshold: 0.5,
    minEntries: 1,
    lookbackDays: 30,
    maxSessionsPerRun: 10,
    maxMessagesPerSession: 50,
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    id: 'frag-a',
    title: '并发模型取舍',
    channelId: CHANNEL_ID,
    date: DAY_KEY,
    status: 'tentative',
    tags: ['架构', '并发'],
    summary: '群里争论并发模型该粗还是该细。',
    background: '从一张 benchmark 截图开始。',
    participants: ['甲', '乙'],
    debateMatrix: [],
    consensus: [],
    openQuestions: ['边界谁来维护？'],
    keyQuotes: [],
    metadata: { messageCount: 2, participantCount: 2, durationMinutes: 8, peakRate: 6 },
    ...overrides,
  };
}

function makeSession(sessionId, channelId = CHANNEL_ID) {
  return {
    sessionId,
    channelId,
    startTime: NOW - 7_200_000,
    endTime: NOW - 3_600_000,
    peakRate: 6,
    triggerReason: 'burst-then-quiescence',
    messages: [
      {
        id: `${sessionId}-m1`,
        channelId,
        userId: 'u-1',
        userName: '甲',
        content: '并发模型得按场景划边界，别一刀切。',
        timestamp: NOW - 7_000_000,
      },
      {
        id: `${sessionId}-m2`,
        channelId,
        userId: 'u-2',
        userName: '乙',
        content: '那边界谁来维护？总得有人写基准。',
        timestamp: NOW - 6_900_000,
      },
    ],
  };
}

/** 单组主题记录（字段与 `TOPIC_OUTPUT_SKELETON` 对齐）。 */
function topicItem(groupId, entryIds, overrides = {}) {
  return {
    groupId,
    topicId: null,
    title: TOPIC_TITLE,
    summary: '群里长期在争论并发模型该粗还是该细。',
    background: '从一张 benchmark 截图开始，反复回到边界问题。',
    narrative:
      '群里从一张 benchmark 截图开始讨论并发模型。\n\n甲主张边界按场景划分，乙追问这条边界由谁维护。',
    tags: ['架构', '并发'],
    participants: ['甲', '乙'],
    consensus: ['先按场景划边界'],
    openQuestions: ['基准谁来维护？'],
    glossary: [{ term: '并发模型', note: '这里指群聊风格调度采用的并发粒度。' }],
    timeline: entryIds.map((id) => ({ entryId: id, contribution: `${id} 推进了边界讨论` })),
    ...overrides,
  };
}

function topicPayload(topics) {
  return JSON.stringify({ topics });
}

async function freshDir(name) {
  const dir = path.join(TEST_ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function prepareEngine(dir) {
  const engine = new WikiEngine({ wikiDir: dir, now: () => ENTRY_CLOCK });
  const store = new LocalStore({ wikiDir: dir }, { now: () => ENTRY_CLOCK });
  return { engine, store };
}

async function seedEntry(engine, store, entry) {
  await engine.saveEntry(entry, { session: makeSession(entry.id) });
  await store.saveEntry(entry, engine.entryPath(entry.id));
}

/** 沉淀三篇普通词条：两篇同标签（应聚成一组）、一篇无关。 */
async function seedFragments(dir) {
  const { engine, store } = await prepareEngine(dir);
  const entries = [
    makeEntry({ id: 'frag-a', title: '并发模型取舍', tags: ['架构', '并发'] }),
    makeEntry({ id: 'frag-b', title: '并发模型边界', tags: ['架构', '并发'], summary: '边界该由谁定义。' }),
    makeEntry({
      id: 'frag-other',
      title: '周末吃饭',
      tags: ['生活'],
      summary: '群里在约周末去哪吃饭。',
      participants: ['丙'],
    }),
  ];
  for (const entry of entries) await seedEntry(engine, store, entry);
  return { engine, store, entries };
}

/** 目录快照：路径 + 文本长度，用于断言「零写入」。 */
async function snapshotTree(root) {
  const out = [];
  async function walk(dir, prefix) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      const absolute = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        out.push(`${relative}/`);
        await walk(absolute, relative);
      } else {
        out.push(`${relative}:${(await fs.readFile(absolute, 'utf8')).length}`);
      }
    }
  }
  await walk(root, '');
  return out;
}

function makeCurator(engine, store, invoke) {
  return new TopicCurator({ engine, store, invoke, now: () => NOW });
}

test('TOPIC-01: 普通条目按标签聚类成一个主题，来源词条不被 superseded', async () => {
  const dir = await freshDir('cluster');
  const { engine, store } = await seedFragments(dir);
  const sourceBefore = await fs.readFile(engine.entryPath('frag-a'), 'utf8');

  const curator = makeCurator(engine, store, async () => ({
    text: topicPayload([topicItem('group-1', ['frag-a', 'frag-b'])]),
  }));

  const result = await curator.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(result.skippedReason, undefined);
  assert.equal(result.dayKey, DAY_KEY);
  assert.equal(result.createdTopicIds.length, 1);
  assert.deepEqual(result.updatedTopicIds, []);
  assert.deepEqual([...result.assignedEntryIds].sort(), ['frag-a', 'frag-b']);

  const topicId = result.createdTopicIds[0];
  assert.match(topicId, /^2026-11-02-topic-[0-9a-f]{8}$/);

  const record = await store.getEntry(topicId);
  assert.equal(record.kind, 'topic');
  assert.equal(record.status, 'tentative');
  assert.equal(record.channelId, CHANNEL_ID);
  assert.equal(record.timeline.length, 2);
  assert.deepEqual(record.timeline.map((item) => item.entryId), ['frag-a', 'frag-b']);
  assert.equal(record.timeline[0].contribution, 'frag-a 推进了边界讨论');
  assert.equal(record.timeline[0].title, '并发模型取舍');
  assert.equal(record.metadata.messageCount, 4, '主题元数据按成员聚合');
  assert.deepEqual(record.sources, ['raw/sessions/frag-a.json', 'raw/sessions/frag-b.json']);

  const markdown = await fs.readFile(engine.entryPath(topicId), 'utf8');
  assert.ok(markdown.includes('Kind: topic'));
  assert.ok(markdown.includes('Sources:\n  - raw/sessions/frag-a.json\n  - raw/sessions/frag-b.json'));
  assert.ok(markdown.includes('Related: [[并发模型取舍]], [[并发模型边界]]'));

  // 来源词条保持原样：状态不变、正文不改、不写 Merged-Into。
  const sourceAfter = await fs.readFile(engine.entryPath('frag-a'), 'utf8');
  assert.equal(sourceAfter, sourceBefore, '来源词条 Markdown 不得被改写');
  assert.ok(!sourceAfter.includes('Merged-Into:'));
  assert.equal((await store.getEntry('frag-a')).status, 'tentative');
  assert.equal((await store.getEntry('frag-b')).status, 'tentative');

  // 未被聚类的孤立词条不进入任何主题。
  assert.ok(!result.assignedEntryIds.includes('frag-other'));

  // 时间轴必须真正落进 store.json：换一个仓储实例重读仍完整（旧 store 无该键时按空时间轴兼容）。
  const reopened = new LocalStore({ wikiDir: dir }, { now: () => ENTRY_CLOCK });
  const persisted = await reopened.getEntry(topicId);
  assert.deepEqual(persisted.timeline.map((item) => item.entryId), ['frag-a', 'frag-b']);
  assert.equal(persisted.timeline[1].contribution, 'frag-b 推进了边界讨论');
});

test('TOPIC-02: 新条目追加到旧主题（同 id、时间轴增长、旧时间轴不丢），重跑幂等', async () => {
  const dir = await freshDir('append');
  const { engine, store } = await seedFragments(dir);

  const first = makeCurator(engine, store, async () => ({
    text: topicPayload([topicItem('group-1', ['frag-a', 'frag-b'])]),
  }));
  const created = await first.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(created.createdTopicIds.length, 1);
  const topicId = created.createdTopicIds[0];

  // 同主题的第三条词条随后沉淀（标签与旧主题一致 → 确定性分组归入旧主题）。
  await seedEntry(
    engine,
    store,
    makeEntry({ id: 'frag-c', title: '并发模型基准', tags: ['架构', '并发'], summary: '基准该谁来写。' }),
  );

  const second = makeCurator(engine, store, async (messages) => {
    const prompt = messages.map((message) => message.content).join('\n');
    assert.ok(prompt.includes(topicId), '候选主题必须出现在提示词里');
    assert.ok(prompt.includes('group-1'), '确定性分组必须出现在提示词里');
    return {
      text: topicPayload([
        topicItem('group-1', ['frag-c'], {
          topicId,
          title: '并发模型的取舍与基准',
          summary: '从「按场景划边界」推进到「基准归属」。',
          timeline: [{ entryId: 'frag-c', contribution: '引入基准维护者的归属问题' }],
        }),
      ]),
    };
  });

  const appended = await second.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(appended.skippedReason, undefined);
  assert.deepEqual(appended.createdTopicIds, []);
  assert.deepEqual(appended.updatedTopicIds, [topicId]);
  assert.deepEqual(appended.assignedEntryIds, ['frag-c']);

  const record = await store.getEntry(topicId);
  assert.equal(record.title, '并发模型的取舍与基准', '标题由模型刷新');
  assert.deepEqual(
    record.timeline.map((item) => item.entryId),
    ['frag-a', 'frag-b', 'frag-c'],
    '时间轴按日期 / id 升序 append，旧成员不得丢失',
  );
  assert.equal(record.timeline[0].contribution, 'frag-a 推进了边界讨论', '旧贡献必须保留');
  assert.equal(record.timeline[2].contribution, '引入基准维护者的归属问题', '新贡献覆盖本条');

  // 幂等：已归入的条目不再参与，窗口内无剩余 → no-entries 且零写入。
  const before = await snapshotTree(dir);
  const third = makeCurator(engine, store, async () => {
    throw new Error('没有剩余条目时不得调用模型');
  });
  const idle = await third.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(idle.skippedReason, 'no-entries');
  assert.deepEqual(idle.createdTopicIds, []);
  assert.deepEqual(idle.updatedTopicIds, []);
  assert.deepEqual(idle.assignedEntryIds, []);
  assert.deepEqual(await snapshotTree(dir), before, 'no-entries 必须零写入');
});

test('TOPIC-03: 不足 2 条（孤立词条 + 无匹配主题）→ no-entries 且不调用模型', async () => {
  const dir = await freshDir('no-entries');
  const { engine, store } = await prepareEngine(dir);
  await seedEntry(engine, store, makeEntry({ id: 'frag-a', tags: ['生活'], title: '周末吃饭' }));

  const before = await snapshotTree(dir);
  const curator = makeCurator(engine, store, async () => {
    throw new Error('分组不足时不得调用模型');
  });

  const result = await curator.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(result.skippedReason, 'no-entries');
  assert.deepEqual(result.createdTopicIds, []);
  assert.deepEqual(result.updatedTopicIds, []);
  assert.deepEqual(result.assignedEntryIds, []);
  assert.deepEqual(await snapshotTree(dir), before);

  // 总开关关闭：零读写，直接 disabled。
  const disabled = await curator.runChannel(CHANNEL_ID, makeConfig({ enabled: false }));
  assert.equal(disabled.skippedReason, 'disabled');
  assert.deepEqual(disabled.assignedEntryIds, []);
});

test('TOPIC-04: 模型输出非法 JSON → model-failed 且零写入', async () => {
  const dir = await freshDir('model-failed');
  const { engine, store } = await seedFragments(dir);

  const before = await snapshotTree(dir);
  const curator = makeCurator(engine, store, async () => ({
    text: '抱歉，我需要更多上下文才能整理出主题。',
  }));

  const result = await curator.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(result.skippedReason, 'model-failed');
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
  assert.deepEqual(result.createdTopicIds, []);
  assert.deepEqual(await snapshotTree(dir), before, '解析失败不得产生任何文件');

  // 模型抛异常同样零写入。
  const throwing = makeCurator(engine, store, async () => {
    throw new Error('upstream 502');
  });
  const failed = await throwing.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(failed.skippedReason, 'model-failed');
  assert.ok(failed.detail.includes('upstream 502'));
  assert.deepEqual(await snapshotTree(dir), before);
});

test('TOPIC-05: 越界 timeline.entryId / 越界 topicId 只丢弃该组，不整轮失败', async () => {
  const dir = await freshDir('out-of-range');
  const { engine, store } = await seedFragments(dir);

  const before = await snapshotTree(dir);
  const outOfTimeline = makeCurator(engine, store, async () => ({
    text: topicPayload([
      topicItem('group-1', ['frag-a', 'frag-other']),
      { ...topicItem('group-9', ['frag-a']), groupId: 'group-9' },
    ]),
  }));
  const first = await outOfTimeline.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(first.skippedReason, undefined);
  assert.deepEqual(first.createdTopicIds, [], '越界分组必须被丢弃');
  assert.deepEqual(first.updatedTopicIds, []);
  assert.deepEqual(first.assignedEntryIds, []);
  assert.ok(typeof first.detail === 'string' && first.detail.includes('越界'));
  assert.deepEqual(await snapshotTree(dir), before, '全部丢弃时零写入');

  const outOfTopic = makeCurator(engine, store, async () => ({
    text: topicPayload([topicItem('group-1', ['frag-a', 'frag-b'], { topicId: '2026-10-01-topic-deadbeef' })]),
  }));
  const second = await outOfTopic.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(second.skippedReason, undefined);
  assert.deepEqual(second.createdTopicIds, []);
  assert.deepEqual(second.updatedTopicIds, []);
  assert.ok(second.detail.includes('越界'));
  assert.deepEqual(await snapshotTree(dir), before, 'topicId 越界同样零写入');
});

test('TOPIC-06: 归入主题后来源词条仍出现在词条页与索引里（不 superseded）', async () => {
  const dir = await freshDir('keep-sources');
  const { engine, store } = await seedFragments(dir);

  const curator = makeCurator(engine, store, async () => ({
    text: topicPayload([topicItem('group-1', ['frag-a', 'frag-b'])]),
  }));
  const result = await curator.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(result.createdTopicIds.length, 1);

  const index = await fs.readFile(path.join(dir, 'index.md'), 'utf8');
  assert.ok(index.includes('[[并发模型取舍]]'), '来源词条的索引行必须保留');
  assert.ok(index.includes('[[并发模型边界]]'), '来源词条的索引行必须保留');
  assert.ok(index.includes(`[[${TOPIC_TITLE}]]`), '主题词条必须进入索引');

  for (const sourceId of ['frag-a', 'frag-b']) {
    const markdown = await fs.readFile(engine.entryPath(sourceId), 'utf8');
    assert.ok(!markdown.includes('Status: superseded'), `${sourceId} 不得被标记 superseded`);
    assert.ok(!markdown.includes('Merged-Into:'), `${sourceId} 不得写 Merged-Into`);
    assert.equal((await store.getEntry(sourceId)).status, 'tentative');
  }

  assert.equal('recallEntryId' in result, false);
  assert.equal('supersededEntryIds' in result, false);
});

test('TOPIC-07: 主题 Markdown 输出 `## 主题综述` 与 `## 时间轴`，矩阵/共识/名词注/摘句保持', async () => {
  const entry = makeEntry({
    id: '2026-11-02-topic-1234abcd',
    title: '并发模型的取舍',
    kind: 'topic',
    sources: ['raw/sessions/frag-a.json', 'raw/sessions/frag-b.json'],
    related: ['并发模型取舍', '并发模型边界'],
    narrative: '第一段主题综述。\n\n第二段继续推进。',
    timeline: [
      {
        entryId: 'frag-a',
        date: '2026-11-01',
        title: '并发模型取舍',
        summary: '群里争论并发模型该粗还是该细。',
        contribution: '提出按场景划边界',
      },
      {
        entryId: 'frag-b',
        date: '2026-11-02',
        title: '并发模型边界',
        summary: '边界该由谁定义。',
      },
    ],
    debateMatrix: [
      { viewpoint: '边界按场景划', proponents: ['甲'], opponents: ['乙'], arguments: ['粗粒度掩盖竞争'] },
    ],
    consensus: ['先按场景划边界'],
    openQuestions: ['基准谁来维护？'],
    glossary: [{ term: '并发模型', note: '群聊调度采用的并发粒度。' }],
    keyQuotes: [{ author: '甲', quote: '别一刀切。' }],
  });

  const markdown = renderEntryMarkdown(entry);
  assert.ok(markdown.includes('Kind: topic'));
  assert.ok(markdown.includes('## 主题综述'));
  assert.ok(markdown.includes('## 时间轴'));
  assert.ok(markdown.indexOf('## 背景') < markdown.indexOf('## 主题综述'), '主题综述必须在背景之后');
  assert.ok(markdown.indexOf('## 主题综述') < markdown.indexOf('## 时间轴'), '时间轴紧跟主题综述');
  assert.ok(markdown.indexOf('## 时间轴') < markdown.indexOf('## 观点碰撞矩阵'), '时间轴在矩阵之前');

  assert.ok(markdown.includes('- 2026-11-01 《并发模型取舍》 — 提出按场景划边界'));
  // 没有 contribution 时回退 summary。
  assert.ok(markdown.includes('- 2026-11-02 《并发模型边界》 — 边界该由谁定义。'));

  assert.ok(markdown.includes('## 观点碰撞矩阵'));
  assert.ok(markdown.includes('## 共识与结论'));
  assert.ok(markdown.includes('## 未决分歧与开放思考'));
  assert.ok(markdown.includes('## 名词注'));
  assert.ok(markdown.includes('## 原始言论 / 金句采撷'));
  assert.ok(markdown.includes('第一段主题综述。\n\n第二段继续推进。'));

});

test('TOPIC-10: structured 模式下主题校准不复用词条 JSON Schema', async () => {
  const dir = await freshDir('structured-format');
  const { engine, store } = await seedFragments(dir);

  const bodies = [];
  const dispatcher = new ModelDispatcher(
    { provider: 'standalone', apiKey: 'k', model: 'gpt-4o-mini', responseFormat: 'structured' },
    {
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'resp_topic',
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: topicPayload([topicItem('group-1', ['frag-a', 'frag-b'])]),
                  },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 10 },
          }),
          text: async () => '',
        };
      },
    },
  );

  // 走真实调度器通道，复现插件里 `invoke: (messages) => dispatcher.invokeRaw(messages)` 的接线。
  const curator = new TopicCurator({
    engine,
    store,
    invoke: async (messages) => dispatcher.invokeRaw(messages),
    now: () => NOW,
  });

  const result = await curator.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(result.skippedReason, undefined, `主题校准必须成功：${result.detail ?? ''}`);
  assert.equal(result.createdTopicIds.length, 1);
  assert.equal(bodies.length, 1, '主题校准只允许一次模型调用');

  const body = bodies[0];
  // 主题输出是 `{topics:[…]}`，与词条 JSON Schema 形状不同：structured 会让模型永远补不齐字段。
  assert.deepEqual(body.text, { format: { type: 'json_object' } }, '主题校准必须走 json_object');
  assert.equal('json_schema' in body.text.format, false);

  // 词条契约字段一个都不能下发。
  const serialized = JSON.stringify(body);
  for (const field of ['shouldDiscard', 'debateMatrix', 'qualityScore', 'additionalProperties']) {
    assert.equal(serialized.includes(field), false, `请求体不得携带词条字段 ${field}`);
  }
});

test('TOPIC-11: 宿主关闭 JSON 模式时主题校准降级为 text，而不是硬发 json_object', async () => {
  const dir = await freshDir('text-mode');
  const { engine, store } = await seedFragments(dir);

  const bodies = [];
  const dispatcher = new ModelDispatcher(
    { provider: 'standalone', apiKey: 'k', model: 'gpt-4o-mini', responseFormat: 'structured' },
    {
      jsonMode: false,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'resp_topic_text',
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: topicPayload([topicItem('group-1', ['frag-a', 'frag-b'])]) },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 10 },
          }),
          text: async () => '',
        };
      },
    },
  );

  const curator = new TopicCurator({
    engine,
    store,
    invoke: async (messages) => dispatcher.invokeRaw(messages),
    now: () => NOW,
  });

  const result = await curator.runChannel(CHANNEL_ID, makeConfig());
  assert.equal(result.skippedReason, undefined, `主题校准必须成功：${result.detail ?? ''}`);
  assert.equal(bodies.length, 1);
  assert.equal('text' in bodies[0], false, 'jsonMode=false 时必须退回纯文本输出');
});
