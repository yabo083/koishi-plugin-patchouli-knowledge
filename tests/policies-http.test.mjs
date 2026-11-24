/**
 * 投递策略 API（`GET/POST /api/policies`，POLICY-API-01）。
 *
 * 键 = `<来源群>\u0000<目标键>`：API 把它拆成 `{ source, target }` 给面板，写回时再合成。
 * 这里盯五件事：① GET 拆键（相册名回显 / 回退稳定地址）；② POST 逐项 upsert 不动别的项；
 * ③ 全缺省 = 删项；④ 非法输入 400 且文件一个字节都不动；⑤ 并发 POST 在同一条串行链上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Config,
  PatchouliKnowledgeSystem,
  readTargetPolicies,
  registerWebUi,
  settingsPath,
  writeTargetBindings,
} from '../lib/index.js';

const API_TOKEN = 'policies-http-test-token';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** Koa Router 替身：`use` 必须存在，否则插件按 fail closed 跳过全部 `/api/*` 路由。 */
function createRouterDouble() {
  const routes = new Map();
  const middlewares = [];
  const router = {
    use: (prefix, middleware) => {
      middlewares.push({ prefix, middleware });
    },
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  };

  const request = async (key, kCtx) => {
    const handler = routes.get(key);
    if (handler === undefined) return undefined;
    const routePath = key.slice(key.indexOf(' ') + 1);
    const applicable = middlewares.filter(({ prefix }) => routePath === prefix || routePath.startsWith(`${prefix}/`));
    let index = -1;
    const dispatch = async () => {
      index += 1;
      if (index < applicable.length) return applicable[index].middleware(kCtx, dispatch);
      return handler(kCtx);
    };
    return dispatch();
  };

  return { router, routes, request };
}

/** 带长期令牌的 Koa 上下文（守卫只认 `x-api-token` / Bearer / Cookie）。 */
function koaCtx(body) {
  return {
    params: {},
    query: {},
    headers: { 'x-api-token': API_TOKEN },
    request: { body, headers: { 'x-api-token': API_TOKEN } },
    status: 200,
    body: undefined,
    set: () => {},
  };
}

async function makeWiki() {
  return mkdtemp(path.join(tmpdir(), 'patchouli-policies-http-'));
}

async function boot({ wikiDir }) {
  const config = Config({
    storage: { wikiDir },
    security: { apiToken: API_TOKEN },
    subscriptions: [{ source: '200', targets: ['@chat'], entry: true, weekly: false }],
  });
  const system = new PatchouliKnowledgeSystem(config, quiet);
  await system.ready;
  const { router, request } = createRouterDouble();
  registerWebUi({ router }, system, '/patchouli');
  return { system, request };
}

test('POLICY-API-01: GET 拆键 / POST 逐项 upsert / 缺省删项 / 400 不改文件 / 并发串行', async () => {
  const wikiDir = await makeWiki();
  // 相册名 → 稳定地址：POST 的相册名解析走的是这张表（与订阅表保存时同一条规则）。
  await writeTargetBindings(wikiDir, { 甲相册: '100/A1' });
  const { system, request } = await boot({ wikiDir });
  const file = settingsPath(wikiDir);
  const readDoc = async () => JSON.parse(await readFile(file, 'utf8'));
  const chatKey = '200\u0000@chat:200';
  const albumKey = '200\u0000100/A1';
  try {
    // ① 空表：GET 回空数组，绝不 500。
    const empty = koaCtx(undefined);
    await request('GET /patchouli/api/policies', empty);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { policies: [] });

    // ② 新增 @chat 策略：`@chat` 按来源群合成目标键，GET 原样回显标签文案（两条 cron 各回各的）。
    const created = koaCtx({
      source: '200',
      target: '@chat',
      entryCron: '0 22 * * *',
      weeklyCron: '0 9 * * 1',
      perDay: 3,
      perWeek: 1,
    });
    await request('POST /patchouli/api/policies', created);
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    assert.deepEqual(created.body.policies, [
      {
        source: '200',
        target: '@chat',
        entryCron: '0 22 * * *',
        weeklyCron: '0 9 * * 1',
        perDay: 3,
        perWeek: 1,
      },
    ]);
    assert.deepEqual(await readTargetPolicies(wikiDir), {
      [chatKey]: { entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 },
    });

    // ③ 相册名解析成稳定地址；新增项只给 perDay 时其余字段按缺省补齐，@chat 那一项不受影响。
    const album = koaCtx({ source: '200', target: '甲相册', perDay: 2 });
    await request('POST /patchouli/api/policies', album);
    assert.equal(album.status, 200);
    assert.deepEqual(await readTargetPolicies(wikiDir), {
      [chatKey]: { entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 },
      [albumKey]: { entryCron: '', weeklyCron: '', perDay: 2, perWeek: 0 },
    });
    assert.deepEqual(
      album.body.policies.map((entry) => entry.target).sort(),
      ['100/A1', '@chat'],
      '相册名没有对应的订阅行时回退稳定地址',
    );

    // ③' 局部更新：只给 weeklyCron 时其余三项沿用现有值（改周主题不得把词条时间清掉）。
    const repatched = koaCtx({ source: '200', target: '@chat', weeklyCron: '0 20 * * 5' });
    await request('POST /patchouli/api/policies', repatched);
    assert.equal(repatched.status, 200);
    assert.deepEqual((await readTargetPolicies(wikiDir))[chatKey], {
      entryCron: '0 22 * * *',
      weeklyCron: '0 20 * * 5',
      perDay: 3,
      perWeek: 1,
    });

    // ④ 四个字段全缺省 = 删除该项（面板「清空」的唯一表达）。
    const cleared = koaCtx({
      source: '200',
      target: '@chat',
      entryCron: '',
      weeklyCron: '',
      perDay: 0,
      perWeek: 0,
    });
    await request('POST /patchouli/api/policies', cleared);
    assert.equal(cleared.status, 200);
    assert.deepEqual(await readTargetPolicies(wikiDir), {
      [albumKey]: { entryCron: '', weeklyCron: '', perDay: 2, perWeek: 0 },
    });

    // ⑤ 非法输入一律 400，文件字节保持原样。
    const before = await readFile(file, 'utf8');
    const invalid = [
      { source: '', target: '@chat' },
      { source: '200', target: '' },
      { source: '200', target: '@chat', entryCron: 'not-a-cron' },
      { source: '200', target: '@chat', entryCron: '0 22 * *' },
      { source: '200', target: '@chat', weeklyCron: '0 9 * * 9' },
      { source: '200', target: '@chat', cron: '0 22 * * *' },
      { source: '200', target: '@chat', perDay: -1 },
      { source: '200', target: '@chat', perDay: 1.5 },
      { source: '200', target: '@chat', perWeek: 1000 },
      { source: '200', target: '未绑定相册', perDay: 1 },
    ];
    for (const body of invalid) {
      const ctx = koaCtx(body);
      await request('POST /patchouli/api/policies', ctx);
      assert.equal(ctx.status, 400, `${JSON.stringify(body)} 必须 400`);
      assert.equal(ctx.body.ok, false);
      assert.ok(typeof ctx.body.error === 'string' && ctx.body.error.length > 0);
    }
    const nullBody = koaCtx(null);
    await request('POST /patchouli/api/policies', nullBody);
    assert.equal(nullBody.status, 400);
    assert.equal(await readFile(file, 'utf8'), before, '400 不得改动文件字节');

    // ⑥ 并发 POST：同一份文档的读改写串行化，两项都得在（后到者读到前者的结果）。
    const source = '200';
    await Promise.all([
      request(
        'POST /patchouli/api/policies',
        (() => {
          const ctx = koaCtx({ source, target: '@chat', entryCron: '0 9 * * 1', perDay: 1, perWeek: 0 });
          return ctx;
        })(),
      ),
      request(
        'POST /patchouli/api/policies',
        (() => {
          const ctx = koaCtx({ source: '201', target: '100/A1', perDay: 5, perWeek: 2 });
          return ctx;
        })(),
      ),
    ]);
    const stored = await readTargetPolicies(wikiDir);
    assert.deepEqual(stored['200\u0000@chat:200'], {
      entryCron: '0 9 * * 1',
      weeklyCron: '',
      perDay: 1,
      perWeek: 0,
    });
    assert.deepEqual(
      stored['201\u0000100/A1'],
      { entryCron: '', weeklyCron: '', perDay: 5, perWeek: 2 },
      '并发写不得互相抹掉',
    );

    const doc = await readDoc();
    assert.equal(doc.version, 1, '策略与订阅表 / 绑定表同住一份文档');
    assert.deepEqual(doc.targetBindings, { 甲相册: '100/A1' }, '写策略不得动绑定表');

    // ⑦ `/api/settings` 的 policies 与 `/api/policies` 同形（只读展示用）。
    const settingsCtx = koaCtx(undefined);
    await request('GET /patchouli/api/settings', settingsCtx);
    assert.equal(settingsCtx.status, 200);
    assert.deepEqual(
      settingsCtx.body.policies.map((entry) => `${entry.source}/${entry.target}`).sort(),
      ['200/100/A1', '200/@chat', '201/100/A1'].sort(),
    );
    assert.deepEqual(
      settingsCtx.body.policies.find((entry) => entry.target === '@chat'),
      {
        source: '200',
        target: '@chat',
        entryCron: '0 9 * * 1',
        weeklyCron: '',
        perDay: 1,
        perWeek: 0,
      },
      '只读展示同样拆成两条 cron',
    );
  } finally {
    system.dispose();
    await rm(wikiDir, { recursive: true, force: true });
  }
});
