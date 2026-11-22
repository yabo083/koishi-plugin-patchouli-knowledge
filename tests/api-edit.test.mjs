import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { registerWebUi } from '../lib/index.js';

const TEST_ROOT = path.resolve('tmp/test-api-edit');
const BASE = '/patchouli';
const ENTRY_ID = '2026-10-25-entry-edit';

/** 与 `WikiEngine.renderEntryMarkdown` 现行产物同构的词条正文（含矩阵 / 共识 / 分歧 / 金句）。 */
function sampleMarkdown(overrides = {}) {
  const {
    title = '发言人链路完整性之辩',
    viewpoint = '词条必须记录完整发言人',
    consensus = '发言人名单必须写入词条头部',
  } = overrides;
  return [
    `# ${title}`,
    '',
    'Status: tentative',
    'Date: 2026-10-25',
    'Tags: [[发言人]]',
    'Participants: [[Yellow A]], [[Yellow B]], [[Yellow D]]',
    '',
    '## 摘要',
    '',
    '群友检验词条是否完整记录支持者与质疑者。',
    '',
    '## 观点碰撞',
    '',
    `#### 1. ${viewpoint}`,
    '',
    '- **支持者**：[[Yellow A]], [[Yellow B]]',
    '',
    '- **核心论据**：',
    '  - 只写观点而不写人，词条就无法追溯',
    '',
    '- **质疑/反驳** (质疑者: Yellow D)：',
    '  - 完整记录会提高生成成本',
    '',
    '## 共识',
    '',
    `- ${consensus}`,
    '',
    '## 分歧',
    '',
    '- 如何在长讨论中控制人名噪声',
    '',
    '## 原始言论 / 金句采撷',
    '',
    '> **Yellow D**：没有署名的观点等于没有发生过。',
    '',
  ].join('\n');
}

function createRecord(overrides = {}) {
  return {
    id: ENTRY_ID,
    title: '发言人链路完整性之辩',
    channelId: 'qq-group-9001',
    date: '2026-10-25',
    status: 'tentative',
    tags: ['发言人'],
    summary: '群友检验词条是否完整记录支持者与质疑者。',
    participants: ['Yellow A', 'Yellow B', 'Yellow D'],
    metadata: { messageCount: 12, participantCount: 3, durationMinutes: 5, peakRate: 3.2 },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/** 内存版 `LocalStore` 替身：只实现 Web 层会碰的四个方法，并记录调用。 */
function createStore(initialRecord) {
  const updateCalls = [];
  const saveCalls = [];
  const deleteCalls = [];
  let record = initialRecord ? structuredClone(initialRecord) : undefined;

  const store = {
    updateCalls,
    saveCalls,
    snapshot: () => (record ? structuredClone(record) : undefined),
    async getEntry(id) {
      return record && record.id === id ? structuredClone(record) : undefined;
    },
    async updateEntry(id, patch) {
      updateCalls.push({ id, patch: structuredClone(patch) });
      if (!record || record.id !== id) throw new Error('LocalStore.updateEntry: 词条不存在');
      record = { ...record, ...patch, updatedAt: record.updatedAt + 1 };
      return structuredClone(record);
    },
    async saveEntry(entry, entryPath) {
      saveCalls.push({ entry: structuredClone(entry), entryPath });
      const base = record && record.id === entry.id ? record : createRecord({ id: entry.id });
      record = {
        ...base,
        id: entry.id,
        title: entry.title,
        channelId: entry.channelId,
        date: entry.date,
        status: entry.status,
        tags: [...entry.tags],
        summary: entry.summary,
        participants: [...entry.participants],
        metadata: { ...entry.metadata },
        updatedAt: base.updatedAt + 1,
      };
      if (entryPath !== undefined) record.path = entryPath;
      else if (base.path !== undefined) record.path = base.path;
      return structuredClone(record);
    },
    async deleteEntry(id) {
      deleteCalls.push(id);
      if (!record || record.id !== id) return false;
      record = undefined;
      return true;
    },
  };
  return { store, deleteCalls, updateCalls, saveCalls };
}

function createRouter({ verbs = ['get', 'post', 'put', 'delete'] } = {}) {
  const routes = new Map();
  const middlewares = [];
  const router = {};
  for (const verb of verbs) {
    router[verb] = (route, handler) => routes.set(`${verb.toUpperCase()} ${route}`, handler);
  }
  // 管理面守卫挂在 `use` 上；缺了它插件会 fail closed 跳过全部 /api 路由，这里照实记录。
  router.use = (route, middleware) => { middlewares.push({ route, middleware }); };
  return { router, routes, middlewares };
}

async function callRoute(routes, key, { params = {}, body, query = {} } = {}) {
  const handler = routes.get(key);
  assert.ok(handler, `路由 ${key} 必须注册`);
  const kCtx = { params, query, request: { body }, status: 200, body: undefined, set: () => {} };
  await handler(kCtx);
  return kCtx;
}

async function prepareDir(name) {
  const dir = path.join(TEST_ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'wiki', 'debates'), { recursive: true });
  return dir;
}

function enginePath(dir, id = ENTRY_ID) {
  return path.join(dir, 'wiki', 'debates', `${id}.md`);
}

test.after(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

test('API-EDIT-00: 旧宿主路由缺 put / delete 时既有 GET 路由照常注册', async () => {
  const { router, routes } = createRouter({ verbs: ['get', 'post'] });
  const { store } = createStore(createRecord());
  registerWebUi({ router }, { config: { channels: [] }, localStore: store, wikiEngine: {} }, BASE);

  assert.ok(routes.has(`GET ${BASE}/api/entries/:id`), '详情路由必须仍然注册');
  assert.equal(routes.has(`PUT ${BASE}/api/entries/:id`), false, '宿主无 put 时不得伪造注册');
});

test('API-EDIT-01: PUT 只改元数据时返回与 GET 一致的完整详情', async (t) => {
  const dir = await prepareDir('put-meta');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const mdPath = enginePath(dir);
  await fs.writeFile(mdPath, sampleMarkdown(), 'utf8');

  const { store, updateCalls } = createStore(createRecord({ path: mdPath }));
  const { router, routes } = createRouter();
  const system = {
    localStore: store,
    wikiEngine: { entryPath: (id) => enginePath(dir, id) },
  };
  registerWebUi({ router }, system, BASE);

  const kCtx = await callRoute(routes, `PUT ${BASE}/api/entries/:id`, {
    params: { id: ENTRY_ID },
    body: {
      title: '词条编辑能力之辩',
      summary: '改完之后索引与详情必须同步。',
      status: 'verified',
      tags: ['发言人', ' 发言人 ', '编辑'],
    },
  });

  assert.equal(kCtx.status, 200);
  assert.equal(kCtx.type, 'application/json');
  assert.equal(updateCalls.length, 1, '元数据必须走 LocalStore.updateEntry');
  assert.equal(updateCalls[0].id, ENTRY_ID);
  assert.deepEqual(updateCalls[0].patch, {
    title: '词条编辑能力之辩',
    summary: '改完之后索引与详情必须同步。',
    status: 'verified',
    tags: ['发言人', '编辑'],
  });

  const payload = kCtx.body;
  assert.equal(payload.id, ENTRY_ID);
  assert.equal(payload.title, '词条编辑能力之辩');
  assert.equal(payload.summary, '改完之后索引与详情必须同步。');
  assert.equal(payload.status, 'verified');
  assert.deepEqual(payload.tags, ['发言人', '编辑']);
  // 与 GET /api/entries/:id 同构：正文与解析段落一并回传
  assert.ok(payload.markdown.includes('## 观点碰撞'), '详情必须带正文');
  assert.equal(payload.debateMatrix.length, 1);
  assert.equal(payload.debateMatrix[0].viewpoint, '词条必须记录完整发言人');
  assert.deepEqual(payload.debateMatrix[0].proponents, ['Yellow A', 'Yellow B']);
  assert.deepEqual(payload.debateMatrix[0].opponents, ['Yellow D']);
  assert.deepEqual(payload.consensus, ['发言人名单必须写入词条头部']);
  assert.deepEqual(payload.openQuestions, ['如何在长讨论中控制人名噪声']);
  assert.deepEqual(payload.keyQuotes, [{ author: 'Yellow D', quote: '没有署名的观点等于没有发生过。' }]);
  assert.deepEqual(payload.participants, ['Yellow A', 'Yellow B', 'Yellow D']);
});

test('API-EDIT-02: PUT 带 markdown 时交给 updateEntryMarkdown，并在改标题时同步 index 行', async (t) => {
  const dir = await prepareDir('put-markdown');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const mdPath = enginePath(dir);
  await fs.writeFile(mdPath, sampleMarkdown(), 'utf8');

  const markdownCalls = [];
  const wikiEngine = {
    entryPath: (id) => enginePath(dir, id),
    async updateEntryMarkdown(id, markdown, metadata) {
      markdownCalls.push({ id, markdown, metadata: metadata ? structuredClone(metadata) : metadata });
      await fs.writeFile(enginePath(dir, id), markdown, 'utf8');
    },
  };

  const { store, updateCalls } = createStore(createRecord({ path: mdPath }));
  const { router, routes } = createRouter();
  registerWebUi({ router }, { localStore: store, wikiEngine }, BASE);

  // 1) 只改正文：不动 index 行（不传 metadata）
  const firstMd = sampleMarkdown({ viewpoint: '正文可以整篇改写' });
  const first = await callRoute(routes, `PUT ${BASE}/api/entries/:id`, {
    params: { id: ENTRY_ID },
    body: { markdown: firstMd },
  });
  assert.equal(first.status, 200);
  assert.equal(markdownCalls.length, 1);
  assert.equal(markdownCalls[0].id, ENTRY_ID);
  assert.ok(markdownCalls[0].markdown.endsWith('\n'), '落盘正文必须以换行收尾');
  assert.equal(markdownCalls[0].metadata, undefined, '只改正文时不得传索引元数据');
  assert.equal(first.body.debateMatrix[0].viewpoint, '正文可以整篇改写');
  assert.equal(updateCalls.length, 1, '只改正文也要刷新 updatedAt');
  assert.deepEqual(updateCalls[0].patch, {}, 'markdown 不属于元数据补丁');

  // 2) 正文 + 标题：metadata 只带真正改动的字段，供引擎改写 index.md
  const secondMd = sampleMarkdown({ title: '新标题之辩', viewpoint: '标题与正文一起改' });
  const second = await callRoute(routes, `PUT ${BASE}/api/entries/:id`, {
    params: { id: ENTRY_ID },
    body: { title: '新标题之辩', markdown: secondMd },
  });
  assert.equal(second.status, 200);
  assert.equal(markdownCalls.length, 2);
  assert.deepEqual(markdownCalls[1].metadata, { title: '新标题之辩' });
  assert.deepEqual(updateCalls[1], { id: ENTRY_ID, patch: { title: '新标题之辩' } });
  assert.equal(second.body.title, '新标题之辩');
  assert.equal(second.body.debateMatrix[0].viewpoint, '标题与正文一起改');
  assert.ok(second.body.markdown.includes('# 新标题之辩'));
});

test('API-EDIT-03: PUT 请求体与 id 校验', async (t) => {
  const dir = await prepareDir('put-invalid');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const { store, updateCalls } = createStore(createRecord());
  const { router, routes } = createRouter();
  registerWebUi({ router }, { localStore: store, wikiEngine: { entryPath: (id) => enginePath(dir, id) } }, BASE);

  const put = (body, id = ENTRY_ID) => callRoute(routes, `PUT ${BASE}/api/entries/:id`, { params: { id }, body });

  const notObject = await put('nope');
  assert.equal(notObject.status, 400);
  assert.equal(notObject.body.ok, false);

  const badStatus = await put({ status: 'archived' });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.body.error, /verified \/ tentative \/ open/u);

  const badTags = await put({ tags: ['ok', 42] });
  assert.equal(badTags.status, 400);
  assert.match(badTags.body.error, /tags/u);

  const badTitle = await put({ title: '   ' });
  assert.equal(badTitle.status, 400);

  const emptyPatch = await put({});
  assert.equal(emptyPatch.status, 400);
  assert.match(emptyPatch.body.error, /至少提供一个可更新字段/u);

  const blankMarkdown = await put({ markdown: '   \n' });
  assert.equal(blankMarkdown.status, 400);

  const emptyId = await put({ title: 'x' }, '   ');
  assert.equal(emptyId.status, 400);
  assert.match(emptyId.body.error, /缺少词条 id/u);

  const missing = await put({ title: 'x' }, 'no-such-entry');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Entry not found');

  assert.equal(updateCalls.length, 0, '非法请求绝不能落库');
});

test('API-EDIT-04: 旧宿主回退——无 updateEntryMarkdown 时直接写正文，无 updateEntry 时走 saveEntry 回填 path', async (t) => {
  const dir = await prepareDir('put-fallback');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  // record 尚无 path：正文路径只能由 wikiEngine.entryPath 推导
  const { store, saveCalls } = createStore(createRecord());
  delete store.updateEntry;

  const { router, routes } = createRouter();
  const system = { localStore: store, wikiEngine: { entryPath: (id) => enginePath(dir, id) } };
  registerWebUi({ router }, system, BASE);

  const md = sampleMarkdown({ title: '回退路径之辩' });
  const kCtx = await callRoute(routes, `PUT ${BASE}/api/entries/:id`, {
    params: { id: ENTRY_ID },
    body: { markdown: md, summary: '旧宿主也要能编辑正文。' },
  });

  assert.equal(kCtx.status, 200);
  const written = await fs.readFile(enginePath(dir), 'utf8');
  assert.equal(written, md, '引擎无 updateEntryMarkdown 时必须直接覆写 record 路径');

  assert.equal(saveCalls.length, 1, '无 updateEntry 时必须回退 saveEntry');
  assert.equal(saveCalls[0].entryPath, enginePath(dir), 'saveEntry 必须回填推导出的正文路径');
  assert.equal(saveCalls[0].entry.title, '发言人链路完整性之辩');
  assert.equal(saveCalls[0].entry.summary, '旧宿主也要能编辑正文。');
  assert.equal(store.snapshot().path, enginePath(dir), '元数据必须记录正文路径');

  assert.equal(kCtx.body.summary, '旧宿主也要能编辑正文。');
  assert.ok(kCtx.body.markdown.includes('# 回退路径之辩'));
  assert.equal(kCtx.body.debateMatrix.length, 1, '回填 path 后详情必须解析矩阵');
});

test('API-EDIT-05: DELETE 优先交给 system.deleteEntry', async (t) => {
  const dir = await prepareDir('delete-system');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const { store, deleteCalls } = createStore(createRecord({ path: enginePath(dir) }));
  const systemCalls = [];
  const { router, routes } = createRouter();
  const system = {
    localStore: store,
    wikiEngine: {
      entryPath: (id) => enginePath(dir, id),
      async deleteEntry() { throw new Error('系统层已接管，不应回退引擎'); },
    },
    async deleteEntry(id) { systemCalls.push(id); },
  };
  registerWebUi({ router }, system, BASE);

  const kCtx = await callRoute(routes, `DELETE ${BASE}/api/entries/:id`, { params: { id: ENTRY_ID } });
  assert.equal(kCtx.status, 200);
  assert.deepEqual(kCtx.body, { ok: true, id: ENTRY_ID });
  assert.deepEqual(systemCalls, [ENTRY_ID]);
  assert.equal(deleteCalls.length, 0, '系统层接管时不得重复调用 localStore.deleteEntry');
});

test('API-EDIT-06: 无 system.deleteEntry 时回退 wikiEngine + localStore', async (t) => {
  const dir = await prepareDir('delete-fallback');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const { store, deleteCalls } = createStore(createRecord({ path: enginePath(dir) }));
  const engineCalls = [];
  const { router, routes } = createRouter();
  const system = {
    localStore: store,
    wikiEngine: {
      entryPath: (id) => enginePath(dir, id),
      async deleteEntry(id, title) { engineCalls.push({ id, title }); },
    },
  };
  registerWebUi({ router }, system, BASE);

  const kCtx = await callRoute(routes, `DELETE ${BASE}/api/entries/:id`, { params: { id: ENTRY_ID } });
  assert.equal(kCtx.status, 200);
  assert.deepEqual(kCtx.body, { ok: true, id: ENTRY_ID });
  assert.deepEqual(engineCalls, [{ id: ENTRY_ID, title: '发言人链路完整性之辩' }]);
  assert.deepEqual(deleteCalls, [ENTRY_ID]);
});

test('API-EDIT-07: DELETE 校验 id / 词条存在性 / 宿主能力', async (t) => {
  const dir = await prepareDir('delete-invalid');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const { store, deleteCalls } = createStore(createRecord({ path: enginePath(dir) }));
  const { router, routes } = createRouter();
  registerWebUi({ router }, { localStore: store, wikiEngine: {} }, BASE);

  const emptyId = await callRoute(routes, `DELETE ${BASE}/api/entries/:id`, { params: { id: '  ' } });
  assert.equal(emptyId.status, 400);
  assert.match(emptyId.body.error, /缺少词条 id/u);

  const missing = await callRoute(routes, `DELETE ${BASE}/api/entries/:id`, { params: { id: 'nope' } });
  assert.equal(missing.status, 404);

  // 词条存在但宿主既无 system.deleteEntry 也无引擎 / 仓储删除能力
  delete store.deleteEntry;
  const unsupported = await callRoute(routes, `DELETE ${BASE}/api/entries/:id`, { params: { id: ENTRY_ID } });
  assert.equal(unsupported.status, 500);
  assert.equal(unsupported.body.ok, false);
  assert.match(unsupported.body.error, /不支持删除词条/u);
  assert.equal(deleteCalls.length, 0);
});

test('API-EDIT-08: POST /api/clear 优先系统层，回退引擎 + 仓储，全缺则 500', async (t) => {
  const dir = await prepareDir('clear');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const messages = [];

  // 1) 系统层接管
  {
    const { store } = createStore(createRecord());
    const { router, routes } = createRouter();
    let systemCleared = 0;
    registerWebUi(
      { router },
      {
        localStore: store,
        wikiEngine: { async clearAllEntries() { throw new Error('系统层已接管，不应回退引擎'); } },
        async clearKnowledgeBase() { systemCleared += 1; },
      },
      BASE,
    );
    const kCtx = await callRoute(routes, `POST ${BASE}/api/clear`);
    assert.equal(kCtx.status, 200);
    assert.deepEqual(kCtx.body, { ok: true, message: '知识库已清空，保留默认骨架' });
    assert.equal(systemCleared, 1);
    messages.push(kCtx.body.message);
  }

  // 2) 回退：引擎清文件 + 仓储清元数据
  {
    const { store } = createStore(createRecord());
    const { router, routes } = createRouter();
    const order = [];
    registerWebUi(
      { router },
      {
        localStore: {
          ...store,
          async clearEntries() { order.push('store'); },
        },
        wikiEngine: { async clearAllEntries() { order.push('engine'); } },
      },
      BASE,
    );
    const kCtx = await callRoute(routes, `POST ${BASE}/api/clear`);
    assert.equal(kCtx.status, 200);
    assert.deepEqual(order, ['engine', 'store'], '必须先清 wiki 产物再清元数据');
    assert.deepEqual(kCtx.body, { ok: true, message: '知识库已清空，保留默认骨架' });
  }

  // 3) 宿主完全没有清空能力
  {
    const { store } = createStore(createRecord());
    const { router, routes } = createRouter();
    registerWebUi({ router }, { localStore: store, wikiEngine: {} }, BASE);
    const kCtx = await callRoute(routes, `POST ${BASE}/api/clear`);
    assert.equal(kCtx.status, 500);
    assert.equal(kCtx.body.ok, false);
    assert.match(kCtx.body.error, /不支持清空知识库/u);
  }

  assert.deepEqual(messages, ['知识库已清空，保留默认骨架']);
});
